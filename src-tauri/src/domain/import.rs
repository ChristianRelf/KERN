// @Author Christian Relf
// @Date 2026-10-15

//! Importing from other apps. The interface reads an export (Todoist,
//! Trello, Notion, Linear, CSV) into one neutral bundle; this writes the
//! whole bundle in a single transaction, so an import either lands
//! completely or not at all. Dates that don't parse are dropped rather than
//! failing the import.

use crate::domain::boards::ColumnTemplate;
use crate::domain::{activity, boards, labels, notes, projects, tasks};
use crate::error::{invalid, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms, valid_date, valid_time};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct BundleNote {
    pub title: String,
    pub content: String,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct BundleProject {
    pub key: String,
    pub name: String,
    pub description: String,
    /// Board columns; tasks refer to them by name. None keeps Kern's defaults.
    pub columns: Option<Vec<ColumnTemplate>>,
    pub notes: Vec<BundleNote>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct BundleTask {
    pub project_key: Option<String>,
    pub column: Option<String>,
    pub title: String,
    pub description: String,
    pub status: Option<String>,
    pub priority: i64,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub estimate_minutes: Option<i64>,
    pub labels: Vec<String>,
    pub completed_at: Option<i64>,
    pub created_at: Option<i64>,
    pub subtasks: Vec<BundleTask>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Bundle {
    /// "Todoist", "Trello", … (shown in activity).
    pub source: String,
    pub projects: Vec<BundleProject>,
    pub tasks: Vec<BundleTask>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub projects: usize,
    pub tasks: usize,
    pub notes: usize,
    pub labels: usize,
    /// Project ids created, in bundle order.
    pub project_ids: Vec<String>,
}

const MAX_TASKS: usize = 20_000;

fn count(ts: &[BundleTask]) -> usize {
    ts.iter().map(|t| 1 + count(&t.subtasks)).sum()
}

struct Ctx<'a> {
    projects: HashMap<String, String>,
    /// (project id, lowercase column name) → column id
    columns: HashMap<(String, String), String>,
    labels: HashMap<String, String>,
    result: &'a mut ImportResult,
}

fn label_id(conn: &Connection, ctx: &mut Ctx, name: &str) -> AppResult<Option<String>> {
    let key = name.trim().to_lowercase();
    if key.is_empty() {
        return Ok(None);
    }
    if let Some(id) = ctx.labels.get(&key) {
        return Ok(Some(id.clone()));
    }
    let before: i64 = conn.query_row("SELECT count(*) FROM labels", [], |r| r.get(0))?;
    let id = labels::ensure(conn, name.trim().chars().take(60).collect::<String>().as_str(), None)?;
    let after: i64 = conn.query_row("SELECT count(*) FROM labels", [], |r| r.get(0))?;
    ctx.result.labels += (after - before) as usize;
    ctx.labels.insert(key, id.clone());
    Ok(Some(id))
}

fn write_tasks(conn: &Connection, list: &[BundleTask], ctx: &mut Ctx, parent: Option<(&str, Option<&str>)>) -> AppResult<()> {
    for t in list {
        let title: String = t.title.trim().chars().take(500).collect();
        if title.is_empty() {
            continue;
        }
        let project_id = match parent {
            Some((_, p)) => p.map(String::from),
            None => t.project_key.as_ref().and_then(|k| ctx.projects.get(k).cloned()),
        };
        let column_id = match (&project_id, &t.column, parent) {
            (Some(p), Some(c), None) => ctx.columns.get(&(p.clone(), c.trim().to_lowercase())).cloned(),
            _ => None,
        };
        let mut label_ids = vec![];
        for l in &t.labels {
            if let Some(id) = label_id(conn, ctx, l)? {
                label_ids.push(id);
            }
        }
        let done = t.status.as_deref() == Some("completed") || t.completed_at.is_some();
        let status = if done {
            "completed".to_string()
        } else {
            match t.status.as_deref() {
                Some(s) if tasks::STATUSES.contains(&s) => s.to_string(),
                _ if project_id.is_none() && parent.is_none() => "inbox".into(),
                _ => "todo".into(),
            }
        };
        let due_date = t.due_date.clone().filter(|d| valid_date(d));
        let created = tasks::create_task(
            conn,
            &tasks::TaskInput {
                title,
                description: Some(t.description.chars().take(100_000).collect()),
                status: Some(status),
                priority: Some(t.priority.clamp(0, 4)),
                project_id: project_id.clone(),
                column_id,
                parent_id: parent.map(|(p, _)| p.to_string()),
                due_time: t.due_time.clone().filter(|x| due_date.is_some() && valid_time(x)),
                due_date,
                estimate_minutes: t.estimate_minutes.filter(|m| *m > 0 && *m < 100_000),
                label_ids: Some(label_ids),
                ..Default::default()
            },
        )?;
        // Keep the original history where the export has it.
        if let Some(ts) = t.created_at.filter(|ts| *ts > 0) {
            conn.execute("UPDATE tasks SET created_at = ?1 WHERE id = ?2", params![ts, created.id])?;
        }
        if done {
            if let Some(ts) = t.completed_at.filter(|ts| *ts > 0) {
                conn.execute("UPDATE tasks SET completed_at = ?1 WHERE id = ?2", params![ts, created.id])?;
            }
        }
        ctx.result.tasks += 1;
        write_tasks(conn, &t.subtasks, ctx, Some((&created.id, project_id.as_deref())))?;
    }
    Ok(())
}

pub fn import(conn: &Connection, b: &Bundle) -> AppResult<ImportResult> {
    let total = count(&b.tasks);
    if total > MAX_TASKS {
        return invalid(format!("That's {total} tasks; Kern imports at most {MAX_TASKS} at once. Split the export and import it in parts."));
    }
    if b.projects.is_empty() && b.tasks.is_empty() {
        return invalid("Nothing to import was found in that file.");
    }
    let mut result = ImportResult::default();
    let mut ctx = Ctx { projects: HashMap::new(), columns: HashMap::new(), labels: HashMap::new(), result: &mut result };
    for p in &b.projects {
        let name: String = p.name.trim().chars().take(200).collect();
        let name = if name.is_empty() { "Imported project".to_string() } else { name };
        let created = projects::create_project(conn, &projects::ProjectInput { name, description: Some(p.description.clone()), ..Default::default() })?;
        let board = created.default_board_id.clone().unwrap_or_default();
        if let Some(cols) = p.columns.as_ref().filter(|c| !c.is_empty() && !board.is_empty()) {
            conn.execute("DELETE FROM board_columns WHERE board_id = ?1", [&board])?;
            let now = now_ms();
            let mut seen = std::collections::HashSet::new();
            let mut order = 0;
            for c in cols {
                let n: String = c.name.trim().chars().take(100).collect();
                if n.is_empty() || !seen.insert(n.to_lowercase()) {
                    continue;
                }
                order += 1;
                let status = c.status.clone().filter(|s| tasks::STATUSES.contains(&s.as_str()) && s != "inbox");
                conn.execute(
                    "INSERT INTO board_columns(id, board_id, name, sort_order, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    params![new_id(), board, n, order as f64, status, now],
                )?;
            }
        }
        if !board.is_empty() {
            for c in boards::list_columns(conn, &board)? {
                ctx.columns.entry((created.id.clone(), c.name.to_lowercase())).or_insert(c.id);
            }
        }
        for n in &p.notes {
            notes::create_note(conn, &n.title, &n.content, Some(&created.id))?;
            ctx.result.notes += 1;
        }
        ctx.projects.insert(p.key.clone(), created.id.clone());
        ctx.result.project_ids.push(created.id.clone());
        ctx.result.projects += 1;
    }
    write_tasks(conn, &b.tasks, &mut ctx, None)?;
    let summary = format!("Imported {} tasks from {}", result.tasks, if b.source.is_empty() { "a file" } else { &b.source });
    for pid in &result.project_ids {
        activity::log(conn, Some(pid), "project", pid, "imported", &summary)?;
    }
    Ok(result)
}

#[tauri::command]
pub fn import_bundle(state: State<AppState>, bundle: Bundle) -> AppResult<ImportResult> {
    state.with(|c| {
        let tx = c.transaction()?;
        let r = import(&tx, &bundle)?;
        tx.commit()?;
        Ok(r)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;

    fn task(title: &str) -> BundleTask {
        BundleTask { title: title.into(), ..Default::default() }
    }

    #[test]
    fn imports_projects_columns_tasks_and_labels() {
        let c = open_memory();
        let b = Bundle {
            source: "Trello".into(),
            projects: vec![BundleProject {
                key: "b1".into(),
                name: "Website".into(),
                columns: Some(vec![ColumnTemplate { name: "Ideas".into(), status: None }, ColumnTemplate { name: "Doing".into(), status: Some("in_progress".into()) }, ColumnTemplate { name: "Done".into(), status: Some("completed".into()) }]),
                notes: vec![BundleNote { title: "About".into(), content: "Imported".into() }],
                ..Default::default()
            }],
            tasks: vec![
                BundleTask {
                    project_key: Some("b1".into()),
                    column: Some("doing".into()),
                    labels: vec!["Urgent".into(), "urgent".into(), "".into()],
                    due_date: Some("2030-05-01".into()),
                    due_time: Some("9am".into()),
                    subtasks: vec![task("Wireframes"), BundleTask { completed_at: Some(5), ..task("Copy") }],
                    ..task("Homepage")
                },
                BundleTask { project_key: Some("b1".into()), column: Some("Done".into()), completed_at: Some(1_700_000_000_000), ..task("Logo") },
                BundleTask { due_date: Some("not a date".into()), ..task("Loose end") },
            ],
        };
        let r = import(&c, &b).unwrap();
        assert_eq!((r.projects, r.tasks, r.notes, r.labels), (1, 5, 1, 1));
        let pid = &r.project_ids[0];
        let all = tasks::query_tasks(&c, &tasks::TaskQuery { project_ids: Some(vec![pid.clone()]), include_completed: true, ..Default::default() }).unwrap();
        let home = all.iter().find(|t| t.title == "Homepage").unwrap();
        assert_eq!((home.status.as_str(), home.subtask_count, home.subtask_done, home.label_ids.len()), ("in_progress", 2, 1, 1));
        assert_eq!((home.due_date.as_deref(), home.due_time.as_deref()), (Some("2030-05-01"), None), "a malformed time is dropped");
        let logo = all.iter().find(|t| t.title == "Logo").unwrap();
        assert_eq!((logo.status.as_str(), logo.completed_at), ("completed", Some(1_700_000_000_000)));
        let loose = tasks::query_tasks(&c, &tasks::TaskQuery { no_project: true, ..Default::default() }).unwrap();
        assert_eq!((loose[0].status.as_str(), loose[0].due_date.as_deref()), ("inbox", None));
        assert!(import(&c, &Bundle::default()).is_err());
    }
}
