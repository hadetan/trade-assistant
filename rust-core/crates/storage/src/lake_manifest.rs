use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LakePartitionKey {
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
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
    let mut keys: Vec<LakePartitionKey> = Vec::new();
    for line in contents.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let key: LakePartitionKey = serde_json::from_str(line)?;
        // Defend against any accidental duplicate line (append-only, so a bug or
        // a crash-retry could in principle repeat one).
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    Ok(keys)
}
