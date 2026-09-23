use crate::protocol::{
    DayBackfillResponse, EnsureDayBackfillRequest, ResolveBenchmarkWindowRequest,
    ResolveBenchmarkWindowResponse,
};
use algo_core::registry;
use chrono::NaiveDate;
use ingestion::backfill::{walk_trading_days_backward, DayFetcher, DayOutcome, WalkStop};
use ingestion::time::ist_date_from_epoch;
use std::ops::ControlFlow;
use storage::{Candle, CandleStore};

/// Bhavcopy is the one on-demand day source this app has (P14§1), so a day
/// backfill only ever reads and writes this one partition.
pub const BACKFILL_TIMEFRAME: &str = "day";
pub const BACKFILL_SOURCE: &str = "bhavcopy";

/// Consecutive real trading days (holidays don't count -- they never reach the
/// callback) with no row for the target symbol before the walk concludes the
/// symbol simply isn't listed that far back. A stock that is currently listed
/// and trading does not miss ten straight national bhavcopies; one that is
/// pre-IPO or delisted does (P14§2 item 4).
///
/// Distinct from `ingestion::backfill::CLOSED_DAY_LIMIT`, which counts days the
/// *archive* had no file for. This one only ever advances on a day that was
/// fetched successfully, so it is evidence about the symbol alone.
pub const ABSENT_DAY_LIMIT: usize = 10;

/// Width of the day-partition boundary below: `BenchmarkView.tsx` sends
/// `from_ts` as UTC midnight of the selected day and derives its own `toTs`
/// as `dayStart + DAY_SECONDS`; this is that same constant on this side of
/// the wire. Changing one without the other reopens the boundary bug fix
/// round 3 of this subsystem existed to close.
const DAY_SECONDS: i64 = 86_400;

/// Of the `lookback + lookahead` bars a run wants, how many it can actually
/// use. Each side is capped at what it is allowed to contribute, so a shortfall
/// on either side lands strictly below the total and `sufficient: false` can
/// never be rendered as "has 22 days; needs 20".
///
/// Accepted limitation: the cap can undersell a genuinely deep symbol when
/// `trailing` is the binding side -- a 1000-bar symbol tested two days from its
/// newest bar with `lookahead = 5` reports `lookback + 2`, not 1000. That needs
/// deliberately selecting a day within the scoring window of the newest bar
/// available, and the alternative (an uncapped row count) is the contradictory
/// banner this cap exists to prevent.
fn usable_bars(leading: usize, trailing: usize, lookback: usize, lookahead: usize) -> usize {
    leading.min(lookback) + trailing.min(lookahead)
}

