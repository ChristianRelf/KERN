// @Author Christian Relf
// @Date 2026-10-12

//! Git tools for a project's repositories.
//!
//! Commands run the system `git` with an argument list (never a shell), no
//! terminal prompts and a timeout. Git can execute code configured by the
//! repository itself (hooks, fsmonitor, filters), so every git command needs
//! a *trusted* folder. Reading the remote from `.git/config` and scanning
//! for TODO comments don't execute anything and also work in restricted mode.
//!
//! Repository commands take a repository id (see `repos`), so a project can
//! have several; nothing here is ever destructive (no reset, clean or force).

use crate::domain::folders::{self, is_sensitive};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

// ------------------------------------------------------------ runner

pub fn command(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash
    }
    c
}

/// Runs a program with a timeout, returning (success, stdout, stderr).
pub fn run(mut cmd: Command, timeout: Duration, max_out: usize) -> AppResult<(bool, String, String)> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::Invalid("Git isn't installed (or isn't on PATH).".into()),
        _ => AppError::Io(e),
    })?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out_t = std::thread::spawn(move || {
        let mut buf = vec![];
        let _ = (&mut stdout).take((max_out + 1) as u64).read_to_end(&mut buf);
        // Drain the rest so the child never blocks on a full pipe.
        let _ = std::io::copy(&mut stdout, &mut std::io::sink());
        buf
    });
    let err_t = std::thread::spawn(move || {
        let mut buf = vec![];
        let _ = (&mut stderr).take(64 * 1024).read_to_end(&mut buf);
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        buf
    });
    let start = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::Other("The git command took too long and was stopped.".into()));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut out = out_t.join().unwrap_or_default();
    let truncated = out.len() > max_out;
    out.truncate(max_out);
    let mut out = String::from_utf8_lossy(&out).to_string();
    if truncated {
        out.push_str("\n… (output truncated)");
    }
    Ok((status.success(), out, String::from_utf8_lossy(&err_t.join().unwrap_or_default()).trim().to_string()))
}

pub fn git_cmd(root: &Path, args: &[&str]) -> Command {
    let mut c = command("git");
    c.arg("-c").arg("core.quotepath=off").arg("-c").arg("color.ui=false").args(args).current_dir(root);
    c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0").env("LC_ALL", "C");
    c
}

pub fn git(root: &Path, args: &[&str], timeout_secs: u64) -> AppResult<String> {
    let (ok, out, err) = run(git_cmd(root, args), Duration::from_secs(timeout_secs), 4 * 1024 * 1024)?;
    if !ok {
        let msg = err.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("git failed").trim_start_matches("fatal: ").trim_start_matches("error: ");
        return Err(AppError::Invalid(format!("Git: {msg}")));
    }
    Ok(out)
}

/// A repository's local root, which must be trusted for git commands.
fn trusted_root(state: &AppState, repo_id: &str) -> AppResult<PathBuf> {
    crate::domain::repos::trusted_root(state, repo_id)
}

pub const TRUST_NEEDED: &str = "Git tools need a trusted folder, because a repository can run its own scripts through git. Trust the folder first.";

pub async fn blocking<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&AppState) -> AppResult<T> + Send + 'static) -> AppResult<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>()))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

// ------------------------------------------------------------ remote (no exec)

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub is_repo: bool,
    pub origin_url: Option<String>,
    /// owner/name when origin is on github.com.
    pub github: Option<String>,
}

/// Parses owner/name from a GitHub remote URL (https or ssh forms).
pub fn github_slug(url: &str) -> Option<String> {
    let u = url.trim();
    let rest = u
        .strip_prefix("https://github.com/")
        .or_else(|| u.strip_prefix("http://github.com/"))
        .or_else(|| u.strip_prefix("git@github.com:"))
        .or_else(|| u.strip_prefix("ssh://git@github.com/"))
        .or_else(|| u.strip_prefix("git://github.com/"))
        .or_else(|| u.split_once('@').and_then(|(_, r)| r.strip_prefix("github.com/")))?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = rest.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    (ok(owner) && ok(name) && parts.next().is_none()).then(|| format!("{owner}/{name}"))
}

