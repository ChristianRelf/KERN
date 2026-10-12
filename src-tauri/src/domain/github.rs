//! GitHub integration: connect a project to a repository, keep its issues
//! and Kern tasks in sync in both directions, and show pull requests.
//!
//! Authentication uses the GitHub CLI's own login when available (`gh auth
//! token`, its documented way to hand a token to other tools) or a token
//! stored in the OS credential store. The token is used by the backend only
//! and never reaches the interface, the database or logs.
//!
//! Sync is a three-way merge per issue. Each link stores the title, body,
//! state and labels as they were at the last sync (the base). A field changed
//! only on GitHub is applied to the task, one changed only in Kern is pushed,
//! and when both changed the more recent edit wins. Deleting a task never
//! closes or deletes its issue; the link is kept as "ignored" so the issue
//! isn't imported again.

use crate::domain::ai::vault::Secret;
use crate::domain::git;
use crate::domain::settings;
use crate::domain::tasks::{self, TaskInput, TaskPatch};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const TOKEN_REF: &str = "github-token";

// ------------------------------------------------------------ auth

fn cli_token() -> Option<Secret> {
    let mut c = git::command("gh");
    c.args(["auth", "token", "--hostname", "github.com"]);
    let (ok, out, _) = git::run(c, Duration::from_secs(10), 4096).ok()?;
    let t = out.trim();
    (ok && !t.is_empty() && !t.contains(char::is_whitespace)).then(|| Secret::new(t.to_string()))
}

/// The token to use, and where it came from ("cli" | "token").
fn token(state: &AppState) -> AppResult<(Secret, &'static str)> {
    let mode: String = state.with(|c| Ok(settings::get_or(c, "github.auth", "auto".to_string())))?;
    if mode != "token" {
        if let Some(t) = cli_token() {
            return Ok((t, "cli"));
        }
        if mode == "cli" {
            return invalid("The GitHub CLI isn't signed in. Run `gh auth login`, or use a token instead.");
        }
    }
    match state.ai.vault.get(TOKEN_REF)? {
        Some(t) => Ok((t, "token")),
        None => invalid("Connect GitHub first: sign in with the GitHub CLI or add a token in Settings → Integrations."),
    }
}

// ------------------------------------------------------------ REST client

struct Gh {
    token: Secret,
    agent: ureq::Agent,
}

struct Resp {
    link_next: Option<String>,
    body: Value,
}

impl Gh {
    fn new(state: &AppState) -> AppResult<Gh> {
        let network: bool = state.with(|c| Ok(settings::get_or(c, "privacy.network", true)))?;
        if !network {
            return invalid("External network requests are turned off in Privacy settings.");
        }
        let (token, _) = token(state)?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .http_status_as_error(false)
            .user_agent("Kern")
            .build()
            .into();
        Ok(Gh { token, agent })
    }

    fn call(&self, method: &str, url: &str, body: Option<&Value>) -> AppResult<Resp> {
        let url = if url.starts_with("https://") { url.to_string() } else { format!("https://api.github.com{url}") };
        if !url.starts_with("https://api.github.com/") {
            return invalid("Unexpected GitHub address.");
        }
        let auth = format!("Bearer {}", self.token.expose());
        let res = match (method, body) {
            ("GET", _) => self.agent.get(&url).header("Authorization", &auth).header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28").call(),
            (m, b) => {
                let req = match m {
                    "POST" => self.agent.post(&url),
                    _ => self.agent.patch(&url),
                };
                req.header("Authorization", &auth)
                    .header("Accept", "application/vnd.github+json")
                    .header("X-GitHub-Api-Version", "2022-11-28")
                    .header("Content-Type", "application/json")
                    .send(b.map(|v| v.to_string()).unwrap_or_default())
            }
        };
        let mut resp = res.map_err(|e| AppError::Network(format!("Couldn't reach GitHub ({e}).")))?;
        let status = resp.status().as_u16();
        let header = |k: &str| resp.headers().get(k).and_then(|v| v.to_str().ok()).map(String::from);
        let link_next = header("link").and_then(|l| {
            l.split(',').find(|p| p.contains("rel=\"next\"")).and_then(|p| p.split(';').next()).map(|u| u.trim().trim_start_matches('<').trim_end_matches('>').to_string())
        });
        let remaining = header("x-ratelimit-remaining");
        let reset = header("x-ratelimit-reset").and_then(|r| r.parse::<i64>().ok());
        let text = resp.body_mut().with_config().limit(16 * 1024 * 1024).read_to_string().unwrap_or_default();
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if status >= 400 {
            let msg = body.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string();
            return Err(match status {
                401 => AppError::Invalid("GitHub rejected the sign-in. Sign in again with the GitHub CLI or replace the token.".into()),
                403 | 429 if remaining.as_deref() == Some("0") || msg.to_lowercase().contains("rate limit") => {
                    let when = reset.and_then(|r| chrono::DateTime::from_timestamp(r, 0)).map(|d| d.with_timezone(&chrono::Local).format("%H:%M").to_string()).unwrap_or_default();
                    AppError::Network(format!("GitHub's rate limit is used up. It resets at {when}."))
                }
                403 => AppError::Invalid(format!("GitHub refused access: {msg}. The token may be missing a permission (Issues: read and write, Pull requests: read).")),
                404 => AppError::NotFound("The repository (or you don't have access to it)".into()),
                410 => AppError::Invalid("Issues are turned off for this repository.".into()),
                _ => AppError::Network(format!("GitHub returned {status}: {msg}")),
            });
        }
        Ok(Resp { link_next, body })
    }

    fn get(&self, path: &str) -> AppResult<Value> {
        Ok(self.call("GET", path, None)?.body)
    }

    /// Follows pagination up to `max_pages`.
    fn get_all(&self, path: &str, max_pages: usize) -> AppResult<Vec<Value>> {
        let mut out = vec![];
        let mut next = Some(path.to_string());
        let mut pages = 0;
        while let Some(url) = next.take() {
            let r = self.call("GET", &url, None)?;
            if let Some(a) = r.body.as_array() {
                out.extend(a.iter().cloned());
            }
            pages += 1;
            if pages < max_pages {
                next = r.link_next;
            }
        }
        Ok(out)
    }
}

async fn blocking<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&AppState) -> AppResult<T> + Send + 'static) -> AppResult<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>()))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

