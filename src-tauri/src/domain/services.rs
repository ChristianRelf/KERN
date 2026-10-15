// @Author Christian Relf
// @Date 2026-10-12

//! Local services a project depends on (a dev server, an API, a database),
//! configured explicitly by the user. Kern only checks what's configured,
//! only when asked (the client polls while the project is open), and never
//! scans the machine.
//!
//! Status is deliberately conservative: `running` means the endpoint
//! answered; `healthy` is only true when a configured HTTP check (status
//! and/or response text) passed. An open TCP port proves reachability, not
//! health. Docker is optional and only used on request.

use crate::domain::git::{self, blocking};
use crate::domain::settings;
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub url: String,
    pub health_path: Option<String>,
    pub expect_status: Option<String>,
    pub expect_text: Option<String>,
    pub command_id: Option<String>,
    pub repository_id: Option<String>,
    pub interval_secs: i64,
    pub enabled: bool,
    /// running | stopped | degraded | unknown
    pub status: String,
    /// Some(true) only when a configured health check passed.
    pub healthy: Option<bool>,
    pub detail: Option<String>,
    pub latency_ms: Option<i64>,
    pub checked_at: Option<i64>,
    pub history: Vec<Check>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub status: String,
    pub latency_ms: Option<i64>,
    pub detail: Option<String>,
    pub checked_at: i64,
}

const SELECT: &str = "SELECT id, project_id, name, url, health_path, expect_status, expect_text, command_id, repository_id, interval_secs, enabled,
  last_status, last_detail, last_latency_ms, last_checked_at FROM local_services";

fn has_check(health_path: &Option<String>, expect_status: &Option<String>, expect_text: &Option<String>) -> bool {
    health_path.as_deref().is_some_and(|s| !s.trim().is_empty()) || expect_status.as_deref().is_some_and(|s| !s.trim().is_empty()) || expect_text.as_deref().is_some_and(|s| !s.trim().is_empty())
}

fn map(r: &Row) -> rusqlite::Result<Service> {
    let health_path: Option<String> = r.get(4)?;
    let expect_status: Option<String> = r.get(5)?;
    let expect_text: Option<String> = r.get(6)?;
    let status: String = r.get(11)?;
    let checked = has_check(&health_path, &expect_status, &expect_text);
    Ok(Service {
        id: r.get(0)?,
        project_id: r.get(1)?,
        name: r.get(2)?,
        url: r.get(3)?,
        healthy: match (status.as_str(), checked) {
            ("running", true) => Some(true),
            ("degraded", true) => Some(false),
            _ => None,
        },
        health_path,
        expect_status,
        expect_text,
        command_id: r.get(7)?,
        repository_id: r.get(8)?,
        interval_secs: r.get(9)?,
        enabled: r.get::<_, i64>(10)? != 0,
        status,
        detail: r.get(12)?,
        latency_ms: r.get(13)?,
        checked_at: r.get(14)?,
        history: vec![],
    })
}

fn history(conn: &Connection, id: &str) -> AppResult<Vec<Check>> {
    let mut stmt = conn.prepare("SELECT status, latency_ms, detail, checked_at FROM service_checks WHERE service_id = ?1 ORDER BY checked_at DESC LIMIT 30")?;
    let rows = stmt.query_map([id], |r| Ok(Check { status: r.get(0)?, latency_ms: r.get(1)?, detail: r.get(2)?, checked_at: r.get(3)? }))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Service> {
    let mut s = conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], map).optional()?.ok_or_else(|| AppError::NotFound("Service".into()))?;
    s.history = history(conn, id)?;
    Ok(s)
}

pub fn list(conn: &Connection, project_id: &str) -> AppResult<Vec<Service>> {
    let mut stmt = conn.prepare(&format!("{SELECT} WHERE project_id = ?1 ORDER BY sort_order, name"))?;
    let mut out = stmt.query_map([project_id], map)?.collect::<Result<Vec<_>, _>>()?;
    for s in &mut out {
        s.history = history(conn, &s.id)?;
    }
    Ok(out)
}

