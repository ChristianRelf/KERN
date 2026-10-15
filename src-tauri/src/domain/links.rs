// @Author Christian Relf
// @Date 2026-10-12

//! Link enrichment: website favicons and page titles, fetched directly from
//! the linked site (no third-party proxy) and cached locally.
//!
//! Safety: only http(s) URLs to public hosts. Hosts that resolve to loopback,
//! private, link-local or other internal ranges are refused, and every
//! redirect hop is re-checked, so a link can't make Kern reach internal
//! services or local files. Responses are size- and time-limited, images are
//! validated by their bytes, and SVGs containing scripts, event handlers or
//! external references are discarded (cached SVGs are only ever shown via
//! <img>, which never runs scripts). Nothing is fetched when remote favicons
//! or external network requests are turned off in Privacy settings.

use crate::domain::{settings, system};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::now_ms;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const DAY: i64 = 86_400_000;

// ------------------------------------------------------------ URL safety

fn ip_is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_broadcast()
                || v.is_documentation()
                || v.is_unspecified()
                || v.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (64..128).contains(&o[1])) // carrier-grade NAT
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // benchmarking
                || o[0] >= 240)
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return ip_is_public(IpAddr::V4(v4));
            }
            let s = v.segments();
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80) // link local
        }
    }
}

/// Parses and checks a URL; returns it with its origin (scheme://host[:port]).
pub fn checked_url(raw: &str) -> AppResult<(url::Url, String)> {
    let u = url::Url::parse(raw.trim()).map_err(|_| AppError::Invalid("That isn't a valid web address.".into()))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return invalid("Only http and https links are fetched.");
    }
    if !u.username().is_empty() || u.password().is_some() {
        return invalid("Links with embedded credentials aren't fetched.");
    }
    let host = u.host_str().ok_or_else(|| AppError::Invalid("The link has no host.".into()))?.to_ascii_lowercase();
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        if !ip_is_public(ip) {
            return invalid("Links to local or private addresses aren't fetched.");
        }
    } else if host == "localhost" || !host.contains('.') || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") || host.ends_with(".lan") || host.ends_with(".home.arpa") {
        return invalid("Links to local network names aren't fetched.");
    }
    let origin = u.origin().ascii_serialization();
    Ok((u, origin))
}

/// Resolves the host and refuses it if any address is internal.
fn check_resolves_public(u: &url::Url) -> AppResult<()> {
    let host = u.host_str().unwrap_or_default();
    let port = u.port_or_known_default().unwrap_or(443);
    let addrs: Vec<_> = (host, port).to_socket_addrs().map_err(|_| AppError::Network("Couldn't find that site.".into()))?.collect();
    if addrs.is_empty() || addrs.iter().any(|a| !ip_is_public(a.ip())) {
        return invalid("That site resolves to a local or private address, so it isn't fetched.");
    }
    Ok(())
}

pub struct Fetched {
    pub final_url: url::Url,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// GET with manual redirects (each hop re-validated), a timeout and a size cap.
pub fn safe_get(start: &url::Url, max_bytes: u64) -> AppResult<Fetched> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(6)))
        .max_redirects(0)
        .http_status_as_error(false)
        .user_agent("Mozilla/5.0 (compatible; Kern link preview)")
        .build()
        .into();
    let mut url = start.clone();
    for _ in 0..5 {
        checked_url(url.as_str())?;
        check_resolves_public(&url)?;
        let mut resp = agent.get(url.as_str()).call().map_err(|e| AppError::Network(format!("Couldn't reach the site ({e}).")))?;
        let status = resp.status().as_u16();
        if (300..400).contains(&status) {
            let loc = resp.headers().get("location").and_then(|v| v.to_str().ok()).ok_or_else(|| AppError::Network("Bad redirect.".into()))?;
            url = url.join(loc).map_err(|_| AppError::Network("Bad redirect.".into()))?;
            continue;
        }
        if status != 200 {
            return Err(AppError::Network(format!("The site answered {status}.")));
        }
        let content_type = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
        let bytes = resp
            .body_mut()
            .with_config()
            .limit(max_bytes)
            .read_to_vec()
            .map_err(|_| AppError::Network("The response was too large or incomplete.".into()))?;
        return Ok(Fetched { final_url: url, content_type, bytes });
    }
    Err(AppError::Network("Too many redirects.".into()))
}