// ------------------------------------------------------------ account

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub connected: bool,
    pub login: Option<String>,
    pub source: Option<String>,
    pub cli_installed: bool,
    pub cli_signed_in: bool,
    pub has_token: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn github_status(app: AppHandle) -> AppResult<GithubStatus> {
    blocking(&app, |s| {
        let mut c = git::command("gh");
        c.arg("--version");
        let cli_installed = git::run(c, Duration::from_secs(10), 1024).map(|(ok, _, _)| ok).unwrap_or(false);
        let cli_signed_in = cli_installed && cli_token().is_some();
        let has_token = s.ai.vault.get(TOKEN_REF)?.is_some();
        let (mut st, gh) = match Gh::new(s) {
            Ok(gh) => (GithubStatus { connected: false, login: None, source: None, cli_installed, cli_signed_in, has_token, error: None }, Some(gh)),
            Err(e) => (GithubStatus { connected: false, login: None, source: None, cli_installed, cli_signed_in, has_token, error: Some(e.to_string()) }, None),
        };
        if let Some(gh) = gh {
            match gh.get("/user") {
                Ok(u) => {
                    st.connected = true;
                    st.login = u.get("login").and_then(|l| l.as_str()).map(String::from);
                    st.source = token(s).ok().map(|(_, src)| src.to_string());
                }
                Err(e) => st.error = Some(e.to_string()),
            }
        }
        Ok(st)
    })
    .await
}

/// Stores a token after checking it with GitHub.
#[tauri::command]
pub async fn github_set_token(app: AppHandle, token: String) -> AppResult<String> {
    blocking(&app, move |s| {
        let t = token.trim().to_string();
        if t.is_empty() || t.contains(char::is_whitespace) {
            return invalid("Paste a GitHub token.");
        }
        let gh = Gh { token: Secret::new(t.clone()), agent: ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(20))).http_status_as_error(false).user_agent("Kern").build().into() };
        let user = gh.get("/user")?;
        s.ai.vault.set(TOKEN_REF, &Secret::new(t))?;
        Ok(user.get("login").and_then(|l| l.as_str()).unwrap_or("").to_string())
    })
    .await
}