fn handle_ensure_day_backfill(
    store: &CandleStore,
    request: EnsureDayBackfillRequest,
    today: NaiveDate,
    fetch: DayFetcher<'_>,
    on_progress: &mut dyn FnMut(usize, usize),
) -> DayBackfillResponse {
    let id = request.id;
    let lookback = registry::all_for_binary()
        .iter()
        .find(|algo| algo.id() == request.algo_id)
        .map(|algo| algo.required_lookback())
        .unwrap_or(0);
    let lookahead = request.lookahead;
    let need = lookback + lookahead;

    let existing = match store.read_sourced_candles(&request.symbol, BACKFILL_TIMEFRAME, BACKFILL_SOURCE) {
        Ok(candles) => candles,
        Err(e) => {
            return DayBackfillResponse {
                id,
                have: 0,
                need,
                sufficient: false,
                archive_exhausted: false,
                error: Some(e.to_string()),
            }
        }
    };
    // The Benchmark UI tests exactly ONE candle per run (`fromTs` is the start
    // of the selected day and `toTs` one day later, so a day-timeframe entry
    // has a single frontier). Total lake depth therefore answers the wrong
    // question: what decides the run is whether THAT candle has `lookback` real
    // bars at-or-before it for `run_applicable`'s history gate, and `lookahead`
    // real bars after it for the loop's scoring gate.
    //
    // The split is taken at the END of the selected day, not at `from_ts`
    // itself. `from_ts` is UTC midnight (BenchmarkView.tsx sends the day's
    // start) while the day's own candle is stamped `ist_session_close_epoch` =
    // 15:30 IST = 10:00 UTC, so a `ts <= from_ts` split files the selection's
    // own bar under `trailing` and reads the scoring window as one bar deeper
    // than it is. This source is day-only (BACKFILL_TIMEFRAME), so the end of
    // the selected partition is simply one calendar day on -- the same
    // `dayStart + DAY_SECONDS` the UI computes for its own `toTs`.
    let to_ts = request.from_ts + DAY_SECONDS;
    let mut leading = existing.iter().filter(|c| c.ts < to_ts).count();
    let mut trailing = existing.iter().filter(|c| c.ts >= to_ts).count();
    let mut has_selected_day = existing.iter().any(|c| c.ts >= request.from_ts && c.ts < to_ts);

    // No candle ON the selected day means the symbol did not trade it -- a
    // weekend, a holiday, or a gap in its listing. The run would have no bar to
    // decide about, and the walk cannot supply one either: it fetches only days
    // older than the lake's earliest bar. `have: 0` rather than a count of the
    // surrounding context, because the shortfall is not "too little history
    // around a real bar" -- there is no bar.
    //
    // Gated on a non-empty lake here so an empty partition still reaches the
    // walk below and gets a chance to fill itself from scratch. An empty lake
    // that STILL has no candle on the selected day once the walk (if any) is
    // done is caught structurally by the final `has_selected_day` gate below,
    // not argued away as unreachable.
    if !existing.is_empty() && !has_selected_day {
        return DayBackfillResponse {
            id,
            have: 0,
            need,
            sufficient: false,
            archive_exhausted: false,
            error: None,
        };
    }

    if trailing < lookahead {
        // Unfixable by definition: the walk resumes from before the earliest
        // bar held and only ever moves further back, so it can add to `leading`
        // and never to `trailing`. Ten minutes of archive fetches would end on
        // this same answer, so give it now instead.
        return DayBackfillResponse {
            id,
            have: usable_bars(leading, trailing, lookback, lookahead),
            need,
            sufficient: false,
            archive_exhausted: false,
            error: None,
        };
    }
    if leading >= lookback {
        return DayBackfillResponse {
            id,
            have: usable_bars(leading, trailing, lookback, lookahead),
            need,
            sufficient: true,
            archive_exhausted: false,
            error: None,
        };
    }

    let exchange = request.symbol.split(':').next().unwrap_or("NSE").to_string();
    // Resume strictly before the earliest bar already held, so no fetched day
    // can collide with one the lake already has.
    let start = match existing.first().map(|c| ist_date_from_epoch(c.ts)).and_then(|d| d.pred_opt()) {
        Some(day) => day,
        None => today,
    };

    let mut absent_streak = 0usize;
    let mut write_failure: Option<String> = None;
    let walk = walk_trading_days_backward(&exchange, &request.symbol, start, fetch, &mut |outcome: DayOutcome| {
        match outcome.candle {
            Some(parsed) => {
                absent_streak = 0;
                // Persist per day, not at the end: a hard-cancel mid-walk must
                // keep every day already fetched (P14§4).
                if let Err(e) = store.write_sourced_candles(
                    &request.symbol,
                    BACKFILL_TIMEFRAME,
                    BACKFILL_SOURCE,
                    &[parsed.candle],
                ) {
                    write_failure = Some(e.to_string());
                    return ControlFlow::Break(());
                }
                // Every fetched day is older than the lake's earliest bar and
                // so older than the selection, which is why this only ever
                // advances the leading side.
                leading += 1;
                on_progress(leading, lookback);
                if leading >= lookback {
                    return ControlFlow::Break(());
                }
            }
            None => {
                absent_streak += 1;
                if absent_streak >= ABSENT_DAY_LIMIT {
                    return ControlFlow::Break(());
                }
            }
        }
        ControlFlow::Continue(())
    });

    let mut archive_exhausted = false;
    let error = match walk {
        Err(e) => Some(e.to_string()),
        Ok(WalkStop::ArchiveExhausted) => {
            // Not an error: the fetches succeeded in the transport sense, the
            // archive simply had no file for CLOSED_DAY_LIMIT weekdays running.
            archive_exhausted = true;
            write_failure
        }
        Ok(WalkStop::CallerStopped) => write_failure,
    };
    // Authoritative split: recount from the partition itself rather than trust
    // the in-memory counter, so a write that failed late can never be reported
    // as a bar the run will get. `has_selected_day` gets the same treatment --
    // the walk only ever adds days OLDER than the selection, so it can turn an
    // empty lake into one with real leading/trailing context without ever
    // supplying the selected day itself, and the pre-walk snapshot alone
    // cannot tell the two apart.
    if let Ok(candles) = store.read_sourced_candles(&request.symbol, BACKFILL_TIMEFRAME, BACKFILL_SOURCE) {
        leading = candles.iter().filter(|c| c.ts < to_ts).count();
        trailing = candles.iter().filter(|c| c.ts >= to_ts).count();
        has_selected_day = candles.iter().any(|c| c.ts >= request.from_ts && c.ts < to_ts);
    }
    DayBackfillResponse {
        id,
        // Zeroing `have` alongside `sufficient` here, not just gating
        // `sufficient` alone -- reporting a nonzero `have` for a day that has
        // no candle at all reintroduces the exact have>=need-but-insufficient
        // contradiction (I-2) this response shape exists to prevent.
        have: if has_selected_day { usable_bars(leading, trailing, lookback, lookahead) } else { 0 },
        need,
        sufficient: has_selected_day && leading >= lookback && trailing >= lookahead,
        archive_exhausted,
        error,
    }
}

