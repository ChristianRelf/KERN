//! Milestones for any project (a renovation, an assignment, a launch), which
//! may optionally represent a software release with a version, repository,
//! linked pull requests and issues, and release notes.
//!
//! Tasks join a milestone through `tasks.milestone_id`, so there is still
//! one task record; progress is computed from those tasks unless the
//! milestone tracks progress manually. Nothing is ever published: the
//! changelog is a draft, and a GitHub release is only ever opened in the
//! browser for the user to review and publish themselves.

use crate::domain::{activity, git, repos};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms, some, valid_date};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, State};

pub const STATUSES: &[&str] = &["planned", "active", "completed", "cancelled"];

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseLink {
    pub id: String,
    pub kind: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub title: Option<String>,
    pub url: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Milestone {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub target_date: Option<String>,
    pub status: String,
    pub progress_mode: String,
    pub manual_progress: i64,
    pub is_release: bool,
    pub version: Option<String>,
    pub repository_id: Option<String>,
    pub release_notes: String,
    pub release_url: Option<String>,
    pub sort_order: f64,
    pub completed_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub task_total: i64,
    pub task_done: i64,
    /// 0..=1, from tasks or the manual value.
    pub progress: f64,
    pub overdue: bool,
    pub depends_on: Vec<String>,
    /// Dependencies that aren't completed yet.
    pub blocked_by: Vec<String>,
    pub links: Vec<ReleaseLink>,
}

const SELECT: &str = "SELECT m.id, m.project_id, m.title, m.description, m.target_date, m.status, m.progress_mode, m.manual_progress,
  m.is_release, m.version, m.repository_id, m.release_notes, m.release_url, m.sort_order, m.completed_at, m.created_at, m.updated_at,
  (SELECT count(*) FROM tasks t WHERE t.milestone_id = m.id AND t.deleted_at IS NULL AND t.parent_id IS NULL),
  (SELECT count(*) FROM tasks t WHERE t.milestone_id = m.id AND t.deleted_at IS NULL AND t.parent_id IS NULL AND t.status = 'completed')
FROM milestones m";

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn map(r: &Row) -> rusqlite::Result<Milestone> {
    let status: String = r.get(5)?;
    let mode: String = r.get(6)?;
    let manual: i64 = r.get(7)?;
    let total: i64 = r.get(17)?;
    let done: i64 = r.get(18)?;
    let target: Option<String> = r.get(4)?;
    let progress = if status == "completed" {
        1.0
    } else if mode == "manual" {
        manual.clamp(0, 100) as f64 / 100.0
    } else if total > 0 {
        done as f64 / total as f64
    } else {
        0.0
    };
    let open = status != "completed" && status != "cancelled";
    Ok(Milestone {
        id: r.get(0)?,
        project_id: r.get(1)?,
        title: r.get(2)?,
        description: r.get(3)?,
        overdue: open && target.as_deref().is_some_and(|d| d < today().as_str()),
        target_date: target,
        status,
        progress_mode: mode,
        manual_progress: manual,
        is_release: r.get::<_, i64>(8)? != 0,
        version: r.get(9)?,
        repository_id: r.get(10)?,
        release_notes: r.get(11)?,
        release_url: r.get(12)?,
        sort_order: r.get(13)?,
        completed_at: r.get(14)?,
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
        task_total: total,
        task_done: done,
        progress,
        depends_on: vec![],
        blocked_by: vec![],
        links: vec![],
    })
}

fn decorate(conn: &Connection, list: &mut [Milestone]) -> AppResult<()> {
    if list.is_empty() {
        return Ok(());
    }
    let mut deps_stmt = conn.prepare(
        "SELECT d.depends_on, m.status FROM milestone_deps d JOIN milestones m ON m.id = d.depends_on WHERE d.milestone_id = ?1",
    )?;
    let mut link_stmt = conn.prepare("SELECT id, kind, ref, title, url FROM release_links WHERE milestone_id = ?1 ORDER BY kind, created_at")?;
    for m in list.iter_mut() {
        let deps: Vec<(String, String)> = deps_stmt.query_map([&m.id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        m.blocked_by = deps.iter().filter(|(_, s)| s != "completed").map(|(i, _)| i.clone()).collect();
        m.depends_on = deps.into_iter().map(|(i, _)| i).collect();
        m.links = link_stmt
            .query_map([&m.id], |r| Ok(ReleaseLink { id: r.get(0)?, kind: r.get(1)?, reference: r.get(2)?, title: r.get(3)?, url: r.get(4)? }))?
            .collect::<Result<_, _>>()?;
    }
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Milestone> {
    let mut m = conn.query_row(&format!("{SELECT} WHERE m.id = ?1"), [id], map).optional()?.ok_or_else(|| AppError::NotFound("Milestone".into()))?;
    decorate(conn, std::slice::from_mut(&mut m))?;
    Ok(m)
}

pub fn list(conn: &Connection, project_id: &str) -> AppResult<Vec<Milestone>> {
    let mut stmt = conn.prepare(&format!("{SELECT} WHERE m.project_id = ?1 ORDER BY m.sort_order, m.created_at"))?;
    let mut out = stmt.query_map([project_id], map)?.collect::<Result<Vec<_>, _>>()?;
    decorate(conn, &mut out)?;
    Ok(out)
}

/// Open milestones with a target date up to `until`, across live projects.
pub fn upcoming(conn: &Connection, until: &str, limit: i64) -> AppResult<Vec<Milestone>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT} JOIN projects p ON p.id = m.project_id
         WHERE p.deleted_at IS NULL AND p.archived_at IS NULL AND m.status IN ('planned', 'active') AND m.target_date IS NOT NULL AND m.target_date <= ?1
         ORDER BY m.target_date LIMIT ?2"
    ))?;
    let mut out = stmt.query_map(params![until, limit.clamp(1, 200)], map)?.collect::<Result<Vec<_>, _>>()?;
    decorate(conn, &mut out)?;
    Ok(out)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MilestoneInput {
    pub project_id: String,
    pub title: String,
    pub description: Option<String>,
    pub target_date: Option<String>,
    pub status: Option<String>,
    pub is_release: Option<bool>,
    pub version: Option<String>,
    pub repository_id: Option<String>,
}

fn check_status(s: &str) -> AppResult<()> {
    if STATUSES.contains(&s) {
        Ok(())
    } else {
        invalid("Unknown milestone status.")
    }
}

pub fn create(conn: &Connection, input: &MilestoneInput) -> AppResult<Milestone> {
    let title = input.title.trim();
    if title.is_empty() {
        return invalid("Give the milestone a title.");
    }
    if let Some(d) = &input.target_date {
        if !valid_date(d) {
            return invalid("Target date isn't valid.");
        }
    }
    let status = input.status.clone().unwrap_or_else(|| "planned".into());
    check_status(&status)?;
    let exists: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM projects WHERE id = ?1 AND deleted_at IS NULL)", [&input.project_id], |r| r.get(0))?;
    if !exists {
        return Err(AppError::NotFound("Project".into()));
    }
    let now = now_ms();
    let id = new_id();
    let sort: f64 = conn.query_row("SELECT coalesce(max(sort_order), 0) + 1 FROM milestones WHERE project_id = ?1", [&input.project_id], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO milestones(id, project_id, title, description, target_date, status, is_release, version, repository_id, sort_order, completed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        params![
            id,
            input.project_id,
            title,
            input.description.clone().unwrap_or_default(),
            input.target_date,
            status,
            input.is_release.unwrap_or(false) as i64,
            input.version.as_deref().map(str::trim).filter(|v| !v.is_empty()),
            input.repository_id,
            sort,
            (status == "completed").then_some(now),
            now
        ],
    )?;
    activity::log(conn, Some(&input.project_id), "milestone", &id, "created", title)?;
    get(conn, &id)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MilestonePatch {
    pub title: Option<String>,
    pub description: Option<String>,
    #[serde(deserialize_with = "some")]
    pub target_date: Option<Option<String>>,
    pub status: Option<String>,
    pub progress_mode: Option<String>,
    pub manual_progress: Option<i64>,
    pub is_release: Option<bool>,
    #[serde(deserialize_with = "some")]
    pub version: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub repository_id: Option<Option<String>>,
    pub release_notes: Option<String>,
    #[serde(deserialize_with = "some")]
    pub release_url: Option<Option<String>>,
    pub sort_order: Option<f64>,
}

pub fn update(conn: &Connection, id: &str, p: &MilestonePatch) -> AppResult<Milestone> {
    let prev = get(conn, id)?;
    let now = now_ms();
    let set = |col: &str, v: &dyn rusqlite::ToSql| -> AppResult<()> {
        conn.execute(&format!("UPDATE milestones SET {col} = ?1, updated_at = ?2 WHERE id = ?3"), params![v, now, id])?;
        Ok(())
    };
    if let Some(t) = &p.title {
        let t = t.trim();
        if t.is_empty() {
            return invalid("Give the milestone a title.");
        }
        set("title", &t)?;
    }
    if let Some(d) = &p.description {
        set("description", d)?;
    }
    if let Some(d) = &p.target_date {
        if let Some(v) = d {
            if !valid_date(v) {
                return invalid("Target date isn't valid.");
            }
        }
        set("target_date", d)?;
    }
    if let Some(m) = &p.progress_mode {
        if m != "tasks" && m != "manual" {
            return invalid("Unknown progress mode.");
        }
        set("progress_mode", m)?;
    }
    if let Some(v) = p.manual_progress {
        set("manual_progress", &v.clamp(0, 100))?;
    }
    if let Some(v) = p.is_release {
        set("is_release", &(v as i64))?;
    }
    if let Some(v) = &p.version {
        set("version", &v.as_deref().map(str::trim).filter(|s| !s.is_empty()))?;
    }
    if let Some(v) = &p.repository_id {
        set("repository_id", v)?;
    }
    if let Some(v) = &p.release_notes {
        set("release_notes", v)?;
    }
    if let Some(v) = &p.release_url {
        set("release_url", &v.as_deref().map(str::trim).filter(|s| !s.is_empty()))?;
    }
    if let Some(v) = p.sort_order {
        set("sort_order", &v)?;
    }
    if let Some(s) = &p.status {
        check_status(s)?;
        set("status", s)?;
        if s == "completed" && prev.status != "completed" {
            set("completed_at", &now)?;
            activity::log(conn, Some(&prev.project_id), "milestone", id, "completed", &prev.title)?;
        } else if s != "completed" && prev.status == "completed" {
            set("completed_at", &Option::<i64>::None)?;
            activity::log(conn, Some(&prev.project_id), "milestone", id, "reopened", &prev.title)?;
        }
    }
    get(conn, id)
}

/// Deletes the milestone; its tasks stay (they just leave the milestone).
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let m = get(conn, id)?;
    conn.execute("DELETE FROM milestones WHERE id = ?1", [id])?;
    activity::log(conn, Some(&m.project_id), "milestone", id, "deleted", &m.title)?;
    Ok(())
}

/// Replaces a milestone's dependencies (same project only, no cycles).
pub fn set_deps(conn: &Connection, id: &str, depends_on: &[String]) -> AppResult<()> {
    let m = get(conn, id)?;
    let mut graph: HashMap<String, Vec<String>> = HashMap::new();
    let mut stmt = conn.prepare("SELECT d.milestone_id, d.depends_on FROM milestone_deps d JOIN milestones m ON m.id = d.milestone_id WHERE m.project_id = ?1")?;
    for row in stmt.query_map([&m.project_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (a, b) = row?;
        if a != id {
            graph.entry(a).or_default().push(b);
        }
    }
    for d in depends_on {
        let owner: Option<String> = conn.query_row("SELECT project_id FROM milestones WHERE id = ?1", [d], |r| r.get(0)).optional()?;
        if owner.as_deref() != Some(m.project_id.as_str()) {
            return invalid("A milestone can only depend on milestones in the same project.");
        }
    }
    graph.insert(id.to_string(), depends_on.to_vec());
    // Cycle check: can we reach `id` again from its new dependencies?
    let mut stack: Vec<String> = depends_on.to_vec();
    let mut seen = HashSet::new();
    while let Some(n) = stack.pop() {
        if n == id {
            return invalid("That would make milestones depend on each other in a loop.");
        }
        if seen.insert(n.clone()) {
            stack.extend(graph.get(&n).cloned().unwrap_or_default());
        }
    }
    conn.execute("DELETE FROM milestone_deps WHERE milestone_id = ?1", [id])?;
    for d in depends_on {
        conn.execute("INSERT OR IGNORE INTO milestone_deps(milestone_id, depends_on) VALUES (?1, ?2)", params![id, d])?;
    }
    Ok(())
}

/// A Markdown draft of release notes from the milestone's completed tasks,
/// its linked pull requests and issues and, for a trusted local repository,
/// the commits since the latest tag. Never published automatically.
pub fn changelog(state: &AppState, id: &str) -> AppResult<String> {
    let (m, done, open) = state.with(|c| {
        let m = get(c, id)?;
        let mut stmt = c.prepare(
            "SELECT title, (SELECT l.issue_number FROM task_issue_links l WHERE l.task_id = t.id), status FROM tasks t
             WHERE t.milestone_id = ?1 AND t.deleted_at IS NULL AND t.parent_id IS NULL ORDER BY t.completed_at, t.sort_order",
        )?;
        let rows: Vec<(String, Option<i64>, String)> = stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
        let (done, open): (Vec<_>, Vec<_>) = rows.into_iter().partition(|r| r.2 == "completed");
        Ok((m, done, open))
    })?;
    let mut out = String::new();
    let heading = match (&m.version, m.is_release) {
        (Some(v), true) => format!("## {v}"),
        _ => format!("## {}", m.title),
    };
    out.push_str(&heading);
    out.push_str("\n\n");
    if !m.description.trim().is_empty() {
        out.push_str(m.description.trim());
        out.push_str("\n\n");
    }
    if !done.is_empty() {
        out.push_str("### Completed\n\n");
        for (t, issue, _) in &done {
            match issue {
                Some(n) => out.push_str(&format!("- {t} (#{n})\n")),
                None => out.push_str(&format!("- {t}\n")),
            }
        }
        out.push('\n');
    }
    let pulls: Vec<&ReleaseLink> = m.links.iter().filter(|l| l.kind == "pull").collect();
    if !pulls.is_empty() {
        out.push_str("### Pull requests\n\n");
        for l in pulls {
            out.push_str(&format!("- {} (#{})\n", l.title.as_deref().unwrap_or("Pull request"), l.reference));
        }
        out.push('\n');
    }
    let issues: Vec<&ReleaseLink> = m.links.iter().filter(|l| l.kind == "issue").collect();
    if !issues.is_empty() {
        out.push_str("### Issues\n\n");
        for l in issues {
            out.push_str(&format!("- {} (#{})\n", l.title.as_deref().unwrap_or("Issue"), l.reference));
        }
        out.push('\n');
    }
    if let Some(rid) = &m.repository_id {
        if let Ok(root) = repos::trusted_root(state, rid) {
            let tag = git::git(&root, &["describe", "--tags", "--abbrev=0"], 15).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
            let range = tag.as_ref().map(|t| format!("{t}..HEAD"));
            if let Ok(commits) = git::log_of(&root, 60, false, Some(range.as_deref().unwrap_or("HEAD")), None) {
                let commits: Vec<_> = commits.into_iter().filter(|c| c.parents.len() < 2).collect();
                if !commits.is_empty() {
                    out.push_str(&format!("### Commits{}\n\n", tag.map(|t| format!(" since {t}")).unwrap_or_default()));
                    for c in commits {
                        out.push_str(&format!("- {} ({})\n", c.subject, c.short));
                    }
                    out.push('\n');
                }
            }
        }
    }
    if !open.is_empty() {
        out.push_str(&format!("<!-- {} task(s) in this milestone are still open. -->\n", open.len()));
    }
    if !m.release_notes.trim().is_empty() {
        out.push_str("### Notes\n\n");
        out.push_str(m.release_notes.trim());
        out.push('\n');
    }
    Ok(out.trim_end().to_string() + "\n")
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub fn milestones_list(state: State<AppState>, project_id: String) -> AppResult<Vec<Milestone>> {
    state.with(|c| list(c, &project_id))
}

#[tauri::command]
pub fn milestones_upcoming(state: State<AppState>, until: String, limit: Option<i64>) -> AppResult<Vec<Milestone>> {
    state.with(|c| upcoming(c, &until, limit.unwrap_or(20)))
}

#[tauri::command]
pub fn milestone_get(state: State<AppState>, id: String) -> AppResult<Milestone> {
    state.with(|c| get(c, &id))
}

#[tauri::command]
pub fn milestone_create(state: State<AppState>, input: MilestoneInput) -> AppResult<Milestone> {
    state.with(|c| {
        let tx = c.transaction()?;
        let m = create(&tx, &input)?;
        tx.commit()?;
        Ok(m)
    })
}

#[tauri::command]
pub fn milestone_update(state: State<AppState>, id: String, patch: MilestonePatch) -> AppResult<Milestone> {
    state.with(|c| {
        let tx = c.transaction()?;
        let m = update(&tx, &id, &patch)?;
        tx.commit()?;
        Ok(m)
    })
}

#[tauri::command]
pub fn milestone_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        delete(&tx, &id)?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn milestones_reorder(state: State<AppState>, ids: Vec<String>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute("UPDATE milestones SET sort_order = ?1 WHERE id = ?2", params![i as f64, id])?;
        }
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn milestone_set_deps(state: State<AppState>, id: String, depends_on: Vec<String>) -> AppResult<Milestone> {
    state.with(|c| {
        let tx = c.transaction()?;
        set_deps(&tx, &id, &depends_on)?;
        tx.commit()?;
        get(c, &id)
    })
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseLinkInput {
    pub milestone_id: String,
    pub kind: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub title: Option<String>,
    pub url: Option<String>,
}

#[tauri::command]
pub fn release_link_add(state: State<AppState>, input: ReleaseLinkInput) -> AppResult<Milestone> {
    if input.kind != "pull" && input.kind != "issue" {
        return invalid("Unknown link type.");
    }
    let reference = input.reference.trim().trim_start_matches('#').to_string();
    if reference.is_empty() {
        return invalid("Enter a pull request or issue number.");
    }
    state.with(|c| {
        c.execute(
            "INSERT INTO release_links(id, milestone_id, kind, ref, title, url, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(milestone_id, kind, ref) DO UPDATE SET title = coalesce(excluded.title, title), url = coalesce(excluded.url, url)",
            params![new_id(), input.milestone_id, input.kind, reference, input.title, input.url, now_ms()],
        )?;
        get(c, &input.milestone_id)
    })
}

#[tauri::command]
pub fn release_link_remove(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM release_links WHERE id = ?1", [id])?;
        Ok(())
    })
}

#[tauri::command]
pub async fn milestone_changelog(app: AppHandle, id: String) -> AppResult<String> {
    git::blocking(&app, move |s| changelog(s, &id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::projects::{create_project, ProjectInput};
    use crate::domain::tasks::{create_task, query_tasks, update_task, TaskInput, TaskPatch, TaskQuery};

    fn project(c: &Connection, name: &str) -> String {
        create_project(c, &ProjectInput { name: name.into(), ..Default::default() }).unwrap().id
    }

    #[test]
    fn milestones_need_no_git_and_progress_follows_tasks() {
        let c = open_memory();
        let p = project(&c, "Fitness");
        let m = create(&c, &MilestoneInput { project_id: p.clone(), title: "Run 10k".into(), target_date: Some("2000-01-01".into()), ..Default::default() }).unwrap();
        assert!(m.overdue && m.progress == 0.0 && !m.is_release);
        let a = create_task(&c, &TaskInput { title: "Week 1".into(), project_id: Some(p.clone()), milestone_id: Some(m.id.clone()), ..Default::default() }).unwrap();
        create_task(&c, &TaskInput { title: "Week 2".into(), project_id: Some(p.clone()), milestone_id: Some(m.id.clone()), ..Default::default() }).unwrap();
        update_task(&c, &a.id, &TaskPatch { status: Some("completed".into()), ..Default::default() }).unwrap();
        let m = get(&c, &m.id).unwrap();
        assert_eq!((m.task_done, m.task_total), (1, 2));
        assert!((m.progress - 0.5).abs() < 1e-9);
        let q = query_tasks(&c, &TaskQuery { milestone_ids: Some(vec![m.id.clone()]), include_completed: true, ..Default::default() }).unwrap();
        assert_eq!(q.len(), 2, "the milestone filter returns the same task records");
        let m = update(&c, &m.id, &MilestonePatch { progress_mode: Some("manual".into()), manual_progress: Some(80), ..Default::default() }).unwrap();
        assert!((m.progress - 0.8).abs() < 1e-9);
        let m = update(&c, &m.id, &MilestonePatch { status: Some("completed".into()), ..Default::default() }).unwrap();
        assert!(m.completed_at.is_some() && !m.overdue && m.progress == 1.0);
    }

    #[test]
    fn tasks_keep_their_milestone_within_the_project_only() {
        let c = open_memory();
        let p = project(&c, "Website");
        let q = project(&c, "Other");
        let m = create(&c, &MilestoneInput { project_id: p.clone(), title: "Launch".into(), ..Default::default() }).unwrap();
        let other = create_task(&c, &TaskInput { title: "Elsewhere".into(), project_id: Some(q.clone()), ..Default::default() }).unwrap();
        assert!(update_task(&c, &other.id, &TaskPatch { milestone_id: Some(Some(m.id.clone())), ..Default::default() }).is_err());
        let t = create_task(&c, &TaskInput { title: "Design".into(), project_id: Some(p.clone()), milestone_id: Some(m.id.clone()), ..Default::default() }).unwrap();
        let moved = update_task(&c, &t.id, &TaskPatch { project_id: Some(Some(q.clone())), ..Default::default() }).unwrap().task;
        assert!(moved.milestone_id.is_none(), "moving projects leaves the milestone");
        // Deleting a milestone keeps its tasks.
        let t2 = create_task(&c, &TaskInput { title: "Copy".into(), project_id: Some(p.clone()), milestone_id: Some(m.id.clone()), ..Default::default() }).unwrap();
        delete(&c, &m.id).unwrap();
        let kept = crate::domain::tasks::get_task(&c, &t2.id).unwrap();
        assert!(kept.milestone_id.is_none() && kept.deleted_at.is_none());
    }

    #[test]
    fn dependencies_reject_loops_and_other_projects() {
        let c = open_memory();
        let p = project(&c, "Game");
        let q = project(&c, "Other");
        let a = create(&c, &MilestoneInput { project_id: p.clone(), title: "Alpha".into(), ..Default::default() }).unwrap();
        let b = create(&c, &MilestoneInput { project_id: p.clone(), title: "Beta".into(), ..Default::default() }).unwrap();
        let x = create(&c, &MilestoneInput { project_id: q, title: "X".into(), ..Default::default() }).unwrap();
        set_deps(&c, &b.id, &[a.id.clone()]).unwrap();
        assert_eq!(get(&c, &b.id).unwrap().blocked_by, vec![a.id.clone()]);
        assert!(set_deps(&c, &a.id, &[b.id.clone()]).is_err());
        assert!(set_deps(&c, &a.id, &[x.id.clone()]).is_err());
        update(&c, &a.id, &MilestonePatch { status: Some("completed".into()), ..Default::default() }).unwrap();
        assert!(get(&c, &b.id).unwrap().blocked_by.is_empty());
    }
}
