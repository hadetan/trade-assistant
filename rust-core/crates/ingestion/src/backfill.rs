use crate::bhavcopy::parse_udiff_equity_bhavcopy;
use crate::error::IngestionError;
use crate::model::ParsedCandle;
use chrono::{Datelike, NaiveDate, Weekday};
use std::ops::ControlFlow;

/// Gap between two anonymous requests to NSE's public archive. A from-scratch
/// 512-bar backfill is ~750 requests; back-to-back they read as a scrape to any
/// rate limiter in front of the archive (P14§2 item 6). Callers own the actual
/// sleep -- this module stays free of timing I/O so its tests run instantly.
pub const POLITENESS_DELAY_MS: u64 = 200;

/// Consecutive *weekday* 404s before the walk concludes the archive itself has
/// stopped answering -- walked past the archive's coverage, or its URL format
/// changed (P14§9). Weekends never reach the network and never count. The
/// longest real NSE closure is a handful of consecutive weekdays, so 30 (six
/// calendar weeks) is generous against any genuine holiday cluster while still
/// bounding the worst case to 30 wasted requests, ~6s at POLITENESS_DELAY_MS,
/// instead of an unbounded backward walk. Deliberately separate from the
/// sidecar's ABSENT_DAY_LIMIT: that one counts days the *symbol* is missing
/// from a file that was fetched successfully (decision (xviii)).
pub const CLOSED_DAY_LIMIT: usize = 30;

/// Injected day fetcher: given an exchange and a date, hand back that day's raw
/// archive bytes. Every walker takes one of these rather than doing its own
/// network I/O, which is what keeps this crate's tests offline and instant.
pub type DayFetcher<'a> = &'a mut dyn FnMut(&str, NaiveDate) -> Result<Vec<u8>, IngestionError>;

/// One calendar day, after the "was the market open?" question is settled.
#[derive(Debug)]
pub enum TradingDay {
    Traded(Vec<u8>),
    Closed,
}

/// Why a walk ended. Both are ordinary, non-error outcomes -- a real failure
/// comes back as `Err` instead.
#[derive(Debug, PartialEq, Eq)]
pub enum WalkStop {
    /// `on_day` returned `ControlFlow::Break`: the caller got what it wanted.
    CallerStopped,
    /// `CLOSED_DAY_LIMIT` weekdays in a row had no file. The caller cannot tell
    /// from here whether the archive stopped covering these dates or stopped
    /// working, so it must not report this as "the symbol has no more history".
    ArchiveExhausted,
}

/// One real trading day's result for a single symbol.
#[derive(Debug)]
pub struct DayOutcome {
    pub date: NaiveDate,
    /// `None` when the day's file carries no EQ row for this symbol -- the
    /// signal the caller counts toward "this symbol isn't listed that far
    /// back" (P14§2 item 4).
    pub candle: Option<ParsedCandle>,
}

/// The single place that decides whether a calendar day is a trading day.
/// Weekends are answered without a network attempt; a 404 means the archive
/// has no file for that date, i.e. a market holiday (P14§2 item 3).
pub fn fetch_trading_day(
    exchange: &str,
    date: NaiveDate,
    fetch: DayFetcher<'_>,
) -> Result<TradingDay, IngestionError> {
    if matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
        return Ok(TradingDay::Closed);
    }
    match fetch(exchange, date) {
        Ok(bytes) => Ok(TradingDay::Traded(bytes)),
        Err(IngestionError::NotFound) => Ok(TradingDay::Closed),
        Err(e) => Err(e),
    }
}

/// Walk calendar days backward from `start`, handing every real trading day's
/// row for `symbol` to `on_day`.
///
/// Two independent exits, because the caller's is not enough on its own:
/// `on_day` returning `ControlFlow::Break` (the caller is satisfied), and
/// `CLOSED_DAY_LIMIT` consecutive weekday 404s. `on_day` is invoked ONLY for a
/// successfully fetched day, so without the second exit a stretch of days the
/// archive has no files for would advance no stop condition at all and the walk
/// would step backward forever (decision (xviii)).
pub fn walk_trading_days_backward(
    exchange: &str,
    symbol: &str,
    start: NaiveDate,
    fetch: DayFetcher<'_>,
    on_day: &mut dyn FnMut(DayOutcome) -> ControlFlow<()>,
) -> Result<WalkStop, IngestionError> {
    let mut date = start;
    let mut consecutive_closed = 0usize;
    loop {
        match fetch_trading_day(exchange, date, fetch)? {
            TradingDay::Traded(bytes) => {
                consecutive_closed = 0;
                let candle = parse_udiff_equity_bhavcopy(&bytes, exchange)?
                    .into_iter()
                    .find(|parsed| parsed.symbol == symbol);
                if on_day(DayOutcome { date, candle }).is_break() {
                    return Ok(WalkStop::CallerStopped);
                }
            }
            // A weekend is Closed without a request, so only a weekday Closed
            // is evidence about the archive.
            TradingDay::Closed if !matches!(date.weekday(), Weekday::Sat | Weekday::Sun) => {
                consecutive_closed += 1;
                if consecutive_closed >= CLOSED_DAY_LIMIT {
                    return Ok(WalkStop::ArchiveExhausted);
                }
            }
            TradingDay::Closed => {}
        }
        date = date
            .pred_opt()
            .ok_or_else(|| IngestionError::Fetch("walked past the earliest representable date".to_string()))?;
    }
}
