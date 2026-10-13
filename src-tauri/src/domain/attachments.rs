//! Attachments and managed files.
//!
//! Managed files are copied into `<data>/attachments/` and referenced by a
//! path *relative* to that directory, so backups restore correctly on
//! another machine. External references keep their absolute path and are
//! checked for availability when displayed.

use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms, safe_file_name};
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub task_id: Option<String>,
    pub project_id: Option<String>,
    pub name: String,
    pub path: String,
    pub abs_path: String,
    pub managed: bool,
    pub mime: Option<String>,
    pub size: i64,
    pub exists: bool,
    pub created_at: i64,
}

pub fn mime_for(name: &str) -> Option<String> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    let m = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "zip" => "application/zip",
        "doc" | "docx" => "application/msword",
        "xls" | "xlsx" => "application/vnd.ms-excel",
        "ppt" | "pptx" => "application/vnd.ms-powerpoint",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        _ => return None,
    };
    Some(m.into())
}

fn resolve(root: &Path, path: &str, managed: bool) -> PathBuf {
    if managed {
        root.join(path)
    } else {
        PathBuf::from(path)
    }
}

/// Copies `src` into managed storage under `sub/`; returns the relative path.
pub fn store_copy(root: &Path, sub: &str, src: &Path) -> AppResult<(String, i64)> {
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let id = new_id();
    let rel = format!("{sub}/{id}/{}", safe_file_name(name));
    let dest = root.join(&rel);
    std::fs::create_dir_all(dest.parent().unwrap())?;
    let size = std::fs::copy(src, &dest)? as i64;
    Ok((rel, size))
}

pub fn store_bytes(root: &Path, sub: &str, name: &str, bytes: &[u8]) -> AppResult<String> {
    let id = new_id();
    let rel = format!("{sub}/{id}/{}", safe_file_name(name));
    let dest = root.join(&rel);
    std::fs::create_dir_all(dest.parent().unwrap())?;
    // Write to a temp file then rename: no partially-written attachments.
    let tmp = dest.with_extension("partial");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &dest)?;
    Ok(rel)
}

fn remove_managed(root: &Path, rel: &str) {
    let p = root.join(rel);
    let _ = std::fs::remove_file(&p);
    if let Some(parent) = p.parent() {
        // Remove the per-file directory if now empty.
        let _ = std::fs::remove_dir(parent);
    }
}

fn attachments_root(conn: &Connection) -> Option<PathBuf> {
    // Written at every startup (see lib.rs) so service functions that only
    // hold a connection can locate managed files.
    conn.query_row("SELECT value FROM settings WHERE key = 'internal.attachmentsDir'", [], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<String>(&s).ok())
        .map(PathBuf::from)
}

