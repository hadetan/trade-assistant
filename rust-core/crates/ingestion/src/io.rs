use crate::error::IngestionError;
use chrono::NaiveDate;
use std::io::Read;

fn bhavcopy_url(date: NaiveDate, exchange: &str) -> Result<String, IngestionError> {
    let ymd = date.format("%Y%m%d");
    match exchange {
        "NSE" => Ok(format!(
            "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{ymd}_F_0000.csv.zip"
        )),
        "BSE" => Ok(format!(
            "https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{ymd}_F_0000.CSV"
        )),
        other => Err(IngestionError::Fetch(format!("unknown exchange {other}"))),
    }
}

fn unzip_single_csv(zip_bytes: &[u8]) -> Result<Vec<u8>, IngestionError> {
    let reader = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| IngestionError::Fetch(e.to_string()))?;
    let mut file = archive.by_index(0).map_err(|e| IngestionError::Fetch(e.to_string()))?;
    let mut out = Vec::new();
    file.read_to_end(&mut out)?;
    Ok(out)
}

/// reqwest's own `error_for_status` collapses every 4xx/5xx into one opaque
/// error, which is why this exists: 404 alone means "no file for this date",
/// and a backward trading-day walk must treat that as a skip, not a failure.
/// Pure so the contract is testable without a network or a mock server.
fn error_for_http_status(status: u16, url: &str) -> Option<IngestionError> {
    match status {
        404 => Some(IngestionError::NotFound),
        code if (400..600).contains(&code) => Some(IngestionError::Fetch(format!("HTTP {code} for {url}"))),
        _ => None,
    }
}

/// Download one day's UDiFF equity bhavcopy and return decompressed CSV bytes.
/// A `User-Agent` is mandatory (design §10.1: a bare request gets a connection
/// reset). rustls only (Global Constraints). Network-touching — exercised only
/// by the #[ignore]d smoke test, never by CI's default run.
pub fn fetch_udiff_bhavcopy(date: NaiveDate, exchange: &str) -> Result<Vec<u8>, IngestionError> {
    let url = bhavcopy_url(date, exchange)?;
    let client = reqwest::blocking::Client::builder()
        .user_agent("trade-assistant/0.1 (personal-use)")
        .build()
        .map_err(|e| IngestionError::Fetch(e.to_string()))?;
    let resp = client.get(&url).send().map_err(|e| IngestionError::Fetch(e.to_string()))?;
    if let Some(error) = error_for_http_status(resp.status().as_u16(), &url) {
        return Err(error);
    }
    let bytes = resp.bytes().map_err(|e| IngestionError::Fetch(e.to_string()))?.to_vec();
    if exchange == "NSE" {
        unzip_single_csv(&bytes)
    } else {
        Ok(bytes) // BSE serves a plain .CSV
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_404_maps_to_not_found_so_a_market_holiday_is_distinguishable_from_an_outage() {
        assert!(matches!(
            error_for_http_status(404, "https://nsearchives.nseindia.com/x.zip"),
            Some(IngestionError::NotFound)
        ));
    }

    #[test]
    fn every_other_error_status_keeps_the_opaque_fetch_variant_with_the_status_and_url() {
        match error_for_http_status(500, "https://nsearchives.nseindia.com/x.zip") {
            Some(IngestionError::Fetch(message)) => {
                assert!(message.contains("500"), "message must name the status: {message}");
                assert!(message.contains("nsearchives"), "message must name the url: {message}");
            }
            other => panic!("expected Fetch for a 500, got {other:?}"),
        }
        assert!(matches!(error_for_http_status(403, "u"), Some(IngestionError::Fetch(_))));
        assert!(matches!(error_for_http_status(400, "u"), Some(IngestionError::Fetch(_))));
        assert!(matches!(error_for_http_status(599, "u"), Some(IngestionError::Fetch(_))));
    }

    #[test]
    fn success_and_redirect_statuses_produce_no_error_at_all() {
        assert!(error_for_http_status(200, "u").is_none());
        assert!(error_for_http_status(302, "u").is_none());
        assert!(error_for_http_status(399, "u").is_none());
    }

    #[test]
    fn not_found_has_its_own_display_text() {
        assert_eq!(IngestionError::NotFound.to_string(), "not found (404)");
    }
}
