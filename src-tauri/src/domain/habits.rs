// @Author Christian Relf
// @Date 2026-10-15

//! Habits. A daily habit is due on chosen weekdays; a weekly one a number
//! of times each week. Checks record how many times it was done on a day.
//! Streaks count consecutive due days (or weeks) that met the target; the
//! current day or week only breaks a streak once it's over.

use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms, some, valid_date};
use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Habit {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub color: Option<String>,
    /// "daily" | "weekly"
    pub cadence: String,
    /// Times per day (daily) or per week (weekly).
    pub target: i64,
    /// ISO weekdays (1 = Monday) a daily habit is due on.
    pub weekdays: Vec<u32>,
    pub sort_order: f64,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    /// Checks in the requested range, by day.
    pub checks: HashMap<String, i64>,
    pub streak: i64,
    pub best_streak: i64,
    /// Done today (daily) or this week (weekly), and whether that meets the target.
    pub progress: i64,
    pub done: bool,
    /// Due today (daily habits off on this weekday aren't).
    pub due_today: bool,
    /// Share of due periods met in the last 30 days (0..=1).
    pub rate: f64,
}

fn date(s: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| AppError::Invalid(format!("'{s}' isn't a valid date.")))
}

fn fmt(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// Monday of the week containing `d`, or Sunday when weeks start on Sunday.
pub fn week_start(d: NaiveDate, week_starts_monday: bool) -> NaiveDate {
    let back = if week_starts_monday { d.weekday().num_days_from_monday() } else { d.weekday().num_days_from_sunday() };
    d - Duration::days(back as i64)
}

struct Raw {
    id: String,
    name: String,
    icon: Option<String>,
    color: Option<String>,
    cadence: String,
    target: i64,
    weekdays: Vec<u32>,
    sort_order: f64,
    archived_at: Option<i64>,
    created_at: i64,
}

fn all_checks(conn: &Connection, id: &str) -> AppResult<HashMap<NaiveDate, i64>> {
    let mut stmt = conn.prepare("SELECT day, count FROM habit_checks WHERE habit_id = ?1")?;
    let rows = stmt.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut out = HashMap::new();
    for r in rows {
        let (d, n) = r?;
        if let Ok(d) = NaiveDate::parse_from_str(&d, "%Y-%m-%d") {
            out.insert(d, n);
        }
    }
    Ok(out)
}

/// (current streak, best streak, rate over the last 30 days).
fn streaks(h: &Raw, checks: &HashMap<NaiveDate, i64>, today: NaiveDate, monday: bool) -> (i64, i64, f64) {
    let created = chrono::DateTime::from_timestamp_millis(h.created_at).map(|d| d.with_timezone(&chrono::Local).date_naive()).unwrap_or(today);
    let first_check = checks.keys().min().copied().unwrap_or(today);
    let start = created.min(first_check);
    let mut best = 0i64;
    let mut run = 0i64;
    let mut current = 0i64;
    let (mut due30, mut met30) = (0i64, 0i64);
    if h.cadence == "weekly" {
        let mut w = week_start(start, monday);
        let this_week = week_start(today, monday);
        while w <= this_week {
            let n: i64 = (0..7).map(|i| checks.get(&(w + Duration::days(i))).copied().unwrap_or(0)).sum();
            let met = n >= h.target;
            if w == this_week && !met {
                // Still in progress: doesn't break the streak yet.
            } else if met {
                run += 1;
            } else {
                run = 0;
            }
            best = best.max(run);
            if w + Duration::days(7) > today - Duration::days(30) && (w < this_week || met) {
                due30 += 1;
                met30 += met as i64;
            }
            w += Duration::days(7);
        }
        current = run;
    } else {
        let mut d = start;
        while d <= today {
            let due = h.weekdays.contains(&d.weekday().number_from_monday());
            if due {
                let met = checks.get(&d).copied().unwrap_or(0) >= h.target;
                if d == today && !met {
                    // Today isn't over yet.
                } else if met {
                    run += 1;
                } else {
                    run = 0;
                }
                best = best.max(run);
                if d > today - Duration::days(30) && (d < today || met) {
                    due30 += 1;
                    met30 += met as i64;
                }
            }
            d += Duration::days(1);
        }
        current = current.max(run);
    }
    (current, best, if due30 > 0 { met30 as f64 / due30 as f64 } else { 0.0 })
}

fn load(conn: &Connection, include_archived: bool) -> AppResult<Vec<Raw>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, icon, color, cadence, target, weekdays, sort_order, archived_at, created_at FROM habits
         WHERE (?1 = 1 OR archived_at IS NULL) ORDER BY archived_at IS NOT NULL, sort_order, created_at",
    )?;
    let rows = stmt.query_map([include_archived as i64], |r| {
        let wd: String = r.get(6)?;
        Ok(Raw {
            id: r.get(0)?,
            name: r.get(1)?,
            icon: r.get(2)?,
            color: r.get(3)?,
            cadence: r.get(4)?,
            target: r.get::<_, i64>(5)?.max(1),
            weekdays: serde_json::from_str(&wd).unwrap_or_else(|_| (1..=7).collect()),
            sort_order: r.get(7)?,
            archived_at: r.get(8)?,
            created_at: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn build(conn: &Connection, h: Raw, today: NaiveDate, from: NaiveDate, monday: bool) -> AppResult<Habit> {
    let checks = all_checks(conn, &h.id)?;
    let (streak, best, rate) = streaks(&h, &checks, today, monday);
    let progress = if h.cadence == "weekly" {
        let w = week_start(today, monday);
        (0..7).map(|i| checks.get(&(w + Duration::days(i))).copied().unwrap_or(0)).sum()
    } else {
        checks.get(&today).copied().unwrap_or(0)
    };
    let due_today = h.cadence == "weekly" || h.weekdays.contains(&today.weekday().number_from_monday());
    let in_range = checks.iter().filter(|(d, _)| **d >= from && **d <= today).map(|(d, n)| (fmt(*d), *n)).collect();
    Ok(Habit {
        done: progress >= h.target,
        id: h.id,
        name: h.name,
        icon: h.icon,
        color: h.color,
        cadence: h.cadence,
        target: h.target,
        weekdays: h.weekdays,
        sort_order: h.sort_order,
        archived_at: h.archived_at,
        created_at: h.created_at,
        checks: in_range,
        streak,
        best_streak: best,
        progress,
        due_today,
        rate,
    })
}

fn monday_first(conn: &Connection) -> bool {
    crate::domain::settings::get_or::<i64>(conn, "tasks.weekStart", 1) == 1
}

pub fn list(conn: &Connection, today: &str, days: i64, include_archived: bool) -> AppResult<Vec<Habit>> {
    let today = date(today)?;
    let from = today - Duration::days(days.clamp(1, 400) - 1);
    let monday = monday_first(conn);
    load(conn, include_archived)?.into_iter().map(|h| build(conn, h, today, from, monday)).collect()
}

fn get(conn: &Connection, id: &str, today: &str) -> AppResult<Habit> {
    let today_d = date(today)?;
    let monday = monday_first(conn);
    let raw = load(conn, true)?.into_iter().find(|h| h.id == id).ok_or_else(|| AppError::NotFound("Habit".into()))?;
    build(conn, raw, today_d, today_d - Duration::days(370), monday)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HabitInput {
    pub name: String,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub cadence: Option<String>,
    pub target: Option<i64>,
    pub weekdays: Option<Vec<u32>>,
}

fn check_fields(cadence: &str, target: i64, weekdays: &[u32]) -> AppResult<()> {
    if cadence != "daily" && cadence != "weekly" {
        return invalid("A habit is daily or weekly.");
    }
    if !(1..=50).contains(&target) {
        return invalid("The target must be between 1 and 50.");
    }
    if cadence == "daily" && (weekdays.is_empty() || weekdays.iter().any(|d| !(1..=7).contains(d))) {
        return invalid("Pick at least one day.");
    }
    Ok(())
}

pub fn create(conn: &Connection, input: &HabitInput, today: &str) -> AppResult<Habit> {
    let name = input.name.trim();
    if name.is_empty() {
        return invalid("Give the habit a name.");
    }
    let cadence = input.cadence.clone().unwrap_or_else(|| "daily".into());
    let target = input.target.unwrap_or(1);
    let mut weekdays = input.weekdays.clone().unwrap_or_else(|| (1..=7).collect());
    weekdays.sort();
    weekdays.dedup();
    check_fields(&cadence, target, &weekdays)?;
    let id = new_id();
    let now = now_ms();
    let sort: f64 = conn.query_row("SELECT coalesce(max(sort_order), 0) + 1 FROM habits", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO habits(id, name, icon, color, cadence, target, weekdays, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![id, name, input.icon, input.color, cadence, target, serde_json::to_string(&weekdays)?, sort, now],
    )?;
    get(conn, &id, today)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HabitPatch {
    pub name: Option<String>,
    #[serde(deserialize_with = "some")]
    pub icon: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub color: Option<Option<String>>,
    pub cadence: Option<String>,
    pub target: Option<i64>,
    pub weekdays: Option<Vec<u32>>,
    pub archived: Option<bool>,
}

pub fn update(conn: &Connection, id: &str, p: &HabitPatch, today: &str) -> AppResult<Habit> {
    let cur = get(conn, id, today)?;
    let name = match &p.name {
        Some(n) if n.trim().is_empty() => return invalid("Give the habit a name."),
        Some(n) => n.trim().to_string(),
        None => cur.name.clone(),
    };
    let cadence = p.cadence.clone().unwrap_or(cur.cadence.clone());
    let target = p.target.unwrap_or(cur.target);
    let mut weekdays = p.weekdays.clone().unwrap_or(cur.weekdays.clone());
    weekdays.sort();
    weekdays.dedup();
    check_fields(&cadence, target, &weekdays)?;
    let archived_at = match p.archived {
        Some(true) => Some(cur.archived_at.unwrap_or_else(now_ms)),
        Some(false) => None,
        None => cur.archived_at,
    };
    conn.execute(
        "UPDATE habits SET name = ?1, icon = ?2, color = ?3, cadence = ?4, target = ?5, weekdays = ?6, archived_at = ?7, updated_at = ?8 WHERE id = ?9",
        params![
            name,
            p.icon.clone().unwrap_or(cur.icon),
            p.color.clone().unwrap_or(cur.color),
            cadence,
            target,
            serde_json::to_string(&weekdays)?,
            archived_at,
            now_ms(),
            id
        ],
    )?;
    get(conn, id, today)
}

/// Adds `delta` to a day's count (never below zero; zero removes the check).
pub fn check(conn: &Connection, id: &str, day: &str, delta: i64, today: &str) -> AppResult<Habit> {
    if !valid_date(day) {
        return invalid("That isn't a valid day.");
    }
    if day > today {
        return invalid("You can't check off a day that hasn't happened yet.");
    }
    let exists: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM habits WHERE id = ?1)", [id], |r| r.get(0))?;
    if !exists {
        return Err(AppError::NotFound("Habit".into()));
    }
    let cur: i64 = conn.query_row("SELECT count FROM habit_checks WHERE habit_id = ?1 AND day = ?2", params![id, day], |r| r.get(0)).optional()?.unwrap_or(0);
    let next = (cur + delta).clamp(0, 99);
    if next == 0 {
        conn.execute("DELETE FROM habit_checks WHERE habit_id = ?1 AND day = ?2", params![id, day])?;
    } else {
        conn.execute(
            "INSERT INTO habit_checks(habit_id, day, count, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(habit_id, day) DO UPDATE SET count = excluded.count",
            params![id, day, next, now_ms()],
        )?;
    }
    conn.execute("UPDATE habits SET updated_at = ?1 WHERE id = ?2", params![now_ms(), id])?;
    get(conn, id, today)
}

// --------------------------------------------------------------- commands

#[tauri::command]
pub fn habits_list(state: State<AppState>, today: String, days: Option<i64>, include_archived: Option<bool>) -> AppResult<Vec<Habit>> {
    state.with(|c| list(c, &today, days.unwrap_or(35), include_archived.unwrap_or(false)))
}

#[tauri::command]
pub fn habit_create(state: State<AppState>, input: HabitInput, today: String) -> AppResult<Habit> {
    state.with(|c| create(c, &input, &today))
}

#[tauri::command]
pub fn habit_update(state: State<AppState>, id: String, patch: HabitPatch, today: String) -> AppResult<Habit> {
    state.with(|c| update(c, &id, &patch, &today))
}

#[tauri::command]
pub fn habit_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM habits WHERE id = ?1", [id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn habit_check(state: State<AppState>, id: String, day: String, delta: i64, today: String) -> AppResult<Habit> {
    state.with(|c| check(c, &id, &day, delta, &today))
}

#[tauri::command]
pub fn habits_reorder(state: State<AppState>, ids: Vec<String>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute("UPDATE habits SET sort_order = ?1 WHERE id = ?2", params![(i + 1) as f64, id])?;
        }
        tx.commit()?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;

    fn backdate(c: &Connection, id: &str, day: &str) {
        let ms = NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap().and_hms_opt(12, 0, 0).unwrap().and_local_timezone(chrono::Local).unwrap().timestamp_millis();
        c.execute("UPDATE habits SET created_at = ?1 WHERE id = ?2", params![ms, id]).unwrap();
    }

    #[test]
    fn daily_streak_skips_days_off_and_today_in_progress() {
        let c = open_memory();
        // Weekdays only. 2030-01-07 is a Monday.
        let h = create(&c, &HabitInput { name: "Run".into(), weekdays: Some(vec![1, 2, 3, 4, 5]), ..Default::default() }, "2030-01-07").unwrap();
        backdate(&c, &h.id, "2030-01-07");
        for d in ["2030-01-07", "2030-01-08", "2030-01-09", "2030-01-10", "2030-01-11", "2030-01-14"] {
            check(&c, &h.id, d, 1, "2030-01-14").unwrap();
        }
        // The weekend doesn't break it; Tuesday isn't over yet.
        let h = list(&c, "2030-01-15", 35, false).unwrap().remove(0);
        assert_eq!((h.streak, h.best_streak, h.done, h.due_today), (6, 6, false, true));
        // Missing Tuesday breaks it once Wednesday comes.
        let h = list(&c, "2030-01-16", 35, false).unwrap().remove(0);
        assert_eq!((h.streak, h.best_streak), (0, 6));
        assert!(h.rate > 0.8 && h.rate < 0.9);
        assert!(check(&c, &h.id, "2030-01-17", 1, "2030-01-16").is_err(), "no future checks");
    }

    #[test]
    fn weekly_targets_and_unchecking() {
        let c = open_memory();
        let h = create(&c, &HabitInput { name: "Gym".into(), cadence: Some("weekly".into()), target: Some(3), ..Default::default() }, "2030-01-07").unwrap();
        backdate(&c, &h.id, "2030-01-07");
        for d in ["2030-01-07", "2030-01-09", "2030-01-11"] {
            check(&c, &h.id, d, 1, "2030-01-13").unwrap();
        }
        let h = check(&c, &h.id, "2030-01-14", 1, "2030-01-15").unwrap();
        assert_eq!((h.streak, h.progress, h.done), (1, 1, false));
        let h = check(&c, &h.id, "2030-01-14", -1, "2030-01-15").unwrap();
        assert_eq!(h.progress, 0);
        assert!(h.checks.get("2030-01-14").is_none());
        let n: i64 = c.query_row("SELECT count(*) FROM habit_checks", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 3);
        assert!(create(&c, &HabitInput { name: "X".into(), weekdays: Some(vec![]), ..Default::default() }, "2030-01-07").is_err());
    }
}