/// Reads `origin` from the repository config file without running git.
pub fn read_remote(root: &Path) -> RemoteInfo {
    let dot = root.join(".git");
    let git_dir = if dot.is_dir() {
        Some(dot)
    } else if dot.is_file() {
        // Worktrees/submodules: ".git" holds "gitdir: <path>".
        std::fs::read_to_string(&dot)
            .ok()
            .and_then(|s| s.strip_prefix("gitdir:").map(|p| root.join(p.trim())))
    } else {
        None
    };
    let Some(git_dir) = git_dir else { return RemoteInfo { is_repo: false, origin_url: None, github: None } };
    let config = std::fs::read_to_string(git_dir.join("config"))
        .or_else(|_| std::fs::read_to_string(git_dir.join("commondir")).map(|c| git_dir.join(c.trim())).and_then(|d| std::fs::read_to_string(d.join("config"))))
        .unwrap_or_default();
    let mut in_origin = false;
    let mut origin = None;
    for line in config.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_origin = l.replace(' ', "").eq_ignore_ascii_case("[remote\"origin\"]");
        } else if in_origin {
            if let Some((k, v)) = l.split_once('=') {
                if k.trim().eq_ignore_ascii_case("url") {
                    origin = Some(v.trim().to_string());
                }
            }
        }
    }
    RemoteInfo { is_repo: true, github: origin.as_deref().and_then(github_slug), origin_url: origin }
}

/// The checked-out branch, read from HEAD without running git (works in
/// restricted folders). A detached HEAD gives its short hash.
pub fn read_head(root: &Path) -> Option<String> {
    let dot = root.join(".git");
    let git_dir = if dot.is_dir() {
        dot
    } else {
        let s = std::fs::read_to_string(&dot).ok()?;
        root.join(s.strip_prefix("gitdir:")?.trim())
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    match head.strip_prefix("ref:") {
        Some(r) => Some(r.trim().trim_start_matches("refs/heads/").to_string()),
        None => Some(head.chars().take(7).collect()),
    }
}

#[tauri::command]
pub async fn git_remote(app: AppHandle, project_id: String) -> AppResult<RemoteInfo> {
    blocking(&app, move |s| {
        let (root, _) = s.with(|c| folders::root_of(c, &project_id))?;
        Ok(read_remote(&root))
    })
    .await
}

// ------------------------------------------------------------ status

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Two-letter XY code from git (index, worktree); "??" untracked.
    pub code: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflicted: bool,
    pub renamed_from: Option<String>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub files: Vec<ChangedFile>,
}

/// Parses `git status --porcelain=v2 --branch -z`.
pub fn parse_status(raw: &str) -> GitStatus {
    let mut st = GitStatus::default();
    let mut entries = raw.split('\0').peekable();
    while let Some(e) = entries.next() {
        if e.is_empty() {
            continue;
        }
        if let Some(h) = e.strip_prefix("# ") {
            if let Some(b) = h.strip_prefix("branch.head ") {
                st.detached = b == "(detached)";
                st.branch = (!st.detached).then(|| b.to_string());
            } else if let Some(u) = h.strip_prefix("branch.upstream ") {
                st.upstream = Some(u.to_string());
            } else if let Some(ab) = h.strip_prefix("branch.ab ") {
                let mut p = ab.split_whitespace();
                st.ahead = p.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
                st.behind = p.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
            }
            continue;
        }
        let kind = e.chars().next().unwrap_or(' ');
        let file = |code: &str, path: &str, from: Option<String>| ChangedFile {
            path: path.to_string(),
            code: code.to_string(),
            staged: code.as_bytes()[0] != b'.' && code != "??",
            unstaged: code.as_bytes().get(1).is_some_and(|c| *c != b'.') || code == "??",
            untracked: code == "??",
            conflicted: kind == 'u',
            renamed_from: from,
        };
        match kind {
            '1' => {
                let f: Vec<&str> = e.splitn(9, ' ').collect();
                if f.len() == 9 {
                    st.files.push(file(f[1], f[8], None));
                }
            }
            '2' => {
                let f: Vec<&str> = e.splitn(10, ' ').collect();
                let orig = entries.next().map(String::from);
                if f.len() == 10 {
                    st.files.push(file(f[1], f[9], orig));
                }
            }
            'u' => {
                let f: Vec<&str> = e.splitn(11, ' ').collect();
                if f.len() == 11 {
                    st.files.push(file(f[1], f[10], None));
                }
            }
            '?' => st.files.push(file("??", &e[2..], None)),
            _ => {}
        }
    }
    st
}

