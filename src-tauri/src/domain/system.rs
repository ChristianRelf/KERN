//! System integration commands: app info, opening links/files, file
//! read/write for exports chosen through native dialogs, link metadata.

use crate::db::SCHEMA_VERSION;
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use base64::Engine;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub schema_version: i64,
    pub data_dir: String,
    pub db_path: String,
    pub attachments_dir: String,
    pub default_backups_dir: String,
    pub platform: String,
    pub tauri_version: String,
    pub launched_at_login: bool,
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<AppState>) -> AppInfo {
    let p = &state.paths;
    AppInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        schema_version: SCHEMA_VERSION,
        data_dir: p.data_dir.to_string_lossy().to_string(),
        db_path: p.db_path.to_string_lossy().to_string(),
        attachments_dir: p.attachments_dir.to_string_lossy().to_string(),
        default_backups_dir: p.default_backups_dir.to_string_lossy().to_string(),
        platform: std::env::consts::OS.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        launched_at_login: std::env::args().any(|a| a == "--autostart"),
    }
}

/// Opens a URL in the default browser or a file with its default app.
#[tauri::command]
pub fn open_external(app: AppHandle, target: String) -> AppResult<()> {
    let t = target.trim();
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:") {
        app.opener().open_url(t, None::<&str>).map_err(|e| AppError::Other(e.to_string()))
    } else if lower.starts_with("www.") {
        app.opener().open_url(format!("https://{t}"), None::<&str>).map_err(|e| AppError::Other(e.to_string()))
    } else {
        let p = PathBuf::from(t);
        if !p.exists() {
            return Err(AppError::NotFound(format!("'{t}'")));
        }
        app.opener().open_path(t, None::<&str>).map_err(|e| AppError::Other(e.to_string()))
    }
}

#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(AppError::NotFound(format!("'{path}'")));
    }
    app.opener().reveal_item_in_dir(p).map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    PathBuf::from(path).exists()
}

/// Writes text to a path the user picked in a native save dialog.
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> AppResult<()> {
    atomic_write(&PathBuf::from(path), contents.as_bytes())
}

#[tauri::command]
pub fn write_binary_file(path: String, data_base64: String) -> AppResult<()> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|_| AppError::Invalid("File data is malformed.".into()))?;
    atomic_write(&PathBuf::from(path), &bytes)
}

#[tauri::command]
pub fn read_text_file(path: String) -> AppResult<String> {
    let meta = std::fs::metadata(&path)?;
    if meta.len() > 64 * 1024 * 1024 {
        return invalid("File is too large to import.");
    }
    Ok(std::fs::read_to_string(path)?)
}

pub fn atomic_write(path: &PathBuf, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("kern-partial");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[tauri::command]
pub fn tray_set_visible(app: AppHandle, visible: bool) -> AppResult<()> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_visible(visible).map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle, state: State<AppState>) {
    state.quitting.store(true, std::sync::atomic::Ordering::SeqCst);
    crate::window::save_window_state(&app);
    app.exit(0);
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    crate::window::show_main(&app);
}

// ---------------------------------------------------------- link metadata

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinkMetadata {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub image: Option<String>,
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .trim()
        .to_string()
}

pub fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{name}=");
    let idx = lower.find(&needle)? + needle.len();
    let rest = &tag[idx..];
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        let end = rest[1..].find(quote)?;
        Some(rest[1..1 + end].to_string())
    } else {
        Some(rest.split(|c: char| c.is_whitespace() || c == '>').next()?.to_string())
    }
}

pub fn parse_metadata(url: &str, html: &str) -> LinkMetadata {
    let mut m = LinkMetadata { url: url.to_string(), ..Default::default() };
    let lower = html.to_ascii_lowercase();
    // Only the <head> matters; avoid scanning huge bodies.
    let head_end = lower.find("</head>").unwrap_or(lower.len().min(200_000));
    let head = &html[..head_end];
    let lower_head = &lower[..head_end];
    let mut pos = 0;
    while let Some(i) = lower_head[pos..].find("<meta") {
        let start = pos + i;
        let Some(end_rel) = lower_head[start..].find('>') else { break };
        let tag = &head[start..start + end_rel + 1];
        let key = attr(tag, "property").or_else(|| attr(tag, "name")).map(|k| k.to_ascii_lowercase());
        if let (Some(key), Some(content)) = (key, attr(tag, "content")) {
            let content = decode_entities(&content);
            match key.as_str() {
                "og:title" | "twitter:title" if m.title.is_none() => m.title = Some(content),
                "og:description" | "description" | "twitter:description" if m.description.is_none() => {
                    m.description = Some(content)
                }
                "og:site_name" => m.site_name = Some(content),
                "og:image" | "twitter:image" if m.image.is_none() => m.image = Some(content),
                _ => {}
            }
        }
        pos = start + end_rel + 1;
    }
    if m.title.is_none() {
        if let Some(s) = lower_head.find("<title") {
            if let Some(gt) = lower_head[s..].find('>') {
                let from = s + gt + 1;
                if let Some(e) = lower_head[from..].find("</title>") {
                    m.title = Some(decode_entities(&head[from..from + e]));
                }
            }
        }
    }
    if let Some(img) = m.image.clone() {
        if img.starts_with('/') && !img.starts_with("//") {
            let origin = url.split('/').take(3).collect::<Vec<_>>().join("/");
            m.image = Some(format!("{origin}{img}"));
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_og_and_title() {
        let html = r#"<html><head><title>Fallback &amp; title</title>
            <meta property="og:title" content="Real Title">
            <meta name="description" content='A "nice" page'>
            <meta property="og:image" content="/img.png"></head><body></body></html>"#;
        let m = parse_metadata("https://example.com/a/b", html);
        assert_eq!(m.title.as_deref(), Some("Real Title"));
        assert_eq!(m.description.as_deref(), Some("A \"nice\" page"));
        assert_eq!(m.image.as_deref(), Some("https://example.com/img.png"));
        let m = parse_metadata("https://x.y", "<head><title>Only &amp; this</title></head>");
        assert_eq!(m.title.as_deref(), Some("Only & this"));
    }
}
