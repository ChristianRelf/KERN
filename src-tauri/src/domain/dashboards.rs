// @Author Christian Relf
// @Date 2026-10-12

//! Named dashboard layouts. Widget definitions and grid layouts are JSON
//! documents owned by the client's widget registry.

use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub id: String,
    pub name: String,
    pub sort_order: f64,
    pub is_default: bool,
    pub widgets: Value,
    pub layouts: Value,
    pub updated_at: i64,
}

fn map(r: &Row) -> rusqlite::Result<Dashboard> {
    let w: String = r.get(4)?;
    let l: String = r.get(5)?;
    Ok(Dashboard {
        id: r.get(0)?,
        name: r.get(1)?,
        sort_order: r.get(2)?,
        is_default: r.get::<_, i64>(3)? != 0,
        widgets: serde_json::from_str(&w).unwrap_or(Value::Array(vec![])),
        layouts: serde_json::from_str(&l).unwrap_or(Value::Object(Default::default())),
        updated_at: r.get(6)?,
    })
}

const SELECT: &str = "SELECT id, name, sort_order, is_default, widgets, layouts, updated_at FROM dashboards";

fn get(conn: &Connection, id: &str) -> AppResult<Dashboard> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], map)
        .optional()?
        .ok_or_else(|| AppError::NotFound("Dashboard".into()))
}

#[tauri::command]
pub fn dashboards_list(state: State<AppState>) -> AppResult<Vec<Dashboard>> {
    state.with(|c| {
        let mut stmt = c.prepare(&format!("{SELECT} ORDER BY sort_order, rowid"))?;
        let rows = stmt.query_map([], map)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command]
pub fn dashboard_create(state: State<AppState>, name: String, widgets: Value, layouts: Value) -> AppResult<Dashboard> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return invalid("Layout name can't be empty.");
    }
    state.with(|c| {
        let id = new_id();
        let now = now_ms();
        let count: i64 = c.query_row("SELECT count(*) FROM dashboards", [], |r| r.get(0))?;
        let sort: f64 = c.query_row("SELECT coalesce(max(sort_order), 0) + 1 FROM dashboards", [], |r| r.get(0))?;
        c.execute(
            "INSERT INTO dashboards(id, name, sort_order, is_default, widgets, layouts, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, name, sort, (count == 0) as i64, serde_json::to_string(&widgets)?, serde_json::to_string(&layouts)?, now],
        )?;
        get(c, &id)
    })
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DashboardPatch {
    pub name: Option<String>,
    pub widgets: Option<Value>,
    pub layouts: Option<Value>,
    pub is_default: Option<bool>,
    pub sort_order: Option<f64>,
}

#[tauri::command]
pub fn dashboard_update(state: State<AppState>, id: String, patch: DashboardPatch) -> AppResult<Dashboard> {
    state.with(|c| {
        let tx = c.transaction()?;
        let now = now_ms();
        if let Some(n) = &patch.name {
            if n.trim().is_empty() {
                return invalid("Layout name can't be empty.");
            }
            tx.execute("UPDATE dashboards SET name = ?1, updated_at = ?2 WHERE id = ?3", params![n.trim(), now, id])?;
        }
        if let Some(w) = &patch.widgets {
            if !w.is_array() {
                return invalid("Widgets must be a list.");
            }
            tx.execute(
                "UPDATE dashboards SET widgets = ?1, updated_at = ?2 WHERE id = ?3",
                params![serde_json::to_string(w)?, now, id],
            )?;
        }
        if let Some(l) = &patch.layouts {
            tx.execute(
                "UPDATE dashboards SET layouts = ?1, updated_at = ?2 WHERE id = ?3",
                params![serde_json::to_string(l)?, now, id],
            )?;
        }
        if patch.is_default == Some(true) {
            tx.execute("UPDATE dashboards SET is_default = (id = ?1)", [&id])?;
        }
        if let Some(s) = patch.sort_order {
            tx.execute("UPDATE dashboards SET sort_order = ?1 WHERE id = ?2", params![s, id])?;
        }
        let d = get(&tx, &id)?;
        tx.commit()?;
        Ok(d)
    })
}

#[tauri::command]
pub fn dashboard_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        let count: i64 = tx.query_row("SELECT count(*) FROM dashboards", [], |r| r.get(0))?;
        if count <= 1 {
            return invalid("Keep at least one dashboard layout.");
        }
        let was_default: bool = tx.query_row("SELECT is_default FROM dashboards WHERE id = ?1", [&id], |r| r.get::<_, i64>(0))? != 0;
        tx.execute("DELETE FROM dashboards WHERE id = ?1", [&id])?;
        if was_default {
            tx.execute(
                "UPDATE dashboards SET is_default = 1 WHERE id = (SELECT id FROM dashboards ORDER BY sort_order LIMIT 1)",
                [],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}
