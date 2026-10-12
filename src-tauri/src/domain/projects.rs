//! Projects and project groups.

use crate::domain::{activity, boards, recent};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms, some, valid_date};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: Option<String>,
    pub accent: Option<String>,
    pub target_date: Option<String>,
    pub group_id: Option<String>,
    pub pinned: bool,
    pub sort_order: f64,
    pub default_view: Option<String>,
    pub hidden_tabs: Value,
    pub default_board_id: Option<String>,
    pub last_opened_at: Option<i64>,
    pub archived_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub task_total: i64,
    pub task_done: i64,
    pub task_overdue: i64,
    pub task_due_soon: i64,
    pub last_activity_at: Option<i64>,
}

/// Columns 0..=16 are the project row; 17.. are statistics. `?1` is
/// today's local date and `?2` whether archived tasks count toward progress.
const PROJECT_SELECT: &str = "SELECT p.id, p.name, p.description, p.icon, p.accent, p.target_date, p.group_id, p.pinned,
  p.sort_order, p.default_view, p.hidden_tabs, p.default_board_id, p.last_opened_at, p.archived_at, p.deleted_at,
  p.created_at, p.updated_at,
  (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.parent_id IS NULL AND (?2 = 1 OR t.archived_at IS NULL)),
  (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.parent_id IS NULL AND (?2 = 1 OR t.archived_at IS NULL) AND t.status = 'completed'),
  (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.status != 'completed' AND t.due_date < ?1),
  (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.status != 'completed' AND t.due_date >= ?1 AND t.due_date <= date(?1, '+3 day')),
  (SELECT max(a.created_at) FROM activity a WHERE a.project_id = p.id)
FROM projects p";

fn map_project(r: &Row) -> rusqlite::Result<Project> {
    let hidden: String = r.get(10)?;
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        icon: r.get(3)?,
        accent: r.get(4)?,
        target_date: r.get(5)?,
        group_id: r.get(6)?,
        pinned: r.get::<_, i64>(7)? != 0,
        sort_order: r.get(8)?,
        default_view: r.get(9)?,
        hidden_tabs: serde_json::from_str(&hidden).unwrap_or(Value::Array(vec![])),
        default_board_id: r.get(11)?,
        last_opened_at: r.get(12)?,
        archived_at: r.get(13)?,
        deleted_at: r.get(14)?,
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
        task_total: r.get(17)?,
        task_done: r.get(18)?,
        task_overdue: r.get(19)?,
        task_due_soon: r.get(20)?,
        last_activity_at: r.get(21)?,
    })
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn include_archived_in_progress(conn: &Connection) -> i64 {
    crate::domain::settings::get_or(conn, "projects.progressIncludeArchived", false) as i64
}

pub fn get_project(conn: &Connection, id: &str) -> AppResult<Project> {
    conn.query_row(
        &format!("{PROJECT_SELECT} WHERE p.id = ?3"),
        params![today(), include_archived_in_progress(conn), id],
        map_project,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("Project".into()))
}

