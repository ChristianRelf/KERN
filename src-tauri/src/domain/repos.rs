// @Author Christian Relf
// @Date 2026-10-12

//! Repositories linked to a project: zero, one or several. Each link has a
//! local clone, a GitHub repository, or both. Links are Kern records only:
//! unlinking never touches the repository on disk or on GitHub.
//!
//! A project's folder link (Files tab) and its GitHub issue-sync connection
//! keep working as before. When the linked folder is itself a git
//! repository it's adopted as a repository link once, and a GitHub
//! connection is mirrored as a repository link, so existing projects gain
//! the repository tools without any setup.

use crate::domain::folders::{self, Trust};
use crate::domain::git::{self, blocking};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub project_id: String,
    /// Display name: the alias, else the folder or GitHub repository name.
    pub name: String,
    pub alias: Option<String>,
    pub local_path: Option<String>,
    /// owner/name on github.com.
    pub github: Option<String>,
    pub is_primary: bool,
    pub sort_order: f64,
    /// ok | missing | not_repo | none (remote only)
    pub local_status: String,
    pub trust: Option<Trust>,
    /// This repository's issues sync with the project's tasks.
    pub issue_sync: bool,
    pub created_at: i64,
}

const SELECT: &str = "SELECT r.id, r.project_id, r.alias, r.local_path, r.folder_key, r.github, r.is_primary, r.sort_order, r.created_at,
  (SELECT t.trust FROM trusted_workspaces t WHERE t.folder_key = r.folder_key),
  EXISTS (SELECT 1 FROM project_repos c WHERE c.project_id = r.project_id AND lower(c.owner || '/' || c.name) = lower(r.github))
FROM project_repositories r";

fn local_status(path: Option<&str>) -> &'static str {
    match path {
        None => "none",
        Some(p) => {
            let p = Path::new(p);
            if !p.is_dir() {
                "missing"
            } else if git::read_remote(p).is_repo {
                "ok"
            } else {
                "not_repo"
            }
        }
    }
}

fn last_segment(s: &str) -> String {
    s.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or(s).to_string()
}

fn map(r: &Row) -> rusqlite::Result<Repository> {
    let alias: Option<String> = r.get(2)?;
    let local_path: Option<String> = r.get(3)?;
    let github: Option<String> = r.get(5)?;
    let trust: Option<String> = r.get(9)?;
    let name = alias
        .clone()
        .filter(|a| !a.trim().is_empty())
        .or_else(|| local_path.as_deref().map(last_segment))
        .or_else(|| github.as_deref().map(last_segment))
        .unwrap_or_else(|| "Repository".into());
    Ok(Repository {
        id: r.get(0)?,
        project_id: r.get(1)?,
        name,
        alias,
        local_status: local_status(local_path.as_deref()).into(),
        local_path,
        github,
        is_primary: r.get::<_, i64>(6)? != 0,
        sort_order: r.get(7)?,
        created_at: r.get(8)?,
        trust: trust.map(|t| if t == "trusted" { Trust::Trusted } else { Trust::Restricted }),
        issue_sync: r.get::<_, i64>(10)? != 0,
    })
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Repository> {
    conn.query_row(&format!("{SELECT} WHERE r.id = ?1"), [id], map)
        .optional()?
        .ok_or_else(|| AppError::NotFound("Repository".into()))
}

fn next_sort(conn: &Connection, project_id: &str) -> AppResult<f64> {
    Ok(conn.query_row("SELECT coalesce(max(sort_order), 0) + 1 FROM project_repositories WHERE project_id = ?1", [project_id], |r| r.get(0))?)
}

fn has_primary(conn: &Connection, project_id: &str) -> AppResult<bool> {
    Ok(conn.query_row("SELECT EXISTS (SELECT 1 FROM project_repositories WHERE project_id = ?1 AND is_primary = 1)", [project_id], |r| r.get(0))?)
}

fn insert(conn: &Connection, project_id: &str, local: Option<&Path>, github: Option<&str>) -> AppResult<String> {
    let id = new_id();
    let now = now_ms();
    let primary = !has_primary(conn, project_id)?;
    conn.execute(
        "INSERT INTO project_repositories(id, project_id, local_path, folder_key, github, is_primary, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            id,
            project_id,
            local.map(|p| p.to_string_lossy().to_string()),
            local.map(folders::folder_key),
            github,
            primary as i64,
            next_sort(conn, project_id)?,
            now
        ],
    )?;
    Ok(id)
}

