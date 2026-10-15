// @Author Christian Relf
// @Date 2026-10-14

//! Relations between tasks: blocks / blocked by, related, and duplicate of.
//! Each pair of tasks has at most one relation, stored in one direction
//! (`task_id` blocks / duplicates `related_id`; `related` is symmetric).

use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::now_ms;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RelatedTask {
    pub id: String,
    pub title: String,
    pub status: String,
    pub resolution: Option<String>,
    pub priority: i64,
    pub project_id: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskRelation {
    /// From this task's point of view: blocks | blocked_by | related |
    /// duplicate_of | duplicated_by.
    pub kind: String,
    pub task: RelatedTask,
}

pub fn list(conn: &Connection, task_id: &str) -> AppResult<Vec<TaskRelation>> {
    let mut stmt = conn.prepare(
        "SELECT r.kind, r.task_id = ?1, o.id, o.title, o.status, o.resolution, o.priority, o.project_id
         FROM task_relations r
         JOIN tasks o ON o.id = CASE WHEN r.task_id = ?1 THEN r.related_id ELSE r.task_id END
         WHERE (r.task_id = ?1 OR r.related_id = ?1) AND o.deleted_at IS NULL
         ORDER BY o.status = 'completed', r.created_at",
    )?;
    let rows = stmt.query_map([task_id], |r| {
        let kind: String = r.get(0)?;
        let outgoing: bool = r.get(1)?;
        let kind = match (kind.as_str(), outgoing) {
            ("blocks", true) => "blocks",
            ("blocks", false) => "blocked_by",
            ("duplicate", true) => "duplicate_of",
            ("duplicate", false) => "duplicated_by",
            _ => "related",
        };
        Ok(TaskRelation {
            kind: kind.into(),
            task: RelatedTask {
                id: r.get(2)?,
                title: r.get(3)?,
                status: r.get(4)?,
                resolution: r.get(5)?,
                priority: r.get(6)?,
                project_id: r.get(7)?,
            },
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn exists(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM tasks WHERE id = ?1 AND deleted_at IS NULL", [id], |_| Ok(()))
        .optional()?
        .is_some())
}

/// True when `from` already blocks `to`, directly or through other tasks.
fn blocks_transitively(conn: &Connection, from: &str, to: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "WITH RECURSIVE reach(id) AS (
           SELECT related_id FROM task_relations WHERE task_id = ?1 AND kind = 'blocks'
           UNION SELECT r.related_id FROM task_relations r JOIN reach ON r.task_id = reach.id WHERE r.kind = 'blocks')
         SELECT EXISTS (SELECT 1 FROM reach WHERE id = ?2)",
        params![from, to],
        |r| r.get(0),
    )?)
}

/// Sets the relation between two tasks, replacing any existing one.
/// `kind` is from `task_id`'s point of view: blocks | blocked_by | related |
/// duplicate_of.
pub fn set(conn: &Connection, task_id: &str, other_id: &str, kind: &str) -> AppResult<()> {
    if task_id == other_id {
        return invalid("A task can't be related to itself.");
    }
    for id in [task_id, other_id] {
        if !exists(conn, id)? {
            return Err(AppError::NotFound("Task".into()));
        }
    }
    let (from, to, stored) = match kind {
        "blocks" => (task_id, other_id, "blocks"),
        "blocked_by" => (other_id, task_id, "blocks"),
        "related" => (task_id, other_id, "related"),
        "duplicate_of" => (task_id, other_id, "duplicate"),
        _ => return invalid(format!("Unknown relation '{kind}'.")),
    };
    remove(conn, task_id, other_id)?;
    if stored == "blocks" && blocks_transitively(conn, to, from)? {
        return invalid("That would make the tasks block each other.");
    }
    conn.execute(
        "INSERT INTO task_relations(task_id, related_id, kind, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![from, to, stored, now_ms()],
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, task_id: &str, other_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM task_relations WHERE (task_id = ?1 AND related_id = ?2) OR (task_id = ?2 AND related_id = ?1)",
        params![task_id, other_id],
    )?;
    Ok(())
}

// --------------------------------------------------------------- commands

#[tauri::command]
pub fn task_relations(state: State<AppState>, task_id: String) -> AppResult<Vec<TaskRelation>> {
    state.with(|c| list(c, &task_id))
}

#[tauri::command]
pub fn task_relation_set(state: State<AppState>, task_id: String, other_id: String, kind: String) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        set(&tx, &task_id, &other_id, &kind)?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn task_relation_remove(state: State<AppState>, task_id: String, other_id: String) -> AppResult<()> {
    state.with(|c| remove(c, &task_id, &other_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::tasks::{create_task, get_task, update_task, TaskInput, TaskPatch};

    fn task(c: &Connection, title: &str) -> String {
        create_task(c, &TaskInput { title: title.into(), ..Default::default() }).unwrap().id
    }

    #[test]
    fn relations_read_from_both_sides() {
        let c = open_memory();
        let (a, b) = (task(&c, "A"), task(&c, "B"));
        set(&c, &a, &b, "blocked_by").unwrap();
        assert_eq!(list(&c, &a).unwrap()[0].kind, "blocked_by");
        assert_eq!(list(&c, &b).unwrap()[0].kind, "blocks");
        assert_eq!(get_task(&c, &a).unwrap().blocked_by, 1);
        // Setting another kind replaces the pair's relation.
        set(&c, &b, &a, "related").unwrap();
        assert_eq!(list(&c, &a).unwrap().len(), 1);
        assert_eq!(list(&c, &a).unwrap()[0].kind, "related");
        assert_eq!(get_task(&c, &a).unwrap().blocked_by, 0);
    }

    #[test]
    fn rejects_self_and_cycles() {
        let c = open_memory();
        let (a, b, d) = (task(&c, "A"), task(&c, "B"), task(&c, "D"));
        assert!(set(&c, &a, &a, "related").is_err());
        set(&c, &a, &b, "blocks").unwrap();
        set(&c, &b, &d, "blocks").unwrap();
        assert!(set(&c, &d, &a, "blocks").is_err());
        assert!(set(&c, &a, &d, "blocked_by").is_err());
    }

    #[test]
    fn completing_the_last_blocker_unblocks() {
        let c = open_memory();
        let (a, b, w) = (task(&c, "Blocker 1"), task(&c, "Blocker 2"), task(&c, "Waiting"));
        update_task(&c, &w, &TaskPatch { status: Some("blocked".into()), ..Default::default() }).unwrap();
        set(&c, &w, &a, "blocked_by").unwrap();
        set(&c, &w, &b, "blocked_by").unwrap();
        let r = update_task(&c, &a, &TaskPatch { status: Some("completed".into()), ..Default::default() }).unwrap();
        assert!(r.unblocked.is_empty());
        assert_eq!(get_task(&c, &w).unwrap().status, "blocked");
        let r = update_task(
            &c,
            &b,
            &TaskPatch { status: Some("completed".into()), resolution: Some(Some("cancelled".into())), ..Default::default() },
        )
        .unwrap();
        assert_eq!(r.task.resolution.as_deref(), Some("cancelled"));
        assert_eq!(r.unblocked.len(), 1);
        assert_eq!(get_task(&c, &w).unwrap().status, "todo");
    }

    #[test]
    fn resolution_only_on_completed_tasks() {
        let c = open_memory();
        let a = task(&c, "A");
        let r = update_task(
            &c,
            &a,
            &TaskPatch { status: Some("completed".into()), resolution: Some(Some("cancelled".into())), ..Default::default() },
        )
        .unwrap();
        assert_eq!(r.task.resolution.as_deref(), Some("cancelled"));
        let r = update_task(&c, &a, &TaskPatch { status: Some("todo".into()), ..Default::default() }).unwrap();
        assert!(r.task.resolution.is_none());
        let r = update_task(&c, &a, &TaskPatch { status: Some("completed".into()), ..Default::default() }).unwrap();
        assert!(r.task.resolution.is_none(), "completing afresh means done");
        assert!(update_task(&c, &a, &TaskPatch { resolution: Some(Some("nope".into())), ..Default::default() }).is_err());
    }
}
