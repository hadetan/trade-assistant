use crate::Timeframe;

/// A single strike/expiry option's Greeks/IV/OI inputs (Wave B: Tasks 20-24).
/// `time_to_expiry_years` is the year-fraction `T` that BSM/IV consume; the
/// absolute bar time this was observed at lives on `MarketContext.timestamps`/
/// `as_of`, not here.
#[derive(Debug, Clone)]
pub struct OptionsContext {
    pub spot: f64,
    pub strike: f64,
    pub rate: f64,
    pub time_to_expiry_years: f64,
    pub is_call: bool,
    pub iv: f64,
    pub oi: f64,
    pub prev_oi: f64,
    pub oi_day_high: f64,
    pub oi_day_low: f64,
    pub market_price: f64,
}

/// One strike's open interest on both legs, as consumed by PCR/Max-Pain.
#[derive(Debug, Clone)]
pub struct StrikeRow {
    pub strike: f64,
    pub call_oi: f64,
    pub put_oi: f64,
}

/// A full option-chain snapshot at one instant, keyed by strike.
#[derive(Debug, Clone)]
pub struct OptionChainSnapshot {
    pub spot: f64,
    pub strikes: Vec<StrikeRow>,
}

/// The second leg of a pair for cointegration/OU spread algorithms (Wave C).
#[derive(Debug, Clone)]
pub struct PeerSeries {
    pub symbol: String,
    pub closes: Vec<f64>,
}

/// A forward-filled higher-timeframe close series for multi-timeframe
/// confluence (Wave C).
#[derive(Debug, Clone)]
pub struct HigherTfSeries {
    pub timeframe: Timeframe,
    pub closes: Vec<f64>,
}