pub fn remove_files_for_task(conn: &Connection, task_id: &str) -> AppResult<()> {
    let Some(root) = attachments_root(conn) else { return Ok(()) };
    let mut stmt = conn.prepare(
        "WITH RECURSIVE d(id) AS (SELECT ?1 UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id)
         SELECT path FROM attachments WHERE managed = 1 AND task_id IN (SELECT id FROM d)",
    )?;
    let paths: Vec<String> = stmt.query_map([task_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for p in paths {
        remove_managed(&root, &p);
    }
    Ok(())
}

pub fn remove_files_for_project(conn: &Connection, project_id: &str) -> AppResult<()> {
    let Some(root) = attachments_root(conn) else { return Ok(()) };
    let mut stmt = conn.prepare("SELECT path FROM attachments WHERE managed = 1 AND project_id = ?1")?;
    let paths: Vec<String> = stmt.query_map([project_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for p in paths {
        remove_managed(&root, &p);
    }
    Ok(())
}

fn list(conn: &Connection, root: &Path, task_id: Option<&str>, project_id: Option<&str>) -> AppResult<Vec<Attachment>> {
    let mut stmt = conn.prepare(
        "SELECT id, task_id, project_id, name, path, managed, mime, size, created_at FROM attachments
         WHERE (?1 IS NOT NULL AND task_id = ?1) OR (?1 IS NULL AND ?2 IS NOT NULL AND project_id = ?2)
         ORDER BY created_at",
    )?;
    let rows = stmt.query_map(params![task_id, project_id], |r| {
        let path: String = r.get(4)?;
        let managed = r.get::<_, i64>(5)? != 0;
        let mime: Option<String> = r.get(6)?;
        let is_link = mime.as_deref() == Some(LINK_MIME);
        let abs = resolve(root, &path, managed);
        Ok(Attachment {
            id: r.get(0)?,
            task_id: r.get(1)?,
            project_id: r.get(2)?,
            name: r.get(3)?,
            exists: is_link || abs.exists(),
            abs_path: abs.to_string_lossy().to_string(),
            path,
            managed,
            mime,
            size: r.get(7)?,
            created_at: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn attachments_list(
    state: State<AppState>,
    task_id: Option<String>,
    project_id: Option<String>,
) -> AppResult<Vec<Attachment>> {
    let root = state.paths.attachments_dir.clone();
    state.with(|c| list(c, &root, task_id.as_deref(), project_id.as_deref()))
}

/// Attaches a file. `managed` copies it into app storage; otherwise only a
/// reference to the original location is kept.
#[tauri::command]
pub fn attachment_add(
    state: State<AppState>,
    source_path: String,
    task_id: Option<String>,
    project_id: Option<String>,
    managed: Option<bool>,
) -> AppResult<Attachment> {
    if task_id.is_none() && project_id.is_none() {
        return invalid("An attachment needs a task or a project.");
    }
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(AppError::NotFound(format!("File '{}'", source_path)));
    }
    let managed = managed.unwrap_or(true);
    let root = state.paths.attachments_dir.clone();
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
    let (path, size) = if managed {
        store_copy(&root, "files", &src)?
    } else {
        (source_path.clone(), std::fs::metadata(&src).map(|m| m.len() as i64).unwrap_or(0))
    };
    state.with(|c| {
        let id = new_id();
        c.execute(
            "INSERT INTO attachments(id, task_id, project_id, name, path, managed, mime, size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, task_id, project_id, name, path, managed as i64, mime_for(&name), size, now_ms()],
        )?;
        let all = list(c, &root, task_id.as_deref(), if task_id.is_some() { None } else { project_id.as_deref() })?;
        all.into_iter().find(|a| a.id == id).ok_or_else(|| AppError::Other("Attachment vanished".into()))
    })
}

#[tauri::command]
pub fn attachment_delete(state: State<AppState>, id: String) -> AppResult<()> {
    let root = state.paths.attachments_dir.clone();
    state.with(|c| {
        let row: Option<(String, i64)> = c
            .query_row("SELECT path, managed FROM attachments WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        c.execute("DELETE FROM attachments WHERE id = ?1", [&id])?;
        if let Some((path, 1)) = row {
            remove_managed(&root, &path);
        }
        Ok(())
    })
}

/// Web links attached to a task or project are stored as unmanaged
/// attachments with this type; `path` holds the URL.
pub const LINK_MIME: &str = "text/uri-list";

#[tauri::command]
pub fn attachment_add_link(
    state: State<AppState>,
    url: String,
    title: Option<String>,
    task_id: Option<String>,
    project_id: Option<String>,
) -> AppResult<Attachment> {
    if task_id.is_none() && project_id.is_none() {
        return invalid("A link needs a task or a project.");
    }
    let mut u = url.trim().to_string();
    if !u.contains("://") && !u.starts_with("mailto:") {
        u = format!("https://{u}");
    }
    let parsed = url::Url::parse(&u).map_err(|_| AppError::Invalid("That isn't a valid web address.".into()))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return invalid("Only web and email links can be attached.");
    }
    let name = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).unwrap_or_else(|| parsed.to_string());
    let root = state.paths.attachments_dir.clone();
    state.with(|c| {
        let id = new_id();
        c.execute(
            "INSERT INTO attachments(id, task_id, project_id, name, path, managed, mime, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 0, ?7)",
            params![id, task_id, project_id, name.chars().take(300).collect::<String>(), parsed.to_string(), LINK_MIME, now_ms()],
        )?;
        let all = list(c, &root, task_id.as_deref(), if task_id.is_some() { None } else { project_id.as_deref() })?;
        all.into_iter().find(|a| a.id == id).ok_or_else(|| AppError::Other("Attachment vanished".into()))
    })
}

#[tauri::command]
pub fn attachment_rename(state: State<AppState>, id: String, name: String) -> AppResult<()> {
    let n = name.trim();
    if n.is_empty() {
        return invalid("The name can't be empty.");
    }
    state.with(|c| {
        c.execute("UPDATE attachments SET name = ?1 WHERE id = ?2", params![n, id])?;
        Ok(())
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoredAsset {
    /// Path relative to the attachments directory.
    pub path: String,
    pub abs_path: String,
    pub name: String,
    pub size: i64,
}

/// Copies a dropped file (e.g. a whiteboard image) into managed storage.
#[tauri::command]
pub fn asset_import(state: State<AppState>, source_path: String) -> AppResult<StoredAsset> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(AppError::NotFound(format!("File '{}'", source_path)));
    }
    let root = &state.paths.attachments_dir;
    let (path, size) = store_copy(root, "wb", &src)?;
    Ok(StoredAsset {
        abs_path: root.join(&path).to_string_lossy().to_string(),
        name: src.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string(),
        path,
        size,
    })
}

/// Stores raw bytes (pasted images) into managed storage.
#[tauri::command]
pub fn asset_import_bytes(state: State<AppState>, name: String, data_base64: String) -> AppResult<StoredAsset> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|_| AppError::Invalid("Image data is malformed.".into()))?;
    if bytes.len() > 50 * 1024 * 1024 {
        return invalid("Images larger than 50 MB aren't supported.");
    }
    let root = &state.paths.attachments_dir;
    let path = store_bytes(root, "wb", &name, &bytes)?;
    Ok(StoredAsset {
        abs_path: root.join(&path).to_string_lossy().to_string(),
        name,
        path,
        size: bytes.len() as i64,
    })
}

/// Reads a managed file (relative to the attachments folder) as base64, so
/// the interface can compress a whiteboard image before sharing it.
#[tauri::command]
pub fn attachment_read_base64(state: State<AppState>, path: String) -> AppResult<String> {
    if path.is_empty() || path.contains("..") || Path::new(&path).is_absolute() {
        return invalid("That isn't a managed file.");
    }
    let p = state.paths.attachments_dir.join(&path);
    let meta = std::fs::metadata(&p).map_err(|_| AppError::NotFound("The image file".into()))?;
    if meta.len() > 50 * 1024 * 1024 {
        return invalid("Images larger than 50 MB can't be shared.");
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(std::fs::read(&p)?))
}

/// Removes whiteboard assets no longer referenced by any whiteboard object
/// (including whiteboards in the trash).
pub fn cleanup_orphan_assets(conn: &Connection, root: &Path) -> AppResult<usize> {
    let wb_dir = root.join("wb");
    let Ok(entries) = std::fs::read_dir(&wb_dir) else { return Ok(0) };
    let mut removed = 0;
    for e in entries.flatten() {
        let dir_name = e.file_name().to_string_lossy().to_string();
        let referenced: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM wb_nodes WHERE instr(data, ?1) > 0)",
            [format!("wb/{dir_name}/")],
            |r| r.get(0),
        )?;
        if !referenced {
            // Grace period: never remove assets younger than a day (they may
            // belong to an edit that hasn't been saved yet).
            let young = e
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| t.elapsed().map(|d| d.as_secs() < 86_400).unwrap_or(true))
                .unwrap_or(true);
            if !young && std::fs::remove_dir_all(e.path()).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}
