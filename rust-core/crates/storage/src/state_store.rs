use crate::error::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConfluenceSnapshot {
    pub bullish_count: usize,
    pub bearish_count: usize,
    pub neutral_count: usize,
    pub weighted_vote: f64,
}

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
        conn.execute(
            "CREATE TABLE IF NOT EXISTS scan_snapshots (
                symbol TEXT PRIMARY KEY,
                confluence_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

    pub fn remove_watchlist_symbol(&self, symbol: &str) -> Result<()> {
        self.conn.execute("DELETE FROM watchlist WHERE symbol = ?1", [symbol])?;
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

    pub fn get_last_snapshot(&self, symbol: &str) -> Result<Option<ConfluenceSnapshot>> {
        use rusqlite::OptionalExtension;
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT confluence_json FROM scan_snapshots WHERE symbol = ?1",
                [symbol],
                |row| row.get(0),
            )
            .optional()?;
        match json {
            Some(text) => Ok(Some(serde_json::from_str(&text)?)),
            None => Ok(None),
        }
    }

    pub fn set_last_snapshot(&self, symbol: &str, snapshot: &ConfluenceSnapshot) -> Result<()> {
        let json = serde_json::to_string(snapshot)?;
        self.conn.execute(
            "INSERT INTO scan_snapshots (symbol, confluence_json, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(symbol) DO UPDATE SET
               confluence_json = excluded.confluence_json,
               updated_at = excluded.updated_at",
            rusqlite::params![symbol, json],
        )?;
        Ok(())
    }
}
