use crate::error::Result;
use rusqlite::Connection;
use std::path::Path;

pub struct StateStore {
    conn: Connection,
}

impl StateStore {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS watchlist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL UNIQUE,
                added_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
            (),
        )?;
        Ok(Self { conn })
    }

    pub fn add_watchlist_symbol(&self, symbol: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO watchlist (symbol) VALUES (?1)",
            [symbol],
        )?;
        Ok(())
    }

    pub fn watchlist(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT symbol FROM watchlist ORDER BY id ASC")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        // Collect into rusqlite's own Result first (the iterator's item error
        // type), then `?` converts any rusqlite::Error into StorageError.
        let symbols = rows.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(symbols)
    }
}
