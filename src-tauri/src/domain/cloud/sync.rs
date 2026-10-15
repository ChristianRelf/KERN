//! Sync engine for cloud space replicas.
//!
//! A space replica has the same schema as the offline database. Triggers on
//! the synced tables record changed rows in `sync_outbox`. Pushing compares
//! each changed row with its shadow (the server's version as last known
//! here) and sends only the fields that differ - or the full row for a new
//! record - so concurrent edits to different fields of the same record merge
//! on the server. Remote changes are applied with a three-way merge: a field
//! with an unsent local edit keeps the local value (it will be pushed), every
//! other field takes the server's value. Deletions leave tombstone shadows so
//! a stale copy can never bring a record back.
//!
//! Columns that are personal or device-specific (pins, time blocks, last-opened times,
//! whiteboard viewports, links to local repositories) are never sent and
//! never overwritten.

use crate::error::AppResult;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap};

pub struct SyncTable {
    pub name: &'static str,
    pub pk: &'static [&'static str],
    /// Columns kept per device (not synced, never overwritten).
    pub local: &'static [&'static str],
}

/// Synced tables in dependency order (parents first).
pub const TABLES: &[SyncTable] = &[
    SyncTable { name: "project_groups", pk: &["id"], local: &["collapsed"] },
    SyncTable { name: "projects", pk: &["id"], local: &["pinned", "last_opened_at", "prev_opened_at", "ai_prefs", "repo_adopted_key"] },
    SyncTable { name: "labels", pk: &["id"], local: &[] },
    SyncTable { name: "boards", pk: &["id"], local: &[] },
    SyncTable { name: "board_columns", pk: &["id"], local: &["collapsed"] },
    SyncTable { name: "milestones", pk: &["id"], local: &["repository_id"] },
    SyncTable { name: "tasks", pk: &["id"], local: &["pinned", "plan_date", "plan_time"] },
    SyncTable { name: "task_labels", pk: &["task_id", "label_id"], local: &[] },
    SyncTable { name: "task_relations", pk: &["task_id", "related_id"], local: &[] },
    SyncTable { name: "milestone_deps", pk: &["milestone_id", "depends_on"], local: &[] },
    SyncTable { name: "release_links", pk: &["id"], local: &[] },
    SyncTable { name: "notes", pk: &["id"], local: &[] },
    SyncTable { name: "inbox_items", pk: &["id"], local: &[] },
    SyncTable { name: "whiteboards", pk: &["id"], local: &["viewport", "pinned"] },
    SyncTable { name: "wb_nodes", pk: &["id"], local: &[] },
    SyncTable { name: "wb_edges", pk: &["id"], local: &[] },
    SyncTable { name: "project_repos", pk: &["project_id"], local: &["last_synced_at", "last_sync_error"] },
    SyncTable { name: "task_issue_links", pk: &["repo", "issue_number"], local: &[] },
    SyncTable { name: "task_comments", pk: &["id"], local: &[] },
    SyncTable { name: "templates", pk: &["id"], local: &[] },
    SyncTable { name: "habits", pk: &["id"], local: &[] },
    SyncTable { name: "habit_checks", pk: &["habit_id", "day"], local: &[] },
];

pub fn table(name: &str) -> Option<&'static SyncTable> {
    TABLES.iter().find(|t| t.name == name)
}

/// The record id used on the server: the primary key, joined with `|` for
/// composite keys.
fn key_expr(t: &SyncTable, row: &str) -> String {
    if t.pk.len() == 1 {
        format!("CAST({row}.{} AS TEXT)", t.pk[0])
    } else {
        t.pk.iter().map(|c| format!("CAST({row}.{c} AS TEXT)")).collect::<Vec<_>>().join(" || '|' || ")
    }
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sync_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  rid TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_key ON sync_outbox(tbl, rid);
-- The server's version of each record as last seen here ('null' = deleted),
-- with the sequence number it had.
CREATE TABLE IF NOT EXISTS sync_shadow (
  tbl TEXT NOT NULL,
  rid TEXT NOT NULL,
  data TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tbl, rid)
);
INSERT OR IGNORE INTO sync_meta(key, value) VALUES ('applying', '0'), ('cursor', '0');
"#;

/// Creates the bookkeeping tables and (re)creates the change triggers.
pub fn install(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA)?;
    let mut sql = String::new();
    let guard = "WHEN (SELECT value FROM sync_meta WHERE key = 'applying') IS NOT '1'";
    for t in TABLES {
        let n = t.name;
        let new_key = key_expr(t, "new");
        let old_key = key_expr(t, "old");
        sql.push_str(&format!(
            "DROP TRIGGER IF EXISTS sync_{n}_ai; DROP TRIGGER IF EXISTS sync_{n}_au; DROP TRIGGER IF EXISTS sync_{n}_ad;
             CREATE TRIGGER sync_{n}_ai AFTER INSERT ON {n} {guard} BEGIN INSERT INTO sync_outbox(tbl, rid) VALUES ('{n}', {new_key}); END;
             CREATE TRIGGER sync_{n}_au AFTER UPDATE ON {n} {guard} BEGIN
               INSERT INTO sync_outbox(tbl, rid) VALUES ('{n}', {new_key});
               INSERT INTO sync_outbox(tbl, rid) SELECT '{n}', {old_key} WHERE {old_key} IS NOT {new_key};
             END;
             CREATE TRIGGER sync_{n}_ad AFTER DELETE ON {n} {guard} BEGIN INSERT INTO sync_outbox(tbl, rid) VALUES ('{n}', {old_key}); END;\n"
        ));
    }
    conn.execute_batch(&sql)?;
    Ok(())
}

