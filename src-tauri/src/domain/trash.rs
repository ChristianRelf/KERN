//! Recoverable trash. Deleting moves items here (soft delete); they can be
//! restored or permanently removed. Items older than the retention period
//! are purged automatically.

use crate::domain::attachments;
use crate::error::{invalid, AppResult};
use crate::state::AppState;
use crate::util::now_ms;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub deleted_at: i64,
}

/// Top-level deleted items only: children deleted together with their
/// parent (subtasks, a project's contents) are restored with it.
pub fn list(conn: &Connection) -> AppResult<Vec<TrashItem>> {
    let mut stmt = conn.prepare(
        "SELECT 'project', id, name, NULL, deleted_at FROM projects WHERE deleted_at IS NOT NULL
         UNION ALL
         SELECT 'task', t.id, t.title, t.project_id, t.deleted_at FROM tasks t WHERE t.deleted_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id = t.parent_id AND p.deleted_at = t.deleted_at)
           AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.deleted_at = t.deleted_at)
         UNION ALL
         SELECT 'note', n.id, CASE WHEN n.title = '' THEN 'Untitled note' ELSE n.title END, n.project_id, n.deleted_at FROM notes n
           WHERE n.deleted_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = n.project_id AND p.deleted_at = n.deleted_at)
         UNION ALL
         SELECT 'whiteboard', w.id, w.name, w.project_id, w.deleted_at FROM whiteboards w WHERE w.deleted_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = w.project_id AND p.deleted_at = w.deleted_at)
         ORDER BY 5 DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TrashItem { kind: r.get(0)?, id: r.get(1)?, title: r.get(2)?, project_id: r.get(3)?, deleted_at: r.get(4)? })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn purge(conn: &Connection, kind: &str, id: &str) -> AppResult<()> {
    match kind {
        "task" => {
            attachments::remove_files_for_task(conn, id)?;
            conn.execute("DELETE FROM tasks WHERE id = ?1 AND deleted_at IS NOT NULL", [id])?;
        }
        "note" => {
            conn.execute("DELETE FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL", [id])?;
        }
        "whiteboard" => {
            conn.execute("DELETE FROM whiteboards WHERE id = ?1 AND deleted_at IS NOT NULL", [id])?;
        }
        "project" => {
            let ts: Option<i64> = conn.query_row("SELECT deleted_at FROM projects WHERE id = ?1", [id], |r| r.get(0))?;
            let Some(ts) = ts else { return invalid("Project isn't in the trash.") };
            let mut stmt = conn.prepare("SELECT id FROM tasks WHERE project_id = ?1 AND deleted_at = ?2")?;
            let ids: Vec<String> = stmt.query_map(params![id, ts], |r| r.get(0))?.collect::<Result<_, _>>()?;
            for t in ids {
                attachments::remove_files_for_task(conn, &t)?;
            }
            attachments::remove_files_for_project(conn, id)?;
            conn.execute("DELETE FROM tasks WHERE project_id = ?1 AND deleted_at = ?2", params![id, ts])?;
            conn.execute("DELETE FROM notes WHERE project_id = ?1 AND deleted_at = ?2", params![id, ts])?;
            conn.execute("DELETE FROM projects WHERE id = ?1", [id])?;
        }
        _ => return invalid("Unknown item type."),
    }
    Ok(())
}

pub fn purge_older_than(conn: &Connection, days: i64) -> AppResult<usize> {
    if days <= 0 {
        return Ok(0);
    }
    let cutoff = now_ms() - days * 86_400_000;
    let items: Vec<TrashItem> = list(conn)?.into_iter().filter(|i| i.deleted_at < cutoff).collect();
    for i in &items {
        purge(conn, &i.kind, &i.id)?;
    }
    Ok(items.len())
}

#[tauri::command]
pub fn trash_list(state: State<AppState>) -> AppResult<Vec<TrashItem>> {
    state.with(|c| list(c))
}

#[tauri::command]
pub fn trash_purge(state: State<AppState>, kind: String, id: String) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        purge(&tx, &kind, &id)?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn trash_empty(state: State<AppState>) -> AppResult<usize> {
    state.with(|c| {
        let tx = c.transaction()?;
        let items = list(&tx)?;
        for i in &items {
            purge(&tx, &i.kind, &i.id)?;
        }
        tx.commit()?;
        Ok(items.len())
    })
}
