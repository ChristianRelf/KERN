//! Comments on tasks. Offline they're notes to yourself; in a Kern Cloud
//! workspace they sync like any other record and can @mention members.
//! A mention is stored twice: inline in the body as `@[Name](user-id)` (so
//! it renders as a chip) and in `mentions` (so it can be looked up).

use crate::domain::{activity, cloud, notify, settings};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

pub const MAX_BODY: usize = 10_000;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub task_id: String,
    pub author_id: Option<String>,
    pub author_name: String,
    pub body: String,
    pub mentions: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub edited_at: Option<i64>,
    /// Written by whoever is using Kern here (always true offline).
    pub mine: bool,
}

const SELECT: &str = "SELECT id, task_id, author_id, author_name, body, mentions, created_at, updated_at, edited_at FROM task_comments";

fn map(r: &Row, me: Option<&str>) -> rusqlite::Result<Comment> {
    let mentions: String = r.get(5)?;
    let author_id: Option<String> = r.get(2)?;
    Ok(Comment {
        id: r.get(0)?,
        task_id: r.get(1)?,
        mine: match (&author_id, me) {
            (Some(a), Some(m)) => a == m,
            (None, _) => true,
            _ => false,
        },
        author_id,
        author_name: r.get(3)?,
        body: r.get(4)?,
        mentions: serde_json::from_str(&mentions).unwrap_or_default(),
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        edited_at: r.get(8)?,
    })
}

/// Who's writing: the Kern Cloud account inside a cloud space, nobody offline.
pub struct Author {
    pub id: Option<String>,
    pub name: String,
}

fn author(conn: &Connection, in_space: bool) -> Author {
    match cloud::current_account(conn) {
        Some(a) if in_space => Author { name: if a.name.trim().is_empty() { a.email.clone() } else { a.name.clone() }, id: Some(a.id) },
        _ => Author { id: None, name: String::new() },
    }
}

/// User ids mentioned in a body (`@[Name](id)`), de-duplicated.
pub fn parse_mentions(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = body;
    while let Some(i) = rest.find("@[") {
        let after = &rest[i + 2..];
        let Some(close) = after.find("](") else { break };
        let tail = &after[close + 2..];
        let Some(end) = tail.find(')') else { break };
        let id = &tail[..end];
        if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') && !out.iter().any(|x| x == id) {
            out.push(id.to_string());
        }
        rest = &tail[end..];
    }
    out
}

pub fn list(conn: &Connection, task_id: &str) -> AppResult<Vec<Comment>> {
    let me = cloud::current_account(conn).map(|a| a.id);
    let mut stmt = conn.prepare(&format!("{SELECT} WHERE task_id = ?1 ORDER BY created_at, id"))?;
    let rows = stmt.query_map([task_id], |r| map(r, me.as_deref()))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Comment> {
    let me = cloud::current_account(conn).map(|a| a.id);
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], |r| map(r, me.as_deref()))
        .optional()?
        .ok_or_else(|| AppError::NotFound("Comment".into()))
}

fn clean_body(body: &str) -> AppResult<String> {
    let b = body.trim();
    if b.is_empty() {
        return invalid("A comment can't be empty.");
    }
    if b.len() > MAX_BODY {
        return invalid("That comment is too long.");
    }
    Ok(b.to_string())
}