#[tauri::command]
pub async fn github_clear_token(app: AppHandle) -> AppResult<()> {
    blocking(&app, |s| s.ai.vault.delete(TOKEN_REF)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub full_name: String,
    pub description: Option<String>,
    pub private: bool,
    pub default_branch: Option<String>,
    pub html_url: String,
    pub open_issues: i64,
    pub updated_at: Option<String>,
}

fn repo_summary(v: &Value) -> Option<RepoSummary> {
    Some(RepoSummary {
        full_name: v.get("full_name")?.as_str()?.to_string(),
        description: v.get("description").and_then(|d| d.as_str()).map(String::from),
        private: v.get("private").and_then(|p| p.as_bool()).unwrap_or(false),
        default_branch: v.get("default_branch").and_then(|d| d.as_str()).map(String::from),
        html_url: v.get("html_url").and_then(|d| d.as_str()).unwrap_or("").to_string(),
        open_issues: v.get("open_issues_count").and_then(|d| d.as_i64()).unwrap_or(0),
        updated_at: v.get("pushed_at").and_then(|d| d.as_str()).map(String::from),
    })
}

#[tauri::command]
pub async fn github_repos(app: AppHandle) -> AppResult<Vec<RepoSummary>> {
    blocking(&app, |s| {
        let gh = Gh::new(s)?;
        let list = gh.get_all("/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member", 5)?;
        Ok(list.iter().filter_map(repo_summary).collect())
    })
    .await
}

// ------------------------------------------------------------ connection

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepo {
    pub project_id: String,
    pub owner: String,
    pub name: String,
    pub full_name: String,
    pub default_branch: Option<String>,
    pub html_url: Option<String>,
    pub sync_issues: bool,
    pub import_closed: bool,
    pub last_synced_at: Option<i64>,
    pub last_sync_error: Option<String>,
    pub linked_issues: i64,
}

pub fn project_repo(conn: &Connection, project_id: &str) -> AppResult<Option<ProjectRepo>> {
    Ok(conn
        .query_row(
            "SELECT project_id, owner, name, default_branch, html_url, sync_issues, import_closed, last_synced_at, last_sync_error,
               (SELECT count(*) FROM task_issue_links l WHERE l.project_id = r.project_id AND l.task_id IS NOT NULL)
             FROM project_repos r WHERE project_id = ?1",
            [project_id],
            |r| {
                let owner: String = r.get(1)?;
                let name: String = r.get(2)?;
                Ok(ProjectRepo {
                    project_id: r.get(0)?,
                    full_name: format!("{owner}/{name}"),
                    owner,
                    name,
                    default_branch: r.get(3)?,
                    html_url: r.get(4)?,
                    sync_issues: r.get::<_, i64>(5)? != 0,
                    import_closed: r.get::<_, i64>(6)? != 0,
                    last_synced_at: r.get(7)?,
                    last_sync_error: r.get(8)?,
                    linked_issues: r.get(9)?,
                })
            },
        )
        .optional()?)
}

#[tauri::command]
pub fn github_project(state: tauri::State<AppState>, project_id: String) -> AppResult<Option<ProjectRepo>> {
    state.with(|c| project_repo(c, &project_id))
}

#[tauri::command]
pub async fn github_connect(app: AppHandle, project_id: String, repo: String, import_closed: Option<bool>) -> AppResult<ProjectRepo> {
    blocking(&app, move |s| {
        let slug = git::github_slug(&format!("https://github.com/{}", repo.trim())).ok_or_else(|| AppError::Invalid("Use the owner/name form, e.g. octocat/hello-world.".into()))?;
        let gh = Gh::new(s)?;
        let info = gh.get(&format!("/repos/{slug}"))?;
        let full = info.get("full_name").and_then(|f| f.as_str()).unwrap_or(&slug).to_string();
        let (owner, name) = full.split_once('/').unwrap_or(("", ""));
        s.with(|c| {
            let taken: Option<String> = c
                .query_row("SELECT p.name FROM project_repos r JOIN projects p ON p.id = r.project_id WHERE lower(r.owner) = lower(?1) AND lower(r.name) = lower(?2) AND r.project_id != ?3", params![owner, name, project_id], |r| r.get(0))
                .optional()?;
            if let Some(p) = taken {
                return invalid(&format!("{full} is already connected to the project “{p}”."));
            }
            c.execute(
                "INSERT INTO project_repos(project_id, owner, name, default_branch, html_url, import_closed, connected_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(project_id) DO UPDATE SET owner = excluded.owner, name = excluded.name, default_branch = excluded.default_branch,
                   html_url = excluded.html_url, import_closed = excluded.import_closed, last_synced_at = NULL, last_sync_error = NULL",
                params![
                    project_id,
                    owner,
                    name,
                    info.get("default_branch").and_then(|d| d.as_str()),
                    info.get("html_url").and_then(|d| d.as_str()),
                    import_closed.unwrap_or(false) as i64,
                    now_ms()
                ],
            )?;
            crate::domain::activity::log(c, Some(&project_id), "project", &project_id, "connected", &full)?;
            project_repo(c, &project_id)?.ok_or_else(|| AppError::Other("Connection vanished".into()))
        })
    })
    .await
}

/// Disconnects the repository. Tasks stay as ordinary tasks; nothing on
/// GitHub changes.
#[tauri::command]
pub fn github_disconnect(state: tauri::State<AppState>, project_id: String) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        tx.execute("DELETE FROM task_issue_links WHERE project_id = ?1", [&project_id])?;
        tx.execute("DELETE FROM project_repos WHERE project_id = ?1", [&project_id])?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn github_update_connection(state: tauri::State<AppState>, project_id: String, sync_issues: Option<bool>, import_closed: Option<bool>) -> AppResult<()> {
    state.with(|c| {
        if let Some(v) = sync_issues {
            c.execute("UPDATE project_repos SET sync_issues = ?1 WHERE project_id = ?2", params![v as i64, project_id])?;
        }
        if let Some(v) = import_closed {
            c.execute("UPDATE project_repos SET import_closed = ?1, last_synced_at = NULL WHERE project_id = ?2", params![v as i64, project_id])?;
        }
        Ok(())
    })
}

// ------------------------------------------------------------ merge

#[derive(Debug, Clone, PartialEq, Default)]
pub struct IssueFields {
    pub title: String,
    pub body: String,
    /// open | closed
    pub state: String,
    pub labels: BTreeSet<String>,
}

#[derive(Debug, Default, PartialEq)]
pub struct Merge {
    pub result: IssueFields,
    pub pull: bool,
    pub push: bool,
}

/// Three-way merge of one issue. `local_newer` decides fields edited on both
/// sides since the last sync.
pub fn merge(base: &IssueFields, local: &IssueFields, remote: &IssueFields, local_newer: bool) -> Merge {
    fn pick<T: Clone + PartialEq>(b: &T, l: &T, r: &T, local_newer: bool) -> (T, bool, bool) {
        let (lc, rc) = (l != b, r != b);
        match (lc, rc) {
            (false, false) => (l.clone(), false, false),
            (true, false) => (l.clone(), false, true),
            (false, true) => (r.clone(), true, false),
            _ if l == r => (l.clone(), false, false),
            _ if local_newer => (l.clone(), false, true),
            _ => (r.clone(), true, false),
        }
    }
    let (title, p1, s1) = pick(&base.title, &local.title, &remote.title, local_newer);
    let (body, p2, s2) = pick(&base.body, &local.body, &remote.body, local_newer);
    let (state, p3, s3) = pick(&base.state, &local.state, &remote.state, local_newer);
    let (labels, p4, s4) = pick(&base.labels, &local.labels, &remote.labels, local_newer);
    Merge { result: IssueFields { title, body, state, labels }, pull: p1 || p2 || p3 || p4, push: s1 || s2 || s3 || s4 }
}

fn remote_fields(issue: &Value) -> IssueFields {
    IssueFields {
        title: issue.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        body: issue.get("body").and_then(|t| t.as_str()).unwrap_or("").replace("\r\n", "\n"),
        state: issue.get("state").and_then(|t| t.as_str()).unwrap_or("open").to_string(),
        labels: issue.get("labels").and_then(|l| l.as_array()).map(|a| a.iter().filter_map(|l| l.get("name").and_then(|n| n.as_str()).map(String::from)).collect()).unwrap_or_default(),
    }
}

fn local_fields(conn: &Connection, t: &tasks::Task) -> AppResult<IssueFields> {
    let mut labels = BTreeSet::new();
    for id in &t.label_ids {
        if let Some(n) = conn.query_row("SELECT name FROM labels WHERE id = ?1", [id], |r| r.get::<_, String>(0)).optional()? {
            labels.insert(n);
        }
    }
    Ok(IssueFields { title: t.title.clone(), body: t.description.clone(), state: if t.status == "completed" { "closed".into() } else { "open".into() }, labels })
}

fn label_ids(conn: &Connection, names: &BTreeSet<String>) -> AppResult<Vec<String>> {
    let mut out = vec![];
    for n in names {
        let id: Option<String> = conn.query_row("SELECT id FROM labels WHERE name = ?1 COLLATE NOCASE", [n], |r| r.get(0)).optional()?;
        let id = match id {
            Some(i) => i,
            None => {
                let i = new_id();
                conn.execute("INSERT INTO labels(id, name, created_at) VALUES (?1, ?2, ?3)", params![i, n, now_ms()])?;
                i
            }
        };
        out.push(id);
    }
    Ok(out)
}

struct Link {
    task_id: Option<String>,
    synced: IssueFields,
}

fn load_link(conn: &Connection, repo: &str, number: i64) -> AppResult<Option<Link>> {
    Ok(conn
        .query_row(
            "SELECT task_id, synced_title, synced_body, synced_state, synced_labels FROM task_issue_links WHERE repo = ?1 AND issue_number = ?2",
            params![repo, number],
            |r| {
                Ok(Link {
                    task_id: r.get(0)?,
                    synced: IssueFields {
                        title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        body: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        state: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        labels: r.get::<_, Option<String>>(4)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
                    },
                })
            },
        )
        .optional()?)
}

fn save_link(conn: &Connection, repo: &str, number: i64, task_id: &str, project_id: &str, url: &str, f: &IssueFields, remote_updated: Option<&str>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO task_issue_links(repo, issue_number, task_id, project_id, html_url, remote_updated_at, synced_at, synced_title, synced_body, synced_state, synced_labels)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(repo, issue_number) DO UPDATE SET task_id = excluded.task_id, html_url = excluded.html_url, remote_updated_at = excluded.remote_updated_at,
           synced_at = excluded.synced_at, synced_title = excluded.synced_title, synced_body = excluded.synced_body, synced_state = excluded.synced_state,
           synced_labels = excluded.synced_labels",
        params![repo, number, task_id, project_id, url, remote_updated, now_ms(), f.title, f.body, f.state, serde_json::to_string(&f.labels)?],
    )?;
    Ok(())
}

