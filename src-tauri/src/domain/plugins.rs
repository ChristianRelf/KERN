// @Author Christian Relf
// @Date 2026-10-12

//! Syntax plugins: TextMate grammars for the file viewer's highlighting.
//!
//! Grammars are plain JSON data, never code. They come from the pinned
//! tm-grammars package on the jsDelivr CDN, and every download is checked
//! against the SHA-256 recorded in `plugins_catalog.rs` before it is saved
//! under `<data dir>/plugins/syntax/`. Only names in that catalog can be
//! requested, so the download address can't be steered anywhere else.
//! Downloads respect the "External network requests" and "Allow plugin and
//! syntax downloads" privacy settings.

use crate::domain::folders::root_of;
use crate::domain::git::SKIP_DIRS;
use crate::domain::plugins_catalog::{GRAMMARS, TM_GRAMMARS_VERSION};
use crate::domain::settings;
use crate::domain::system::atomic_write;
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

fn syntax_dir(state: &AppState) -> PathBuf {
    state.paths.data_dir.join("plugins").join("syntax")
}

fn catalog_entry(name: &str) -> AppResult<(&'static str, &'static str, u64)> {
    GRAMMARS.iter().copied().find(|(n, _, _)| *n == name).ok_or_else(|| AppError::Invalid(format!("'{name}' isn't a known syntax.")))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// A stored grammar is only used when it still matches its recorded hash.
fn installed_ok(dir: &Path, name: &str, hash: &str) -> bool {
    std::fs::read(dir.join(format!("{name}.json"))).map(|b| sha256_hex(&b) == hash).unwrap_or(false)
}

async fn blocking<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&AppState) -> AppResult<T> + Send + 'static) -> AppResult<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>()))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

/// Names of the grammars installed and intact.
#[tauri::command]
pub async fn syntax_installed(app: AppHandle) -> AppResult<Vec<String>> {
    blocking(&app, |s| {
        let dir = syntax_dir(s);
        Ok(GRAMMARS.iter().filter(|(n, h, _)| installed_ok(&dir, n, h)).map(|(n, _, _)| n.to_string()).collect())
    })
    .await
}

/// Downloads and verifies grammars. Already-installed ones are skipped.
#[tauri::command]
pub async fn syntax_install(app: AppHandle, names: Vec<String>) -> AppResult<Vec<String>> {
    blocking(&app, move |s| {
        let (network, downloads): (bool, bool) =
            s.with(|c| Ok((settings::get_or(c, "privacy.network", true), settings::get_or(c, "privacy.pluginDownloads", true))))?;
        if !network {
            return invalid("External network requests are turned off in Privacy settings, so syntaxes can't be downloaded.");
        }
        if !downloads {
            return invalid("Plugin and syntax downloads are turned off in Privacy settings.");
        }
        let dir = syntax_dir(s);
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(60)))
            .http_status_as_error(false)
            .user_agent("Kern")
            .build()
            .into();
        let mut done = vec![];
        for name in names {
            let (name, hash, size) = catalog_entry(&name)?;
            if installed_ok(&dir, name, hash) {
                done.push(name.to_string());
                continue;
            }
            let url = format!("https://cdn.jsdelivr.net/npm/tm-grammars@{TM_GRAMMARS_VERSION}/grammars/{name}.json");
            let mut resp = agent.get(&url).call().map_err(|e| AppError::Network(format!("Couldn't download the {name} syntax ({e}).")))?;
            if resp.status().as_u16() != 200 {
                return Err(AppError::Network(format!("The plugin server returned {} for the {name} syntax.", resp.status().as_u16())));
            }
            let bytes = resp.body_mut().with_config().limit(size + 1024).read_to_vec().map_err(|e| AppError::Network(format!("The {name} syntax download failed ({e}).")))?;
            if sha256_hex(&bytes) != hash {
                return invalid(&format!("The {name} syntax didn't match its expected checksum, so it wasn't installed."));
            }
            atomic_write(&dir.join(format!("{name}.json")), &bytes)?;
            done.push(name.to_string());
        }
        Ok(done)
    })
    .await
}

#[tauri::command]
pub async fn syntax_remove(app: AppHandle, names: Vec<String>) -> AppResult<()> {
    blocking(&app, move |s| {
        let dir = syntax_dir(s);
        for name in names {
            let (name, _, _) = catalog_entry(&name)?;
            match std::fs::remove_file(dir.join(format!("{name}.json"))) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            }
        }
        Ok(())
    })
    .await
}

/// A verified grammar's JSON, for the highlighter.
#[tauri::command]
pub async fn syntax_grammar(app: AppHandle, name: String) -> AppResult<String> {
    blocking(&app, move |s| {
        let (name, hash, _) = catalog_entry(&name)?;
        let bytes = std::fs::read(syntax_dir(s).join(format!("{name}.json"))).map_err(|_| AppError::NotFound(format!("The {name} syntax")))?;
        if sha256_hex(&bytes) != hash {
            return invalid(&format!("The {name} syntax file is damaged. Reinstall it from Settings → Plugins."));
        }
        String::from_utf8(bytes).map_err(|_| AppError::Invalid("Damaged syntax file.".into()))
    })
    .await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileKindCount {
    /// Lower-case extension, or the whole lower-case name for files without one.
    pub key: String,
    pub count: u32,
}

/// Counts file extensions in a folder (skipping dependencies, build output
/// and hidden folders), most common first. Reads names only, never contents.
pub fn count_file_kinds(root: &Path, max_files: usize) -> Vec<FileKindCount> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut seen = 0;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            let Ok(meta) = std::fs::symlink_metadata(e.path()) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if depth < 8 && !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                    stack.push((e.path(), depth + 1));
                }
                continue;
            }
            seen += 1;
            if seen > max_files {
                break;
            }
            let key = match name.rfind('.') {
                Some(i) if i > 0 => name[i + 1..].to_string(),
                _ => name,
            };
            *counts.entry(key).or_default() += 1;
        }
        if seen > max_files {
            break;
        }
    }
    let mut out: Vec<FileKindCount> = counts.into_iter().map(|(key, count)| FileKindCount { key, count }).collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then(a.key.cmp(&b.key)));
    out.truncate(60);
    out
}

#[tauri::command]
pub async fn project_file_kinds(app: AppHandle, project_id: String) -> AppResult<Vec<FileKindCount>> {
    blocking(&app, move |s| {
        let (root, _) = s.with(|c| root_of(c, &project_id))?;
        Ok(count_file_kinds(&root, 20_000))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_well_formed() {
        assert!(GRAMMARS.len() > 50);
        for (name, hash, size) in GRAMMARS {
            assert!(name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'), "{name}");
            assert_eq!(hash.len(), 64, "{name}");
            assert!(*size > 0);
        }
        assert!(catalog_entry("typescript").is_ok());
        assert!(catalog_entry("../../etc/passwd").is_err());
    }

    #[test]
    fn counts_kinds_and_skips_dependencies() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        for f in ["src/a.ts", "src/b.ts", "src/deep/c.TS", "src/d.css", "Dockerfile", "node_modules/x/y.js"] {
            std::fs::write(root.join(f), "").unwrap();
        }
        let kinds = count_file_kinds(root, 1000);
        assert_eq!(kinds[0], FileKindCount { key: "ts".into(), count: 3 });
        assert!(kinds.iter().any(|k| k.key == "dockerfile"));
        assert!(!kinds.iter().any(|k| k.key == "js"));
    }
}
