use crate::error::IngestionError;
use csv::StringRecord;
use std::collections::HashMap;

/// Maps each header name to its column index so parsers can look columns up by
/// name rather than by fragile positional index (source files add/reorder
/// columns across schema versions).
pub fn header_index(headers: &StringRecord) -> HashMap<String, usize> {
    headers.iter().enumerate().map(|(i, h)| (h.to_string(), i)).collect()
}

/// Look up one column's index by header name, or a descriptive error if this
/// file's header row is missing that column.
pub fn col(idx: &HashMap<String, usize>, name: &str) -> Result<usize, IngestionError> {
    idx.get(name).copied().ok_or_else(|| IngestionError::MissingColumn(name.to_string()))
}