// ------------------------------------------------------------ meta

pub fn meta(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT value FROM sync_meta WHERE key = ?1", [key], |r| r.get(0)).optional()?.flatten())
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute("INSERT INTO sync_meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value])?;
    Ok(())
}

pub fn cursor(conn: &Connection) -> AppResult<i64> {
    Ok(meta(conn, "cursor")?.and_then(|v| v.parse().ok()).unwrap_or(0))
}

pub fn set_cursor(conn: &Connection, v: i64) -> AppResult<()> {
    set_meta(conn, "cursor", &v.to_string())
}

/// The space this replica belongs to (None for the offline database).
pub fn space_of(conn: &Connection) -> Option<String> {
    meta(conn, "space").ok().flatten()
}

pub fn pending_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(DISTINCT tbl || char(31) || rid) FROM sync_outbox", [], |r| r.get(0)).unwrap_or(0)
}

fn set_applying(conn: &Connection, on: bool) -> AppResult<()> {
    conn.execute("UPDATE sync_meta SET value = ?1 WHERE key = 'applying'", [if on { "1" } else { "0" }])?;
    Ok(())
}

// ------------------------------------------------------------ values

fn to_json(v: SqlValue) -> Value {
    match v {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(i) => Value::from(i),
        SqlValue::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        SqlValue::Text(s) => Value::String(s),
        SqlValue::Blob(_) => Value::Null,
    }
}

fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(SqlValue::Integer).unwrap_or_else(|| SqlValue::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

/// Equality that treats 1 and 1.0 as the same value.
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Null), None) | (None, Some(Value::Null)) => true,
        (x, y) => x == y,
    }
}

/// Synced column names of a table (in the replica's schema).
fn columns(conn: &Connection, t: &SyncTable, cache: &mut HashMap<&'static str, Vec<String>>) -> AppResult<Vec<String>> {
    if let Some(c) = cache.get(t.name) {
        return Ok(c.clone());
    }
    let mut stmt = conn.prepare(&format!("SELECT name FROM pragma_table_info('{}', 'main')", t.name))?;
    let cols: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    let cols: Vec<String> = cols.into_iter().filter(|c| !t.local.contains(&c.as_str())).collect();
    cache.insert(t.name, cols.clone());
    Ok(cols)
}

fn split_key<'a>(t: &SyncTable, rid: &'a str) -> Vec<&'a str> {
    if t.pk.len() == 1 {
        vec![rid]
    } else {
        rid.splitn(t.pk.len(), '|').collect()
    }
}

fn pk_where(t: &SyncTable) -> String {
    t.pk.iter().enumerate().map(|(i, c)| format!("{c} = ?{}", i + 1)).collect::<Vec<_>>().join(" AND ")
}

fn read_row(conn: &Connection, t: &SyncTable, rid: &str, cols: &[String]) -> AppResult<Option<Map<String, Value>>> {
    let parts = split_key(t, rid);
    if parts.len() != t.pk.len() {
        return Ok(None);
    }
    let sql = format!("SELECT {} FROM main.{} WHERE {}", cols.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", "), t.name, pk_where(t));
    let row = conn
        .query_row(&sql, params_from_iter(parts.iter()), |r| {
            let mut m = Map::new();
            for (i, c) in cols.iter().enumerate() {
                m.insert(c.clone(), to_json(r.get::<_, SqlValue>(i)?));
            }
            Ok(m)
        })
        .optional()?;
    Ok(row)
}

