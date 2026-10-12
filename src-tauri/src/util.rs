use serde::{Deserialize, Deserializer};

/// Time-ordered unique identifier (UUIDv7).
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Current time as UTC epoch milliseconds.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Deserialize helper distinguishing "field absent" (None) from
/// "field explicitly null" (Some(None)) in patch payloads.
pub fn some<'de, T, D>(d: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(d).map(Some)
}

/// Validates a calendar date string (YYYY-MM-DD).
pub fn valid_date(s: &str) -> bool {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

/// Validates a wall-clock time string (HH:MM).
pub fn valid_time(s: &str) -> bool {
    chrono::NaiveTime::parse_from_str(s, "%H:%M").is_ok()
}

/// Builds a `?,?,?` placeholder list.
pub fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

/// Strips characters that are invalid in Windows/macOS/Linux file names.
pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() {
        "untitled".into()
    } else {
        trimmed.chars().take(120).collect()
    }
}
