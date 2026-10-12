//! Project folders on disk, workspace trust and the project file browser.
//!
//! A Kern project and a folder are separate things: a project may be linked
//! to one folder, and removing the link or deleting the project never touches
//! the folder. Every file operation goes through these commands, which
//! resolve the requested path against the linked folder's canonical root and
//! refuse anything that escapes it (`..`, absolute paths, symlinks pointing
//! elsewhere). Trust is recorded per canonical folder and applies to that
//! exact folder only.
//!
//! Restricted folders can be browsed, revealed and their documents opened.
//! Programs and scripts are never opened in restricted mode; in a trusted
//! folder they open only after a separate, explicit confirmation. Creating,
//! renaming, duplicating and deleting items (deletes go to the
//! Recycle Bin) require trust. Nothing ever runs automatically.

use crate::domain::settings;
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::now_ms;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

// ------------------------------------------------------------ paths

/// Removes Windows' verbatim prefix so paths display and compare normally.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// Resolves symlinks, junctions, `.`/`..` and relative segments.
pub fn canonical(path: &Path) -> AppResult<PathBuf> {
    std::fs::canonicalize(path).map(strip_verbatim).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound(format!("Folder '{}'", path.display())),
        std::io::ErrorKind::PermissionDenied => AppError::Invalid(format!("Kern doesn't have permission to read '{}'.", path.display())),
        _ => AppError::Io(e),
    })
}

/// Comparison key for a canonical path: case-insensitive on Windows and macOS.
pub fn folder_key(canonical: &Path) -> String {
    let s = canonical.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    if cfg!(any(windows, target_os = "macos")) {
        s.to_lowercase()
    } else {
        s
    }
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    let (r, c) = (folder_key(root), folder_key(candidate));
    c == r || c.starts_with(&format!("{r}{}", std::path::MAIN_SEPARATOR))
}

/// Joins a user-supplied relative path onto `root` and verifies the result
/// (after resolving links) is still inside `root`.
pub fn resolve_inside(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let rel_path = Path::new(rel);
    for c in rel_path.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return invalid("That path isn't inside the project folder."),
        }
    }
    let joined = root.join(rel_path);
    let resolved = canonical(&joined)?;
    if !is_within(root, &resolved) {
        return invalid("That item links outside the project folder, so Kern won't open it.");
    }
    Ok(resolved)
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default()
}

// ------------------------------------------------------------ classification

const PROGRAM_EXTS: &[&str] = &[
    "exe", "com", "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msp", "msix", "appx", "scr", "pif",
    "lnk", "url", "reg", "hta", "cpl", "jar", "sh", "bash", "zsh", "fish", "command", "app", "appimage", "run", "py", "pyw", "rb", "pl",
    "php", "dll", "sys", "inf", "application", "gadget", "ws", "scf", "xll", "docm", "xlsm", "pptm",
];

/// Programs, scripts and other files that run code when "opened".
pub fn is_program(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if PROGRAM_EXTS.contains(&ext.as_str()) {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(m) = std::fs::metadata(path) {
            return m.is_file() && m.permissions().mode() & 0o111 != 0;
        }
    }
    false
}

/// Files that commonly hold secrets; never offered to AI features.
pub fn is_sensitive(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == ".env"
        || n.starts_with(".env.")
        || n.ends_with(".pem")
        || n.ends_with(".key")
        || n.ends_with(".p12")
        || n.ends_with(".pfx")
        || n.ends_with(".kdbx")
        || n.starts_with("id_rsa")
        || n.starts_with("id_ed25519")
        || n == ".npmrc"
        || n == ".netrc"
        || n == ".pgpass"
        || n.contains("credentials")
        || n.contains("secret")
}

// ------------------------------------------------------------ trust

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Trust {
    Trusted,
    Restricted,
}

impl Trust {
    fn as_str(self) -> &'static str {
        match self {
            Trust::Trusted => "trusted",
            Trust::Restricted => "restricted",
        }
    }
    fn parse(s: &str) -> Trust {
        if s == "trusted" {
            Trust::Trusted
        } else {
            Trust::Restricted
        }
    }
}

pub fn trust_of(conn: &Connection, key: &str) -> AppResult<Option<Trust>> {
    Ok(conn
        .query_row("SELECT trust FROM trusted_workspaces WHERE folder_key = ?1", [key], |r| r.get::<_, String>(0))
        .optional()?
        .map(|s| Trust::parse(&s)))
}