pub fn status_of(root: &Path) -> AppResult<GitStatus> {
    Ok(parse_status(&git(root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], 30)?))
}

#[tauri::command]
pub async fn git_status(app: AppHandle, repo_id: String) -> AppResult<GitStatus> {
    blocking(&app, move |s| status_of(&trusted_root(s, &repo_id)?)).await
}

pub fn safe_rel(rel: &str) -> AppResult<()> {
    if rel.is_empty() || rel.starts_with('-') || Path::new(rel).components().any(|c| !matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir)) {
        return invalid("That path isn't inside the repository.");
    }
    Ok(())
}

#[tauri::command]
pub async fn git_diff(app: AppHandle, repo_id: String, path: String, staged: bool, untracked: bool) -> AppResult<String> {
    blocking(&app, move |s| {
        safe_rel(&path)?;
        let root = trusted_root(s, &repo_id)?;
        if untracked {
            // New file: show its start as an addition (text only, size-capped).
            let full = folders::resolve_inside(&root, &path)?;
            let meta = std::fs::metadata(&full)?;
            if meta.len() > 512 * 1024 {
                return Ok(format!("New file ({} KB) - too large to preview.", meta.len() / 1024));
            }
            let bytes = std::fs::read(&full)?;
            if bytes.iter().take(4096).any(|b| *b == 0) {
                return Ok("New binary file.".into());
            }
            return Ok(String::from_utf8_lossy(&bytes).lines().take(400).map(|l| format!("+{l}\n")).collect());
        }
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--unified=3"];
        if staged {
            args.push("--cached");
        }
        args.extend(["--", path.as_str()]);
        git(&root, &args, 30)
    })
    .await
}

// ------------------------------------------------------------ history & branches

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    /// Parent hashes, first parent first (empty for a root commit).
    pub parents: Vec<String>,
    /// Branches and tags pointing here, as git decorates them
    /// in full ("HEAD -> refs/heads/main", "refs/remotes/origin/main",
    /// "tag: refs/tags/v1.0").
    pub refs: Vec<String>,
}

pub fn parse_log(raw: &str) -> Vec<Commit> {
    raw.split('\u{1e}')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_matches('\n').split('\u{1f}').collect();
            (f.len() == 7).then(|| Commit {
                hash: f[0].into(),
                short: f[1].into(),
                author: f[2].into(),
                date: f[3].into(),
                parents: f[4].split_whitespace().map(String::from).collect(),
                refs: f[5].split(", ").map(str::trim).filter(|r| !r.is_empty()).map(String::from).collect(),
                subject: f[6].into(),
            })
        })
        .collect()
}

const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%D%x1f%s%x1e";