fn network_allowed(conn: &Connection) -> bool {
    settings::get_or(conn, "privacy.network", true)
}

// ------------------------------------------------------------ favicons

/// Image type from content bytes (never trust the extension or header alone).
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0, 0, 1, 0]) || bytes.starts_with(&[0, 0, 2, 0]) {
        Some("ico")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.starts_with(b"BM") && bytes.len() > 26 {
        Some("bmp")
    } else {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_ascii_lowercase();
        (head.trim_start().starts_with("<svg") || (head.trim_start().starts_with("<?xml") && head.contains("<svg"))).then_some("svg")
    }
}

/// True if an SVG has no scripts, event handlers, entities or external references.
pub fn svg_is_safe(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    if ["<script", "javascript:", "<foreignobject", "<!entity", "<!doctype", "<iframe", "<embed", "<object", "data:text/html"].iter().any(|p| t.contains(p)) {
        return false;
    }
    // href/src may only point at fragments (#id) or embedded data images.
    for attr in ["href=", "src="] {
        let mut pos = 0;
        while let Some(i) = t[pos..].find(attr) {
            let start = pos + i + attr.len();
            let rest = t[start..].trim_start_matches(['"', '\'']);
            if !(rest.starts_with('#') || rest.starts_with("data:image/")) {
                return false;
            }
            pos = start;
        }
    }
    // Event handler attributes: whitespace + "on" + letters + "=".
    let bytes = t.as_bytes();
    for i in 0..bytes.len().saturating_sub(3) {
        if bytes[i].is_ascii_whitespace() && bytes[i + 1] == b'o' && bytes[i + 2] == b'n' {
            let mut j = i + 3;
            while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
                j += 1;
            }
            if j > i + 3 && j < bytes.len() && bytes[j] == b'=' {
                return false;
            }
        }
    }
    true
}

