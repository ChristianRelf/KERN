// @Author Christian Relf
// @Date 2026-10-12

//! Search index for linked folders and repositories: every file name, plus
//! the text of small, non-sensitive text files (code search).
//!
//! Indexing is incremental (a file is re-read only when its size or
//! modification time changed), runs on a background thread in small
//! batches so the interface never waits on it, and only happens when search
//! asks for files or code (never at startup). It skips dependency folders,
//! build output, hidden folders, binaries, large files, anything matched by
//! the root's .gitignore and files that look like secrets.

use crate::domain::folders::{self, is_sensitive};
use crate::domain::git::{blocking, SKIP_DIRS};
use crate::domain::search::to_fts_query;
use crate::error::AppResult;
use crate::state::AppState;
use crate::util::now_ms;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

const MAX_FILES: usize = 50_000;
const MAX_CONTENT: u64 = 256 * 1024;
/// Re-check a root at most this often when searching.
const STALE_MS: i64 = 5 * 60_000;

static INDEXING: Mutex<Vec<String>> = Mutex::new(Vec::new());

const TEXT_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "md", "mdx", "txt", "toml", "yaml", "yml", "css", "scss", "less", "html", "htm", "vue", "svelte", "astro", "py", "pyi", "go", "java", "kt",
    "kts", "gradle", "cs", "fs", "c", "h", "cc", "cpp", "hpp", "hh", "m", "mm", "swift", "rb", "php", "lua", "luau", "sh", "bash", "zsh", "ps1", "psm1", "bat", "cmd", "sql", "graphql", "gql", "proto", "xml",
    "csproj", "fsproj", "sln", "ini", "cfg", "conf", "env.example", "dockerfile", "makefile", "cmake", "tf", "hcl", "nix", "dart", "ex", "exs", "erl", "hs", "elm", "clj", "scala", "r", "jl", "zig", "nim",
    "vb", "glsl", "hlsl", "wgsl", "shader", "uproject", "uplugin", "rst", "adoc", "tex", "csv", "svg",
];

fn indexable_text(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if ["makefile", "dockerfile", "readme", "license", "justfile", "procfile", "gemfile", "rakefile"].contains(&n.as_str()) {
        return true;
    }
    n.rsplit_once('.').is_some_and(|(_, e)| TEXT_EXTS.contains(&e)) && !n.ends_with(".min.js") && !n.ends_with(".lock") && n != "package-lock.json"
}

// ------------------------------------------------------------ .gitignore (subset)

struct Rule {
    pattern: String,
    negate: bool,
    dir_only: bool,
    anchored: bool,
}

fn glob(p: &[u8], s: &[u8]) -> bool {
    match (p.first(), s.first()) {
        (None, None) => true,
        (Some(b'*'), _) => glob(&p[1..], s) || (!s.is_empty() && s[0] != b'/' && glob(p, &s[1..])),
        (Some(b'?'), Some(c)) if *c != b'/' => glob(&p[1..], &s[1..]),
        (Some(a), Some(b)) if a == b => glob(&p[1..], &s[1..]),
        _ => false,
    }
}

pub struct Ignore(Vec<Rule>);

impl Ignore {
    pub fn parse(text: &str) -> Ignore {
        Ignore(
            text.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(|l| {
                    let negate = l.starts_with('!');
                    let l = l.trim_start_matches('!');
                    let dir_only = l.ends_with('/');
                    let l = l.trim_end_matches('/');
                    let anchored = l.starts_with('/') || l.trim_start_matches('/').contains('/');
                    Rule { pattern: l.trim_start_matches('/').trim_start_matches("**/").to_string(), negate, dir_only, anchored }
                })
                .collect(),
        )
    }

    /// `rel` uses forward slashes, relative to the root.
    pub fn ignored(&self, rel: &str, is_dir: bool) -> bool {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        let mut out = false;
        for r in &self.0 {
            if r.dir_only && !is_dir {
                continue;
            }
            let hit = if r.anchored { glob(r.pattern.as_bytes(), rel.as_bytes()) } else { glob(r.pattern.as_bytes(), name.as_bytes()) };
            if hit {
                out = !r.negate;
            }
        }
        out
    }
}

// ------------------------------------------------------------ indexing

struct Found {
    rel: String,
    size: u64,
    mtime: i64,
    path: PathBuf,
}

fn walk(root: &Path) -> (Vec<Found>, bool) {
    let ignore = std::fs::read_to_string(root.join(".gitignore")).map(|t| Ignore::parse(&t)).unwrap_or(Ignore(vec![]));
    let mut out = vec![];
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(meta) = std::fs::symlink_metadata(e.path()) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if meta.is_dir() {
                if !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) && !ignore.ignored(&r, true) {
                    stack.push((e.path(), r));
                }
                continue;
            }
            if ignore.ignored(&r, false) || is_sensitive(&name) {
                continue;
            }
            if out.len() >= MAX_FILES {
                return (out, false);
            }
            let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
            out.push(Found { rel: r, size: meta.len(), mtime, path: e.path() });
        }
    }
    (out, true)
}