/// Commits in `range` (or HEAD), newest first. `all` includes every branch.
pub fn log_of(root: &Path, limit: u32, all: bool, range: Option<&str>, since: Option<&str>) -> AppResult<Vec<Commit>> {
    let n = format!("--max-count={}", limit.clamp(1, 500));
    let since_arg = since.map(|s| format!("--since={s}"));
    // Topological order keeps each branch's commits together, which is
    // what the history graph needs to draw tidy lanes.
    let mut args = vec!["log", n.as_str(), "--topo-order", "--decorate=full", "--date=iso-strict", LOG_FORMAT];
    if let Some(s) = &since_arg {
        args.push(s.as_str());
    }
    if all {
        args.push("--all");
    }
    if let Some(r) = range {
        if r.starts_with('-') {
            return invalid("That isn't a valid revision range.");
        }
        args.push(r);
        args.push("--");
    }
    // A brand-new repository has no commits yet.
    match git(root, &args, 30) {
        Ok(o) => Ok(parse_log(&o)),
        Err(e) if e.to_string().contains("does not have any commits") || e.to_string().contains("unknown revision") => Ok(vec![]),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn git_log(app: AppHandle, repo_id: String, limit: Option<u32>, all: Option<bool>, range: Option<String>) -> AppResult<Vec<Commit>> {
    blocking(&app, move |s| {
        let root = trusted_root(s, &repo_id)?;
        log_of(&root, limit.unwrap_or(50), all.unwrap_or(false), range.as_deref(), None)
    })
    .await
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    pub short_hash: String,
    pub date: String,
}

pub fn branches_of(root: &Path) -> AppResult<Vec<Branch>> {
        let out = git(
            &root,
            &["for-each-ref", "--sort=-committerdate", "--format=%(HEAD)%1f%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(objectname:short)%1f%(committerdate:iso-strict)", "refs/heads", "refs/remotes"],
            30,
        )?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\u{1f}').collect();
                if f.len() != 6 || f[1].ends_with("/HEAD") {
                    return None;
                }
                Some(Branch {
                    current: f[0] == "*",
                    remote: f[1].starts_with("refs/remotes/"),
                    name: f[2].into(),
                    upstream: (!f[3].is_empty()).then(|| f[3].to_string()),
                    short_hash: f[4].into(),
                    date: f[5].into(),
                })
            })
            .collect())
}

#[tauri::command]
pub async fn git_branches(app: AppHandle, repo_id: String) -> AppResult<Vec<Branch>> {
    blocking(&app, move |s| branches_of(&trusted_root(s, &repo_id)?)).await
}

pub fn valid_branch(root: &Path, name: &str) -> AppResult<()> {
    if name.starts_with('-') || name.trim().is_empty() {
        return invalid("That isn't a valid branch name.");
    }
    git(root, &["check-ref-format", "--branch", name], 10).map(|_| ()).map_err(|_| AppError::Invalid("That isn't a valid branch name.".into()))
}

/// Switches to a branch (creating it when asked). Git refuses if local
/// changes would be overwritten, and that message is passed on.
#[tauri::command]
pub async fn git_switch(app: AppHandle, repo_id: String, name: String, create: bool) -> AppResult<()> {
    blocking(&app, move |s| {
        let root = trusted_root(s, &repo_id)?;
        valid_branch(&root, &name)?;
        let local = name.split_once('/').filter(|(r, _)| *r == "origin").map(|(_, b)| b.to_string());
        if create {
            git(&root, &["switch", "-c", &name], 60)?;
        } else if let Some(b) = local {
            // Remote branch: track it locally.
            git(&root, &["switch", "--track", "-c", &b, &name], 60).or_else(|_| git(&root, &["switch", &b], 60))?;
        } else {
            git(&root, &["switch", &name], 60)?;
        }
        Ok(())
    })
    .await
}

