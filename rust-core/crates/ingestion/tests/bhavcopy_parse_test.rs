use ingestion::bhavcopy::parse_udiff_equity_bhavcopy;

const SAMPLE: &[u8] = include_bytes!("fixtures/nse_bhavcopy_udiff_sample.csv");

#[test]
fn parses_only_eq_series_with_correct_fields_and_ist_close_timestamp() {
    let parsed = parse_udiff_equity_bhavcopy(SAMPLE, "NSE").unwrap();

    assert_eq!(parsed.len(), 2, "BE-series row must be skipped");

    let infy = parsed.iter().find(|p| p.symbol == "NSE:INFY").unwrap();
    assert_eq!(infy.timeframe, "day");
    assert_eq!(infy.candle.ts, 1_705_312_800); // 2024-01-15 15:30 IST -> 10:00 UTC
    assert_eq!(infy.candle.open, 1500.00);
    assert_eq!(infy.candle.high, 1525.50);
    assert_eq!(infy.candle.low, 1495.25);
    assert_eq!(infy.candle.close, 1520.75);
    assert_eq!(infy.candle.volume, 1_234_567);

    assert!(parsed.iter().any(|p| p.symbol == "NSE:TCS"));
    assert!(!parsed.iter().any(|p| p.symbol == "NSE:IDEA"));
}