pub fn list_projects(conn: &Connection, include_archived: bool) -> AppResult<Vec<Project>> {
    let sql = format!(
        "{PROJECT_SELECT} WHERE p.deleted_at IS NULL AND (?3 = 1 OR p.archived_at IS NULL) ORDER BY p.sort_order, p.created_at"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![today(), include_archived_in_progress(conn), include_archived as i64], map_project)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectInput {
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub accent: Option<String>,
    pub target_date: Option<String>,
    pub group_id: Option<String>,
    pub default_view: Option<String>,
}

pub fn create_project(conn: &Connection, input: &ProjectInput) -> AppResult<Project> {
    let name = input.name.trim();
    if name.is_empty() {
        return invalid("Project name can't be empty.");
    }
    if let Some(d) = &input.target_date {
        if !valid_date(d) {
            return invalid("Target date isn't valid.");
        }
    }
    let now = now_ms();
    let id = new_id();
    let sort: f64 = conn.query_row("SELECT coalesce(max(sort_order), 0) + 1 FROM projects", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO projects(id, name, description, icon, accent, target_date, group_id, sort_order, default_view, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            id,
            name,
            input.description.clone().unwrap_or_default(),
            input.icon,
            input.accent,
            input.target_date,
            input.group_id,
            sort,
            input.default_view,
            now
        ],
    )?;
    let cols = boards::default_columns(conn);
    let board = boards::create_board(conn, &id, "Board", &cols)?;
    conn.execute("UPDATE projects SET default_board_id = ?1 WHERE id = ?2", params![board.id, id])?;
    activity::log(conn, Some(&id), "project", &id, "created", name)?;
    get_project(conn, &id)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    #[serde(deserialize_with = "some")]
    pub icon: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub accent: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub target_date: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub group_id: Option<Option<String>>,
    pub pinned: Option<bool>,
    #[serde(deserialize_with = "some")]
    pub default_view: Option<Option<String>>,
    pub hidden_tabs: Option<Value>,
    pub archived: Option<bool>,
    pub sort_order: Option<f64>,
}

pub fn update_project(conn: &Connection, id: &str, p: &ProjectPatch) -> AppResult<Project> {
    let prev = get_project(conn, id)?;
    let now = now_ms();
    let set = |col: &str, v: &dyn rusqlite::ToSql| -> AppResult<()> {
        conn.execute(&format!("UPDATE projects SET {col} = ?1, updated_at = ?2 WHERE id = ?3"), params![v, now, id])?;
        Ok(())
    };
    if let Some(n) = &p.name {
        let n = n.trim();
        if n.is_empty() {
            return invalid("Project name can't be empty.");
        }
        set("name", &n)?;
        if n != prev.name {
            activity::log(conn, Some(id), "project", id, "renamed", &format!("{} → {}", prev.name, n))?;
        }
    }
    if let Some(d) = &p.description {
        set("description", d)?;
    }
    if let Some(v) = &p.icon {
        set("icon", v)?;
    }
    if let Some(v) = &p.accent {
        set("accent", v)?;
    }
    if let Some(v) = &p.target_date {
        if let Some(d) = v {
            if !valid_date(d) {
                return invalid("Target date isn't valid.");
            }
        }
        set("target_date", v)?;
    }
    if let Some(v) = &p.group_id {
        set("group_id", v)?;
    }
    if let Some(v) = p.pinned {
        set("pinned", &(v as i64))?;
    }
    if let Some(v) = &p.default_view {
        set("default_view", v)?;
    }
    if let Some(v) = &p.hidden_tabs {
        set("hidden_tabs", &serde_json::to_string(v)?)?;
    }
    if let Some(v) = p.sort_order {
        set("sort_order", &v)?;
    }
    if let Some(a) = p.archived {
        if a && prev.archived_at.is_none() {
            set("archived_at", &now)?;
            activity::log(conn, Some(id), "project", id, "archived", &prev.name)?;
        } else if !a && prev.archived_at.is_some() {
            set("archived_at", &Option::<i64>::None)?;
            activity::log(conn, Some(id), "project", id, "unarchived", &prev.name)?;
        }
    }
    get_project(conn, id)
}

/// Copies a project with its boards, columns, open tasks (with subtasks and
/// labels), notes and whiteboards.
pub fn duplicate_project(conn: &Connection, id: &str) -> AppResult<Project> {
    let src = get_project(conn, id)?;
    let now = now_ms();
    let new_pid = new_id();
    conn.execute(
        "INSERT INTO projects(id, name, description, icon, accent, target_date, group_id, pinned, sort_order, default_view,
           hidden_tabs, created_at, updated_at)
         SELECT ?1, name || ' (copy)', description, icon, accent, target_date, group_id, 0, sort_order + 0.5, default_view,
           hidden_tabs, ?2, ?2 FROM projects WHERE id = ?3",
        params![new_pid, now, id],
    )?;
    // Boards & columns, with an id map for column placement.
    let mut col_map: Vec<(String, String)> = vec![];
    let mut stmt = conn.prepare("SELECT id FROM boards WHERE project_id = ?1 ORDER BY sort_order")?;
    let board_ids: Vec<String> = stmt.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for b in &board_ids {
        let nb = new_id();
        conn.execute(
            "INSERT INTO boards(id, project_id, name, sort_order, settings, created_at, updated_at)
             SELECT ?1, ?2, name, sort_order, settings, ?3, ?3 FROM boards WHERE id = ?4",
            params![nb, new_pid, now, b],
        )?;
        if src.default_board_id.as_deref() == Some(b.as_str()) {
            conn.execute("UPDATE projects SET default_board_id = ?1 WHERE id = ?2", params![nb, new_pid])?;
        }
        let mut cs = conn.prepare("SELECT id FROM board_columns WHERE board_id = ?1")?;
        let cols: Vec<String> = cs.query_map([b], |r| r.get(0))?.collect::<Result<_, _>>()?;
        for c in cols {
            let nc = new_id();
            conn.execute(
                "INSERT INTO board_columns(id, board_id, name, sort_order, status, wip_limit, collapsed, width, created_at, updated_at)
                 SELECT ?1, ?2, name, sort_order, status, wip_limit, collapsed, width, ?3, ?3 FROM board_columns WHERE id = ?4",
                params![nc, nb, now, c],
            )?;
            col_map.push((c, nc));
        }
    }
    // Open tasks, preserving hierarchy.
    let mut ts = conn.prepare(
        "WITH RECURSIVE tree(id, depth) AS (
           SELECT id, 0 FROM tasks WHERE project_id = ?1 AND parent_id IS NULL AND deleted_at IS NULL AND status != 'completed'
           UNION ALL SELECT t.id, tree.depth + 1 FROM tasks t JOIN tree ON t.parent_id = tree.id WHERE t.deleted_at IS NULL)
         SELECT id FROM tree ORDER BY depth",
    )?;
    let task_ids: Vec<String> = ts.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut task_map: std::collections::HashMap<String, String> = Default::default();
    for t in task_ids {
        let nt = new_id();
        let (parent, column): (Option<String>, Option<String>) =
            conn.query_row("SELECT parent_id, column_id FROM tasks WHERE id = ?1", [&t], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let new_parent = parent.and_then(|p| task_map.get(&p).cloned());
        let new_col = column.and_then(|c| col_map.iter().find(|(o, _)| *o == c).map(|(_, n)| n.clone()));
        conn.execute(
            "INSERT INTO tasks(id, title, description, status, priority, project_id, column_id, parent_id, due_date, due_time,
               start_date, estimate_minutes, sort_order, board_order, pinned, recurrence, reminder_minutes, created_at, updated_at)
             SELECT ?1, title, description, status, priority, ?2, ?3, ?4, due_date, due_time, start_date, estimate_minutes,
               sort_order, board_order, pinned, recurrence, reminder_minutes, ?5, ?5 FROM tasks WHERE id = ?6",
            params![nt, new_pid, new_col, new_parent, now, t],
        )?;
        conn.execute(
            "INSERT INTO task_labels(task_id, label_id) SELECT ?1, label_id FROM task_labels WHERE task_id = ?2",
            params![nt, t],
        )?;
        conn.execute("UPDATE tasks SET series_id = id WHERE id = ?1 AND recurrence IS NOT NULL", [&nt])?;
        task_map.insert(t, nt);
    }
    // Notes.
    conn.execute(
        "INSERT INTO notes(id, title, content, project_id, pinned, created_at, updated_at)
         SELECT lower(hex(randomblob(16))), title, content, ?1, pinned, ?2, ?2 FROM notes
         WHERE project_id = ?3 AND deleted_at IS NULL AND archived_at IS NULL",
        params![new_pid, now, id],
    )?;
    // Whiteboards.
    let mut ws = conn.prepare("SELECT id FROM whiteboards WHERE project_id = ?1 AND deleted_at IS NULL")?;
    let wbs: Vec<String> = ws.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for w in wbs {
        crate::domain::whiteboards::duplicate(conn, &w, Some(&new_pid), false)?;
    }
    activity::log(conn, Some(&new_pid), "project", &new_pid, "created", &format!("Duplicated from {}", src.name))?;
    get_project(conn, &new_pid)
}