/// The shadow of a record: Some(None) is a tombstone.
fn shadow(conn: &Connection, tbl: &str, rid: &str) -> AppResult<Option<(Option<Map<String, Value>>, i64)>> {
    let row: Option<(String, i64)> = conn
        .query_row("SELECT data, seq FROM sync_shadow WHERE tbl = ?1 AND rid = ?2", params![tbl, rid], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    Ok(row.map(|(d, seq)| {
        let data = match serde_json::from_str::<Value>(&d) {
            Ok(Value::Object(m)) => Some(m),
            _ => None,
        };
        (data, seq)
    }))
}

fn set_shadow(conn: &Connection, tbl: &str, rid: &str, data: Option<&Map<String, Value>>, seq: i64) -> AppResult<()> {
    let text = data.map(|d| Value::Object(d.clone()).to_string()).unwrap_or_else(|| "null".into());
    conn.execute(
        "INSERT INTO sync_shadow(tbl, rid, data, seq) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(tbl, rid) DO UPDATE SET data = excluded.data, seq = excluded.seq",
        params![tbl, rid, text, seq],
    )?;
    Ok(())
}

fn enqueue(conn: &Connection, tbl: &str, rid: &str) -> AppResult<()> {
    conn.execute("INSERT INTO sync_outbox(tbl, rid) VALUES (?1, ?2)", params![tbl, rid])?;
    Ok(())
}

/// Fields of `local` that differ from the shadow.
fn diff(local: &Map<String, Value>, shadow: &Map<String, Value>) -> Map<String, Value> {
    local.iter().filter(|(k, v)| !same(Some(v), shadow.get(*k))).map(|(k, v)| (k.clone(), v.clone())).collect()
}

// ------------------------------------------------------------ push

#[derive(Serialize, Debug, Clone)]
pub struct OutChange {
    pub t: String,
    pub id: String,
    pub op: &'static str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub full: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Map<String, Value>>,
}

#[derive(Debug, Default)]
pub struct PushBatch {
    /// Every outbox key examined, with the highest outbox entry covered.
    pub keys: Vec<(String, String, i64)>,
    pub changes: Vec<OutChange>,
}

/// Gathers up to `limit` changed records (bounded to ~`max_bytes` of JSON).
pub fn collect(conn: &Connection, limit: usize, max_bytes: usize) -> AppResult<PushBatch> {
    let mut stmt = conn.prepare("SELECT tbl, rid, max(seq) FROM sync_outbox GROUP BY tbl, rid ORDER BY min(seq) LIMIT ?1")?;
    let keys: Vec<(String, String, i64)> = stmt.query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
    let mut cache = HashMap::new();
    let mut batch = PushBatch::default();
    let mut bytes = 0usize;
    for (tbl, rid, upto) in keys {
        let Some(t) = table(&tbl) else {
            batch.keys.push((tbl, rid, upto));
            continue;
        };
        let cols = columns(conn, t, &mut cache)?;
        let local = read_row(conn, t, &rid, &cols)?;
        let sh = shadow(conn, &tbl, &rid)?;
        let change = match (local, sh) {
            (None, Some((Some(_), _))) => Some(OutChange { t: tbl.clone(), id: rid.clone(), op: "delete", full: false, data: None }),
            (None, _) => None,
            (Some(row), Some((Some(s), _))) => {
                let mut patch = diff(&row, &s);
                if patch.is_empty() {
                    None
                } else {
                    for k in t.pk {
                        if let Some(v) = row.get(*k) {
                            patch.insert(k.to_string(), v.clone());
                        }
                    }
                    Some(OutChange { t: tbl.clone(), id: rid.clone(), op: "upsert", full: false, data: Some(patch) })
                }
            }
            (Some(row), _) => Some(OutChange { t: tbl.clone(), id: rid.clone(), op: "upsert", full: true, data: Some(row) }),
        };
        if let Some(c) = change {
            let size = c.data.as_ref().map(|d| Value::Object(d.clone()).to_string().len()).unwrap_or(64);
            if !batch.changes.is_empty() && bytes + size > max_bytes {
                break;
            }
            bytes += size;
            batch.changes.push(c);
        }
        batch.keys.push((tbl, rid, upto));
    }
    Ok(batch)
}

#[derive(Deserialize, Debug, Clone)]
pub struct RemoteChange {
    pub seq: i64,
    pub t: String,
    pub id: String,
    pub op: String,
    #[serde(default)]
    pub data: Option<Map<String, Value>>,
}

#[derive(Deserialize, Debug, Default)]
pub struct PushResult {
    #[serde(default)]
    pub changes: Vec<RemoteChange>,
    #[serde(default)]
    pub rejected: Vec<RemoteChange>,
}

#[derive(Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Touched {
    pub tables: BTreeSet<String>,
    pub whiteboards: BTreeSet<String>,
}

impl Touched {
    pub fn is_empty(&self) -> bool {
        self.tables.is_empty()
    }
    fn note(&mut self, tbl: &str, data: Option<&Map<String, Value>>, wb: Option<String>) {
        self.tables.insert(tbl.to_string());
        if tbl == "wb_nodes" || tbl == "wb_edges" {
            if let Some(id) = wb.or_else(|| data.and_then(|d| d.get("whiteboard_id")).and_then(|v| v.as_str()).map(String::from)) {
                self.whiteboards.insert(id);
            }
        } else if tbl == "whiteboards" {
            if let Some(id) = data.and_then(|d| d.get("id")).and_then(|v| v.as_str()) {
                self.whiteboards.insert(id.to_string());
            }
        }
    }
}

/// Records what the server accepted. The reply carries each record as merged
/// on the server - including fields other people changed - so it's applied
/// like a remote change, against a base of "the previous shadow plus what we
/// sent". Anything edited again since collecting stays queued.
pub fn ack(conn: &mut Connection, batch: &PushBatch, result: &PushResult) -> AppResult<Touched> {
    with_applying(conn, |tx| {
        let mut touched = Touched::default();
        let mut cache = HashMap::new();
        let sent: HashMap<(&str, &str), &OutChange> = batch.changes.iter().map(|c| ((c.t.as_str(), c.id.as_str()), c)).collect();
        for r in &result.changes {
            let Some(out) = sent.get(&(r.t.as_str(), r.id.as_str())) else { continue };
            let current = shadow(tx, &r.t, &r.id)?;
            let (prev, prev_seq) = match current {
                // A newer version was already applied (e.g. the realtime echo).
                Some((_, seq)) if seq >= r.seq => continue,
                Some((d, seq)) => (d, seq),
                None => (None, 0),
            };
            if out.op == "delete" {
                set_shadow(tx, &r.t, &r.id, None, r.seq)?;
                continue;
            }
            let mut base = if out.full { Map::new() } else { prev.unwrap_or_default() };
            for (k, v) in out.data.iter().flatten() {
                base.insert(k.clone(), v.clone());
            }
            set_shadow(tx, &r.t, &r.id, Some(&base), prev_seq)?;
            apply_one(tx, r, false, &mut cache, &mut touched)?;
        }
        // Deleted elsewhere while edited here: deletion wins.
        for r in &result.rejected {
            if let Some(t) = table(&r.t) {
                let wb = whiteboard_of(tx, t, &r.id);
                let parts = split_key(t, &r.id);
                tx.execute(&format!("DELETE FROM main.{} WHERE {}", t.name, pk_where(t)), params_from_iter(parts.iter()))?;
                set_shadow(tx, &r.t, &r.id, None, 0)?;
                touched.note(&r.t, None, wb);
            }
        }
        for (tbl, rid, upto) in &batch.keys {
            tx.execute("DELETE FROM sync_outbox WHERE tbl = ?1 AND rid = ?2 AND seq <= ?3", params![tbl, rid, upto])?;
            // Re-queue if the record still differs from what the server has.
            if let Some(t) = table(tbl) {
                let cols = columns(tx, t, &mut cache)?;
                let local = read_row(tx, t, rid, &cols)?;
                let sh = shadow(tx, tbl, rid)?;
                let dirty = match (&local, &sh) {
                    (Some(l), Some((Some(s), _))) => !diff(l, s).is_empty(),
                    // Never accepted by the server yet: keep trying.
                    (Some(_), _) => true,
                    (None, Some((Some(_), _))) => true,
                    (None, _) => false,
                };
                if dirty {
                    enqueue(tx, tbl, rid)?;
                }
            }
        }
        Ok(touched)
    })
}

