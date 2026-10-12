//! Kanban boards and columns. Tasks reference a column; the project's
//! default board additionally shows project tasks that have no placement
//! yet (they are placed by status on the client).

use crate::domain::{activity, settings, tasks};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub sort_order: f64,
    pub settings: Value,
    pub is_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub id: String,
    pub board_id: String,
    pub name: String,
    pub sort_order: f64,
    pub status: Option<String>,
    pub wip_limit: Option<i64>,
    pub collapsed: bool,
    pub width: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ColumnTemplate {
    pub name: String,
    pub status: Option<String>,
}

pub fn default_columns(conn: &Connection) -> Vec<ColumnTemplate> {
    settings::get(conn, "projects.defaultColumns").unwrap_or_else(|| {
        vec![
            ColumnTemplate { name: "Backlog".into(), status: None },
            ColumnTemplate { name: "To Do".into(), status: Some("todo".into()) },
            ColumnTemplate { name: "In Progress".into(), status: Some("in_progress".into()) },
            ColumnTemplate { name: "Done".into(), status: Some("completed".into()) },
        ]
    })
}

fn default_board_id(conn: &Connection, project_id: &str) -> AppResult<Option<String>> {
    let explicit: Option<String> = conn
        .query_row(
            "SELECT p.default_board_id FROM projects p JOIN boards b ON b.id = p.default_board_id WHERE p.id = ?1",
            [project_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    if explicit.is_some() {
        return Ok(explicit);
    }
    Ok(conn
        .query_row(
            "SELECT id FROM boards WHERE project_id = ?1 ORDER BY sort_order, created_at LIMIT 1",
            [project_id],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn create_board(conn: &Connection, project_id: &str, name: &str, columns: &[ColumnTemplate]) -> AppResult<Board> {
    let name = name.trim();
    if name.is_empty() {
        return invalid("Board name can't be empty.");
    }
    let now = now_ms();
    let id = new_id();
    let sort: f64 = conn
        .query_row("SELECT coalesce(max(sort_order), 0) + 1 FROM boards WHERE project_id = ?1", [project_id], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO boards(id, project_id, name, sort_order, settings, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, '{}', ?5, ?5)",
        params![id, project_id, name, sort, now],
    )?;
    for (i, c) in columns.iter().enumerate() {
        conn.execute(
            "INSERT INTO board_columns(id, board_id, name, sort_order, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![new_id(), id, c.name, (i + 1) as f64, c.status, now],
        )?;
    }
    get_board(conn, &id)
}

pub fn get_board(conn: &Connection, id: &str) -> AppResult<Board> {
    let (project_id, name, sort_order, settings, created_at, updated_at): (String, String, f64, String, i64, i64) = conn
        .query_row(
            "SELECT project_id, name, sort_order, settings, created_at, updated_at FROM boards WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("Board".into()))?;
    let default = default_board_id(conn, &project_id)?;
    Ok(Board {
        id: id.to_string(),
        is_default: default.as_deref() == Some(id),
        project_id,
        name,
        sort_order,
        settings: serde_json::from_str(&settings).unwrap_or(Value::Object(Default::default())),
        created_at,
        updated_at,
    })
}

pub fn list_columns(conn: &Connection, board_id: &str) -> AppResult<Vec<Column>> {
    let mut stmt = conn.prepare(
        "SELECT id, board_id, name, sort_order, status, wip_limit, collapsed, width FROM board_columns WHERE board_id = ?1 ORDER BY sort_order",
    )?;
    let rows = stmt.query_map([board_id], |r| {
        Ok(Column {
            id: r.get(0)?,
            board_id: r.get(1)?,
            name: r.get(2)?,
            sort_order: r.get(3)?,
            status: r.get(4)?,
            wip_limit: r.get(5)?,
            collapsed: r.get::<_, i64>(6)? != 0,
            width: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BoardData {
    pub board: Board,
    pub columns: Vec<Column>,
    pub tasks: Vec<tasks::Task>,
}

pub fn board_data(conn: &Connection, board_id: &str) -> AppResult<BoardData> {
    let board = get_board(conn, board_id)?;
    let columns = list_columns(conn, board_id)?;
    let sql = format!(
        "{} WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND t.parent_id IS NULL AND t.project_id = ?1
           AND (t.column_id IN (SELECT id FROM board_columns WHERE board_id = ?2)
             OR (?3 = 1 AND (t.column_id IS NULL OR t.column_id NOT IN
                  (SELECT c.id FROM board_columns c JOIN boards b ON b.id = c.board_id WHERE b.project_id = ?1))))
         ORDER BY t.board_order, t.sort_order",
        tasks::TASK_SELECT
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![board.project_id, board_id, board.is_default as i64], tasks::map_task)?;
    let tasks = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(BoardData { board, columns, tasks })
}

#[tauri::command]
pub fn boards_list(state: State<AppState>, project_id: Option<String>) -> AppResult<Vec<Board>> {
    state.with(|c| {
        let mut stmt = c.prepare(
            "SELECT b.id FROM boards b JOIN projects p ON p.id = b.project_id
             WHERE p.deleted_at IS NULL AND (?1 IS NULL OR b.project_id = ?1) ORDER BY p.sort_order, b.sort_order",
        )?;
        let ids: Vec<String> = stmt.query_map([project_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        ids.iter().map(|id| get_board(c, id)).collect()
    })
}

#[tauri::command]
pub fn board_get(state: State<AppState>, id: String) -> AppResult<BoardData> {
    state.with(|c| board_data(c, &id))
}

#[tauri::command]
pub fn board_create(state: State<AppState>, project_id: String, name: String) -> AppResult<Board> {
    state.with(|c| {
        let tx = c.transaction()?;
        let cols = default_columns(&tx);
        let b = create_board(&tx, &project_id, &name, &cols)?;
        activity::log(&tx, Some(&project_id), "board", &b.id, "created", &b.name)?;
        tx.commit()?;
        Ok(b)
    })
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BoardPatch {
    pub name: Option<String>,
    pub settings: Option<Value>,
    pub make_default: Option<bool>,
}

#[tauri::command]
pub fn board_update(state: State<AppState>, id: String, patch: BoardPatch) -> AppResult<Board> {
    state.with(|c| {
        let tx = c.transaction()?;
        let b = get_board(&tx, &id)?;
        if let Some(name) = &patch.name {
            if name.trim().is_empty() {
                return invalid("Board name can't be empty.");
            }
            tx.execute("UPDATE boards SET name = ?1, updated_at = ?2 WHERE id = ?3", params![name.trim(), now_ms(), id])?;
        }
        if let Some(s) = &patch.settings {
            // Shallow-merge settings so independent controls don't clobber each other.
            let mut merged = b.settings.clone();
            if let (Some(m), Some(n)) = (merged.as_object_mut(), s.as_object()) {
                for (k, v) in n {
                    m.insert(k.clone(), v.clone());
                }
            }
            tx.execute(
                "UPDATE boards SET settings = ?1, updated_at = ?2 WHERE id = ?3",
                params![serde_json::to_string(&merged)?, now_ms(), id],
            )?;
        }
        if patch.make_default == Some(true) {
            tx.execute("UPDATE projects SET default_board_id = ?1 WHERE id = ?2", params![id, b.project_id])?;
        }
        let out = get_board(&tx, &id)?;
        tx.commit()?;
        Ok(out)
    })
}

#[tauri::command]
pub fn board_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        let b = get_board(&tx, &id)?;
        let count: i64 = tx.query_row("SELECT count(*) FROM boards WHERE project_id = ?1", [&b.project_id], |r| r.get(0))?;
        if count <= 1 {
            return invalid("A project needs at least one board.");
        }
        // Tasks keep their status and project; they lose only their placement.
        tx.execute("DELETE FROM boards WHERE id = ?1", [&id])?;
        tx.execute("UPDATE projects SET default_board_id = NULL WHERE default_board_id = ?1", [&id])?;
        activity::log(&tx, Some(&b.project_id), "board", &id, "deleted", &b.name)?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn column_create(state: State<AppState>, board_id: String, name: String, status: Option<String>) -> AppResult<Column> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return invalid("Column name can't be empty.");
    }
    state.with(|c| {
        let now = now_ms();
        let id = new_id();
        let sort: f64 = c.query_row(
            "SELECT coalesce(max(sort_order), 0) + 1 FROM board_columns WHERE board_id = ?1",
            [&board_id],
            |r| r.get(0),
        )?;
        c.execute(
            "INSERT INTO board_columns(id, board_id, name, sort_order, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, board_id, name, sort, status, now],
        )?;
        Ok(list_columns(c, &board_id)?.into_iter().find(|x| x.id == id).unwrap())
    })
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ColumnPatch {
    pub name: Option<String>,
    #[serde(deserialize_with = "crate::util::some")]
    pub status: Option<Option<String>>,
    #[serde(deserialize_with = "crate::util::some")]
    pub wip_limit: Option<Option<i64>>,
    pub collapsed: Option<bool>,
    #[serde(deserialize_with = "crate::util::some")]
    pub width: Option<Option<i64>>,
}

#[tauri::command]
pub fn column_update(state: State<AppState>, id: String, patch: ColumnPatch) -> AppResult<()> {
    state.with(|c| {
        let now = now_ms();
        if let Some(n) = &patch.name {
            if n.trim().is_empty() {
                return invalid("Column name can't be empty.");
            }
            c.execute("UPDATE board_columns SET name = ?1, updated_at = ?2 WHERE id = ?3", params![n.trim(), now, id])?;
        }
        if let Some(s) = &patch.status {
            if let Some(st) = s {
                if !tasks::STATUSES.contains(&st.as_str()) {
                    return invalid("Unknown status.");
                }
            }
            c.execute("UPDATE board_columns SET status = ?1, updated_at = ?2 WHERE id = ?3", params![s, now, id])?;
        }
        if let Some(w) = &patch.wip_limit {
            c.execute("UPDATE board_columns SET wip_limit = ?1 WHERE id = ?2", params![w.filter(|x| *x > 0), id])?;
        }
        if let Some(col) = patch.collapsed {
            c.execute("UPDATE board_columns SET collapsed = ?1 WHERE id = ?2", params![col as i64, id])?;
        }
        if let Some(w) = &patch.width {
            c.execute("UPDATE board_columns SET width = ?1 WHERE id = ?2", params![w.map(|x| x.clamp(200, 560)), id])?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn column_delete(state: State<AppState>, id: String, move_to: Option<String>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        let board_id: String = tx
            .query_row("SELECT board_id FROM board_columns WHERE id = ?1", [&id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| AppError::NotFound("Column".into()))?;
        let count: i64 = tx.query_row("SELECT count(*) FROM board_columns WHERE board_id = ?1", [&board_id], |r| r.get(0))?;
        if count <= 1 {
            return invalid("A board needs at least one column.");
        }
        if let Some(target) = move_to {
            let base: f64 = tx.query_row(
                "SELECT coalesce(max(board_order), 0) FROM tasks WHERE column_id = ?1",
                [&target],
                |r| r.get(0),
            )?;
            tx.execute(
                "UPDATE tasks SET column_id = ?1, board_order = board_order + ?2, updated_at = ?3 WHERE column_id = ?4",
                params![target, base, now_ms(), id],
            )?;
        }
        tx.execute("DELETE FROM board_columns WHERE id = ?1", [&id])?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn columns_reorder(state: State<AppState>, ids: Vec<String>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute("UPDATE board_columns SET sort_order = ?1 WHERE id = ?2", params![(i + 1) as f64, id])?;
        }
        tx.commit()?;
        Ok(())
    })
}