/// Candidate icon URLs from a page's <link rel="…icon…"> tags, best first.
pub fn icon_candidates(page: &url::Url, html: &str) -> Vec<url::Url> {
    let lower = html.to_ascii_lowercase();
    let head_end = lower.find("</head>").unwrap_or(lower.len().min(300_000));
    let (head, lower_head) = (&html[..head_end], &lower[..head_end]);
    let mut found: Vec<(i32, url::Url)> = vec![];
    let mut pos = 0;
    while let Some(i) = lower_head[pos..].find("<link") {
        let start = pos + i;
        let Some(end) = lower_head[start..].find('>') else { break };
        let tag = &head[start..start + end + 1];
        pos = start + end + 1;
        let rel = system::attr(tag, "rel").unwrap_or_default().to_ascii_lowercase();
        if !rel.split_whitespace().any(|r| r == "icon" || r == "apple-touch-icon") {
            continue;
        }
        let Some(href) = system::attr(tag, "href") else { continue };
        let Ok(u) = page.join(href.trim()) else { continue };
        let sizes = system::attr(tag, "sizes").unwrap_or_default();
        let ty = system::attr(tag, "type").unwrap_or_default();
        let largest = sizes.split_whitespace().filter_map(|s| s.split('x').next()?.parse::<i32>().ok()).max().unwrap_or(0);
        // Favour crisp, small-to-medium icons; SVG scales perfectly.
        let score = if ty.contains("svg") || href.ends_with(".svg") {
            90
        } else if (32..=96).contains(&largest) {
            80
        } else if rel.contains("apple-touch-icon") {
            60
        } else if largest > 96 {
            55
        } else {
            50
        };
        found.push((score, u));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out: Vec<url::Url> = found.into_iter().map(|(_, u)| u).collect();
    if let Ok(ico) = page.join("/favicon.ico") {
        out.push(ico);
    }
    out.dedup();
    out
}

fn file_name_for(origin: &str, ext: &str) -> String {
    let safe: String = origin.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect();
    format!("{safe}.{ext}")
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Favicon {
    pub origin: String,
    /// Absolute path of the cached icon, if one exists.
    pub path: Option<String>,
    /// ok | none (site has no usable icon) | error | disabled
    pub status: String,
}

fn cached(conn: &Connection, dir: &Path, origin: &str) -> AppResult<Option<(Favicon, i64)>> {
    let row: Option<(Option<String>, String, i64)> = conn
        .query_row("SELECT file, status, expires_at FROM favicon_cache WHERE origin = ?1", [origin], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    Ok(row.and_then(|(file, status, expires)| {
        let path = file.map(|f| dir.join(f)).filter(|p| p.is_file());
        // A row claiming an icon whose file is gone (cache cleared) is stale.
        if status == "ok" && path.is_none() {
            return None;
        }
        Some((Favicon { origin: origin.into(), path: path.map(|p| p.to_string_lossy().to_string()), status }, expires))
    }))
}

fn fetch_icon(page: &url::Url) -> AppResult<Option<(Vec<u8>, &'static str)>> {
    let mut candidates = vec![];
    if let Ok(f) = safe_get(page, 512 * 1024) {
        candidates = icon_candidates(&f.final_url, &String::from_utf8_lossy(&f.bytes));
    } else if let Ok(ico) = page.join("/favicon.ico") {
        candidates.push(ico);
    }
    for c in candidates.into_iter().take(4) {
        let Ok(f) = safe_get(&c, 256 * 1024) else { continue };
        let Some(kind) = sniff_image(&f.bytes) else { continue };
        if kind == "svg" && !svg_is_safe(&String::from_utf8_lossy(&f.bytes)) {
            continue;
        }
        if f.bytes.len() < 32 {
            continue;
        }
        return Ok(Some((f.bytes, kind)));
    }
    Ok(None)
}

/// One lock per origin: concurrent requests for the same site wait for the
/// first fetch and then read its cached result.
fn origin_lock(origin: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut map = LOCKS.get_or_init(Default::default).lock().unwrap();
    if map.len() > 512 {
        map.retain(|_, l| Arc::strong_count(l) > 1);
    }
    map.entry(origin.to_string()).or_default().clone()
}

pub fn favicon_for(state: &AppState, raw_url: &str) -> AppResult<Favicon> {
    let (u, origin) = checked_url(raw_url)?;
    let dir = state.paths.favicons_dir();
    let lock = origin_lock(&origin);
    let _guard = lock.lock().map_err(|_| AppError::Other("Favicon lock poisoned".into()))?;
    let (hit, allowed) = state.with(|c| Ok((cached(c, &dir, &origin)?, network_allowed(c) && settings::get_or(c, "privacy.favicons", true))))?;
    if let Some((fav, expires)) = &hit {
        if *expires > now_ms() || !allowed {
            return Ok(fav.clone());
        }
    }
    if !allowed {
        return Ok(Favicon { origin, path: None, status: "disabled".into() });
    }
    let page = u.join("/").unwrap_or(u.clone());
    let (status, file, ttl) = match fetch_icon(&page) {
        Ok(Some((bytes, ext))) => {
            std::fs::create_dir_all(&dir)?;
            let name = file_name_for(&origin, ext);
            system::atomic_write(&dir.join(&name), &bytes)?;
            ("ok", Some(name), 30 * DAY)
        }
        Ok(None) => ("none", None, 7 * DAY),
        // Offline or blocked: keep any older icon, try again later.
        Err(_) => match &hit {
            Some((fav, _)) if fav.path.is_some() => return Ok(fav.clone()),
            _ => ("error", None, DAY / 4),
        },
    };
    state.with(|c| {
        c.execute(
            "INSERT INTO favicon_cache(origin, file, status, fetched_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(origin) DO UPDATE SET file = excluded.file, status = excluded.status, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at",
            params![origin, file, status, now_ms(), now_ms() + ttl],
        )?;
        Ok(())
    })?;
    Ok(Favicon { origin, path: file.map(|f| dir.join(f).to_string_lossy().to_string()), status: status.into() })
}

#[tauri::command]
pub async fn favicon_get(app: AppHandle, url: String) -> AppResult<Favicon> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || favicon_for(&handle.state::<AppState>(), &url))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

// ------------------------------------------------------------ titles

/// Page title/description for a link (opt-in), cached for 30 days.
#[tauri::command]
pub async fn link_metadata(app: AppHandle, url: String) -> AppResult<system::LinkMetadata> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let (u, _) = checked_url(&url)?;
        let key = u.to_string();
        let (allowed, hit) = state.with(|c| {
            let hit: Option<(Option<String>, Option<String>, Option<String>, i64)> = c
                .query_row("SELECT title, description, site_name, fetched_at FROM link_metadata WHERE url = ?1", [&key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .optional()?;
            Ok((network_allowed(c) && settings::get_or(c, "data.linkPreviews", true), hit))
        })?;
        if let Some((title, description, site_name, at)) = &hit {
            if now_ms() - at < 30 * DAY || !allowed {
                return Ok(system::LinkMetadata { url: key, title: title.clone(), description: description.clone(), site_name: site_name.clone(), image: None });
            }
        }
        if !allowed {
            return invalid("Fetching link titles is turned off in Privacy settings.");
        }
        let f = safe_get(&u, 2 * 1024 * 1024)?;
        let m = system::parse_metadata(f.final_url.as_str(), &String::from_utf8_lossy(&f.bytes));
        state.with(|c| {
            c.execute(
                "INSERT INTO link_metadata(url, title, description, site_name, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(url) DO UPDATE SET title = excluded.title, description = excluded.description, site_name = excluded.site_name, fetched_at = excluded.fetched_at",
                params![key, m.title, m.description, m.site_name, now_ms()],
            )?;
            Ok(())
        })?;
        Ok(system::LinkMetadata { url: key, image: None, ..m })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_internal_and_non_web_urls() {
        for bad in ["file:///C:/Windows/win.ini", "http://localhost:8080", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1", "http://[::1]/", "http://169.254.169.254/latest", "http://router.local/", "http://intranet/", "javascript:alert(1)", "https://user:pass@example.com"] {
            assert!(checked_url(bad).is_err(), "{bad} should be refused");
        }
        let (_, origin) = checked_url("https://GitHub.com/example/project?x=1").unwrap();
        assert_eq!(origin, "https://github.com");
    }

    #[test]
    fn sniffs_images_by_bytes() {
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(sniff_image(&[0, 0, 1, 0, 1, 0]), Some("ico"));
        assert_eq!(sniff_image(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>"), Some("svg"));
        assert_eq!(sniff_image(b"<html>not an icon</html>"), None);
    }

    #[test]
    fn rejects_dangerous_svg() {
        assert!(svg_is_safe(r##"<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/><path d="M0 0"/></svg>"##));
        assert!(!svg_is_safe(r#"<svg><script>alert(1)</script></svg>"#));
        assert!(!svg_is_safe(r#"<svg onload="alert(1)"></svg>"#));
        assert!(!svg_is_safe(r#"<svg><image href="https://tracker.example/x.png"/></svg>"#));
        assert!(!svg_is_safe(r#"<svg><a href="javascript:alert(1)">x</a></svg>"#));
    }

    #[test]
    fn finds_icon_candidates() {
        let page = url::Url::parse("https://example.com/docs/").unwrap();
        let html = r#"<head><link rel="apple-touch-icon" href="/apple.png"><link rel="icon" type="image/png" sizes="32x32" href="icons/32.png"><link rel="stylesheet" href="x.css"></head>"#;
        let c = icon_candidates(&page, html);
        assert_eq!(c[0].as_str(), "https://example.com/docs/icons/32.png");
        assert_eq!(c[1].as_str(), "https://example.com/apple.png");
        assert_eq!(c.last().unwrap().as_str(), "https://example.com/favicon.ico");
    }
}
