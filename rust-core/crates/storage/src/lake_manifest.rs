use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LakePartitionKey {
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
    pub from_ts: i64,
    pub to_ts: i64,
    pub candle_count: usize,
    // Recorded once, on the write that first creates this (symbol, timeframe,
    // source) partition, and never overwritten afterward. `Option` (not a bare
    // value) so a manifest line written before this field existed deserializes
    // as `None` -- unambiguously "unknown", distinguishable from "recorded as
    // zero".
    #[serde(default)]
    pub first_seen_from_ts: Option<i64>,
    #[serde(default)]
    pub first_seen_to_ts: Option<i64>,
    #[serde(default)]
    pub first_seen_candle_count: Option<usize>,
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join("lake_manifest.jsonl")
}

pub fn append_partition_key(root: &Path, key: &LakePartitionKey) -> Result<()> {
    let line = serde_json::to_string(key)?;
    let mut file = OpenOptions::new().create(true).append(true).open(manifest_path(root))?;
    writeln!(file, "{line}")?;
    Ok(())
}

pub fn read_partition_keys(root: &Path) -> Result<Vec<LakePartitionKey>> {
    let path = manifest_path(root);
    // A missing manifest is an empty lake, not an error -- mirrors
    // read_partition's "never-written partition is empty" convention.
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = std::fs::read_to_string(&path)?;
    let mut order: Vec<(String, String, String)> = Vec::new();
    let mut latest: HashMap<(String, String, String), LakePartitionKey> = HashMap::new();
    for line in contents.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let key: LakePartitionKey = serde_json::from_str(line)?;
        let dedup_key = (key.symbol.clone(), key.timeframe.clone(), key.source.clone());
        if !latest.contains_key(&dedup_key) {
            order.push(dedup_key.clone());
        }
        // Append-only manifest, so a later line for the same partition always
        // reflects a more recent write -- last-line-wins resolves staleness
        // here instead of rewriting history on every append.
        latest.insert(dedup_key, key);
    }
    Ok(order.into_iter().map(|k| latest.remove(&k).unwrap()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn read_partition_keys_last_line_wins_on_bounds_for_the_same_partition() {
        let dir = tempdir().unwrap();
        append_partition_key(
            dir.path(),
            &LakePartitionKey {
                symbol: "NSE:INFY".to_string(),
                timeframe: "day".to_string(),
                source: "bhavcopy".to_string(),
                from_ts: 100,
                to_ts: 200,
                candle_count: 5,
                first_seen_from_ts: Some(100),
                first_seen_to_ts: Some(200),
                first_seen_candle_count: Some(5),
            },
        )
        .unwrap();
        append_partition_key(
            dir.path(),
            &LakePartitionKey {
                symbol: "NSE:INFY".to_string(),
                timeframe: "day".to_string(),
                source: "bhavcopy".to_string(),
                from_ts: 100,
                to_ts: 300,
                candle_count: 8,
                first_seen_from_ts: Some(100),
                first_seen_to_ts: Some(200),
                first_seen_candle_count: Some(5),
            },
        )
        .unwrap();

        let keys = read_partition_keys(dir.path()).unwrap();

        assert_eq!(keys.len(), 1, "duplicate (symbol, timeframe, source) must fold to one entry");
        assert_eq!(keys[0].to_ts, 300, "last write's bounds must win");
        assert_eq!(keys[0].candle_count, 8, "last write's candle_count must win");
        assert_eq!(keys[0].first_seen_to_ts, Some(200), "first_seen_* must carry forward from the last line, not recompute");
    }

    #[test]
    fn an_old_format_line_with_no_first_seen_keys_deserializes_them_as_none() {
        let dir = tempdir().unwrap();
        let path = manifest_path(dir.path());
        let old_format_line = serde_json::json!({
            "symbol": "NSE:INFY",
            "timeframe": "day",
            "source": "bhavcopy",
            "from_ts": 100,
            "to_ts": 200,
            "candle_count": 5,
        });
        std::fs::write(&path, format!("{old_format_line}\n")).unwrap();

        let keys = read_partition_keys(dir.path()).unwrap();

        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].first_seen_from_ts, None, "a pre-migration line has no recorded first-seen extent");
        assert_eq!(keys[0].first_seen_to_ts, None);
        assert_eq!(keys[0].first_seen_candle_count, None);
    }
}
