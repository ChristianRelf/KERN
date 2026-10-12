//! Storage analytics: how much disk space Kern uses and what it consists of.
//!
//! Only Kern-owned locations are measured (the data folder, the WebView data
//! folder, Kern's own archives in a custom backup folder), plus linked
//! project folders when the user explicitly asks - and those are reported
//! separately, never added to Kern's total.
//!
//! Accounting is by path and mutually exclusive: each file lands in exactly
//! one category (first matching rule wins), symbolic links and junctions are
//! never followed (so loops and double counting through aliases can't
//! happen), and the custom backup folder is only scanned for Kern archives.
//! Sizes come from metadata; files are never read.

use crate::domain::settings;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, Paths};
use crate::util::now_ms;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Database,
    Attachments,
    Whiteboard,
    Backups,
    Cache,
    Logs,
    Other,
}

impl Category {
    const ALL: [Category; 7] = [
        Category::Database,
        Category::Attachments,
        Category::Whiteboard,
        Category::Backups,
        Category::Cache,
        Category::Logs,
        Category::Other,
    ];
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CategoryUsage {
    pub id: Category,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub id: String,
    pub label: String,
    pub path: String,
    pub exists: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LinkedFolderUsage {
    pub project_id: String,
    pub project_name: String,
    pub path: String,
    pub bytes: u64,
    pub files: u64,
    /// False when the folder was missing or the scan hit its limits.
    pub complete: bool,
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    pub scanned_at: i64,
    pub duration_ms: u64,
    pub total_bytes: u64,
    pub total_files: u64,
    pub categories: Vec<CategoryUsage>,
    pub locations: Vec<Location>,
    /// Entries that couldn't be read (permissions, files in use).
    pub skipped: u64,
    /// Present only when linked folders were scanned (never part of the total).
    pub linked: Option<Vec<LinkedFolderUsage>>,
}

/// Where Kern's data lives; resolved once per scan.
#[derive(Debug, Clone)]
pub struct Roots {
    pub data_dir: PathBuf,
    pub attachments_dir: PathBuf,
    pub default_backups_dir: PathBuf,
    /// User-chosen backup folder, if different from the default.
    pub custom_backups_dir: Option<PathBuf>,
    /// WebView storage (Windows: %LOCALAPPDATA%\<id>\EBWebView).
    pub webview_dir: Option<PathBuf>,
    pub cache_dir: PathBuf,
    pub tmp_dir: PathBuf,
    pub logs_dir: PathBuf,
}

impl Roots {
    pub fn new(paths: &Paths, custom_backups: Option<PathBuf>, webview_dir: Option<PathBuf>) -> Self {
        Roots {
            data_dir: paths.data_dir.clone(),
            attachments_dir: paths.attachments_dir.clone(),
            default_backups_dir: paths.default_backups_dir.clone(),
            custom_backups_dir: custom_backups.filter(|d| d != &paths.default_backups_dir),
            webview_dir,
            cache_dir: paths.cache_dir(),
            tmp_dir: paths.tmp_dir(),
            logs_dir: paths.logs_dir(),
        }
    }

    /// Classifies a file inside the data folder. Order matters: the first
    /// matching rule wins, which keeps categories mutually exclusive.
    pub fn classify(&self, file: &Path) -> Category {
        let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if file.parent() == Some(self.data_dir.as_path()) && (name == "kern.db" || name.starts_with("kern.db-")) {
            return Category::Database;
        }
        if file.starts_with(self.attachments_dir.join("wb")) {
            return Category::Whiteboard;
        }
        if file.starts_with(&self.attachments_dir) {
            return Category::Attachments;
        }
        if file.starts_with(&self.default_backups_dir) || self.custom_backups_dir.as_ref().is_some_and(|d| file.starts_with(d)) {
            return Category::Backups;
        }
        if file.starts_with(&self.cache_dir) || file.starts_with(&self.tmp_dir) || self.webview_dir.as_ref().is_some_and(|d| file.starts_with(d)) {
            return Category::Cache;
        }
        if file.starts_with(&self.logs_dir) {
            return Category::Logs;
        }
        Category::Other
    }
}

/// Kern's own archive names (manual/automatic backups, exports, safety copies).
fn is_kern_archive(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    (n.starts_with("kern-backup-") && n.ends_with(".zip")) || (n.starts_with("pre-migration-") && n.ends_with(".db"))
}

// ------------------------------------------------------------ walking

/// Directory listing memo for immutable trees (managed attachments are
/// written once into their own folder and never modified in place): an
/// unchanged directory mtime means its direct files and subfolders are too.
#[derive(Default)]
pub struct DirCache {
    entries: HashMap<PathBuf, CachedDir>,
}

#[derive(Clone)]
struct CachedDir {
    mtime: SystemTime,
    files: Vec<(PathBuf, u64)>,
    subdirs: Vec<PathBuf>,
}

pub struct Scan<'a> {
    pub cancel: &'a AtomicBool,
    pub progress: &'a mut dyn FnMut(u64, u64),
    pub cache: Option<&'a mut DirCache>,
    /// Only memoise directories under this root.
    pub memo_root: Option<PathBuf>,
    pub skipped: u64,
    pub files: u64,
    pub bytes: u64,
    /// Stop after this many files (linked folders only).
    pub max_files: Option<u64>,
    seen_dirs: HashSet<PathBuf>,
    last_report: Option<Instant>,
}

impl<'a> Scan<'a> {
    pub fn new(cancel: &'a AtomicBool, progress: &'a mut dyn FnMut(u64, u64)) -> Self {
        Scan { cancel, progress, cache: None, memo_root: None, skipped: 0, files: 0, bytes: 0, max_files: None, seen_dirs: HashSet::new(), last_report: None }
    }

