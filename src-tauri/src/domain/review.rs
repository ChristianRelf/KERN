// @Author Christian Relf
// @Date 2026-10-15

//! The weekly review (what got done, what slipped, what's stale, what's
//! next) and estimate accuracy (how long tasks took against their
//! estimates). Everything is computed locally from existing data; the
//! review's own notes are kept as a "weekly" snapshot of its first day.

use crate::domain::{habits, milestones, sessions, tasks};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::util::now_ms;
use chrono::{Duration, NaiveDate, TimeZone};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EstimateRow {
    pub task_id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub estimate_minutes: i64,
    pub actual_minutes: i64,
    /// actual / estimate
    pub ratio: f64,
    pub completed_at: Option<i64>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EstimateStats {
    /// Completed tasks with both an estimate and tracked time.
    pub count: i64,
    pub total_estimate_minutes: i64,
    pub total_actual_minutes: i64,
    pub median_ratio: Option<f64>,
    /// Within 25% of the estimate.
    pub on_target: i64,
    pub over: i64,
    pub under: i64,
    /// Completed tasks with an estimate but no tracked time.
    pub untracked: i64,
    /// The furthest off, first.
    pub misses: Vec<EstimateRow>,
}

/// Estimate accuracy for tasks completed in [from, to) (epoch ms).
pub fn estimates(conn: &Connection, from: i64, to: i64, project_id: Option<&str>) -> AppResult<EstimateStats> {
    let mut stmt = conn.prepare(
        "SELECT id, title, project_id, estimate_minutes, tracked_seconds, completed_at FROM tasks
         WHERE deleted_at IS NULL AND status = 'completed' AND resolution IS NULL AND completed_at >= ?1 AND completed_at < ?2
           AND estimate_minutes > 0 AND (?3 IS NULL OR project_id = ?3)",
    )?;
    let rows: Vec<(String, String, Option<String>, i64, i64, Option<i64>)> =
        stmt.query_map(params![from, to, project_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?.collect::<Result<_, _>>()?;
    let mut s = EstimateStats::default();
    let mut list = vec![];
    for (id, title, project, est, tracked, completed_at) in rows {
        if tracked < 60 {
            s.untracked += 1;
            continue;
        }
        let actual = (tracked + 30) / 60;
        let ratio = tracked as f64 / 60.0 / est as f64;
        s.count += 1;
        s.total_estimate_minutes += est;
        s.total_actual_minutes += actual;
        if ratio > 1.25 {
            s.over += 1;
        } else if ratio < 0.75 {
            s.under += 1;
        } else {
            s.on_target += 1;
        }
        list.push(EstimateRow { task_id: id, title, project_id: project, estimate_minutes: est, actual_minutes: actual, ratio, completed_at });
    }
    let mut ratios: Vec<f64> = list.iter().map(|r| r.ratio).collect();
    ratios.sort_by(|a, b| a.partial_cmp(b).unwrap());
    s.median_ratio = match ratios.len() {
        0 => None,
        n if n % 2 == 1 => Some(ratios[n / 2]),
        n => Some((ratios[n / 2 - 1] + ratios[n / 2]) / 2.0),
    };
    // How far off, either way (2× over and 2× under are equally far).
    list.sort_by(|a, b| b.ratio.ln().abs().partial_cmp(&a.ratio.ln().abs()).unwrap());
    list.truncate(12);
    s.misses = list;
    Ok(s)
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntry {
    pub id: String,
    pub content: String,
    pub created_at: i64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HabitWeek {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub met: i64,
    pub due: i64,
    pub streak: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WeekReview {
    pub week_start: String,
    pub week_end: String,
    pub completed: Vec<tasks::Task>,
    pub cancelled: i64,
    pub created: i64,
    /// Open tasks that were due this week and the day has passed.
    pub slipped: Vec<tasks::Task>,
    /// Open tasks overdue from before this week.
    pub older_overdue: i64,
    /// Open tasks untouched for 30 days.
    pub stale: Vec<tasks::Task>,
    pub inbox_items: Vec<InboxEntry>,
    pub inbox_tasks: Vec<tasks::Task>,
    pub next_week: Vec<tasks::Task>,
    pub milestones: Vec<milestones::Milestone>,
    pub tracked_ms: i64,
    pub by_project: Vec<sessions::Bucket>,
    pub by_day: Vec<sessions::Bucket>,
    pub focus_minutes: i64,
    pub habits: Vec<HabitWeek>,
    pub estimates: EstimateStats,
}

fn date(s: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| AppError::Invalid(format!("'{s}' isn't a valid date.")))
}

fn day_start_ms(d: NaiveDate) -> i64 {
    chrono::Local.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap()).earliest().map(|t| t.timestamp_millis()).unwrap_or(0)
}

fn fmt(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

pub fn week(conn: &Connection, week_start: &str, today: &str, tz_offset_minutes: i64) -> AppResult<WeekReview> {
    let start = date(week_start)?;
    let end = start + Duration::days(6);
    let today_d = date(today)?;
    let (from, to) = (day_start_ms(start), day_start_ms(end + Duration::days(1)));
    let top = |q: tasks::TaskQuery| tasks::query_tasks(conn, &tasks::TaskQuery { top_level_only: true, ..q });
    let completed: Vec<tasks::Task> = top(tasks::TaskQuery { completed_from: Some(from), completed_to: Some(to), order: Some("completed".into()), ..Default::default() })?
        .into_iter()
        .filter(|t| t.resolution.is_none())
        .collect();
    let cancelled: i64 = conn.query_row(
        "SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND parent_id IS NULL AND status = 'completed' AND resolution IS NOT NULL AND completed_at >= ?1 AND completed_at < ?2",
        params![from, to],
        |r| r.get(0),
    )?;
    let created: i64 = conn.query_row("SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND parent_id IS NULL AND created_at >= ?1 AND created_at < ?2", params![from, to], |r| r.get(0))?;
    // The days of this week that are over.
    let passed_until = today_d.min(end + Duration::days(1));
    let slipped = if passed_until > start {
        top(tasks::TaskQuery { due_from: Some(fmt(start)), due_to: Some(fmt(passed_until - Duration::days(1))), order: Some("due".into()), ..Default::default() })?
    } else {
        vec![]
    };
    let older_overdue: i64 = conn.query_row(
        "SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL AND parent_id IS NULL AND status != 'completed' AND due_date < ?1",
        [fmt(start)],
        |r| r.get(0),
    )?;
    let stale_cutoff = now_ms() - 30 * 86_400_000;
    let stale: Vec<tasks::Task> = top(tasks::TaskQuery { order: Some("updated".into()), ..Default::default() })?
        .into_iter()
        .filter(|t| t.updated_at < stale_cutoff && t.recurrence.is_none() && t.status != "inbox" && t.due_date.as_deref().map(|d| d >= today).unwrap_or(true))
        .rev()
        .take(15)
        .collect();
    let inbox_items: Vec<InboxEntry> = {
        let mut stmt = conn.prepare("SELECT id, content, created_at FROM inbox_items ORDER BY created_at LIMIT 50")?;
        let rows = stmt.query_map([], |r| Ok(InboxEntry { id: r.get(0)?, content: r.get(1)?, created_at: r.get(2)? }))?;
        rows.collect::<Result<_, _>>()?
    };
    let inbox_tasks = top(tasks::TaskQuery { statuses: Some(vec!["inbox".into()]), order: Some("created".into()), limit: Some(50), ..Default::default() })?;
    let next_start = today_d.max(end + Duration::days(1));
    let next_week = top(tasks::TaskQuery { due_from: Some(fmt(next_start)), due_to: Some(fmt(next_start + Duration::days(6))), order: Some("due".into()), ..Default::default() })?;
    let ms = milestones::upcoming(conn, &fmt(next_start + Duration::days(13)), 10)?;
    let report = sessions::report(conn, from, to, tz_offset_minutes, None)?;
    let focus_seconds: i64 = conn.query_row("SELECT coalesce(sum(actual_seconds), 0) FROM focus_sessions WHERE kind = 'focus' AND started_at >= ?1 AND started_at < ?2", params![from, to], |r| r.get(0))?;
    let habit_list = habits::list(conn, &fmt(today_d.min(end)), 7, false)?;
    let habit_weeks = habit_list
        .into_iter()
        .map(|h| {
            let days: Vec<NaiveDate> = (0..7).map(|i| start + Duration::days(i)).filter(|d| *d <= today_d).collect();
            let (met, due) = if h.cadence == "weekly" {
                let n: i64 = days.iter().map(|d| h.checks.get(&fmt(*d)).copied().unwrap_or(0)).sum();
                ((n >= h.target) as i64, 1)
            } else {
                let due: Vec<&NaiveDate> = days.iter().filter(|d| h.weekdays.contains(&chrono::Datelike::weekday(*d).number_from_monday())).collect();
                (due.iter().filter(|d| h.checks.get(&fmt(***d)).copied().unwrap_or(0) >= h.target).count() as i64, due.len() as i64)
            };
            HabitWeek { id: h.id, name: h.name, icon: h.icon, met, due, streak: h.streak }
        })
        .collect();
    Ok(WeekReview {
        week_start: fmt(start),
        week_end: fmt(end),
        completed,
        cancelled,
        created,
        slipped,
        older_overdue,
        stale,
        inbox_items,
        inbox_tasks,
        next_week,
        milestones: ms,
        tracked_ms: report.total_ms,
        by_project: report.by_project,
        by_day: report.by_day,
        focus_minutes: focus_seconds / 60,
        habits: habit_weeks,
        estimates: estimates(conn, from, to, None)?,
    })
}

#[tauri::command]
pub fn weekly_review(state: State<AppState>, week_start: String, today: String, tz_offset_minutes: i64) -> AppResult<WeekReview> {
    state.with(|c| week(c, &week_start, &today, tz_offset_minutes))
}

#[tauri::command]
pub fn estimate_accuracy(state: State<AppState>, from: i64, to: i64, project_id: Option<String>) -> AppResult<EstimateStats> {
    state.with(|c| estimates(c, from, to, project_id.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::tasks::{create_task, update_task, TaskInput, TaskPatch};

    #[test]
    fn estimate_accuracy_compares_tracked_time() {
        let c = open_memory();
        let mk = |title: &str, est: i64, tracked: i64| {
            let t = create_task(&c, &TaskInput { title: title.into(), estimate_minutes: Some(est), ..Default::default() }).unwrap();
            update_task(&c, &t.id, &TaskPatch { add_tracked_seconds: Some(tracked), status: Some("completed".into()), ..Default::default() }).unwrap();
        };
        mk("On time", 60, 3600);
        mk("Twice as long", 30, 3600);
        mk("Quick", 120, 1800);
        mk("Not tracked", 60, 0);
        let s = estimates(&c, 0, now_ms() + 1000, None).unwrap();
        assert_eq!((s.count, s.on_target, s.over, s.under, s.untracked), (3, 1, 1, 1, 1));
        assert_eq!((s.total_estimate_minutes, s.total_actual_minutes), (210, 150));
        assert_eq!(s.median_ratio, Some(1.0));
        // 4× under and 2× over: the bigger miss first.
        assert_eq!(s.misses[0].title, "Quick");
    }

    #[test]
    fn weekly_review_finds_slipped_and_upcoming_work() {
        let c = open_memory();
        create_task(&c, &TaskInput { title: "Missed".into(), due_date: Some("2030-01-08".into()), ..Default::default() }).unwrap();
        create_task(&c, &TaskInput { title: "Later this week".into(), due_date: Some("2030-01-12".into()), ..Default::default() }).unwrap();
        create_task(&c, &TaskInput { title: "Next week".into(), due_date: Some("2030-01-15".into()), ..Default::default() }).unwrap();
        create_task(&c, &TaskInput { title: "Unsorted".into(), status: Some("inbox".into()), ..Default::default() }).unwrap();
        let r = week(&c, "2030-01-07", "2030-01-10", 0).unwrap();
        assert_eq!(r.slipped.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), vec!["Missed"]);
        assert_eq!(r.next_week.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), vec!["Next week"]);
        assert_eq!(r.inbox_tasks.len(), 1);
        assert_eq!(r.week_end, "2030-01-13");
    }
}
