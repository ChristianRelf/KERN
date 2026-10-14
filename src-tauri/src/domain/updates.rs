//! Update check: compares the running version with the newest published
//! GitHub release. Read-only and unauthenticated. Downloading and installing
//! is done by the updater plugin (signed installers listed in the release's
//! `latest.json`); this module also fetches a release's notes for the
//! "What's new" dialog shown after updating.
//!
//! The interface polls often (every minute while Kern is visible), so the
//! last response's ETag is sent back: an unchanged release list comes back
//! as 304, which GitHub doesn't count against the unauthenticated rate limit.

use crate::domain::settings;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use semver::Version;
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const RELEASES_API: &str = "https://api.github.com/repos/ChristianRelf/KERN/releases?per_page=20";
pub const RELEASES_PAGE: &str = "https://github.com/ChristianRelf/KERN/releases";

/// Debug builds can point the check at a local stand-in (`KERN_RELEASES_API`)
/// to try the update notice; release builds always ask GitHub.
fn releases_api() -> String {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("KERN_RELEASES_API") {
        return url;
    }
    RELEASES_API.to_string()
}

/// The last release list GitHub sent, with its ETag.
struct Cached {
    etag: String,
    releases: Vec<Value>,
}
static LAST: Mutex<Option<Cached>> = Mutex::new(None);

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    /// The newest release when it is newer than the running version.
    pub latest: Option<String>,
    pub url: String,
    /// A release newer than the running version fixes a security issue, so
    /// the update is required (Kern installs it without asking).
    pub security: bool,
}

/// Marks a security release: written at the top of its notes (an HTML
/// comment, so invisible on GitHub). `npm run release -- --security` adds it.
pub const SECURITY_MARKER: &str = "<!-- kern:security -->";

fn is_security(release: &Value) -> bool {
    release.get("body").and_then(Value::as_str).is_some_and(|b| b.to_ascii_lowercase().contains(SECURITY_MARKER))
}

fn parse(tag: &str) -> Option<Version> {
    Version::parse(tag.trim().trim_start_matches(['v', 'V'])).ok()
}

/// The newest non-draft release newer than `current`, and whether any
/// release newer than `current` is a security release (skipping one doesn't
/// make it optional). Pre-releases count: Kern ships betas through the same
/// channel.
fn newest(releases: &[Value], current: &Version) -> Option<(Version, String, bool)> {
    let newer: Vec<(Version, String, bool)> = releases
        .iter()
        .filter(|r| !r.get("draft").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|r| {
            let v = parse(r.get("tag_name")?.as_str()?)?;
            let url = r.get("html_url").and_then(Value::as_str).unwrap_or(RELEASES_PAGE).to_string();
            Some((v, url, is_security(r)))
        })
        .filter(|(v, _, _)| v > current)
        .collect();
    let security = newer.iter().any(|r| r.2);
    newer.into_iter().max_by(|a, b| a.0.cmp(&b.0)).map(|(v, url, _)| (v, url, security))
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> AppResult<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let network: bool = state.with(|c| Ok(settings::get_or(c, "privacy.network", true)))?;
        let none = UpdateInfo { current: current.clone(), latest: None, url: RELEASES_PAGE.to_string(), security: false };
        let Some(cur) = parse(&current) else { return Ok(none) };
        if !network {
            return Ok(none);
        }
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(15)))
            .http_status_as_error(false)
            .user_agent("Kern")
            .build()
            .into();
        let etag = LAST.lock().ok().and_then(|l| l.as_ref().map(|c| c.etag.clone()));
        let mut req = agent.get(&releases_api()).header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(tag) = &etag {
            req = req.header("If-None-Match", tag);
        }
        let mut resp = req.call().map_err(|e| AppError::Network(format!("Couldn't reach GitHub ({e}).")))?;
        let status = resp.status().as_u16();
        let releases: Vec<Value> = if status == 304 {
            LAST.lock().ok().and_then(|l| l.as_ref().map(|c| c.releases.clone())).unwrap_or_default()
        } else if status >= 400 {
            return Err(AppError::Network(format!("GitHub returned {status}.")));
        } else {
            let new_etag = resp.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_string);
            let text = resp.body_mut().with_config().limit(4 * 1024 * 1024).read_to_string().unwrap_or_default();
            let releases: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
            if let (Some(etag), Ok(mut last)) = (new_etag, LAST.lock()) {
                *last = Some(Cached { etag, releases: releases.clone() });
            }
            releases
        };
        Ok(match newest(&releases, &cur) {
            Some((v, url, security)) => UpdateInfo { current, latest: Some(v.to_string()), url, security },
            None => none,
        })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotes {
    pub version: String,
    pub name: String,
    /// Markdown, as written on the release page.
    pub body: String,
    pub url: String,
    pub published_at: Option<String>,
}