/// Applies merged fields to the task without disturbing Kern-only state
/// (priority, due date, board column…).
fn apply_local(conn: &Connection, task: &tasks::Task, f: &IssueFields) -> AppResult<()> {
    let mut patch = TaskPatch::default();
    if task.title != f.title {
        patch.title = Some(f.title.clone());
    }
    if task.description != f.body {
        patch.description = Some(f.body.clone());
    }
    let closed = task.status == "completed";
    if closed && f.state == "open" {
        patch.status = Some("todo".into());
    } else if !closed && f.state == "closed" {
        patch.status = Some("completed".into());
    }
    let wanted = label_ids(conn, &f.labels)?;
    let mut have = task.label_ids.clone();
    have.sort();
    let mut w = wanted.clone();
    w.sort();
    if have != w {
        patch.label_ids = Some(wanted);
    }
    tasks::update_task(conn, &task.id, &patch)?;
    Ok(())
}

fn iso_ms(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s).map(|d| d.timestamp_millis()).unwrap_or(0)
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub imported: usize,
    pub updated_in_kern: usize,
    pub updated_on_github: usize,
    pub unchanged: usize,
    pub errors: Vec<String>,
}

/// Reconciles one issue with its task (creating the task when new).
fn reconcile(state: &AppState, gh: &Gh, repo: &ProjectRepo, issue: &Value, labels_on_repo: &BTreeSet<String>, report: &mut SyncReport) -> AppResult<()> {
    let number = issue.get("number").and_then(|n| n.as_i64()).unwrap_or(0);
    let url = issue.get("html_url").and_then(|u| u.as_str()).unwrap_or("").to_string();
    let remote_updated = issue.get("updated_at").and_then(|u| u.as_str()).map(String::from);
    let remote = remote_fields(issue);
    let full = repo.full_name.as_str();

    enum Plan {
        Done,
        Push(IssueFields, String),
    }
    let plan = state.with(|c| {
        let tx = c.transaction()?;
        let link = load_link(&tx, full, number)?;
        let plan = match link {
            None => {
                if remote.state == "closed" && !repo.import_closed {
                    Plan::Done
                } else {
                    let t = tasks::create_task(
                        &tx,
                        &TaskInput {
                            title: if remote.title.trim().is_empty() { format!("Issue #{number}") } else { remote.title.clone() },
                            description: Some(remote.body.clone()),
                            status: Some(if remote.state == "closed" { "completed".into() } else { "todo".into() }),
                            project_id: Some(repo.project_id.clone()),
                            label_ids: Some(label_ids(&tx, &remote.labels)?),
                            ..Default::default()
                        },
                    )?;
                    save_link(&tx, full, number, &t.id, &repo.project_id, &url, &remote, remote_updated.as_deref())?;
                    report.imported += 1;
                    Plan::Done
                }
            }
            // Ignored (its task was deleted).
            Some(Link { task_id: None, .. }) => Plan::Done,
            Some(Link { task_id: Some(tid), synced }) => match tasks::get_task(&tx, &tid) {
                Ok(task) if task.deleted_at.is_none() => {
                    let local = local_fields(&tx, &task)?;
                    let local_newer = task.updated_at > remote_updated.as_deref().map(iso_ms).unwrap_or(0);
                    let m = merge(&synced, &local, &remote, local_newer);
                    if m.pull {
                        apply_local(&tx, &task, &m.result)?;
                        report.updated_in_kern += 1;
                    }
                    if m.push {
                        Plan::Push(m.result, tid)
                    } else {
                        if !m.pull {
                            report.unchanged += 1;
                        }
                        save_link(&tx, full, number, &tid, &repo.project_id, &url, &m.result, remote_updated.as_deref())?;
                        Plan::Done
                    }
                }
                // In the trash: leave the issue alone until it's restored or purged.
                _ => Plan::Done,
            },
        };
        tx.commit()?;
        Ok(plan)
    })?;

    if let Plan::Push(fields, tid) = plan {
        // Only labels that exist on the repo are sent (Kern never invents repo labels).
        let push_labels: Vec<&String> = fields.labels.iter().filter(|l| labels_on_repo.contains(*l)).collect();
        let body = json!({ "title": fields.title, "body": fields.body, "state": fields.state, "labels": push_labels });
        let updated = gh.call("PATCH", &format!("/repos/{full}/issues/{number}"), Some(&body))?.body;
        let mut synced = remote_fields(&updated);
        // Keep Kern-only labels in the base so they don't read as a local change next time.
        synced.labels.extend(fields.labels.iter().filter(|l| !labels_on_repo.contains(*l)).cloned());
        state.with(|c| save_link(c, full, number, &tid, &repo.project_id, &url, &synced, updated.get("updated_at").and_then(|u| u.as_str())))?;
        report.updated_on_github += 1;
    }
    Ok(())
}

fn repo_labels(gh: &Gh, full: &str) -> BTreeSet<String> {
    gh.get_all(&format!("/repos/{full}/labels?per_page=100"), 5)
        .map(|v| v.iter().filter_map(|l| l.get("name").and_then(|n| n.as_str()).map(String::from)).collect())
        .unwrap_or_default()
}