pub fn set_trust(conn: &Connection, canonical: &Path, trust: Trust) -> AppResult<()> {
    conn.execute(
        "INSERT INTO trusted_workspaces(folder_key, path, trust, decided_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(folder_key) DO UPDATE SET trust = excluded.trust, path = excluded.path, decided_at = excluded.decided_at",
        params![folder_key(canonical), canonical.to_string_lossy(), trust.as_str(), now_ms()],
    )?;
    Ok(())
}

/// With "Remember trusted folders" off, trust lasts one session: every
/// trusted folder starts the next launch restricted.
pub fn apply_trust_retention(conn: &Connection) -> AppResult<()> {
    if !settings::get_or(conn, "projects.rememberTrust", true) {
        conn.execute("UPDATE trusted_workspaces SET trust = 'restricted' WHERE trust = 'trusted'", [])?;
    }
    Ok(())
}

// ------------------------------------------------------------ inspection

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    /// Canonical path (links and aliases resolved).
    pub path: String,
    pub name: String,
    /// Previously recorded trust for exactly this folder, if any.
    pub trust: Option<Trust>,
    /// Kern projects already linked to it.
    pub linked_projects: Vec<String>,
}

pub fn inspect(conn: &Connection, path: &str) -> AppResult<FolderInfo> {
    let canon = canonical(Path::new(path.trim()))?;
    if !canon.is_dir() {
        return invalid("Choose a folder rather than a file.");
    }
    let key = folder_key(&canon);
    let mut stmt = conn.prepare(
        "SELECT p.name FROM project_folder_links l JOIN projects p ON p.id = l.project_id WHERE l.folder_key = ?1 AND p.deleted_at IS NULL",
    )?;
    let linked_projects = stmt.query_map([&key], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
    Ok(FolderInfo {
        name: canon.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| canon.to_string_lossy().to_string()),
        path: canon.to_string_lossy().to_string(),
        trust: trust_of(conn, &key)?,
        linked_projects,
    })
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub browse: bool,
    pub open_documents: bool,
    /// Programs and scripts: trusted folders only, each run confirmed.
    pub open_programs: bool,
    /// Creating, renaming, duplicating and deleting (to the Recycle Bin) items.
    pub modify: bool,
    /// AI features may read files (needs trust, the project's own permission
    /// and the global privacy setting).
    pub ai_files: bool,
    pub ai_files_reason: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolder {
    pub project_id: String,
    pub path: String,
    pub name: String,
    /// ok | missing | not_directory | inaccessible
    pub status: String,
    pub trust: Trust,
    pub capabilities: Capabilities,
    pub linked_at: i64,
}

fn link_row(conn: &Connection, project_id: &str) -> AppResult<Option<(String, String, i64)>> {
    Ok(conn
        .query_row(
            "SELECT path, folder_key, linked_at FROM project_folder_links WHERE project_id = ?1",
            [project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?)
}

pub fn ai_file_access(conn: &Connection, project_id: &str, trust: Trust) -> (bool, Option<String>) {
    let global: bool = settings::get_or(conn, "privacy.aiLinkedFolders", false);
    let prefs: String = conn
        .query_row("SELECT ai_prefs FROM projects WHERE id = ?1", [project_id], |r| r.get(0))
        .unwrap_or_else(|_| "{}".into());
    let project_allows = serde_json::from_str::<serde_json::Value>(&prefs)
        .ok()
        .and_then(|v| v.get("fileAccess").and_then(|b| b.as_bool()))
        .unwrap_or(false);
    if trust != Trust::Trusted {
        (false, Some("The folder is in restricted mode.".into()))
    } else if !global {
        (false, Some("AI access to linked folders is off in Privacy settings.".into()))
    } else if !project_allows {
        (false, Some("This project hasn't allowed AI file access.".into()))
    } else {
        (true, None)
    }
}

pub fn project_folder(conn: &Connection, project_id: &str) -> AppResult<Option<ProjectFolder>> {
    let Some((path, key, linked_at)) = link_row(conn, project_id)? else { return Ok(None) };
    let p = PathBuf::from(&path);
    let status = match std::fs::metadata(&p) {
        Ok(m) if m.is_dir() => "ok",
        Ok(_) => "not_directory",
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "missing",
        Err(_) => "inaccessible",
    };
    let trust = trust_of(conn, &key)?.unwrap_or(Trust::Restricted);
    let ok = status == "ok";
    let (ai_files, ai_files_reason) = ai_file_access(conn, project_id, trust);
    Ok(Some(ProjectFolder {
        project_id: project_id.to_string(),
        name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.clone()),
        path,
        status: status.into(),
        trust,
        capabilities: Capabilities {
            browse: ok,
            open_documents: ok,
            open_programs: ok && trust == Trust::Trusted,
            modify: ok && trust == Trust::Trusted,
            ai_files: ok && ai_files,
            ai_files_reason: if ok { ai_files_reason } else { Some("The folder isn't available.".into()) },
        },
        linked_at,
    }))
}

/// Links (or relinks) a project to a folder and records the user's trust
/// decision for exactly that folder.
pub fn link(conn: &Connection, project_id: &str, path: &str, trust: Trust) -> AppResult<ProjectFolder> {
    let exists: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM projects WHERE id = ?1)", [project_id], |r| r.get(0))?;
    if !exists {
        return Err(AppError::NotFound("Project".into()));
    }
    let canon = canonical(Path::new(path.trim()))?;
    if !canon.is_dir() {
        return invalid("Choose a folder rather than a file.");
    }
    set_trust(conn, &canon, trust)?;
    conn.execute(
        "INSERT INTO project_folder_links(project_id, path, folder_key, linked_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(project_id) DO UPDATE SET path = excluded.path, folder_key = excluded.folder_key, linked_at = excluded.linked_at",
        params![project_id, canon.to_string_lossy(), folder_key(&canon), now_ms()],
    )?;
    let name = canon.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| canon.to_string_lossy().to_string());
    crate::domain::activity::log(conn, Some(project_id), "project", project_id, "linked", &name)?;
    project_folder(conn, project_id)?.ok_or_else(|| AppError::Other("Folder link vanished".into()))
}

