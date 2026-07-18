use storage::StateStore;
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