/// Picks a day using only rows already on disk, so the run's trailing side
/// is satisfied without ever needing a fetch (P15§3) -- backfill only ever
/// walks backward, so trailing can never be grown after the fact. Needs no
/// calendar/holiday logic: it counts rows, it doesn't walk dates.
fn pick_candidate_from_ts(existing: &[Candle], lookahead: usize, today: NaiveDate) -> i64 {
    let start_of_day = |day: NaiveDate| day.and_hms_opt(0, 0, 0).expect("midnight is a valid time").and_utc().timestamp();
    if existing.is_empty() {
        return start_of_day(today);
    }
    let mut sorted: Vec<&Candle> = existing.iter().collect();
    sorted.sort_by_key(|c| std::cmp::Reverse(c.ts));
    // `lookahead.min(sorted.len() - 1)`: when the lake holds no more than
    // `lookahead` rows total, trailing can never reach `lookahead` from any
    // candidate -- picking the earliest row here just routes into the
    // existing, already-tested `trailing < lookahead` refusal below with zero
    // fetches, rather than needing a second refusal path of its own.
    let idx = lookahead.min(sorted.len() - 1);
    start_of_day(ist_date_from_epoch(sorted[idx].ts))
}

/// Resolves which day to test (P15§3) and delegates to the untouched,
/// already-tested per-day check above. The caller supplies only the symbol,
/// algorithm, and this run's scoring window -- not a day.
pub fn handle_resolve_benchmark_window(
    store: &CandleStore,
    request: ResolveBenchmarkWindowRequest,
    today: NaiveDate,
    fetch: DayFetcher<'_>,
    on_progress: &mut dyn FnMut(usize, usize),
) -> ResolveBenchmarkWindowResponse {
    let id = request.id;
    let lookahead = request.lookahead;
    let lookback = registry::all_for_binary()
        .iter()
        .find(|algo| algo.id() == request.algo_id)
        .map(|algo| algo.required_lookback())
        .unwrap_or(0);
    let need = lookback + lookahead;

    let existing = match store.read_sourced_candles(&request.symbol, BACKFILL_TIMEFRAME, BACKFILL_SOURCE) {
        Ok(candles) => candles,
        Err(e) => {
            return ResolveBenchmarkWindowResponse { id, from_ts: 0, have: 0, need, sufficient: false, archive_exhausted: false, error: Some(e.to_string()) };
        }
    };
    let from_ts = pick_candidate_from_ts(&existing, lookahead, today);

    // Delegates to the untouched per-day check; it re-reads `existing` itself
    // (a small, accepted duplicate local read -- P14/P15 leave that function's
    // body unmodified on purpose).
    let checked = handle_ensure_day_backfill(
        store,
        EnsureDayBackfillRequest { id, symbol: request.symbol, algo_id: request.algo_id, lookahead, from_ts },
        today,
        fetch,
        on_progress,
    );

    ResolveBenchmarkWindowResponse {
        id: checked.id,
        from_ts,
        have: checked.have,
        need: checked.need,
        sufficient: checked.sufficient,
        archive_exhausted: checked.archive_exhausted,
        error: checked.error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use algo_core::registry;
    use chrono::Datelike;
    use ingestion::backfill::CLOSED_DAY_LIMIT;
    use ingestion::error::IngestionError;
    use ingestion::time::ist_session_close_epoch;
    use tempfile::tempdir;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("test dates are valid")
    }

    // Per-date TradDt: write_sourced_candles merges on ts, so reusing one fixed
    // date would collapse every fetched day into a single lake row.
    fn bhavcopy_csv(day: NaiveDate, symbols: &[&str]) -> Vec<u8> {
        let mut out = String::from(
            "TradDt,FinInstrmTp,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd\n",
        );
        for symbol in symbols {
            out.push_str(&format!("{day},STK,{symbol},EQ,10.0,11.0,9.0,10.5,10.5,10.0,1000,10500.0,7\n"));
        }
        out.into_bytes()
    }

    // Asserting against the registry's own number rather than a literal: obv's
    // required_lookback is 2 today (indicators/obv.rs), but this must not
    // silently pass if that constant ever moves.
    fn lookback_of(algo_id: &str) -> usize {
        registry::all_for_binary()
            .iter()
            .find(|a| a.id() == algo_id)
            .map(|a| a.required_lookback())
            .unwrap_or_else(|| panic!("{algo_id} must be in every build's registry"))
    }

    fn request(symbol: &str, algo_id: &str, lookahead: usize, from_ts: i64) -> EnsureDayBackfillRequest {
        EnsureDayBackfillRequest {
            id: 7,
            symbol: symbol.to_string(),
            algo_id: algo_id.to_string(),
            lookahead,
            from_ts,
        }
    }

    fn candle_at(day: NaiveDate) -> Candle {
        Candle { ts: ist_session_close_epoch(day), open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 }
    }

    /// The wire encoding of `from_ts`: UTC midnight of the selected calendar
    /// day, which is 10 hours BEFORE that day's candle is stamped
    /// (`ist_session_close_epoch` = 15:30 IST = 10:00 UTC). Encoding fixtures
    /// the other way is what hid the boundary bug through three rounds.
    fn selected_day_ts(day: NaiveDate) -> i64 {
        day.and_hms_opt(0, 0, 0).expect("midnight is a valid time").and_utc().timestamp()
    }

    // A fixture standing in for a lake partition: `count` candles spaced a
    // week apart, newest first, so index 0 is the entry's newest available
    // bar and the last index is its earliest.
    fn weekly_candles(newest: NaiveDate, count: usize) -> Vec<Candle> {
        (0..count).map(|i| candle_at(newest - chrono::Duration::days(i as i64 * 7))).collect()
    }

    #[test]
    fn an_already_deep_enough_lake_answers_immediately_with_zero_fetches() {
        // Thu 11, Fri 12, Mon 15 with the 12th selected: two bars at-or-before
        // it (lookback 2) and one after it (lookahead 1). Both sides are
        // already satisfied, so there is nothing to fetch.
        let lookahead = 1;
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        store
            .write_sourced_candles(
                "NSE:INFY",
                BACKFILL_TIMEFRAME,
                BACKFILL_SOURCE,
                &[candle_at(date(2024, 1, 15)), candle_at(date(2024, 1, 12)), candle_at(date(2024, 1, 11))],
            )
            .unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };
        let mut progress: Vec<(usize, usize)> = Vec::new();

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv", lookahead, selected_day_ts(date(2024, 1, 12))),
            date(2024, 1, 15),
            &mut fetch,
            &mut |index, total| progress.push((index, total)),
        );

        assert_eq!(response.id, 7);
        assert_eq!(response.need, lookback_of("obv") + lookahead);
        assert_eq!(response.have, lookback_of("obv") + lookahead, "a satisfied run has exactly what it needs");
        assert!(response.sufficient);
        assert_eq!(response.error, None);
        assert!(attempts.is_empty(), "a deep-enough lake must never hit the network");
        assert!(progress.is_empty());
    }

    #[test]
    fn an_empty_lake_fetches_exactly_the_leading_context_it_needs_and_reports_each_day() {
        // Selecting today with no scoring window: nothing has to come after the
        // selected day, so the whole job is the algorithm's leading context.
        let lookback = lookback_of("obv");
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY", "TCS"]))
        };
        let mut progress: Vec<(usize, usize)> = Vec::new();

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv", 0, selected_day_ts(date(2024, 1, 15))),
            date(2024, 1, 15),
            &mut fetch,
            &mut |index, total| progress.push((index, total)),
        );

        assert!(response.sufficient);
        assert_eq!(response.have, lookback);
        assert_eq!(response.need, lookback);
        assert_eq!(attempts.len(), lookback, "one fetch per needed trading day, no more");
        assert_eq!(attempts[0], date(2024, 1, 15), "the walk starts at today when the lake is empty");
        assert!(attempts.iter().all(|d| !matches!(d.weekday(), chrono::Weekday::Sat | chrono::Weekday::Sun)));
        assert!(attempts.windows(2).all(|w| w[1] < w[0]), "the walk goes strictly backward");
        assert_eq!(progress, (1..=lookback).map(|i| (i, lookback)).collect::<Vec<_>>());
        // The days really landed in the lake, not just in a counter.
        assert_eq!(store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap().len(), lookback);
    }

    #[test]
    fn a_partial_lake_resumes_from_the_day_before_its_earliest_candle() {
        assert!(lookback_of("obv") == 2, "this fixture is sized for obv's 2-bar lookback");
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        store
            .write_sourced_candles("NSE:INFY", BACKFILL_TIMEFRAME, BACKFILL_SOURCE, &[candle_at(date(2024, 1, 15))])
            .unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv", 0, selected_day_ts(date(2024, 1, 15))),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        // Earliest existing candle is Mon 15 -> start at Sun 14 -> Sat 13 -> Fri
        // 12. Neither weekend day is fetched and the 15th is never refetched.
        // A zero lookahead means nothing has to be scored, so one new bar
        // completes the 15th's two-bar leading context.
        assert_eq!(attempts, vec![date(2024, 1, 12)]);
        assert_eq!(response.have, 2);
        assert!(response.sufficient);
    }

    #[test]
    fn a_lake_deep_enough_in_total_still_fetches_when_the_selected_day_is_thin() {
        // Five bars already held and a combined budget of five: a sizing rule
        // that only looks at the lake's TOTAL depth short-circuits here with
        // zero fetches. But the selected day is the earliest of the five, so it
        // has one bar of leading context, not two, and the run it was fetched
        // for still produces nothing. Depth in total is not the question; depth
        // around the ONE candle the run tests is.
        let lookback = lookback_of("obv");
        let lookahead = 3;
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let already = weekly_candles(date(2024, 1, 15), lookback + lookahead);
        assert_eq!(already.len(), lookback + lookahead, "the fixture must start at exactly the combined budget");
        store.write_sourced_candles("NSE:INFY", BACKFILL_TIMEFRAME, BACKFILL_SOURCE, &already).unwrap();
        let earliest = date(2023, 12, 18);
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv", lookahead, selected_day_ts(earliest)),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        // Mon Dec 18 -> Sun 17 and Sat 16 are skipped without a fetch -> Fri
        // Dec 15 lands the one missing leading bar.
        assert_eq!(attempts, vec![date(2023, 12, 15)], "a lake at the combined budget must not short-circuit");
        assert!(response.sufficient);
        assert_eq!(response.have, lookback + lookahead);
        assert_eq!(response.need, lookback + lookahead, "`need` reports what THIS run needs in total");
    }

    #[test]
    fn a_thin_lake_tested_at_its_earliest_bar_backfills_that_bar_s_full_leading_context() {
        // The reported incident, to scale: a symbol with a handful of bhavcopy
        // days, a deep algorithm, and the UI's default selected day (the
        // entry's EARLIEST bar). The earliest bar has exactly one bar of
        // leading context, so the walk owes `lookback - 1` genuinely new days
        // -- and every one of them is older than the selection, so every one
        // counts toward the side that was short.
        let lookback = lookback_of("garch");
        assert!(lookback > 8, "this fixture needs an algorithm deeper than the lake it starts with");
        let lookahead = 5;
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let already = weekly_candles(date(2024, 1, 15), 8);
        store.write_sourced_candles("NSE:ZYDUSWELL", BACKFILL_TIMEFRAME, BACKFILL_SOURCE, &already).unwrap();
        let earliest = date(2023, 11, 27);
        let from_ts = selected_day_ts(earliest);
        let end_of_selected_day = from_ts + DAY_SECONDS;
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["ZYDUSWELL"]))
        };
        let mut progress: Vec<(usize, usize)> = Vec::new();

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:ZYDUSWELL", "garch", lookahead, from_ts),
            date(2024, 1, 15),
            &mut fetch,
            &mut |index, total| progress.push((index, total)),
        );

        assert_eq!(attempts.len(), lookback - 1, "one fetch per missing leading bar");
        assert!(attempts.iter().all(|d| *d < earliest), "backfill only ever reaches days older than the selection");
        assert!(response.sufficient);
        assert_eq!(response.need, lookback + lookahead);
        assert_eq!(response.have, lookback + lookahead);
        assert_eq!(progress.first(), Some(&(2, lookback)), "progress counts leading bars toward the lookback");
        assert_eq!(progress.last(), Some(&(lookback, lookback)));
        // The selected bar really does have its full leading context now, and
        // the trailing bars it started with are untouched.
        let final_lake = store.read_sourced_candles("NSE:ZYDUSWELL", "day", "bhavcopy").unwrap();
        assert_eq!(final_lake.iter().filter(|c| c.ts < end_of_selected_day).count(), lookback);
        assert_eq!(final_lake.iter().filter(|c| c.ts >= end_of_selected_day).count(), 7);
    }

    #[test]
    fn a_selected_day_without_enough_trailing_bars_is_answered_without_fetching() {
        // Backfill walks strictly BACKWARD, so it can only ever add bars older
        // than the selection. A selection with too few bars after it is
        // structurally unfixable -- spending ten minutes on the archive would
        // end in the same answer, so give it now.
        let lookback = lookback_of("obv");
        let lookahead = 5;
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        store
            .write_sourced_candles("NSE:INFY", BACKFILL_TIMEFRAME, BACKFILL_SOURCE, &weekly_candles(date(2024, 1, 15), 3))
            .unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };
        let mut progress: Vec<(usize, usize)> = Vec::new();

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv", lookahead, selected_day_ts(date(2024, 1, 1))),
            date(2024, 1, 15),
            &mut fetch,
            &mut |index, total| progress.push((index, total)),
        );

        assert!(attempts.is_empty(), "no fetch can put a bar AFTER the selected day");
        assert!(progress.is_empty());
        assert!(!response.sufficient);
        assert_eq!(response.need, lookback + lookahead);
        // One usable leading bar (the selection itself) and two usable trailing.
        assert_eq!(response.have, 3);
        assert!(
            response.have < response.need,
            "a trailing-limited shortfall must still read as a shortfall: {} >= {}",
            response.have,
            response.need
        );
        assert!(!response.archive_exhausted, "nothing was asked of the archive");
        assert_eq!(response.error, None);
    }

    #[test]
    fn the_selected_day_s_own_candle_counts_as_leading_context_not_as_a_bar_to_score_against() {
        // The phase-defining incident, at its exact boundary: a symbol holding
        // exactly `lookahead` bars, tested at the UI's default day (the
        // earliest). Only `lookahead - 1` bars follow the selection, so the
        // run's scoring gate can never clear -- but counting the selected day's
        // OWN candle as a trailing bar (which is what splitting at `from_ts`
        // does, since the candle is stamped 10 hours after midnight) makes the
        // trailing side look exactly one bar deeper than it is and the whole
        // walk end in a false `sufficient: true`.
        let lookback = lookback_of("obv");
        let lookahead = 5;
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let already = weekly_candles(date(2024, 1, 15), lookahead);
        store.write_sourced_candles("NSE:INFY", BACKFILL_TIMEFRAME, BACKFILL_SOURCE, &already).unwrap();
        let earliest = date(2023, 12, 18);
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv", lookahead, selected_day_ts(earliest)),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        assert!(
            !response.sufficient,
            "{lookahead} bars with the earliest selected leaves only {} to score against",
            lookahead - 1
        );
        assert!(attempts.is_empty(), "no backward fetch can add a bar AFTER the selection, so none should be spent");
        assert_eq!(response.need, lookback + lookahead);
        // One usable leading bar (the selection itself) and the four after it.
        assert_eq!(response.have, 1 + (lookahead - 1));
        assert!(response.have < response.need);
        assert_eq!(response.error, None);
    }

    #[test]
    fn a_selected_day_the_symbol_never_traded_is_refused_instead_of_silently_passing() {
        // A Saturday (or a holiday, or a day inside a listing gap): the lake
        // holds plenty of context on both sides, but there is no candle ON the
        // selected day, so the run has nothing to make a decision about. The
        // walk cannot manufacture one either -- it only ever fetches days older
        // than the lake's earliest bar -- so this must be an immediate, honest
        // refusal rather than a `sufficient: true` that yields zero decision
        // points and no banner.
        let lookahead = 1;
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        store
            .write_sourced_candles(
                "NSE:INFY",
                BACKFILL_TIMEFRAME,
                BACKFILL_SOURCE,
                &weekly_candles(date(2024, 1, 15), 10),
            )
            .unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };

        // Sat 2024-01-13 sits between the Mon 8 and Mon 15 bars the lake holds.
        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv", lookahead, selected_day_ts(date(2024, 1, 13))),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        assert!(!response.sufficient, "a day the symbol never traded cannot be benchmarked");
        assert!(attempts.is_empty(), "backfill cannot manufacture a trading day that did not happen");
        assert_eq!(response.have, 0, "there is no bar for the selected day at all, not merely too little around one");
        assert_eq!(response.need, lookback_of("obv") + lookahead);
        assert!(!response.archive_exhausted, "nothing was asked of the archive");
        assert_eq!(response.error, None);
    }

    #[test]
    fn an_empty_lake_that_fills_around_a_gap_on_the_selected_day_itself_is_still_insufficient() {
        // The one mismatch the review's 857-scenario probe found: an empty
        // lake, a `from_ts` landing on `today` (so the walk's own starting
        // point IS the selection), and a symbol that happens to be absent
        // specifically on that one day but present on the days just before
        // it. The walk fills `leading` past `lookback` from those older days
        // alone, so a check that trusts leading/trailing counts without also
        // confirming a candle exists ON the selection reports a false
        // `sufficient: true` -- the empty-lake carve-out was "argued
        // unreachable" via the UI picker, not structurally impossible here.
        let lookback = lookback_of("obv");
        assert!(lookback == 2, "this fixture is sized for obv's 2-bar lookback");
        let today = date(2024, 1, 15);
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            let symbols: &[&str] = if d == today { &["TCS"] } else { &["INFY"] };
            attempts.push(d);
            Ok(bhavcopy_csv(d, symbols))
        };

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv", 0, selected_day_ts(today)),
            today,
            &mut fetch,
            &mut |_, _| {},
        );

        assert!(!response.sufficient, "the selection itself has no candle, no matter how deep the older context is");
        assert_eq!(response.have, 0, "a day with no candle at all must report zero usable bars, not a nonzero count");
        assert_eq!(response.need, lookback);
    }

    #[test]
    fn an_insufficient_answer_never_claims_more_history_than_it_says_it_needs() {
        // The leading-limited mirror of the test above: the trailing side is
        // fully satisfied and the walk really runs, but the symbol is in no
        // older bhavcopy. "NSE:ZYDUSWELL has 6 days of real listed history;
        // this run needs 7" -- never the reverse.
        let lookback = lookback_of("obv");
        let lookahead = 5;
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        store
            .write_sourced_candles(
                "NSE:ZYDUSWELL",
                BACKFILL_TIMEFRAME,
                BACKFILL_SOURCE,
                &weekly_candles(date(2024, 1, 15), lookahead + 1),
            )
            .unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["TCS"]))
        };

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:ZYDUSWELL", "obv", lookahead, selected_day_ts(date(2023, 12, 11))),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        assert_eq!(attempts.len(), ABSENT_DAY_LIMIT, "the leading side is fixable in principle, so it is tried");
        assert!(!response.sufficient);
        assert_eq!(response.need, lookback + lookahead);
        assert_eq!(response.have, 1 + lookahead, "one leading bar found, the full trailing window already held");
        assert!(
            response.have < response.need,
            "an insufficient answer that shows have >= need reads as a contradiction: {} >= {}",
            response.have,
            response.need
        );
    }

    #[test]
    fn ten_consecutive_absent_trading_days_stop_the_walk_and_report_the_real_history() {
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["TCS"]))
        };
        let mut progress: Vec<(usize, usize)> = Vec::new();

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:ZYDUSWELL", "obv", 0, selected_day_ts(date(2024, 1, 15))),
            date(2024, 1, 15),
            &mut fetch,
            &mut |index, total| progress.push((index, total)),
        );

        assert!(!response.sufficient);
        assert_eq!(response.have, 0, "have is the symbol's real available history");
        assert_eq!(response.need, lookback_of("obv"));
        assert_eq!(response.error, None, "an absent symbol is an answer, not a failure");
        assert!(
            !response.archive_exhausted,
            "every day here fetched fine -- this is a fact about the symbol, not the archive"
        );
        // Mon 15, Fri 12, Thu 11, Wed 10, Tue 9, Mon 8, Fri 5, Thu 4, Wed 3, Tue 2.
        assert_eq!(attempts.len(), ABSENT_DAY_LIMIT);
        assert_eq!(attempts.last(), Some(&date(2024, 1, 2)));
        assert!(progress.is_empty());
    }

    #[test]
    fn an_archive_that_answers_nothing_is_reported_as_exhausted_not_as_a_short_history() {
        // A backfill that walks past the archive's coverage must not come back
        // saying "NSE:INFY has 0 days of listed history" -- it cannot know that.
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| -> Result<Vec<u8>, IngestionError> {
            attempts.push(d);
            Err(IngestionError::NotFound)
        };

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv", 0, selected_day_ts(date(2024, 1, 15))),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        assert!(response.archive_exhausted, "the third outcome must reach the response");
        assert!(!response.sufficient);
        assert_eq!(response.have, 0);
        assert_eq!(response.need, lookback_of("obv"));
        assert_eq!(response.error, None, "a silent archive is an answer, not a transport failure");
        // Bounded, not infinite -- this is the whole point of the cap.
        assert_eq!(attempts.len(), CLOSED_DAY_LIMIT);
    }

    #[test]
    fn one_present_day_resets_the_absent_streak_instead_of_stopping_at_ten_overall() {
        let lookback = lookback_of("obv");
        assert!(lookback >= 2, "this fixture needs a lookback of at least 2 to avoid stopping at the present day");
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            let symbols: &[&str] = if d == date(2024, 1, 5) { &["ZYDUSWELL"] } else { &["TCS"] };
            Ok(bhavcopy_csv(d, symbols))
        };

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:ZYDUSWELL", "obv", 0, selected_day_ts(date(2024, 1, 15))),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        // Six absent trading days (15, 12, 11, 10, 9, 8), then Fri 5 present
        // (streak resets), then ten more absent (4, 3, 2, 1, Dec 29, 28, 27,
        // 26, 25, 22) trips the limit. Without a reset it would have stopped
        // after ten fetches total.
        assert_eq!(attempts.len(), 17);
        assert_eq!(attempts.last(), Some(&date(2023, 12, 22)));
        assert_eq!(response.have, 0, "the found candle is on Jan 5, not on the Jan 15 selection itself");
        assert!(!response.sufficient);
    }

    #[test]
    fn a_non_404_fetch_failure_surfaces_as_an_error_and_keeps_what_it_already_persisted() {
        assert!(lookback_of("obv") == 2, "this fixture is sized for obv's 2-bar lookback");
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut fetch = |_e: &str, d: NaiveDate| {
            if d == date(2024, 1, 12) {
                Err(IngestionError::Fetch("network down".to_string()))
            } else {
                Ok(bhavcopy_csv(d, &["INFY"]))
            }
        };

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv", 0, selected_day_ts(date(2024, 1, 15))),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        assert!(!response.sufficient);
        assert_eq!(response.have, 1, "Monday's candle stays committed");
        let message = response.error.expect("a non-404 failure must be reported, not swallowed");
        assert!(message.contains("network down"), "got {message}");
        assert_eq!(store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap().len(), 1);
    }

    #[test]
    fn an_unknown_algo_id_needs_nothing_and_fetches_nothing() {
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };

        // Lookahead 0 because this is the defensive path only: the picker feeds
        // ids straight from list_algorithms, so an unknown one never arrives
        // alongside a real run's scoring window.
        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "__not_an_algorithm__", 0, selected_day_ts(date(2024, 1, 15))),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        assert_eq!(response.need, 0);
        assert_eq!(response.have, 0);
        assert!(response.sufficient);
        assert!(attempts.is_empty());
    }

    #[test]
    fn resolve_picks_a_day_with_zero_fetches_when_the_lake_already_has_enough_on_both_sides() {
        // Mirrors an_already_deep_enough_lake_answers_immediately_with_zero_fetches,
        // but through the new entry point: nothing supplies from_ts, so the
        // picked day must be the newest candle minus `lookahead` positions.
        let lookahead = 1;
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        store
            .write_sourced_candles(
                "NSE:INFY",
                BACKFILL_TIMEFRAME,
                BACKFILL_SOURCE,
                &[candle_at(date(2024, 1, 15)), candle_at(date(2024, 1, 12)), candle_at(date(2024, 1, 11))],
            )
            .unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };

        let response = handle_resolve_benchmark_window(
            &store,
            ResolveBenchmarkWindowRequest { id: 7, symbol: "NSE:INFY".to_string(), algo_id: "obv".to_string(), lookahead },
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        assert_eq!(response.id, 7);
        // Newest is Jan 15 (index 0); index `lookahead` = 1 is Jan 12.
        assert_eq!(response.from_ts, selected_day_ts(date(2024, 1, 12)));
        assert_eq!(response.need, lookback_of("obv") + lookahead);
        assert_eq!(response.have, lookback_of("obv") + lookahead);
        assert!(response.sufficient);
        assert!(attempts.is_empty(), "a deep-enough lake must never hit the network");
    }

    #[test]
    fn resolve_refuses_immediately_when_the_whole_lake_is_thinner_than_the_lookahead_alone() {
        // Trailing can never reach `lookahead` no matter which day is picked
        // when the lake holds fewer rows than that in total -- the same
        // structural refusal a_selected_day_without_enough_trailing_bars_is_answered_without_fetching
        // exercises, reached here through candidate selection instead of a
        // caller-supplied from_ts.
        let lookahead = 5;
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        store
            .write_sourced_candles("NSE:INFY", BACKFILL_TIMEFRAME, BACKFILL_SOURCE, &weekly_candles(date(2024, 1, 15), 3))
            .unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };

        let response = handle_resolve_benchmark_window(
            &store,
            ResolveBenchmarkWindowRequest { id: 7, symbol: "NSE:INFY".to_string(), algo_id: "obv".to_string(), lookahead },
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        assert!(!response.sufficient);
        assert!(attempts.is_empty(), "a lake this thin can never be fixed by fetching, so nothing should be attempted");
        assert_eq!(response.need, lookback_of("obv") + lookahead);
    }

    #[test]
    fn resolve_still_drives_the_leading_side_backfill_walk_when_needed() {
        // The phase-defining incident, reached through resolve(): a thin lake
        // and a deep algorithm, with no from_ts supplied at all.
        let lookback = lookback_of("garch");
        assert!(lookback > 8, "this fixture needs an algorithm deeper than the lake it starts with");
        let lookahead = 5;
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        store
            .write_sourced_candles("NSE:ZYDUSWELL", BACKFILL_TIMEFRAME, BACKFILL_SOURCE, &weekly_candles(date(2024, 1, 15), 8))
            .unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["ZYDUSWELL"]))
        };

        let response = handle_resolve_benchmark_window(
            &store,
            ResolveBenchmarkWindowRequest { id: 7, symbol: "NSE:ZYDUSWELL".to_string(), algo_id: "garch".to_string(), lookahead },
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        // 8 candles held (index 0 = newest, index 7 = earliest), lookahead 5 ->
        // candidate is the candle at index 5 (the 6th newest) = Dec 11, two weeks
        // in from the earliest (Nov 27).
        assert!(response.sufficient);
        assert_eq!(response.from_ts, selected_day_ts(date(2023, 12, 11)));
        assert_eq!(response.need, lookback + lookahead);
        assert_eq!(response.have, lookback + lookahead);
        assert!(!attempts.is_empty(), "the leading side was short, so the walk must have run");
    }
}