fn content_of(f: &Found) -> String {
    if f.size > MAX_CONTENT || !indexable_text(&f.rel.rsplit('/').next().unwrap_or("")) {
        return String::new();
    }
    let Ok(bytes) = std::fs::read(&f.path) else { return String::new() };
    if bytes.iter().take(4096).any(|b| *b == 0) {
        return String::new();
    }
    String::from_utf8_lossy(&bytes).to_string()
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub roots: usize,
    pub files: usize,
    pub updated: usize,
    pub removed: usize,
    pub incomplete: bool,
}

/// Brings one root's index up to date. Holds the database only in short batches.
pub fn index_root(state: &AppState, root: &Path) -> AppResult<IndexStats> {
    let key = folders::folder_key(root);
    {
        let mut busy = INDEXING.lock().unwrap_or_else(|e| e.into_inner());
        if busy.contains(&key) {
            return Ok(IndexStats::default());
        }
        busy.push(key.clone());
    }
    let result = (|| {
        let (found, complete) = walk(root);
        let existing: HashMap<String, (i64, i64, i64)> = state.with(|c| {
            let mut stmt = c.prepare("SELECT rel, id, size, mtime FROM file_index WHERE root_key = ?1")?;
            let rows = stmt.query_map([&key], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?))))?;
            Ok(rows.collect::<Result<HashMap<_, _>, _>>()?)
        })?;
        let mut stats = IndexStats { roots: 1, files: found.len(), incomplete: !complete, ..Default::default() };
        let changed: Vec<&Found> = found.iter().filter(|f| existing.get(&f.rel).map(|(_, s, m)| *s != f.size as i64 || *m != f.mtime).unwrap_or(true)).collect();
        for batch in changed.chunks(200) {
            // Read files outside the database lock.
            let prepared: Vec<(&Found, String)> = batch.iter().map(|f| (*f, content_of(f))).collect();
            state.with(|c| {
                let tx = c.transaction()?;
                for (f, body) in &prepared {
                    if let Some((id, _, _)) = existing.get(&f.rel) {
                        tx.execute("DELETE FROM file_fts WHERE rowid = ?1", [id])?;
                        tx.execute("UPDATE file_index SET size = ?1, mtime = ?2 WHERE id = ?3", params![f.size as i64, f.mtime, id])?;
                        tx.execute("INSERT INTO file_fts(rowid, name, body) VALUES (?1, ?2, ?3)", params![id, f.rel.replace(['/', '.', '_', '-'], " "), body])?;
                    } else {
                        tx.execute("INSERT INTO file_index(root_key, rel, size, mtime) VALUES (?1, ?2, ?3, ?4)", params![key, f.rel, f.size as i64, f.mtime])?;
                        let id = tx.last_insert_rowid();
                        tx.execute("INSERT INTO file_fts(rowid, name, body) VALUES (?1, ?2, ?3)", params![id, f.rel.replace(['/', '.', '_', '-'], " "), body])?;
                    }
                }
                tx.commit()?;
                Ok(())
            })?;
            stats.updated += batch.len();
        }
        let seen: HashSet<&str> = found.iter().map(|f| f.rel.as_str()).collect();
        let gone: Vec<i64> = existing.iter().filter(|(rel, _)| !seen.contains(rel.as_str())).map(|(_, (id, _, _))| *id).collect();
        for batch in gone.chunks(500) {
            state.with(|c| {
                let tx = c.transaction()?;
                for id in batch {
                    tx.execute("DELETE FROM file_fts WHERE rowid = ?1", [id])?;
                    tx.execute("DELETE FROM file_index WHERE id = ?1", [id])?;
                }
                tx.commit()?;
                Ok(())
            })?;
        }
        stats.removed = gone.len();
        state.with(|c| {
            c.execute(
                "INSERT INTO file_index_roots(root_key, path, indexed_at, file_count, complete) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(root_key) DO UPDATE SET path = excluded.path, indexed_at = excluded.indexed_at, file_count = excluded.file_count, complete = excluded.complete",
                params![key, root.to_string_lossy(), now_ms(), found.len() as i64, complete as i64],
            )?;
            Ok(())
        })?;
        Ok(stats)
    })();
    INDEXING.lock().unwrap_or_else(|e| e.into_inner()).retain(|k| k != &key);
    result
}

/// Every linked root (project folders and local repositories) of live projects.
pub struct RootRef {
    pub key: String,
    pub path: String,
    pub project_id: String,
    pub repository_id: Option<String>,
}