/// The notes of the release tagged `v{version}`, read from GitHub.
#[tauri::command]
pub async fn release_notes(app: AppHandle, version: String) -> AppResult<ReleaseNotes> {
    let Some(v) = parse(&version) else {
        return Err(AppError::Invalid(format!("'{version}' isn't a version.")));
    };
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let network: bool = state.with(|c| Ok(settings::get_or(c, "privacy.network", true)))?;
        if !network {
            return Err(AppError::Network("Network access is turned off in Settings → Privacy.".into()));
        }
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(15)))
            .http_status_as_error(false)
            .user_agent("Kern")
            .build()
            .into();
        let api = releases_api();
        let url = format!("{}/tags/v{v}", api.split('?').next().unwrap_or(RELEASES_API));
        let mut resp = agent
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .call()
            .map_err(|e| AppError::Network(format!("Couldn't reach GitHub ({e}).")))?;
        let status = resp.status().as_u16();
        if status == 404 {
            return Err(AppError::NotFound(format!("Release v{v}")));
        }
        if status >= 400 {
            return Err(AppError::Network(format!("GitHub returned {status}.")));
        }
        let text = resp.body_mut().with_config().limit(1024 * 1024).read_to_string().map_err(|e| AppError::Network(e.to_string()))?;
        let r: Value = serde_json::from_str(&text).map_err(|e| AppError::Network(format!("Unexpected reply from GitHub ({e}).")))?;
        Ok(notes_from(&r, &v))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

fn notes_from(r: &Value, v: &Version) -> ReleaseNotes {
    let s = |k: &str| r.get(k).and_then(Value::as_str).map(str::to_string);
    ReleaseNotes {
        version: v.to_string(),
        name: s("name").filter(|n| !n.trim().is_empty()).unwrap_or_else(|| format!("Kern {v}")),
        body: s("body").unwrap_or_default(),
        url: s("html_url").unwrap_or_else(|| RELEASES_PAGE.to_string()),
        published_at: s("published_at"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picks_newest_newer_release() {
        let rs = vec![
            json!({ "tag_name": "v0.1.1-beta", "html_url": "a", "draft": false }),
            json!({ "tag_name": "v0.2.0-beta", "html_url": "b", "draft": false }),
            json!({ "tag_name": "v0.3.0", "html_url": "c", "draft": true }),
            json!({ "tag_name": "nightly", "html_url": "d", "draft": false }),
        ];
        let cur = parse("0.1.1-beta").unwrap();
        assert_eq!(newest(&rs, &cur).map(|(v, u, _)| (v.to_string(), u)), Some(("0.2.0-beta".into(), "b".into())));
        assert!(newest(&rs, &parse("0.2.0").unwrap()).is_none());
        // A stable release outranks its own beta.
        assert!(newest(&[json!({ "tag_name": "v0.1.1", "html_url": "e" })], &cur).is_some());
    }

    #[test]
    fn a_skipped_security_release_still_requires_the_update() {
        let rs = vec![
            json!({ "tag_name": "v0.1.12", "html_url": "c", "body": "Small fixes" }),
            json!({ "tag_name": "v0.1.11", "html_url": "b", "body": "<!-- KERN:SECURITY -->
## What's new" }),
            json!({ "tag_name": "v0.1.10", "html_url": "a", "body": "<!-- kern:security -->" }),
        ];
        let (v, url, security) = newest(&rs, &parse("0.1.10").unwrap()).unwrap();
        assert_eq!((v.to_string(), url.as_str(), security), ("0.1.12".into(), "c", true));
        // Security releases already installed don't count.
        assert!(!newest(&rs, &parse("0.1.11").unwrap()).unwrap().2);
        assert!(!newest(&rs[..1], &parse("0.1.9").unwrap()).unwrap().2);
    }

    #[test]
    fn reads_release_notes() {
        let v = parse("0.2.0").unwrap();
        let n = notes_from(&json!({ "name": "", "body": "## What's new", "html_url": "u", "published_at": "2026-10-14T00:00:00Z" }), &v);
        assert_eq!((n.name.as_str(), n.body.as_str(), n.url.as_str()), ("Kern 0.2.0", "## What's new", "u"));
        assert_eq!(notes_from(&json!({}), &v).url, RELEASES_PAGE);
    }
}
