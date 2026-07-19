#[derive(Debug)]
pub enum StorageError {
    Io(std::io::Error),
    Duckdb(duckdb::Error),
    Sqlite(rusqlite::Error),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageError::Io(e) => write!(f, "storage io error: {e}"),
            StorageError::Duckdb(e) => write!(f, "storage duckdb error: {e}"),
            StorageError::Sqlite(e) => write!(f, "storage sqlite error: {e}"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<std::io::Error> for StorageError {
    fn from(e: std::io::Error) -> Self {
        StorageError::Io(e)
    }
}

impl From<duckdb::Error> for StorageError {
    fn from(e: duckdb::Error) -> Self {
        StorageError::Duckdb(e)
    }
}

impl From<rusqlite::Error> for StorageError {
    fn from(e: rusqlite::Error) -> Self {
        StorageError::Sqlite(e)
    }
}

pub type Result<T> = std::result::Result<T, StorageError>;