/// Accepts http(s)://host[:port][/path] or tcp://host:port.
pub fn parse_endpoint(raw: &str) -> AppResult<url::Url> {
    let raw = raw.trim();
    let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("http://{raw}") };
    let u = url::Url::parse(&with_scheme).map_err(|_| AppError::Invalid("Enter an address like http://localhost:3000 or tcp://localhost:5432.".into()))?;
    match u.scheme() {
        "http" | "https" => {}
        "tcp" if u.port().is_some() => {}
        "tcp" => return invalid("A tcp:// address needs a port."),
        _ => return invalid("Use an http://, https:// or tcp:// address."),
    }
    if u.host_str().is_none() {
        return invalid("The address needs a host, e.g. localhost.");
    }
    Ok(u)
}

fn is_local(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") {
        return true;
    }
    let h = host.trim_matches(['[', ']']);
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(v)) => v.is_loopback() || v.is_private() || v.is_link_local() || v.is_unspecified(),
        Ok(IpAddr::V6(v)) => v.is_loopback() || (v.segments()[0] & 0xfe00) == 0xfc00 || v.is_unspecified(),
        Err(_) => false,
    }
}

/// Does `status` satisfy an expectation like "200", "2xx", "200-299" or "200,204"?
pub fn status_matches(expect: Option<&str>, status: u16) -> bool {
    let Some(e) = expect.map(str::trim).filter(|e| !e.is_empty()) else { return (200..400).contains(&status) };
    e.split(',').map(str::trim).any(|part| {
        if let Some((a, b)) = part.split_once('-') {
            matches!((a.trim().parse::<u16>(), b.trim().parse::<u16>()), (Ok(a), Ok(b)) if (a..=b).contains(&status))
        } else if part.len() == 3 && part.ends_with("xx") {
            part[..1].parse::<u16>().map(|d| status / 100 == d).unwrap_or(false)
        } else {
            part.parse::<u16>() == Ok(status)
        }
    })
}

struct Outcome {
    status: &'static str,
    latency: Option<i64>,
    detail: String,
}

fn probe(s: &Service, network_allowed: bool) -> Outcome {
    let u = match parse_endpoint(&s.url) {
        Ok(u) => u,
        Err(e) => return Outcome { status: "unknown", latency: None, detail: e.to_string() },
    };
    let host = u.host_str().unwrap_or("").to_string();
    if !is_local(&host) && !network_allowed {
        return Outcome { status: "unknown", latency: None, detail: "Not checked: external network requests are off in Privacy settings.".into() };
    }
    let start = Instant::now();
    if u.scheme() == "tcp" {
        let port = u.port().unwrap_or(0);
        let addrs: Vec<_> = match (host.trim_matches(['[', ']']), port).to_socket_addrs() {
            Ok(a) => a.collect(),
            Err(e) => return Outcome { status: "stopped", latency: None, detail: format!("Couldn't resolve {host} ({e}).") },
        };
        for a in addrs {
            if TcpStream::connect_timeout(&a, Duration::from_secs(2)).is_ok() {
                return Outcome { status: "running", latency: Some(start.elapsed().as_millis() as i64), detail: "Port is open (a TCP check can't confirm the service is healthy).".into() };
            }
        }
        return Outcome { status: "stopped", latency: None, detail: format!("Nothing is listening on {host}:{port}.") };
    }
    let mut target = u.clone();
    if let Some(p) = s.health_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        match u.join(p) {
            Ok(j) => target = j,
            Err(_) => return Outcome { status: "unknown", latency: None, detail: "The health-check path isn't valid.".into() },
        }
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(4)))
        .timeout_connect(Some(Duration::from_secs(2)))
        .http_status_as_error(false)
        .max_redirects(3)
        .user_agent("Kern service check")
        .build()
        .into();
    match agent.get(target.as_str()).call() {
        Err(e) => {
            let msg = e.to_string();
            let refused = msg.contains("refused") || msg.contains("Connection") || msg.contains("connect");
            Outcome { status: "stopped", latency: None, detail: if refused { "Not responding (connection refused).".into() } else { format!("Not responding ({msg}).") } }
        }
        Ok(mut resp) => {
            let latency = start.elapsed().as_millis() as i64;
            let code = resp.status().as_u16();
            if !status_matches(s.expect_status.as_deref(), code) {
                return Outcome { status: "degraded", latency: Some(latency), detail: format!("Responded with HTTP {code}.") };
            }
            if let Some(t) = s.expect_text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                let body = resp.body_mut().with_config().limit(256 * 1024).read_to_string().unwrap_or_default();
                if !body.contains(t) {
                    return Outcome { status: "degraded", latency: Some(latency), detail: format!("HTTP {code}, but the response didn't contain “{t}”.") };
                }
            }
            let checked = has_check(&s.health_path, &s.expect_status, &s.expect_text);
            Outcome {
                status: "running",
                latency: Some(latency),
                detail: if checked { format!("Health check passed (HTTP {code}).") } else { format!("Responded with HTTP {code}. Add a health check to confirm it's healthy.") },
            }
        }
    }
}