/// Mirrors the project's folder (when it's a git repository) and its GitHub
/// connection as repository links. Idempotent and cheap: one metadata read.
pub fn adopt(conn: &Connection, project_id: &str) -> AppResult<()> {
    // GitHub issue-sync connection.
    let connected: Option<String> = conn
        .query_row("SELECT owner || '/' || name FROM project_repos WHERE project_id = ?1", [project_id], |r| r.get(0))
        .optional()?;
    // The linked folder, once per folder.
    let folder: Option<(String, String, Option<String>)> = conn
        .query_row(
            "SELECT l.path, l.folder_key, p.repo_adopted_key FROM project_folder_links l JOIN projects p ON p.id = l.project_id WHERE l.project_id = ?1",
            [project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((path, key, adopted)) = folder {
        if adopted.as_deref() != Some(key.as_str()) {
            let root = PathBuf::from(&path);
            let remote = git::read_remote(&root);
            if remote.is_repo {
                let exists: bool = conn.query_row(
                    "SELECT EXISTS (SELECT 1 FROM project_repositories WHERE project_id = ?1 AND folder_key = ?2)",
                    params![project_id, key],
                    |r| r.get(0),
                )?;
                if !exists {
                    // Attach to a remote-only link of the same GitHub repository, if any.
                    let same: Option<String> = match &remote.github {
                        Some(g) => conn
                            .query_row(
                                "SELECT id FROM project_repositories WHERE project_id = ?1 AND lower(github) = lower(?2) AND local_path IS NULL",
                                params![project_id, g],
                                |r| r.get(0),
                            )
                            .optional()?,
                        None => None,
                    };
                    match same {
                        Some(id) => {
                            conn.execute(
                                "UPDATE project_repositories SET local_path = ?1, folder_key = ?2, updated_at = ?3 WHERE id = ?4",
                                params![path, key, now_ms(), id],
                            )?;
                        }
                        None => {
                            insert(conn, project_id, Some(&root), remote.github.as_deref())?;
                        }
                    }
                }
            }
            conn.execute("UPDATE projects SET repo_adopted_key = ?1 WHERE id = ?2", params![key, project_id])?;
        }
    }
    if let Some(full) = connected {
        let exists: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM project_repositories WHERE project_id = ?1 AND lower(github) = lower(?2))",
            params![project_id, full],
            |r| r.get(0),
        )?;
        if !exists {
            insert(conn, project_id, None, Some(&full))?;
        }
    }
    Ok(())
}