// ------------------------------------------------------------ apply

fn whiteboard_of(conn: &Connection, t: &SyncTable, rid: &str) -> Option<String> {
    if t.name != "wb_nodes" && t.name != "wb_edges" {
        return None;
    }
    conn.query_row(&format!("SELECT whiteboard_id FROM main.{} WHERE id = ?1", t.name), [rid], |r| r.get(0)).optional().ok().flatten()
}

/// Runs `f` in a transaction with change capture paused and foreign keys
/// off (remote records may arrive before the records they point to).
fn with_applying<T>(conn: &mut Connection, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
    conn.execute_batch("PRAGMA foreign_keys = OFF")?;
    let out = (|| {
        let tx = conn.transaction()?;
        set_applying(&tx, true)?;
        let v = f(&tx)?;
        set_applying(&tx, false)?;
        tx.commit()?;
        Ok(v)
    })();
    let _ = conn.execute_batch("PRAGMA foreign_keys = ON");
    out
}

/// Applies remote changes (in sequence order). With `force`, local edits
/// that haven't been sent are discarded instead of kept.
pub fn apply(conn: &mut Connection, changes: &[RemoteChange], force: bool) -> AppResult<Touched> {
    with_applying(conn, |tx| {
        let mut touched = Touched::default();
        let mut cache = HashMap::new();
        for ch in changes {
            apply_one(tx, ch, force, &mut cache, &mut touched)?;
        }
        Ok(touched)
    })
}

/// Three-way applies one remote version: fields with an unsent local edit
/// keep the local value (and stay queued); everything else takes the
/// server's. Older versions than the one already known are ignored.
fn apply_one(tx: &Connection, ch: &RemoteChange, force: bool, cache: &mut HashMap<&'static str, Vec<String>>, touched: &mut Touched) -> AppResult<()> {
    let Some(t) = table(&ch.t) else { return Ok(()) };
    let sh = shadow(tx, &ch.t, &ch.id)?;
    if !force && sh.as_ref().map(|(_, s)| *s >= ch.seq).unwrap_or(false) {
        return Ok(());
    }
    let parts = split_key(t, &ch.id);
    if parts.len() != t.pk.len() {
        return Ok(());
    }
    if ch.op == "delete" {
        let wb = whiteboard_of(tx, t, &ch.id);
        tx.execute(&format!("DELETE FROM main.{} WHERE {}", t.name, pk_where(t)), params_from_iter(parts.iter()))?;
        tx.execute("DELETE FROM sync_outbox WHERE tbl = ?1 AND rid = ?2", params![ch.t, ch.id])?;
        set_shadow(tx, &ch.t, &ch.id, None, ch.seq)?;
        touched.note(&ch.t, None, wb);
        return Ok(());
    }
    let cols = columns(tx, t, cache)?;
    let Some(data) = &ch.data else { return Ok(()) };
    let remote: Map<String, Value> = data.iter().filter(|(k, _)| cols.contains(k)).map(|(k, v)| (k.clone(), v.clone())).collect();
    if t.pk.iter().any(|k| !remote.contains_key(*k)) {
        return Ok(());
    }
    let local = read_row(tx, t, &ch.id, &cols)?;
    let base = sh.as_ref().and_then(|(d, _)| d.as_ref());
    let mut pending = false;
    let mut merged = remote.clone();
    if let (false, Some(l), Some(s)) = (force, &local, base) {
        for (k, v) in remote.iter() {
            if !same(l.get(k), s.get(k)) && !same(l.get(k), Some(v)) {
                merged.insert(k.clone(), l.get(k).cloned().unwrap_or(Value::Null));
                pending = true;
            }
        }
    }
    let result = match &local {
        Some(l) => {
            let changed: Vec<(&String, &Value)> = merged.iter().filter(|(k, v)| !same(l.get(*k), Some(v))).collect();
            if changed.is_empty() {
                Ok(0)
            } else {
                let sets = changed.iter().enumerate().map(|(i, (k, _))| format!("\"{k}\" = ?{}", i + 1)).collect::<Vec<_>>().join(", ");
                let wh = t.pk.iter().enumerate().map(|(i, c)| format!("{c} = ?{}", changed.len() + i + 1)).collect::<Vec<_>>().join(" AND ");
                let mut vals: Vec<SqlValue> = changed.iter().map(|(_, v)| to_sql(v)).collect();
                vals.extend(parts.iter().map(|p| SqlValue::Text(p.to_string())));
                tx.execute(&format!("UPDATE main.{} SET {sets} WHERE {wh}", t.name), params_from_iter(vals))
            }
        }
        None => {
            let names: Vec<&String> = merged.keys().collect();
            let sql = format!(
                "INSERT INTO main.{} ({}) VALUES ({})",
                t.name,
                names.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", "),
                (1..=names.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ")
            );
            tx.execute(&sql, params_from_iter(merged.values().map(to_sql)))
        }
    };
    if let Err(e) = result {
        // One bad record (e.g. from a newer app version) must not block the rest.
        eprintln!("cloud sync: couldn't apply {}/{}: {e}", ch.t, ch.id);
        return Ok(());
    }
    set_shadow(tx, &ch.t, &ch.id, Some(&remote), ch.seq)?;
    if pending {
        enqueue(tx, &ch.t, &ch.id)?;
    } else if force {
        tx.execute("DELETE FROM sync_outbox WHERE tbl = ?1 AND rid = ?2", params![ch.t, ch.id])?;
    }
    touched.note(&ch.t, Some(&remote), None);
    Ok(())
}

