// @Author Christian Relf
// @Date 2026-10-12

//! Git worktrees for a repository. The list always comes from git itself
//! (`git worktree list`), including worktrees Kern didn't create; Kern only
//! keeps an alias and associations (task, agent label) alongside.
//!
//! Safety: removal checks the worktree's real status first. A worktree with
//! uncommitted or untracked files is only removed with an explicit `force`
//! the user confirmed after seeing what's affected; locked worktrees are
//! never removed; a branch is only deleted with `git branch -d`, which
//! refuses unmerged work. Kern never runs clean, reset or force-delete.

use crate::domain::folders::{self, Trust};
use crate::domain::git::{self, blocking, slug};
use crate::domain::repos;
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RawWorktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
}

/// Parses `git worktree list --porcelain`.
pub fn parse_list(raw: &str) -> Vec<RawWorktree> {
    let mut out = vec![];
    let mut cur: Option<RawWorktree> = None;
    for line in raw.lines() {
        if line.is_empty() {
            if let Some(w) = cur.take() {
                out.push(w);
            }
            continue;
        }
        let (k, v) = line.split_once(' ').unwrap_or((line, ""));
        match k {
            "worktree" => {
                if let Some(w) = cur.take() {
                    out.push(w);
                }
                cur = Some(RawWorktree { path: v.to_string(), ..Default::default() });
            }
            _ => {
                let Some(w) = cur.as_mut() else { continue };
                match k {
                    "HEAD" => w.head = Some(v.to_string()),
                    "branch" => w.branch = Some(v.trim_start_matches("refs/heads/").to_string()),
                    "detached" => w.detached = true,
                    "bare" => w.bare = true,
                    "locked" => w.locked = Some(v.to_string()),
                    "prunable" => w.prunable = Some(v.to_string()),
                    _ => {}
                }
            }
        }
    }
    if let Some(w) = cur {
        out.push(w);
    }
    out
}

