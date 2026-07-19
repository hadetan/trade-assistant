use chrono::{FixedOffset, NaiveDate, TimeZone};

/// The instant a daily candle is final: 15:30 IST session close, as an absolute
/// Unix epoch (seconds). Encoding the exchange-local session boundary as absolute
/// time keeps backtest frontier comparisons locale-independent while anchored to
/// session time (design §6.4). Panics only on an impossible offset/time, which
/// are compile-time constants here.
pub fn ist_session_close_epoch(date: NaiveDate) -> i64 {
    let ist = FixedOffset::east_opt(5 * 3600 + 30 * 60).unwrap();
    let naive = date.and_hms_opt(15, 30, 0).unwrap();
    ist.from_local_datetime(&naive).unwrap().timestamp()
}
