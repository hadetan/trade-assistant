use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, OptionChainSnapshot, StrikeRow, Timeframe};
use chrono::{DateTime, Utc};

fn ctx_with_chain(chain: Option<OptionChainSnapshot>) -> MarketContext {
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let mut ctx = MarketContext::from_closes(
        "NSE:NIFTY",
        Timeframe::Day,
        Horizon::Positional,
        vec![],
        as_of,
    );
    ctx.chain = chain;
    ctx
}

#[test]
fn registry_contains_put_call_ratio() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"put_call_ratio"));
}

#[test]
fn put_call_ratio_matches_brief_reference_value() {
    // Sigma put_oi = 1500, Sigma call_oi = 1000 -> PCR = 1.5
    let chain = OptionChainSnapshot {
        spot: 100.0,
        strikes: vec![
            StrikeRow {
                strike: 90.0,
                call_oi: 400.0,
                put_oi: 600.0,
            },
            StrikeRow {
                strike: 100.0,
                call_oi: 600.0,
                put_oi: 900.0,
            },
        ],
    };
    let ctx = ctx_with_chain(Some(chain));

    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "put_call_ratio")
        .expect("put_call_ratio not registered");

    let output = algo.compute(&ctx);

    assert!((output.magnitude - 1.5).abs() < 1e-9);
    assert_eq!(output.direction, Direction::Neutral);
    assert!(output.evidence[0].contains("1.50"));
}

#[test]
fn put_call_ratio_guards_zero_call_oi() {
    let chain = OptionChainSnapshot {
        spot: 100.0,
        strikes: vec![StrikeRow {
            strike: 100.0,
            call_oi: 0.0,
            put_oi: 500.0,
        }],
    };
    let ctx = ctx_with_chain(Some(chain));

    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "put_call_ratio")
        .expect("put_call_ratio not registered");

    let output = algo.compute(&ctx);

    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.evidence[0], "undefined pcr (zero call OI)");
}
