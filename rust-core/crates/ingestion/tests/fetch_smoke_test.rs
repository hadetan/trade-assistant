use chrono::NaiveDate;
use ingestion::bhavcopy::parse_udiff_equity_bhavcopy;
use ingestion::io::fetch_udiff_bhavcopy;

#[test]
#[ignore = "hits the live NSE endpoint; run manually with `cargo test -p ingestion -- --ignored`, pick a recent trading day"]
fn fetch_real_nse_bhavcopy_smoke() {
    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let csv = fetch_udiff_bhavcopy(date, "NSE").unwrap();
    let parsed = parse_udiff_equity_bhavcopy(&csv, "NSE").unwrap();
    assert!(!parsed.is_empty());
}