fn key_of(path: &str) -> String {
    match folders::canonical(Path::new(path)) {
        Ok(c) => folders::folder_key(&c),
        Err(_) => folders::folder_key(Path::new(&path.replace('/', std::path::MAIN_SEPARATOR_STR))),
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub repository_id: String,
    /// Kern's metadata row, if any.
    pub id: Option<String>,
    pub path: String,
    pub name: String,
    pub alias: Option<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    /// The repository's main working tree (can't be removed).
    pub is_main: bool,
    pub locked: Option<String>,
    /// The folder is gone; git can prune the entry.
    pub prunable: bool,
    pub task_id: Option<String>,
    pub task_title: Option<String>,
    pub agent: Option<String>,
    pub created_by_kern: bool,
    pub trust: Option<Trust>,
    /// Status counts (None when unavailable).
    pub changed: Option<usize>,
    pub untracked: Option<usize>,
    pub ahead: Option<i64>,
    pub behind: Option<i64>,
    pub last_activity: Option<i64>,
}

struct Meta {
    id: String,
    alias: Option<String>,
    task_id: Option<String>,
    task_title: Option<String>,
    agent: Option<String>,
    created_by_kern: bool,
}

fn meta_for(conn: &Connection, repo_id: &str, key: &str) -> AppResult<Option<Meta>> {
    Ok(conn
        .query_row(
            "SELECT w.id, w.alias, w.task_id, (SELECT title FROM tasks t WHERE t.id = w.task_id AND t.deleted_at IS NULL), w.agent, w.created_by_kern
             FROM git_worktrees w WHERE w.repository_id = ?1 AND w.folder_key = ?2",
            params![repo_id, key],
            |r| Ok(Meta { id: r.get(0)?, alias: r.get(1)?, task_id: r.get(2)?, task_title: r.get(3)?, agent: r.get(4)?, created_by_kern: r.get::<_, i64>(5)? != 0 }),
        )
        .optional()?)
}

fn modified_ms(p: &Path) -> Option<i64> {
    std::fs::metadata(p).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

pub fn list(state: &AppState, repo_id: &str, with_status: bool) -> AppResult<Vec<Worktree>> {
    let root = repos::trusted_root(state, repo_id)?;
    let raw = parse_list(&git::git(&root, &["worktree", "list", "--porcelain"], 30)?);
    let mut out = vec![];
    for (i, w) in raw.into_iter().enumerate() {
        if w.bare {
            continue;
        }
        let key = key_of(&w.path);
        let native = PathBuf::from(w.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let (meta, trust) = state.with(|c| Ok((meta_for(c, repo_id, &key)?, folders::trust_of(c, &key)?)))?;
        let mut wt = Worktree {
            repository_id: repo_id.to_string(),
            id: meta.as_ref().map(|m| m.id.clone()),
            name: meta.as_ref().and_then(|m| m.alias.clone()).unwrap_or_else(|| native.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| w.path.clone())),
            alias: meta.as_ref().and_then(|m| m.alias.clone()),
            path: native.to_string_lossy().to_string(),
            branch: w.branch.clone(),
            head: w.head.clone(),
            detached: w.detached,
            // git always lists the main working tree first.
            is_main: i == 0,
            locked: w.locked.clone(),
            prunable: w.prunable.is_some() || !native.is_dir(),
            task_id: meta.as_ref().and_then(|m| m.task_id.clone()),
            task_title: meta.as_ref().and_then(|m| m.task_title.clone()),
            agent: meta.as_ref().and_then(|m| m.agent.clone()),
            created_by_kern: meta.as_ref().map(|m| m.created_by_kern).unwrap_or(false),
            // The main worktree shares the repository's trust decision.
            trust: if i == 0 { Some(Trust::Trusted) } else { trust },
            changed: None,
            untracked: None,
            ahead: None,
            behind: None,
            last_activity: modified_ms(&native.join(".git")).or_else(|| modified_ms(&native)),
        };
        if with_status && !wt.prunable && out.len() < 40 {
            if let Ok(st) = git::status_of(&native) {
                let untracked = st.files.iter().filter(|f| f.untracked).count();
                wt.untracked = Some(untracked);
                wt.changed = Some(st.files.len() - untracked);
                wt.ahead = Some(st.ahead);
                wt.behind = Some(st.behind);
            }
        }
        out.push(wt);
    }
    Ok(out)
}

/// `<parent>/<repo>.worktrees/<branch-slug>`, the default for new worktrees.
pub fn default_path(root: &Path, branch: &str) -> PathBuf {
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "repo".into());
    let parent = root.parent().unwrap_or(root);
    let leaf = slug(branch.rsplit('/').next().unwrap_or(branch));
    parent.join(format!("{name}.worktrees")).join(if leaf.is_empty() { "worktree".into() } else { leaf })
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CreateInput {
    pub repository_id: String,
    pub branch: String,
    /// Create `branch` (from `base`) rather than checking out an existing one.
    pub new_branch: bool,
    pub base: Option<String>,
    pub path: Option<String>,
    pub task_id: Option<String>,
    pub alias: Option<String>,
    /// Record the new folder as trusted (it shares the repository's config).
    pub trust: bool,
}

pub fn create(state: &AppState, input: &CreateInput) -> AppResult<Worktree> {
    let root = repos::trusted_root(state, &input.repository_id)?;
    let branch = input.branch.trim();
    git::valid_branch(&root, branch)?;
    let exists = git::branch_exists(&root, branch);
    if input.new_branch && exists {
        return invalid(&format!("A branch named {branch} already exists. Use it instead, or choose another name."));
    }
    if !input.new_branch && !exists {
        return invalid(&format!("There's no branch named {branch}."));
    }
    if let Some(b) = input.base.as_deref().filter(|b| !b.is_empty()) {
        git::valid_commitish(&root, b)?;
    }
    let dest = match input.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => default_path(&root, branch),
    };
    if !dest.is_absolute() {
        return invalid("Choose a full folder path for the worktree.");
    }
    if dest.exists() && std::fs::read_dir(&dest).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return invalid("That folder already exists and isn't empty. Choose another location.");
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let dest_s = dest.to_string_lossy().to_string();
    let mut args: Vec<&str> = vec!["worktree", "add"];
    if input.new_branch {
        args.extend(["-b", branch, "--", dest_s.as_str()]);
        if let Some(b) = input.base.as_deref().filter(|b| !b.is_empty()) {
            args.push(b);
        }
    } else {
        args.extend(["--", dest_s.as_str(), branch]);
    }
    git::git(&root, &args, 120)?;
    let canon = folders::canonical(&dest)?;
    let key = folders::folder_key(&canon);
    state.with(|c| {
        let tx = c.transaction()?;
        let now = now_ms();
        let id = new_id();
        tx.execute(
            "INSERT INTO git_worktrees(id, repository_id, path, folder_key, alias, task_id, created_by_kern, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)
             ON CONFLICT(repository_id, folder_key) DO UPDATE SET path = excluded.path, task_id = excluded.task_id, updated_at = excluded.updated_at",
            params![id, input.repository_id, canon.to_string_lossy(), key, input.alias.as_deref().filter(|a| !a.trim().is_empty()), input.task_id, now],
        )?;
        if input.trust {
            folders::set_trust(&tx, &canon, Trust::Trusted)?;
        }
        if let Some(t) = &input.task_id {
            crate::domain::workflow::add_link(&tx, t, "worktree", Some(&input.repository_id), &canon.to_string_lossy(), Some(branch), None)?;
            crate::domain::workflow::add_link(&tx, t, "branch", Some(&input.repository_id), branch, None, None)?;
        }
        tx.commit()?;
        Ok(())
    })?;
    list(state, &input.repository_id, false)?
        .into_iter()
        .find(|w| key_of(&w.path) == key)
        .ok_or_else(|| AppError::Other("The worktree was created but git doesn't list it.".into()))
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub path: String,
    pub exists: bool,
    pub is_main: bool,
    pub locked: Option<String>,
    pub branch: Option<String>,
    pub modified: Vec<String>,
    pub untracked: Vec<String>,
    pub modified_count: usize,
    pub untracked_count: usize,
    /// Commits on the branch that no remote has (lost if the branch is deleted).
    pub unpushed: Option<i64>,
    /// The branch is merged into the repository's current HEAD branch.
    pub merged: Option<bool>,
    /// A Kern terminal or work session uses this folder.
    pub in_use: Vec<String>,
}

fn find(state: &AppState, repo_id: &str, path: &str) -> AppResult<(PathBuf, RawWorktree, bool)> {
    let root = repos::trusted_root(state, repo_id)?;
    let raw = parse_list(&git::git(&root, &["worktree", "list", "--porcelain"], 30)?);
    let key = key_of(path);
    let idx = raw.iter().position(|w| key_of(&w.path) == key).ok_or_else(|| AppError::NotFound("That worktree".into()))?;
    Ok((root, raw[idx].clone(), idx == 0))
}

pub fn inspect(state: &AppState, repo_id: &str, path: &str) -> AppResult<Inspection> {
    let (root, w, is_main) = find(state, repo_id, path)?;
    let native = PathBuf::from(w.path.replace('/', std::path::MAIN_SEPARATOR_STR));
    let mut out = Inspection { path: native.to_string_lossy().to_string(), exists: native.is_dir(), is_main, locked: w.locked.clone(), branch: w.branch.clone(), ..Default::default() };
    if out.exists {
        let st = git::status_of(&native)?;
        for f in &st.files {
            if f.untracked {
                out.untracked_count += 1;
                if out.untracked.len() < 25 {
                    out.untracked.push(f.path.clone());
                }
            } else {
                out.modified_count += 1;
                if out.modified.len() < 25 {
                    out.modified.push(f.path.clone());
                }
            }
        }
    }
    if let Some(b) = &w.branch {
        out.unpushed = git::git(&root, &["rev-list", "--count", &format!("refs/heads/{b}"), "--not", "--remotes"], 30).ok().and_then(|s| s.trim().parse().ok());
        out.merged = git::git(&root, &["merge-base", "--is-ancestor", &format!("refs/heads/{b}"), "HEAD"], 30).map(|_| true).ok().or(Some(false));
    }
    let key = key_of(path);
    out.in_use = state.pty.users_of(&key);
    Ok(out)
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub removed: bool,
    pub branch_deleted: bool,
    /// Why the branch was kept, if deletion was requested.
    pub branch_note: Option<String>,
}

pub fn remove(state: &AppState, repo_id: &str, path: &str, force: bool, delete_branch: bool) -> AppResult<RemoveResult> {
    let info = inspect(state, repo_id, path)?;
    if info.is_main {
        return invalid("The repository's main working tree can't be removed.");
    }
    if info.locked.is_some() {
        return invalid("This worktree is locked. Unlock it with git first if you really want to remove it.");
    }
    if !info.in_use.is_empty() {
        return invalid(&format!("This worktree is in use ({}). Close it first.", info.in_use.join(", ")));
    }
    let dirty = info.modified_count + info.untracked_count > 0;
    if dirty && !force {
        return Err(AppError::Invalid(format!(
            "The worktree has {} changed and {} untracked file(s). Removing it would discard them.",
            info.modified_count, info.untracked_count
        )));
    }
    let root = repos::trusted_root(state, repo_id)?;
    let mut args = vec!["worktree", "remove"];
    if dirty {
        args.push("--force");
    }
    args.push("--");
    args.push(&info.path);
    git::git(&root, &args, 120)?;
    let key = key_of(path);
    state.with(|c| {
        c.execute("DELETE FROM task_dev_links WHERE kind = 'worktree' AND repository_id = ?1 AND ref = ?2", params![repo_id, info.path])?;
        c.execute("DELETE FROM git_worktrees WHERE repository_id = ?1 AND folder_key = ?2", params![repo_id, key])?;
        Ok(())
    })?;
    let mut res = RemoveResult { removed: true, ..Default::default() };
    if delete_branch {
        if let Some(b) = &info.branch {
            // -d refuses to delete unmerged work; that refusal is reported, not overridden.
            match git::git(&root, &["branch", "-d", "--", b], 30) {
                Ok(_) => res.branch_deleted = true,
                Err(e) => res.branch_note = Some(format!("The branch {b} was kept: {}", e.to_string().trim_start_matches("Git: "))),
            }
        }
    }
    Ok(res)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WorktreePatch {
    #[serde(deserialize_with = "crate::util::some")]
    pub alias: Option<Option<String>>,
    #[serde(deserialize_with = "crate::util::some")]
    pub task_id: Option<Option<String>>,
    #[serde(deserialize_with = "crate::util::some")]
    pub agent: Option<Option<String>>,
}

/// Records metadata for any worktree (including ones Kern didn't create).
pub fn update(state: &AppState, repo_id: &str, path: &str, p: &WorktreePatch) -> AppResult<()> {
    let (_, w, _) = find(state, repo_id, path)?;
    let native = w.path.replace('/', std::path::MAIN_SEPARATOR_STR);
    let key = key_of(path);
    state.with(|c| {
        let tx = c.transaction()?;
        let now = now_ms();
        tx.execute(
            "INSERT INTO git_worktrees(id, repository_id, path, folder_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(repository_id, folder_key) DO NOTHING",
            params![new_id(), repo_id, native, key, now],
        )?;
        let clean = |v: &Option<String>| v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        if let Some(a) = &p.alias {
            tx.execute("UPDATE git_worktrees SET alias = ?1, updated_at = ?2 WHERE repository_id = ?3 AND folder_key = ?4", params![clean(a), now, repo_id, key])?;
        }
        if let Some(a) = &p.agent {
            tx.execute("UPDATE git_worktrees SET agent = ?1, updated_at = ?2 WHERE repository_id = ?3 AND folder_key = ?4", params![clean(a), now, repo_id, key])?;
        }
        if let Some(t) = &p.task_id {
            let prev: Option<String> =
                tx.query_row("SELECT task_id FROM git_worktrees WHERE repository_id = ?1 AND folder_key = ?2", params![repo_id, key], |r| r.get(0))?;
            if let Some(old) = prev {
                tx.execute("DELETE FROM task_dev_links WHERE task_id = ?1 AND kind = 'worktree' AND repository_id = ?2 AND ref = ?3", params![old, repo_id, native])?;
            }
            tx.execute("UPDATE git_worktrees SET task_id = ?1, updated_at = ?2 WHERE repository_id = ?3 AND folder_key = ?4", params![t, now, repo_id, key])?;
            if let Some(task) = t {
                crate::domain::workflow::add_link(&tx, task, "worktree", Some(repo_id), &native, w.branch.as_deref(), None)?;
            }
        }
        tx.commit()?;
        Ok(())
    })
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub async fn worktrees_list(app: AppHandle, repository_id: String, with_status: Option<bool>) -> AppResult<Vec<Worktree>> {
    blocking(&app, move |s| list(s, &repository_id, with_status.unwrap_or(true))).await
}

#[tauri::command]
pub async fn worktree_default_path(app: AppHandle, repository_id: String, branch: String) -> AppResult<String> {
    blocking(&app, move |s| Ok(default_path(&repos::trusted_root(s, &repository_id)?, &branch).to_string_lossy().to_string())).await
}

#[tauri::command]
pub async fn worktree_create(app: AppHandle, input: CreateInput) -> AppResult<Worktree> {
    blocking(&app, move |s| create(s, &input)).await
}

#[tauri::command]
pub async fn worktree_inspect(app: AppHandle, repository_id: String, path: String) -> AppResult<Inspection> {
    blocking(&app, move |s| inspect(s, &repository_id, &path)).await
}

#[tauri::command]
pub async fn worktree_remove(app: AppHandle, repository_id: String, path: String, force: bool, delete_branch: bool) -> AppResult<RemoveResult> {
    blocking(&app, move |s| remove(s, &repository_id, &path, force, delete_branch)).await
}

#[tauri::command]
pub async fn worktree_update(app: AppHandle, repository_id: String, path: String, patch: WorktreePatch) -> AppResult<()> {
    blocking(&app, move |s| update(s, &repository_id, &path, &patch)).await
}

/// Removes git's records of worktrees whose folders no longer exist. It
/// never deletes files.
#[tauri::command]
pub async fn worktrees_prune(app: AppHandle, repository_id: String) -> AppResult<()> {
    blocking(&app, move |s| {
        let root = repos::trusted_root(s, &repository_id)?;
        git::git(&root, &["worktree", "prune"], 60).map(|_| ())
    })
    .await
}

/// Opens a folder (repository or worktree) in the configured external
/// editor, or the system file manager when none is set.
#[tauri::command]
pub async fn open_in_editor(app: AppHandle, path: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let handle = app.clone();
    blocking(&app, move |s| {
        let canon = folders::canonical(Path::new(&path))?;
        if !canon.is_dir() {
            return invalid("That folder isn't available.");
        }
        let editor: String = s.with(|c| Ok(crate::domain::settings::get_or(c, "dev.editor", String::new())))?;
        let editor = editor.trim().to_string();
        if editor.is_empty() {
            return handle.opener().open_path(canon.to_string_lossy(), None::<&str>).map_err(|e| AppError::Other(e.to_string()));
        }
        let mut c = git::command(&editor);
        c.arg(&canon).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        c.spawn().map(|_| ()).map_err(|e| AppError::Invalid(format!("Couldn't start “{editor}” ({e}). Check the editor in Settings → Projects.")))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_porcelain() {
        let raw = "worktree C:/src/reactor\nHEAD 1111\nbranch refs/heads/main\n\nworktree C:/src/reactor.worktrees/cooling\nHEAD 2222\nbranch refs/heads/feature/cooling\nlocked busy\n\nworktree C:/tmp/gone\nHEAD 3333\ndetached\nprunable gitdir file points to non-existent location\n\n";
        let w = parse_list(raw);
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].branch.as_deref(), Some("main"));
        assert_eq!(w[1].branch.as_deref(), Some("feature/cooling"));
        assert_eq!(w[1].locked.as_deref(), Some("busy"));
        assert!(w[2].detached && w[2].prunable.is_some());
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").args(args).current_dir(dir).env("GIT_TERMINAL_PROMPT", "0").status().map(|s| s.success()).unwrap_or(false);
        assert!(ok, "git {args:?} failed");
    }

    /// Uses the real git CLI: create, inspect and safely remove a worktree.
    #[test]
    fn worktree_lifecycle_never_discards_work_silently() {
        if git::command("git").arg("--version").output().is_err() {
            return; // git isn't installed on this machine
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("reactor");
        std::fs::create_dir(&repo).unwrap();
        run_git(&repo, &["init", "-q", "-b", "main"]);
        run_git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        let paths = crate::state::Paths::new(tmp.path().join("data"));
        let state = AppState::new(crate::db::open_memory(), paths);
        let pid = state
            .with(|c| crate::domain::projects::create_project(c, &crate::domain::projects::ProjectInput { name: "Reactor".into(), ..Default::default() }))
            .unwrap()
            .id;
        let rid = state.with(|c| repos::link_local(c, &pid, &repo.to_string_lossy(), Trust::Trusted)).unwrap().id;
        let wt = create(&state, &CreateInput { repository_id: rid.clone(), branch: "feature/cooling".into(), new_branch: true, trust: true, ..Default::default() }).unwrap();
        assert_eq!(wt.branch.as_deref(), Some("feature/cooling"));
        assert!(wt.created_by_kern && !wt.is_main);
        assert_eq!(list(&state, &rid, true).unwrap().len(), 2);
        // The same branch can't be created twice.
        assert!(create(&state, &CreateInput { repository_id: rid.clone(), branch: "feature/cooling".into(), new_branch: true, ..Default::default() }).is_err());
        // Uncommitted work blocks removal unless explicitly forced.
        std::fs::write(Path::new(&wt.path).join("notes.txt"), "keep me").unwrap();
        let info = inspect(&state, &rid, &wt.path).unwrap();
        assert_eq!(info.untracked_count, 1);
        assert!(remove(&state, &rid, &wt.path, false, false).is_err());
        assert!(Path::new(&wt.path).join("notes.txt").exists());
        // The main working tree is never removable.
        assert!(remove(&state, &rid, &repo.to_string_lossy(), true, false).is_err());
        let res = remove(&state, &rid, &wt.path, true, true).unwrap();
        assert!(res.removed && res.branch_deleted, "an already-merged branch may be deleted with -d");
        assert_eq!(list(&state, &rid, false).unwrap().len(), 1);
    }

    #[test]
    fn default_paths_sit_beside_the_repository() {
        let root = Path::new("/src/reactor");
        let p = default_path(root, "feature/Reactor Cooling");
        assert!(p.ends_with("reactor.worktrees/reactor-cooling"));
    }
}