pub fn roots(conn: &Connection, project_ids: Option<&[String]>) -> AppResult<Vec<RootRef>> {
    let mut out: Vec<RootRef> = vec![];
    let mut stmt = conn.prepare(
        "SELECT l.folder_key, l.path, l.project_id, NULL FROM project_folder_links l JOIN projects p ON p.id = l.project_id WHERE p.deleted_at IS NULL
         UNION ALL SELECT r.folder_key, r.local_path, r.project_id, r.id FROM project_repositories r JOIN projects p ON p.id = r.project_id
         WHERE p.deleted_at IS NULL AND r.folder_key IS NOT NULL",
    )?;
    for row in stmt.query_map([], |r| Ok(RootRef { key: r.get(0)?, path: r.get(1)?, project_id: r.get(2)?, repository_id: r.get(3)? }))? {
        let r = row?;
        if project_ids.is_some_and(|ids| !ids.contains(&r.project_id)) {
            continue;
        }
        // The same folder linked as both the project folder and a repository: index once.
        if !out.iter().any(|o| o.key == r.key) {
            out.push(r);
        }
    }
    Ok(out)
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub project_id: String,
    pub repository_id: Option<String>,
    pub root: String,
    pub rel: String,
    pub name: String,
    pub snippet: Option<String>,
}

fn fuzzy(query: &str, text: &str) -> Option<i64> {
    let q: Vec<char> = query.to_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    if q.is_empty() {
        return None;
    }
    let (mut qi, mut score, mut last) = (0, 0i64, None::<usize>);
    for (i, c) in t.iter().enumerate() {
        if qi < q.len() && *c == q[qi] {
            score += if last == Some(i.wrapping_sub(1)) { 6 } else { 1 };
            if i == 0 || matches!(t[i - 1], '/' | '.' | '_' | '-') {
                score += 4;
            }
            last = Some(i);
            qi += 1;
        }
    }
    (qi == q.len()).then_some(score)
}

