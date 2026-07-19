use crate::csv_util::{col, header_index};
use crate::error::IngestionError;
use crate::model::ParsedCandle;
use crate::time::ist_session_close_epoch;
use chrono::NaiveDate;
use csv::{ReaderBuilder, StringRecord, Trim};
use storage::Candle;

fn get(r: &StringRecord, i: usize) -> Result<&str, IngestionError> {
    r.get(i).ok_or_else(|| IngestionError::BadField { column: format!("index {i}"), value: "<missing>".to_string() })
}

fn num(r: &StringRecord, i: usize, name: &str) -> Result<f64, IngestionError> {
    let v = get(r, i)?;
    v.parse::<f64>().map_err(|_| IngestionError::BadField { column: name.to_string(), value: v.to_string() })
}

pub fn parse_nse_indices_close(csv_bytes: &[u8]) -> Result<Vec<ParsedCandle>, IngestionError> {
    let mut reader = ReaderBuilder::new().trim(Trim::All).from_reader(csv_bytes);
    let headers = reader.headers()?.clone();
    let idx = header_index(&headers);

    let c_name = col(&idx, "Index Name")?;
    let c_date = col(&idx, "Index Date")?;
    let c_o = col(&idx, "Open Index Value")?;
    let c_h = col(&idx, "High Index Value")?;
    let c_l = col(&idx, "Low Index Value")?;
    let c_c = col(&idx, "Closing Index Value")?;

    let mut out = Vec::new();
    for record in reader.records() {
        let record = record?;
        let date_str = get(&record, c_date)?;
        let date = NaiveDate::parse_from_str(date_str, "%d-%m-%Y")
            .map_err(|_| IngestionError::BadField { column: "Index Date".to_string(), value: date_str.to_string() })?;
        out.push(ParsedCandle {
            symbol: format!("NSE:{}", get(&record, c_name)?),
            timeframe: "day".to_string(),
            candle: Candle {
                ts: ist_session_close_epoch(date),
                open: num(&record, c_o, "Open Index Value")?,
                high: num(&record, c_h, "High Index Value")?,
                low: num(&record, c_l, "Low Index Value")?,
                close: num(&record, c_c, "Closing Index Value")?,
                volume: 0, // design §5.1: indices report volume 0
            },
        });
    }
    Ok(out)
}