/// Removes the association only. The folder and its files are untouched.
pub fn unlink(conn: &Connection, project_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM project_folder_links WHERE project_id = ?1", [project_id])?;
    Ok(())
}

/// The canonical root of a project's folder, re-verified on every call.
pub fn root_of(conn: &Connection, project_id: &str) -> AppResult<(PathBuf, Trust)> {
    let Some((path, key, _)) = link_row(conn, project_id)? else {
        return invalid("This project isn't linked to a folder.");
    };
    let canon = canonical(Path::new(&path)).map_err(|_| AppError::NotFound(format!("The linked folder '{path}'")))?;
    // If the stored path now resolves somewhere else (e.g. it became a link
    // to another location), the old trust decision doesn't carry over.
    let trust = if folder_key(&canon) == key { trust_of(conn, &key)?.unwrap_or(Trust::Restricted) } else { Trust::Restricted };
    Ok((canon, trust))
}

// ------------------------------------------------------------ browsing

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// Path relative to the folder root, with forward slashes.
    pub rel: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: Option<u64>,
    pub modified: Option<i64>,
    pub program: bool,
    pub sensitive: bool,
    pub hidden: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub rel: String,
    pub entries: Vec<FileEntry>,
    /// More entries exist than were returned.
    pub truncated: bool,
}

const MAX_ENTRIES: usize = 5000;

fn hidden(name: &str, meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x2 != 0 {
            return true;
        }
    }
    let _ = meta;
    name.starts_with('.')
}

pub fn list_dir(root: &Path, rel: &str) -> AppResult<DirListing> {
    let dir = if rel.trim().is_empty() { root.to_path_buf() } else { resolve_inside(root, rel)? };
    if !dir.is_dir() {
        return invalid("That isn't a folder.");
    }
    let mut entries = vec![];
    let mut truncated = false;
    for e in std::fs::read_dir(&dir)?.flatten() {
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let name = e.file_name().to_string_lossy().to_string();
        // symlink_metadata: never follow links just to list them.
        let Ok(lmeta) = e.file_type().and_then(|_| std::fs::symlink_metadata(e.path())) else { continue };
        let is_link = lmeta.file_type().is_symlink();
        let meta = if is_link { std::fs::metadata(e.path()).unwrap_or(lmeta.clone()) } else { lmeta.clone() };
        let path = e.path();
        entries.push(FileEntry {
            rel: rel_of(root, &path),
            is_dir: meta.is_dir(),
            is_link,
            size: if meta.is_file() { Some(meta.len()) } else { None },
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64),
            program: meta.is_file() && is_program(&path),
            sensitive: is_sensitive(&name),
            hidden: hidden(&name, &lmeta),
            name,
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(DirListing { rel: rel_of(root, &dir), entries, truncated })
}

fn valid_name(name: &str) -> AppResult<String> {
    let n = name.trim();
    if n.is_empty() || n == "." || n == ".." || n.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) || n.chars().any(|c| c.is_control()) {
        return invalid("That name isn't allowed. Avoid / \\ : * ? \" < > | and leading dots-only names.");
    }
    Ok(n.trim_end_matches('.').to_string())
}

// ------------------------------------------------------------ commands

async fn blocking<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&AppState) -> AppResult<T> + Send + 'static) -> AppResult<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>()))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn folder_inspect(app: AppHandle, path: String) -> AppResult<FolderInfo> {
    blocking(&app, move |s| s.with(|c| inspect(c, &path))).await
}

