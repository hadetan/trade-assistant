use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn garch_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();

    assert!(ids.contains(&"garch"));
}

#[test]
fn garch_compute_forecasts_neutral_finite_volatility() {
    let algos = registry::all();
    let algo = algos
        .into_iter()
        .find(|a| a.id() == "garch")
        .expect("garch must be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    // Deterministic synthetic price path (alternating +1%/-0.8% moves) long
    // enough to clear required_lookback and give the Nelder-Mead fit real
    // return variance to work with. The brief's exact recursion/long-run
    // values (omega=1e-5, alpha=0.10, beta=0.85 -> long-run var 0.0002) are
    // pinned as unit tests on the pure formulas inside garch.rs instead of
    // here, since the fitted (omega, alpha, beta) from MLE on arbitrary
    // closes is the optimizer's output, not a value the brief specifies.
    let mut closes = Vec::with_capacity(60);
    let mut price = 100.0;
    closes.push(price);
    for i in 0..59 {
        let pct = if i % 2 == 0 { 0.01 } else { -0.008 };
        price *= 1.0 + pct;
        closes.push(price);
    }

    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        closes,
        as_of,
    );

    assert!(algo.required_lookback() <= ctx.closes.len());
    let output = algo.compute(&ctx);

    assert_eq!(output.algo_id, "garch");
    // GARCH forecasts volatility, not price direction -- always Neutral.
    assert_eq!(output.direction, Direction::Neutral);
    assert!(output.magnitude > 0.0);
    assert!(output.magnitude.is_finite());
    assert!(output.evidence[0].to_lowercase().contains("long-run"));
    assert_eq!(output.computed_at, as_of);
}
