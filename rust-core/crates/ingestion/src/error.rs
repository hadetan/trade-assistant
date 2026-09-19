#[derive(Debug)]
pub enum IngestionError {
    Csv(csv::Error),
    MissingColumn(String),
    BadField { column: String, value: String },
    Io(std::io::Error),
    Storage(storage::StorageError),
    Fetch(String),
    /// The archive has no file for this date. For a per-day bhavcopy URL that
    /// means "not a trading day", which a backward walk must skip rather than
    /// abort on -- a distinction Fetch(String) cannot carry (P14§2 item 3).
    NotFound,
}

impl std::fmt::Display for IngestionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IngestionError::Csv(e) => write!(f, "csv error: {e}"),
            IngestionError::MissingColumn(c) => write!(f, "missing column: {c}"),
            IngestionError::BadField { column, value } => write!(f, "bad field in {column}: {value:?}"),
            IngestionError::Io(e) => write!(f, "io error: {e}"),
            IngestionError::Storage(e) => write!(f, "storage error: {e}"),
            IngestionError::Fetch(m) => write!(f, "fetch error: {m}"),
            IngestionError::NotFound => write!(f, "not found (404)"),
        }
    }
}

impl std::error::Error for IngestionError {}

impl From<csv::Error> for IngestionError {
    fn from(e: csv::Error) -> Self { IngestionError::Csv(e) }
}
impl From<std::io::Error> for IngestionError {
    fn from(e: std::io::Error) -> Self { IngestionError::Io(e) }
}
impl From<storage::StorageError> for IngestionError {
    fn from(e: storage::StorageError) -> Self { IngestionError::Storage(e) }
}
