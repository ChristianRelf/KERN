// @Author Christian Relf
// @Date 2026-10-15

//! Passkeys, and the per-project locks they open.
//!
//! A passkey here is a credential held by the operating system's
//! authenticator - Windows Hello (face, fingerprint or PIN), or a security
//! key over USB. WebAuthn isn't available inside the webview, so every
//! credential operation happens in this module through the OS API and the
//! front end never sees key material, only labels and dates.
//!
//! What the lock is: an access gate. A project with `locked_at` set returns
//! nothing - no project row detail, tasks, notes, whiteboards, search hits or
//! recents - until a passkey has answered for it in this session.
//!
//! What it is not: encryption. `kern.db` holds the same rows as before and
//! anything running as this user can read the file, so the gate guards the
//! running app, not the data at rest. Two consequences are deliberate:
//!
//! - Kern is its own relying party, on the same machine as the authenticator.
//!   The gate therefore checks that the OS returned an assertion for a
//!   credential registered here and that its user-verified flag is set; it
//!   doesn't re-verify the signature, because the verifying key would live
//!   inside the very process being protected.
//! - Locks only bite while this computer has a passkey (`enforced`). A
//!   project locked on another computer would otherwise be unreachable here,
//!   and `reset` exists so a lost authenticator can't strand data either.
//!
//! Passkeys are per-computer (`DEVICE_TABLES`); `projects.locked_at` syncs,
//! so the lock follows the project and each computer registers its own
//! passkey to open it.

#[cfg(windows)]
#[path = "platform_windows.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "platform_other.rs"]
mod platform;

use crate::domain::settings;
use crate::error::{invalid, locked, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, State};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// This computer's built-in authenticator (Windows Hello).
    Platform,
    /// A removable authenticator (USB security key).
    SecurityKey,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Platform => "platform",
            Kind::SecurityKey => "securityKey",
        }
    }
    fn parse(s: &str) -> Kind {
        if s == "securityKey" {
            Kind::SecurityKey
        } else {
            Kind::Platform
        }
    }
}

/// What the authenticator produced when a passkey was created.
pub struct Registered {
    pub credential_id: Vec<u8>,
    pub kind: Kind,
    pub user_verified: bool,
}