/// Drops local changes that were never accepted (read-only access): queued
/// edits are forgotten and records the server has never seen are removed.
/// A forced full pull afterwards restores the server's values.
pub fn discard_local(conn: &mut Connection) -> AppResult<Touched> {
    let tx = conn.transaction()?;
    set_applying(&tx, true)?;
    let mut touched = Touched::default();
    tx.execute("DELETE FROM sync_outbox", [])?;
    for t in TABLES {
        let key = key_expr(t, t.name);
        let n = tx.execute(
            &format!("DELETE FROM main.{0} WHERE NOT EXISTS (SELECT 1 FROM sync_shadow s WHERE s.tbl = '{0}' AND s.rid = {key} AND s.data != 'null')", t.name),
            [],
        )?;
        if n > 0 {
            touched.tables.insert(t.name.to_string());
        }
    }
    set_cursor(&tx, 0)?;
    set_applying(&tx, false)?;
    tx.commit()?;
    Ok(touched)
}

// ------------------------------------------------------------ import

/// Copies offline data (the attached `local` database) into this replica.
/// Existing records are left alone. Files are never copied: attachments stay
/// on this computer, and links to project folders and local repositories are
/// copied as device-only links.
pub fn import_offline(conn: &mut Connection, project_ids: Option<&[String]>) -> AppResult<HashMap<String, usize>> {
    // References that point outside the copied selection (a subtask of a
    // task in another project, say) are kept as they are, like remote data.
    conn.execute_batch("PRAGMA foreign_keys = OFF")?;
    let out = import_inner(conn, project_ids);
    let _ = conn.execute_batch("PRAGMA foreign_keys = ON");
    out
}

