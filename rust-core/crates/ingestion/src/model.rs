use storage::Candle;

/// One parsed OHLCV bar plus the metadata needed to route it into the candle
/// lake. `source` is NOT carried here — it is a whole-file property applied by
/// the importer at write time (a bhavcopy file is entirely one source).
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedCandle {
    pub symbol: String,    // exchange-qualified, e.g. "NSE:INFY"
    pub timeframe: String, // "day" | "minute"
    pub candle: Candle,
}