#[tauri::command]
pub async fn project_folder_get(app: AppHandle, project_id: String) -> AppResult<Option<ProjectFolder>> {
    blocking(&app, move |s| s.with(|c| project_folder(c, &project_id))).await
}

#[tauri::command]
pub async fn project_folder_link(app: AppHandle, project_id: String, path: String, trust: Trust) -> AppResult<ProjectFolder> {
    blocking(&app, move |s| {
        s.with(|c| {
            let tx = c.transaction()?;
            let f = link(&tx, &project_id, &path, trust)?;
            tx.commit()?;
            Ok(f)
        })
    })
    .await
}

#[tauri::command]
pub fn project_folder_unlink(state: tauri::State<AppState>, project_id: String) -> AppResult<()> {
    state.with(|c| unlink(c, &project_id))
}

/// Changes the trust of a project's folder (trust or restrict).
#[tauri::command]
pub async fn project_folder_set_trust(app: AppHandle, project_id: String, trust: Trust) -> AppResult<ProjectFolder> {
    blocking(&app, move |s| {
        s.with(|c| {
            let (root, _) = root_of(c, &project_id)?;
            set_trust(c, &root, trust)?;
            project_folder(c, &project_id)?.ok_or_else(|| AppError::NotFound("Folder link".into()))
        })
    })
    .await
}

#[tauri::command]
pub async fn project_files_list(app: AppHandle, project_id: String, rel: String) -> AppResult<DirListing> {
    blocking(&app, move |s| {
        let (root, _) = s.with(|c| root_of(c, &project_id))?;
        list_dir(&root, &rel)
    })
    .await
}

/// Opens a file with its default application. Programs and scripts need a
/// trusted folder and an explicit confirmation for this specific open.
#[tauri::command]
pub async fn project_file_open(app: AppHandle, project_id: String, rel: String, confirmed_program: Option<bool>) -> AppResult<()> {
    let handle = app.clone();
    blocking(&app, move |s| {
        let (root, trust) = s.with(|c| root_of(c, &project_id))?;
        let target = if rel.is_empty() { root.clone() } else { resolve_inside(&root, &rel)? };
        if target.is_file() && is_program(&target) {
            if trust != Trust::Trusted {
                return invalid("Programs and scripts can't be opened from a folder in restricted mode. Trust the folder first.");
            }
            if confirmed_program != Some(true) {
                return Err(AppError::Invalid("confirm_program".into()));
            }
        }
        handle.opener().open_path(target.to_string_lossy(), None::<&str>).map_err(|e| AppError::Other(e.to_string()))
    })
    .await
}

#[tauri::command]
pub async fn project_file_reveal(app: AppHandle, project_id: String, rel: String) -> AppResult<()> {
    let handle = app.clone();
    blocking(&app, move |s| {
        let (root, _) = s.with(|c| root_of(c, &project_id))?;
        let target = if rel.is_empty() { root } else { resolve_inside(&root, &rel)? };
        handle.opener().reveal_item_in_dir(target).map_err(|e| AppError::Other(e.to_string()))
    })
    .await
}

/// Absolute path of an item (for "Copy path"); verified to be inside the folder.
#[tauri::command]
pub async fn project_file_path(app: AppHandle, project_id: String, rel: String) -> AppResult<String> {
    blocking(&app, move |s| {
        let (root, _) = s.with(|c| root_of(c, &project_id))?;
        let target = if rel.is_empty() { root } else { resolve_inside(&root, &rel)? };
        Ok(target.to_string_lossy().to_string())
    })
    .await
}

