//! Links between tasks and development resources (repositories, branches,
//! worktrees, pull requests, commits), and the development context shown in
//! the task inspector.
//!
//! Only explicit links are stored. Context that is merely inferred (a pull
//! request whose head branch matches a linked branch) is returned with
//! `inferred: true` so the interface can label it as such. Completing a task
//! never commits, pushes, merges or removes anything.

use crate::domain::git::{self, blocking};
use crate::domain::repos;
use crate::error::{invalid, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use tauri::AppHandle;

pub const KINDS: &[&str] = &["repository", "branch", "worktree", "pull", "commit"];

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DevLink {
    pub id: String,
    pub task_id: String,
    pub kind: String,
    pub repository_id: Option<String>,
    pub repository_name: Option<String>,
    #[serde(rename = "ref")]
    pub reference: String,
    pub title: Option<String>,
    pub url: Option<String>,
    pub created_at: i64,
}

/// Adds a link unless the same one exists (idempotent).
pub fn add_link(conn: &Connection, task_id: &str, kind: &str, repository_id: Option<&str>, reference: &str, title: Option<&str>, url: Option<&str>) -> AppResult<()> {
    if !KINDS.contains(&kind) {
        return invalid("Unknown link type.");
    }
    conn.execute(
        "INSERT OR IGNORE INTO task_dev_links(id, task_id, kind, repository_id, ref, title, url, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![new_id(), task_id, kind, repository_id, reference, title, url, now_ms()],
    )?;
    Ok(())
}

pub fn links(conn: &Connection, task_id: &str) -> AppResult<Vec<DevLink>> {
    let mut stmt = conn.prepare(
        "SELECT d.id, d.task_id, d.kind, d.repository_id,
           (SELECT coalesce(nullif(trim(r.alias), ''), r.github, r.local_path) FROM project_repositories r WHERE r.id = d.repository_id),
           d.ref, d.title, d.url, d.created_at
         FROM task_dev_links d WHERE d.task_id = ?1 ORDER BY d.created_at",
    )?;
    let rows = stmt.query_map([task_id], |r| {
        let name: Option<String> = r.get(4)?;
        Ok(DevLink {
            id: r.get(0)?,
            task_id: r.get(1)?,
            kind: r.get(2)?,
            repository_id: r.get(3)?,
            repository_name: name.map(|n| n.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or(&n).to_string()),
            reference: r.get(5)?,
            title: r.get(6)?,
            url: r.get(7)?,
            created_at: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPull {
    pub repository: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub head: String,
    pub checks: String,
    pub review: String,
    pub draft: bool,
    /// Matched by branch name or issue reference rather than an explicit link.
    pub inferred: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskDevContext {
    pub links: Vec<DevLink>,
    pub pulls: Vec<LinkedPull>,
    pub session_seconds: i64,
    pub session_count: i64,
    pub active_session_id: Option<String>,
}

/// Pull requests cached by the last GitHub fetch for a repository.
pub fn cached_pulls(conn: &Connection, full: &str) -> Vec<Value> {
    conn.query_row("SELECT data FROM dev_cache WHERE key = ?1", [format!("gh:pulls:{}", full.to_lowercase())], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

pub fn context(conn: &Connection, task_id: &str) -> AppResult<TaskDevContext> {
    let links = links(conn, task_id)?;
    let (session_seconds, session_count): (i64, i64) = conn.query_row(
        &format!("SELECT coalesce(sum({}), 0) / 1000, count(*) FROM work_sessions WHERE task_id = ?1", crate::domain::sessions::elapsed_expr("?2")),
        params![task_id, now_ms()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let active_session_id: Option<String> =
        conn.query_row("SELECT id FROM work_sessions WHERE task_id = ?1 AND ended_at IS NULL", [task_id], |r| r.get(0)).optional()?;
    // Pull requests: explicit links first, then ones inferred from linked
    // branches or the task's GitHub issue, from the cached pull list.
    let issue: Option<(String, i64)> =
        conn.query_row("SELECT repo, issue_number FROM task_issue_links WHERE task_id = ?1", [task_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let mut repos_seen: Vec<(Option<String>, String)> = vec![];
    for l in &links {
        if let Some(rid) = &l.repository_id {
            if let Some(gh) = conn.query_row("SELECT github FROM project_repositories WHERE id = ?1", [rid], |r| r.get::<_, Option<String>>(0)).optional()?.flatten() {
                if !repos_seen.iter().any(|(_, g)| g.eq_ignore_ascii_case(&gh)) {
                    repos_seen.push((Some(rid.clone()), gh));
                }
            }
        }
    }
    if let Some((repo, _)) = &issue {
        if !repos_seen.iter().any(|(_, g)| g.eq_ignore_ascii_case(repo)) {
            repos_seen.push((None, repo.clone()));
        }
    }
    let mut pulls = vec![];
    for (rid, full) in &repos_seen {
        for p in cached_pulls(conn, full) {
            let num = p.get("number").and_then(|n| n.as_i64()).unwrap_or(0);
            let head = p.get("head").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let explicit = links.iter().any(|l| l.kind == "pull" && l.repository_id.as_deref() == rid.as_deref() && l.reference == num.to_string());
            let by_branch = links.iter().any(|l| l.kind == "branch" && l.repository_id.as_deref() == rid.as_deref() && l.reference == head);
            let by_issue = issue.as_ref().is_some_and(|(r, n)| r.eq_ignore_ascii_case(full) && p.get("linkedIssues").and_then(|v| v.as_array()).is_some_and(|a| a.iter().any(|x| x.as_i64() == Some(*n))));
            if explicit || by_branch || by_issue {
                pulls.push(LinkedPull {
                    repository: full.clone(),
                    number: num,
                    title: p.get("title").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                    url: p.get("htmlUrl").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                    head,
                    checks: p.get("checks").and_then(|n| n.as_str()).unwrap_or("none").to_string(),
                    review: p.get("review").and_then(|n| n.as_str()).unwrap_or("none").to_string(),
                    draft: p.get("draft").and_then(|n| n.as_bool()).unwrap_or(false),
                    inferred: !explicit,
                });
            }
        }
    }
    Ok(TaskDevContext { links, pulls, session_seconds, session_count, active_session_id })
}

/// The branch new work usually starts from: origin's default branch, else
/// main / master, else the current HEAD.
pub fn default_base(root: &Path) -> String {
    if let Ok(o) = git::git(root, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], 10) {
        let o = o.trim();
        if !o.is_empty() {
            return o.to_string();
        }
    }
    for b in ["main", "master", "trunk", "develop"] {
        if git::branch_exists(root, b) {
            return b.to_string();
        }
    }
    "HEAD".into()
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LinkInput {
    pub task_id: String,
    pub kind: String,
    pub repository_id: Option<String>,
    #[serde(rename = "ref")]
    pub reference: String,
    pub title: Option<String>,
    pub url: Option<String>,
}

#[tauri::command]
pub fn task_links(state: tauri::State<AppState>, task_id: String) -> AppResult<Vec<DevLink>> {
    state.with(|c| links(c, &task_id))
}

#[tauri::command]
pub fn task_link_add(state: tauri::State<AppState>, input: LinkInput) -> AppResult<()> {
    state.with(|c| {
        let reference = input.reference.trim();
        if reference.is_empty() && input.kind != "repository" {
            return invalid("Enter what to link.");
        }
        add_link(c, &input.task_id, &input.kind, input.repository_id.as_deref(), reference, input.title.as_deref(), input.url.as_deref())
    })
}

#[tauri::command]
pub fn task_link_remove(state: tauri::State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM task_dev_links WHERE id = ?1", [id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn task_dev_context(state: tauri::State<AppState>, task_id: String) -> AppResult<TaskDevContext> {
    state.with(|c| context(c, &task_id))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub base: String,
    pub commits: Vec<git::Commit>,
}

/// Commits on `branch` that aren't on the repository's base branch.
#[tauri::command]
pub async fn task_branch_commits(app: AppHandle, repository_id: String, branch: String, limit: Option<u32>) -> AppResult<BranchInfo> {
    blocking(&app, move |s| {
        let root = repos::trusted_root(s, &repository_id)?;
        git::valid_branch(&root, &branch)?;
        let base = default_base(&root);
        let range = if base == "HEAD" { branch.clone() } else { format!("{base}..{branch}") };
        let commits = git::log_of(&root, limit.unwrap_or(20), false, Some(&range), None)?;
        Ok(BranchInfo { base, commits })
    })
    .await
}

/// Suggests a base branch for new work in a repository.
#[tauri::command]
pub async fn repo_default_base(app: AppHandle, repository_id: String) -> AppResult<String> {
    blocking(&app, move |s| Ok(default_base(&repos::trusted_root(s, &repository_id)?))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::projects::{create_project, ProjectInput};
    use crate::domain::tasks::{create_task, get_task, update_task, TaskInput, TaskPatch};

    #[test]
    fn links_are_explicit_idempotent_and_survive_completion() {
        let c = open_memory();
        let p = create_project(&c, &ProjectInput { name: "Reactor".into(), ..Default::default() }).unwrap();
        let r = repos::link_github(&c, &p.id, "acme/reactor").unwrap();
        let t = create_task(&c, &TaskInput { title: "Fix reactor cooling controls".into(), project_id: Some(p.id.clone()), ..Default::default() }).unwrap();
        add_link(&c, &t.id, "branch", Some(&r.id), "feature/reactor-cooling-controls", None, None).unwrap();
        add_link(&c, &t.id, "branch", Some(&r.id), "feature/reactor-cooling-controls", None, None).unwrap();
        assert_eq!(links(&c, &t.id).unwrap().len(), 1);
        let task = get_task(&c, &t.id).unwrap();
        assert_eq!(task.dev_links.len(), 1);
        assert_eq!(task.dev_links[0].reference, "feature/reactor-cooling-controls");
        // Completing the task leaves its development links alone.
        update_task(&c, &t.id, &TaskPatch { status: Some("completed".into()), ..Default::default() }).unwrap();
        assert_eq!(links(&c, &t.id).unwrap().len(), 1);
        assert!(add_link(&c, &t.id, "nonsense", None, "x", None, None).is_err());
    }

    #[test]
    fn pulls_from_branches_are_marked_inferred() {
        let c = open_memory();
        let p = create_project(&c, &ProjectInput { name: "Reactor".into(), ..Default::default() }).unwrap();
        let r = repos::link_github(&c, &p.id, "acme/reactor").unwrap();
        let t = create_task(&c, &TaskInput { title: "Cooling".into(), project_id: Some(p.id.clone()), ..Default::default() }).unwrap();
        add_link(&c, &t.id, "branch", Some(&r.id), "feature/cooling", None, None).unwrap();
        c.execute(
            "INSERT INTO dev_cache(key, data, fetched_at) VALUES ('gh:pulls:acme/reactor', ?1, 0)",
            [r#"[{"number":7,"title":"Cooling","htmlUrl":"u","head":"feature/cooling","checks":"success","review":"none","draft":false,"linkedIssues":[]},{"number":8,"title":"Other","htmlUrl":"u","head":"x","linkedIssues":[]}]"#],
        )
        .unwrap();
        let ctx = context(&c, &t.id).unwrap();
        assert_eq!(ctx.pulls.len(), 1);
        assert!(ctx.pulls[0].inferred);
        add_link(&c, &t.id, "pull", Some(&r.id), "7", None, None).unwrap();
        assert!(!context(&c, &t.id).unwrap().pulls[0].inferred);
    }
}
