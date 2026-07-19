use ingestion::indices::parse_nse_indices_close;

const SAMPLE: &[u8] = include_bytes!("fixtures/nse_indices_close_sample.csv");

#[test]
fn parses_indices_with_zero_volume_and_ist_close_timestamp() {
    let parsed = parse_nse_indices_close(SAMPLE).unwrap();

    assert_eq!(parsed.len(), 2);
    for p in &parsed {
        assert_eq!(p.candle.volume, 0, "index candles carry volume 0 (design §5.1)");
        assert_eq!(p.candle.ts, 1_705_312_800);
        assert_eq!(p.timeframe, "day");
    }
    let nifty = parsed.iter().find(|p| p.symbol == "NSE:Nifty 50").unwrap();
    assert_eq!(nifty.candle.open, 21600.00);
    assert_eq!(nifty.candle.close, 21700.50);
    assert!(parsed.iter().any(|p| p.symbol == "NSE:Nifty Bank"));
}