pub fn sync_project(state: &AppState, project_id: &str) -> AppResult<SyncReport> {
    let repo = state.with(|c| project_repo(c, project_id))?.ok_or_else(|| AppError::Invalid("This project isn't connected to a GitHub repository.".into()))?;
    if !repo.sync_issues {
        return invalid("Issue sync is turned off for this project.");
    }
    let gh = Gh::new(state)?;
    let started = now_ms();
    let full = repo.full_name.clone();
    let labels = repo_labels(&gh, &full);
    let mut report = SyncReport::default();
    let result = (|| -> AppResult<()> {
        // Everything changed since the last sync (minus a minute of overlap).
        let since = repo
            .last_synced_at
            .and_then(|t| chrono::DateTime::from_timestamp_millis(t - 60_000))
            .map(|d| format!("&since={}", d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)))
            .unwrap_or_default();
        let state_q = if repo.last_synced_at.is_none() && !repo.import_closed { "open" } else { "all" };
        let issues = gh.get_all(&format!("/repos/{full}/issues?state={state_q}&per_page=100&sort=updated&direction=desc{since}"), 30)?;
        let mut seen = BTreeSet::new();
        for issue in issues.iter().filter(|i| i.get("pull_request").is_none()) {
            let n = issue.get("number").and_then(|n| n.as_i64()).unwrap_or(0);
            seen.insert(n);
            if let Err(e) = reconcile(state, &gh, &repo, issue, &labels, &mut report) {
                report.errors.push(format!("#{n}: {e}"));
            }
        }
        // Tasks edited in Kern whose issues didn't change on GitHub.
        let pending: Vec<(i64, String)> = state.with(|c| {
            let mut stmt = c.prepare(
                "SELECT l.issue_number, l.task_id FROM task_issue_links l JOIN tasks t ON t.id = l.task_id
                 WHERE l.project_id = ?1 AND t.deleted_at IS NULL AND t.updated_at > l.synced_at",
            )?;
            let rows = stmt.query_map([project_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        for (n, _) in pending.into_iter().filter(|(n, _)| !seen.contains(n)) {
            match gh.get(&format!("/repos/{full}/issues/{n}")) {
                Ok(issue) => {
                    if let Err(e) = reconcile(state, &gh, &repo, &issue, &labels, &mut report) {
                        report.errors.push(format!("#{n}: {e}"));
                    }
                }
                Err(e) => report.errors.push(format!("#{n}: {e}")),
            }
        }
        Ok(())
    })();
    state.with(|c| {
        c.execute(
            "UPDATE project_repos SET last_synced_at = ?1, last_sync_error = ?2 WHERE project_id = ?3",
            params![if result.is_ok() { Some(started) } else { repo.last_synced_at }, result.as_ref().err().map(|e| e.to_string()), project_id],
        )?;
        Ok(())
    })?;
    result?;
    Ok(report)
}

#[tauri::command]
pub async fn github_sync(app: AppHandle, project_id: String) -> AppResult<SyncReport> {
    blocking(&app, move |s| sync_project(s, &project_id)).await
}

/// Pushes (and pulls) one linked task right after it changed in Kern.
#[tauri::command]
pub async fn github_sync_task(app: AppHandle, task_id: String) -> AppResult<SyncReport> {
    blocking(&app, move |s| {
        let link: Option<(String, i64, String)> = s.with(|c| {
            Ok(c.query_row("SELECT repo, issue_number, project_id FROM task_issue_links WHERE task_id = ?1", [&task_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?)
        })?;
        let Some((full, n, project_id)) = link else { return invalid("This task isn't linked to a GitHub issue.") };
        let repo = s.with(|c| project_repo(c, &project_id))?.ok_or_else(|| AppError::Invalid("The project is no longer connected.".into()))?;
        let gh = Gh::new(s)?;
        let issue = gh.get(&format!("/repos/{full}/issues/{n}"))?;
        let mut report = SyncReport::default();
        reconcile(s, &gh, &repo, &issue, &repo_labels(&gh, &full), &mut report)?;
        Ok(report)
    })
    .await
}

/// Creates a GitHub issue from a Kern task and links them.
#[tauri::command]
pub async fn github_create_issue(app: AppHandle, task_id: String) -> AppResult<String> {
    blocking(&app, move |s| {
        let (task, repo) = s.with(|c| {
            let t = tasks::get_task(c, &task_id)?;
            let pid = t.project_id.clone().ok_or_else(|| AppError::Invalid("Move the task into a project connected to GitHub first.".into()))?;
            let r = project_repo(c, &pid)?.ok_or_else(|| AppError::Invalid("This task's project isn't connected to GitHub.".into()))?;
            Ok((t, r))
        })?;
        if task.issue.is_some() {
            return invalid("This task is already linked to an issue.");
        }
        let gh = Gh::new(s)?;
        let labels = repo_labels(&gh, &repo.full_name);
        let local = s.with(|c| local_fields(c, &task))?;
        let body = json!({ "title": local.title, "body": local.body, "labels": local.labels.iter().filter(|l| labels.contains(*l)).collect::<Vec<_>>() });
        let created = gh.call("POST", &format!("/repos/{}/issues", repo.full_name), Some(&body))?.body;
        let n = created.get("number").and_then(|n| n.as_i64()).unwrap_or(0);
        let url = created.get("html_url").and_then(|u| u.as_str()).unwrap_or("").to_string();
        if local.state == "closed" {
            let _ = gh.call("PATCH", &format!("/repos/{}/issues/{n}", repo.full_name), Some(&json!({ "state": "closed" })));
        }
        let mut synced = remote_fields(&created);
        synced.state = local.state.clone();
        synced.labels.extend(local.labels.iter().filter(|l| !labels.contains(*l)).cloned());
        s.with(|c| save_link(c, &repo.full_name, n, &task_id, &repo.project_id, &url, &synced, created.get("updated_at").and_then(|u| u.as_str())))?;
        Ok(url)
    })
    .await
}

// ------------------------------------------------------------ pull requests

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullInfo {
    pub number: i64,
    pub title: String,
    pub html_url: String,
    pub draft: bool,
    pub author: String,
    pub head: String,
    pub base: String,
    pub updated_at: String,
    /// success | failure | pending | none
    pub checks: String,
    /// approved | changes_requested | commented | none
    pub review: String,
    pub linked_issues: Vec<i64>,
    pub linked_tasks: Vec<LinkedTask>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedTask {
    pub id: String,
    pub title: String,
    pub done: bool,
}

/// Issue numbers a pull request refers to ("#12", "fixes #12", branch "12-foo").
pub fn referenced_issues(title: &str, body: &str, branch: &str) -> Vec<i64> {
    let mut out = BTreeSet::new();
    for text in [title, body] {
        let b = text.as_bytes();
        for (i, ch) in b.iter().enumerate() {
            if *ch == b'#' && (i == 0 || !b[i - 1].is_ascii_alphanumeric()) {
                let digits: String = text[i + 1..].chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(n) = digits.parse::<i64>() {
                    out.insert(n);
                }
            }
        }
    }
    let lead: String = branch.rsplit('/').next().unwrap_or("").chars().take_while(|c| c.is_ascii_digit()).collect();
    if let Ok(n) = lead.parse::<i64>() {
        out.insert(n);
    }
    if let Some(i) = branch.find("issue-") {
        if let Ok(n) = branch[i + 6..].chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse::<i64>() {
            out.insert(n);
        }
    }
    out.into_iter().collect()
}

/// The GitHub repository an operation targets: `repo` when it's linked to
/// the project, else the issue-sync connection, else the first linked
/// repository on GitHub.
pub fn project_slug(conn: &Connection, project_id: &str, repo: Option<&str>) -> AppResult<String> {
    if let Some(r) = repo.map(str::trim).filter(|r| !r.is_empty()) {
        let linked: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM project_repositories WHERE project_id = ?1 AND lower(github) = lower(?2))
               OR EXISTS (SELECT 1 FROM project_repos WHERE project_id = ?1 AND lower(owner || '/' || name) = lower(?2))",
            params![project_id, r],
            |x| x.get(0),
        )?;
        if !linked {
            return invalid("That repository isn't linked to this project.");
        }
        return Ok(r.to_string());
    }
    if let Some(r) = project_repo(conn, project_id)? {
        return Ok(r.full_name);
    }
    crate::domain::repos::adopt(conn, project_id)?;
    conn.query_row(
        "SELECT github FROM project_repositories WHERE project_id = ?1 AND github IS NOT NULL ORDER BY is_primary DESC, sort_order LIMIT 1",
        [project_id],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .ok_or_else(|| AppError::Invalid("This project isn't linked to a GitHub repository.".into()))
}

/// Stores a fetched GitHub result for offline use (health, catch-up, search).
fn cache_put<T: Serialize>(state: &AppState, key: &str, value: &T) {
    if let Ok(data) = serde_json::to_string(value) {
        let _ = state.with(|c| {
            c.execute(
                "INSERT INTO dev_cache(key, data, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at",
                params![key, data, now_ms()],
            )?;
            Ok(())
        });
    }
}

#[tauri::command]
pub async fn github_pulls(app: AppHandle, project_id: String, repo: Option<String>) -> AppResult<Vec<PullInfo>> {
    blocking(&app, move |s| {
        let full_name = s.with(|c| project_slug(c, &project_id, repo.as_deref()))?;
        let gh = Gh::new(s)?;
        let full = &full_name;
        let pulls = gh.get(&format!("/repos/{full}/pulls?state=open&per_page=20&sort=updated&direction=desc"))?;
        let mut out = vec![];
        for p in pulls.as_array().cloned().unwrap_or_default().into_iter().take(12) {
            let n = p.get("number").and_then(|x| x.as_i64()).unwrap_or(0);
            let s_ = |k: &str| p.pointer(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let sha = s_("/head/sha");
            // Checks: check runs plus legacy commit statuses.
            let mut checks = "none".to_string();
            if let Ok(runs) = gh.get(&format!("/repos/{full}/commits/{sha}/check-runs?per_page=100")) {
                let list = runs.get("check_runs").and_then(|r| r.as_array()).cloned().unwrap_or_default();
                if !list.is_empty() {
                    checks = if list.iter().any(|r| matches!(r.get("conclusion").and_then(|c| c.as_str()), Some("failure" | "timed_out" | "cancelled" | "action_required"))) {
                        "failure"
                    } else if list.iter().any(|r| r.get("status").and_then(|c| c.as_str()) != Some("completed")) {
                        "pending"
                    } else {
                        "success"
                    }
                    .into();
                }
            }
            if checks != "failure" {
                if let Ok(st) = gh.get(&format!("/repos/{full}/commits/{sha}/status")) {
                    if st.get("total_count").and_then(|t| t.as_i64()).unwrap_or(0) > 0 {
                        match st.get("state").and_then(|t| t.as_str()) {
                            Some("failure" | "error") => checks = "failure".into(),
                            Some("pending") if checks != "failure" => checks = "pending".into(),
                            Some("success") if checks == "none" => checks = "success".into(),
                            _ => {}
                        }
                    }
                }
            }
            // Latest review per reviewer decides.
            let mut by_user: HashMap<String, String> = HashMap::new();
            if let Ok(reviews) = gh.get(&format!("/repos/{full}/pulls/{n}/reviews?per_page=100")) {
                for r in reviews.as_array().cloned().unwrap_or_default() {
                    let user = r.pointer("/user/login").and_then(|u| u.as_str()).unwrap_or("").to_string();
                    let st = r.get("state").and_then(|u| u.as_str()).unwrap_or("").to_string();
                    if st != "COMMENTED" || !by_user.contains_key(&user) {
                        by_user.insert(user, st);
                    }
                }
            }
            let review = if by_user.values().any(|s| s == "CHANGES_REQUESTED") {
                "changes_requested"
            } else if by_user.values().any(|s| s == "APPROVED") {
                "approved"
            } else if !by_user.is_empty() {
                "commented"
            } else {
                "none"
            };
            let linked_issues = referenced_issues(&s_("/title"), &s_("/body"), &s_("/head/ref"));
            let linked_tasks = s.with(|c| {
                let mut v = vec![];
                for i in &linked_issues {
                    if let Some(t) = c
                        .query_row(
                            "SELECT t.id, t.title, t.status FROM task_issue_links l JOIN tasks t ON t.id = l.task_id WHERE l.repo = ?1 AND l.issue_number = ?2 AND t.deleted_at IS NULL",
                            params![full, i],
                            |r| Ok(LinkedTask { id: r.get(0)?, title: r.get(1)?, done: r.get::<_, String>(2)? == "completed" }),
                        )
                        .optional()?
                    {
                        v.push(t);
                    }
                }
                Ok(v)
            })?;
            out.push(PullInfo {
                number: n,
                title: s_("/title"),
                html_url: s_("/html_url"),
                draft: p.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
                author: s_("/user/login"),
                head: s_("/head/ref"),
                base: s_("/base/ref"),
                updated_at: s_("/updated_at"),
                checks,
                review: review.into(),
                linked_issues,
                linked_tasks,
            });
        }
        cache_put(s, &format!("gh:pulls:{}", full.to_lowercase()), &out);
        Ok(out)
    })
    .await
}

// ------------------------------------------------------------ actions, issues, commits

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: i64,
    pub workflow_id: i64,
    pub workflow: String,
    pub title: String,
    pub branch: String,
    pub event: String,
    /// queued | in_progress | completed
    pub status: String,
    /// success | failure | cancelled | skipped | timed_out | action_required | null
    pub conclusion: Option<String>,
    pub html_url: String,
    pub created_at: String,
    pub run_number: i64,
    pub actor: String,
    pub head_sha: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActionsOverview {
    pub repository: String,
    pub default_branch: Option<String>,
    /// The latest run of each workflow (newest first).
    pub latest: Vec<WorkflowRun>,
    pub recent: Vec<WorkflowRun>,
}

fn run_of(v: &Value) -> WorkflowRun {
    let s = |k: &str| v.pointer(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    WorkflowRun {
        id: v.get("id").and_then(|x| x.as_i64()).unwrap_or(0),
        workflow_id: v.get("workflow_id").and_then(|x| x.as_i64()).unwrap_or(0),
        workflow: s("/name"),
        title: s("/display_title"),
        branch: s("/head_branch"),
        event: s("/event"),
        status: s("/status"),
        conclusion: v.get("conclusion").and_then(|x| x.as_str()).map(String::from),
        html_url: s("/html_url"),
        created_at: s("/created_at"),
        run_number: v.get("run_number").and_then(|x| x.as_i64()).unwrap_or(0),
        actor: s("/actor/login"),
        head_sha: s("/head_sha"),
    }
}

/// Recent GitHub Actions runs and the latest run of each workflow.
#[tauri::command]
pub async fn github_actions(app: AppHandle, project_id: String, repo: Option<String>) -> AppResult<ActionsOverview> {
    blocking(&app, move |s| {
        let full = s.with(|c| project_slug(c, &project_id, repo.as_deref()))?;
        let gh = Gh::new(s)?;
        let info = gh.get(&format!("/repos/{full}"))?;
        let default_branch = info.get("default_branch").and_then(|d| d.as_str()).map(String::from);
        let runs = gh.get(&format!("/repos/{full}/actions/runs?per_page=40"))?;
        let recent: Vec<WorkflowRun> = runs.get("workflow_runs").and_then(|r| r.as_array()).cloned().unwrap_or_default().iter().map(run_of).collect();
        let mut seen = BTreeSet::new();
        let latest = recent.iter().filter(|r| seen.insert(r.workflow_id)).cloned().collect();
        let out = ActionsOverview { repository: full.clone(), default_branch, latest, recent };
        cache_put(s, &format!("gh:actions:{}", full.to_lowercase()), &out);
        Ok(out)
    })
    .await
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: i64,
    pub title: String,
    pub html_url: String,
    pub state: String,
    pub labels: Vec<String>,
    pub author: String,
    pub comments: i64,
    pub updated_at: String,
    /// The Kern task synced with this issue, if any.
    pub task_id: Option<String>,
}

/// Open issues of a linked repository (read-only; issue sync is separate).
#[tauri::command]
pub async fn github_issues(app: AppHandle, project_id: String, repo: Option<String>) -> AppResult<Vec<IssueSummary>> {
    blocking(&app, move |s| {
        let full = s.with(|c| project_slug(c, &project_id, repo.as_deref()))?;
        let gh = Gh::new(s)?;
        let list = gh.get(&format!("/repos/{full}/issues?state=open&per_page=30&sort=updated&direction=desc"))?;
        let mut out = vec![];
        for i in list.as_array().cloned().unwrap_or_default().iter().filter(|i| i.get("pull_request").is_none()) {
            let n = i.get("number").and_then(|x| x.as_i64()).unwrap_or(0);
            let task_id: Option<String> = s.with(|c| {
                Ok(c.query_row("SELECT task_id FROM task_issue_links WHERE lower(repo) = lower(?1) AND issue_number = ?2", params![full, n], |r| r.get(0)).optional()?.flatten())
            })?;
            let st = |k: &str| i.pointer(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            out.push(IssueSummary {
                number: n,
                title: st("/title"),
                html_url: st("/html_url"),
                state: st("/state"),
                labels: i.get("labels").and_then(|l| l.as_array()).map(|a| a.iter().filter_map(|l| l.get("name").and_then(|n| n.as_str()).map(String::from)).collect()).unwrap_or_default(),
                author: st("/user/login"),
                comments: i.get("comments").and_then(|x| x.as_i64()).unwrap_or(0),
                updated_at: st("/updated_at"),
                task_id,
            });
        }
        cache_put(s, &format!("gh:issues:{}", full.to_lowercase()), &out);
        Ok(out)
    })
    .await
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommit {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub html_url: String,
}

/// Recent commits on GitHub (for repositories without a local copy).
#[tauri::command]
pub async fn github_commits(app: AppHandle, project_id: String, repo: Option<String>) -> AppResult<Vec<RemoteCommit>> {
    blocking(&app, move |s| {
        let full = s.with(|c| project_slug(c, &project_id, repo.as_deref()))?;
        let gh = Gh::new(s)?;
        let list = gh.get(&format!("/repos/{full}/commits?per_page=20"))?;
        let out: Vec<RemoteCommit> = list
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|c| {
                let st = |k: &str| c.pointer(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
                let sha = st("/sha");
                RemoteCommit {
                    short: sha.chars().take(7).collect(),
                    subject: st("/commit/message").lines().next().unwrap_or("").to_string(),
                    author: c.pointer("/author/login").and_then(|x| x.as_str()).map(String::from).unwrap_or_else(|| st("/commit/author/name")),
                    date: st("/commit/author/date"),
                    html_url: st("/html_url"),
                    sha,
                }
            })
            .collect();
        cache_put(s, &format!("gh:commits:{}", full.to_lowercase()), &out);
        Ok(out)
    })
    .await
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CachedGithub {
    pub repository: String,
    pub pulls: Option<Value>,
    pub actions: Option<Value>,
    pub issues: Option<Value>,
    pub commits: Option<Value>,
    pub fetched_at: Option<i64>,
}

/// The last fetched GitHub data for a project's repositories (no network).
#[tauri::command]
pub fn github_cached(state: tauri::State<AppState>, project_id: String) -> AppResult<Vec<CachedGithub>> {
    state.with(|c| {
        crate::domain::repos::adopt(c, &project_id)?;
        let mut stmt = c.prepare(
            "SELECT DISTINCT lower(github) FROM project_repositories WHERE project_id = ?1 AND github IS NOT NULL
             UNION SELECT lower(owner || '/' || name) FROM project_repos WHERE project_id = ?1",
        )?;
        let slugs: Vec<String> = stmt.query_map([&project_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        let mut out = vec![];
        for slug in slugs {
            let mut newest: Option<i64> = None;
            let mut load = |kind: &str| -> AppResult<Option<Value>> {
                let row: Option<(String, i64)> = c.query_row("SELECT data, fetched_at FROM dev_cache WHERE key = ?1", [format!("gh:{kind}:{slug}")], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
                Ok(row.map(|(d, t)| {
                    newest = Some(newest.map_or(t, |n| n.max(t)));
                    serde_json::from_str(&d).unwrap_or(Value::Null)
                }))
            };
            let pulls = load("pulls")?;
            let actions = load("actions")?;
            let issues = load("issues")?;
            let commits = load("commits")?;
            out.push(CachedGithub { repository: slug, pulls, actions, issues, commits, fetched_at: newest });
        }
        Ok(out)
    })
}

// ------------------------------------------------------------ overview

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoOverview {
    pub full_name: String,
    pub description: Option<String>,
    pub html_url: String,
    pub default_branch: Option<String>,
    pub private: bool,
    pub stars: i64,
    pub forks: i64,
    pub open_issues: i64,
    pub pushed_at: Option<String>,
    /// Bytes of code per language, largest first.
    pub languages: Vec<(String, i64)>,
    pub readme: Option<String>,
    /// Where the README came from: "local" (linked clone) or "github".
    pub readme_source: Option<String>,
}

#[tauri::command]
pub async fn github_overview(app: AppHandle, project_id: String) -> AppResult<RepoOverview> {
    blocking(&app, move |s| {
        let repo = s.with(|c| project_repo(c, &project_id))?.ok_or_else(|| AppError::Invalid("This project isn't connected to GitHub.".into()))?;
        let gh = Gh::new(s)?;
        let full = &repo.full_name;
        let info = gh.get(&format!("/repos/{full}"))?;
        let mut languages: Vec<(String, i64)> = gh
            .get(&format!("/repos/{full}/languages"))
            .ok()
            .and_then(|v| v.as_object().cloned())
            .map(|m| m.into_iter().map(|(k, v)| (k, v.as_i64().unwrap_or(0))).collect())
            .unwrap_or_default();
        languages.sort_by(|a, b| b.1.cmp(&a.1));
        // Prefer the README in a linked local clone of this same repository.
        let local = s
            .with(|c| crate::domain::folders::root_of(c, &project_id))
            .ok()
            .filter(|(root, _)| git::read_remote(root).github.is_some_and(|g| g.eq_ignore_ascii_case(full)))
            .and_then(|(root, _)| ["README.md", "readme.md", "README.markdown", "README.txt", "README"].iter().map(|n| root.join(n)).find(|p| p.is_file()))
            .and_then(|p| std::fs::read(&p).ok())
            .map(|b| String::from_utf8_lossy(&b[..b.len().min(64 * 1024)]).to_string());
        let (readme, readme_source) = match local {
            Some(r) => (Some(r), Some("local".to_string())),
            None => match gh.get(&format!("/repos/{full}/readme")) {
                Ok(v) => {
                    use base64::Engine;
                    let raw = v.get("content").and_then(|c| c.as_str()).unwrap_or("").replace('\n', "");
                    let text = base64::engine::general_purpose::STANDARD.decode(raw).ok().map(|b| String::from_utf8_lossy(&b[..b.len().min(64 * 1024)]).to_string());
                    (text, Some("github".to_string()))
                }
                Err(_) => (None, None),
            },
        };
        Ok(RepoOverview {
            full_name: full.clone(),
            description: info.get("description").and_then(|d| d.as_str()).map(String::from),
            html_url: info.get("html_url").and_then(|d| d.as_str()).unwrap_or("").to_string(),
            default_branch: info.get("default_branch").and_then(|d| d.as_str()).map(String::from),
            private: info.get("private").and_then(|d| d.as_bool()).unwrap_or(false),
            stars: info.get("stargazers_count").and_then(|d| d.as_i64()).unwrap_or(0),
            forks: info.get("forks_count").and_then(|d| d.as_i64()).unwrap_or(0),
            open_issues: info.get("open_issues_count").and_then(|d| d.as_i64()).unwrap_or(0),
            pushed_at: info.get("pushed_at").and_then(|d| d.as_str()).map(String::from),
            languages,
            readme,
            readme_source,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(title: &str, body: &str, state: &str, labels: &[&str]) -> IssueFields {
        IssueFields { title: title.into(), body: body.into(), state: state.into(), labels: labels.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn three_way_merge() {
        let base = f("Fix login", "", "open", &["bug"]);
        // Only GitHub changed → pull.
        let m = merge(&base, &base, &f("Fix login flow", "", "open", &["bug"]), false);
        assert!(m.pull && !m.push);
        assert_eq!(m.result.title, "Fix login flow");
        // Only Kern changed (task completed) → push close.
        let m = merge(&base, &f("Fix login", "", "closed", &["bug"]), &base, false);
        assert!(m.push && !m.pull);
        assert_eq!(m.result.state, "closed");
        // Different fields on each side → both apply.
        let m = merge(&base, &f("Fix login", "", "closed", &["bug"]), &f("Fix login", "steps to repro", "open", &["bug"]), false);
        assert!(m.push && m.pull);
        assert_eq!((m.result.state.as_str(), m.result.body.as_str()), ("closed", "steps to repro"));
        // Same field on both sides → newer wins.
        let l = f("Local title", "", "open", &["bug"]);
        let r = f("Remote title", "", "open", &["bug"]);
        assert_eq!(merge(&base, &l, &r, true).result.title, "Local title");
        assert_eq!(merge(&base, &l, &r, false).result.title, "Remote title");
        // Nothing changed.
        assert_eq!(merge(&base, &base, &base, true), Merge { result: base.clone(), pull: false, push: false });
    }

    #[test]
    fn finds_referenced_issues() {
        assert_eq!(referenced_issues("Fix login (#12)", "Closes #34 and refs acme#9", "feature/56-login"), vec![12, 34, 56]);
        assert_eq!(referenced_issues("No refs", "", "fix/issue-7-crash"), vec![7]);
    }

    #[test]
    fn deleting_a_task_marks_its_issue_ignored() {
        let c = crate::db::open_memory();
        let p = crate::domain::projects::create_project(&c, &crate::domain::projects::ProjectInput { name: "Repo".into(), ..Default::default() }).unwrap();
        let t = tasks::create_task(&c, &TaskInput { title: "Issue".into(), project_id: Some(p.id.clone()), ..Default::default() }).unwrap();
        save_link(&c, "o/r", 5, &t.id, &p.id, "https://github.com/o/r/issues/5", &f("Issue", "", "open", &[]), None).unwrap();
        assert_eq!(tasks::get_task(&c, &t.id).unwrap().issue.unwrap().number, 5);
        c.execute("DELETE FROM tasks WHERE id = ?1", [&t.id]).unwrap();
        let link = load_link(&c, "o/r", 5).unwrap().unwrap();
        assert!(link.task_id.is_none(), "the link survives as 'ignored'");
    }
}
