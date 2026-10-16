// @Author Christian Relf
// @Date 2026-10-12

//! Project health: a short, actionable list of what needs attention,
//! summarised as On track / Needs attention / Blocked / No recent data.
//! There is no score.
//!
//! Every project is judged on its own work (overdue and blocked tasks,
//! deadlines, milestones, stalled work). Development signals (failed CI,
//! pull requests waiting, dependency advisories, local services) only count
//! when the project has those resources, and only from data Kern already
//! fetched; computing health never touches the network. Not opening a
//! project is never held against it.

use crate::domain::{milestones, passkeys};
use crate::error::AppResult;
use crate::state::AppState;
use crate::util::now_ms;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub overdue: bool,
    pub blocked: bool,
    pub due_soon: bool,
    pub due_soon_days: i64,
    pub milestones: bool,
    pub stale: bool,
    pub stale_days: i64,
    pub ci: bool,
    /// Workflow names that count (empty = all).
    pub workflows: Vec<String>,
    pub pulls: bool,
    pub dependencies: bool,
    pub services: bool,
    /// Repository ids that count (empty = all).
    pub repositories: Vec<String>,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            overdue: true,
            blocked: true,
            due_soon: true,
            due_soon_days: 3,
            milestones: true,
            stale: true,
            stale_days: 14,
            ci: true,
            workflows: vec![],
            pulls: true,
            dependencies: true,
            services: true,
            repositories: vec![],
        }
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub key: String,
    pub label: String,
    pub count: i64,
    /// info | warning | critical
    pub severity: String,
    /// Where clicking leads: tasks | milestones | build | pulls | dependencies | services
    pub target: String,
    /// Optional detail for the target (status filter, milestone id, run URL…).
    pub target_ref: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    /// on_track | needs_attention | blocked | no_data
    pub state: String,
    pub items: Vec<Item>,
    pub prefs: Prefs,
    pub checked_at: i64,
}