    fn tick(&mut self) {
        let due = self.last_report.map(|t| t.elapsed().as_millis() >= 200).unwrap_or(true);
        if due {
            (self.progress)(self.files, self.bytes);
            self.last_report = Some(Instant::now());
        }
    }

    fn limited(&self) -> bool {
        self.max_files.is_some_and(|m| self.files >= m)
    }

    /// Visits every regular file under `dir`, calling `visit(path, size)`.
    pub fn walk(&mut self, dir: &Path, visit: &mut dyn FnMut(&Path, u64)) -> AppResult<()> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(AppError::Other("cancelled".into()));
        }
        if self.limited() || !self.seen_dirs.insert(dir.to_path_buf()) {
            return Ok(());
        }
        let memo = self.memo_root.as_ref().is_some_and(|r| dir.starts_with(r)) && self.cache.is_some();
        let mtime = std::fs::metadata(dir).and_then(|m| m.modified()).ok();
        if memo {
            if let (Some(m), Some(cached)) = (mtime, self.cache.as_ref().and_then(|c| c.entries.get(dir)).cloned()) {
                if cached.mtime == m {
                    for (f, size) in &cached.files {
                        self.files += 1;
                        self.bytes += size;
                        visit(f, *size);
                    }
                    self.tick();
                    for d in &cached.subdirs {
                        self.walk(d, visit)?;
                    }
                    return Ok(());
                }
            }
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => {
                self.skipped += 1;
                return Ok(());
            }
        };
        let mut files = vec![];
        let mut subdirs = vec![];
        for e in entries {
            let Ok(e) = e else {
                self.skipped += 1;
                continue;
            };
            let path = e.path();
            // Never follow links or junctions: no loops, no counting elsewhere.
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                self.skipped += 1;
                continue;
            };
            let ft = meta.file_type();
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                subdirs.push(path);
            } else if ft.is_file() {
                files.push((path, meta.len()));
            }
        }
        for (f, size) in &files {
            if self.limited() {
                break;
            }
            self.files += 1;
            self.bytes += size;
            visit(f, *size);
        }
        self.tick();
        if memo {
            if let (Some(m), Some(cache)) = (mtime, self.cache.as_mut()) {
                cache.entries.insert(dir.to_path_buf(), CachedDir { mtime: m, files: files.clone(), subdirs: subdirs.clone() });
            }
        }
        for d in subdirs {
            self.walk(&d, visit)?;
        }
        Ok(())
    }
}