pub fn check(state: &AppState, id: &str) -> AppResult<Service> {
    let (svc, network) = state.with(|c| Ok((get(c, id)?, settings::get_or(c, "privacy.network", true))))?;
    let o = probe(&svc, network);
    let now = now_ms();
    state.with(|c| {
        c.execute(
            "UPDATE local_services SET last_status = ?1, last_detail = ?2, last_latency_ms = ?3, last_checked_at = ?4 WHERE id = ?5",
            params![o.status, o.detail, o.latency, now, id],
        )?;
        c.execute("INSERT INTO service_checks(service_id, status, latency_ms, detail, checked_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![id, o.status, o.latency, o.detail, now])?;
        c.execute(
            "DELETE FROM service_checks WHERE service_id = ?1 AND id NOT IN (SELECT id FROM service_checks WHERE service_id = ?1 ORDER BY checked_at DESC LIMIT 100)",
            [id],
        )?;
        get(c, id)
    })
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ServiceInput {
    pub id: Option<String>,
    pub project_id: String,
    pub name: String,
    pub url: String,
    pub health_path: Option<String>,
    pub expect_status: Option<String>,
    pub expect_text: Option<String>,
    pub command_id: Option<String>,
    pub repository_id: Option<String>,
    pub interval_secs: Option<i64>,
    pub enabled: Option<bool>,
}

pub fn save(conn: &Connection, i: &ServiceInput) -> AppResult<Service> {
    let name = i.name.trim();
    if name.is_empty() {
        return invalid("Name the service.");
    }
    let u = parse_endpoint(&i.url)?;
    if let Some(e) = i.expect_status.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        if !(100..600).any(|c| status_matches(Some(e), c)) {
            return invalid("Expected status should look like 200, 2xx or 200-299.");
        }
    }
    let clean = |v: &Option<String>| v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let interval = i.interval_secs.unwrap_or(30).clamp(10, 3600);
    let now = now_ms();
    let url = if u.scheme() == "tcp" { u.as_str().trim_end_matches('/').to_string() } else { u.to_string() };
    let id = match &i.id {
        Some(id) => {
            conn.execute(
                "UPDATE local_services SET name = ?1, url = ?2, health_path = ?3, expect_status = ?4, expect_text = ?5, command_id = ?6, repository_id = ?7,
                   interval_secs = ?8, enabled = ?9, updated_at = ?10, last_status = 'unknown', last_detail = NULL WHERE id = ?11",
                params![name, url, clean(&i.health_path), clean(&i.expect_status), clean(&i.expect_text), i.command_id, i.repository_id, interval, i.enabled.unwrap_or(true) as i64, now, id],
            )?;
            id.clone()
        }
        None => {
            let id = new_id();
            let sort: f64 = conn.query_row("SELECT coalesce(max(sort_order), 0) + 1 FROM local_services WHERE project_id = ?1", [&i.project_id], |r| r.get(0))?;
            conn.execute(
                "INSERT INTO local_services(id, project_id, name, url, health_path, expect_status, expect_text, command_id, repository_id, interval_secs, enabled, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
                params![id, i.project_id, name, url, clean(&i.health_path), clean(&i.expect_status), clean(&i.expect_text), i.command_id, i.repository_id, interval, i.enabled.unwrap_or(true) as i64, sort, now],
            )?;
            id
        }
    };
    get(conn, &id)
}

// ------------------------------------------------------------ Docker (optional)

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
}

