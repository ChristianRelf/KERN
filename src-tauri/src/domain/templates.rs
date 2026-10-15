// @Author Christian Relf
// @Date 2026-10-15

//! Templates: reusable projects (boards, milestones, tasks with checklists,
//! notes), notes and tasks. A template is a JSON document; dates are stored
//! as day offsets from the template's start, so a project template keeps its
//! schedule when it's started on any day. Kern ships a few built-in
//! templates (ids starting with "builtin:"); saved ones sync with the space.

use crate::domain::boards::{self, ColumnTemplate};
use crate::domain::{labels, milestones, notes, projects, tasks};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms, valid_date};
use chrono::{Duration, Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::State;

pub const KINDS: &[&str] = &["project", "note", "task"];

// ------------------------------------------------------------ documents

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct BoardDoc {
    pub name: String,
    pub columns: Vec<ColumnTemplate>,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct MilestoneDoc {
    pub key: String,
    pub title: String,
    pub description: String,
    pub offset_days: Option<i64>,
    pub is_release: bool,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskDoc {
    pub title: String,
    pub description: String,
    pub status: Option<String>,
    pub priority: i64,
    /// Board (index into `boards`, default the first) and column name.
    pub board: Option<usize>,
    pub column: Option<String>,
    pub labels: Vec<String>,
    pub due_offset: Option<i64>,
    pub estimate_minutes: Option<i64>,
    /// Key of a milestone in the same template.
    pub milestone: Option<String>,
    pub recurrence: Option<Value>,
    pub subtasks: Vec<TaskDoc>,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteDoc {
    pub title: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectDoc {
    pub description: String,
    pub icon: Option<String>,
    pub accent: Option<String>,
    pub default_view: Option<String>,
    pub hidden_tabs: Vec<String>,
    /// The project's target date, as an offset from the start.
    pub target_offset: Option<i64>,
    pub boards: Vec<BoardDoc>,
    pub milestones: Vec<MilestoneDoc>,
    pub tasks: Vec<TaskDoc>,
    pub notes: Vec<NoteDoc>,
}

// ------------------------------------------------------------ records

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TemplateMeta {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub icon: Option<String>,
    pub builtin: bool,
    /// e.g. "12 tasks · 3 milestones · 1 note".
    pub summary: String,
    pub updated_at: i64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    #[serde(flatten)]
    pub meta: TemplateMeta,
    pub data: Value,
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn count_tasks(ts: &[TaskDoc]) -> usize {
    ts.iter().map(|t| 1 + count_tasks(&t.subtasks)).sum()
}

fn summary(kind: &str, data: &Value) -> String {
    match kind {
        "project" => {
            let d: ProjectDoc = serde_json::from_value(data.clone()).unwrap_or_default();
            let mut parts = vec![];
            if !d.tasks.is_empty() {
                parts.push(plural(count_tasks(&d.tasks), "task", "tasks"));
            }
            if !d.milestones.is_empty() {
                parts.push(plural(d.milestones.len(), "milestone", "milestones"));
            }
            if !d.notes.is_empty() {
                parts.push(plural(d.notes.len(), "note", "notes"));
            }
            if d.boards.len() > 1 {
                parts.push(plural(d.boards.len(), "board", "boards"));
            }
            if parts.is_empty() {
                "Board layout only".into()
            } else {
                parts.join(" · ")
            }
        }
        "task" => {
            let d: TaskDoc = serde_json::from_value(data.clone()).unwrap_or_default();
            if d.subtasks.is_empty() {
                "Single task".into()
            } else {
                format!("Checklist of {}", plural(count_tasks(&d.subtasks), "step", "steps"))
            }
        }
        _ => {
            let d: NoteDoc = serde_json::from_value(data.clone()).unwrap_or_default();
            let lines = d.content.lines().filter(|l| l.trim().starts_with('#')).count();
            if lines > 0 {
                plural(lines, "section", "sections")
            } else {
                "Note".into()
            }
        }
    }
}

fn check_kind(kind: &str) -> AppResult<()> {
    if KINDS.contains(&kind) {
        Ok(())
    } else {
        invalid(format!("Unknown template kind '{kind}'."))
    }
}

pub fn list(conn: &Connection, kind: Option<&str>) -> AppResult<Vec<TemplateMeta>> {
    let mut out: Vec<TemplateMeta> = Vec::new();
    let mut stmt = conn.prepare("SELECT id, kind, name, description, icon, data, updated_at FROM templates WHERE (?1 IS NULL OR kind = ?1) ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([kind], |r| {
        let kind: String = r.get(1)?;
        let data: String = r.get(5)?;
        let v: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        Ok(TemplateMeta { id: r.get(0)?, summary: summary(&kind, &v), kind, name: r.get(2)?, description: r.get(3)?, icon: r.get(4)?, builtin: false, updated_at: r.get(6)? })
    })?;
    for r in rows {
        out.push(r?);
    }
    for b in builtins() {
        if kind.map(|k| k == b.meta.kind).unwrap_or(true) {
            out.push(b.meta);
        }
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Template> {
    if id.starts_with("builtin:") {
        return builtins().into_iter().find(|b| b.meta.id == id).ok_or_else(|| AppError::NotFound("Template".into()));
    }
    conn.query_row("SELECT id, kind, name, description, icon, data, updated_at FROM templates WHERE id = ?1", [id], |r| {
        let kind: String = r.get(1)?;
        let data: String = r.get(5)?;
        let v: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        Ok(Template {
            meta: TemplateMeta { id: r.get(0)?, summary: summary(&kind, &v), kind, name: r.get(2)?, description: r.get(3)?, icon: r.get(4)?, builtin: false, updated_at: r.get(6)? },
            data: v,
        })
    })
    .optional()?
    .ok_or_else(|| AppError::NotFound("Template".into()))
}

pub fn insert(conn: &Connection, kind: &str, name: &str, description: &str, icon: Option<&str>, data: &Value) -> AppResult<Template> {
    check_kind(kind)?;
    let name = name.trim();
    if name.is_empty() {
        return invalid("Give the template a name.");
    }
    let id = new_id();
    let now = now_ms();
    conn.execute(
        "INSERT INTO templates(id, kind, name, description, icon, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, kind, name, description.trim(), icon, serde_json::to_string(data)?, now],
    )?;
    get(conn, &id)
}

// ------------------------------------------------------------ saving

fn date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

fn offset(d: Option<&str>, anchor: NaiveDate) -> Option<i64> {
    d.and_then(date).map(|d| (d - anchor).num_days())
}

struct ColumnNames {
    /// column id → (board index, column name)
    by_id: HashMap<String, (usize, String)>,
}

fn task_doc(conn: &Connection, t: &tasks::Task, anchor: NaiveDate, cols: &ColumnNames, milestone_keys: &HashMap<String, String>, label_names: &HashMap<String, String>, top: bool) -> AppResult<TaskDoc> {
    let subs = tasks::query_tasks(conn, &tasks::TaskQuery { parent_id: Some(t.id.clone()), include_completed: true, include_archived: false, order: Some("manual".into()), ..Default::default() })?;
    let placed = t.column_id.as_ref().and_then(|c| cols.by_id.get(c)).cloned();
    Ok(TaskDoc {
        title: t.title.clone(),
        description: t.description.clone(),
        status: if top && t.status != "completed" { Some(t.status.clone()) } else { None },
        priority: t.priority,
        board: placed.as_ref().map(|p| p.0).filter(|b| *b > 0),
        column: placed.map(|p| p.1),
        labels: t.label_ids.iter().filter_map(|l| label_names.get(l).cloned()).collect(),
        due_offset: offset(t.due_date.as_deref(), anchor),
        estimate_minutes: t.estimate_minutes,
        milestone: t.milestone_id.as_ref().and_then(|m| milestone_keys.get(m).cloned()),
        recurrence: if top { t.recurrence.clone() } else { None },
        subtasks: subs.iter().map(|s| task_doc(conn, s, anchor, cols, milestone_keys, label_names, false)).collect::<AppResult<_>>()?,
    })
}

fn label_names(conn: &Connection) -> AppResult<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT id, name FROM labels")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Captures a project's structure. Open tasks (with their checklists) and
/// notes are included on request; completed work never is.
pub fn project_doc(conn: &Connection, project_id: &str, include_tasks: bool, include_notes: bool) -> AppResult<ProjectDoc> {
    let p = projects::get_project(conn, project_id)?;
    // Boards, the default one first.
    let mut boards_list = boards::list_boards(conn, project_id)?;
    boards_list.sort_by_key(|b| !b.is_default);
    let mut cols = ColumnNames { by_id: HashMap::new() };
    let mut board_docs = vec![];
    for (i, b) in boards_list.iter().enumerate() {
        let columns = boards::list_columns(conn, &b.id)?;
        for c in &columns {
            cols.by_id.insert(c.id.clone(), (i, c.name.clone()));
        }
        board_docs.push(BoardDoc { name: b.name.clone(), columns: columns.into_iter().map(|c| ColumnTemplate { name: c.name, status: c.status }).collect() });
    }
    let ms = milestones::list(conn, project_id)?;
    let open_tasks = if include_tasks {
        tasks::query_tasks(conn, &tasks::TaskQuery { project_ids: Some(vec![project_id.into()]), top_level_only: true, order: Some("manual".into()), ..Default::default() })?
    } else {
        vec![]
    };
    // Dates count from the earliest date in the template (or today).
    let anchor = std::iter::once(p.target_date.clone())
        .chain(ms.iter().map(|m| m.target_date.clone()))
        .chain(open_tasks.iter().map(|t| t.due_date.clone()))
        .flatten()
        .filter_map(|d| date(&d))
        .min()
        .unwrap_or_else(|| Local::now().date_naive());
    let milestone_keys: HashMap<String, String> = ms.iter().enumerate().map(|(i, m)| (m.id.clone(), format!("m{}", i + 1))).collect();
    let names = label_names(conn)?;
    let task_docs = open_tasks.iter().map(|t| task_doc(conn, t, anchor, &cols, &milestone_keys, &names, true)).collect::<AppResult<Vec<_>>>()?;
    let note_docs = if include_notes {
        let mut stmt = conn.prepare("SELECT title, content FROM notes WHERE project_id = ?1 AND deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at")?;
        let rows = stmt.query_map([project_id], |r| Ok(NoteDoc { title: r.get(0)?, content: r.get(1)? }))?;
        rows.collect::<Result<Vec<_>, _>>()?
    } else {
        vec![]
    };
    Ok(ProjectDoc {
        description: p.description.clone(),
        icon: p.icon.clone(),
        accent: p.accent.clone(),
        default_view: p.default_view.clone(),
        hidden_tabs: serde_json::from_value(p.hidden_tabs.clone()).unwrap_or_default(),
        target_offset: offset(p.target_date.as_deref(), anchor),
        boards: board_docs,
        milestones: ms
            .iter()
            .filter(|m| m.status != "cancelled")
            .map(|m| MilestoneDoc { key: milestone_keys[&m.id].clone(), title: m.title.clone(), description: m.description.clone(), offset_days: offset(m.target_date.as_deref(), anchor), is_release: m.is_release })
            .collect(),
        tasks: task_docs,
        notes: note_docs,
    })
}

pub fn task_template_doc(conn: &Connection, task_id: &str) -> AppResult<TaskDoc> {
    let t = tasks::get_task(conn, task_id)?;
    let anchor = t.due_date.as_deref().and_then(date).unwrap_or_else(|| Local::now().date_naive());
    let names = label_names(conn)?;
    let mut d = task_doc(conn, &t, anchor, &ColumnNames { by_id: HashMap::new() }, &HashMap::new(), &names, true)?;
    // A task template is placed wherever it's used.
    d.due_offset = t.due_date.as_ref().map(|_| 0);
    d.milestone = None;
    Ok(d)
}

// ------------------------------------------------------------ using

fn shift(start: NaiveDate, days: Option<i64>) -> Option<String> {
    days.map(|d| (start + Duration::days(d)).format("%Y-%m-%d").to_string())
}

/// Fills `{{date}}`, `{{weekday}}`, `{{week}}` and `{{project}}` in note templates.
pub fn fill(text: &str, project: Option<&str>) -> String {
    let now = Local::now();
    text.replace("{{date}}", &now.format("%Y-%m-%d").to_string())
        .replace("{{weekday}}", &now.format("%A").to_string())
        .replace("{{week}}", &now.format("%G-W%V").to_string())
        .replace("{{project}}", project.unwrap_or(""))
}

/// Creates tasks (with their checklists); returns the new top-level ids.
fn create_tasks(conn: &Connection, docs: &[TaskDoc], ctx: &UseCtx, parent: Option<&str>) -> AppResult<Vec<String>> {
    let mut ids = vec![];
    for d in docs {
        if d.title.trim().is_empty() {
            continue;
        }
        let column_id = if parent.is_none() { d.column.as_ref().and_then(|c| ctx.columns.get(&(d.board.unwrap_or(0), c.to_lowercase())).cloned()) } else { None };
        let label_ids = d.labels.iter().filter(|l| !l.trim().is_empty()).map(|l| labels::ensure(conn, l, None)).collect::<AppResult<Vec<_>>>()?;
        let status = d.status.clone().filter(|s| tasks::STATUSES.contains(&s.as_str()) && s != "completed" && s != "inbox");
        let t = tasks::create_task(
            conn,
            &tasks::TaskInput {
                title: d.title.clone(),
                description: Some(d.description.clone()),
                status: status.or(Some("todo".into())),
                priority: Some(d.priority),
                project_id: ctx.project_id.clone(),
                column_id,
                parent_id: parent.map(String::from),
                due_date: shift(ctx.start, d.due_offset),
                estimate_minutes: d.estimate_minutes,
                recurrence: if parent.is_none() { d.recurrence.clone() } else { None },
                label_ids: Some(label_ids),
                milestone_id: if parent.is_none() { d.milestone.as_ref().and_then(|k| ctx.milestones.get(k).cloned()) } else { None },
                ..Default::default()
            },
        )?;
        create_tasks(conn, &d.subtasks, ctx, Some(&t.id))?;
        ids.push(t.id);
    }
    Ok(ids)
}

struct UseCtx {
    project_id: Option<String>,
    start: NaiveDate,
    /// (board index, lowercase column name) → column id
    columns: HashMap<(usize, String), String>,
    milestones: HashMap<String, String>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UseProject {
    pub name: String,
    pub start_date: Option<String>,
    pub group_id: Option<String>,
    pub include_tasks: Option<bool>,
    pub include_notes: Option<bool>,
}

fn start_of(s: Option<&str>) -> AppResult<NaiveDate> {
    match s {
        Some(d) if !valid_date(d) => invalid("The start date isn't valid."),
        Some(d) => Ok(date(d).unwrap()),
        None => Ok(Local::now().date_naive()),
    }
}

pub fn create_project_from(conn: &Connection, doc: &ProjectDoc, input: &UseProject) -> AppResult<projects::Project> {
    let start = start_of(input.start_date.as_deref())?;
    let p = projects::create_project(
        conn,
        &projects::ProjectInput {
            name: input.name.clone(),
            description: Some(doc.description.clone()),
            icon: doc.icon.clone(),
            accent: doc.accent.clone(),
            target_date: shift(start, doc.target_offset),
            group_id: input.group_id.clone(),
            default_view: doc.default_view.clone(),
            folder: None,
        },
    )?;
    if !doc.hidden_tabs.is_empty() {
        projects::update_project(conn, &p.id, &projects::ProjectPatch { hidden_tabs: Some(json!(doc.hidden_tabs)), ..Default::default() })?;
    }
    // The first board replaces the default one; the rest are added.
    let mut columns = HashMap::new();
    for (i, b) in doc.boards.iter().enumerate() {
        let board_id = if i == 0 {
            let id = p.default_board_id.clone().ok_or_else(|| AppError::Other("The new project has no board.".into()))?;
            if !b.columns.is_empty() {
                conn.execute("DELETE FROM board_columns WHERE board_id = ?1", [&id])?;
                let now = now_ms();
                for (j, c) in b.columns.iter().enumerate() {
                    conn.execute(
                        "INSERT INTO board_columns(id, board_id, name, sort_order, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                        params![new_id(), id, c.name, (j + 1) as f64, c.status, now],
                    )?;
                }
            }
            if !b.name.trim().is_empty() {
                conn.execute("UPDATE boards SET name = ?1 WHERE id = ?2", params![b.name.trim(), id])?;
            }
            id
        } else {
            let cols = if b.columns.is_empty() { boards::default_columns(conn) } else { b.columns.clone() };
            boards::create_board(conn, &p.id, if b.name.trim().is_empty() { "Board" } else { &b.name }, &cols)?.id
        };
        for c in boards::list_columns(conn, &board_id)? {
            columns.entry((i, c.name.to_lowercase())).or_insert(c.id);
        }
    }
    let mut ms = HashMap::new();
    for m in &doc.milestones {
        let created = milestones::create(
            conn,
            &milestones::MilestoneInput {
                project_id: p.id.clone(),
                title: m.title.clone(),
                description: Some(m.description.clone()),
                target_date: shift(start, m.offset_days),
                is_release: Some(m.is_release),
                ..Default::default()
            },
        )?;
        ms.insert(m.key.clone(), created.id);
    }
    let ctx = UseCtx { project_id: Some(p.id.clone()), start, columns, milestones: ms };
    if input.include_tasks.unwrap_or(true) {
        create_tasks(conn, &doc.tasks, &ctx, None)?;
    }
    if input.include_notes.unwrap_or(true) {
        for n in &doc.notes {
            notes::create_note(conn, &fill(&n.title, Some(&p.name)), &fill(&n.content, Some(&p.name)), Some(&p.id))?;
        }
    }
    projects::get_project(conn, &p.id)
}

pub fn create_task_from(conn: &Connection, doc: &TaskDoc, project_id: Option<String>, due_date: Option<String>) -> AppResult<tasks::Task> {
    let start = match due_date.as_deref() {
        Some(d) => start_of(Some(d))?,
        None => Local::now().date_naive(),
    };
    let mut d = doc.clone();
    if due_date.is_none() && doc.due_offset == Some(0) {
        d.due_offset = None;
    }
    if due_date.is_some() {
        d.due_offset = Some(0);
    }
    d.column = None;
    d.milestone = None;
    if d.title.trim().is_empty() {
        return invalid("This template has no title.");
    }
    let ctx = UseCtx { project_id, start, columns: HashMap::new(), milestones: HashMap::new() };
    let ids = create_tasks(conn, std::slice::from_ref(&d), &ctx, None)?;
    tasks::get_task(conn, &ids[0])
}

// ------------------------------------------------------------ built-ins

fn t(title: &str, due: Option<i64>) -> TaskDoc {
    TaskDoc { title: title.into(), due_offset: due, ..Default::default() }
}

fn checklist(title: &str, due: Option<i64>, steps: &[&str]) -> TaskDoc {
    TaskDoc { title: title.into(), due_offset: due, subtasks: steps.iter().map(|s| t(s, None)).collect(), ..Default::default() }
}

fn m(key: &str, title: &str, offset: i64) -> MilestoneDoc {
    MilestoneDoc { key: key.into(), title: title.into(), offset_days: Some(offset), ..Default::default() }
}

fn in_ms(mut d: TaskDoc, key: &str) -> TaskDoc {
    d.milestone = Some(key.into());
    d
}

fn builtin(id: &str, kind: &str, name: &str, description: &str, icon: &str, data: Value) -> Template {
    Template {
        meta: TemplateMeta { id: format!("builtin:{id}"), kind: kind.into(), summary: summary(kind, &data), name: name.into(), description: description.into(), icon: Some(icon.into()), builtin: true, updated_at: 0 },
        data,
    }
}

fn col(name: &str, status: Option<&str>) -> ColumnTemplate {
    ColumnTemplate { name: name.into(), status: status.map(String::from) }
}

pub fn builtins() -> Vec<Template> {
    let client = ProjectDoc {
        description: "Work for a client, from kickoff to the final invoice.".into(),
        icon: Some("briefcase".into()),
        target_offset: Some(30),
        milestones: vec![m("kickoff", "Kickoff", 0), m("draft", "First draft", 14), m("delivery", "Final delivery", 30)],
        tasks: vec![
            in_ms(checklist("Kickoff call", Some(0), &["Agree goals and scope", "Confirm budget and timeline", "Share the project brief"]), "kickoff"),
            in_ms(t("Collect requirements and assets", Some(2)), "kickoff"),
            in_ms(t("Send proposal and timeline", Some(4)), "kickoff"),
            in_ms(t("Prepare first draft", Some(14)), "draft"),
            in_ms(t("Client review", Some(18)), "draft"),
            in_ms(t("Make revisions", Some(24)), "delivery"),
            in_ms(checklist("Final delivery", Some(30), &["Final files exported", "Handover notes written", "Client sign-off"]), "delivery"),
            t("Send invoice", Some(31)),
        ],
        notes: vec![NoteDoc {
            title: "Project brief".into(),
            content: "## Client\n\n## Goals\n\n- \n\n## Scope\n\n**In:**\n\n**Out:**\n\n## Contacts\n\n## Budget and timeline\n".into(),
        }],
        ..Default::default()
    };
    let launch = ProjectDoc {
        description: "Plan and ship a launch: positioning, beta, launch day and follow-up.".into(),
        icon: Some("rocket".into()),
        target_offset: Some(28),
        milestones: vec![m("beta", "Beta", 14), MilestoneDoc { is_release: true, ..m("launch", "Launch", 28) }],
        tasks: vec![
            in_ms(t("Write positioning and key messages", Some(3)), "beta"),
            in_ms(t("Set pricing", Some(5)), "beta"),
            in_ms(checklist("Landing page", Some(10), &["Copy", "Screenshots", "Sign-up form", "Analytics"]), "beta"),
            in_ms(t("Invite beta users", Some(14)), "beta"),
            in_ms(t("Collect and triage beta feedback", Some(21)), "launch"),
            in_ms(t("Prepare launch post and press kit", Some(24)), "launch"),
            in_ms(checklist("Launch day", Some(28), &["Publish the launch post", "Email the list", "Post on social", "Watch support and fix issues"]), "launch"),
            t("Launch retrospective", Some(35)),
        ],
        notes: vec![NoteDoc { title: "Launch plan".into(), content: "## Audience\n\n## Message\n\n## Channels\n\n## Success looks like\n\n## Risks\n".into() }],
        ..Default::default()
    };
    let event = ProjectDoc {
        description: "Organise an event: venue, guests, suppliers and the day itself.".into(),
        icon: Some("party-popper".into()),
        target_offset: Some(42),
        milestones: vec![m("booked", "Venue booked", 7), m("invites", "Invitations sent", 14), m("day", "Event day", 42)],
        tasks: vec![
            t("Set the budget", Some(1)),
            in_ms(checklist("Book the venue", Some(7), &["Shortlist venues", "Visit", "Sign and pay deposit"]), "booked"),
            in_ms(t("Draft the guest list", Some(10)), "invites"),
            in_ms(t("Send invitations", Some(14)), "invites"),
            t("Book catering", Some(21)),
            t("Arrange equipment and decorations", Some(28)),
            t("Confirm numbers with suppliers", Some(38)),
            in_ms(checklist("Event day", Some(42), &["Set up", "Welcome guests", "Pack down"]), "day"),
            t("Send thank-yous", Some(44)),
        ],
        ..Default::default()
    };
    let bugs = ProjectDoc {
        description: "A board for incoming bugs: triage, confirm, fix and verify.".into(),
        icon: Some("bug".into()),
        boards: vec![BoardDoc {
            name: "Bugs".into(),
            columns: vec![col("Triage", None), col("Confirmed", Some("todo")), col("Fixing", Some("in_progress")), col("Waiting", Some("blocked")), col("Fixed", Some("completed"))],
        }],
        notes: vec![NoteDoc {
            title: "Triage guide".into(),
            content: "## Priority\n\n- **Urgent**: data loss, security, everyone blocked\n- **High**: a main feature is broken\n- **Medium**: broken with a workaround\n- **Low**: cosmetic\n\n## A good report has\n\n- [ ] Steps to reproduce\n- [ ] What was expected\n- [ ] What happened\n- [ ] Version and system\n".into(),
        }],
        ..Default::default()
    };
    let note = |id: &str, name: &str, desc: &str, icon: &str, title: &str, content: &str| builtin(id, "note", name, desc, icon, json!(NoteDoc { title: title.into(), content: content.into() }));
    vec![
        builtin("client", "project", "Client project", "Kickoff, drafts, revisions and delivery, with a project brief.", "briefcase", json!(client)),
        builtin("launch", "project", "Product launch", "Positioning, beta, launch day and a retrospective.", "rocket", json!(launch)),
        builtin("event", "project", "Event planning", "Budget, venue, invitations, suppliers and the day itself.", "party-popper", json!(event)),
        builtin("bugs", "project", "Bug tracker", "A triage board for bugs, with a triage guide.", "bug", json!(bugs)),
        note("meeting", "Meeting notes", "Attendees, agenda, decisions and actions.", "users", "Meeting {{date}}", "**Attendees:** \n\n## Agenda\n\n1. \n\n## Notes\n\n## Decisions\n\n- \n\n## Actions\n\n- [ ] \n"),
        note("weekly", "Weekly plan", "Priorities and a plan for each day.", "calendar-days", "Week {{week}}", "## This week's priorities\n\n1. \n2. \n3. \n\n## Monday\n\n## Tuesday\n\n## Wednesday\n\n## Thursday\n\n## Friday\n\n## Notes\n"),
        note("decision", "Decision record", "Context, options and the decision made.", "scale", "Decision: ", "**Date:** {{date}}\n**Status:** Proposed\n\n## Context\n\n## Options\n\n1. \n2. \n\n## Decision\n\n## Consequences\n"),
        note("one-on-one", "One-to-one", "Check-in, topics and follow-ups.", "messages-square", "1:1 {{date}}", "## How are things?\n\n## Topics\n\n- \n\n## Feedback\n\n## Follow-ups\n\n- [ ] \n"),
        note("retro", "Retrospective", "What went well, what didn't, what to change.", "rotate-ccw", "Retro {{date}}", "## What went well\n\n- \n\n## What didn't\n\n- \n\n## What we'll change\n\n- [ ] \n"),
        builtin("bugfix", "task", "Fix a bug", "Reproduce, test, fix and verify.", "bug", json!(checklist("Fix: ", None, &["Reproduce the problem", "Write a failing test", "Fix it", "Verify the fix", "Note it in the changelog"]))),
        builtin("article", "task", "Publish an article", "Draft to published, then shared.", "pen-line", json!(checklist("Publish: ", None, &["Outline", "First draft", "Edit", "Images", "Publish", "Share it"]))),
    ]
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub fn templates_list(state: State<AppState>, kind: Option<String>) -> AppResult<Vec<TemplateMeta>> {
    state.with(|c| list(c, kind.as_deref()))
}

#[tauri::command]
pub fn template_get(state: State<AppState>, id: String) -> AppResult<Template> {
    state.with(|c| get(c, &id))
}

#[tauri::command]
pub fn template_save_project(state: State<AppState>, project_id: String, name: String, description: Option<String>, include_tasks: bool, include_notes: bool) -> AppResult<Template> {
    state.with(|c| {
        let doc = project_doc(c, &project_id, include_tasks, include_notes)?;
        let icon = doc.icon.clone();
        insert(c, "project", &name, description.as_deref().unwrap_or(""), icon.as_deref(), &serde_json::to_value(&doc)?)
    })
}

#[tauri::command]
pub fn template_save_note(state: State<AppState>, note_id: String, name: String) -> AppResult<Template> {
    state.with(|c| {
        let n = notes::get_note(c, &note_id)?;
        insert(c, "note", &name, "", None, &json!(NoteDoc { title: n.title, content: n.content }))
    })
}

#[tauri::command]
pub fn template_save_task(state: State<AppState>, task_id: String, name: String) -> AppResult<Template> {
    state.with(|c| {
        let doc = task_template_doc(c, &task_id)?;
        insert(c, "task", &name, "", None, &serde_json::to_value(&doc)?)
    })
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TemplatePatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
}

#[tauri::command]
pub fn template_update(state: State<AppState>, id: String, patch: TemplatePatch) -> AppResult<Template> {
    if id.starts_with("builtin:") {
        return invalid("Built-in templates can't be changed. Use one, then save your version.");
    }
    state.with(|c| {
        let now = now_ms();
        if let Some(n) = &patch.name {
            if n.trim().is_empty() {
                return invalid("Give the template a name.");
            }
            c.execute("UPDATE templates SET name = ?1, updated_at = ?2 WHERE id = ?3", params![n.trim(), now, id])?;
        }
        if let Some(d) = &patch.description {
            c.execute("UPDATE templates SET description = ?1, updated_at = ?2 WHERE id = ?3", params![d.trim(), now, id])?;
        }
        if let Some(i) = &patch.icon {
            c.execute("UPDATE templates SET icon = ?1, updated_at = ?2 WHERE id = ?3", params![i, now, id])?;
        }
        get(c, &id)
    })
}

#[tauri::command]
pub fn template_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM templates WHERE id = ?1", [id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn template_use_project(state: State<AppState>, id: String, input: UseProject) -> AppResult<projects::Project> {
    state.with(|c| {
        let tpl = get(c, &id)?;
        if tpl.meta.kind != "project" {
            return invalid("That isn't a project template.");
        }
        let doc: ProjectDoc = serde_json::from_value(tpl.data)?;
        let tx = c.transaction()?;
        let p = create_project_from(&tx, &doc, &input)?;
        tx.commit()?;
        Ok(p)
    })
}

#[tauri::command]
pub fn template_use_note(state: State<AppState>, id: String, project_id: Option<String>) -> AppResult<notes::Note> {
    state.with(|c| {
        let tpl = get(c, &id)?;
        if tpl.meta.kind != "note" {
            return invalid("That isn't a note template.");
        }
        let doc: NoteDoc = serde_json::from_value(tpl.data)?;
        let project_name: Option<String> = match &project_id {
            Some(p) => c.query_row("SELECT name FROM projects WHERE id = ?1", [p], |r| r.get(0)).optional()?,
            None => None,
        };
        notes::create_note(c, &fill(&doc.title, project_name.as_deref()), &fill(&doc.content, project_name.as_deref()), project_id.as_deref())
    })
}

#[tauri::command]
pub fn template_use_task(state: State<AppState>, id: String, project_id: Option<String>, due_date: Option<String>) -> AppResult<tasks::Task> {
    state.with(|c| {
        let tpl = get(c, &id)?;
        if tpl.meta.kind != "task" {
            return invalid("That isn't a task template.");
        }
        let doc: TaskDoc = serde_json::from_value(tpl.data)?;
        let tx = c.transaction()?;
        let t = create_task_from(&tx, &doc, project_id, due_date)?;
        tx.commit()?;
        Ok(t)
    })
}

/// Writes a template to a `.kern-template.json` file to share.
#[tauri::command]
pub fn template_export(state: State<AppState>, id: String, path: String) -> AppResult<()> {
    let tpl = state.with(|c| get(c, &id))?;
    let doc = json!({ "kernTemplate": 1, "kind": tpl.meta.kind, "name": tpl.meta.name, "description": tpl.meta.description, "icon": tpl.meta.icon, "data": tpl.data });
    std::fs::write(path, serde_json::to_string_pretty(&doc)?)?;
    Ok(())
}

#[tauri::command]
pub fn template_import(state: State<AppState>, path: String) -> AppResult<Template> {
    let text = std::fs::read_to_string(&path)?;
    let v: Value = serde_json::from_str(&text).map_err(|_| AppError::Invalid("That file isn't a Kern template.".into()))?;
    if v.get("kernTemplate").is_none() {
        return invalid("That file isn't a Kern template.");
    }
    let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    check_kind(kind)?;
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    // Reject documents that don't parse as their kind.
    let ok = match kind {
        "project" => serde_json::from_value::<ProjectDoc>(data.clone()).is_ok(),
        "task" => serde_json::from_value::<TaskDoc>(data.clone()).is_ok(),
        _ => serde_json::from_value::<NoteDoc>(data.clone()).is_ok(),
    };
    if !ok {
        return invalid("That template file is damaged.");
    }
    state.with(|c| {
        insert(
            c,
            kind,
            v.get("name").and_then(|n| n.as_str()).unwrap_or("Imported template"),
            v.get("description").and_then(|n| n.as_str()).unwrap_or(""),
            v.get("icon").and_then(|n| n.as_str()),
            &data,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;

    #[test]
    fn builtins_are_valid_documents() {
        for b in builtins() {
            assert!(b.meta.builtin && b.meta.id.starts_with("builtin:"));
            match b.meta.kind.as_str() {
                "project" => assert!(serde_json::from_value::<ProjectDoc>(b.data.clone()).is_ok(), "{}", b.meta.name),
                "task" => assert!(serde_json::from_value::<TaskDoc>(b.data.clone()).is_ok()),
                _ => assert!(serde_json::from_value::<NoteDoc>(b.data.clone()).is_ok()),
            }
        }
    }

    #[test]
    fn project_round_trip_keeps_structure_and_relative_dates() {
        let c = open_memory();
        // Start a project from the built-in client template on a fixed day.
        let doc: ProjectDoc = serde_json::from_value(get(&c, "builtin:client").unwrap().data).unwrap();
        let p = create_project_from(&c, &doc, &UseProject { name: "Acme site".into(), start_date: Some("2030-03-01".into()), ..Default::default() }).unwrap();
        assert_eq!(p.target_date.as_deref(), Some("2030-03-31"));
        let all = tasks::query_tasks(&c, &tasks::TaskQuery { project_ids: Some(vec![p.id.clone()]), ..Default::default() }).unwrap();
        assert_eq!(all.len(), count_tasks(&doc.tasks));
        let kickoff = all.iter().find(|t| t.title == "Kickoff call").unwrap();
        assert_eq!(kickoff.due_date.as_deref(), Some("2030-03-01"));
        assert_eq!(kickoff.subtask_count, 3);
        assert!(kickoff.milestone_id.is_some());
        assert_eq!(milestones::list(&c, &p.id).unwrap().len(), 3);
        // Save it back and start it again a week later: everything shifts.
        let saved = project_doc(&c, &p.id, true, true).unwrap();
        assert_eq!(saved.tasks.len(), doc.tasks.len());
        assert_eq!(saved.notes.len(), 1);
        let q = create_project_from(&c, &saved, &UseProject { name: "Beta site".into(), start_date: Some("2030-03-08".into()), ..Default::default() }).unwrap();
        assert_eq!(q.target_date.as_deref(), Some("2030-04-07"));
        let invoice = tasks::query_tasks(&c, &tasks::TaskQuery { project_ids: Some(vec![q.id.clone()]), search: Some("invoice".into()), ..Default::default() }).unwrap();
        assert_eq!(invoice[0].due_date.as_deref(), Some("2030-04-08"));
    }

    #[test]
    fn custom_board_columns_place_tasks() {
        let c = open_memory();
        let doc = ProjectDoc {
            boards: vec![BoardDoc { name: "Flow".into(), columns: vec![col("Ideas", None), col("Doing", Some("in_progress"))] }],
            tasks: vec![TaskDoc { title: "Sketch".into(), column: Some("doing".into()), labels: vec!["Design".into()], ..Default::default() }],
            ..Default::default()
        };
        let p = create_project_from(&c, &doc, &UseProject { name: "Studio".into(), ..Default::default() }).unwrap();
        let t = &tasks::query_tasks(&c, &tasks::TaskQuery { project_ids: Some(vec![p.id.clone()]), ..Default::default() }).unwrap()[0];
        assert_eq!(t.status, "in_progress");
        assert!(t.column_id.is_some());
        assert_eq!(t.label_ids.len(), 1);
        let cols = boards::list_columns(&c, p.default_board_id.as_ref().unwrap()).unwrap();
        assert_eq!(cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["Ideas", "Doing"]);
    }

    #[test]
    fn task_templates_bring_their_checklist() {
        let c = open_memory();
        let doc: TaskDoc = serde_json::from_value(get(&c, "builtin:bugfix").unwrap().data).unwrap();
        let t = create_task_from(&c, &doc, None, Some("2030-01-02".into())).unwrap();
        assert_eq!((t.subtask_count, t.due_date.as_deref()), (5, Some("2030-01-02")));
        let saved = task_template_doc(&c, &t.id).unwrap();
        assert_eq!(saved.subtasks.len(), 5);
        assert!(fill("Week {{week}} {{project}}", Some("X")).ends_with(" X"));
    }
}
