use storage::{ConfluenceSnapshot, StateStore};
use tempfile::tempdir;

#[test]
fn watchlist_round_trips_through_sqlite() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("state.sqlite");

    let store = StateStore::open(&db_path).unwrap();
    store.add_watchlist_symbol("NSE:INFY").unwrap();
    store.add_watchlist_symbol("NSE:TCS").unwrap();

    let watchlist = store.watchlist().unwrap();

    assert_eq!(watchlist, vec!["NSE:INFY".to_string(), "NSE:TCS".to_string()]);
}

#[test]
fn remove_watchlist_symbol_removes_only_the_named_symbol() {
    let dir = tempdir().unwrap();
    let store = StateStore::open(&dir.path().join("state.sqlite")).unwrap();
    store.add_watchlist_symbol("NSE:INFY").unwrap();
    store.add_watchlist_symbol("NSE:TCS").unwrap();

    store.remove_watchlist_symbol("NSE:INFY").unwrap();

    assert_eq!(store.watchlist().unwrap(), vec!["NSE:TCS".to_string()]);
}

#[test]
fn removing_a_symbol_not_on_the_watchlist_is_a_harmless_no_op() {
    let dir = tempdir().unwrap();
    let store = StateStore::open(&dir.path().join("state.sqlite")).unwrap();

    store.remove_watchlist_symbol("NSE:NOTHERE").unwrap();

    assert!(store.watchlist().unwrap().is_empty());
}

#[test]
fn get_last_snapshot_returns_none_for_a_symbol_never_scanned() {
    let dir = tempdir().unwrap();
    let store = StateStore::open(&dir.path().join("state.sqlite")).unwrap();

    assert_eq!(store.get_last_snapshot("NSE:INFY").unwrap(), None);
}

#[test]
fn set_last_snapshot_then_get_last_snapshot_round_trips() {
    let dir = tempdir().unwrap();
    let store = StateStore::open(&dir.path().join("state.sqlite")).unwrap();
    let snapshot = ConfluenceSnapshot { bullish_count: 5, bearish_count: 2, neutral_count: 10, weighted_vote: 0.12 };

    store.set_last_snapshot("NSE:INFY", &snapshot).unwrap();

    assert_eq!(store.get_last_snapshot("NSE:INFY").unwrap(), Some(snapshot));
}

#[test]
fn set_last_snapshot_twice_overwrites_rather_than_duplicating() {
    let dir = tempdir().unwrap();
    let store = StateStore::open(&dir.path().join("state.sqlite")).unwrap();
    let first = ConfluenceSnapshot { bullish_count: 1, bearish_count: 1, neutral_count: 1, weighted_vote: 0.0 };
    let second = ConfluenceSnapshot { bullish_count: 9, bearish_count: 1, neutral_count: 0, weighted_vote: 0.8 };

    store.set_last_snapshot("NSE:INFY", &first).unwrap();
    store.set_last_snapshot("NSE:INFY", &second).unwrap();

    // The upsert overwrites the single row; get returns only the second value.
    assert_eq!(store.get_last_snapshot("NSE:INFY").unwrap(), Some(second));
}
