// @Author Christian Relf
// @Date 2026-10-12

//! Native notifications with global enable, per-category toggles, quiet
//! hours and duplicate suppression.

use crate::domain::settings;
use crate::util::now_ms;
use chrono::{Local, NaiveTime};
use rusqlite::{params, Connection};
use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QuietHours {
    pub enabled: bool,
    pub start: String,
    pub end: String,
}

pub fn in_quiet_hours(conn: &Connection) -> bool {
    let Some(q) = settings::get::<QuietHours>(conn, "notifications.quietHours") else { return false };
    if !q.enabled {
        return false;
    }
    let (Ok(start), Ok(end)) = (NaiveTime::parse_from_str(&q.start, "%H:%M"), NaiveTime::parse_from_str(&q.end, "%H:%M")) else {
        return false;
    };
    let now = Local::now().time();
    if start <= end {
        now >= start && now < end
    } else {
        // Spans midnight, e.g. 22:00–07:00.
        now >= start || now < end
    }
}

/// Global switch, category switch and quiet hours.
pub fn category_enabled(conn: &Connection, key: &str) -> bool {
    settings::get_or(conn, "notifications.enabled", true) && settings::get_or(conn, key, true) && !in_quiet_hours(conn)
}

/// Records `key` and returns true the first time only (duplicate suppression).
pub fn first_time(conn: &Connection, key: &str) -> bool {
    conn.execute("INSERT OR IGNORE INTO notification_log(key, created_at) VALUES (?1, ?2)", params![key, now_ms()])
        .map(|n| n > 0)
        .unwrap_or(false)
}

pub fn prune_log(conn: &Connection) {
    let _ = conn.execute("DELETE FROM notification_log WHERE created_at < ?1", [now_ms() - 30 * 86_400_000]);
}

pub fn send(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}
