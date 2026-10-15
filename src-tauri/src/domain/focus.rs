// @Author Christian Relf
// @Date 2026-10-12

//! Focus sessions. The timer itself is timestamp-based on the client; the
//! backend records finished sessions and fires the completion notification
//! from a native thread so it's on time even when the webview is throttled
//! (minimised / hidden to tray).

use crate::domain::{notify, tasks};
use crate::error::AppResult;
use crate::state::AppState;
use crate::util::new_id;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FocusSession {
    pub id: String,
    pub task_id: Option<String>,
    pub kind: String,
    pub planned_seconds: i64,
    pub actual_seconds: i64,
    pub started_at: i64,
    pub ended_at: i64,
    pub completed: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FocusSessionInput {
    pub task_id: Option<String>,
    pub kind: String,
    pub planned_seconds: i64,
    pub actual_seconds: i64,
    pub started_at: i64,
    pub ended_at: i64,
    pub completed: bool,
}

#[tauri::command]
pub fn focus_record(state: State<AppState>, input: FocusSessionInput) -> AppResult<FocusSession> {
    state.with(|c| {
        let tx = c.transaction()?;
        let id = new_id();
        let actual = input.actual_seconds.clamp(0, 24 * 3600);
        tx.execute(
            "INSERT INTO focus_sessions(id, task_id, kind, planned_seconds, actual_seconds, started_at, ended_at, completed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, input.task_id, input.kind, input.planned_seconds, actual, input.started_at, input.ended_at, input.completed as i64],
        )?;
        if let (Some(task_id), "focus") = (&input.task_id, input.kind.as_str()) {
            // Ignore a deleted/missing task rather than failing the record.
            let _ = tasks::update_task(
                &tx,
                task_id,
                &tasks::TaskPatch { add_tracked_seconds: Some(actual), ..Default::default() },
            );
        }
        tx.commit()?;
        Ok(FocusSession {
            id,
            task_id: input.task_id,
            kind: input.kind,
            planned_seconds: input.planned_seconds,
            actual_seconds: actual,
            started_at: input.started_at,
            ended_at: input.ended_at,
            completed: input.completed,
        })
    })
}

#[tauri::command]
pub fn focus_sessions_list(state: State<AppState>, from: i64, to: i64) -> AppResult<Vec<FocusSession>> {
    state.with(|c| {
        let mut stmt = c.prepare(
            "SELECT id, task_id, kind, planned_seconds, actual_seconds, started_at, ended_at, completed FROM focus_sessions
             WHERE started_at >= ?1 AND started_at < ?2 ORDER BY started_at DESC",
        )?;
        let rows = stmt.query_map(params![from, to], |r| {
            Ok(FocusSession {
                id: r.get(0)?,
                task_id: r.get(1)?,
                kind: r.get(2)?,
                planned_seconds: r.get(3)?,
                actual_seconds: r.get(4)?,
                started_at: r.get(5)?,
                ended_at: r.get(6)?,
                completed: r.get::<_, i64>(7)? != 0,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

/// Schedules a native notification at `end_at` (epoch ms). Scheduling again
/// or calling `focus_cancel` invalidates any previously scheduled one.
#[tauri::command]
pub fn focus_schedule(app: AppHandle, state: State<AppState>, end_at: i64, title: String, body: String) -> AppResult<()> {
    let generation = state.focus_generation.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        loop {
            let now = chrono::Utc::now().timestamp_millis();
            let remaining = end_at - now;
            if remaining <= 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(remaining.min(1000) as u64));
            let st = app.state::<AppState>();
            if st.focus_generation.load(Ordering::SeqCst) != generation {
                return;
            }
        }
        let st = app.state::<AppState>();
        if st.focus_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let enabled = st
            .with(|c| Ok(notify::category_enabled(c, "notifications.focus")))
            .unwrap_or(true);
        if enabled {
            notify::send(&app, &title, &body);
        }
        let _ = app.emit("kern://focus-ended", end_at);
    });
    Ok(())
}

#[tauri::command]
pub fn focus_cancel(state: State<AppState>) -> AppResult<()> {
    state.focus_generation.fetch_add(1, Ordering::SeqCst);
    Ok(())
}