fn import_inner(conn: &mut Connection, project_ids: Option<&[String]>) -> AppResult<HashMap<String, usize>> {
    let tx = conn.transaction()?;
    let mut counts = HashMap::new();
    let sel = project_ids.map(|ids| {
        let quoted: Vec<String> = ids.iter().map(|i| format!("'{}'", i.replace('\'', "''"))).collect();
        format!("({})", quoted.join(","))
    });
    let filter = |table: &str| -> Option<String> {
        let p = sel.as_ref()?;
        Some(match table {
            "project_groups" => format!("id IN (SELECT group_id FROM local.projects WHERE id IN {p})"),
            "projects" => format!("id IN {p}"),
            "project_folder_links" | "project_repositories" | "project_layouts" => format!("project_id IN {p}"),
            "labels" => format!("id IN (SELECT tl.label_id FROM local.task_labels tl JOIN local.tasks x ON x.id = tl.task_id WHERE x.project_id IN {p})"),
            "boards" | "milestones" | "tasks" | "notes" | "whiteboards" | "project_repos" | "task_issue_links" => format!("project_id IN {p}"),
            "board_columns" => format!("board_id IN (SELECT id FROM local.boards WHERE project_id IN {p})"),
            "task_labels" => format!("task_id IN (SELECT id FROM local.tasks WHERE project_id IN {p})"),
            "milestone_deps" => format!("milestone_id IN (SELECT id FROM local.milestones WHERE project_id IN {p})"),
            "task_comments" => format!("task_id IN (SELECT id FROM local.tasks WHERE project_id IN {p})"),
            "release_links" => format!("milestone_id IN (SELECT id FROM local.milestones WHERE project_id IN {p})"),
            "wb_nodes" | "wb_edges" => format!("whiteboard_id IN (SELECT id FROM local.whiteboards WHERE project_id IN {p})"),
            _ => "0".to_string(),
        })
    };
    // Device-only companions first (milestones may point at repositories).
    let mut order: Vec<&str> = vec!["project_folder_links", "project_repositories", "project_layouts"];
    order.extend(TABLES.iter().map(|t| t.name));
    for name in order {
        let cols: Vec<String> = {
            let mut stmt = tx.prepare(&format!("SELECT name FROM pragma_table_info('{name}', 'main')"))?;
            let main_cols: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            let mut stmt = tx.prepare(&format!("SELECT name FROM pragma_table_info('{name}', 'local')"))?;
            let local_cols: BTreeSet<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            main_cols.into_iter().filter(|c| local_cols.contains(c)).collect()
        };
        if cols.is_empty() {
            continue;
        }
        let list = cols.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
        let wh = filter(name).map(|f| format!(" WHERE {f}")).unwrap_or_default();
        let n = tx.execute(&format!("INSERT OR IGNORE INTO main.{name} ({list}) SELECT {list} FROM local.{name}{wh}"), [])?;
        if n > 0 {
            counts.insert(name.to_string(), n);
        }
    }
    tx.commit()?;
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn replica() -> Connection {
        let c = crate::db::open_memory();
        install(&c).unwrap();
        c
    }

    fn rc(seq: i64, t: &str, id: &str, data: Value) -> RemoteChange {
        RemoteChange { seq, t: t.into(), id: id.into(), op: "upsert".into(), data: data.as_object().cloned() }
    }

    /// Pushes everything; the simulated server replies with the merged (full) rows.
    fn sent_all(c: &mut Connection, base_seq: i64) -> PushBatch {
        let b = collect(c, 500, 1 << 20).unwrap();
        let mut cache = HashMap::new();
        let res = PushResult {
            changes: b
                .changes
                .iter()
                .enumerate()
                .map(|(i, ch)| {
                    let t = table(&ch.t).unwrap();
                    let cols = columns(c, t, &mut cache).unwrap();
                    let data = if ch.op == "delete" { None } else { read_row(c, t, &ch.id, &cols).unwrap() };
                    RemoteChange { seq: base_seq + i as i64, t: ch.t.clone(), id: ch.id.clone(), op: ch.op.into(), data }
                })
                .collect(),
            rejected: vec![],
        };
        ack(c, &b, &res).unwrap();
        b
    }

    #[test]
    fn local_writes_are_captured_and_pushed_as_patches() {
        let mut c = replica();
        c.execute_batch("INSERT INTO projects(id, name, created_at, updated_at) VALUES ('p1', 'Site', 1, 1)").unwrap();
        let first = sent_all(&mut c, 1);
        assert_eq!(first.changes.len(), 1);
        assert!(first.changes[0].full);
        assert_eq!(pending_count(&c), 0);
        // Only the changed field (plus the key) is sent next time.
        c.execute_batch("UPDATE projects SET description = 'New' WHERE id = 'p1'").unwrap();
        let b = collect(&c, 500, 1 << 20).unwrap();
        let data = b.changes[0].data.as_ref().unwrap();
        assert!(!b.changes[0].full);
        assert_eq!(data.get("description"), Some(&json!("New")));
        assert!(data.get("name").is_none());
        // Personal columns are never sent.
        c.execute_batch("UPDATE projects SET pinned = 1 WHERE id = 'p1'").unwrap();
        let b = collect(&c, 500, 1 << 20).unwrap();
        assert!(b.changes[0].data.as_ref().unwrap().get("pinned").is_none());
    }

    #[test]
    fn remote_changes_merge_with_unsent_local_edits() {
        let mut c = replica();
        c.execute_batch("INSERT INTO tasks(id, title, created_at, updated_at) VALUES ('t1', 'Old', 1, 1)").unwrap();
        sent_all(&mut c, 1);
        // Local edit not yet pushed.
        c.execute_batch("UPDATE tasks SET title = 'Mine' WHERE id = 't1'").unwrap();
        // Someone else changed the status.
        let touched = apply(&mut c, &[rc(2, "tasks", "t1", json!({"id": "t1", "title": "Old", "status": "completed", "priority": 0, "created_at": 1, "updated_at": 2}))], false).unwrap();
        assert!(touched.tables.contains("tasks"));
        let (title, status): (String, String) = c.query_row("SELECT title, status FROM tasks WHERE id = 't1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((title.as_str(), status.as_str()), ("Mine", "completed"));
        // The local edit is still queued and is the only thing sent.
        let b = collect(&c, 500, 1 << 20).unwrap();
        let data = b.changes[0].data.as_ref().unwrap();
        assert_eq!(data.get("title"), Some(&json!("Mine")));
        assert!(data.get("status").is_none());
        // Remote applies don't enqueue themselves.
        let before = pending_count(&c);
        apply(&mut c, &[rc(3, "notes", "n1", json!({"id": "n1", "title": "Hi", "content": "", "created_at": 1, "updated_at": 1}))], false).unwrap();
        assert_eq!(pending_count(&c), before);
    }

    #[test]
    fn push_replies_bring_in_fields_others_changed() {
        let mut c = replica();
        c.execute_batch("INSERT INTO tasks(id, title, created_at, updated_at) VALUES ('t1', 'Old', 1, 1)").unwrap();
        sent_all(&mut c, 1);
        c.execute_batch("UPDATE tasks SET status = 'in_progress' WHERE id = 't1'").unwrap();
        let b = collect(&c, 500, 1 << 20).unwrap();
        // Someone renamed the task (seq 2) before our push (seq 3) was merged:
        // the server's reply is the whole merged row.
        let t = table("tasks").unwrap();
        let mut merged = read_row(&c, t, "t1", &columns(&c, t, &mut HashMap::new()).unwrap()).unwrap().unwrap();
        merged.insert("title".into(), json!("New"));
        ack(&mut c, &b, &PushResult { changes: vec![rc(3, "tasks", "t1", Value::Object(merged))], rejected: vec![] }).unwrap();
        let title: String = c.query_row("SELECT title FROM tasks WHERE id = 't1'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "New");
        assert_eq!(pending_count(&c), 0);
    }

    #[test]
    fn deletes_leave_tombstones_and_stale_copies_stay_dead() {
        let mut c = replica();
        apply(&mut c, &[rc(1, "notes", "n1", json!({"id": "n1", "title": "A", "content": "", "created_at": 1, "updated_at": 1}))], false).unwrap();
        apply(&mut c, &[RemoteChange { seq: 3, t: "notes".into(), id: "n1".into(), op: "delete".into(), data: None }], false).unwrap();
        // A pull that started before the delete delivers the older version.
        apply(&mut c, &[rc(2, "notes", "n1", json!({"id": "n1", "title": "A", "content": "", "created_at": 1, "updated_at": 1}))], false).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        // A local delete is pushed once.
        apply(&mut c, &[rc(4, "notes", "n2", json!({"id": "n2", "title": "B", "content": "", "created_at": 1, "updated_at": 1}))], false).unwrap();
        c.execute_batch("DELETE FROM notes WHERE id = 'n2'").unwrap();
        let b = sent_all(&mut c, 5);
        assert_eq!(b.changes[0].op, "delete");
        assert_eq!(pending_count(&c), 0);
    }

    #[test]
    fn composite_keys_round_trip() {
        let mut c = replica();
        c.execute_batch(
            "INSERT INTO labels(id, name, created_at) VALUES ('l1', 'Bug', 1);
             INSERT INTO tasks(id, title, created_at, updated_at) VALUES ('t1', 'T', 1, 1);
             INSERT INTO task_labels(task_id, label_id) VALUES ('t1', 'l1');",
        )
        .unwrap();
        let b = sent_all(&mut c, 1);
        assert!(b.changes.iter().any(|ch| ch.t == "task_labels" && ch.id == "t1|l1"));
        c.execute_batch("DELETE FROM task_labels").unwrap();
        let b = collect(&c, 500, 1 << 20).unwrap();
        assert_eq!((b.changes[0].id.as_str(), b.changes[0].op), ("t1|l1", "delete"));
        // Applying a remote composite row.
        apply(&mut c, &[rc(9, "task_labels", "t1|l1", json!({"task_id": "t1", "label_id": "l1"}))], false).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM task_labels", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn rejected_patch_removes_the_local_copy() {
        let mut c = replica();
        c.execute_batch("INSERT INTO notes(id, title, created_at, updated_at) VALUES ('n1', 'A', 1, 1)").unwrap();
        sent_all(&mut c, 1);
        c.execute_batch("UPDATE notes SET title = 'B' WHERE id = 'n1'").unwrap();
        let b = collect(&c, 500, 1 << 20).unwrap();
        let res = PushResult { changes: vec![], rejected: vec![RemoteChange { seq: 0, t: "notes".into(), id: "n1".into(), op: "delete".into(), data: None }] };
        ack(&mut c, &b, &res).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!((n, pending_count(&c)), (0, 0));
    }
}

/// End-to-end sync between two replicas through a running Kern Cloud server.
/// Opt-in: set KERN_E2E_URL, KERN_E2E_A / KERN_E2E_B (session tokens of two
/// members of one workspace) and KERN_E2E_SPACE, then
/// `cargo test cloud_e2e -- --ignored --nocapture`.
#[cfg(test)]
mod e2e {
    use super::*;
    use crate::domain::cloud::client;
    use crate::domain::whiteboards::{self, ScenePatch, WbNode};
    use serde_json::json;

    struct Peer {
        conn: Connection,
        token: String,
    }

    fn env(k: &str) -> Option<String> {
        std::env::var(k).ok().filter(|v| !v.is_empty())
    }

    fn peer(token: String) -> Peer {
        let conn = crate::db::open_memory();
        install(&conn).unwrap();
        Peer { conn, token }
    }

    fn push(p: &mut Peer, base: &str, space: &str) {
        loop {
            let batch = collect(&p.conn, 300, 2 << 20).unwrap();
            if batch.keys.is_empty() {
                return;
            }
            let result: PushResult = if batch.changes.is_empty() {
                PushResult::default()
            } else {
                let r = client::check(client::request(base, Some(&p.token), "POST", &format!("/spaces/{space}/sync/push"), Some(&json!({ "changes": batch.changes })))).unwrap();
                serde_json::from_value(r.body).unwrap()
            };
            ack(&mut p.conn, &batch, &result).unwrap();
        }
    }

    fn pull(p: &mut Peer, base: &str, space: &str) {
        loop {
            let since = cursor(&p.conn).unwrap();
            let r = client::check(client::request(base, Some(&p.token), "GET", &format!("/spaces/{space}/sync/pull?since={since}"), None)).unwrap().body;
            let changes: Vec<RemoteChange> = serde_json::from_value(r["changes"].clone()).unwrap();
            apply(&mut p.conn, &changes, false).unwrap();
            let next = r["cursor"].as_i64().unwrap();
            if next > since {
                set_cursor(&p.conn, next).unwrap();
            }
            if !r["hasMore"].as_bool().unwrap_or(false) {
                return;
            }
        }
    }

    fn text(c: &Connection, sql: &str) -> Option<String> {
        c.query_row(sql, [], |r| r.get(0)).optional().unwrap().flatten()
    }

    fn wb(id: &str, x: f64) -> WbNode {
        serde_json::from_value(json!({ "id": id, "type": "sticky", "x": x, "y": 0.0, "width": 200.0, "height": 200.0, "data": { "text": id } })).unwrap()
    }

    #[test]
    #[ignore]
    fn cloud_e2e_two_replicas_converge() {
        let (Some(base), Some(ta), Some(tb), Some(space)) = (env("KERN_E2E_URL"), env("KERN_E2E_A"), env("KERN_E2E_B"), env("KERN_E2E_SPACE")) else {
            eprintln!("KERN_E2E_* not set; skipping");
            return;
        };
        let (mut a, mut b) = (peer(ta), peer(tb));

        // A creates a project, a board column, a task and a whiteboard.
        a.conn
            .execute_batch(
                "INSERT INTO projects(id, name, created_at, updated_at) VALUES ('p1', 'Launch', 1, 1);
                 INSERT INTO boards(id, project_id, name, created_at, updated_at) VALUES ('b1', 'p1', 'Board', 1, 1);
                 INSERT INTO board_columns(id, board_id, name, created_at, updated_at) VALUES ('c1', 'b1', 'Doing', 1, 1);
                 INSERT INTO tasks(id, title, project_id, column_id, created_at, updated_at) VALUES ('t1', 'Write copy', 'p1', 'c1', 1, 1);
                 INSERT INTO labels(id, name, created_at) VALUES ('l1', 'urgent', 1);
                 INSERT INTO task_labels(task_id, label_id) VALUES ('t1', 'l1');
                 INSERT INTO whiteboards(id, project_id, name, created_at, updated_at) VALUES ('w1', 'p1', 'Plan', 1, 1);",
            )
            .unwrap();
        push(&mut a, &base, &space);
        pull(&mut b, &base, &space);
        assert_eq!(text(&b.conn, "SELECT title FROM tasks WHERE id = 't1'").as_deref(), Some("Write copy"));
        assert_eq!(text(&b.conn, "SELECT name FROM board_columns WHERE id = 'c1'").as_deref(), Some("Doing"));
        assert_eq!(text(&b.conn, "SELECT label_id FROM task_labels WHERE task_id = 't1'").as_deref(), Some("l1"));
        // Remote rows are searchable like local ones.
        assert_eq!(text(&b.conn, "SELECT ref_id FROM search_fts WHERE search_fts MATCH 'copy'").as_deref(), Some("t1"));

        // Concurrent edits to different fields of the same task merge.
        a.conn.execute_batch("UPDATE tasks SET title = 'Write launch copy' WHERE id = 't1'").unwrap();
        b.conn.execute_batch("UPDATE tasks SET status = 'in_progress', priority = 2 WHERE id = 't1'").unwrap();
        push(&mut a, &base, &space);
        push(&mut b, &base, &space);
        pull(&mut a, &base, &space);
        pull(&mut b, &base, &space);
        for p in [&a, &b] {
            let (title, status, prio): (String, String, i64) = p.conn.query_row("SELECT title, status, priority FROM tasks WHERE id = 't1'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
            assert_eq!((title.as_str(), status.as_str(), prio), ("Write launch copy", "in_progress", 2));
            assert_eq!(pending_count(&p.conn), 0);
        }

        // Two people add objects to the same whiteboard: both survive.
        whiteboards::patch_scene(&a.conn, "w1", &ScenePatch { nodes: vec![wb("from-a", 0.0)], ..Default::default() }).unwrap();
        whiteboards::patch_scene(&b.conn, "w1", &ScenePatch { nodes: vec![wb("from-b", 300.0)], ..Default::default() }).unwrap();
        push(&mut a, &base, &space);
        push(&mut b, &base, &space);
        pull(&mut a, &base, &space);
        pull(&mut b, &base, &space);
        for p in [&a, &b] {
            assert_eq!(whiteboards::nodes(&p.conn, "w1").unwrap().len(), 2);
        }

        // A deletes the task while B edits it offline: deletion wins everywhere.
        a.conn.execute_batch("DELETE FROM tasks WHERE id = 't1'").unwrap();
        push(&mut a, &base, &space);
        b.conn.execute_batch("UPDATE tasks SET description = 'late edit' WHERE id = 't1'").unwrap();
        push(&mut b, &base, &space);
        pull(&mut b, &base, &space);
        assert!(text(&b.conn, "SELECT id FROM tasks WHERE id = 't1'").is_none());
        assert!(text(&b.conn, "SELECT task_id FROM task_labels WHERE task_id = 't1'").is_none(), "the label link went with the task");

        // A shared image: A uploads a compressed copy, the whiteboard object
        // references it, and B downloads the same bytes.
        let webp: Vec<u8> = [b"RIFF".as_slice(), &[30, 0, 0, 0], b"WEBPVP8 ", &[0u8; 18]].concat();
        let (up, _, _) = client::request_bytes(&base, &a.token, "POST", &format!("/spaces/{space}/assets?w=1&h=1"), Some((&webp, "image/webp"))).unwrap();
        let asset = client::check(Ok(up)).unwrap().body["id"].as_str().unwrap().to_string();
        let mut img = wb("img", 600.0);
        img.kind = "image".into();
        img.data = json!({ "src": "wb/x/photo.png", "cloudAsset": asset });
        whiteboards::patch_scene(&a.conn, "w1", &ScenePatch { nodes: vec![img], ..Default::default() }).unwrap();
        push(&mut a, &base, &space);
        pull(&mut b, &base, &space);
        let node = whiteboards::nodes(&b.conn, "w1").unwrap().into_iter().find(|n| n.id == "img").unwrap();
        let shared = node.data["cloudAsset"].as_str().unwrap().to_string();
        let (down, bytes, mime) = client::request_bytes(&base, &b.token, "GET", &format!("/spaces/{space}/assets/{shared}"), None).unwrap();
        assert_eq!((down.status, mime.as_deref(), bytes), (200, Some("image/webp"), webp));
        println!("ASSET={asset}");

        // A fresh device bootstraps the whole space.
        let mut c = peer(b.token.clone());
        pull(&mut c, &base, &space);
        assert_eq!(text(&c.conn, "SELECT name FROM projects WHERE id = 'p1'").as_deref(), Some("Launch"));
        assert_eq!(whiteboards::nodes(&c.conn, "w1").unwrap().len(), 3);
        assert!(text(&c.conn, "SELECT id FROM tasks WHERE id = 't1'").is_none());
    }
}
