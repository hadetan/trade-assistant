use crate::csv_util::{col, header_index};
use crate::error::IngestionError;
use crate::model::ParsedCandle;
use crate::time::ist_session_close_epoch;
use chrono::NaiveDate;
use csv::{ReaderBuilder, StringRecord, Trim};
use storage::Candle;

fn field(record: &StringRecord, i: usize) -> Result<&str, IngestionError> {
    record.get(i).ok_or_else(|| IngestionError::BadField {
        column: format!("index {i}"),
        value: "<missing>".to_string(),
    })
}

fn parse_f64(record: &StringRecord, i: usize, name: &str) -> Result<f64, IngestionError> {
    let v = field(record, i)?;
    v.parse::<f64>().map_err(|_| IngestionError::BadField { column: name.to_string(), value: v.to_string() })
}

fn parse_i64(record: &StringRecord, i: usize, name: &str) -> Result<i64, IngestionError> {
    let v = field(record, i)?;
    v.parse::<i64>().map_err(|_| IngestionError::BadField { column: name.to_string(), value: v.to_string() })
}

pub fn parse_udiff_equity_bhavcopy(
    csv_bytes: &[u8],
    exchange: &str,
) -> Result<Vec<ParsedCandle>, IngestionError> {
    let mut reader = ReaderBuilder::new().trim(Trim::All).from_reader(csv_bytes);
    let headers = reader.headers()?.clone();
    let idx = header_index(&headers);

    let (c_series, c_tckr, c_dt) = (col(&idx, "SctySrs")?, col(&idx, "TckrSymb")?, col(&idx, "TradDt")?);
    let (c_o, c_h, c_l, c_c, c_v) = (
        col(&idx, "OpnPric")?,
        col(&idx, "HghPric")?,
        col(&idx, "LwPric")?,
        col(&idx, "ClsPric")?,
        col(&idx, "TtlTradgVol")?,
    );

    let mut out = Vec::new();
    for record in reader.records() {
        let record = record?;
        if record.get(c_series) != Some("EQ") {
            continue;
        }
        let dt_str = field(&record, c_dt)?;
        let date = NaiveDate::parse_from_str(dt_str, "%Y-%m-%d")
            .map_err(|_| IngestionError::BadField { column: "TradDt".to_string(), value: dt_str.to_string() })?;
        out.push(ParsedCandle {
            symbol: format!("{exchange}:{}", field(&record, c_tckr)?),
            timeframe: "day".to_string(),
            candle: Candle {
                ts: ist_session_close_epoch(date),
                open: parse_f64(&record, c_o, "OpnPric")?,
                high: parse_f64(&record, c_h, "HghPric")?,
                low: parse_f64(&record, c_l, "LwPric")?,
                close: parse_f64(&record, c_c, "ClsPric")?,
                volume: parse_i64(&record, c_v, "TtlTradgVol")?,
            },
        });
    }
    Ok(out)
}