/// What it produced when one was used.
pub struct Assertion {
    pub credential_id: Vec<u8>,
    pub user_verified: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Support {
    /// Windows Hello (or another built-in verifying authenticator) is set up.
    pub platform: bool,
    /// A security key can be used.
    pub security_key: bool,
    /// Why one or both are unavailable, for the settings page to show.
    pub reason: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Passkey {
    pub id: String,
    pub label: String,
    pub kind: Kind,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

/// A locked project, as the settings page lists it.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LockedProject {
    pub id: String,
    pub name: String,
    pub locked_at: i64,
    /// Opened with a passkey in this session.
    pub unlocked: bool,
}

// ------------------------------------------------------------ session state

/// Which locked projects have been opened this session, and when that lapses
/// (`None` lasts until Kern quits). Process-wide on purpose: it belongs to
/// the running app rather than to a connection, and the read paths that
/// consult it only have a `&Connection` to hand.
fn opened() -> &'static Mutex<HashMap<String, Option<i64>>> {
    static OPENED: OnceLock<Mutex<HashMap<String, Option<i64>>>> = OnceLock::new();
    OPENED.get_or_init(Default::default)
}

/// The projects open right now, dropping any whose time has run out.
fn open_ids() -> HashSet<String> {
    let now = now_ms();
    let mut guard = match opened().lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    guard.retain(|_, until| until.map_or(true, |t| t > now));
    guard.keys().cloned().collect()
}

fn mark_open(conn: &Connection, project_id: &str) {
    let minutes: i64 = settings::get_or(conn, "privacy.passkeyRelockMinutes", 0);
    let until = (minutes > 0).then(|| now_ms() + minutes * 60_000);
    if let Ok(mut g) = opened().lock() {
        g.insert(project_id.to_string(), until);
    }
}

/// Closes a project again (or every project, with `None`): the next read
/// needs a passkey. Also used when a project's lock is turned off and on.
pub fn close(project_id: Option<&str>) {
    if let Ok(mut g) = opened().lock() {
        match project_id {
            Some(id) => {
                g.remove(id);
            }
            None => g.clear(),
        }
    }
}

// ------------------------------------------------------------ the gate

pub fn list(conn: &Connection) -> AppResult<Vec<Passkey>> {
    let mut stmt = conn.prepare("SELECT id, label, kind, created_at, last_used_at FROM passkeys ORDER BY created_at")?;
    let rows = stmt.query_map([], |r| {
        Ok(Passkey {
            id: r.get(0)?,
            label: r.get(1)?,
            kind: Kind::parse(&r.get::<_, String>(2)?),
            created_at: r.get(3)?,
            last_used_at: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Whether locks are enforced at all: with no passkey on this computer there
/// would be no way to open one, so a lock set elsewhere stays inert here.
pub fn enforced(conn: &Connection) -> bool {
    conn.query_row("SELECT EXISTS (SELECT 1 FROM passkeys)", [], |r| r.get::<_, i64>(0)).map(|n| n == 1).unwrap_or(false)
}

pub fn is_locked(conn: &Connection, project_id: &str) -> bool {
    conn.query_row("SELECT locked_at IS NOT NULL FROM projects WHERE id = ?1", [project_id], |r| r.get::<_, i64>(0))
        .optional()
        .unwrap_or(None)
        .is_some_and(|n| n == 1)
}

/// True when this project's content may be read right now.
pub fn readable(conn: &Connection, project_id: &str) -> bool {
    !enforced(conn) || !is_locked(conn, project_id) || open_ids().contains(project_id)
}

/// The guard for every command that takes a project id.
pub fn ensure_readable(conn: &Connection, project_id: &str) -> AppResult<()> {
    if readable(conn, project_id) {
        return Ok(());
    }
    locked("This project is locked. Use a passkey to open it.")
}

/// Same, for a task or note that may or may not belong to a project.
pub fn ensure_readable_opt(conn: &Connection, project_id: Option<&str>) -> AppResult<()> {
    match project_id {
        Some(id) => ensure_readable(conn, id),
        None => Ok(()),
    }
}

/// Ids made by `new_id()` are UUIDs; anything else must never reach spliced
/// SQL, so the filter below fails closed instead of letting a row through.
fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The projects that are locked and not open right now - the only ones the
/// read paths have to hide. Empty in the ordinary case, including when locks
/// aren't enforced on this computer.
fn shut_ids(conn: &Connection) -> Vec<String> {
    if !enforced(conn) {
        return vec![];
    }
    let locked_ids: Vec<String> = conn
        .prepare("SELECT id FROM projects WHERE locked_at IS NOT NULL")
        .and_then(|mut s| s.query_map([], |r| r.get(0)).and_then(|rows| rows.collect()))
        .unwrap_or_default();
    if locked_ids.is_empty() {
        return vec![];
    }
    let open = open_ids();
    locked_ids.into_iter().filter(|id| !open.contains(id)).collect()
}

/// Whether anything is being withheld at the moment. Read paths that filter
/// in Rust rather than SQL use it to skip the work entirely.
pub fn filtering(conn: &Connection) -> bool {
    !shut_ids(conn).is_empty()
}

/// A SQL predicate - no parameters, for splicing into a larger query - that
/// is true for rows whose project may be read right now. `column` is the
/// project-id column (`t.project_id`), and a row without a project passes.
///
/// It is the literal `1` in the ordinary case where nothing is locked, so
/// queries are unchanged until the feature is actually used.
pub fn readable_sql(conn: &Connection, column: &str) -> String {
    let shut = shut_ids(conn);
    if shut.is_empty() {
        return "1".into();
    }
    if !shut.iter().all(|id| plain_id(id)) {
        // Can't quote it safely: hide every project's rows rather than risk
        // showing a locked one.
        return format!("{column} IS NULL");
    }
    let list = shut.iter().map(|id| format!("'{id}'")).collect::<Vec<_>>().join(", ");
    format!("({column} IS NULL OR {column} NOT IN ({list}))")
}

// ------------------------------------------------------------ registering

/// 32 bytes to be signed over. Two v4 UUIDs rather than a new dependency:
/// both come from the OS random source, for 244 bits of freshness.
fn challenge() -> Vec<u8> {
    let mut v = uuid::Uuid::new_v4().as_bytes().to_vec();
    v.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    v
}

/// The window the OS parents its prompt to. Zero is accepted by the API but
/// leaves the dialog unparented, so the real handle is worth the lookup.
fn parent_window(app: &AppHandle) -> isize {
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(h) = w.hwnd() {
            return h.0 as isize;
        }
    }
    #[cfg(not(windows))]
    let _ = app;
    0
}

pub fn support() -> Support {
    platform::support()
}

fn clean_label(label: &str) -> AppResult<String> {
    let label = label.trim();
    if label.is_empty() {
        return invalid("Give the passkey a name.");
    }
    Ok(label.chars().take(60).collect())
}

/// Registers a new passkey. The OS prompt blocks, so the caller must already
/// be off the UI thread and must not be holding the database lock.
fn create(state: &AppState, app: &AppHandle, label: &str, kind: Kind) -> AppResult<Passkey> {
    let label = clean_label(label)?;
    let hwnd = parent_window(app);
    let handle = uuid::Uuid::new_v4().as_bytes().to_vec();
    let out = platform::register(hwnd, &label, &challenge(), &handle, kind)?;
    if !out.user_verified {
        return invalid("That authenticator didn't verify who you are, so it can't be used as a Kern passkey.");
    }
    let row = Passkey { id: new_id(), label, kind: out.kind, created_at: now_ms(), last_used_at: None };
    let credential = URL_SAFE_NO_PAD.encode(&out.credential_id);
    state.with(|c| {
        c.execute(
            "INSERT INTO passkeys(id, label, credential_id, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![row.id, row.label, credential, row.kind.as_str(), row.created_at],
        )?;
        Ok(())
    })?;
    Ok(row)
}

/// Asks the authenticator for an assertion over a fresh challenge, limited to
/// the passkeys registered here, and records which one answered.
fn verify(state: &AppState, app: &AppHandle) -> AppResult<String> {
    let registered: Vec<(String, String)> = state.with(|c| {
        let mut stmt = c.prepare("SELECT id, credential_id FROM passkeys")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })?;
    if registered.is_empty() {
        return invalid("No passkey is registered on this computer. Add one in Settings > Privacy & Security.");
    }
    let allow: Vec<Vec<u8>> = registered.iter().filter_map(|(_, c)| URL_SAFE_NO_PAD.decode(c).ok()).collect();
    let hwnd = parent_window(app);
    let assertion = platform::assert(hwnd, &challenge(), &allow)?;
    if !assertion.user_verified {
        return locked("The authenticator didn't verify who you are.");
    }
    let used = URL_SAFE_NO_PAD.encode(&assertion.credential_id);
    let Some((id, _)) = registered.into_iter().find(|(_, c)| *c == used) else {
        // The OS answered with something Kern never registered.
        return locked("That passkey isn't registered with Kern.");
    };
    state.with(|c| {
        c.execute("UPDATE passkeys SET last_used_at = ?1 WHERE id = ?2", params![now_ms(), &id])?;
        Ok(())
    })?;
    Ok(id)
}

// ------------------------------------------------------------ locked projects

pub fn locked_projects(conn: &Connection) -> AppResult<Vec<LockedProject>> {
    let open = open_ids();
    let mut stmt = conn.prepare(
        "SELECT id, name, locked_at FROM projects WHERE locked_at IS NOT NULL AND deleted_at IS NULL ORDER BY name",
    )?;
    let rows = stmt.query_map([], |r| {
        let id: String = r.get(0)?;
        Ok(LockedProject { unlocked: open.contains(&id), id, name: r.get(1)?, locked_at: r.get(2)? })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn set_lock(conn: &Connection, project_id: &str, on: bool) -> AppResult<()> {
    if on && !enforced(conn) {
        return invalid("Add a passkey to this computer before locking a project.");
    }
    let exists: Option<i64> = conn
        .query_row("SELECT 1 FROM projects WHERE id = ?1 AND deleted_at IS NULL", [project_id], |r| r.get(0))
        .optional()?;
    if exists.is_none() {
        return Err(AppError::NotFound("Project".into()));
    }
    // Turning the lock off is itself behind the lock.
    if !on {
        ensure_readable(conn, project_id)?;
    }
    let now = now_ms();
    conn.execute(
        "UPDATE projects SET locked_at = ?1, updated_at = ?2 WHERE id = ?3",
        params![on.then_some(now), now, project_id],
    )?;
    // A newly locked project shouldn't count as already open.
    close(Some(project_id));
    Ok(())
}

// --------------------------------------------------------------- commands

async fn blocking<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&AppState, &AppHandle) -> AppResult<T> + Send + 'static) -> AppResult<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>(), &app))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn passkeys_list(state: State<AppState>) -> AppResult<Vec<Passkey>> {
    state.with(|c| list(c))
}

#[tauri::command]
pub fn passkeys_support() -> Support {
    support()
}

#[tauri::command]
pub async fn passkey_register(app: AppHandle, label: String, kind: Kind) -> AppResult<Passkey> {
    blocking(&app, move |s, app| create(s, app, &label, kind)).await
}

#[tauri::command]
pub fn passkey_rename(state: State<AppState>, id: String, label: String) -> AppResult<()> {
    let label = clean_label(&label)?;
    state.with(|c| {
        let n = c.execute("UPDATE passkeys SET label = ?1 WHERE id = ?2", params![label, &id])?;
        if n == 0 {
            return Err(AppError::NotFound("Passkey".into()));
        }
        Ok(())
    })
}

/// Removing a passkey needs a passkey: otherwise the gate could be taken
/// apart by whoever is sitting at the computer.
#[tauri::command]
pub async fn passkey_remove(app: AppHandle, id: String) -> AppResult<()> {
    blocking(&app, move |s, app| {
        verify(s, app)?;
        s.with(|c| {
            let n = c.execute("DELETE FROM passkeys WHERE id = ?1", [&id])?;
            if n == 0 {
                return Err(AppError::NotFound("Passkey".into()));
            }
            Ok(())
        })
    })
    .await
}

/// The way back when no passkey can answer any more (a reset Windows Hello
/// container, a lost security key): forget every passkey and clear every
/// lock. It protects nothing that reading `kern.db` wouldn't already give
/// up, and without it a lost authenticator would strand a project for good.
#[tauri::command]
pub fn passkeys_reset(state: State<AppState>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        tx.execute("DELETE FROM passkeys", [])?;
        tx.execute("UPDATE projects SET locked_at = NULL, updated_at = ?1 WHERE locked_at IS NOT NULL", [now_ms()])?;
        tx.commit()?;
        Ok(())
    })?;
    close(None);
    Ok(())
}

#[tauri::command]
pub fn locked_projects_list(state: State<AppState>) -> AppResult<Vec<LockedProject>> {
    state.with(|c| locked_projects(c))
}

#[tauri::command]
pub fn project_set_locked(state: State<AppState>, id: String, locked: bool) -> AppResult<()> {
    state.with(|c| set_lock(c, &id, locked))
}

/// Opens one locked project for this session.
#[tauri::command]
pub async fn project_unlock(app: AppHandle, id: String) -> AppResult<()> {
    blocking(&app, move |s, app| {
        let needed = s.with(|c| {
            if !is_locked(c, &id) {
                return invalid("That project isn't locked.");
            }
            Ok(enforced(c))
        })?;
        if !needed {
            return invalid("No passkey is registered on this computer, so its lock isn't being enforced here.");
        }
        verify(s, app)?;
        s.with(|c| {
            mark_open(c, &id);
            Ok(())
        })
    })
    .await
}

/// "Lock now", for one project or all of them.
#[tauri::command]
pub fn project_relock(id: Option<String>) {
    close(id.as_deref());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::projects::{create_project, ProjectInput};

    /// The session state is process-wide, so these tests take turns.
    fn serially() -> std::sync::MutexGuard<'static, ()> {
        static L: OnceLock<Mutex<()>> = OnceLock::new();
        let m = L.get_or_init(Default::default);
        let g = match m.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        close(None);
        g
    }

    fn project(c: &Connection, name: &str) -> String {
        create_project(c, &ProjectInput { name: name.into(), ..Default::default() }).unwrap().id
    }

    fn add_passkey(c: &Connection) {
        c.execute(
            "INSERT INTO passkeys(id, label, credential_id, kind, created_at) VALUES ('p1', 'Hello', 'Y3JlZA', 'platform', 1)",
            [],
        )
        .unwrap();
    }

    #[test]
    fn locks_need_a_passkey_on_this_computer() {
        let _g = serially();
        let c = open_memory();
        let id = project(&c, "Mini Reactors");
        assert!(set_lock(&c, &id, true).is_err(), "nothing to open it with");
        add_passkey(&c);
        set_lock(&c, &id, true).unwrap();
        assert!(is_locked(&c, &id));
        assert!(!readable(&c, &id));
        assert!(ensure_readable(&c, &id).is_err());
    }

    #[test]
    fn a_lock_from_another_computer_stays_inert_without_a_passkey() {
        let _g = serially();
        let c = open_memory();
        let id = project(&c, "Mini Reactors");
        c.execute("UPDATE projects SET locked_at = 1 WHERE id = ?1", [&id]).unwrap();
        assert!(!enforced(&c));
        assert!(readable(&c, &id), "otherwise the project could never be opened here");
        assert_eq!(readable_sql(&c, "t.project_id"), "1");
    }

    #[test]
    fn the_filter_hides_only_shut_projects() {
        let _g = serially();
        let c = open_memory();
        let shut = project(&c, "Locked");
        let open = project(&c, "Open");
        add_passkey(&c);
        set_lock(&c, &shut, true).unwrap();
        set_lock(&c, &open, true).unwrap();

        let sql = readable_sql(&c, "t.project_id");
        assert!(sql.contains(&shut) && sql.contains(&open), "both are shut to begin with");

        mark_open(&c, &open);
        let sql = readable_sql(&c, "t.project_id");
        assert!(sql.contains(&shut), "still hidden");
        assert!(!sql.contains(&open), "opened this session");
        assert!(readable(&c, &open) && !readable(&c, &shut));

        // Unlocking the project itself is only allowed once it's open.
        assert!(set_lock(&c, &shut, false).is_err());
        set_lock(&c, &open, false).unwrap();
        assert!(!is_locked(&c, &open));
        close(None);
    }

    #[test]
    fn relocking_closes_a_project_again() {
        let _g = serially();
        let c = open_memory();
        let id = project(&c, "Mini Reactors");
        add_passkey(&c);
        set_lock(&c, &id, true).unwrap();
        mark_open(&c, &id);
        assert!(readable(&c, &id));
        close(Some(&id));
        assert!(!readable(&c, &id));
    }

    #[test]
    fn a_time_limit_closes_a_project_on_its_own() {
        let _g = serially();
        let c = open_memory();
        let id = project(&c, "Mini Reactors");
        add_passkey(&c);
        set_lock(&c, &id, true).unwrap();
        settings::set(&c, "privacy.passkeyRelockMinutes", &serde_json::json!(15)).unwrap();
        mark_open(&c, &id);
        assert!(readable(&c, &id));
        // Backdate the permission past its window.
        opened().lock().unwrap().insert(id.clone(), Some(now_ms() - 1));
        assert!(!readable(&c, &id));
        close(None);
    }

    #[test]
    fn reset_clears_every_lock() {
        let _g = serially();
        let c = open_memory();
        let id = project(&c, "Mini Reactors");
        add_passkey(&c);
        set_lock(&c, &id, true).unwrap();
        c.execute("DELETE FROM passkeys", []).unwrap();
        c.execute("UPDATE projects SET locked_at = NULL WHERE locked_at IS NOT NULL", []).unwrap();
        assert!(!is_locked(&c, &id));
        assert!(list(&c).unwrap().is_empty());
    }

    /// The gate as the read paths actually use it: a locked project's task
    /// leaves every list and can't be fetched by id either.
    #[test]
    fn locked_content_leaves_the_read_paths() {
        use crate::domain::tasks::{create_task, get_task, query_tasks, TaskInput, TaskQuery};
        let _g = serially();
        let c = open_memory();
        let id = project(&c, "Mini Reactors");
        let task = create_task(&c, &TaskInput { title: "Shield check".into(), project_id: Some(id.clone()), ..Default::default() }).unwrap();
        let loose = create_task(&c, &TaskInput { title: "Buy milk".into(), ..Default::default() }).unwrap();
        let visible = |c: &Connection| query_tasks(c, &TaskQuery::default()).unwrap().into_iter().map(|t| t.id).collect::<Vec<_>>();
        assert!(visible(&c).contains(&task.id));

        add_passkey(&c);
        set_lock(&c, &id, true).unwrap();
        let after = visible(&c);
        assert!(!after.contains(&task.id), "a locked project's task is in nobody's list");
        assert!(after.contains(&loose.id), "a task with no project is unaffected");
        assert!(get_task(&c, &task.id).is_err(), "nor by id");
        assert!(get_task(&c, &loose.id).is_ok());

        mark_open(&c, &id);
        assert!(visible(&c).contains(&task.id), "and comes back once opened");
        assert!(get_task(&c, &task.id).is_ok());
        close(None);
    }

    /// The project row itself stays visible - that's how you reach the
    /// unlock prompt - but it carries no counts.
    #[test]
    fn a_locked_project_keeps_its_name_and_loses_its_numbers() {
        use crate::domain::projects::get_project;
        use crate::domain::tasks::{create_task, TaskInput};
        let _g = serially();
        let c = open_memory();
        let id = project(&c, "Mini Reactors");
        create_task(&c, &TaskInput { title: "Shield check".into(), project_id: Some(id.clone()), ..Default::default() }).unwrap();
        assert_eq!(get_project(&c, &id).unwrap().task_total, 1);

        add_passkey(&c);
        set_lock(&c, &id, true).unwrap();
        let p = get_project(&c, &id).unwrap();
        assert_eq!(p.name, "Mini Reactors");
        assert!(p.locked_at.is_some() && !p.unlocked);
        assert_eq!(p.task_total, 0, "counts are not a preview of locked content");

        mark_open(&c, &id);
        let p = get_project(&c, &id).unwrap();
        assert!(p.unlocked);
        assert_eq!(p.task_total, 1);
        close(None);
    }

    /// The surfaces that don't go through `query_tasks` or `get_project`:
    /// each one is its own way into a project's content, so each is checked.
    #[test]
    fn every_read_surface_refuses_while_locked() {
        use crate::domain::tasks::{create_task, TaskInput};
        use crate::domain::{archive, comments, envvars, fileindex, folders, milestones};
        let _g = serially();
        let c = open_memory();
        let id = project(&c, "Mini Reactors");
        let task = create_task(&c, &TaskInput { title: "Shield check".into(), project_id: Some(id.clone()), ..Default::default() }).unwrap();
        milestones::create(&c, &milestones::MilestoneInput { project_id: id.clone(), title: "First criticality".into(), target_date: Some("2030-01-01".into()), ..Default::default() }).unwrap();
        envvars::create_profile(&c, &id, "Development").unwrap();
        let dir = tempfile::tempdir().unwrap();
        folders::link(&c, &id, &dir.path().to_string_lossy(), folders::Trust::Restricted).unwrap();

        // Everything is reachable before the lock.
        assert!(comments::list(&c, &task.id).is_ok());
        assert!(milestones::list(&c, &id).is_ok());
        assert_eq!(milestones::upcoming(&c, "2031-01-01", 20).unwrap().len(), 1);
        assert!(envvars::profiles(&c, &id).is_ok());
        assert_eq!(fileindex::roots(&c, None).unwrap().len(), 1);
        assert!(archive::tasks_csv(&c).unwrap().contains("Shield check"));
        assert!(archive::projects_json(&c, None).is_ok());

        add_passkey(&c);
        set_lock(&c, &id, true).unwrap();
        assert!(comments::list(&c, &task.id).is_err(), "comment text");
        assert!(milestones::list(&c, &id).is_err(), "milestones of the project");
        assert!(milestones::upcoming(&c, "2031-01-01", 20).unwrap().is_empty(), "and in the cross-project list");
        assert!(envvars::profiles(&c, &id).is_err(), "environment values");
        assert!(fileindex::roots(&c, None).unwrap().is_empty(), "file names and code");
        assert!(folders::root_of(&c, &id).is_err(), "files, terminals, git, dev tools");
        assert!(!archive::tasks_csv(&c).unwrap().contains("Shield check"), "CSV export");
        assert!(archive::projects_json(&c, None).is_err(), "JSON export says why rather than omitting it");

        mark_open(&c, &id);
        assert!(comments::list(&c, &task.id).is_ok());
        assert!(milestones::list(&c, &id).is_ok());
        assert!(envvars::profiles(&c, &id).is_ok());
        assert_eq!(fileindex::roots(&c, None).unwrap().len(), 1);
        assert!(archive::tasks_csv(&c).unwrap().contains("Shield check"));
        close(None);
    }

    #[test]
    fn only_plain_ids_reach_spliced_sql() {
        assert!(plain_id("0199a0b1-2c3d-7e4f-8a9b-0c1d2e3f4a5b"));
        assert!(!plain_id("'; DROP TABLE tasks; --"));
        assert!(!plain_id(""));
    }
}
