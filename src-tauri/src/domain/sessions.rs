//! Work sessions: time spent on a project or task, for any kind of project.
//! Development context (repository, branch, worktree) is optional.
//!
//! Timing is derived from timestamps only, so minimising, throttling or a
//! restart never drifts the clock: elapsed = (end or now) − start − paused.
//! While a session runs the client records a heartbeat (`last_seen_at`) at a
//! low rate; a long silence (sleep, crash, the app being closed) shows up as
//! a gap the user can keep or exclude. Nothing else is monitored: no
//! keystrokes, screenshots or other applications.

use crate::domain::tasks::{self, TaskPatch};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

/// A silence longer than this while running is reported as a gap.
pub const GAP_MS: i64 = 10 * 60_000;

/// SQL for a session's elapsed milliseconds, with `now` as the given parameter.
pub fn elapsed_expr(now: &str) -> String {
    format!(
        "max(0, coalesce(ended_at, {now}) - started_at - paused_ms - CASE WHEN paused_at IS NOT NULL THEN max(0, coalesce(ended_at, {now}) - paused_at) ELSE 0 END)"
    )
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionLink {
    pub id: String,
    pub kind: String,
    pub repository_id: Option<String>,
    #[serde(rename = "ref")]
    pub reference: String,
    pub title: Option<String>,
    pub url: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub task_id: Option<String>,
    pub task_title: Option<String>,
    pub repository_id: Option<String>,
    pub repository_name: Option<String>,
    pub branch: Option<String>,
    pub worktree_id: Option<String>,
    pub milestone_id: Option<String>,
    pub milestone_title: Option<String>,
    pub note: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub paused_ms: i64,
    pub paused_at: Option<i64>,
    pub last_seen_at: i64,
    /// running | paused | ended
    pub status: String,
    pub elapsed_ms: i64,
    /// Unaccounted silence before now (sleep, crash, app closed), if long.
    pub gap_ms: Option<i64>,
    pub links: Vec<SessionLink>,
}

const SELECT: &str = "SELECT s.id, s.project_id, (SELECT name FROM projects p WHERE p.id = s.project_id), s.task_id,
  (SELECT title FROM tasks t WHERE t.id = s.task_id), s.repository_id,
  (SELECT coalesce(nullif(trim(r.alias), ''), r.github, r.local_path) FROM project_repositories r WHERE r.id = s.repository_id),
  s.branch, s.worktree_id, s.milestone_id, (SELECT title FROM milestones m WHERE m.id = s.milestone_id), s.note,
  s.started_at, s.ended_at, s.paused_ms, s.paused_at, s.last_seen_at
FROM work_sessions s";

pub fn elapsed(started: i64, ended: Option<i64>, paused_ms: i64, paused_at: Option<i64>, now: i64) -> i64 {
    let end = ended.unwrap_or(now);
    let pausing = paused_at.map(|p| (end - p).max(0)).unwrap_or(0);
    (end - started - paused_ms - pausing).max(0)
}

fn map(r: &Row, now: i64) -> rusqlite::Result<Session> {
    let started_at: i64 = r.get(12)?;
    let ended_at: Option<i64> = r.get(13)?;
    let paused_ms: i64 = r.get(14)?;
    let paused_at: Option<i64> = r.get(15)?;
    let last_seen_at: i64 = r.get(16)?;
    let repo: Option<String> = r.get(6)?;
    let status = if ended_at.is_some() { "ended" } else if paused_at.is_some() { "paused" } else { "running" };
    let gap = now - last_seen_at;
    Ok(Session {
        id: r.get(0)?,
        project_id: r.get(1)?,
        project_name: r.get(2)?,
        task_id: r.get(3)?,
        task_title: r.get(4)?,
        repository_id: r.get(5)?,
        repository_name: repo.map(|n| n.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or(&n).to_string()),
        branch: r.get(7)?,
        worktree_id: r.get(8)?,
        milestone_id: r.get(9)?,
        milestone_title: r.get(10)?,
        note: r.get(11)?,
        started_at,
        ended_at,
        paused_ms,
        paused_at,
        last_seen_at,
        status: status.into(),
        elapsed_ms: elapsed(started_at, ended_at, paused_ms, paused_at, now),
        gap_ms: (status == "running" && gap > GAP_MS).then_some(gap),
        links: vec![],
    })
}

fn load_links(conn: &Connection, s: &mut Session) -> AppResult<()> {
    let mut stmt = conn.prepare("SELECT id, kind, repository_id, ref, title, url FROM session_links WHERE session_id = ?1 ORDER BY created_at")?;
    s.links = stmt
        .query_map([&s.id], |r| Ok(SessionLink { id: r.get(0)?, kind: r.get(1)?, repository_id: r.get(2)?, reference: r.get(3)?, title: r.get(4)?, url: r.get(5)? }))?
        .collect::<Result<_, _>>()?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Session> {
    let now = now_ms();
    let mut s = conn
        .query_row(&format!("{SELECT} WHERE s.id = ?1"), [id], |r| map(r, now))
        .optional()?
        .ok_or_else(|| AppError::NotFound("Session".into()))?;
    load_links(conn, &mut s)?;
    Ok(s)
}

pub fn active(conn: &Connection) -> AppResult<Option<Session>> {
    let id: Option<String> =
        conn.query_row("SELECT id FROM work_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1", [], |r| r.get(0)).optional()?;
    id.map(|i| get(conn, &i)).transpose()
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionInput {
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub repository_id: Option<String>,
    pub branch: Option<String>,
    pub worktree_id: Option<String>,
    pub milestone_id: Option<String>,
    pub note: Option<String>,
}

/// Starts a session. Only one runs at a time: an open one is stopped first.
pub fn start(conn: &Connection, input: &SessionInput) -> AppResult<Session> {
    if let Some(open) = active(conn)? {
        stop(conn, &open.id, None)?;
    }
    let mut project_id = input.project_id.clone();
    if let Some(t) = &input.task_id {
        let task = tasks::get_task(conn, t)?;
        if project_id.is_none() {
            project_id = task.project_id.clone();
        }
    }
    let now = now_ms();
    let id = new_id();
    conn.execute(
        "INSERT INTO work_sessions(id, project_id, task_id, repository_id, branch, worktree_id, milestone_id, note, started_at, last_seen_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?9, ?9)",
        params![
            id,
            project_id,
            input.task_id,
            input.repository_id,
            input.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()),
            input.worktree_id,
            input.milestone_id,
            input.note.clone().unwrap_or_default(),
            now
        ],
    )?;
    if let Some(t) = &input.task_id {
        let title: String = conn.query_row("SELECT title FROM tasks WHERE id = ?1", [t], |r| r.get(0))?;
        crate::domain::activity::log(conn, project_id.as_deref(), "session", &id, "started", &title)?;
    }
    get(conn, &id)
}

fn open_session(conn: &Connection, id: &str) -> AppResult<(Option<i64>, Option<i64>, i64)> {
    conn.query_row("SELECT ended_at, paused_at, last_seen_at FROM work_sessions WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?
        .ok_or_else(|| AppError::NotFound("Session".into()))
}

pub fn pause(conn: &Connection, id: &str) -> AppResult<Session> {
    let (ended, paused, _) = open_session(conn, id)?;
    if ended.is_some() {
        return invalid("This session has already ended.");
    }
    if paused.is_none() {
        let now = now_ms();
        conn.execute("UPDATE work_sessions SET paused_at = ?1, last_seen_at = ?1, updated_at = ?1 WHERE id = ?2", params![now, id])?;
    }
    get(conn, id)
}

pub fn resume(conn: &Connection, id: &str) -> AppResult<Session> {
    let (ended, paused, _) = open_session(conn, id)?;
    if ended.is_some() {
        return invalid("This session has already ended.");
    }
    if let Some(p) = paused {
        let now = now_ms();
        conn.execute(
            "UPDATE work_sessions SET paused_ms = paused_ms + ?1, paused_at = NULL, last_seen_at = ?2, updated_at = ?2 WHERE id = ?3",
            params![(now - p).max(0), now, id],
        )?;
    }
    get(conn, id)
}

/// Ends a session at `at` (default now) and adds its time to the task.
pub fn stop_at(conn: &Connection, id: &str, at: Option<i64>, note: Option<&str>) -> AppResult<Session> {
    let (ended, paused, _) = open_session(conn, id)?;
    if ended.is_some() {
        return get(conn, id);
    }
    let now = now_ms();
    let end = at.unwrap_or(now).min(now);
    let fold = paused.map(|p| (end - p).max(0)).unwrap_or(0);
    conn.execute(
        "UPDATE work_sessions SET ended_at = max(started_at, ?1), paused_ms = paused_ms + ?2, paused_at = NULL, note = coalesce(?3, note), updated_at = ?4 WHERE id = ?5",
        params![end, fold, note, now, id],
    )?;
    let s = get(conn, id)?;
    if let Some(t) = &s.task_id {
        let _ = tasks::update_task(conn, t, &TaskPatch { add_tracked_seconds: Some(s.elapsed_ms / 1000), ..Default::default() });
    }
    Ok(s)
}

pub fn stop(conn: &Connection, id: &str, note: Option<&str>) -> AppResult<Session> {
    stop_at(conn, id, None, note)
}

pub fn heartbeat(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("UPDATE work_sessions SET last_seen_at = ?1 WHERE id = ?2 AND ended_at IS NULL", params![now_ms(), id])?;
    Ok(())
}

/// Excludes the silence since the last heartbeat (the computer slept or the
/// app wasn't running) from a running session.
pub fn discard_gap(conn: &Connection, id: &str) -> AppResult<Session> {
    let (ended, paused, last_seen) = open_session(conn, id)?;
    if ended.is_none() && paused.is_none() {
        let now = now_ms();
        conn.execute(
            "UPDATE work_sessions SET paused_ms = paused_ms + ?1, last_seen_at = ?2, updated_at = ?2 WHERE id = ?3",
            params![(now - last_seen).max(0), now, id],
        )?;
    }
    get(conn, id)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionPatch {
    pub note: Option<String>,
    #[serde(deserialize_with = "crate::util::some")]
    pub task_id: Option<Option<String>>,
    #[serde(deserialize_with = "crate::util::some")]
    pub project_id: Option<Option<String>>,
    #[serde(deserialize_with = "crate::util::some")]
    pub milestone_id: Option<Option<String>>,
    #[serde(deserialize_with = "crate::util::some")]
    pub repository_id: Option<Option<String>>,
    #[serde(deserialize_with = "crate::util::some")]
    pub branch: Option<Option<String>>,
}

pub fn update(conn: &Connection, id: &str, p: &SessionPatch) -> AppResult<Session> {
    let prev = get(conn, id)?;
    let now = now_ms();
    let set = |col: &str, v: &dyn rusqlite::ToSql| -> AppResult<()> {
        conn.execute(&format!("UPDATE work_sessions SET {col} = ?1, updated_at = ?2 WHERE id = ?3"), params![v, now, id])?;
        Ok(())
    };
    if let Some(n) = &p.note {
        set("note", n)?;
    }
    if let Some(v) = &p.project_id {
        set("project_id", v)?;
    }
    if let Some(v) = &p.milestone_id {
        set("milestone_id", v)?;
    }
    if let Some(v) = &p.repository_id {
        set("repository_id", v)?;
    }
    if let Some(v) = &p.branch {
        set("branch", &v.as_deref().map(str::trim).filter(|b| !b.is_empty()))?;
    }
    if let Some(v) = &p.task_id {
        set("task_id", v)?;
        // Time already credited to the previous task moves with the session.
        if prev.status == "ended" && prev.task_id != *v {
            let secs = prev.elapsed_ms / 1000;
            if let Some(old) = &prev.task_id {
                let _ = tasks::update_task(conn, old, &TaskPatch { add_tracked_seconds: Some(-secs), ..Default::default() });
            }
            if let Some(new) = v {
                let _ = tasks::update_task(conn, new, &TaskPatch { add_tracked_seconds: Some(secs), ..Default::default() });
            }
        }
    }
    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let s = get(conn, id)?;
    if let (Some(t), "ended") = (&s.task_id, s.status.as_str()) {
        let _ = tasks::update_task(conn, t, &TaskPatch { add_tracked_seconds: Some(-(s.elapsed_ms / 1000)), ..Default::default() });
    }
    conn.execute("DELETE FROM work_sessions WHERE id = ?1", [id])?;
    Ok(())
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionQuery {
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub limit: Option<i64>,
}

pub fn list(conn: &Connection, q: &SessionQuery) -> AppResult<Vec<Session>> {
    let now = now_ms();
    let mut stmt = conn.prepare(&format!(
        "{SELECT} WHERE s.started_at >= ?1 AND s.started_at < ?2 AND (?3 IS NULL OR s.project_id = ?3) AND (?4 IS NULL OR s.task_id = ?4)
         ORDER BY s.started_at DESC LIMIT ?5"
    ))?;
    let rows = stmt.query_map(
        params![q.from.unwrap_or(0), q.to.unwrap_or(i64::MAX), q.project_id, q.task_id, q.limit.unwrap_or(200).clamp(1, 2000)],
        |r| map(r, now),
    )?;
    let mut out = rows.collect::<Result<Vec<_>, _>>()?;
    for s in &mut out {
        load_links(conn, s)?;
    }
    Ok(out)
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub key: Option<String>,
    pub label: String,
    pub ms: i64,
    pub sessions: i64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub total_ms: i64,
    pub sessions: i64,
    /// Local calendar days (YYYY-MM-DD) in range, each with its time.
    pub by_day: Vec<Bucket>,
    pub by_project: Vec<Bucket>,
    pub by_task: Vec<Bucket>,
}

/// Time per day / project / task for sessions that started in [from, to).
/// `tz_offset_minutes` places sessions on the user's local calendar days.
pub fn report(conn: &Connection, from: i64, to: i64, tz_offset_minutes: i64, project_id: Option<&str>) -> AppResult<Report> {
    let now = now_ms();
    let e = elapsed_expr("?3");
    let off = tz_offset_minutes * 60_000;
    let (total_ms, sessions): (i64, i64) = conn.query_row(
        &format!("SELECT coalesce(sum({e}), 0), count(*) FROM work_sessions WHERE started_at >= ?1 AND started_at < ?2 AND (?4 IS NULL OR project_id = ?4)"),
        params![from, to, now, project_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let bucket = |sql: String, args: &[&dyn rusqlite::ToSql]| -> AppResult<Vec<Bucket>> {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(args, |r| Ok(Bucket { key: r.get(0)?, label: r.get::<_, Option<String>>(1)?.unwrap_or_default(), ms: r.get(2)?, sessions: r.get(3)? }))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    };
    let by_day = bucket(
        format!(
            "SELECT date((started_at + ?5) / 1000, 'unixepoch') AS d, date((started_at + ?5) / 1000, 'unixepoch'), sum({e}), count(*)
             FROM work_sessions WHERE started_at >= ?1 AND started_at < ?2 AND (?4 IS NULL OR project_id = ?4) GROUP BY d ORDER BY d"
        ),
        &[&from, &to, &now, &project_id, &off],
    )?;
    let by_project = bucket(
        format!(
            "SELECT s.project_id, coalesce((SELECT name FROM projects p WHERE p.id = s.project_id), 'No project'), sum({e}) AS ms, count(*)
             FROM work_sessions s WHERE started_at >= ?1 AND started_at < ?2 AND (?4 IS NULL OR project_id = ?4) GROUP BY s.project_id ORDER BY ms DESC LIMIT 20"
        ),
        &[&from, &to, &now, &project_id],
    )?;
    let by_task = bucket(
        format!(
            "SELECT s.task_id, coalesce((SELECT title FROM tasks t WHERE t.id = s.task_id), 'No task'), sum({e}) AS ms, count(*)
             FROM work_sessions s WHERE started_at >= ?1 AND started_at < ?2 AND (?4 IS NULL OR project_id = ?4) GROUP BY s.task_id ORDER BY ms DESC LIMIT 20"
        ),
        &[&from, &to, &now, &project_id],
    )?;
    Ok(Report { total_ms, sessions, by_day, by_project, by_task })
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub fn session_active(state: State<AppState>) -> AppResult<Option<Session>> {
    state.with(|c| active(c))
}

#[tauri::command]
pub fn session_start(state: State<AppState>, input: SessionInput) -> AppResult<Session> {
    state.with(|c| {
        let tx = c.transaction()?;
        let s = start(&tx, &input)?;
        tx.commit()?;
        Ok(s)
    })
}

#[tauri::command]
pub fn session_pause(state: State<AppState>, id: String) -> AppResult<Session> {
    state.with(|c| pause(c, &id))
}

#[tauri::command]
pub fn session_resume(state: State<AppState>, id: String) -> AppResult<Session> {
    state.with(|c| resume(c, &id))
}

/// `at` ends the session earlier than now (e.g. at the last activity before a crash).
#[tauri::command]
pub fn session_stop(state: State<AppState>, id: String, note: Option<String>, at: Option<i64>) -> AppResult<Session> {
    state.with(|c| {
        let tx = c.transaction()?;
        let s = stop_at(&tx, &id, at, note.as_deref())?;
        tx.commit()?;
        Ok(s)
    })
}

#[tauri::command]
pub fn session_heartbeat(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| heartbeat(c, &id))
}

#[tauri::command]
pub fn session_discard_gap(state: State<AppState>, id: String) -> AppResult<Session> {
    state.with(|c| discard_gap(c, &id))
}

#[tauri::command]
pub fn session_update(state: State<AppState>, id: String, patch: SessionPatch) -> AppResult<Session> {
    state.with(|c| {
        let tx = c.transaction()?;
        let s = update(&tx, &id, &patch)?;
        tx.commit()?;
        Ok(s)
    })
}

#[tauri::command]
pub fn session_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        delete(&tx, &id)?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn sessions_list(state: State<AppState>, query: SessionQuery) -> AppResult<Vec<Session>> {
    state.with(|c| list(c, &query))
}

#[tauri::command]
pub fn sessions_report(state: State<AppState>, from: i64, to: i64, tz_offset_minutes: i64, project_id: Option<String>) -> AppResult<Report> {
    state.with(|c| report(c, from, to, tz_offset_minutes, project_id.as_deref()))
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionLinkInput {
    pub session_id: String,
    pub kind: String,
    pub repository_id: Option<String>,
    #[serde(rename = "ref")]
    pub reference: String,
    pub title: Option<String>,
    pub url: Option<String>,
}

#[tauri::command]
pub fn session_link_add(state: State<AppState>, input: SessionLinkInput) -> AppResult<()> {
    if !["commit", "pull", "issue"].contains(&input.kind.as_str()) || input.reference.trim().is_empty() {
        return invalid("Unknown link.");
    }
    state.with(|c| {
        c.execute(
            "INSERT OR IGNORE INTO session_links(id, session_id, kind, repository_id, ref, title, url, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![new_id(), input.session_id, input.kind, input.repository_id, input.reference.trim(), input.title, input.url, now_ms()],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn session_link_remove(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM session_links WHERE id = ?1", [id])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::projects::{create_project, ProjectInput};
    use crate::domain::tasks::{create_task, get_task, TaskInput};

    #[test]
    fn elapsed_excludes_pauses_and_clamps_clock_changes() {
        assert_eq!(elapsed(1_000, Some(11_000), 2_000, None, 0), 8_000);
        // Paused at 6s and still paused at now = 9s: 5s counted.
        assert_eq!(elapsed(1_000, None, 0, Some(6_000), 9_000), 5_000);
        // The clock moved backwards: never negative.
        assert_eq!(elapsed(10_000, None, 0, None, 5_000), 0);
    }

    #[test]
    fn sessions_work_without_projects_or_git() {
        let c = open_memory();
        let s = start(&c, &SessionInput::default()).unwrap();
        assert_eq!(s.status, "running");
        assert!(s.project_id.is_none() && s.repository_id.is_none());
        let s = pause(&c, &s.id).unwrap();
        assert_eq!(s.status, "paused");
        let s = resume(&c, &s.id).unwrap();
        assert_eq!(s.status, "running");
        let s = stop(&c, &s.id, Some("done")).unwrap();
        assert_eq!((s.status.as_str(), s.note.as_str()), ("ended", "done"));
    }

    #[test]
    fn one_session_at_a_time_and_time_goes_to_the_task() {
        let c = open_memory();
        let p = create_project(&c, &ProjectInput { name: "Garden".into(), ..Default::default() }).unwrap();
        let t = create_task(&c, &TaskInput { title: "Plant beans".into(), project_id: Some(p.id.clone()), ..Default::default() }).unwrap();
        let a = start(&c, &SessionInput { task_id: Some(t.id.clone()), ..Default::default() }).unwrap();
        assert_eq!(a.project_id.as_deref(), Some(p.id.as_str()), "the task's project is used");
        c.execute("UPDATE work_sessions SET started_at = started_at - 120000 WHERE id = ?1", [&a.id]).unwrap();
        let b = start(&c, &SessionInput::default()).unwrap();
        assert_eq!(get(&c, &a.id).unwrap().status, "ended");
        assert_eq!(active(&c).unwrap().unwrap().id, b.id);
        let tracked = get_task(&c, &t.id).unwrap().tracked_seconds;
        assert!((119..=121).contains(&tracked), "tracked {tracked}");
        // Deleting the ended session takes its time back.
        delete(&c, &a.id).unwrap();
        assert_eq!(get_task(&c, &t.id).unwrap().tracked_seconds, 0);
    }

    #[test]
    fn gaps_are_reported_and_can_be_excluded() {
        let c = open_memory();
        let s = start(&c, &SessionInput::default()).unwrap();
        c.execute("UPDATE work_sessions SET started_at = started_at - 3600000, last_seen_at = last_seen_at - 1800000 WHERE id = ?1", [&s.id]).unwrap();
        let s = get(&c, &s.id).unwrap();
        assert!(s.gap_ms.unwrap() >= 1_800_000);
        let s = discard_gap(&c, &s.id).unwrap();
        assert!(s.gap_ms.is_none());
        assert!((s.elapsed_ms - 1_800_000).abs() < 2_000, "elapsed {}", s.elapsed_ms);
    }

    #[test]
    fn reports_group_by_day_project_and_task() {
        let c = open_memory();
        let p = create_project(&c, &ProjectInput { name: "Garden".into(), ..Default::default() }).unwrap();
        let s = start(&c, &SessionInput { project_id: Some(p.id.clone()), ..Default::default() }).unwrap();
        c.execute("UPDATE work_sessions SET started_at = started_at - 600000 WHERE id = ?1", [&s.id]).unwrap();
        stop(&c, &s.id, None).unwrap();
        let r = report(&c, 0, i64::MAX, 0, None).unwrap();
        assert_eq!(r.sessions, 1);
        assert!(r.total_ms >= 600_000);
        assert_eq!(r.by_project[0].label, "Garden");
        assert_eq!(r.by_day.len(), 1);
        assert_eq!(r.by_task[0].label, "No task");
    }
}
