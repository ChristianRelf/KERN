// @Author Christian Relf
// @Date 2026-10-12

//! Backups, exports and restore.
//!
//! One versioned archive format (zip) serves both backups and full exports:
//!
//! ```text
//! manifest.json        format, formatVersion, schemaVersion, appVersion, createdAt, kind, counts
//! kern.db              consistent SQLite snapshot (VACUUM INTO - safe on a live database)
//! attachments/...      managed attachment files
//! data/<table>.json    (exports) every table as JSON rows
//! notes/*.md           (exports) notes as Markdown with front matter
//! whiteboards/*.json   (exports) whiteboard scenes
//! settings.json        (exports) settings as a JSON object
//! ```
//!
//! Restore validates the archive (manifest, integrity check, schema
//! version), writes a safety backup of the current data, copies the
//! snapshot into the live connection with SQLite's online backup API,
//! migrates it if it came from an older version and swaps attachments.

use crate::db::{self, SCHEMA_VERSION};
use crate::domain::{settings, stats::dir_size, whiteboards};
use crate::error::{invalid, AppError, AppResult};
use crate::state::{AppState, Paths};
use crate::util::{new_id, now_ms, safe_file_name};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use zip::write::SimpleFileOptions;

pub const FORMAT: &str = "kern-archive";
pub const FORMAT_VERSION: i64 = 1;

const TABLES: &[&str] = &[
    "settings",
    "project_groups",
    "projects",
    "labels",
    "boards",
    "board_columns",
    "tasks",
    "task_labels",
    "task_relations",
    "task_comments",
    "templates",
    "habits",
    "habit_checks",
    "calendar_feeds",
    "attachments",
    "notes",
    "inbox_items",
    "whiteboards",
    "wb_nodes",
    "wb_edges",
    "dashboards",
    "daily_snapshots",
    "activity",
    "focus_sessions",
    "saved_views",
    "project_repositories",
    "git_worktrees",
    "task_dev_links",
    "milestones",
    "milestone_deps",
    "release_links",
    "work_sessions",
    "session_links",
    "workspace_state",
    "workspace_snapshots",
    "project_layouts",
    "project_commands",
    "env_profiles",
    "env_variables",
    "local_services",
];

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub format_version: i64,
    pub schema_version: i64,
    pub app_version: String,
    pub created_at: i64,
    pub kind: String,
    pub counts: Map<String, Value>,
    #[serde(default)]
    pub portable: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    pub manifest: Manifest,
}

fn counts(conn: &Connection) -> AppResult<Map<String, Value>> {
    let mut m = Map::new();
    for (k, sql) in [
        ("projects", "SELECT count(*) FROM projects WHERE deleted_at IS NULL"),
        ("tasks", "SELECT count(*) FROM tasks WHERE deleted_at IS NULL"),
        ("notes", "SELECT count(*) FROM notes WHERE deleted_at IS NULL"),
        ("whiteboards", "SELECT count(*) FROM whiteboards WHERE deleted_at IS NULL"),
        ("attachments", "SELECT count(*) FROM attachments"),
    ] {
        let n: i64 = conn.query_row(sql, [], |r| r.get(0))?;
        m.insert(k.into(), json!(n));
    }
    Ok(m)
}

fn tmp_dir(paths: &Paths) -> AppResult<PathBuf> {
    let d = paths.data_dir.join("tmp");
    std::fs::create_dir_all(&d)?;
    Ok(d)
}

pub fn backups_dir(conn: &Connection, paths: &Paths) -> PathBuf {
    settings::get::<String>(conn, "backups.dir")
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.default_backups_dir.clone())
}

fn add_dir(zw: &mut zip::ZipWriter<File>, root: &Path, dir: &Path, prefix: &str, opts: SimpleFileOptions) -> AppResult<()> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            add_dir(zw, root, &p, prefix, opts)?;
        } else {
            let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
            if rel.ends_with(".partial") {
                continue;
            }
            zw.start_file(format!("{prefix}/{rel}"), opts)?;
            let mut f = File::open(&p)?;
            std::io::copy(&mut f, zw)?;
        }
    }
    Ok(())
}