#[tauri::command]
pub async fn project_folder_create(app: AppHandle, project_id: String, parent_rel: String, name: String) -> AppResult<String> {
    blocking(&app, move |s| {
        let (root, trust) = s.with(|c| root_of(c, &project_id))?;
        if trust != Trust::Trusted {
            return invalid("Creating folders needs a trusted folder.");
        }
        let parent = if parent_rel.is_empty() { root.clone() } else { resolve_inside(&root, &parent_rel)? };
        let target = parent.join(valid_name(&name)?);
        if target.exists() {
            return invalid("Something with that name already exists.");
        }
        std::fs::create_dir(&target)?;
        Ok(rel_of(&root, &target))
    })
    .await
}

#[tauri::command]
pub async fn project_file_rename(app: AppHandle, project_id: String, rel: String, new_name: String) -> AppResult<String> {
    blocking(&app, move |s| {
        let (root, trust) = s.with(|c| root_of(c, &project_id))?;
        if trust != Trust::Trusted {
            return invalid("Renaming needs a trusted folder.");
        }
        if rel.is_empty() {
            return invalid("The project folder itself can't be renamed from Kern.");
        }
        let src = resolve_inside(&root, &rel)?;
        let dest = src.parent().ok_or_else(|| AppError::Invalid("Can't rename that.".into()))?.join(valid_name(&new_name)?);
        if dest.exists() {
            return invalid("Something with that name already exists.");
        }
        std::fs::rename(&src, &dest)?;
        Ok(rel_of(&root, &dest))
    })
    .await
}

/// The item itself (not what a link points to): the parent folder is
/// resolved and verified, the final name is taken as-is.
fn entry_inside(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let p = Path::new(rel);
    let name = p.file_name().ok_or_else(|| AppError::Invalid("The project folder itself can't be changed from Kern.".into()))?;
    let parent_rel = p.parent().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
    let parent = if parent_rel.is_empty() { root.to_path_buf() } else { resolve_inside(root, &parent_rel)? };
    let target = parent.join(valid_name(&name.to_string_lossy())?);
    if std::fs::symlink_metadata(&target).is_err() {
        return Err(AppError::NotFound(format!("'{rel}'")));
    }
    Ok(target)
}

#[tauri::command]
pub async fn project_file_create(app: AppHandle, project_id: String, parent_rel: String, name: String) -> AppResult<String> {
    blocking(&app, move |s| {
        let (root, trust) = s.with(|c| root_of(c, &project_id))?;
        if trust != Trust::Trusted {
            return invalid("Creating files needs a trusted folder.");
        }
        let parent = if parent_rel.is_empty() { root.clone() } else { resolve_inside(&root, &parent_rel)? };
        let target = parent.join(valid_name(&name)?);
        std::fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => AppError::Invalid("Something with that name already exists.".into()),
            _ => AppError::Io(e),
        })?;
        Ok(rel_of(&root, &target))
    })
    .await
}

/// "name.ext" → "name copy.ext", then "name copy 2.ext", …
fn copy_name(dir: &Path, name: &str) -> PathBuf {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..)
        .map(|n| dir.join(if n == 1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {n}{ext}") }))
        .find(|p| std::fs::symlink_metadata(p).is_err())
        .expect("unbounded")
}

/// Duplicates a file next to itself. Folders aren't duplicated.
#[tauri::command]
pub async fn project_file_duplicate(app: AppHandle, project_id: String, rel: String) -> AppResult<String> {
    blocking(&app, move |s| {
        let (root, trust) = s.with(|c| root_of(c, &project_id))?;
        if trust != Trust::Trusted {
            return invalid("Duplicating needs a trusted folder.");
        }
        let src = entry_inside(&root, &rel)?;
        if !std::fs::symlink_metadata(&src)?.is_file() {
            return invalid("Only files can be duplicated.");
        }
        let dir = src.parent().ok_or_else(|| AppError::Invalid("Can't duplicate that.".into()))?;
        let dest = copy_name(dir, &src.file_name().unwrap_or_default().to_string_lossy());
        std::fs::copy(&src, &dest)?;
        Ok(rel_of(&root, &dest))
    })
    .await
}

/// Moves a file or folder to the system Recycle Bin / Trash, never a
/// permanent delete. A link is removed itself; its target is untouched.
#[tauri::command]
pub async fn project_file_trash(app: AppHandle, project_id: String, rel: String) -> AppResult<()> {
    blocking(&app, move |s| {
        let (root, trust) = s.with(|c| root_of(c, &project_id))?;
        if trust != Trust::Trusted {
            return invalid("Deleting needs a trusted folder.");
        }
        let target = entry_inside(&root, &rel)?;
        os_trash::delete(&target).map_err(|e| AppError::Other(format!("Couldn't move it to the Recycle Bin ({e}).")))
    })
    .await
}

// ------------------------------------------------------------ viewing & editing

const MAX_TEXT: u64 = 2 * 1024 * 1024;
const MAX_IMAGE: u64 = 30 * 1024 * 1024;

fn modified_ms(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    /// Contents with line endings normalised to "\n".
    pub text: String,
    /// The file used Windows line endings; saving restores them.
    pub crlf: bool,
    /// The file started with a UTF-8 byte-order mark; saving keeps it.
    pub bom: bool,
    pub modified: Option<i64>,
    pub size: u64,
    /// Editing needs a trusted folder.
    pub read_only: bool,
}

/// Splits raw bytes into text and the details needed to write them back
/// unchanged: BOM and line-ending style.
pub fn decode_text(bytes: &[u8]) -> AppResult<(String, bool, bool)> {
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return invalid("This looks like a binary file, so Kern can't show it as text.");
    }
    let (bom, body) = match bytes.strip_prefix(b"\xEF\xBB\xBF") {
        Some(rest) => (true, rest),
        None => (false, bytes),
    };
    let text = std::str::from_utf8(body).map_err(|_| AppError::Invalid("This file isn't UTF-8 text, so Kern can't show it.".into()))?;
    let crlf = text.contains("\r\n");
    Ok((if crlf { text.replace("\r\n", "\n") } else { text.to_string() }, crlf, bom))
}