/// Measures Kern's storage. Pure apart from filesystem reads (unit-tested).
pub fn measure(roots: &Roots, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, u64), cache: Option<&mut DirCache>) -> AppResult<(Vec<CategoryUsage>, u64, u64)> {
    let mut totals: HashMap<Category, (u64, u64)> = HashMap::new();
    let mut scan = Scan::new(cancel, progress);
    scan.cache = cache;
    scan.memo_root = Some(roots.attachments_dir.clone());
    {
        let mut add = |p: &Path, size: u64| {
            let t = totals.entry(roots.classify(p)).or_default();
            t.0 += size;
            t.1 += 1;
        };
        if roots.data_dir.is_dir() {
            scan.walk(&roots.data_dir, &mut add)?;
        }
        // WebView data lives outside the data folder on Windows; skip it if
        // it happens to be inside (already counted).
        if let Some(w) = roots.webview_dir.as_ref().filter(|w| w.is_dir() && !w.starts_with(&roots.data_dir)) {
            scan.walk(w, &mut add)?;
        }
    }
    // A custom backup folder may hold unrelated files: count only Kern's
    // archives, non-recursively, and only if it isn't inside the data folder.
    if let Some(dir) = roots.custom_backups_dir.as_ref().filter(|d| !d.starts_with(&roots.data_dir)) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let Ok(meta) = std::fs::symlink_metadata(e.path()) else { continue };
                if meta.is_file() && is_kern_archive(&name) {
                    let t = totals.entry(Category::Backups).or_default();
                    t.0 += meta.len();
                    t.1 += 1;
                    scan.files += 1;
                    scan.bytes += meta.len();
                }
            }
        }
    }
    let categories = Category::ALL
        .iter()
        .map(|c| {
            let (bytes, files) = totals.get(c).copied().unwrap_or_default();
            CategoryUsage { id: *c, bytes, files }
        })
        .collect();
    Ok((categories, scan.skipped, scan.files))
}

// ------------------------------------------------------------ state

#[derive(Default)]
pub struct ScanControl {
    pub running: AtomicBool,
    pub cancel: AtomicBool,
    pub dir_cache: Mutex<DirCache>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: &'static str,
    files: u64,
    bytes: u64,
}

fn webview_dir(app: &AppHandle) -> Option<PathBuf> {
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some() {
        return std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").map(PathBuf::from);
    }
    if cfg!(windows) {
        app.path().app_local_data_dir().ok().map(|d| d.join("EBWebView"))
    } else {
        None
    }
}

fn roots(app: &AppHandle, conn: &Connection, paths: &Paths) -> Roots {
    let custom = settings::get::<String>(conn, "backups.dir").filter(|s| !s.trim().is_empty()).map(PathBuf::from);
    Roots::new(paths, custom, webview_dir(app))
}

fn locations(r: &Roots, paths: &Paths) -> Vec<Location> {
    let loc = |id: &str, label: &str, p: &Path| Location { id: id.into(), label: label.into(), path: p.to_string_lossy().to_string(), exists: p.exists() };
    let mut out = vec![
        loc("data", "Application data", &r.data_dir),
        loc("database", "Database", &paths.db_path),
        loc("attachments", "Attachments", &r.attachments_dir),
        loc("backups", "Backups", r.custom_backups_dir.as_ref().unwrap_or(&r.default_backups_dir)),
        loc("cache", "Cache", &r.cache_dir),
    ];
    if let Some(w) = &r.webview_dir {
        out.push(loc("webview", "Web view data", w));
    }
    out
}

fn save_report(conn: &Connection, report: &StorageReport) -> AppResult<()> {
    conn.execute(
        "INSERT INTO storage_scan_cache(id, data, scanned_at) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, scanned_at = excluded.scanned_at",
        params![serde_json::to_string(report)?, report.scanned_at],
    )?;
    Ok(())
}

