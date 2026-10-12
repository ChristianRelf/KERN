//! Global search backed by SQLite FTS5 (kept in sync by triggers), plus
//! labels and saved views by name.

use crate::error::AppResult;
use crate::state::AppState;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub kind: String,
    pub id: String,
    /// Project id (tasks, notes, boards, whiteboards) or whiteboard id (wb_node).
    pub parent_id: Option<String>,
    pub title: String,
    pub snippet: String,
    /// Extra per-kind info, e.g. task status.
    pub meta: Option<String>,
}

/// Converts free text into a safe FTS5 query: every token becomes a quoted
/// prefix term, all terms required.
pub fn to_fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '(' || c == ')' || c == '*' || c == ':' || c == '^')
        .filter(|t| !t.is_empty())
        .take(8)
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

#[tauri::command]
pub fn search(state: State<AppState>, query: String, limit: Option<i64>) -> AppResult<Vec<SearchHit>> {
    let limit = limit.unwrap_or(30).clamp(1, 200);
    let Some(fts) = to_fts_query(&query) else { return Ok(vec![]) };
    let like = format!("%{}%", query.trim().replace('%', "").replace('_', ""));
    state.with(|c| {
        let mut out = vec![];
        let mut stmt = c.prepare(
            "SELECT kind, ref_id, parent_id, title, snippet(search_fts, 4, '', '', '…', 12)
             FROM search_fts WHERE search_fts MATCH ?1
             ORDER BY bm25(search_fts, 0.0, 0.0, 0.0, 8.0, 1.0) LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![fts, limit], |r| {
            Ok(SearchHit {
                kind: r.get(0)?,
                id: r.get(1)?,
                parent_id: r.get(2)?,
                title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                snippet: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                meta: None,
            })
        })?;
        for hit in rows {
            let mut hit = hit?;
            match hit.kind.as_str() {
                "task" => {
                    hit.meta = c
                        .query_row("SELECT status FROM tasks WHERE id = ?1", [&hit.id], |r| r.get(0))
                        .optional()?;
                }
                "wb_node" => {
                    // Show the whiteboard's name for context.
                    hit.meta = c
                        .query_row("SELECT name FROM whiteboards WHERE id = ?1 AND deleted_at IS NULL", [&hit.parent_id], |r| r.get(0))
                        .optional()?;
                    if hit.meta.is_none() {
                        continue;
                    }
                }
                _ => {}
            }
            out.push(hit);
        }
        let mut stmt = c.prepare("SELECT id, name FROM labels WHERE name LIKE ?1 ORDER BY name LIMIT 5")?;
        for row in stmt.query_map([&like], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (id, name) = row?;
            out.push(SearchHit { kind: "label".into(), id, parent_id: None, title: name, snippet: String::new(), meta: None });
        }
        let mut stmt = c.prepare("SELECT id, name FROM saved_views WHERE name LIKE ?1 ORDER BY name LIMIT 5")?;
        for row in stmt.query_map([&like], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (id, name) = row?;
            out.push(SearchHit { kind: "view".into(), id, parent_id: None, title: name, snippet: String::new(), meta: None });
        }
        Ok(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_sanitising() {
        assert_eq!(to_fts_query("  "), None);
        assert_eq!(to_fts_query("web re\"design"), Some("\"web\"* \"re\"* \"design\"*".into()));
        assert_eq!(to_fts_query("a:b OR c*"), Some("\"a\"* \"b\"* \"OR\"* \"c\"*".into()));
    }
}
