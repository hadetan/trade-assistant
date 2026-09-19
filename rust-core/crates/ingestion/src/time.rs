use chrono::{DateTime, FixedOffset, NaiveDate, TimeZone};

fn ist_offset() -> FixedOffset {
    FixedOffset::east_opt(5 * 3600 + 30 * 60).expect("IST is a valid fixed offset")
}

/// The instant a daily candle is final: 15:30 IST session close, as an absolute
/// Unix epoch (seconds). Encoding the exchange-local session boundary as absolute
/// time keeps backtest frontier comparisons locale-independent while anchored to
/// session time (design §6.4). Panics only on an impossible offset/time, which
/// are compile-time constants here.
pub fn ist_session_close_epoch(date: NaiveDate) -> i64 {
    let naive = date.and_hms_opt(15, 30, 0).expect("15:30 is a valid time of day");
    ist_offset().from_local_datetime(&naive).unwrap().timestamp()
}

/// Which IST calendar date an absolute instant falls on -- the inverse of
/// `ist_session_close_epoch`, and the bridge from a stored candle `ts` (or
/// `Utc::now().timestamp()`) back to the `NaiveDate` a bhavcopy walk needs.
pub fn ist_date_from_epoch(ts: i64) -> NaiveDate {
    let at: DateTime<FixedOffset> = ist_offset()
        .timestamp_opt(ts, 0)
        .single()
        .expect("a fixed offset yields exactly one local time for any epoch second");
    at.date_naive()
}

#[cfg(test)]
mod tests {
    use super::{ist_date_from_epoch, ist_session_close_epoch};
    use chrono::NaiveDate;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("test dates are valid")
    }

    #[test]
    fn ist_date_from_epoch_inverts_ist_session_close_epoch() {
        for day in [date(2024, 1, 15), date(2023, 12, 29), date(2026, 9, 18)] {
            assert_eq!(ist_date_from_epoch(ist_session_close_epoch(day)), day);
        }
    }

    #[test]
    fn ist_date_from_epoch_classifies_by_the_ist_calendar_date_not_the_utc_one() {
        // 2024-01-15 00:00 IST is 2024-01-14 18:30 UTC: a UTC-based conversion
        // would answer the 14th. 15:30 IST close is 1_705_312_800, and midnight
        // that morning is 15.5 hours (55_800s) earlier.
        assert_eq!(ist_date_from_epoch(1_705_257_000), date(2024, 1, 15));
        assert_eq!(ist_date_from_epoch(1_705_256_999), date(2024, 1, 14));
    }
}
