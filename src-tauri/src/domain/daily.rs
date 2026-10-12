//! Daily rundown support: a scoped data fetch for the deterministic rundown
//! (computed on the client so the scoring is transparent and adjustable),
//! plus persisted daily snapshots for history.
//!
//! Dates are local calendar dates (YYYY-MM-DD) supplied by the client, so
//! timezone and daylight-saving changes never shift what "today" means.

use crate::domain::projects::{list_projects, Project};
use crate::domain::tasks::{query_tasks, Task, TaskQuery};
use crate::error::AppResult;
use crate::state::AppState;
use crate::util::now_ms;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RundownData {
    pub overdue: Vec<Task>,
    pub today: Vec<Task>,
    pub upcoming: Vec<Task>,
    pub high_priority: Vec<Task>,
    pub in_progress: Vec<Task>,
    pub pinned: Vec<Task>,
    pub completed_today: Vec<Task>,
    pub completed_yesterday: Vec<Task>,
    pub projects: Vec<Project>,
}

/// `day_start` / `yesterday_start` / `tomorrow_start` are local-midnight
/// epoch-ms boundaries computed by the client.
#[tauri::command]
pub fn rundown_data(
    state: State<AppState>,
    today: String,
    horizon_end: String,
    day_start: i64,
    yesterday_start: i64,
    tomorrow_start: i64,
    project_ids: Option<Vec<String>>,
) -> AppResult<RundownData> {
    state.with(|c| {
        let base = TaskQuery { project_ids: project_ids.clone(), top_level_only: true, ..Default::default() };
        let overdue = query_tasks(c, &TaskQuery { overdue_as_of: Some(today.clone()), order: Some("due".into()), ..base.clone() })?;
        let today_tasks = query_tasks(
            c,
            &TaskQuery { due_from: Some(today.clone()), due_to: Some(today.clone()), order: Some("due".into()), ..base.clone() },
        )?;
        let tomorrow = chrono::NaiveDate::parse_from_str(&today, "%Y-%m-%d")
            .map(|d| (d + chrono::Duration::days(1)).format("%Y-%m-%d").to_string())
            .unwrap_or(today.clone());
        let upcoming = query_tasks(
            c,
            &TaskQuery { due_from: Some(tomorrow), due_to: Some(horizon_end), order: Some("due".into()), limit: Some(100), ..base.clone() },
        )?;
        let high_priority =
            query_tasks(c, &TaskQuery { min_priority: Some(3), order: Some("priority".into()), limit: Some(100), ..base.clone() })?;
        let in_progress = query_tasks(
            c,
            &TaskQuery { statuses: Some(vec!["in_progress".into(), "blocked".into()]), limit: Some(100), ..base.clone() },
        )?;
        let pinned = query_tasks(c, &TaskQuery { pinned: Some(true), limit: Some(50), ..base.clone() })?;
        let completed_today = query_tasks(
            c,
            &TaskQuery {
                completed_from: Some(day_start),
                completed_to: Some(tomorrow_start),
                order: Some("completed".into()),
                include_archived: true,
                ..base.clone()
            },
        )?;
        let completed_yesterday = query_tasks(
            c,
            &TaskQuery {
                completed_from: Some(yesterday_start),
                completed_to: Some(day_start),
                order: Some("completed".into()),
                include_archived: true,
                ..base.clone()
            },
        )?;
        let mut projects = list_projects(c, false)?;
        if let Some(ids) = &project_ids {
            projects.retain(|p| ids.contains(&p.id));
        }
        Ok(RundownData {
            overdue,
            today: today_tasks,
            upcoming,
            high_priority,
            in_progress,
            pinned,
            completed_today,
            completed_yesterday,
            projects,
        })
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub day: String,
    pub kind: String,
    pub data: Value,
    pub created_at: i64,
    pub viewed_at: Option<i64>,
}

#[tauri::command]
pub fn snapshot_get(state: State<AppState>, day: String, kind: String) -> AppResult<Option<Snapshot>> {
    state.with(|c| {
        Ok(c.query_row(
            "SELECT day, kind, data, created_at, viewed_at FROM daily_snapshots WHERE day = ?1 AND kind = ?2",
            params![day, kind],
            |r| {
                let d: String = r.get(2)?;
                Ok(Snapshot {
                    day: r.get(0)?,
                    kind: r.get(1)?,
                    data: serde_json::from_str(&d).unwrap_or(Value::Null),
                    created_at: r.get(3)?,
                    viewed_at: r.get(4)?,
                })
            },
        )
        .optional()?)
    })
}

/// Stores the snapshot for a day. An existing snapshot keeps its original
/// creation time and viewed state unless `replace` is set.
#[tauri::command]
pub fn snapshot_save(state: State<AppState>, day: String, kind: String, data: Value, replace: Option<bool>) -> AppResult<()> {
    state.with(|c| {
        let json = serde_json::to_string(&data)?;
        if replace.unwrap_or(false) {
            c.execute(
                "INSERT INTO daily_snapshots(day, kind, data, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(day, kind) DO UPDATE SET data = excluded.data",
                params![day, kind, json, now_ms()],
            )?;
        } else {
            c.execute(
                "INSERT OR IGNORE INTO daily_snapshots(day, kind, data, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![day, kind, json, now_ms()],
            )?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn snapshot_mark_viewed(state: State<AppState>, day: String, kind: String) -> AppResult<()> {
    state.with(|c| {
        c.execute(
            "UPDATE daily_snapshots SET viewed_at = coalesce(viewed_at, ?1) WHERE day = ?2 AND kind = ?3",
            params![now_ms(), day, kind],
        )?;
        Ok(())
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub day: String,
    pub kind: String,
    pub created_at: i64,
    pub viewed_at: Option<i64>,
}

#[tauri::command]
pub fn snapshots_list(state: State<AppState>, limit: Option<i64>) -> AppResult<Vec<SnapshotMeta>> {
    state.with(|c| {
        let mut stmt = c.prepare(
            "SELECT day, kind, created_at, viewed_at FROM daily_snapshots ORDER BY day DESC, kind LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.unwrap_or(120)], |r| {
            Ok(SnapshotMeta { day: r.get(0)?, kind: r.get(1)?, created_at: r.get(2)?, viewed_at: r.get(3)? })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}