pub fn add(conn: &Connection, task_id: &str, body: &str, who: &Author) -> AppResult<Comment> {
    let body = clean_body(body)?;
    let (title, project): (String, Option<String>) = conn
        .query_row("SELECT title, project_id FROM tasks WHERE id = ?1 AND deleted_at IS NULL", [task_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or_else(|| AppError::NotFound("Task".into()))?;
    let now = now_ms();
    let id = new_id();
    let mentions = serde_json::to_string(&parse_mentions(&body))?;
    conn.execute(
        "INSERT INTO task_comments(id, task_id, author_id, author_name, body, mentions, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, task_id, who.id, who.name, body, mentions, now],
    )?;
    activity::log(conn, project.as_deref(), "task", task_id, "commented", &title)?;
    get(conn, &id)
}

fn check_own(conn: &Connection, id: &str) -> AppResult<Comment> {
    let c = get(conn, id)?;
    if !c.mine {
        return invalid("You can only change your own comments.");
    }
    Ok(c)
}

pub fn edit(conn: &Connection, id: &str, body: &str) -> AppResult<Comment> {
    check_own(conn, id)?;
    let body = clean_body(body)?;
    let now = now_ms();
    let mentions = serde_json::to_string(&parse_mentions(&body))?;
    conn.execute("UPDATE task_comments SET body = ?1, mentions = ?2, updated_at = ?3, edited_at = ?3 WHERE id = ?4", params![body, mentions, now, id])?;
    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    check_own(conn, id)?;
    conn.execute("DELETE FROM task_comments WHERE id = ?1", [id])?;
    Ok(())
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    pub comment_id: String,
    pub task_id: String,
    pub task_title: String,
    pub author_name: String,
    pub excerpt: String,
    pub created_at: i64,
}

/// Plain text for previews: mention chips become "@Name".
pub fn plain(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    while let Some(i) = rest.find("@[") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        match (after.find("]("), after.find(')')) {
            (Some(close), Some(end)) if close < end => {
                out.push('@');
                out.push_str(&after[..close]);
                rest = &after[end + 1..];
            }
            _ => {
                out.push_str("@[");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Comments by others that mention `user_id`, newest first.
pub fn mentions_of(conn: &Connection, user_id: &str, since: i64, limit: i64) -> AppResult<Vec<Mention>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.task_id, t.title, c.author_name, c.body, c.created_at FROM task_comments c JOIN tasks t ON t.id = c.task_id
         WHERE t.deleted_at IS NULL AND c.created_at > ?2 AND (c.author_id IS NULL OR c.author_id != ?1)
           AND EXISTS (SELECT 1 FROM json_each(c.mentions) m WHERE m.value = ?1)
         ORDER BY c.created_at DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![user_id, since, limit], |r| {
        let body: String = r.get(4)?;
        let text = plain(&body);
        Ok(Mention {
            comment_id: r.get(0)?,
            task_id: r.get(1)?,
            task_title: r.get(2)?,
            author_name: r.get(3)?,
            excerpt: text.lines().next().unwrap_or("").chars().take(140).collect(),
            created_at: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// After remote comments arrive: a notification for each new mention of
/// the signed-in user (in this space), once.
pub fn notify_mentions(app: &AppHandle, space: &str) {
    let state = app.state::<AppState>();
    let key = format!("internal.mentionsSeen.{space}");
    let found = state.with(|c| {
        let Some(me) = cloud::current_account(c) else { return Ok(vec![]) };
        let seen: Option<i64> = settings::get(c, &key);
        let Some(seen) = seen else {
            // First sync of this space: older mentions aren't news.
            settings::set(c, &key, &Value::from(now_ms()))?;
            return Ok(vec![]);
        };
        let found = mentions_of(c, &me.id, seen, 20)?;
        if let Some(newest) = found.first() {
            settings::set(c, &key, &Value::from(newest.created_at))?;
        }
        let allowed = notify::category_enabled(c, "notifications.mentions");
        Ok(if allowed { found } else { vec![] })
    });
    let Ok(found) = found else { return };
    if found.is_empty() {
        return;
    }
    if found.len() > 3 {
        notify::send(app, &format!("{} new mentions", found.len()), "You were mentioned in task comments.");
    } else {
        for m in &found {
            notify::send(app, &format!("{} mentioned you", if m.author_name.is_empty() { "Someone" } else { &m.author_name }), &format!("{}: {}", m.task_title, m.excerpt));
        }
    }
    let _ = app.emit("kern://mentioned", &found);
}

// --------------------------------------------------------------- commands

#[tauri::command]
pub fn comments_list(state: State<AppState>, task_id: String) -> AppResult<Vec<Comment>> {
    state.with(|c| list(c, &task_id))
}

#[tauri::command]
pub fn comment_add(state: State<AppState>, task_id: String, body: String) -> AppResult<Comment> {
    let in_space = state.cloud.is_active();
    state.with(|c| {
        let who = author(c, in_space);
        let tx = c.transaction()?;
        let out = add(&tx, &task_id, &body, &who)?;
        tx.commit()?;
        Ok(out)
    })
}

#[tauri::command]
pub fn comment_edit(state: State<AppState>, id: String, body: String) -> AppResult<Comment> {
    state.with(|c| edit(c, &id, &body))
}

#[tauri::command]
pub fn comment_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| delete(c, &id))
}

#[tauri::command]
pub fn comment_mentions(state: State<AppState>, limit: Option<i64>) -> AppResult<Vec<Mention>> {
    state.with(|c| match cloud::current_account(c) {
        Some(me) if state.cloud.is_active() => mentions_of(c, &me.id, 0, limit.unwrap_or(30).clamp(1, 200)),
        _ => Ok(vec![]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::tasks::{create_task, TaskInput};

    #[test]
    fn mentions_are_parsed_and_rendered_plain() {
        let b = "Hey @[Ana Li](u-1) and @[Bo](u_2), see @[Ana Li](u-1). Not @[x](bad id).";
        assert_eq!(parse_mentions(b), vec!["u-1".to_string(), "u_2".to_string()]);
        assert_eq!(plain("Hi @[Ana](u1)!"), "Hi @Ana!");
        assert_eq!(plain("broken @[x"), "broken @[x");
    }

    #[test]
    fn add_edit_delete_and_find_mentions() {
        let c = open_memory();
        let t = create_task(&c, &TaskInput { title: "Ship it".into(), ..Default::default() }).unwrap();
        let me = Author { id: Some("me".into()), name: "Me".into() };
        let other = Author { id: Some("ana".into()), name: "Ana".into() };
        let a = add(&c, &t.id, "  Looks good  ", &me).unwrap();
        assert_eq!(a.body, "Looks good");
        assert!(add(&c, &t.id, "   ", &me).is_err());
        add(&c, &t.id, "Over to you @[Me](me)", &other).unwrap();
        // Signed out here, so nothing is "mine" except offline comments.
        let found = mentions_of(&c, "me", 0, 10).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].author_name, "Ana");
        assert_eq!(found[0].excerpt, "Over to you @Me");
        // Own mentions of yourself aren't news.
        add(&c, &t.id, "note to @[Me](me)", &me).unwrap();
        assert_eq!(mentions_of(&c, "me", 0, 10).unwrap().len(), 1);
        assert_eq!(list(&c, &t.id).unwrap().len(), 3);
        let task = crate::domain::tasks::get_task(&c, &t.id).unwrap();
        assert_eq!(task.comment_count, 3);
        // Offline comments (no author) can be edited and deleted.
        let mine = add(&c, &t.id, "draft", &Author { id: None, name: String::new() }).unwrap();
        assert_eq!(edit(&c, &mine.id, "final").unwrap().body, "final");
        delete(&c, &mine.id).unwrap();
        assert_eq!(list(&c, &t.id).unwrap().len(), 3);
    }
}