pub fn cached_report(conn: &Connection) -> AppResult<Option<StorageReport>> {
    let raw: Option<String> = conn.query_row("SELECT data FROM storage_scan_cache WHERE id = 1", [], |r| r.get(0)).optional()?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
}

fn linked_folders(conn: &Connection) -> AppResult<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, l.path FROM project_folder_links l JOIN projects p ON p.id = l.project_id WHERE p.deleted_at IS NULL ORDER BY p.name",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

const LINKED_MAX_FILES: u64 = 500_000;

/// Last scan result, without scanning (the settings page shows this first).
#[tauri::command]
pub fn storage_report(state: tauri::State<AppState>) -> AppResult<Option<StorageReport>> {
    state.with(|c| cached_report(c))
}

/// Scans Kern's storage on a background thread, emitting
/// `kern://storage-scan` progress. Linked folders are scanned only when asked.
#[tauri::command]
pub async fn storage_scan(app: AppHandle, include_linked: bool) -> AppResult<StorageReport> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let ctl = &state.storage;
        if ctl.running.swap(true, Ordering::SeqCst) {
            return Err(AppError::Invalid("A storage scan is already running.".into()));
        }
        ctl.cancel.store(false, Ordering::SeqCst);
        let result = (|| {
            let started = Instant::now();
            let paths = state.paths.clone();
            let (r, linked_list) = state.with(|c| Ok((roots(&handle, c, &paths), if include_linked { linked_folders(c)? } else { vec![] })))?;
            let emit = |phase: &'static str, files: u64, bytes: u64| {
                let _ = handle.emit("kern://storage-scan", Progress { phase, files, bytes });
            };
            let mut on_progress = |f: u64, b: u64| emit("kern", f, b);
            let (categories, skipped, total_files) = {
                let mut cache = ctl.dir_cache.lock().map_err(|_| AppError::Other("Scan cache unavailable".into()))?;
                measure(&r, &ctl.cancel, &mut on_progress, Some(&mut cache))?
            };
            let linked = if include_linked {
                let mut out = vec![];
                for (pid, name, path) in linked_list {
                    let p = PathBuf::from(&path);
                    if !p.is_dir() {
                        out.push(LinkedFolderUsage { project_id: pid, project_name: name, path, bytes: 0, files: 0, complete: false, note: Some("Folder not found".into()) });
                        continue;
                    }
                    let mut on_linked = |f: u64, b: u64| emit("linked", f, b);
                    let mut scan = Scan::new(&ctl.cancel, &mut on_linked);
                    scan.max_files = Some(LINKED_MAX_FILES);
                    scan.walk(&p, &mut |_, _| {})?;
                    let limited = scan.files >= LINKED_MAX_FILES;
                    out.push(LinkedFolderUsage {
                        project_id: pid,
                        project_name: name,
                        path,
                        bytes: scan.bytes,
                        files: scan.files,
                        complete: !limited && scan.skipped == 0,
                        note: if limited {
                            Some(format!("Stopped after {LINKED_MAX_FILES} files"))
                        } else if scan.skipped > 0 {
                            Some(format!("{} items couldn't be read", scan.skipped))
                        } else {
                            None
                        },
                    });
                }
                Some(out)
            } else {
                None
            };
            let report = StorageReport {
                scanned_at: now_ms(),
                duration_ms: started.elapsed().as_millis() as u64,
                total_bytes: categories.iter().map(|c| c.bytes).sum(),
                total_files,
                categories,
                locations: locations(&r, &paths),
                skipped,
                linked,
            };
            state.with(|c| save_report(c, &report))?;
            emit("done", report.total_files, report.total_bytes);
            Ok(report)
        })();
        ctl.running.store(false, Ordering::SeqCst);
        result.map_err(|e| match e {
            AppError::Other(m) if m == "cancelled" => AppError::Invalid("Scan cancelled.".into()),
            e => e,
        })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn storage_scan_cancel(state: tauri::State<AppState>) {
    state.storage.cancel.store(true, Ordering::SeqCst);
}

// ------------------------------------------------------------ cleanup

