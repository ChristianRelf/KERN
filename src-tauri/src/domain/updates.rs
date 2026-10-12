//! Update check: compares the running version with the newest published
//! GitHub release. Read-only and unauthenticated; it never downloads or
//! installs anything, the interface just links to the release page.

use crate::domain::settings;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use semver::Version;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const RELEASES_API: &str = "https://api.github.com/repos/ChristianRelf/KERN/releases?per_page=20";
pub const RELEASES_PAGE: &str = "https://github.com/ChristianRelf/KERN/releases";

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    /// The newest release when it is newer than the running version.
    pub latest: Option<String>,
    pub url: String,
}

fn parse(tag: &str) -> Option<Version> {
    Version::parse(tag.trim().trim_start_matches(['v', 'V'])).ok()
}

/// The newest non-draft release newer than `current`. Pre-releases count:
/// Kern ships betas through the same channel.
fn newest(releases: &[Value], current: &Version) -> Option<(Version, String)> {
    releases
        .iter()
        .filter(|r| !r.get("draft").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|r| {
            let v = parse(r.get("tag_name")?.as_str()?)?;
            let url = r.get("html_url").and_then(Value::as_str).unwrap_or(RELEASES_PAGE).to_string();
            Some((v, url))
        })
        .filter(|(v, _)| v > current)
        .max_by(|a, b| a.0.cmp(&b.0))
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> AppResult<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let network: bool = state.with(|c| Ok(settings::get_or(c, "privacy.network", true)))?;
        let none = UpdateInfo { current: current.clone(), latest: None, url: RELEASES_PAGE.to_string() };
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
        let mut resp = agent
            .get(RELEASES_API)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .call()
            .map_err(|e| AppError::Network(format!("Couldn't reach GitHub ({e}).")))?;
        if resp.status().as_u16() >= 400 {
            return Err(AppError::Network(format!("GitHub returned {}.", resp.status().as_u16())));
        }
        let text = resp.body_mut().with_config().limit(4 * 1024 * 1024).read_to_string().unwrap_or_default();
        let releases: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
        Ok(match newest(&releases, &cur) {
            Some((v, url)) => UpdateInfo { current, latest: Some(v.to_string()), url },
            None => none,
        })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
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
        assert_eq!(newest(&rs, &cur).map(|(v, u)| (v.to_string(), u)), Some(("0.2.0-beta".into(), "b".into())));
        assert!(newest(&rs, &parse("0.2.0").unwrap()).is_none());
        // A stable release outranks its own beta.
        assert!(newest(&[json!({ "tag_name": "v0.1.1", "html_url": "e" })], &cur).is_some());
    }
}
