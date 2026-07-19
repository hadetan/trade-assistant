use crate::csv_util::{col, header_index};
use crate::error::IngestionError;
use crate::model::ParsedCandle;
use chrono::DateTime;
use csv::{ReaderBuilder, StringRecord, Trim};
use storage::Candle;

fn get(r: &StringRecord, i: usize) -> Result<&str, IngestionError> {
    r.get(i).ok_or_else(|| IngestionError::BadField { column: format!("index {i}"), value: "<missing>".to_string() })
}

fn num(r: &StringRecord, i: usize, name: &str) -> Result<f64, IngestionError> {
    let v = get(r, i)?;
    v.parse::<f64>().map_err(|_| IngestionError::BadField { column: name.to_string(), value: v.to_string() })
}

fn int(r: &StringRecord, i: usize, name: &str) -> Result<i64, IngestionError> {
    let v = get(r, i)?;
    v.parse::<i64>().map_err(|_| IngestionError::BadField { column: name.to_string(), value: v.to_string() })
}

pub fn parse_intraday_ohlcv(csv_bytes: &[u8], symbol: &str) -> Result<Vec<ParsedCandle>, IngestionError> {
    let mut reader = ReaderBuilder::new().trim(Trim::All).from_reader(csv_bytes);
    let headers = reader.headers()?.clone();
    let idx = header_index(&headers);

    let c_date = col(&idx, "date")?;
    let (c_o, c_h, c_l, c_c, c_v) = (
        col(&idx, "open")?,
        col(&idx, "high")?,
        col(&idx, "low")?,
        col(&idx, "close")?,
        col(&idx, "volume")?,
    );

    let mut out = Vec::new();
    for record in reader.records() {
        let record = record?;
        let raw = get(&record, c_date)?;
        // Normalize a space separator to RFC3339's 'T'; parse OFFSET-AWARE so the
        // +05:30 is honored, never stripped to naive (design §5.2 bug class).
        let normalized = raw.replacen(' ', "T", 1);
        let dt = DateTime::parse_from_rfc3339(&normalized)
            .map_err(|_| IngestionError::BadField { column: "date".to_string(), value: raw.to_string() })?;
        out.push(ParsedCandle {
            symbol: symbol.to_string(),
            timeframe: "minute".to_string(),
            candle: Candle {
                ts: dt.timestamp(),
                open: num(&record, c_o, "open")?,
                high: num(&record, c_h, "high")?,
                low: num(&record, c_l, "low")?,
                close: num(&record, c_c, "close")?,
                volume: int(&record, c_v, "volume")?,
            },
        });
    }
    Ok(out)
}
