// @Author Christian Relf
// @Date 2026-10-12

//! Recently opened projects, notes and whiteboards.

use crate::domain::{passkeys, settings};
use crate::error::AppResult;
use crate::state::AppState;
use crate::util::now_ms;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

/// "Record recently opened items" (Settings -> Privacy & Security).
fn recording(conn: &Connection) -> bool {
    settings::get_or(conn, "privacy.recordRecents", true)
}

/// Forgets everything opened so far. Called when recording is off, so turning
/// the setting off also clears what was already recorded.
pub fn clear(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM recent_items", [])?;
    Ok(())
}

pub fn touch(conn: &Connection, entity_type: &str, entity_id: &str) -> AppResult<()> {
    if !recording(conn) {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO recent_items(entity_type, entity_id, opened_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET opened_at = excluded.opened_at",
        params![entity_type, entity_id, now_ms()],
    )?;
    // Keep the table small.
    conn.execute(
        "DELETE FROM recent_items WHERE rowid NOT IN (SELECT rowid FROM recent_items ORDER BY opened_at DESC LIMIT 100)",
        [],
    )?;
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub entity_type: String,
    pub entity_id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub opened_at: i64,
}

#[tauri::command]
pub fn recent_list(state: State<AppState>, limit: Option<i64>) -> AppResult<Vec<RecentItem>> {
    state.with(|c| {
        if !recording(c) {
            clear(c)?;
            return Ok(vec![]);
        }
        let mut stmt = c.prepare(
            "SELECT r.entity_type, r.entity_id, r.opened_at,
               CASE r.entity_type
                 WHEN 'project' THEN (SELECT name FROM projects WHERE id = r.entity_id AND deleted_at IS NULL)
                 WHEN 'note' THEN (SELECT CASE WHEN title = '' THEN 'Untitled note' ELSE title END FROM notes WHERE id = r.entity_id AND deleted_at IS NULL)
                 WHEN 'whiteboard' THEN (SELECT name FROM whiteboards WHERE id = r.entity_id AND deleted_at IS NULL)
               END AS title,
               CASE r.entity_type
                 WHEN 'note' THEN (SELECT project_id FROM notes WHERE id = r.entity_id)
                 WHEN 'whiteboard' THEN (SELECT project_id FROM whiteboards WHERE id = r.entity_id)
                 ELSE NULL
               END AS project_id
             FROM recent_items r ORDER BY r.opened_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.unwrap_or(12) * 2], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?))
        })?;
        let mut out = vec![];
        for row in rows {
            let (entity_type, entity_id, opened_at, title, project_id) = row?;
            // A locked project is neither listed itself nor through a note
            // or whiteboard of its own.
            let owner = if entity_type == "project" { Some(entity_id.as_str()) } else { project_id.as_deref() };
            if !passkeys::ensure_readable_opt(c, owner).is_ok() {
                continue;
            }
            if let Some(title) = title {
                out.push(RecentItem { entity_type, entity_id, title, project_id, opened_at });
            }
        }
        out.truncate(limit.unwrap_or(12) as usize);
        Ok(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;

    fn count(c: &Connection) -> i64 {
        c.query_row("SELECT count(*) FROM recent_items", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn recording_can_be_turned_off_and_clears_what_was_recorded() {
        let c = open_memory();
        touch(&c, "note", "n1").unwrap();
        assert_eq!(count(&c), 1);
        settings::set(&c, "privacy.recordRecents", &serde_json::json!(false)).unwrap();
        touch(&c, "note", "n2").unwrap();
        assert_eq!(count(&c), 1, "nothing new is recorded");
        clear(&c).unwrap();
        assert_eq!(count(&c), 0);
    }
}