pub fn branch_exists(root: &Path, name: &str) -> bool {
    git(root, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")], 10).is_ok()
}

/// Verifies `rev` names a commit (branch, tag or hash).
pub fn valid_commitish(root: &Path, rev: &str) -> AppResult<()> {
    if rev.starts_with('-') || rev.trim().is_empty() {
        return invalid("That isn't a valid branch or commit.");
    }
    git(root, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")], 10)
        .map(|_| ())
        .map_err(|_| AppError::Invalid(format!("'{rev}' isn't a branch or commit in this repository.")))
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchCheck {
    pub valid: bool,
    pub exists: bool,
    pub message: Option<String>,
}

/// Checks a proposed branch name against git's rules and existing branches.
#[tauri::command]
pub async fn git_branch_check(app: AppHandle, repo_id: String, name: String) -> AppResult<BranchCheck> {
    blocking(&app, move |s| {
        let root = trusted_root(s, &repo_id)?;
        Ok(match valid_branch(&root, &name) {
            Err(e) => BranchCheck { valid: false, exists: false, message: Some(e.to_string()) },
            Ok(()) => {
                let exists = branch_exists(&root, &name);
                BranchCheck { valid: true, exists, message: exists.then(|| "A branch with that name already exists.".to_string()) }
            }
        })
    })
    .await
}

/// Creates a branch from `base` (default: HEAD) without touching the
/// working tree unless `switch` is set. Never overwrites an existing branch.
pub fn create_branch(root: &Path, name: &str, base: Option<&str>, switch: bool) -> AppResult<()> {
    valid_branch(root, name)?;
    if branch_exists(root, name) {
        return invalid(&format!("A branch named {name} already exists."));
    }
    if let Some(b) = base {
        valid_commitish(root, b)?;
    }
    let base = base.unwrap_or("HEAD");
    if switch {
        // git refuses (and explains) if local changes would be overwritten.
        git(root, &["switch", "-c", name, base], 60)?;
    } else {
        git(root, &["branch", "--no-track", name, base], 30)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_create_branch(app: AppHandle, repo_id: String, name: String, base: Option<String>, switch: bool) -> AppResult<()> {
    blocking(&app, move |s| create_branch(&trusted_root(s, &repo_id)?, name.trim(), base.as_deref().filter(|b| !b.is_empty()), switch)).await
}

/// Lowercase slug for branch names: "Fix login bug!" → "fix-login-bug".
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    out.trim_end_matches('-').to_string()
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteResult {
    pub output: String,
}

/// fetch | pull (fast-forward only) | push (sets upstream on first push).
#[tauri::command]
pub async fn git_sync(app: AppHandle, repo_id: String, action: String) -> AppResult<RemoteResult> {
    blocking(&app, move |s| {
        let network: bool = s.with(|c| Ok(crate::domain::settings::get_or(c, "privacy.network", true)))?;
        if !network {
            return invalid("External network requests are turned off in Privacy settings.");
        }
        let root = trusted_root(s, &repo_id)?;
        let (ok, out, err) = match action.as_str() {
            "fetch" => run(git_cmd(&root, &["fetch", "--prune"]), Duration::from_secs(180), 256 * 1024)?,
            "pull" => run(git_cmd(&root, &["pull", "--ff-only"]), Duration::from_secs(180), 256 * 1024)?,
            "push" => {
                let st = parse_status(&git(&root, &["status", "--porcelain=v2", "--branch", "-z"], 30)?);
                if st.detached {
                    return invalid("Switch to a branch before pushing.");
                }
                if st.upstream.is_some() {
                    run(git_cmd(&root, &["push"]), Duration::from_secs(180), 256 * 1024)?
                } else {
                    run(git_cmd(&root, &["push", "-u", "origin", "HEAD"]), Duration::from_secs(180), 256 * 1024)?
                }
            }
            _ => return invalid("Unknown git action."),
        };
        if !ok {
            let msg = err.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("git failed").to_string();
            let hint = if msg.contains("Not possible to fast-forward") || msg.contains("diverged") {
                " Your branch and the remote have both changed; merge or rebase in your git tool."
            } else if msg.contains("Authentication") || msg.contains("could not read Username") {
                " Git couldn't authenticate. Sign in with your git credential manager or the GitHub CLI."
            } else {
                ""
            };
            return Err(AppError::Invalid(format!("Git: {}{hint}", msg.trim_start_matches("fatal: ").trim_start_matches("error: "))));
        }
        Ok(RemoteResult { output: format!("{out}\n{err}").trim().to_string() })
    })
    .await
}

/// Clones a GitHub repository into `<parent>/<name>`. The caller links the
/// new folder afterwards (with its own trust decision).
#[tauri::command]
pub async fn git_clone(app: AppHandle, repo: String, parent: String) -> AppResult<String> {
    blocking(&app, move |s| {
        let network: bool = s.with(|c| Ok(crate::domain::settings::get_or(c, "privacy.network", true)))?;
        if !network {
            return invalid("External network requests are turned off in Privacy settings.");
        }
        let slug = github_slug(&format!("https://github.com/{repo}")).ok_or_else(|| AppError::Invalid("That isn't a GitHub repository.".into()))?;
        let name = slug.split('/').nth(1).unwrap_or("repo").to_string();
        let parent = folders::canonical(Path::new(&parent))?;
        let dest = parent.join(&name);
        if dest.exists() {
            return invalid(&format!("A folder named {name} already exists there."));
        }
        let url = format!("https://github.com/{slug}.git");
        let mut c = command("git");
        c.args(["clone", "--", &url]).arg(&dest).current_dir(&parent).env("GIT_TERMINAL_PROMPT", "0");
        let (ok, _, err) = run(c, Duration::from_secs(900), 64 * 1024)?;
        if !ok {
            let _ = std::fs::remove_dir_all(&dest);
            return Err(AppError::Invalid(format!("Git: {}", err.lines().last().unwrap_or("clone failed").trim_start_matches("fatal: "))));
        }
        Ok(dest.to_string_lossy().to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_available(app: AppHandle) -> AppResult<Option<String>> {
    blocking(&app, |_| {
        let mut c = command("git");
        c.arg("--version");
        Ok(run(c, Duration::from_secs(10), 1024).ok().filter(|(ok, _, _)| *ok).map(|(_, o, _)| o.trim().to_string()))
    })
    .await
}

// ------------------------------------------------------------ TODO scan (no exec)

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub path: String,
    pub line: usize,
    pub kind: String,
    pub text: String,
}

pub const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", "out", ".next", ".nuxt", "vendor", "__pycache__", ".venv", "venv", "coverage", ".idea", ".vscode", "bin", "obj"];

/// Finds TODO / FIXME / HACK / XXX comments. Reads text files only (no
/// binaries, nothing over 512 KB, no files that look like secrets).
pub fn scan_todos(root: &Path, limit: usize) -> Vec<TodoItem> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    let mut files_seen = 0;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(meta) = std::fs::symlink_metadata(e.path()) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                    stack.push(e.path());
                }
                continue;
            }
            files_seen += 1;
            if files_seen > 20_000 || out.len() >= limit {
                return out;
            }
            if meta.len() > 512 * 1024 || is_sensitive(&name) || name.ends_with(".min.js") || name.ends_with(".lock") || name == "package-lock.json" {
                continue;
            }
            let Ok(bytes) = std::fs::read(e.path()) else { continue };
            if bytes.iter().take(4096).any(|b| *b == 0) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            let rel = e.path().strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            for (i, line) in text.lines().enumerate() {
                for kind in ["TODO", "FIXME", "HACK", "XXX"] {
                    if let Some(pos) = line.find(kind) {
                        // Only a marker that opens a comment counts ("// TODO: …",
                        // "# FIXME(x) …"), not prose that mentions the word.
                        let before = line[..pos].trim_end();
                        let opens_comment = ["//", "#", "/*", "*", "--", "<!--", ";", "'", "%", "{-", "\"\"\"", "REM"].iter().any(|m| before.ends_with(m));
                        let after = line[pos + kind.len()..].chars().next();
                        let word = opens_comment && after.map_or(true, |c| matches!(c, ':' | '(' | ' ' | '!' | '-'));
                        if word {
                            let rest = line[pos + kind.len()..].trim_start_matches(|c: char| c == ':' || c == ' ' || c == '-' || c == '!');
                            let rest = rest.split_once(')').filter(|_| rest.starts_with('(')).map(|(_, r)| r.trim_start_matches([':', ' '])).unwrap_or(rest);
                            let text = rest.trim().trim_end_matches("*/").trim_end_matches("-->").trim().chars().take(200).collect::<String>();
                            if text.chars().next().is_some_and(|c| c.is_alphanumeric() || c == '`' || c == '"') {
                                out.push(TodoItem { path: rel.clone(), line: i + 1, kind: kind.into(), text });
                            }
                            break;
                        }
                    }
                }
                if out.len() >= limit {
                    return out;
                }
            }
        }
    }
    out
}

#[tauri::command]
pub async fn project_scan_todos(app: AppHandle, project_id: String) -> AppResult<Vec<TodoItem>> {
    blocking(&app, move |s| {
        let (root, _) = s.with(|c| folders::root_of(c, &project_id))?;
        Ok(scan_todos(&root, 500))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_parents_and_refs() {
        let raw = "a1\u{1f}a\u{1f}Ann\u{1f}2026-01-02T00:00:00Z\u{1f}b2 c3\u{1f}HEAD -> main, origin/main, tag: v1\u{1f}Merge x\u{1e}\n\
                   b2\u{1f}b\u{1f}Ann\u{1f}2026-01-01T00:00:00Z\u{1f}\u{1f}\u{1f}Root\u{1e}\n";
        let log = parse_log(raw);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].parents, vec!["b2", "c3"]);
        assert_eq!(log[0].refs, vec!["HEAD -> main", "origin/main", "tag: v1"]);
        assert_eq!(log[0].subject, "Merge x");
        assert!(log[1].parents.is_empty() && log[1].refs.is_empty());
    }

    #[test]
    fn github_slugs() {
        assert_eq!(github_slug("https://github.com/Owner/repo.git").as_deref(), Some("Owner/repo"));
        assert_eq!(github_slug("git@github.com:owner/my-repo.git").as_deref(), Some("owner/my-repo"));
        assert_eq!(github_slug("https://token@github.com/o/r").as_deref(), Some("o/r"));
        assert_eq!(github_slug("https://gitlab.com/o/r"), None);
        assert_eq!(github_slug("https://github.com/o/r/tree/main"), None);
    }

    #[test]
    fn reads_remote_without_git() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/config"), "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = git@github.com:acme/reactor.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n").unwrap();
        let r = read_remote(dir.path());
        assert!(r.is_repo);
        assert_eq!(r.github.as_deref(), Some("acme/reactor"));
        assert!(!read_remote(tempfile::tempdir().unwrap().path()).is_repo);
    }

    #[test]
    fn parses_porcelain_v2() {
        let raw = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\01 .M N... 100644 100644 100644 a b src/app.ts\01 A. N... 0 100644 100644 a b new.rs\02 R. N... 100644 100644 100644 a b R100 renamed.md\0old.md\0? notes.txt\0";
        let s = parse_status(raw);
        assert_eq!((s.branch.as_deref(), s.upstream.as_deref(), s.ahead, s.behind), (Some("main"), Some("origin/main"), 2, 1));
        assert_eq!(s.files.len(), 4);
        assert!(s.files[0].unstaged && !s.files[0].staged);
        assert!(s.files[1].staged);
        assert_eq!(s.files[2].renamed_from.as_deref(), Some("old.md"));
        assert!(s.files[3].untracked);
    }

    #[test]
    fn finds_todos_but_skips_secrets_and_vendor() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/x")).unwrap();
        std::fs::write(
            dir.path().join("src/main.rs"),
            "//! Docs that mention TODO comments aren't tasks.\n/// Scans TODO / FIXME markers.\nfn main() {\n    // TODO: handle errors\n    // FIXME(chris): flaky\n    let todo_list = 1; // not a TODOS marker\n}\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("node_modules/x/i.js"), "// TODO vendor").unwrap();
        std::fs::write(dir.path().join(".env"), "# TODO rotate key").unwrap();
        let t = scan_todos(dir.path(), 100);
        assert_eq!(t.len(), 2);
        assert_eq!((t[0].path.as_str(), t[0].line, t[0].text.as_str()), ("src/main.rs", 4, "handle errors"));
        assert_eq!((t[1].kind.as_str(), t[1].text.as_str()), ("FIXME", "flaky"));
    }

    #[test]
    fn slugs_branch_names() {
        assert_eq!(slug("Fix login bug!"), "fix-login-bug");
        assert_eq!(slug("  Call   supplier - today "), "call-supplier-today");
    }

    #[test]
    fn rejects_unsafe_diff_paths() {
        assert!(safe_rel("src/a.rs").is_ok());
        assert!(safe_rel("../etc/passwd").is_err());
        assert!(safe_rel("--output=x").is_err());
    }
}