pub fn prefs(conn: &Connection, project_id: &str) -> Prefs {
    conn.query_row("SELECT health_prefs FROM projects WHERE id = ?1", [project_id], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn today_plus(days: i64) -> String {
    (chrono::Local::now().date_naive() + chrono::Duration::days(days)).format("%Y-%m-%d").to_string()
}

fn cached(conn: &Connection, key: &str) -> Option<Value> {
    conn.query_row("SELECT data FROM dev_cache WHERE key = ?1", [key], |r| r.get::<_, String>(0)).optional().ok().flatten().and_then(|s| serde_json::from_str(&s).ok())
}

fn severity_rank(s: &str) -> u8 {
    match s {
        "critical" => 2,
        "warning" => 1,
        _ => 0,
    }
}

pub fn compute(conn: &Connection, project_id: &str) -> AppResult<Health> {
    let p = prefs(conn, project_id);
    let today = today_plus(0);
    let mut items: Vec<Item> = vec![];
    let mut push = |key: &str, label: String, count: i64, severity: &str, target: &str, target_ref: Option<String>| {
        if count > 0 {
            items.push(Item { key: key.into(), label, count, severity: severity.into(), target: target.into(), target_ref });
        }
    };
    let plural = |n: i64, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });

    let (open, overdue, blocked, due_soon, stale): (i64, i64, i64, i64, i64) = conn.query_row(
        "SELECT count(*),
           sum(due_date < ?2),
           sum(status = 'blocked'),
           sum(due_date >= ?2 AND due_date <= ?3),
           sum(status = 'in_progress' AND updated_at < ?4)
         FROM tasks WHERE project_id = ?1 AND deleted_at IS NULL AND archived_at IS NULL AND parent_id IS NULL AND status != 'completed'",
        params![project_id, today, today_plus(p.due_soon_days.clamp(0, 60)), now_ms() - p.stale_days.clamp(1, 365) * 86_400_000],
        |r| {
            Ok((
                r.get(0)?,
                r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                r.get::<_, Option<i64>>(4)?.unwrap_or(0),
            ))
        },
    )?;
    if p.overdue {
        push("overdue", format!("{} overdue", plural(overdue, "task", "tasks")), overdue, "critical", "tasks", Some("overdue".into()));
    }
    if p.blocked {
        push("blocked", format!("{} blocked", plural(blocked, "task", "tasks")), blocked, "warning", "tasks", Some("blocked".into()));
    }
    if p.due_soon {
        push("due_soon", format!("{} due within {} days", plural(due_soon, "task", "tasks"), p.due_soon_days), due_soon, "info", "tasks", Some("due_soon".into()));
    }
    if p.stale {
        push("stale", format!("{} in progress with no change for {} days", plural(stale, "task", "tasks"), p.stale_days), stale, "info", "tasks", Some("stale".into()));
    }

    let ms = milestones::list(conn, project_id)?;
    let open_ms: Vec<_> = ms.iter().filter(|m| m.status == "planned" || m.status == "active").collect();
    let mut milestone_blocked_late = false;
    if p.milestones {
        let late: Vec<_> = open_ms.iter().filter(|m| m.overdue).collect();
        let waiting: Vec<_> = open_ms.iter().filter(|m| !m.blocked_by.is_empty()).collect();
        milestone_blocked_late = late.iter().any(|m| !m.blocked_by.is_empty());
        push("milestone_overdue", format!("{} past its target date", plural(late.len() as i64, "milestone", "milestones")), late.len() as i64, "critical", "milestones", late.first().map(|m| m.id.clone()));
        push(
            "milestone_blocked",
            format!("{} waiting on other milestones", plural(waiting.len() as i64, "milestone", "milestones")),
            waiting.len() as i64,
            if milestone_blocked_late { "critical" } else { "warning" },
            "milestones",
            waiting.first().map(|m| m.id.clone()),
        );
    }

    // Development signals: only for projects with those resources.
    let mut repos: Vec<(String, Option<String>, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, github, folder_key FROM project_repositories WHERE project_id = ?1")?;
        let rows = stmt.query_map([project_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<Vec<_>, _>>()?;
        rows
    };
    if !p.repositories.is_empty() {
        repos.retain(|(id, _, _)| p.repositories.contains(id));
    }
    let mut dev_signals = !repos.is_empty();
    if p.ci {
        let mut failed: Vec<String> = vec![];
        for (_, gh, _) in &repos {
            let Some(gh) = gh else { continue };
            let Some(a) = cached(conn, &format!("gh:actions:{}", gh.to_lowercase())) else { continue };
            let default = a.get("defaultBranch").and_then(|b| b.as_str()).map(String::from);
            for r in a.get("latest").and_then(|l| l.as_array()).cloned().unwrap_or_default() {
                let wf = r.get("workflow").and_then(|x| x.as_str()).unwrap_or("");
                if !p.workflows.is_empty() && !p.workflows.iter().any(|w| w == wf) {
                    continue;
                }
                let on_default = default.is_none() || r.get("branch").and_then(|b| b.as_str()) == default.as_deref();
                if on_default && matches!(r.get("conclusion").and_then(|c| c.as_str()), Some("failure" | "timed_out" | "startup_failure")) {
                    failed.push(r.get("htmlUrl").and_then(|u| u.as_str()).unwrap_or("").to_string());
                }
            }
        }
        push("ci", format!("{} failing on the default branch", plural(failed.len() as i64, "workflow", "workflows")), failed.len() as i64, "critical", "build", failed.first().cloned());
    }
    if p.pulls {
        let (mut waiting, mut changes) = (0i64, 0i64);
        for (_, gh, _) in &repos {
            let Some(gh) = gh else { continue };
            for pr in cached(conn, &format!("gh:pulls:{}", gh.to_lowercase())).and_then(|v| v.as_array().cloned()).unwrap_or_default() {
                if pr.get("draft").and_then(|d| d.as_bool()) == Some(true) {
                    continue;
                }
                match pr.get("review").and_then(|r| r.as_str()) {
                    Some("changes_requested") => changes += 1,
                    Some("none") => waiting += 1,
                    _ => {}
                }
            }
        }
        push("pulls_review", format!("{} awaiting review", plural(waiting, "pull request", "pull requests")), waiting, "info", "pulls", None);
        push("pulls_changes", format!("{} with changes requested", plural(changes, "pull request", "pull requests")), changes, "warning", "pulls", None);
    }
    if p.dependencies {
        let mut keys: Vec<String> = repos.iter().filter_map(|(_, _, k)| k.clone()).collect();
        if let Some(k) = conn.query_row("SELECT folder_key FROM project_folder_links WHERE project_id = ?1", [project_id], |r| r.get::<_, String>(0)).optional()? {
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
        let (mut high, mut other) = (0i64, 0i64);
        for k in keys {
            let Some(a) = cached(conn, &format!("adv:{k}")) else { continue };
            dev_signals = true;
            for f in a.get("findings").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
                let sev = f.get("advisories").and_then(|x| x.as_array()).map(|a| {
                    a.iter().any(|ad| ad.get("severity").and_then(|s| s.as_str()).is_some_and(|s| matches!(s.to_ascii_uppercase().as_str(), "HIGH" | "CRITICAL")))
                });
                if sev == Some(true) {
                    high += 1;
                } else {
                    other += 1;
                }
            }
        }
        push("deps_high", format!("{} with high-severity advisories", plural(high, "dependency", "dependencies")), high, "critical", "dependencies", None);
        push("deps_other", format!("{} with known advisories", plural(other, "dependency", "dependencies")), other, "warning", "dependencies", None);
    }
    if p.services {
        let mut stmt = conn.prepare("SELECT name, last_status FROM local_services WHERE project_id = ?1 AND enabled = 1 AND last_checked_at IS NOT NULL")?;
        let rows: Vec<(String, String)> = stmt.query_map([project_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        dev_signals |= !rows.is_empty();
        let down = rows.iter().filter(|(_, s)| s == "stopped").count() as i64;
        let degraded = rows.iter().filter(|(_, s)| s == "degraded").count() as i64;
        push("services_down", format!("{} not responding", plural(down, "service", "services")), down, "warning", "services", None);
        push("services_degraded", format!("{} degraded", plural(degraded, "service", "services")), degraded, "warning", "services", None);
    }

    items.sort_by(|a, b| severity_rank(&b.severity).cmp(&severity_rank(&a.severity)));
    let attention = items.iter().any(|i| i.severity != "info");
    // Blocked: nothing can move (every open task is blocked) or a late
    // milestone is still waiting on others.
    let all_blocked = open > 0 && blocked == open;
    let state = if all_blocked || milestone_blocked_late {
        "blocked"
    } else if attention {
        "needs_attention"
    } else if open == 0 && open_ms.is_empty() && !dev_signals {
        "no_data"
    } else {
        "on_track"
    };
    Ok(Health { state: state.into(), items, prefs: p, checked_at: now_ms() })
}

#[tauri::command]
pub fn project_health(state: State<AppState>, project_id: String) -> AppResult<Health> {
    state.with(|c| {
        passkeys::ensure_readable(c, &project_id)?;
        compute(c, &project_id)
    })
}

#[tauri::command]
pub fn project_health_prefs(state: State<AppState>, project_id: String, prefs: Prefs) -> AppResult<Health> {
    state.with(|c| {
        c.execute("UPDATE projects SET health_prefs = ?1 WHERE id = ?2", params![serde_json::to_string(&prefs)?, project_id])?;
        compute(c, &project_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::projects::{create_project, ProjectInput};
    use crate::domain::tasks::{create_task, TaskInput};

    #[test]
    fn general_projects_are_judged_on_their_own_work() {
        let c = open_memory();
        let p = create_project(&c, &ProjectInput { name: "Renovation".into(), ..Default::default() }).unwrap();
        assert_eq!(compute(&c, &p.id).unwrap().state, "no_data");
        create_task(&c, &TaskInput { title: "Paint".into(), project_id: Some(p.id.clone()), ..Default::default() }).unwrap();
        let h = compute(&c, &p.id).unwrap();
        assert_eq!(h.state, "on_track");
        assert!(h.items.iter().all(|i| !["ci", "pulls_review", "deps_high", "services_down"].contains(&i.key.as_str())), "no development warnings without development resources");
        create_task(&c, &TaskInput { title: "Order tiles".into(), project_id: Some(p.id.clone()), due_date: Some("2000-01-01".into()), ..Default::default() }).unwrap();
        let h = compute(&c, &p.id).unwrap();
        assert_eq!(h.state, "needs_attention");
        assert_eq!(h.items[0].key, "overdue");
        // Rules are configurable.
        c.execute("UPDATE projects SET health_prefs = '{\"overdue\":false}' WHERE id = ?1", [&p.id]).unwrap();
        assert_eq!(compute(&c, &p.id).unwrap().state, "on_track");
    }

    #[test]
    fn everything_blocked_is_blocked() {
        let c = open_memory();
        let p = create_project(&c, &ProjectInput { name: "Launch".into(), ..Default::default() }).unwrap();
        create_task(&c, &TaskInput { title: "Waiting on supplier".into(), project_id: Some(p.id.clone()), status: Some("blocked".into()), ..Default::default() }).unwrap();
        assert_eq!(compute(&c, &p.id).unwrap().state, "blocked");
    }

    #[test]
    fn failed_ci_counts_only_from_cached_runs_on_the_default_branch() {
        let c = open_memory();
        let p = create_project(&c, &ProjectInput { name: "App".into(), ..Default::default() }).unwrap();
        crate::domain::repos::link_github(&c, &p.id, "acme/app").unwrap();
        c.execute(
            "INSERT INTO dev_cache(key, data, fetched_at) VALUES ('gh:actions:acme/app', ?1, 0)",
            [r#"{"defaultBranch":"main","latest":[{"workflow":"CI","branch":"main","conclusion":"failure","htmlUrl":"u"},{"workflow":"Docs","branch":"feature","conclusion":"failure","htmlUrl":"v"}]}"#],
        )
        .unwrap();
        let h = compute(&c, &p.id).unwrap();
        let ci = h.items.iter().find(|i| i.key == "ci").unwrap();
        assert_eq!(ci.count, 1);
        assert_eq!(h.state, "needs_attention");
    }
}