#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum Cleanup {
    /// Cached website icons (re-fetched when needed).
    Favicons,
    /// Link titles older than 30 days.
    ExpiredPreviews,
    /// Leftovers from interrupted exports and restores.
    Temporary,
    /// Whiteboard images no longer used by any whiteboard (older than a day).
    UnusedWhiteboardAssets,
}

fn remove_dir_contents(dir: &Path, older_than: Option<std::time::Duration>) -> u64 {
    let mut freed = 0;
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    for e in entries.flatten() {
        let p = e.path();
        let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
        if let Some(age) = older_than {
            let young = meta.modified().ok().and_then(|m| m.elapsed().ok()).map(|d| d < age).unwrap_or(true);
            if young {
                continue;
            }
        }
        if meta.is_dir() {
            let mut size = 0;
            let stop = AtomicBool::new(false);
            let mut noop = |_: u64, _: u64| {};
            let mut s = Scan::new(&stop, &mut noop);
            let _ = s.walk(&p, &mut |_, b| size += b);
            if std::fs::remove_dir_all(&p).is_ok() {
                freed += size;
            }
        } else if std::fs::remove_file(&p).is_ok() {
            freed += meta.len();
        }
    }
    freed
}

/// Runs a safe cleanup. Never touches projects, tasks, notes, whiteboards,
/// user files, linked folders or backups. Returns bytes freed.
pub fn cleanup(conn: &Connection, paths: &Paths, what: Cleanup) -> AppResult<u64> {
    Ok(match what {
        Cleanup::Favicons => {
            let freed = remove_dir_contents(&paths.favicons_dir(), None);
            conn.execute("DELETE FROM favicon_cache", [])?;
            freed
        }
        Cleanup::ExpiredPreviews => {
            let n = conn.execute("DELETE FROM link_metadata WHERE fetched_at < ?1", [now_ms() - 30 * 86_400_000])?;
            n as u64 * 256 // rows are small; an estimate is shown as "about"
        }
        // Skip anything touched in the last 10 minutes: it may belong to an
        // export or restore that's still running.
        Cleanup::Temporary => remove_dir_contents(&paths.tmp_dir(), Some(std::time::Duration::from_secs(600))),
        Cleanup::UnusedWhiteboardAssets => {
            let before = dir_bytes(&paths.attachments_dir.join("wb"));
            crate::domain::attachments::cleanup_orphan_assets(conn, &paths.attachments_dir)?;
            before.saturating_sub(dir_bytes(&paths.attachments_dir.join("wb")))
        }
    })
}

fn dir_bytes(p: &Path) -> u64 {
    let stop = AtomicBool::new(false);
    let mut noop = |_: u64, _: u64| {};
    let mut s = Scan::new(&stop, &mut noop);
    let _ = s.walk(p, &mut |_, _| {});
    s.bytes
}