pub fn list(conn: &Connection, project_id: &str) -> AppResult<Vec<Repository>> {
    adopt(conn, project_id)?;
    let mut stmt = conn.prepare(&format!("{SELECT} WHERE r.project_id = ?1 ORDER BY r.is_primary DESC, r.sort_order, r.created_at"))?;
    let rows = stmt.query_map([project_id], map)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Links a local git repository (with the user's trust decision for that
/// exact folder). Its GitHub origin, if any, is recorded too.
pub fn link_local(conn: &Connection, project_id: &str, path: &str, trust: Trust) -> AppResult<Repository> {
    let exists: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM projects WHERE id = ?1)", [project_id], |r| r.get(0))?;
    if !exists {
        return Err(AppError::NotFound("Project".into()));
    }
    let canon = folders::canonical(Path::new(path.trim()))?;
    if !canon.is_dir() {
        return invalid("Choose a folder rather than a file.");
    }
    let remote = git::read_remote(&canon);
    if !remote.is_repo {
        return invalid("That folder isn't a git repository. Link it as the project folder instead, or initialise git there first.");
    }
    let key = folders::folder_key(&canon);
    let dup: Option<String> = conn
        .query_row("SELECT id FROM project_repositories WHERE project_id = ?1 AND folder_key = ?2", params![project_id, key], |r| r.get(0))
        .optional()?;
    if dup.is_some() {
        return invalid("That repository is already linked to this project.");
    }
    folders::set_trust(conn, &canon, trust)?;
    // Fill in a remote-only link of the same GitHub repository instead of duplicating it.
    let same: Option<String> = match &remote.github {
        Some(g) => conn
            .query_row(
                "SELECT id FROM project_repositories WHERE project_id = ?1 AND lower(github) = lower(?2) AND local_path IS NULL",
                params![project_id, g],
                |r| r.get(0),
            )
            .optional()?,
        None => None,
    };
    let id = match same {
        Some(id) => {
            conn.execute(
                "UPDATE project_repositories SET local_path = ?1, folder_key = ?2, updated_at = ?3 WHERE id = ?4",
                params![canon.to_string_lossy(), key, now_ms(), id],
            )?;
            id
        }
        None => {
            let github = remote.github.as_deref().filter(|g| {
                !conn
                    .query_row(
                        "SELECT EXISTS (SELECT 1 FROM project_repositories WHERE project_id = ?1 AND lower(github) = lower(?2))",
                        params![project_id, g],
                        |r| r.get::<_, bool>(0),
                    )
                    .unwrap_or(false)
            });
            insert(conn, project_id, Some(&canon), github)?
        }
    };
    crate::domain::activity::log(conn, Some(project_id), "project", project_id, "linked", &last_segment(&canon.to_string_lossy()))?;
    get(conn, &id)
}

/// Links a GitHub repository without a local copy (or fills in the GitHub
/// side of a local link whose origin matches).
pub fn link_github(conn: &Connection, project_id: &str, full: &str) -> AppResult<Repository> {
    let slug = git::github_slug(&format!("https://github.com/{}", full.trim())).ok_or_else(|| AppError::Invalid("Use the owner/name form, e.g. octocat/hello-world.".into()))?;
    if let Some(id) = conn
        .query_row("SELECT id FROM project_repositories WHERE project_id = ?1 AND lower(github) = lower(?2)", params![project_id, slug], |r| r.get::<_, String>(0))
        .optional()?
    {
        return get(conn, &id);
    }
    let id = insert(conn, project_id, None, Some(&slug))?;
    get(conn, &id)
}

/// Removes the link only. Files on disk and the GitHub repository are untouched.
pub fn unlink(conn: &Connection, id: &str) -> AppResult<()> {
    let r = get(conn, id)?;
    conn.execute("DELETE FROM project_repositories WHERE id = ?1", [id])?;
    if r.is_primary {
        conn.execute(
            "UPDATE project_repositories SET is_primary = 1 WHERE id = (SELECT id FROM project_repositories WHERE project_id = ?1 ORDER BY sort_order LIMIT 1)",
            [&r.project_id],
        )?;
    }
    Ok(())
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoPatch {
    #[serde(deserialize_with = "crate::util::some")]
    pub alias: Option<Option<String>>,
    pub primary: Option<bool>,
    pub sort_order: Option<f64>,
}

pub fn update(conn: &Connection, id: &str, p: &RepoPatch) -> AppResult<Repository> {
    let r = get(conn, id)?;
    let now = now_ms();
    if let Some(a) = &p.alias {
        let a = a.as_deref().map(str::trim).filter(|s| !s.is_empty());
        conn.execute("UPDATE project_repositories SET alias = ?1, updated_at = ?2 WHERE id = ?3", params![a, now, id])?;
    }
    if p.primary == Some(true) {
        conn.execute("UPDATE project_repositories SET is_primary = (id = ?1), updated_at = ?2 WHERE project_id = ?3", params![id, now, r.project_id])?;
    }
    if let Some(s) = p.sort_order {
        conn.execute("UPDATE project_repositories SET sort_order = ?1 WHERE id = ?2", params![s, id])?;
    }
    get(conn, id)
}

/// The repository's canonical local root and its trust, re-verified on every call.
pub fn local_root(conn: &Connection, id: &str) -> AppResult<(PathBuf, Trust)> {
    let (path, key): (Option<String>, Option<String>) = conn
        .query_row("SELECT local_path, folder_key FROM project_repositories WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or_else(|| AppError::NotFound("Repository".into()))?;
    let (Some(path), Some(key)) = (path, key) else {
        return invalid("This repository has no local copy on this computer. Clone it or link a local folder first.");
    };
    let canon = folders::canonical(Path::new(&path)).map_err(|_| AppError::NotFound(format!("The repository folder '{path}'")))?;
    let trust = if folders::folder_key(&canon) == key { folders::trust_of(conn, &key)?.unwrap_or(Trust::Restricted) } else { Trust::Restricted };
    Ok((canon, trust))
}

pub fn trusted_root(state: &AppState, id: &str) -> AppResult<PathBuf> {
    let (root, trust) = state.with(|c| local_root(c, id))?;
    if trust != Trust::Trusted {
        return invalid(git::TRUST_NEEDED);
    }
    Ok(root)
}

/// The primary repository of a project, if it has any.
pub fn primary(conn: &Connection, project_id: &str) -> AppResult<Option<Repository>> {
    Ok(list(conn, project_id)?.into_iter().next())
}

// ------------------------------------------------------------ summary

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub repository_id: String,
    pub available: bool,
    /// Why details are missing (restricted, missing folder, remote only…).
    pub reason: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub changed: usize,
    pub untracked: usize,
    pub conflicted: usize,
    pub last_commit: Option<git::Commit>,
}

pub fn summary_of(state: &AppState, id: &str) -> AppResult<RepoSummary> {
    let mut out = RepoSummary { repository_id: id.to_string(), ..Default::default() };
    let (root, trust) = match state.with(|c| local_root(c, id)) {
        Ok(v) => v,
        Err(e) => {
            out.reason = Some(e.to_string());
            return Ok(out);
        }
    };
    if trust != Trust::Trusted {
        out.reason = Some("Restricted folder: trust it to see its git status.".into());
        return Ok(out);
    }
    let st = git::status_of(&root)?;
    out.available = true;
    out.branch = st.branch.clone();
    out.detached = st.detached;
    out.upstream = st.upstream.clone();
    out.ahead = st.ahead;
    out.behind = st.behind;
    out.untracked = st.files.iter().filter(|f| f.untracked).count();
    out.conflicted = st.files.iter().filter(|f| f.conflicted).count();
    out.changed = st.files.len() - out.untracked;
    out.last_commit = git::log_of(&root, 1, false, None, None).ok().and_then(|v| v.into_iter().next());
    Ok(out)
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub async fn repos_list(app: AppHandle, project_id: String) -> AppResult<Vec<Repository>> {
    blocking(&app, move |s| s.with(|c| list(c, &project_id))).await
}

#[tauri::command]
pub async fn repo_link_local(app: AppHandle, project_id: String, path: String, trust: Trust) -> AppResult<Repository> {
    blocking(&app, move |s| {
        s.with(|c| {
            let tx = c.transaction()?;
            let r = link_local(&tx, &project_id, &path, trust)?;
            tx.commit()?;
            Ok(r)
        })
    })
    .await
}

#[tauri::command]
pub fn repo_link_github(state: tauri::State<AppState>, project_id: String, repo: String) -> AppResult<Repository> {
    state.with(|c| link_github(c, &project_id, &repo))
}

#[tauri::command]
pub fn repo_unlink(state: tauri::State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        unlink(&tx, &id)?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn repo_update(state: tauri::State<AppState>, id: String, patch: RepoPatch) -> AppResult<Repository> {
    state.with(|c| update(c, &id, &patch))
}

#[tauri::command]
pub async fn repo_set_trust(app: AppHandle, id: String, trust: Trust) -> AppResult<Repository> {
    blocking(&app, move |s| {
        s.with(|c| {
            let (root, _) = local_root(c, &id)?;
            folders::set_trust(c, &root, trust)?;
            get(c, &id)
        })
    })
    .await
}

#[tauri::command]
pub async fn repo_summary(app: AppHandle, id: String) -> AppResult<RepoSummary> {
    blocking(&app, move |s| summary_of(s, &id)).await
}

#[tauri::command]
pub async fn repo_reveal(app: AppHandle, id: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let handle = app.clone();
    blocking(&app, move |s| {
        let (root, _) = s.with(|c| local_root(c, &id))?;
        handle.opener().reveal_item_in_dir(root).map_err(|e| AppError::Other(e.to_string()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::projects::{create_project, ProjectInput};

    fn project(c: &Connection) -> String {
        create_project(c, &ProjectInput { name: "Reactor".into(), ..Default::default() }).unwrap().id
    }

    fn fake_repo(dir: &Path, origin: &str) {
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git/config"), format!("[remote \"origin\"]\n\turl = {origin}\n")).unwrap();
    }

    #[test]
    fn projects_need_no_repository() {
        let c = open_memory();
        let pid = project(&c);
        assert!(list(&c, &pid).unwrap().is_empty());
        assert!(primary(&c, &pid).unwrap().is_none());
    }

    #[test]
    fn links_several_repositories_and_keeps_one_primary() {
        let c = open_memory();
        let pid = project(&c);
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        fake_repo(a.path(), "git@github.com:acme/frontend.git");
        fake_repo(b.path(), "https://github.com/acme/backend");
        let ra = link_local(&c, &pid, &a.path().to_string_lossy(), Trust::Trusted).unwrap();
        let rb = link_local(&c, &pid, &b.path().to_string_lossy(), Trust::Restricted).unwrap();
        let gh = link_github(&c, &pid, "acme/docs").unwrap();
        assert!(ra.is_primary && !rb.is_primary && !gh.is_primary);
        assert_eq!(ra.github.as_deref(), Some("acme/frontend"));
        assert_eq!(gh.local_status, "none");
        assert_eq!(list(&c, &pid).unwrap().len(), 3);
        update(&c, &rb.id, &RepoPatch { primary: Some(true), ..Default::default() }).unwrap();
        assert!(get(&c, &rb.id).unwrap().is_primary && !get(&c, &ra.id).unwrap().is_primary);
        // Unlinking the primary promotes another; the folder stays on disk.
        unlink(&c, &rb.id).unwrap();
        assert!(b.path().join(".git/config").exists());
        assert_eq!(list(&c, &pid).unwrap().iter().filter(|r| r.is_primary).count(), 1);
        assert!(link_local(&c, &pid, &a.path().to_string_lossy(), Trust::Trusted).is_err(), "no duplicates");
    }

    #[test]
    fn local_link_fills_in_a_remote_only_link() {
        let c = open_memory();
        let pid = project(&c);
        let gh = link_github(&c, &pid, "acme/reactor").unwrap();
        let dir = tempfile::tempdir().unwrap();
        fake_repo(dir.path(), "git@github.com:acme/reactor.git");
        let r = link_local(&c, &pid, &dir.path().to_string_lossy(), Trust::Trusted).unwrap();
        assert_eq!(r.id, gh.id);
        assert_eq!(list(&c, &pid).unwrap().len(), 1);
    }

    #[test]
    fn adopts_the_project_folder_once() {
        let c = open_memory();
        let pid = project(&c);
        let dir = tempfile::tempdir().unwrap();
        fake_repo(dir.path(), "git@github.com:acme/reactor.git");
        folders::link(&c, &pid, &dir.path().to_string_lossy(), Trust::Trusted).unwrap();
        let repos = list(&c, &pid).unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].trust, Some(Trust::Trusted));
        unlink(&c, &repos[0].id).unwrap();
        assert!(list(&c, &pid).unwrap().is_empty(), "an unlinked adopted repository stays unlinked");
    }

    #[test]
    fn remote_only_repositories_explain_missing_local_tools() {
        let c = open_memory();
        let pid = project(&c);
        let gh = link_github(&c, &pid, "acme/docs").unwrap();
        let err = local_root(&c, &gh.id).unwrap_err().to_string();
        assert!(err.contains("no local copy"));
    }
}
