// @Author Christian Relf
// @Date 2026-10-12

//! Key/value application settings. Values are JSON; the frontend owns the
//! typed schema and defaults (src/features/settings/schema.ts). The backend
//! reads a handful of keys (notifications, backups, window behaviour) with
//! matching defaults.

use crate::error::AppResult;
use crate::state::AppState;
use crate::util::now_ms;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashMap;
use tauri::State;

pub fn get_all(conn: &Connection) -> AppResult<HashMap<String, Value>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut map = HashMap::new();
    for row in rows {
        let (k, v) = row?;
        // A malformed value is skipped (falls back to the default) rather
        // than failing the whole settings load.
        if let Ok(parsed) = serde_json::from_str(&v) {
            map.insert(k, parsed);
        }
    }
    Ok(map)
}

pub fn get<T: DeserializeOwned>(conn: &Connection, key: &str) -> Option<T> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    raw.and_then(|s| serde_json::from_str(&s).ok())
}

pub fn get_or<T: DeserializeOwned>(conn: &Connection, key: &str, default: T) -> T {
    get(conn, key).unwrap_or(default)
}

pub fn set(conn: &Connection, key: &str, value: &Value) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings(key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, serde_json::to_string(value)?, now_ms()],
    )?;
    Ok(())
}

#[tauri::command]
pub fn settings_get_all(state: State<AppState>) -> AppResult<HashMap<String, Value>> {
    state.with(|c| get_all(c))
}

#[tauri::command]
pub fn settings_set(state: State<AppState>, entries: HashMap<String, Value>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        for (k, v) in &entries {
            set(&tx, k, v)?;
        }
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn settings_reset(state: State<AppState>, keys: Option<Vec<String>>) -> AppResult<()> {
    state.with(|c| {
        match keys {
            Some(keys) => {
                for k in keys {
                    c.execute("DELETE FROM settings WHERE key = ?1", [k])?;
                }
            }
            None => {
                c.execute("DELETE FROM settings WHERE key NOT LIKE 'internal.%'", [])?;
            }
        }
        Ok(())
    })
}