#[tauri::command]
pub async fn storage_cleanup(app: AppHandle, what: Cleanup) -> AppResult<u64> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let paths = state.paths.clone();
        state.with(|c| cleanup(c, &paths, what))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, n: usize) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, vec![0u8; n]).unwrap();
    }

    fn sizes(cats: &[CategoryUsage]) -> HashMap<Category, u64> {
        cats.iter().map(|c| (c.id, c.bytes)).collect()
    }

    #[test]
    fn categories_are_exclusive_and_complete() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().join("data"));
        write(&paths.db_path, 1000);
        write(&paths.data_dir.join("kern.db-wal"), 200);
        write(&paths.attachments_dir.join("files/a/report.pdf"), 3000);
        write(&paths.attachments_dir.join("wb/b/photo.png"), 4000);
        write(&paths.default_backups_dir.join("kern-backup-1.zip"), 500);
        write(&paths.favicons_dir().join("https_github.com.png"), 50);
        write(&paths.tmp_dir().join("x.partial"), 25);
        write(&paths.logs_dir().join("kern.log"), 10);
        write(&paths.data_dir.join("stray.txt"), 7);
        let roots = Roots::new(&paths, None, None);
        let stop = AtomicBool::new(false);
        let (cats, skipped, files) = measure(&roots, &stop, &mut |_, _| {}, None).unwrap();
        let s = sizes(&cats);
        assert_eq!(s[&Category::Database], 1200);
        assert_eq!(s[&Category::Attachments], 3000);
        assert_eq!(s[&Category::Whiteboard], 4000, "whiteboard assets aren't double-counted as attachments");
        assert_eq!(s[&Category::Backups], 500);
        assert_eq!(s[&Category::Cache], 75);
        assert_eq!(s[&Category::Logs], 10);
        assert_eq!(s[&Category::Other], 7);
        assert_eq!(s.values().sum::<u64>(), 8792, "every byte counted exactly once");
        assert_eq!((skipped, files), (0, 9));
    }

    #[test]
    fn custom_backup_folder_counts_only_kern_archives() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().join("data"));
        write(&paths.db_path, 100);
        let custom = dir.path().join("D-Backups");
        write(&custom.join("kern-backup-2026.zip"), 900);
        write(&custom.join("holiday-video.mp4"), 1_000_000);
        write(&custom.join("nested/kern-old.zip"), 5000);
        let roots = Roots::new(&paths, Some(custom), None);
        let stop = AtomicBool::new(false);
        let (cats, _, _) = measure(&roots, &stop, &mut |_, _| {}, None).unwrap();
        assert_eq!(sizes(&cats)[&Category::Backups], 900);
    }

    #[cfg(unix)]
    #[test]
    fn links_are_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().join("data"));
        write(&paths.db_path, 100);
        let outside = dir.path().join("big");
        write(&outside.join("huge.bin"), 50_000);
        std::os::unix::fs::symlink(&outside, paths.data_dir.join("link")).unwrap();
        std::os::unix::fs::symlink(&paths.data_dir, paths.data_dir.join("loop")).unwrap();
        let roots = Roots::new(&paths, None, None);
        let stop = AtomicBool::new(false);
        let (cats, _, _) = measure(&roots, &stop, &mut |_, _| {}, None).unwrap();
        assert_eq!(cats.iter().map(|c| c.bytes).sum::<u64>(), 100);
    }

    #[test]
    fn unchanged_attachment_folders_come_from_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().join("data"));
        write(&paths.attachments_dir.join("files/a/one.bin"), 10);
        let roots = Roots::new(&paths, None, None);
        let stop = AtomicBool::new(false);
        let mut cache = DirCache::default();
        measure(&roots, &stop, &mut |_, _| {}, Some(&mut cache)).unwrap();
        assert!(cache.entries.contains_key(&paths.attachments_dir.join("files").join("a")));
        // A new attachment folder changes the parent's mtime and is picked up.
        write(&paths.attachments_dir.join("files/b/two.bin"), 20);
        let (cats, _, _) = measure(&roots, &stop, &mut |_, _| {}, Some(&mut cache)).unwrap();
        assert_eq!(sizes(&cats)[&Category::Attachments], 30);
    }

    #[test]
    fn cancellation_stops_the_scan() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().join("data"));
        write(&paths.db_path, 1);
        let roots = Roots::new(&paths, None, None);
        let stop = AtomicBool::new(true);
        assert!(measure(&roots, &stop, &mut |_, _| {}, None).is_err());
    }

    #[test]
    fn cleanup_never_touches_user_data() {
        let c = crate::db::open_memory();
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().join("data"));
        write(&paths.favicons_dir().join("x.png"), 100);
        write(&paths.attachments_dir.join("files/a/keep.pdf"), 100);
        write(&paths.default_backups_dir.join("kern-backup.zip"), 100);
        c.execute("INSERT INTO favicon_cache(origin, file, status, fetched_at, expires_at) VALUES ('https://x', 'x.png', 'ok', 1, 2)", []).unwrap();
        assert_eq!(cleanup(&c, &paths, Cleanup::Favicons).unwrap(), 100);
        assert!(paths.attachments_dir.join("files/a/keep.pdf").exists());
        assert!(paths.default_backups_dir.join("kern-backup.zip").exists());
        let n: i64 = c.query_row("SELECT count(*) FROM favicon_cache", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }
}
