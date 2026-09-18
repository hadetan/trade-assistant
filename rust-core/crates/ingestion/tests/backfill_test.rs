use chrono::{Datelike, NaiveDate, Weekday};
use ingestion::backfill::{
    fetch_trading_day, walk_trading_days_backward, DayOutcome, TradingDay, WalkStop, CLOSED_DAY_LIMIT,
};
use ingestion::error::IngestionError;
use ingestion::time::ist_session_close_epoch;
use std::ops::ControlFlow;

fn date(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).expect("test dates are valid")
}

// The shared fixture's TradDt is hardcoded to 2024-01-15, which would give
// every walked day the same candle ts; these tests stamp the walked date in.
fn bhavcopy_csv(day: NaiveDate, symbols: &[&str]) -> Vec<u8> {
    let mut out = String::from(
        "TradDt,FinInstrmTp,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd\n",
    );
    for symbol in symbols {
        out.push_str(&format!("{day},STK,{symbol},EQ,10.0,11.0,9.0,10.5,10.5,10.0,1000,10500.0,7\n"));
    }
    out.into_bytes()
}

#[test]
fn a_weekend_day_is_closed_without_any_network_attempt() {
    let mut attempts: Vec<NaiveDate> = Vec::new();
    let mut fetch = |_exchange: &str, d: NaiveDate| {
        attempts.push(d);
        Ok(bhavcopy_csv(d, &["INFY"]))
    };
    // 2024-01-13 is a Saturday, 2024-01-14 a Sunday.
    assert!(matches!(fetch_trading_day("NSE", date(2024, 1, 13), &mut fetch), Ok(TradingDay::Closed)));
    assert!(matches!(fetch_trading_day("NSE", date(2024, 1, 14), &mut fetch), Ok(TradingDay::Closed)));
    assert!(attempts.is_empty(), "weekends must never reach the network");
}

#[test]
fn a_404_is_closed_and_a_non_404_error_propagates() {
    let mut fetch_404 = |_e: &str, _d: NaiveDate| Err(IngestionError::NotFound);
    assert!(matches!(fetch_trading_day("NSE", date(2024, 1, 15), &mut fetch_404), Ok(TradingDay::Closed)));

    let mut fetch_500 = |_e: &str, _d: NaiveDate| Err(IngestionError::Fetch("boom".to_string()));
    match fetch_trading_day("NSE", date(2024, 1, 15), &mut fetch_500) {
        Err(IngestionError::Fetch(m)) => assert_eq!(m, "boom"),
        other => panic!("a non-404 must propagate, got {other:?}"),
    }
}

#[test]
fn a_successful_weekday_fetch_is_traded_and_carries_the_bytes_through() {
    let mut fetch = |_e: &str, d: NaiveDate| Ok(bhavcopy_csv(d, &["INFY"]));
    match fetch_trading_day("NSE", date(2024, 1, 15), &mut fetch) {
        Ok(TradingDay::Traded(bytes)) => {
            assert!(String::from_utf8(bytes).unwrap().contains("2024-01-15"));
        }
        other => panic!("expected Traded, got {other:?}"),
    }
}

#[test]
fn the_walk_visits_consecutive_trading_days_backward_and_never_fetches_a_weekend() {
    let mut attempts: Vec<NaiveDate> = Vec::new();
    let mut fetch = |_e: &str, d: NaiveDate| {
        attempts.push(d);
        Ok(bhavcopy_csv(d, &["INFY"]))
    };
    let mut visited: Vec<NaiveDate> = Vec::new();
    let mut on_day = |outcome: DayOutcome| {
        visited.push(outcome.date);
        if visited.len() == 3 { ControlFlow::Break(()) } else { ControlFlow::Continue(()) }
    };

    let stop =
        walk_trading_days_backward("NSE", "NSE:INFY", date(2024, 1, 15), &mut fetch, &mut on_day).unwrap();

    assert_eq!(stop, WalkStop::CallerStopped);
    // Mon 15 -> (Sun 14, Sat 13 skipped with no fetch) -> Fri 12 -> Thu 11.
    assert_eq!(visited, vec![date(2024, 1, 15), date(2024, 1, 12), date(2024, 1, 11)]);
    assert_eq!(attempts, visited);
}

#[test]
fn an_archive_that_404s_on_every_weekday_ends_the_walk_at_the_cap_instead_of_looping_forever() {
    // The defect CLOSED_DAY_LIMIT exists for: `on_day` only ever runs for a
    // fetched day, so with the callback as the walk's only exit an archive that
    // has stopped answering -- walked past its coverage, or its URL format
    // changed -- would step backward one weekday at a time forever, wedging the
    // serial sidecar until the user hits Stop. If this test hangs, the walk has
    // no bound of its own and the cap is not wired up.
    let mut attempts: Vec<NaiveDate> = Vec::new();
    let mut fetch = |_e: &str, d: NaiveDate| -> Result<Vec<u8>, IngestionError> {
        attempts.push(d);
        Err(IngestionError::NotFound)
    };
    let mut visited: Vec<NaiveDate> = Vec::new();
    // Deliberately never breaks -- the walk must terminate on its own.
    let mut on_day = |outcome: DayOutcome| {
        visited.push(outcome.date);
        ControlFlow::Continue(())
    };

    let stop =
        walk_trading_days_backward("NSE", "NSE:INFY", date(2024, 1, 15), &mut fetch, &mut on_day).unwrap();

    assert_eq!(stop, WalkStop::ArchiveExhausted, "the walk must report WHY it stopped");
    assert!(visited.is_empty(), "a closed day never reaches the callback");
    // Exactly the cap and not one request more. Thirty weekdays back from Mon
    // 2024-01-15 lands on Tue 2023-12-05; no weekend is ever attempted, so
    // weekends cannot pad the count toward the cap either.
    assert_eq!(attempts.len(), CLOSED_DAY_LIMIT);
    assert_eq!(attempts.first(), Some(&date(2024, 1, 15)));
    assert_eq!(attempts.last(), Some(&date(2023, 12, 5)));
    assert!(attempts.iter().all(|d| !matches!(d.weekday(), Weekday::Sat | Weekday::Sun)));
}

