// @Author Christian Relf
// @Date 2026-10-12

//! Saved task views (named filter combinations shown in the sidebar).

use crate::error::{invalid, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SavedView {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub filters: Value,
    pub sort_order: f64,
}

#[tauri::command]
pub fn views_list(state: State<AppState>) -> AppResult<Vec<SavedView>> {
    state.with(|c| {
        let mut stmt = c.prepare("SELECT id, name, icon, filters, sort_order FROM saved_views ORDER BY sort_order")?;
        let rows = stmt.query_map([], |r| {
            let f: String = r.get(3)?;
            Ok(SavedView {
                id: r.get(0)?,
                name: r.get(1)?,
                icon: r.get(2)?,
                filters: serde_json::from_str(&f).unwrap_or(Value::Object(Default::default())),
                sort_order: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command]
pub fn view_create(state: State<AppState>, name: String, icon: Option<String>, filters: Value) -> AppResult<SavedView> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return invalid("View name can't be empty.");
    }
    state.with(|c| {
        let id = new_id();
        let now = now_ms();
        let sort: f64 = c.query_row("SELECT coalesce(max(sort_order), 0) + 1 FROM saved_views", [], |r| r.get(0))?;
        c.execute(
            "INSERT INTO saved_views(id, name, icon, filters, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, name, icon, serde_json::to_string(&filters)?, sort, now],
        )?;
        Ok(SavedView { id, name, icon, filters, sort_order: sort })
    })
}

#[tauri::command]
pub fn view_update(
    state: State<AppState>,
    id: String,
    name: Option<String>,
    icon: Option<String>,
    filters: Option<Value>,
) -> AppResult<()> {
    state.with(|c| {
        let now = now_ms();
        if let Some(n) = name {
            if n.trim().is_empty() {
                return invalid("View name can't be empty.");
            }
            c.execute("UPDATE saved_views SET name = ?1, updated_at = ?2 WHERE id = ?3", params![n.trim(), now, id])?;
        }
        if let Some(i) = icon {
            c.execute("UPDATE saved_views SET icon = ?1 WHERE id = ?2", params![i, id])?;
        }
        if let Some(f) = filters {
            c.execute(
                "UPDATE saved_views SET filters = ?1, updated_at = ?2 WHERE id = ?3",
                params![serde_json::to_string(&f)?, now, id],
            )?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn view_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM saved_views WHERE id = ?1", [id])?;
        Ok(())
    })
}

/// Persists the sidebar order of saved views.
#[tauri::command]
pub fn views_reorder(state: State<AppState>, ids: Vec<String>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute("UPDATE saved_views SET sort_order = ?1 WHERE id = ?2", params![(i + 1) as f64, id])?;
        }
        tx.commit()?;
        Ok(())
    })
}