fn value_to_json(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => {
            let s = String::from_utf8_lossy(t).to_string();
            json!(s)
        }
        ValueRef::Blob(b) => {
            use base64::Engine;
            json!(base64::engine::general_purpose::STANDARD.encode(b))
        }
    }
}

pub fn dump_table(conn: &Connection, table: &str) -> AppResult<Vec<Value>> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table}"))?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query([])?;
    let mut out = vec![];
    while let Some(r) = rows.next()? {
        let mut obj = Map::new();
        for (i, n) in names.iter().enumerate() {
            obj.insert(n.clone(), value_to_json(r.get_ref(i)?));
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

fn unique_name(used: &mut std::collections::HashSet<String>, base: &str, ext: &str) -> String {
    let base = safe_file_name(if base.trim().is_empty() { "Untitled" } else { base });
    let mut name = format!("{base}.{ext}");
    let mut i = 2;
    while used.contains(&name.to_lowercase()) {
        name = format!("{base} ({i}).{ext}");
        i += 1;
    }
    used.insert(name.to_lowercase());
    name
}

pub fn note_markdown(title: &str, content: &str, project: Option<&str>, created: i64, updated: i64) -> String {
    let ts = |ms: i64| {
        chrono::DateTime::from_timestamp_millis(ms)
            .map(|d| d.to_rfc3339())
            .unwrap_or_default()
    };
    let esc = |s: &str| s.replace('"', "\\\"");
    let mut out = String::from("---\n");
    out.push_str(&format!("title: \"{}\"\n", esc(title)));
    if let Some(p) = project {
        out.push_str(&format!("project: \"{}\"\n", esc(p)));
    }
    out.push_str(&format!("created: {}\nupdated: {}\n---\n\n", ts(created), ts(updated)));
    if !title.trim().is_empty() && !content.trim_start().starts_with("# ") {
        out.push_str(&format!("# {}\n\n", title.trim()));
    }
    out.push_str(content);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Writes an archive to `dest`. Atomic: written to a temp name and renamed.
pub fn create_archive(
    conn: &Connection,
    paths: &Paths,
    app_version: &str,
    dest: &Path,
    kind: &str,
    portable: bool,
) -> AppResult<BackupInfo> {
    let tmp = tmp_dir(paths)?;
    let snapshot = tmp.join(format!("snapshot-{}.db", new_id()));
    conn.execute("VACUUM INTO ?1", [snapshot.to_string_lossy().to_string()])?;

    let manifest = Manifest {
        format: FORMAT.into(),
        format_version: FORMAT_VERSION,
        schema_version: SCHEMA_VERSION,
        app_version: app_version.into(),
        created_at: now_ms(),
        kind: kind.into(),
        counts: counts(conn)?,
        portable,
    };
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = dest.with_extension("zip.partial");
    let result = (|| -> AppResult<()> {
        let file = File::create(&partial)?;
        let mut zw = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        zw.start_file("manifest.json", opts)?;
        zw.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
        zw.start_file("kern.db", opts)?;
        std::io::copy(&mut File::open(&snapshot)?, &mut zw)?;
        add_dir(&mut zw, &paths.attachments_dir, &paths.attachments_dir, "attachments", opts)?;

        if portable {
            zw.start_file("README.md", opts)?;
            zw.write_all(PORTABLE_README.as_bytes())?;
            for t in TABLES {
                zw.start_file(format!("data/{t}.json"), opts)?;
                zw.write_all(serde_json::to_string_pretty(&dump_table(conn, t)?)?.as_bytes())?;
            }
            let all_settings = settings::get_all(conn)?;
            zw.start_file("settings.json", opts)?;
            zw.write_all(serde_json::to_string_pretty(&all_settings)?.as_bytes())?;
            // Notes as Markdown.
            let mut used = std::collections::HashSet::new();
            let mut stmt = conn.prepare(
                "SELECT n.title, n.content, p.name, n.created_at, n.updated_at FROM notes n
                 LEFT JOIN projects p ON p.id = n.project_id WHERE n.deleted_at IS NULL ORDER BY n.created_at",
            )?;
            let notes: Vec<(String, String, Option<String>, i64, i64)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
                .collect::<Result<_, _>>()?;
            for (title, content, project, created, updated) in notes {
                let name = unique_name(&mut used, &title, "md");
                zw.start_file(format!("notes/{name}"), opts)?;
                zw.write_all(note_markdown(&title, &content, project.as_deref(), created, updated).as_bytes())?;
            }
            // Whiteboards as JSON scenes.
            let mut used = std::collections::HashSet::new();
            let mut stmt = conn.prepare("SELECT id FROM whiteboards WHERE deleted_at IS NULL")?;
            let ids: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            for id in ids {
                let wb = whiteboards::get(conn, &id)?;
                let doc = json!({
                    "format": "kern-whiteboard", "formatVersion": 1,
                    "whiteboard": wb, "nodes": whiteboards::nodes(conn, &id)?, "edges": whiteboards::edges(conn, &id)?,
                });
                let name = unique_name(&mut used, &wb.name, "json");
                zw.start_file(format!("whiteboards/{name}"), opts)?;
                zw.write_all(serde_json::to_string_pretty(&doc)?.as_bytes())?;
            }
        }
        zw.finish()?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&snapshot);
    if let Err(e) = result {
        let _ = std::fs::remove_file(&partial);
        return Err(e);
    }
    std::fs::rename(&partial, dest)?;
    Ok(BackupInfo {
        path: dest.to_string_lossy().to_string(),
        file_name: dest.file_name().unwrap_or_default().to_string_lossy().to_string(),
        size: std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0),
        manifest,
    })
}

const PORTABLE_README: &str = "# Kern export

This archive is a complete, portable copy of your Kern data.

- `manifest.json` - archive format/version, app and schema versions, item counts.
- `kern.db` - a SQLite database snapshot. Open it with any SQLite tool, or
  restore it in Kern (Settings → Data & Backups → Restore).
- `data/*.json` - every table as plain JSON rows (dates are local YYYY-MM-DD,
  timestamps are UTC epoch milliseconds).
- `notes/*.md` - notes as Markdown with YAML front matter.
- `whiteboards/*.json` - whiteboard scenes (objects and connections); these can
  be imported individually from any whiteboard's menu.
- `attachments/` - managed files referenced by relative paths in the data.
";

pub fn read_manifest(path: &Path) -> AppResult<Manifest> {
    let file = File::open(path)?;
    let mut za = zip::ZipArchive::new(file).map_err(|_| AppError::Invalid("This file isn't a Kern backup.".into()))?;
    let mut f = za
        .by_name("manifest.json")
        .map_err(|_| AppError::Invalid("This file isn't a Kern backup (no manifest).".into()))?;
    let mut s = String::new();
    f.read_to_string(&mut s)?;
    let m: Manifest = serde_json::from_str(&s).map_err(|_| AppError::Invalid("The backup manifest is unreadable.".into()))?;
    if m.format != FORMAT {
        return invalid("This file isn't a Kern backup.");
    }
    if m.format_version > FORMAT_VERSION || m.schema_version > SCHEMA_VERSION {
        return invalid("This backup was made by a newer version of the app. Update the app to restore it.");
    }
    Ok(m)
}

/// Extracts and validates the database from an archive. Returns the temp path.
fn extract_db(path: &Path, tmp: &Path) -> AppResult<PathBuf> {
    let file = File::open(path)?;
    let mut za = zip::ZipArchive::new(file)?;
    let mut f = za.by_name("kern.db").map_err(|_| AppError::Invalid("The backup has no database.".into()))?;
    let out = tmp.join(format!("restore-{}.db", new_id()));
    let mut o = File::create(&out)?;
    std::io::copy(&mut f, &mut o)?;
    o.sync_all()?;
    Ok(out)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub manifest: Manifest,
    pub valid: bool,
    pub problems: Vec<String>,
    pub counts: Map<String, Value>,
    pub has_attachments: bool,
}

pub fn preview(paths: &Paths, path: &Path) -> AppResult<RestorePreview> {
    let manifest = read_manifest(path)?;
    let tmp = tmp_dir(paths)?;
    let db_path = extract_db(path, &tmp)?;
    let mut problems = vec![];
    let mut found = Map::new();
    {
        let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).unwrap_or_else(|e| e.to_string());
        if check != "ok" {
            problems.push(format!("Integrity check failed: {check}"));
        }
        let v = db::user_version(&conn)?;
        if v > SCHEMA_VERSION {
            problems.push("Created by a newer version of the app.".into());
        }
        if v < 1 {
            problems.push("The database is empty or not a Kern database.".into());
        } else {
            match counts(&conn) {
                Ok(c) => found = c,
                Err(e) => problems.push(format!("Couldn't read the data: {e}")),
            }
        }
    }
    let _ = std::fs::remove_file(&db_path);
    let has_attachments = {
        let file = File::open(path)?;
        let za = zip::ZipArchive::new(file)?;
        let found = za.file_names().any(|n| n.map(|n| n.starts_with("attachments/")).unwrap_or(false));
        found
    };
    Ok(RestorePreview { valid: problems.is_empty(), manifest, problems, counts: found, has_attachments })
}

pub fn restore(conn: &mut Connection, paths: &Paths, app_version: &str, path: &Path) -> AppResult<BackupInfo> {
    let p = preview(paths, path)?;
    if !p.valid {
        return invalid(format!("This backup can't be restored: {}", p.problems.join(" ")));
    }
    // 1. Safety copy of the current data.
    let dir = backups_dir(conn, paths);
    let safety = dir.join(format!("kern-backup-{}-pre-restore.zip", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    let safety_info = create_archive(conn, paths, app_version, &safety, "pre-restore", false)?;

    // 2. Database via the online backup API into the live connection.
    let tmp = tmp_dir(paths)?;
    let db_path = extract_db(path, &tmp)?;
    {
        let src = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let backup = rusqlite::backup::Backup::new(&src, conn)?;
        backup.run_to_completion(512, std::time::Duration::ZERO, None)?;
    }
    let _ = std::fs::remove_file(&db_path);
    db::configure(conn)?;
    db::migrate(conn)?;
    settings::set(conn, "internal.attachmentsDir", &json!(paths.attachments_dir.to_string_lossy()))?;

    // 3. Attachments: extract to a staging dir, then swap.
    let staging = paths.data_dir.join(format!("attachments.restore-{}", new_id()));
    std::fs::create_dir_all(&staging)?;
    {
        let file = File::open(path)?;
        let mut za = zip::ZipArchive::new(file)?;
        for i in 0..za.len() {
            let mut f = za.by_index(i)?;
            let Some(name) = f.enclosed_name() else { continue };
            let Ok(rel) = name.strip_prefix("attachments") else { continue };
            if f.is_dir() || rel.as_os_str().is_empty() {
                continue;
            }
            let out = staging.join(rel);
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut o = File::create(&out)?;
            std::io::copy(&mut f, &mut o)?;
        }
    }
    let old = paths.data_dir.join(format!("attachments.old-{}", new_id()));
    if paths.attachments_dir.exists() {
        std::fs::rename(&paths.attachments_dir, &old)?;
    }
    if let Err(e) = std::fs::rename(&staging, &paths.attachments_dir) {
        // Put the previous files back rather than leaving none.
        let _ = std::fs::rename(&old, &paths.attachments_dir);
        return Err(e.into());
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(safety_info)
}

pub fn list_backups(dir: &Path) -> Vec<BackupInfo> {
    let mut out = vec![];
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
            if !(name.starts_with("kern-backup-") && name.ends_with(".zip")) {
                continue;
            }
            if let Ok(manifest) = read_manifest(&p) {
                out.push(BackupInfo {
                    path: p.to_string_lossy().to_string(),
                    file_name: name,
                    size: e.metadata().map(|m| m.len()).unwrap_or(0),
                    manifest,
                });
            }
        }
    }
    out.sort_by(|a, b| b.manifest.created_at.cmp(&a.manifest.created_at));
    out
}

/// Keeps the newest `keep` automatic backups.
pub fn prune_auto(dir: &Path, keep: usize) {
    let autos: Vec<BackupInfo> = list_backups(dir).into_iter().filter(|b| b.manifest.kind == "auto").collect();
    for b in autos.iter().skip(keep.max(1)) {
        let _ = std::fs::remove_file(&b.path);
    }
}

/// Creates an automatic backup if one is due. Returns the backup if made.
pub fn auto_backup_if_due(conn: &Connection, paths: &Paths, app_version: &str) -> AppResult<Option<BackupInfo>> {
    let freq: String = settings::get_or(conn, "backups.frequency", "daily".to_string());
    let interval = match freq.as_str() {
        "daily" => 86_400_000,
        "weekly" => 7 * 86_400_000,
        _ => return Ok(None),
    };
    let last: i64 = settings::get_or(conn, "internal.lastAutoBackup", 0);
    if now_ms() - last < interval {
        return Ok(None);
    }
    let dir = backups_dir(conn, paths);
    let dest = dir.join(format!("kern-backup-{}.zip", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    let info = create_archive(conn, paths, app_version, &dest, "auto", false)?;
    settings::set(conn, "internal.lastAutoBackup", &json!(now_ms()))?;
    let keep: i64 = settings::get_or(conn, "backups.keep", 10);
    prune_auto(&dir, keep as usize);
    Ok(Some(info))
}

// ------------------------------------------------------------- exports

fn csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

pub fn tasks_csv(conn: &Connection) -> AppResult<String> {
    let mut out = String::from(
        "id,title,status,priority,project,parent_id,due_date,due_time,start_date,labels,estimate_minutes,tracked_minutes,created_at,completed_at,archived,description\r\n",
    );
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.status, t.priority, p.name, t.parent_id, t.due_date, t.due_time, t.start_date,
           (SELECT group_concat(l.name, '; ') FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = t.id),
           t.estimate_minutes, t.tracked_seconds / 60, t.created_at, t.completed_at, t.archived_at IS NOT NULL, t.description
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.deleted_at IS NULL ORDER BY p.sort_order, t.sort_order",
    )?;
    let prio = ["none", "low", "medium", "high", "urgent"];
    let ts = |v: Option<i64>| {
        v.and_then(chrono::DateTime::from_timestamp_millis)
            .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_default()
    };
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let p: i64 = r.get(3)?;
        let fields = [
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            prio.get(p as usize).unwrap_or(&"none").to_string(),
            r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            r.get::<_, Option<String>>(5)?.unwrap_or_default(),
            r.get::<_, Option<String>>(6)?.unwrap_or_default(),
            r.get::<_, Option<String>>(7)?.unwrap_or_default(),
            r.get::<_, Option<String>>(8)?.unwrap_or_default(),
            r.get::<_, Option<String>>(9)?.unwrap_or_default(),
            r.get::<_, Option<i64>>(10)?.map(|v| v.to_string()).unwrap_or_default(),
            r.get::<_, i64>(11)?.to_string(),
            ts(Some(r.get(12)?)),
            ts(r.get(13)?),
            if r.get::<_, bool>(14)? { "yes".into() } else { "no".into() },
            r.get::<_, String>(15)?,
        ];
        out.push_str(&fields.iter().map(|f| csv_field(f)).collect::<Vec<_>>().join(","));
        out.push_str("\r\n");
    }
    Ok(out)
}

pub fn notes_to_dir(conn: &Connection, dir: &Path) -> AppResult<usize> {
    std::fs::create_dir_all(dir)?;
    let mut stmt = conn.prepare(
        "SELECT n.title, n.content, p.name, n.created_at, n.updated_at FROM notes n
         LEFT JOIN projects p ON p.id = n.project_id WHERE n.deleted_at IS NULL ORDER BY n.created_at",
    )?;
    let notes: Vec<(String, String, Option<String>, i64, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<Result<_, _>>()?;
    let mut used = std::collections::HashSet::new();
    // Avoid clobbering files already in the folder.
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            used.insert(e.file_name().to_string_lossy().to_lowercase());
        }
    }
    for (title, content, project, created, updated) in &notes {
        let name = unique_name(&mut used, title, "md");
        crate::domain::system::atomic_write(
            &dir.join(name),
            note_markdown(title, content, project.as_deref(), *created, *updated).as_bytes(),
        )?;
    }
    Ok(notes.len())
}

pub fn projects_json(conn: &Connection, ids: Option<Vec<String>>) -> AppResult<Value> {
    let all = crate::domain::projects::list_projects(conn, true)?;
    let selected: Vec<_> = all.into_iter().filter(|p| ids.as_ref().map(|i| i.contains(&p.id)).unwrap_or(true)).collect();
    let labels = dump_table(conn, "labels")?;
    let mut projects = vec![];
    for p in selected {
        let rows = |sql: &str| -> AppResult<Vec<Value>> {
            let mut stmt = conn.prepare(sql)?;
            let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
            let mut q = stmt.query([&p.id])?;
            let mut out = vec![];
            while let Some(r) = q.next()? {
                let mut o = Map::new();
                for (i, n) in names.iter().enumerate() {
                    o.insert(n.clone(), value_to_json(r.get_ref(i)?));
                }
                out.push(Value::Object(o));
            }
            Ok(out)
        };
        let boards = rows("SELECT * FROM boards WHERE project_id = ?1")?;
        let columns = rows("SELECT c.* FROM board_columns c JOIN boards b ON b.id = c.board_id WHERE b.project_id = ?1")?;
        let tasks = rows("SELECT t.*, (SELECT group_concat(label_id) FROM task_labels WHERE task_id = t.id) AS label_ids FROM tasks t WHERE t.project_id = ?1 AND t.deleted_at IS NULL")?;
        let notes = rows("SELECT * FROM notes WHERE project_id = ?1 AND deleted_at IS NULL")?;
        let mut wbs = vec![];
        let mut stmt = conn.prepare("SELECT id FROM whiteboards WHERE project_id = ?1 AND deleted_at IS NULL")?;
        let wb_ids: Vec<String> = stmt.query_map([&p.id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        for w in wb_ids {
            wbs.push(json!({
                "whiteboard": whiteboards::get(conn, &w)?,
                "nodes": whiteboards::nodes(conn, &w)?,
                "edges": whiteboards::edges(conn, &w)?,
            }));
        }
        projects.push(json!({
            "project": p, "boards": boards, "columns": columns, "tasks": tasks, "notes": notes, "whiteboards": wbs,
        }));
    }
    Ok(json!({
        "format": "kern-projects", "formatVersion": 1, "schemaVersion": SCHEMA_VERSION,
        "exportedAt": chrono::Utc::now().to_rfc3339(), "labels": labels, "projects": projects,
    }))
}

// ------------------------------------------------------------- commands

#[tauri::command]
pub fn backup_create(app: AppHandle, state: State<AppState>, dest_dir: Option<String>) -> AppResult<BackupInfo> {
    if state.cloud.is_active() {
        return invalid("Backups cover your offline data. Switch to Offline in the space menu first - cloud spaces are kept on the server.");
    }
    let version = app.package_info().version.to_string();
    let paths = state.paths.clone();
    state.with(|c| {
        let dir = dest_dir.map(PathBuf::from).unwrap_or_else(|| backups_dir(c, &paths));
        let dest = dir.join(format!("kern-backup-{}-manual.zip", chrono::Local::now().format("%Y%m%d-%H%M%S")));
        create_archive(c, &paths, &version, &dest, "manual", false)
    })
}

#[tauri::command]
pub fn backups_list(state: State<AppState>) -> AppResult<Vec<BackupInfo>> {
    let paths = state.paths.clone();
    let dir = state.with(|c| Ok(backups_dir(c, &paths)))?;
    Ok(list_backups(&dir))
}

#[tauri::command]
pub fn backup_preview(state: State<AppState>, path: String) -> AppResult<RestorePreview> {
    preview(&state.paths, &PathBuf::from(path))
}

/// Restores from an archive (backup or full export). Returns the safety
/// backup made of the replaced data. The client reloads afterwards.
#[tauri::command]
pub fn backup_restore(app: AppHandle, state: State<AppState>, path: String) -> AppResult<BackupInfo> {
    if state.cloud.is_active() {
        return invalid("Backups cover your offline data. Switch to Offline in the space menu first - cloud spaces are kept on the server.");
    }
    let version = app.package_info().version.to_string();
    let paths = state.paths.clone();
    state.with(|c| restore(c, &paths, &version, &PathBuf::from(&path)))
}

#[tauri::command]
pub fn backup_delete(state: State<AppState>, path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    if !(name.starts_with("kern-backup-") && name.ends_with(".zip")) {
        return invalid("Only Kern backup files can be deleted here.");
    }
    let _ = state;
    std::fs::remove_file(p)?;
    Ok(())
}

#[tauri::command]
pub fn export_all(app: AppHandle, state: State<AppState>, path: String) -> AppResult<BackupInfo> {
    if state.cloud.is_active() {
        return invalid("Backups cover your offline data. Switch to Offline in the space menu first - cloud spaces are kept on the server.");
    }
    let version = app.package_info().version.to_string();
    let paths = state.paths.clone();
    state.with(|c| create_archive(c, &paths, &version, &PathBuf::from(&path), "export", true))
}

#[tauri::command]
pub fn export_tasks_csv(state: State<AppState>, path: String) -> AppResult<()> {
    let csv = state.with(|c| tasks_csv(c))?;
    // UTF-8 BOM so spreadsheet apps detect the encoding.
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(csv.as_bytes());
    crate::domain::system::atomic_write(&PathBuf::from(path), &bytes)
}

#[tauri::command]
pub fn export_notes_markdown(state: State<AppState>, dir: String) -> AppResult<usize> {
    state.with(|c| notes_to_dir(c, &PathBuf::from(dir)))
}

#[tauri::command]
pub fn export_projects_json(state: State<AppState>, path: String, ids: Option<Vec<String>>) -> AppResult<()> {
    let doc = state.with(|c| projects_json(c, ids))?;
    crate::domain::system::atomic_write(&PathBuf::from(path), serde_json::to_string_pretty(&doc)?.as_bytes())
}

#[tauri::command]
pub fn data_dir_size(state: State<AppState>) -> u64 {
    dir_size(&state.paths.data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{notes, projects, tasks};

    fn setup() -> (tempfile::TempDir, Paths, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().to_path_buf());
        std::fs::create_dir_all(&paths.attachments_dir).unwrap();
        let conn = db::open(&paths.db_path, &paths.default_backups_dir).unwrap();
        (dir, paths, conn)
    }

    #[test]
    fn backup_restore_roundtrip() {
        let (_d, paths, mut conn) = setup();
        let p = projects::create_project(&conn, &projects::ProjectInput { name: "Alpha".into(), ..Default::default() }).unwrap();
        tasks::create_task(&conn, &tasks::TaskInput { title: "Keep me".into(), project_id: Some(p.id.clone()), ..Default::default() }).unwrap();
        notes::create_note(&conn, "Note", "# Hello\nworld", None).unwrap();
        std::fs::create_dir_all(paths.attachments_dir.join("files/x")).unwrap();
        std::fs::write(paths.attachments_dir.join("files/x/a.txt"), b"attachment").unwrap();

        let dest = paths.data_dir.join("out/kern-backup-test.zip");
        let info = create_archive(&conn, &paths, "0.1.0", &dest, "manual", true).unwrap();
        assert_eq!(info.manifest.counts["tasks"], json!(1));

        // Mutate after the backup.
        tasks::create_task(&conn, &tasks::TaskInput { title: "Lost".into(), ..Default::default() }).unwrap();
        std::fs::remove_file(paths.attachments_dir.join("files/x/a.txt")).unwrap();

        let prev = preview(&paths, &dest).unwrap();
        assert!(prev.valid, "{:?}", prev.problems);
        assert!(prev.has_attachments);

        restore(&mut conn, &paths, "0.1.0", &dest).unwrap();
        let titles: Vec<String> = tasks::query_tasks(&conn, &Default::default()).unwrap().into_iter().map(|t| t.title).collect();
        assert_eq!(titles, vec!["Keep me".to_string()]);
        assert_eq!(std::fs::read(paths.attachments_dir.join("files/x/a.txt")).unwrap(), b"attachment");
        // The safety backup exists.
        assert!(list_backups(&backups_dir(&conn, &paths)).iter().any(|b| b.manifest.kind == "pre-restore"));
    }

    #[test]
    fn rejects_non_archives() {
        let (_d, paths, _conn) = setup();
        let bogus = paths.data_dir.join("bogus.zip");
        std::fs::write(&bogus, b"not a zip").unwrap();
        assert!(preview(&paths, &bogus).is_err());
    }

    #[test]
    fn csv_escaping() {
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("plain"), "plain");
    }
}