#[test]
fn one_successful_fetch_resets_the_closed_day_streak() {
    // A scattered mid-history holiday must not accumulate toward the cap.
    // Tue 2023-12-26 is the 15th weekday back from Mon 2024-01-15.
    let traded = date(2023, 12, 26);
    let mut attempts: Vec<NaiveDate> = Vec::new();
    let mut fetch = |_e: &str, d: NaiveDate| -> Result<Vec<u8>, IngestionError> {
        attempts.push(d);
        if d == traded {
            Ok(bhavcopy_csv(d, &["INFY"]))
        } else {
            Err(IngestionError::NotFound)
        }
    };
    let mut visited: Vec<NaiveDate> = Vec::new();
    let mut on_day = |outcome: DayOutcome| {
        visited.push(outcome.date);
        ControlFlow::Continue(())
    };

    let stop =
        walk_trading_days_backward("NSE", "NSE:INFY", date(2024, 1, 15), &mut fetch, &mut on_day).unwrap();

    assert_eq!(stop, WalkStop::ArchiveExhausted);
    assert_eq!(visited, vec![traded]);
    // 14 closed weekdays, then the traded one (streak -> 0), then a full fresh
    // CLOSED_DAY_LIMIT run. Without the reset the walk would have stopped after
    // 31 attempts, when the 30th cumulative 404 landed.
    assert_eq!(attempts.len(), 15 + CLOSED_DAY_LIMIT);
}

#[test]
fn a_holiday_404_is_skipped_without_reaching_the_callback_but_is_still_attempted() {
    let mut attempts: Vec<NaiveDate> = Vec::new();
    let mut fetch = |_e: &str, d: NaiveDate| {
        attempts.push(d);
        if d == date(2024, 1, 12) { Err(IngestionError::NotFound) } else { Ok(bhavcopy_csv(d, &["INFY"])) }
    };
    let mut visited: Vec<NaiveDate> = Vec::new();
    let mut on_day = |outcome: DayOutcome| {
        visited.push(outcome.date);
        if visited.len() == 3 { ControlFlow::Break(()) } else { ControlFlow::Continue(()) }
    };

    walk_trading_days_backward("NSE", "NSE:INFY", date(2024, 1, 15), &mut fetch, &mut on_day).unwrap();

    assert_eq!(visited, vec![date(2024, 1, 15), date(2024, 1, 11), date(2024, 1, 10)]);
    // The holiday WAS attempted -- only weekends are free.
    assert_eq!(
        attempts,
        vec![date(2024, 1, 15), date(2024, 1, 12), date(2024, 1, 11), date(2024, 1, 10)]
    );
}

#[test]
fn a_non_404_error_stops_the_walk_and_propagates_even_when_the_callback_never_breaks() {
    let mut fetch = |_e: &str, d: NaiveDate| {
        if d == date(2024, 1, 12) {
            Err(IngestionError::Fetch("network down".to_string()))
        } else {
            Ok(bhavcopy_csv(d, &["INFY"]))
        }
    };
    let mut visited: Vec<NaiveDate> = Vec::new();
    let mut on_day = |outcome: DayOutcome| {
        visited.push(outcome.date);
        ControlFlow::Continue(())
    };

    match walk_trading_days_backward("NSE", "NSE:INFY", date(2024, 1, 15), &mut fetch, &mut on_day) {
        Err(IngestionError::Fetch(m)) => assert_eq!(m, "network down"),
        other => panic!("expected the fetch error to propagate, got {other:?}"),
    }
    assert_eq!(visited, vec![date(2024, 1, 15)], "the walk stops at the failing day");
}

#[test]
fn a_day_whose_file_has_no_row_for_the_target_symbol_reports_a_none_candle() {
    let mut fetch = |_e: &str, d: NaiveDate| Ok(bhavcopy_csv(d, &["TCS", "RELIANCE"]));
    let mut outcomes: Vec<DayOutcome> = Vec::new();
    let mut on_day = |outcome: DayOutcome| {
        outcomes.push(outcome);
        ControlFlow::Break(())
    };

    walk_trading_days_backward("NSE", "NSE:ZYDUSWELL", date(2024, 1, 15), &mut fetch, &mut on_day).unwrap();

    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].date, date(2024, 1, 15));
    assert!(outcomes[0].candle.is_none(), "absence is a None candle on a real trading day, not an error");
}

#[test]
fn a_present_symbol_is_parsed_with_the_walked_days_own_session_close_timestamp() {
    let mut fetch = |_e: &str, d: NaiveDate| Ok(bhavcopy_csv(d, &["TCS", "INFY"]));
    let mut outcomes: Vec<DayOutcome> = Vec::new();
    let mut on_day = |outcome: DayOutcome| {
        outcomes.push(outcome);
        ControlFlow::Break(())
    };

    walk_trading_days_backward("NSE", "NSE:INFY", date(2024, 1, 15), &mut fetch, &mut on_day).unwrap();

    let parsed = outcomes[0].candle.as_ref().expect("INFY is present in this day's file");
    assert_eq!(parsed.symbol, "NSE:INFY");
    assert_eq!(parsed.timeframe, "day");
    // The ts comes from the file's own TradDt, which is authoritative.
    assert_eq!(parsed.candle.ts, ist_session_close_epoch(date(2024, 1, 15)));
    assert_eq!(parsed.candle.close, 10.5);
}
