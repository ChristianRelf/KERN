//! Aggregate statistics computed with scoped SQL (no full-table loads).

use crate::error::AppResult;
use crate::state::AppState;
use rusqlite::params;
use serde::Serialize;
use tauri::State;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub open_tasks: i64,
    pub overdue: i64,
    pub due_today: i64,
    pub inbox: i64,
    pub active_projects: i64,
    pub completed_today: i64,
    pub completed_week: i64,
}

#[tauri::command]
pub fn stats_overview(state: State<AppState>, today: String, day_start: i64, week_start: i64) -> AppResult<Overview> {
    state.with(|c| {
        Ok(c.query_row(
            "SELECT
               (SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL AND status != 'completed' AND parent_id IS NULL),
               (SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL AND status != 'completed' AND due_date < ?1),
               (SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL AND status != 'completed' AND due_date = ?1),
               (SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL AND status = 'inbox' AND parent_id IS NULL)
                 + (SELECT count(*) FROM inbox_items),
               (SELECT count(*) FROM projects WHERE deleted_at IS NULL AND archived_at IS NULL),
               (SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND completed_at >= ?2),
               (SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND completed_at >= ?3)",
            params![today, day_start, week_start],
            |r| {
                Ok(Overview {
                    open_tasks: r.get(0)?,
                    overdue: r.get(1)?,
                    due_today: r.get(2)?,
                    inbox: r.get(3)?,
                    active_projects: r.get(4)?,
                    completed_today: r.get(5)?,
                    completed_week: r.get(6)?,
                })
            },
        )?)
    })
}

/// Completion timestamps in [from, to); the client buckets them by local day.
#[tauri::command]
pub fn stats_completions(state: State<AppState>, from: i64, to: i64) -> AppResult<Vec<i64>> {
    state.with(|c| {
        let mut stmt = c.prepare(
            "SELECT completed_at FROM tasks WHERE deleted_at IS NULL AND completed_at >= ?1 AND completed_at < ?2 ORDER BY completed_at",
        )?;
        let rows = stmt.query_map(params![from, to], |r| r.get(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

/// Number of open tasks per due date in [from, to] (calendar indicators).
#[tauri::command]
pub fn stats_due_counts(state: State<AppState>, from: String, to: String) -> AppResult<Vec<(String, i64, i64)>> {
    state.with(|c| {
        let mut stmt = c.prepare(
            "SELECT due_date, sum(status != 'completed'), sum(status = 'completed') FROM tasks
             WHERE deleted_at IS NULL AND archived_at IS NULL AND parent_id IS NULL AND due_date >= ?1 AND due_date <= ?2
             GROUP BY due_date",
        )?;
        let rows = stmt.query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub db_bytes: u64,
    pub attachments_bytes: u64,
    pub attachments_count: i64,
    pub tasks: i64,
    pub projects: i64,
    pub notes: i64,
    pub whiteboards: i64,
    pub whiteboard_objects: i64,
    pub activity_entries: i64,
    pub trash_items: i64,
}

pub fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(m) = e.metadata() {
                total += m.len();
            }
        }
    }
    total
}

#[tauri::command]
pub fn storage_stats(state: State<AppState>) -> AppResult<StorageStats> {
    let paths = state.paths.clone();
    let mut db_bytes = std::fs::metadata(&paths.db_path).map(|m| m.len()).unwrap_or(0);
    db_bytes += std::fs::metadata(paths.db_path.with_extension("db-wal")).map(|m| m.len()).unwrap_or(0);
    let attachments_bytes = dir_size(&paths.attachments_dir);
    state.with(|c| {
        Ok(c.query_row(
            "SELECT (SELECT count(*) FROM tasks WHERE deleted_at IS NULL),
                    (SELECT count(*) FROM projects WHERE deleted_at IS NULL),
                    (SELECT count(*) FROM notes WHERE deleted_at IS NULL),
                    (SELECT count(*) FROM whiteboards WHERE deleted_at IS NULL),
                    (SELECT count(*) FROM wb_nodes),
                    (SELECT count(*) FROM activity),
                    (SELECT count(*) FROM tasks WHERE deleted_at IS NOT NULL) + (SELECT count(*) FROM notes WHERE deleted_at IS NOT NULL)
                      + (SELECT count(*) FROM projects WHERE deleted_at IS NOT NULL) + (SELECT count(*) FROM whiteboards WHERE deleted_at IS NOT NULL),
                    (SELECT count(*) FROM attachments)",
            [],
            |r| {
                Ok(StorageStats {
                    db_bytes,
                    attachments_bytes,
                    tasks: r.get(0)?,
                    projects: r.get(1)?,
                    notes: r.get(2)?,
                    whiteboards: r.get(3)?,
                    whiteboard_objects: r.get(4)?,
                    activity_entries: r.get(5)?,
                    trash_items: r.get(6)?,
                    attachments_count: r.get(7)?,
                })
            },
        )?)
    })
}