pub fn encode_text(text: &str, crlf: bool, bom: bool) -> Vec<u8> {
    let body = if crlf { text.replace("\r\n", "\n").replace('\n', "\r\n") } else { text.to_string() };
    let mut out = Vec::with_capacity(body.len() + 3);
    if bom {
        out.extend_from_slice(b"\xEF\xBB\xBF");
    }
    out.extend_from_slice(body.as_bytes());
    out
}

#[tauri::command]
pub async fn project_file_read(app: AppHandle, project_id: String, rel: String) -> AppResult<FileText> {
    blocking(&app, move |s| {
        let (root, trust) = s.with(|c| root_of(c, &project_id))?;
        let path = resolve_inside(&root, &rel)?;
        let meta = std::fs::metadata(&path)?;
        if !meta.is_file() {
            return invalid("That isn't a file.");
        }
        if meta.len() > MAX_TEXT {
            return invalid("This file is over 2 MB, which is too large for Kern's viewer. Open it in your editor instead.");
        }
        let (text, crlf, bom) = decode_text(&std::fs::read(&path)?)?;
        Ok(FileText { text, crlf, bom, modified: modified_ms(&meta), size: meta.len(), read_only: trust != Trust::Trusted })
    })
    .await
}

/// Saves edited text. Refuses when the file changed on disk since it was
/// read (`expected_modified`), so another editor's work is never overwritten.
#[tauri::command]
pub async fn project_file_write(app: AppHandle, project_id: String, rel: String, text: String, crlf: bool, bom: bool, expected_modified: Option<i64>) -> AppResult<Option<i64>> {
    blocking(&app, move |s| {
        let (root, trust) = s.with(|c| root_of(c, &project_id))?;
        if trust != Trust::Trusted {
            return invalid("Editing files needs a trusted folder.");
        }
        let path = resolve_inside(&root, &rel)?;
        let meta = std::fs::metadata(&path)?;
        if !meta.is_file() {
            return invalid("That isn't a file.");
        }
        if expected_modified.is_some() && modified_ms(&meta) != expected_modified {
            return invalid("The file changed on disk since you opened it. Reload it to see the latest version.");
        }
        let bytes = encode_text(&text, crlf, bom);
        if bytes.len() as u64 > MAX_TEXT * 2 {
            return invalid("That's too much text to save from Kern.");
        }
        // Write beside the file, then swap it in, so a failed save never leaves a half-written file.
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let tmp = path.with_file_name(format!(".{name}.kern-saving"));
        std::fs::write(&tmp, &bytes)?;
        if let Err(e) = std::fs::rename(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
        Ok(std::fs::metadata(&path).ok().and_then(|m| modified_ms(&m)))
    })
    .await
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// An image as a data URL for the in-app viewer (the webview can't read
/// project folders directly).
#[tauri::command]
pub async fn project_file_image(app: AppHandle, project_id: String, rel: String) -> AppResult<String> {
    use base64::Engine;
    blocking(&app, move |s| {
        let (root, _) = s.with(|c| root_of(c, &project_id))?;
        let path = resolve_inside(&root, &rel)?;
        let mime = image_mime(&path).ok_or_else(|| AppError::Invalid("Kern can't preview that kind of image.".into()))?;
        let meta = std::fs::metadata(&path)?;
        if !meta.is_file() || meta.len() > MAX_IMAGE {
            return invalid("This image is too large to preview.");
        }
        let bytes = std::fs::read(&path)?;
        Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    })
    .await
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrustRecord {
    pub path: String,
    pub trust: Trust,
    pub decided_at: i64,
    pub projects: Vec<String>,
    pub exists: bool,
}

#[tauri::command]
pub fn trusted_folders_list(state: tauri::State<AppState>) -> AppResult<Vec<TrustRecord>> {
    state.with(|c| {
        let mut stmt = c.prepare("SELECT folder_key, path, trust, decided_at FROM trusted_workspaces ORDER BY path COLLATE NOCASE")?;
        let rows: Vec<(String, String, String, i64)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?;
        let mut out = vec![];
        for (key, path, trust, decided_at) in rows {
            let mut ps = c.prepare(
                "SELECT p.name FROM project_folder_links l JOIN projects p ON p.id = l.project_id WHERE l.folder_key = ?1 AND p.deleted_at IS NULL",
            )?;
            let projects = ps.query_map([&key], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            out.push(TrustRecord { exists: Path::new(&path).is_dir(), path, trust: Trust::parse(&trust), decided_at, projects });
        }
        Ok(out)
    })
}

/// Revokes trust (restricted) or forgets the decision entirely (the next
/// link asks again; linked projects fall back to restricted).
#[tauri::command]
pub fn trusted_folder_update(state: tauri::State<AppState>, path: String, trust: Option<Trust>) -> AppResult<()> {
    state.with(|c| {
        let key = folder_key(Path::new(&path));
        match trust {
            Some(t) => c.execute("UPDATE trusted_workspaces SET trust = ?1, decided_at = ?2 WHERE folder_key = ?3", params![t.as_str(), now_ms(), key])?,
            None => c.execute("DELETE FROM trusted_workspaces WHERE folder_key = ?1", [key])?,
        };
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::projects::{create_project, ProjectInput};

    fn project(c: &Connection) -> String {
        create_project(c, &ProjectInput { name: "Mini Reactors".into(), ..Default::default() }).unwrap().id
    }

    #[test]
    fn resolve_rejects_escapes() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("a.txt"), "x").unwrap();
        assert!(resolve_inside(&root, "src/a.txt").is_ok());
        assert!(resolve_inside(&root, "../").is_err());
        assert!(resolve_inside(&root, "src/../../etc").is_err());
        let abs = if cfg!(windows) { r"C:\Windows" } else { "/etc" };
        assert!(resolve_inside(&root, abs).is_err());
        // A sibling whose name merely starts with the root's name is outside.
        let outside = tempfile::tempdir().unwrap();
        assert!(!is_within(&root, &canonical(outside.path()).unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_pointing_outside_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
        assert!(resolve_inside(&root, "escape").is_err());
    }

    #[test]
    fn link_records_trust_for_that_folder_only() {
        let c = open_memory();
        let pid = project(&c);
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let f = link(&c, &pid, &a.path().to_string_lossy(), Trust::Trusted).unwrap();
        assert_eq!(f.trust, Trust::Trusted);
        assert!(f.capabilities.open_programs && f.capabilities.modify);
        // Changing folders doesn't inherit the old folder's trust.
        let info = inspect(&c, &b.path().to_string_lossy()).unwrap();
        assert_eq!(info.trust, None);
        let f = link(&c, &pid, &b.path().to_string_lossy(), Trust::Restricted).unwrap();
        assert_eq!(f.trust, Trust::Restricted);
        assert!(f.capabilities.browse && f.capabilities.open_documents);
        assert!(!f.capabilities.open_programs && !f.capabilities.modify && !f.capabilities.ai_files);
        // The first folder keeps its own decision.
        assert_eq!(inspect(&c, &a.path().to_string_lossy()).unwrap().trust, Some(Trust::Trusted));
    }

    #[test]
    fn missing_folder_keeps_project_and_reports_status() {
        let c = open_memory();
        let pid = project(&c);
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("moved-away");
        std::fs::create_dir(&sub).unwrap();
        link(&c, &pid, &sub.to_string_lossy(), Trust::Trusted).unwrap();
        std::fs::remove_dir(&sub).unwrap();
        let f = project_folder(&c, &pid).unwrap().unwrap();
        assert_eq!(f.status, "missing");
        assert!(!f.capabilities.browse);
        assert!(crate::domain::projects::get_project(&c, &pid).is_ok());
    }

    #[test]
    fn deleting_a_project_never_touches_its_folder() {
        let c = open_memory();
        let pid = project(&c);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("keep.txt"), "important").unwrap();
        link(&c, &pid, &dir.path().to_string_lossy(), Trust::Trusted).unwrap();
        // Trash, then purge permanently (the strongest delete): only the link row goes.
        c.execute("UPDATE projects SET deleted_at = 1 WHERE id = ?1", [&pid]).unwrap();
        assert!(dir.path().join("keep.txt").exists());
        crate::domain::trash::purge(&c, "project", &pid).unwrap();
        assert!(dir.path().join("keep.txt").exists());
        let links: i64 = c.query_row("SELECT count(*) FROM project_folder_links", [], |r| r.get(0)).unwrap();
        assert_eq!(links, 0);
    }

    #[test]
    fn ai_file_access_needs_trust_project_and_privacy() {
        let c = open_memory();
        let pid = project(&c);
        let dir = tempfile::tempdir().unwrap();
        link(&c, &pid, &dir.path().to_string_lossy(), Trust::Trusted).unwrap();
        assert!(!project_folder(&c, &pid).unwrap().unwrap().capabilities.ai_files);
        settings::set(&c, "privacy.aiLinkedFolders", &serde_json::json!(true)).unwrap();
        assert!(!project_folder(&c, &pid).unwrap().unwrap().capabilities.ai_files, "trust alone isn't permission");
        c.execute("UPDATE projects SET ai_prefs = '{\"fileAccess\":true}' WHERE id = ?1", [&pid]).unwrap();
        assert!(project_folder(&c, &pid).unwrap().unwrap().capabilities.ai_files);
    }

    #[test]
    fn trust_retention_off_downgrades_on_launch() {
        let c = open_memory();
        let dir = tempfile::tempdir().unwrap();
        set_trust(&c, &canonical(dir.path()).unwrap(), Trust::Trusted).unwrap();
        settings::set(&c, "projects.rememberTrust", &serde_json::json!(false)).unwrap();
        apply_trust_retention(&c).unwrap();
        let key = folder_key(&canonical(dir.path()).unwrap());
        assert_eq!(trust_of(&c, &key).unwrap(), Some(Trust::Restricted));
    }

    #[test]
    fn classifies_programs_and_secrets() {
        assert!(is_program(Path::new("setup.EXE")) && is_program(Path::new("build.ps1")));
        assert!(!is_program(Path::new("notes.md")));
        assert!(is_sensitive(".env") && is_sensitive(".env.local") && is_sensitive("server.pem"));
        assert!(!is_sensitive("README.md"));
    }

    #[test]
    fn copy_names_and_entries() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        std::fs::write(root.join("a.txt"), "x").unwrap();
        assert_eq!(copy_name(&root, "a.txt"), root.join("a copy.txt"));
        std::fs::write(root.join("a copy.txt"), "x").unwrap();
        assert_eq!(copy_name(&root, "a.txt"), root.join("a copy 2.txt"));
        assert_eq!(copy_name(&root, ".env"), root.join(".env copy"));
        assert_eq!(entry_inside(&root, "a.txt").unwrap(), root.join("a.txt"));
        assert!(entry_inside(&root, "missing.txt").is_err());
        assert!(entry_inside(&root, "").is_err());
        assert!(entry_inside(&root, "../a.txt").is_err());
    }

    #[test]
    fn text_round_trips_bom_and_line_endings() {
        let raw = b"\xEF\xBB\xBFone\r\ntwo\r\n";
        let (text, crlf, bom) = decode_text(raw).unwrap();
        assert_eq!((text.as_str(), crlf, bom), ("one\ntwo\n", true, true));
        assert_eq!(encode_text(&format!("{text}three"), crlf, bom), b"\xEF\xBB\xBFone\r\ntwo\r\nthree".to_vec());
        assert_eq!(encode_text("a\nb", false, false), b"a\nb".to_vec());
        assert!(decode_text(b"PNG\0\0data").is_err());
        assert!(decode_text(&[0xff, 0xfe, 0x41]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn entry_inside_keeps_the_link_itself() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        std::fs::create_dir(root.join("real")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        assert_eq!(entry_inside(&root, "link").unwrap(), root.join("link"));
    }
}
