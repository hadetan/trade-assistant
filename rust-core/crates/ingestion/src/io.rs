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
    let resp = client
        .get(&url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| IngestionError::Fetch(e.to_string()))?;
    let bytes = resp.bytes().map_err(|e| IngestionError::Fetch(e.to_string()))?.to_vec();
    if exchange == "NSE" {
        unzip_single_csv(&bytes)
    } else {
        Ok(bytes) // BSE serves a plain .CSV
    }
}