// --------------------------------------------------------------- groups

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroup {
    pub id: String,
    pub name: String,
    pub sort_order: f64,
    pub collapsed: bool,
}

#[tauri::command]
pub fn groups_list(state: State<AppState>) -> AppResult<Vec<ProjectGroup>> {
    state.with(|c| {
        let mut stmt = c.prepare("SELECT id, name, sort_order, collapsed FROM project_groups ORDER BY sort_order")?;
        let rows = stmt.query_map([], |r| {
            Ok(ProjectGroup { id: r.get(0)?, name: r.get(1)?, sort_order: r.get(2)?, collapsed: r.get::<_, i64>(3)? != 0 })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command]
pub fn group_create(state: State<AppState>, name: String) -> AppResult<ProjectGroup> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return invalid("Group name can't be empty.");
    }
    state.with(|c| {
        let id = new_id();
        let now = now_ms();
        let sort: f64 = c.query_row("SELECT coalesce(max(sort_order), 0) + 1 FROM project_groups", [], |r| r.get(0))?;
        c.execute(
            "INSERT INTO project_groups(id, name, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, name, sort, now],
        )?;
        Ok(ProjectGroup { id, name, sort_order: sort, collapsed: false })
    })
}

#[tauri::command]
pub fn group_update(
    state: State<AppState>,
    id: String,
    name: Option<String>,
    collapsed: Option<bool>,
    sort_order: Option<f64>,
) -> AppResult<()> {
    state.with(|c| {
        if let Some(n) = name {
            if n.trim().is_empty() {
                return invalid("Group name can't be empty.");
            }
            c.execute("UPDATE project_groups SET name = ?1, updated_at = ?2 WHERE id = ?3", params![n.trim(), now_ms(), id])?;
        }
        if let Some(v) = collapsed {
            c.execute("UPDATE project_groups SET collapsed = ?1 WHERE id = ?2", params![v as i64, id])?;
        }
        if let Some(v) = sort_order {
            c.execute("UPDATE project_groups SET sort_order = ?1 WHERE id = ?2", params![v, id])?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn group_delete(state: State<AppState>, id: String) -> AppResult<()> {
    // Projects inside are kept and become ungrouped (ON DELETE SET NULL).
    state.with(|c| {
        c.execute("DELETE FROM project_groups WHERE id = ?1", [id])?;
        Ok(())
    })
}

// ------------------------------------------------------------- commands

#[tauri::command]
pub fn projects_list(state: State<AppState>, include_archived: Option<bool>) -> AppResult<Vec<Project>> {
    state.with(|c| list_projects(c, include_archived.unwrap_or(false)))
}

#[tauri::command]
pub fn project_get(state: State<AppState>, id: String) -> AppResult<Project> {
    state.with(|c| get_project(c, &id))
}

#[tauri::command]
pub fn project_create(state: State<AppState>, input: ProjectInput) -> AppResult<Project> {
    state.with(|c| {
        let tx = c.transaction()?;
        let p = create_project(&tx, &input)?;
        tx.commit()?;
        Ok(p)
    })
}

#[tauri::command]
pub fn project_update(state: State<AppState>, id: String, patch: ProjectPatch) -> AppResult<Project> {
    state.with(|c| {
        let tx = c.transaction()?;
        let p = update_project(&tx, &id, &patch)?;
        tx.commit()?;
        Ok(p)
    })
}

#[tauri::command]
pub fn projects_reorder(
    state: State<AppState>,
    ids: Vec<String>,
    set_group: Option<bool>,
    group_id: Option<String>,
) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute("UPDATE projects SET sort_order = ?1 WHERE id = ?2", params![(i + 1) as f64, id])?;
        }
        if set_group == Some(true) {
            for id in &ids {
                tx.execute("UPDATE projects SET group_id = ?1 WHERE id = ?2", params![group_id, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn project_duplicate(state: State<AppState>, id: String) -> AppResult<Project> {
    state.with(|c| {
        let tx = c.transaction()?;
        let p = duplicate_project(&tx, &id)?;
        tx.commit()?;
        Ok(p)
    })
}

#[tauri::command]
pub fn project_delete(state: State<AppState>, id: String) -> AppResult<()> {
    // Soft delete: the project (and everything in it) moves to the trash.
    // Its tasks, notes and whiteboards are hidden with it and restored with it.
    state.with(|c| {
        let tx = c.transaction()?;
        let now = now_ms();
        tx.execute("UPDATE projects SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL", params![now, id])?;
        tx.execute("UPDATE tasks SET deleted_at = ?1 WHERE project_id = ?2 AND deleted_at IS NULL", params![now, id])?;
        tx.execute("UPDATE notes SET deleted_at = ?1 WHERE project_id = ?2 AND deleted_at IS NULL", params![now, id])?;
        tx.execute("UPDATE whiteboards SET deleted_at = ?1 WHERE project_id = ?2 AND deleted_at IS NULL", params![now, id])?;
        tx.execute("DELETE FROM recent_items WHERE entity_type = 'project' AND entity_id = ?1", [&id])?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn project_restore(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        let ts: Option<i64> = tx
            .query_row("SELECT deleted_at FROM projects WHERE id = ?1", [&id], |r| r.get(0))
            .optional()?
            .flatten();
        if let Some(ts) = ts {
            tx.execute("UPDATE projects SET deleted_at = NULL WHERE id = ?1", [&id])?;
            for table in ["tasks", "notes", "whiteboards"] {
                tx.execute(
                    &format!("UPDATE {table} SET deleted_at = NULL WHERE project_id = ?1 AND deleted_at = ?2"),
                    params![id, ts],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn project_touch(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("UPDATE projects SET last_opened_at = ?1 WHERE id = ?2", params![now_ms(), id])?;
        recent::touch(c, "project", &id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::tasks::{create_task, TaskInput};

    #[test]
    fn project_progress_and_default_board() {
        let c = open_memory();
        let p = create_project(&c, &ProjectInput { name: "Website".into(), ..Default::default() }).unwrap();
        assert!(p.default_board_id.is_some());
        assert_eq!(p.task_total, 0);
        for i in 0..4 {
            let t = create_task(&c, &TaskInput { title: format!("t{i}"), project_id: Some(p.id.clone()), ..Default::default() }).unwrap();
            if i < 3 {
                crate::domain::tasks::update_task(
                    &c,
                    &t.id,
                    &crate::domain::tasks::TaskPatch { status: Some("completed".into()), ..Default::default() },
                )
                .unwrap();
            }
        }
        let p = get_project(&c, &p.id).unwrap();
        assert_eq!((p.task_done, p.task_total), (3, 4));
    }

    #[test]
    fn duplicate_copies_structure() {
        let c = open_memory();
        let p = create_project(&c, &ProjectInput { name: "Game".into(), ..Default::default() }).unwrap();
        let parent = create_task(&c, &TaskInput { title: "Level 1".into(), project_id: Some(p.id.clone()), ..Default::default() }).unwrap();
        create_task(&c, &TaskInput { title: "Art".into(), parent_id: Some(parent.id.clone()), ..Default::default() }).unwrap();
        let d = duplicate_project(&c, &p.id).unwrap();
        assert_eq!(d.name, "Game (copy)");
        assert_eq!(d.task_total, 1);
        let subs: i64 = c
            .query_row("SELECT count(*) FROM tasks WHERE project_id = ?1 AND parent_id IS NOT NULL", [&d.id], |r| r.get(0))
            .unwrap();
        assert_eq!(subs, 1);
        assert!(d.default_board_id.is_some());
    }
}