pub fn search(conn: &Connection, query: &str, project_ids: Option<&[String]>, code: bool, limit: usize) -> AppResult<Vec<FileHit>> {
    let rts = roots(conn, project_ids)?;
    let by_key: HashMap<&str, &RootRef> = rts.iter().map(|r| (r.key.as_str(), r)).collect();
    let mut out = vec![];
    if code {
        let Some(fts) = to_fts_query(query) else { return Ok(vec![]) };
        let mut stmt = conn.prepare(
            "SELECT i.root_key, i.rel, snippet(file_fts, 1, '', '', '…', 10) FROM file_fts f JOIN file_index i ON i.id = f.rowid
             WHERE file_fts MATCH ?1 ORDER BY bm25(file_fts, 2.0, 1.0) LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![format!("body : ({fts})"), (limit * 4) as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
        for row in rows {
            let (k, rel, snip) = row?;
            if let Some(r) = by_key.get(k.as_str()) {
                out.push(FileHit { project_id: r.project_id.clone(), repository_id: r.repository_id.clone(), root: r.path.clone(), name: rel.rsplit('/').next().unwrap_or(&rel).to_string(), rel, snippet: Some(snip.replace('\n', " ")) });
                if out.len() >= limit {
                    break;
                }
            }
        }
        return Ok(out);
    }
    // File names: substring prefilter in SQL, fuzzy ranking here.
    let first = query.trim().chars().next().map(|c| c.to_string()).unwrap_or_default();
    let mut stmt = conn.prepare("SELECT root_key, rel FROM file_index WHERE rel LIKE ?1 ESCAPE '\\' LIMIT 20000")?;
    let pat = format!("%{}%", first.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let mut scored: Vec<(i64, FileHit)> = vec![];
    for row in stmt.query_map([pat], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (k, rel) = row?;
        let Some(r) = by_key.get(k.as_str()) else { continue };
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        let Some(score) = fuzzy(query, &rel) else { continue };
        let bonus = fuzzy(query, &name).map(|s| s * 2).unwrap_or(0) - rel.matches('/').count() as i64;
        scored.push((score + bonus, FileHit { project_id: r.project_id.clone(), repository_id: r.repository_id.clone(), root: r.path.clone(), name, rel, snippet: None }));
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(scored.into_iter().take(limit).map(|(_, h)| h).collect())
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub roots: usize,
    pub indexed: usize,
    pub files: i64,
    pub indexing: bool,
    pub stale: bool,
}

// ------------------------------------------------------------ commands

/// Updates the index for the given projects (or every project), skipping
/// roots indexed recently unless `force`.
#[tauri::command]
pub async fn files_index(app: AppHandle, project_ids: Option<Vec<String>>, force: Option<bool>) -> AppResult<IndexStats> {
    blocking(&app, move |s| {
        let enabled: bool = s.with(|c| Ok(crate::domain::settings::get_or(c, "search.indexFiles", true)))?;
        if !enabled {
            return Ok(IndexStats::default());
        }
        let list: Vec<(String, String, Option<i64>)> = s.with(|c| {
            let rts = roots(c, project_ids.as_deref())?;
            let mut out = vec![];
            for r in rts {
                let at: Option<i64> = c.query_row("SELECT indexed_at FROM file_index_roots WHERE root_key = ?1", [&r.key], |x| x.get(0)).optional()?;
                out.push((r.key, r.path, at));
            }
            Ok(out)
        })?;
        let mut total = IndexStats::default();
        for (_, path, at) in list {
            if !force.unwrap_or(false) && at.is_some_and(|a| now_ms() - a < STALE_MS) {
                continue;
            }
            let p = PathBuf::from(&path);
            if !p.is_dir() {
                continue;
            }
            let st = index_root(s, &p)?;
            total.roots += st.roots;
            total.files += st.files;
            total.updated += st.updated;
            total.removed += st.removed;
            total.incomplete |= st.incomplete;
        }
        Ok(total)
    })
    .await
}

#[tauri::command]
pub async fn files_search(app: AppHandle, query: String, project_ids: Option<Vec<String>>, code: bool, limit: Option<usize>) -> AppResult<Vec<FileHit>> {
    blocking(&app, move |s| s.with(|c| search(c, &query, project_ids.as_deref(), code, limit.unwrap_or(20).clamp(1, 100)))).await
}

#[tauri::command]
pub fn files_index_status(state: tauri::State<AppState>) -> AppResult<IndexStatus> {
    state.with(|c| {
        let rts = roots(c, None)?;
        let (indexed, files, oldest): (i64, i64, Option<i64>) =
            c.query_row("SELECT count(*), coalesce(sum(file_count), 0), min(indexed_at) FROM file_index_roots", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(IndexStatus {
            roots: rts.len(),
            indexed: indexed as usize,
            files,
            indexing: !INDEXING.lock().map(|v| v.is_empty()).unwrap_or(true),
            stale: oldest.map_or(true, |o| now_ms() - o > STALE_MS) || (indexed as usize) < rts.len(),
        })
    })
}

/// Deletes the whole file index (it's rebuilt on the next file search).
#[tauri::command]
pub fn files_index_clear(state: tauri::State<AppState>) -> AppResult<()> {
    state.with(|c| {
        c.execute_batch("DELETE FROM file_fts; DELETE FROM file_index; DELETE FROM file_index_roots;")?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitignore_subset() {
        let ig = Ignore::parse("# c\n*.log\nbuild/\n/secret.txt\n!keep.log\n");
        assert!(ig.ignored("a/b/x.log", false));
        assert!(!ig.ignored("a/keep.log", false));
        assert!(ig.ignored("build", true) && !ig.ignored("build", false));
        assert!(ig.ignored("secret.txt", false) && !ig.ignored("a/secret.txt", false));
    }

    #[test]
    fn indexes_incrementally_and_finds_names_and_code() {
        let tmp = tempfile::tempdir().unwrap();
        let root = folders::canonical(tmp.path()).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(root.join("src/reactorCooling.ts"), "export function ventCoolant() { return 1 }\n").unwrap();
        std::fs::write(root.join("node_modules/x/index.js"), "ventCoolant").unwrap();
        std::fs::write(root.join(".env"), "TOKEN=ventCoolant").unwrap();
        std::fs::write(root.join("debug.log"), "ventCoolant").unwrap();
        std::fs::write(root.join(".gitignore"), "*.log\n").unwrap();
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(crate::db::open_memory(), crate::state::Paths::new(data.path().to_path_buf()));
        state
            .with(|c| {
                let p = crate::domain::projects::create_project(c, &crate::domain::projects::ProjectInput { name: "Reactor".into(), ..Default::default() })?;
                folders::link(c, &p.id, &root.to_string_lossy(), folders::Trust::Restricted)?;
                Ok(())
            })
            .unwrap();
        let st = index_root(&state, &root).unwrap();
        assert_eq!(st.files, 2, "only src/reactorCooling.ts and .gitignore");
        let code = state.with(|c| search(c, "ventCoolant", None, true, 10)).unwrap();
        assert_eq!(code.len(), 1);
        assert_eq!(code[0].rel, "src/reactorCooling.ts");
        let names = state.with(|c| search(c, "rcool", None, false, 10)).unwrap();
        assert_eq!(names[0].name, "reactorCooling.ts");
        // Unchanged files aren't re-read; removed files leave the index.
        assert_eq!(index_root(&state, &root).unwrap().updated, 0);
        std::fs::remove_file(root.join("src/reactorCooling.ts")).unwrap();
        assert_eq!(index_root(&state, &root).unwrap().removed, 1);
        assert!(state.with(|c| search(c, "ventCoolant", None, true, 10)).unwrap().is_empty());
    }
}
