// @Author Christian Relf
// @Date 2026-10-12

//! Per-project workspace context ("resume where you left off"), named
//! workspace snapshots and the Project Command Centre layout.
//!
//! The documents are owned by the client (it knows which UI state matters)
//! and hold only lightweight references: ids, relative paths, viewport and
//! panel sizes. Repository contents are never copied.

use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

/// Upper bound for a saved state document, to keep accidental bloat out.
const MAX_STATE_BYTES: usize = 64 * 1024;

fn encode(v: &Value) -> AppResult<String> {
    if !v.is_object() {
        return invalid("Workspace state must be an object.");
    }
    let s = serde_json::to_string(v)?;
    if s.len() > MAX_STATE_BYTES {
        return invalid("That workspace state is too large to save.");
    }
    Ok(s)
}

pub fn state_get(conn: &Connection, project_id: &str) -> AppResult<Option<Value>> {
    let raw: Option<String> = conn.query_row("SELECT state FROM workspace_state WHERE project_id = ?1", [project_id], |r| r.get(0)).optional()?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
}

pub fn state_save(conn: &Connection, project_id: &str, state: &Value) -> AppResult<()> {
    let s = encode(state)?;
    // A deleted project's state is simply not saved.
    conn.execute(
        "INSERT INTO workspace_state(project_id, state, updated_at) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?1)
         ON CONFLICT(project_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
        params![project_id, s, now_ms()],
    )?;
    Ok(())
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub state: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

fn snapshot(conn: &Connection, id: &str) -> AppResult<Snapshot> {
    conn.query_row("SELECT id, project_id, name, state, created_at, updated_at FROM workspace_snapshots WHERE id = ?1", [id], |r| {
        let s: String = r.get(3)?;
        Ok(Snapshot { id: r.get(0)?, project_id: r.get(1)?, name: r.get(2)?, state: serde_json::from_str(&s).unwrap_or(Value::Null), created_at: r.get(4)?, updated_at: r.get(5)? })
    })
    .optional()?
    .ok_or_else(|| AppError::NotFound("Workspace snapshot".into()))
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub project_id: String,
    pub preset: Option<String>,
    pub widgets: Value,
    pub layouts: Value,
    pub updated_at: i64,
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub fn workspace_state_get(state: State<AppState>, project_id: String) -> AppResult<Option<Value>> {
    state.with(|c| state_get(c, &project_id))
}

#[tauri::command]
pub fn workspace_state_save(state: State<AppState>, project_id: String, value: Value) -> AppResult<()> {
    state.with(|c| state_save(c, &project_id, &value))
}

#[tauri::command]
pub fn workspace_snapshots_list(state: State<AppState>, project_id: String) -> AppResult<Vec<Snapshot>> {
    state.with(|c| {
        let mut stmt = c.prepare("SELECT id FROM workspace_snapshots WHERE project_id = ?1 ORDER BY name COLLATE NOCASE")?;
        let ids: Vec<String> = stmt.query_map([&project_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        ids.iter().map(|i| snapshot(c, i)).collect()
    })
}

#[tauri::command]
pub fn workspace_snapshot_save(state: State<AppState>, project_id: String, name: String, value: Value, id: Option<String>) -> AppResult<Snapshot> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return invalid("Name the snapshot.");
    }
    state.with(|c| {
        let s = encode(&value)?;
        let now = now_ms();
        let id = match id {
            Some(id) => {
                c.execute("UPDATE workspace_snapshots SET name = ?1, state = ?2, updated_at = ?3 WHERE id = ?4", params![name, s, now, id])?;
                id
            }
            None => {
                let id = new_id();
                c.execute(
                    "INSERT INTO workspace_snapshots(id, project_id, name, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    params![id, project_id, name, s, now],
                )?;
                id
            }
        };
        snapshot(c, &id)
    })
}

#[tauri::command]
pub fn workspace_snapshot_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM workspace_snapshots WHERE id = ?1", [id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn project_layout_get(state: State<AppState>, project_id: String) -> AppResult<Option<Layout>> {
    state.with(|c| {
        Ok(c.query_row("SELECT project_id, preset, widgets, layouts, updated_at FROM project_layouts WHERE project_id = ?1", [&project_id], |r| {
            let w: String = r.get(2)?;
            let l: String = r.get(3)?;
            Ok(Layout {
                project_id: r.get(0)?,
                preset: r.get(1)?,
                widgets: serde_json::from_str(&w).unwrap_or(Value::Array(vec![])),
                layouts: serde_json::from_str(&l).unwrap_or(Value::Object(Default::default())),
                updated_at: r.get(4)?,
            })
        })
        .optional()?)
    })
}

#[tauri::command]
pub fn project_layout_save(state: State<AppState>, project_id: String, preset: Option<String>, widgets: Value, layouts: Value) -> AppResult<()> {
    if !widgets.is_array() || !layouts.is_object() {
        return invalid("That layout is malformed.");
    }
    state.with(|c| {
        c.execute(
            "INSERT INTO project_layouts(project_id, preset, widgets, layouts, updated_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?1)
             ON CONFLICT(project_id) DO UPDATE SET preset = excluded.preset, widgets = excluded.widgets, layouts = excluded.layouts, updated_at = excluded.updated_at",
            params![project_id, preset, serde_json::to_string(&widgets)?, serde_json::to_string(&layouts)?, now_ms()],
        )?;
        Ok(())
    })
}

/// Restoring the default layout: the client rebuilds it from a preset.
#[tauri::command]
pub fn project_layout_reset(state: State<AppState>, project_id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM project_layouts WHERE project_id = ?1", [project_id])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::projects::{create_project, ProjectInput};
    use serde_json::json;

    #[test]
    fn state_round_trips_and_is_bounded() {
        let c = open_memory();
        let p = create_project(&c, &ProjectInput { name: "Renovation".into(), ..Default::default() }).unwrap();
        assert!(state_get(&c, &p.id).unwrap().is_none());
        state_save(&c, &p.id, &json!({ "tab": "board", "boardId": "b1" })).unwrap();
        assert_eq!(state_get(&c, &p.id).unwrap().unwrap()["tab"], "board");
        assert!(state_save(&c, &p.id, &json!("nope")).is_err());
        assert!(state_save(&c, &p.id, &json!({ "x": "y".repeat(70_000) })).is_err());
        // Unknown projects are ignored rather than erroring.
        state_save(&c, "missing", &json!({})).unwrap();
        assert!(state_get(&c, "missing").unwrap().is_none());
    }
}