fn docker(args: &[&str], timeout: u64) -> AppResult<String> {
    let mut c = git::command("docker");
    c.args(args);
    let (ok, out, err) = git::run(c, Duration::from_secs(timeout), 1024 * 1024).map_err(|_| AppError::Invalid("Docker isn't available on this computer.".into()))?;
    if !ok {
        return Err(AppError::Invalid(format!("Docker: {}", err.lines().last().unwrap_or("command failed"))));
    }
    Ok(out)
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub fn services_list(state: State<AppState>, project_id: String) -> AppResult<Vec<Service>> {
    state.with(|c| list(c, &project_id))
}

#[tauri::command]
pub fn service_save(state: State<AppState>, input: ServiceInput) -> AppResult<Service> {
    state.with(|c| save(c, &input))
}

#[tauri::command]
pub fn service_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM local_services WHERE id = ?1", [id])?;
        Ok(())
    })
}

#[tauri::command]
pub async fn service_check(app: AppHandle, id: String) -> AppResult<Service> {
    blocking(&app, move |s| check(s, &id)).await
}

/// Checks a project's enabled services (used while the project is open).
#[tauri::command]
pub async fn services_check_project(app: AppHandle, project_id: String) -> AppResult<Vec<Service>> {
    blocking(&app, move |s| {
        let ids: Vec<String> = s.with(|c| Ok(list(c, &project_id)?.into_iter().filter(|x| x.enabled).map(|x| x.id).collect()))?;
        for id in ids {
            let _ = check(s, &id);
        }
        s.with(|c| list(c, &project_id))
    })
    .await
}

#[tauri::command]
pub async fn docker_containers(app: AppHandle) -> AppResult<Vec<Container>> {
    blocking(&app, |_| {
        let out = docker(&["ps", "-a", "--format", "{{json .}}"], 10)?;
        Ok(out
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .map(|v| {
                let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
                Container { id: s("ID"), name: s("Names"), image: s("Image"), state: s("State"), status: s("Status"), ports: s("Ports") }
            })
            .collect())
    })
    .await
}

/// start | stop | restart for one container, on explicit request.
#[tauri::command]
pub async fn docker_container_action(app: AppHandle, id: String, action: String) -> AppResult<()> {
    blocking(&app, move |_| {
        if !["start", "stop", "restart"].contains(&action.as_str()) {
            return invalid("Unknown Docker action.");
        }
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) {
            return invalid("That isn't a container id.");
        }
        docker(&[action.as_str(), "--", id.as_str()], 60).map(|_| ())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_expectations() {
        assert!(status_matches(None, 200) && status_matches(None, 302) && !status_matches(None, 500));
        assert!(status_matches(Some("2xx"), 204) && !status_matches(Some("2xx"), 301));
        assert!(status_matches(Some("200-299, 404"), 404));
        assert!(status_matches(Some("200"), 200) && !status_matches(Some("200"), 201));
    }

    #[test]
    fn endpoints_and_locality() {
        assert_eq!(parse_endpoint("localhost:3000").unwrap().as_str(), "http://localhost:3000/");
        assert!(parse_endpoint("tcp://localhost").is_err());
        assert!(parse_endpoint("ftp://x").is_err());
        assert!(is_local("localhost") && is_local("127.0.0.1") && is_local("192.168.1.4") && is_local("[::1]"));
        assert!(!is_local("example.com") && !is_local("8.8.8.8"));
    }

    #[test]
    fn closed_ports_are_stopped_and_open_ports_are_unverified() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let svc = |url: String| Service {
            id: "s".into(),
            project_id: "p".into(),
            name: "db".into(),
            url,
            health_path: None,
            expect_status: None,
            expect_text: None,
            command_id: None,
            repository_id: None,
            interval_secs: 30,
            enabled: true,
            status: "unknown".into(),
            healthy: None,
            detail: None,
            latency_ms: None,
            checked_at: None,
            history: vec![],
        };
        let open = probe(&svc(format!("tcp://127.0.0.1:{port}")), false);
        assert_eq!(open.status, "running");
        assert!(open.detail.contains("can't confirm"));
        drop(listener);
        let closed = probe(&svc(format!("tcp://127.0.0.1:{port}")), false);
        assert_eq!(closed.status, "stopped");
        // Remote hosts aren't contacted when the network is off.
        assert_eq!(probe(&svc("https://example.com".into()), false).status, "unknown");
    }
}
