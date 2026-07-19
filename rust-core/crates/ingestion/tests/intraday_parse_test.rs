use ingestion::intraday::parse_intraday_ohlcv;

const SAMPLE: &[u8] = include_bytes!("fixtures/kaggle_banknifty_minute_sample.csv");

#[test]
fn parses_minute_bars_offset_aware() {
    let parsed = parse_intraday_ohlcv(SAMPLE, "NSE:BANKNIFTY").unwrap();

    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0].symbol, "NSE:BANKNIFTY");
    assert_eq!(parsed[0].timeframe, "minute");
    assert_eq!(parsed[0].candle.ts, 1_609_472_700); // 09:15 +05:30 -> 03:45 UTC
    assert_eq!(parsed[0].candle.close, 31010.25);
    assert_eq!(parsed[0].candle.volume, 150000);
    // one-minute spacing preserved
    assert_eq!(parsed[1].candle.ts - parsed[0].candle.ts, 60);
}
