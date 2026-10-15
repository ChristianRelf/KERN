// @Author Christian Relf
// @Date 2026-10-15

//! Calendars: read-only subscriptions to ICS addresses (Google, Outlook,
//! iCloud, …) shown next to tasks, and exporting tasks as an ICS file.
//!
//! Subscribed events are fetched only when a subscription is added, when
//! asked, and every few hours while Kern runs (never with network access
//! turned off). Each refresh expands recurring events into occurrences from
//! a month back to a year ahead and stores them per computer. Times are
//! converted to this computer's local time using the calendar's own
//! VTIMEZONE definitions (or UTC); unknown zones are read as local time.

use crate::domain::{settings, tasks};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc, Weekday};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Manager, State};

const MAX_BYTES: u64 = 12 * 1024 * 1024;
const MAX_OCCURRENCES: usize = 1500;

// ------------------------------------------------------------ parsing

#[derive(Debug, Clone)]
struct Prop {
    name: String,
    params: HashMap<String, String>,
    value: String,
}

/// Unfolds continuation lines and splits each into name, parameters and value.
fn props(text: &str) -> Vec<Prop> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if (line.starts_with(' ') || line.starts_with('\t')) && !lines.is_empty() {
            lines.last_mut().unwrap().push_str(&line[1..]);
        } else if !line.is_empty() {
            lines.push(line.to_string());
        }
    }
    lines
        .into_iter()
        .filter_map(|l| {
            // The value starts at the first ':' outside a quoted parameter.
            let mut quoted = false;
            let mut split = None;
            for (i, ch) in l.char_indices() {
                match ch {
                    '"' => quoted = !quoted,
                    ':' if !quoted => {
                        split = Some(i);
                        break;
                    }
                    _ => {}
                }
            }
            let i = split?;
            let (head, value) = (&l[..i], &l[i + 1..]);
            let mut parts = head.split(';');
            let name = parts.next()?.trim().to_ascii_uppercase();
            let params = parts
                .filter_map(|p| {
                    let (k, v) = p.split_once('=')?;
                    Some((k.trim().to_ascii_uppercase(), v.trim().trim_matches('"').to_string()))
                })
                .collect();
            Some(Prop { name, params, value: value.to_string() })
        })
        .collect()
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(o) => out.push(o),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Where a wall-clock time is.
#[derive(Debug, Clone, PartialEq)]
enum Zone {
    Utc,
    Named(String),
    Floating,
}

#[derive(Debug, Clone, PartialEq)]
enum When {
    Date(NaiveDate),
    Time(NaiveDateTime, Zone),
}

fn parse_when(p: &Prop) -> Option<When> {
    let v = p.value.trim();
    let is_date = p.params.get("VALUE").map(|x| x.eq_ignore_ascii_case("DATE")).unwrap_or(false) || (v.len() == 8 && v.chars().all(|c| c.is_ascii_digit()));
    if is_date {
        return NaiveDate::parse_from_str(&v[..8.min(v.len())], "%Y%m%d").ok().map(When::Date);
    }
    let (body, utc) = match v.strip_suffix('Z') {
        Some(b) => (b, true),
        None => (v, false),
    };
    let dt = NaiveDateTime::parse_from_str(body, "%Y%m%dT%H%M%S").or_else(|_| NaiveDateTime::parse_from_str(body, "%Y%m%dT%H%M")).ok()?;
    let zone = if utc {
        Zone::Utc
    } else {
        match p.params.get("TZID") {
            Some(t) => Zone::Named(t.clone()),
            None => Zone::Floating,
        }
    };
    Some(When::Time(dt, zone))
}

/// ICS durations: P1D, PT1H30M, P1W, -PT15M.
fn parse_duration(s: &str) -> Option<Duration> {
    let s = s.trim();
    let (neg, s) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let s = s.strip_prefix('P')?;
    let mut total = Duration::zero();
    let mut num = String::new();
    let mut in_time = false;
    for ch in s.chars() {
        match ch {
            'T' => in_time = true,
            '0'..='9' => num.push(ch),
            u => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                total += match (u, in_time) {
                    ('W', _) => Duration::weeks(n),
                    ('D', _) => Duration::days(n),
                    ('H', true) => Duration::hours(n),
                    ('M', true) => Duration::minutes(n),
                    ('S', true) => Duration::seconds(n),
                    _ => return None,
                };
            }
        }
    }
    Some(if neg { -total } else { total })
}

// ------------------------------------------------------------ time zones

#[derive(Debug, Clone)]
struct TzRule {
    offset_to: i64,
    start: NaiveDateTime,
    /// Yearly transition: month and (ordinal, weekday), e.g. last Sunday of March.
    yearly: Option<(u32, i32, Weekday)>,
}

#[derive(Debug, Clone, Default)]
struct TzDef {
    rules: Vec<TzRule>,
}

fn parse_offset(s: &str) -> Option<i64> {
    let s = s.trim();
    let sign = if s.starts_with('-') { -1 } else { 1 };
    let d = s.trim_start_matches(['+', '-']);
    if d.len() < 4 {
        return None;
    }
    let h: i64 = d[0..2].parse().ok()?;
    let m: i64 = d[2..4].parse().ok()?;
    let sec: i64 = if d.len() >= 6 { d[4..6].parse().ok()? } else { 0 };
    Some(sign * (h * 3600 + m * 60 + sec))
}

fn weekday_of(s: &str) -> Option<Weekday> {
    Some(match s {
        "MO" => Weekday::Mon,
        "TU" => Weekday::Tue,
        "WE" => Weekday::Wed,
        "TH" => Weekday::Thu,
        "FR" => Weekday::Fri,
        "SA" => Weekday::Sat,
        "SU" => Weekday::Sun,
        _ => return None,
    })
}

/// "2MO" → (2, Monday); "-1SU" → (-1, Sunday); "TU" → (0, Tuesday).
fn parse_byday(s: &str) -> Option<(i32, Weekday)> {
    let s = s.trim();
    if s.len() < 2 {
        return None;
    }
    let (n, d) = s.split_at(s.len() - 2);
    Some((if n.is_empty() || n == "+" { 0 } else { n.parse().ok()? }, weekday_of(d)?))
}

/// The n-th (1-based, negative from the end) weekday of a month.
fn nth_weekday(year: i32, month: u32, n: i32, wd: Weekday) -> Option<NaiveDate> {
    if n > 0 {
        let first = NaiveDate::from_ymd_opt(year, month, 1)?;
        let shift = (7 + wd.num_days_from_monday() as i64 - first.weekday().num_days_from_monday() as i64) % 7;
        let d = first + Duration::days(shift + 7 * (n as i64 - 1));
        (d.month() == month).then_some(d)
    } else if n < 0 {
        let last = last_day(year, month)?;
        let shift = (7 + last.weekday().num_days_from_monday() as i64 - wd.num_days_from_monday() as i64) % 7;
        let d = last - Duration::days(shift + 7 * (-n as i64 - 1));
        (d.month() == month).then_some(d)
    } else {
        None
    }
}

fn last_day(year: i32, month: u32) -> Option<NaiveDate> {
    let (y, m) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(y, m, 1).map(|d| d - Duration::days(1))
}

impl TzDef {
    /// UTC offset (seconds) in effect at a wall-clock time.
    fn offset_at(&self, wall: NaiveDateTime) -> Option<i64> {
        let mut best: Option<(NaiveDateTime, i64)> = None;
        for r in &self.rules {
            let mut onsets = vec![r.start];
            if let Some((month, n, wd)) = r.yearly {
                for y in [wall.year() - 1, wall.year()] {
                    if y >= r.start.year() {
                        if let Some(d) = nth_weekday(y, month, n, wd) {
                            onsets.push(d.and_time(r.start.time()));
                        }
                    }
                }
            }
            for o in onsets {
                if o <= wall && best.map(|(b, _)| o > b).unwrap_or(true) {
                    best = Some((o, r.offset_to));
                }
            }
        }
        best.map(|(_, off)| off).or_else(|| self.rules.first().map(|r| r.offset_to))
    }
}

fn parse_tz(block: &[Prop]) -> (Option<String>, TzDef) {
    let mut id = None;
    let mut def = TzDef::default();
    let mut cur: Option<TzRule> = None;
    for p in block {
        match (p.name.as_str(), p.value.as_str()) {
            ("TZID", v) => id = Some(v.to_string()),
            ("BEGIN", "STANDARD") | ("BEGIN", "DAYLIGHT") => cur = Some(TzRule { offset_to: 0, start: NaiveDate::from_ymd_opt(1970, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap(), yearly: None }),
            ("END", "STANDARD") | ("END", "DAYLIGHT") => {
                if let Some(r) = cur.take() {
                    def.rules.push(r);
                }
            }
            ("TZOFFSETTO", v) => {
                if let (Some(r), Some(o)) = (cur.as_mut(), parse_offset(v)) {
                    r.offset_to = o;
                }
            }
            ("DTSTART", _) => {
                if let (Some(r), Some(When::Time(dt, _))) = (cur.as_mut(), parse_when(p)) {
                    r.start = dt;
                }
            }
            ("RRULE", v) => {
                if let Some(r) = cur.as_mut() {
                    let parts: HashMap<String, String> = v.split(';').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_ascii_uppercase(), v.to_string())).collect();
                    let month = parts.get("BYMONTH").and_then(|m| m.parse().ok());
                    let day = parts.get("BYDAY").and_then(|d| parse_byday(d.split(',').next().unwrap_or("")));
                    if let (Some(m), Some((n, wd))) = (month, day) {
                        r.yearly = Some((m, if n == 0 { 1 } else { n }, wd));
                    }
                }
            }
            _ => {}
        }
    }
    (id, def)
}

struct Zones(HashMap<String, TzDef>);

impl Zones {
    /// A wall-clock time in `zone` as this computer's local time.
    fn to_local(&self, wall: NaiveDateTime, zone: &Zone) -> NaiveDateTime {
        let utc = match zone {
            Zone::Floating => return wall,
            Zone::Utc => wall,
            Zone::Named(name) => match self.0.get(name).and_then(|d| d.offset_at(wall)) {
                Some(off) => wall - Duration::seconds(off),
                // Unknown zone (e.g. a Windows name without a definition): read as local.
                None => return wall,
            },
        };
        Utc.from_utc_datetime(&utc).with_timezone(&Local).naive_local()
    }
}

// ------------------------------------------------------------ events

#[derive(Debug, Clone, Default)]
struct RawEvent {
    uid: String,
    summary: String,
    location: Option<String>,
    start: Option<When>,
    end: Option<When>,
    duration: Option<Duration>,
    rrule: Option<String>,
    rdates: Vec<When>,
    exdates: Vec<When>,
    recurrence_id: Option<When>,
    cancelled: bool,
}

fn parse_events(text: &str) -> AppResult<(Vec<RawEvent>, Zones)> {
    let all = props(text);
    if !all.iter().any(|p| p.name == "BEGIN" && p.value.eq_ignore_ascii_case("VCALENDAR")) {
        return invalid("That address didn't return a calendar (ICS) file.");
    }
    let mut events = vec![];
    let mut zones = HashMap::new();
    let mut i = 0;
    while i < all.len() {
        let p = &all[i];
        if p.name == "BEGIN" && p.value.eq_ignore_ascii_case("VTIMEZONE") {
            let start = i;
            while i < all.len() && !(all[i].name == "END" && all[i].value.eq_ignore_ascii_case("VTIMEZONE")) {
                i += 1;
            }
            let (id, def) = parse_tz(&all[start..i.min(all.len())]);
            if let Some(id) = id {
                zones.insert(id, def);
            }
        } else if p.name == "BEGIN" && p.value.eq_ignore_ascii_case("VEVENT") {
            let mut e = RawEvent::default();
            let mut depth = 0;
            i += 1;
            while i < all.len() {
                let q = &all[i];
                if q.name == "BEGIN" {
                    depth += 1; // VALARM and friends
                } else if q.name == "END" {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                } else if depth == 0 {
                    match q.name.as_str() {
                        "UID" => e.uid = q.value.trim().to_string(),
                        "SUMMARY" => e.summary = unescape(&q.value),
                        "LOCATION" => e.location = Some(unescape(&q.value)).filter(|l| !l.trim().is_empty()),
                        "DTSTART" => e.start = parse_when(q),
                        "DTEND" => e.end = parse_when(q),
                        "DURATION" => e.duration = parse_duration(&q.value),
                        "RRULE" => e.rrule = Some(q.value.clone()),
                        "RDATE" | "EXDATE" => {
                            for v in q.value.split(',') {
                                if let Some(w) = parse_when(&Prop { value: v.to_string(), ..q.clone() }) {
                                    if q.name == "RDATE" {
                                        e.rdates.push(w);
                                    } else {
                                        e.exdates.push(w);
                                    }
                                }
                            }
                        }
                        "RECURRENCE-ID" => e.recurrence_id = parse_when(q),
                        "STATUS" => e.cancelled = q.value.trim().eq_ignore_ascii_case("CANCELLED"),
                        _ => {}
                    }
                }
                i += 1;
            }
            if e.start.is_some() {
                if e.uid.is_empty() {
                    e.uid = format!("{}-{:?}", e.summary, e.start);
                }
                events.push(e);
            }
        }
        i += 1;
    }
    Ok((events, Zones(zones)))
}

#[derive(Debug, Default)]
struct Rule {
    freq: String,
    interval: i64,
    count: Option<usize>,
    until: Option<When>,
    byday: Vec<(i32, Weekday)>,
    bymonthday: Vec<i32>,
    bymonth: Vec<u32>,
    bysetpos: Vec<i32>,
}

fn parse_rule(s: &str) -> Option<Rule> {
    let mut r = Rule { interval: 1, ..Default::default() };
    for part in s.split(';') {
        let (k, v) = part.split_once('=')?;
        match k.to_ascii_uppercase().as_str() {
            "FREQ" => r.freq = v.to_ascii_uppercase(),
            "INTERVAL" => r.interval = v.parse().ok().filter(|n: &i64| *n > 0).unwrap_or(1),
            "COUNT" => r.count = v.parse().ok(),
            "UNTIL" => r.until = parse_when(&Prop { name: "UNTIL".into(), params: HashMap::new(), value: v.to_string() }),
            "BYDAY" => r.byday = v.split(',').filter_map(parse_byday).collect(),
            "BYMONTHDAY" => r.bymonthday = v.split(',').filter_map(|d| d.parse().ok()).collect(),
            "BYMONTH" => r.bymonth = v.split(',').filter_map(|d| d.parse().ok()).collect(),
            "BYSETPOS" => r.bysetpos = v.split(',').filter_map(|d| d.parse().ok()).collect(),
            _ => {}
        }
    }
    matches!(r.freq.as_str(), "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY").then_some(r)
}

fn month_days(year: i32, month: u32, r: &Rule, start_day: u32) -> Vec<NaiveDate> {
    let mut out: Vec<NaiveDate> = vec![];
    let Some(last) = last_day(year, month) else { return out };
    if !r.bymonthday.is_empty() {
        for d in &r.bymonthday {
            let day = if *d > 0 { *d } else { last.day() as i32 + 1 + d };
            if day >= 1 && day <= last.day() as i32 {
                out.push(NaiveDate::from_ymd_opt(year, month, day as u32).unwrap());
            }
        }
    } else if !r.byday.is_empty() {
        for (n, wd) in &r.byday {
            if *n != 0 {
                out.extend(nth_weekday(year, month, *n, *wd));
            } else {
                let mut d = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
                while d.month() == month {
                    if d.weekday() == *wd {
                        out.push(d);
                    }
                    d += Duration::days(1);
                }
            }
        }
    } else if start_day <= last.day() {
        out.push(NaiveDate::from_ymd_opt(year, month, start_day).unwrap());
    }
    out.sort();
    out.dedup();
    if !r.bysetpos.is_empty() {
        let n = out.len() as i32;
        let picked: Vec<NaiveDate> = r.bysetpos.iter().filter_map(|p| {
            let i = if *p > 0 { p - 1 } else { n + p };
            (0..n).contains(&i).then(|| out[i as usize])
        }).collect();
        out = picked;
        out.sort();
    }
    out
}

/// Start days of a recurring event (in its own wall-clock time), from the
/// first occurrence until `until_day`, bounded. DTSTART is always the first
/// occurrence, even when it doesn't match the rule (RFC 5545).
fn expand_days(start: NaiveDate, r: &Rule, until_day: NaiveDate, until: Option<NaiveDate>) -> Vec<NaiveDate> {
    let mut out = expand_rule(start, r, until_day, until);
    if out.first() != Some(&start) {
        out.insert(0, start);
        if let Some(c) = r.count {
            out.truncate(c);
        }
    }
    out
}

fn expand_rule(start: NaiveDate, r: &Rule, until_day: NaiveDate, until: Option<NaiveDate>) -> Vec<NaiveDate> {
    let mut out = vec![];
    let stop = until.map(|u| u.min(until_day)).unwrap_or(until_day);
    let mut produced = 0usize;
    let push = |d: NaiveDate, out: &mut Vec<NaiveDate>, produced: &mut usize| -> bool {
        if d < start {
            return true;
        }
        if r.count.map(|c| *produced >= c).unwrap_or(false) || d > stop || out.len() >= MAX_OCCURRENCES {
            return false;
        }
        *produced += 1;
        out.push(d);
        true
    };
    for k in 0..5000i64 {
        let step = k * r.interval;
        let days: Vec<NaiveDate> = match r.freq.as_str() {
            "DAILY" => vec![start + Duration::days(step)],
            "WEEKLY" => {
                let week = start - Duration::days(start.weekday().num_days_from_monday() as i64) + Duration::weeks(step);
                let mut ds: Vec<NaiveDate> = if r.byday.is_empty() { vec![week + Duration::days(start.weekday().num_days_from_monday() as i64)] } else { r.byday.iter().map(|(_, wd)| week + Duration::days(wd.num_days_from_monday() as i64)).collect() };
                ds.sort();
                ds
            }
            "MONTHLY" => {
                let m0 = start.year() as i64 * 12 + start.month0() as i64 + step;
                month_days((m0 / 12) as i32, (m0 % 12) as u32 + 1, r, start.day())
            }
            _ => {
                let y = start.year() + step as i32;
                let months = if r.bymonth.is_empty() { vec![start.month()] } else { r.bymonth.clone() };
                let mut ds = vec![];
                for m in months {
                    ds.extend(month_days(y, m, r, start.day()));
                }
                ds.sort();
                ds
            }
        };
        let first = days.first().copied();
        for d in days {
            if !push(d, &mut out, &mut produced) {
                return out;
            }
        }
        if first.map(|f| f > stop).unwrap_or(false) {
            break;
        }
    }
    out
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub uid: String,
    /// 'YYYY-MM-DD' (all day) or 'YYYY-MM-DDTHH:MM', local time.
    pub start: String,
    /// Inclusive last day for all-day events; end time otherwise.
    pub end: String,
    pub all_day: bool,
    pub title: String,
    pub location: Option<String>,
}

fn fmt_day(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

fn fmt_time(t: NaiveDateTime) -> String {
    t.format("%Y-%m-%dT%H:%M").to_string()
}

/// Expands a calendar into local occurrences overlapping [from, to].
fn occurrences(text: &str, from: NaiveDate, to: NaiveDate) -> AppResult<Vec<Occurrence>> {
    let (events, zones) = parse_events(text)?;
    // Edited single occurrences replace the original one.
    let mut overridden: HashSet<(String, String)> = HashSet::new();
    for e in &events {
        if let Some(rid) = &e.recurrence_id {
            let key = match rid {
                When::Date(d) => fmt_day(*d),
                When::Time(t, z) => fmt_time(zones.to_local(*t, z)),
            };
            overridden.insert((e.uid.clone(), key));
        }
    }
    let mut out = vec![];
    for e in events {
        if e.cancelled {
            continue;
        }
        let Some(start) = e.start.clone() else { continue };
        let title = if e.summary.trim().is_empty() { "Busy".to_string() } else { e.summary.trim().to_string() };
        let master = e.recurrence_id.is_none();
        match start {
            When::Date(d0) => {
                let days_long = match (&e.end, e.duration) {
                    (Some(When::Date(e1)), _) => (*e1 - d0).num_days().max(1),
                    (_, Some(dur)) => dur.num_days().max(1),
                    _ => 1,
                };
                let ex: HashSet<NaiveDate> = e.exdates.iter().filter_map(|w| if let When::Date(d) = w { Some(*d) } else { None }).collect();
                let mut days = match e.rrule.as_deref().and_then(parse_rule).filter(|_| master) {
                    Some(r) => {
                        let until = match &r.until {
                            Some(When::Date(u)) => Some(*u),
                            Some(When::Time(t, _)) => Some(t.date()),
                            None => None,
                        };
                        expand_days(d0, &r, to, until)
                    }
                    None => vec![d0],
                };
                days.extend(e.rdates.iter().filter_map(|w| if let When::Date(d) = w { Some(*d) } else { None }));
                for d in days {
                    let last = d + Duration::days(days_long - 1);
                    if ex.contains(&d) || last < from || d > to || (master && overridden.contains(&(e.uid.clone(), fmt_day(d)))) {
                        continue;
                    }
                    out.push(Occurrence { uid: e.uid.clone(), start: fmt_day(d), end: fmt_day(last), all_day: true, title: title.clone(), location: e.location.clone() });
                }
            }
            When::Time(t0, zone) => {
                // Length from the end (in its own zone) or DURATION.
                let local_start0 = zones.to_local(t0, &zone);
                let length = match (&e.end, e.duration) {
                    (Some(When::Time(t1, z1)), _) => zones.to_local(*t1, z1) - local_start0,
                    (Some(When::Date(d1)), _) => d1.and_time(NaiveTime::MIN) - t0,
                    (_, Some(dur)) => dur,
                    _ => Duration::zero(),
                };
                let length = length.max(Duration::zero());
                let ex: HashSet<String> = e
                    .exdates
                    .iter()
                    .map(|w| match w {
                        When::Date(d) => fmt_day(*d),
                        When::Time(t, z) => fmt_time(zones.to_local(*t, z)),
                    })
                    .collect();
                let mut walls: Vec<NaiveDateTime> = match e.rrule.as_deref().and_then(parse_rule).filter(|_| master) {
                    Some(r) => {
                        let until = match &r.until {
                            Some(When::Date(u)) => Some(*u),
                            Some(When::Time(t, z)) => Some(zones.to_local(*t, z).date() + Duration::days(1)),
                            None => None,
                        };
                        let until_local = match &r.until {
                            Some(When::Time(t, z)) => Some(zones.to_local(*t, z)),
                            _ => None,
                        };
                        expand_days(t0.date(), &r, to + Duration::days(1), until)
                            .into_iter()
                            .map(|d| d.and_time(t0.time()))
                            .filter(|w| until_local.map(|u| zones.to_local(*w, &zone) <= u).unwrap_or(true))
                            .collect()
                    }
                    None => vec![t0],
                };
                walls.extend(e.rdates.iter().filter_map(|w| match w {
                    When::Time(t, _) => Some(*t),
                    When::Date(d) => Some(d.and_time(t0.time())),
                }));
                for w in walls {
                    let s = zones.to_local(w, &zone);
                    let end = s + length;
                    let key = fmt_time(s);
                    if ex.contains(&key) || ex.contains(&fmt_day(w.date())) || end.date() < from || s.date() > to || (master && overridden.contains(&(e.uid.clone(), key.clone()))) {
                        continue;
                    }
                    out.push(Occurrence { uid: e.uid.clone(), start: key, end: fmt_time(end), all_day: false, title: title.clone(), location: e.location.clone() });
                }
            }
        }
    }
    out.sort_by(|a, b| a.start.cmp(&b.start).then(a.title.cmp(&b.title)));
    out.dedup_by(|a, b| a.uid == b.uid && a.start == b.start);
    Ok(out)
}

// ------------------------------------------------------------ feeds

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    pub id: String,
    pub name: String,
    pub url: String,
    pub color: Option<String>,
    pub enabled: bool,
    pub last_fetched_at: Option<i64>,
    pub last_error: Option<String>,
    pub event_count: i64,
}

fn feeds(conn: &Connection) -> AppResult<Vec<Feed>> {
    let mut stmt = conn.prepare("SELECT id, name, url, color, enabled, last_fetched_at, last_error, event_count FROM calendar_feeds ORDER BY created_at")?;
    let rows = stmt.query_map([], |r| {
        Ok(Feed { id: r.get(0)?, name: r.get(1)?, url: r.get(2)?, color: r.get(3)?, enabled: r.get::<_, i64>(4)? != 0, last_fetched_at: r.get(5)?, last_error: r.get(6)?, event_count: r.get(7)? })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn feed(conn: &Connection, id: &str) -> AppResult<Feed> {
    feeds(conn)?.into_iter().find(|f| f.id == id).ok_or_else(|| AppError::NotFound("Calendar".into()))
}

/// webcal:// addresses are https; anything that isn't http(s) is refused.
pub fn normalize_url(raw: &str) -> AppResult<String> {
    let t = raw.trim();
    let t = if let Some(rest) = t.strip_prefix("webcal://").or_else(|| t.strip_prefix("webcals://")) { format!("https://{rest}") } else { t.to_string() };
    let u = url::Url::parse(&t).map_err(|_| AppError::Invalid("That isn't a valid calendar address.".into()))?;
    if u.scheme() != "https" && u.scheme() != "http" {
        return invalid("Calendar addresses start with https://, http:// or webcal://.");
    }
    Ok(u.to_string())
}

fn fetch(url: &str) -> AppResult<String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(30)))
        .http_status_as_error(false)
        .user_agent("Kern calendar")
        .build()
        .into();
    let mut resp = agent.get(url).call().map_err(|e| AppError::Network(format!("Couldn't reach the calendar ({e}).")))?;
    let status = resp.status().as_u16();
    match status {
        200..=299 => {}
        401 | 403 => return Err(AppError::Network("The calendar refused access. Check that the address is the secret or public ICS link.".into())),
        404 => return Err(AppError::Network("No calendar was found at that address.".into())),
        s => return Err(AppError::Network(format!("The calendar server answered {s}."))),
    }
    resp.body_mut().with_config().limit(MAX_BYTES).read_to_string().map_err(|_| AppError::Network("The calendar was too large or incomplete.".into()))
}

fn window() -> (NaiveDate, NaiveDate) {
    let today = Local::now().date_naive();
    (today - Duration::days(35), today + Duration::days(400))
}

fn store(conn: &mut Connection, feed_id: &str, occ: &[Occurrence]) -> AppResult<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM calendar_events WHERE feed_id = ?1", [feed_id])?;
    {
        let mut ins = tx.prepare("INSERT OR IGNORE INTO calendar_events(feed_id, uid, start, end, all_day, title, location) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")?;
        for o in occ {
            ins.execute(params![feed_id, o.uid, o.start, o.end, o.all_day as i64, o.title, o.location])?;
        }
    }
    tx.execute("UPDATE calendar_feeds SET last_fetched_at = ?1, last_error = NULL, event_count = ?2 WHERE id = ?3", params![now_ms(), occ.len() as i64, feed_id])?;
    tx.commit()?;
    Ok(())
}

/// Fetches and stores one subscription (network outside the database lock).
pub fn refresh_one(state: &AppState, id: &str) -> AppResult<Feed> {
    let url = state.with(|c| {
        if !settings::get_or(c, "privacy.network", true) {
            return invalid("Network access is turned off in Settings → Privacy, so calendars can't be refreshed.");
        }
        Ok(feed(c, id)?.url)
    })?;
    let (from, to) = window();
    let result = fetch(&url).and_then(|text| occurrences(&text, from, to));
    state.with(|c| {
        match &result {
            Ok(occ) => store(c, id, occ)?,
            Err(e) => {
                c.execute("UPDATE calendar_feeds SET last_fetched_at = ?1, last_error = ?2 WHERE id = ?3", params![now_ms(), e.to_string(), id])?;
            }
        }
        feed(c, id)
    })?;
    result.map(|_| ())?;
    state.with(|c| feed(c, id))
}

/// Background refresh of enabled subscriptions older than the interval.
pub fn refresh_due(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let due: Vec<String> = state
        .with(|c| {
            if !settings::get_or(c, "privacy.network", true) {
                return Ok(vec![]);
            }
            let minutes: i64 = settings::get_or(c, "calendar.refreshMinutes", 180).max(15);
            let cutoff = now_ms() - minutes * 60_000;
            Ok(feeds(c)?.into_iter().filter(|f| f.enabled && f.last_fetched_at.map(|t| t < cutoff).unwrap_or(true)).map(|f| f.id).collect())
        })
        .unwrap_or_default();
    let mut changed = false;
    for id in due {
        changed |= refresh_one(&state, &id).is_ok();
    }
    changed
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalEvent {
    pub feed_id: String,
    pub feed_name: String,
    pub color: Option<String>,
    pub uid: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub title: String,
    pub location: Option<String>,
}

pub fn events(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<CalEvent>> {
    // `start` sorts as text; an event overlaps when it starts before the
    // end of `to` and ends on or after `from`.
    let mut stmt = conn.prepare(
        "SELECT e.feed_id, f.name, f.color, e.uid, e.start, e.end, e.all_day, e.title, e.location FROM calendar_events e
         JOIN calendar_feeds f ON f.id = e.feed_id
         WHERE f.enabled = 1 AND e.start <= ?2 || 'T99' AND substr(e.end, 1, 10) >= ?1
         ORDER BY e.all_day DESC, e.start, e.title",
    )?;
    let rows = stmt.query_map(params![from, to], |r| {
        Ok(CalEvent { feed_id: r.get(0)?, feed_name: r.get(1)?, color: r.get(2)?, uid: r.get(3)?, start: r.get(4)?, end: r.get(5)?, all_day: r.get::<_, i64>(6)? != 0, title: r.get(7)?, location: r.get(8)? })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

// ------------------------------------------------------------ export

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    pub project_ids: Option<Vec<String>>,
    pub include_completed: bool,
    pub include_milestones: bool,
    /// Time-blocked tasks as timed events at their planned time.
    pub include_planned: bool,
}

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace(';', "\\;").replace(',', "\\,").replace('\n', "\\n").replace('\r', "")
}

/// Folds a content line at 75 octets (on character boundaries).
fn fold(line: &str) -> String {
    let mut out = String::new();
    let mut len = 0;
    for ch in line.chars() {
        let w = ch.len_utf8();
        if len + w > 75 {
            out.push_str("\r\n ");
            len = 1;
        }
        out.push(ch);
        len += w;
    }
    out.push_str("\r\n");
    out
}

fn compact(d: &str) -> String {
    d.replace(['-', ':'], "")
}

pub fn export_ics(conn: &Connection, o: &ExportOptions) -> AppResult<(String, usize)> {
    let q = tasks::TaskQuery { project_ids: o.project_ids.clone(), include_completed: o.include_completed, ..Default::default() };
    let all = tasks::query_tasks(conn, &q)?;
    let names: HashMap<String, String> = {
        let mut stmt = conn.prepare("SELECT id, name FROM projects")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let mut body = String::new();
    let mut n = 0;
    let mut event = |uid: &str, summary: &str, desc: &str, cat: Option<&str>, start: (String, bool), end: String| {
        body.push_str("BEGIN:VEVENT\r\n");
        body.push_str(&fold(&format!("UID:{uid}@kern")));
        body.push_str(&format!("DTSTAMP:{stamp}\r\n"));
        if start.1 {
            body.push_str(&format!("DTSTART;VALUE=DATE:{}\r\nDTEND;VALUE=DATE:{}\r\n", start.0, end));
        } else {
            body.push_str(&format!("DTSTART:{}\r\nDTEND:{}\r\n", start.0, end));
        }
        body.push_str(&fold(&format!("SUMMARY:{}", esc(summary))));
        if !desc.trim().is_empty() {
            body.push_str(&fold(&format!("DESCRIPTION:{}", esc(desc))));
        }
        if let Some(c) = cat {
            body.push_str(&fold(&format!("CATEGORIES:{}", esc(c))));
        }
        body.push_str("END:VEVENT\r\n");
        n += 1;
    };
    let next_day = |d: &str| NaiveDate::parse_from_str(d, "%Y-%m-%d").map(|d| compact(&fmt_day(d + Duration::days(1)))).unwrap_or_default();
    for t in &all {
        let project = t.project_id.as_ref().and_then(|p| names.get(p)).map(|s| s.as_str());
        let mut desc: String = t.description.chars().take(1000).collect();
        if t.status == "completed" {
            desc = format!("Completed.\n{desc}");
        }
        let title = if t.status == "completed" { format!("✓ {}", t.title) } else { t.title.clone() };
        if let Some(due) = &t.due_date {
            match &t.due_time {
                Some(time) => {
                    let s = NaiveDateTime::parse_from_str(&format!("{due}T{time}"), "%Y-%m-%dT%H:%M").ok();
                    if let Some(s) = s {
                        let e = s + Duration::minutes(t.estimate_minutes.unwrap_or(30).clamp(5, 24 * 60));
                        event(&t.id, &title, &desc, project, (s.format("%Y%m%dT%H%M%S").to_string(), false), e.format("%Y%m%dT%H%M%S").to_string());
                    }
                }
                None => event(&t.id, &title, &desc, project, (compact(due), true), next_day(due)),
            }
        }
        if o.include_planned {
            if let (Some(day), Some(time)) = (&t.plan_date, &t.plan_time) {
                if let Ok(s) = NaiveDateTime::parse_from_str(&format!("{day}T{time}"), "%Y-%m-%dT%H:%M") {
                    let e = s + Duration::minutes(t.estimate_minutes.unwrap_or(30).clamp(5, 24 * 60));
                    event(&format!("{}-plan", t.id), &format!("Planned: {}", t.title), &desc, project, (s.format("%Y%m%dT%H%M%S").to_string(), false), e.format("%Y%m%dT%H%M%S").to_string());
                }
            }
        }
    }
    if o.include_milestones {
        let mut stmt = conn.prepare("SELECT m.id, m.title, m.target_date, p.name, m.status FROM milestones m JOIN projects p ON p.id = m.project_id WHERE m.target_date IS NOT NULL AND p.deleted_at IS NULL AND m.status != 'cancelled'")?;
        let rows: Vec<(String, String, String, String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<Result<_, _>>()?;
        for (id, title, date, project, status) in rows {
            if let Some(ids) = &o.project_ids {
                let pid: Option<String> = conn.query_row("SELECT project_id FROM milestones WHERE id = ?1", [&id], |r| r.get(0)).optional()?;
                if !pid.map(|p| ids.contains(&p)).unwrap_or(false) {
                    continue;
                }
            }
            if status == "completed" && !o.include_completed {
                continue;
            }
            event(&id, &format!("◆ {title}"), &format!("Milestone in {project}"), Some(&project), (compact(&date), true), next_day(&date));
        }
    }
    let out = format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Kern//Tasks//EN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:Kern\r\n{body}END:VCALENDAR\r\n");
    Ok((out, n))
}

/// Keeps the "always up to date" export file current (set in Settings).
pub fn write_auto_export(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = state.with(|c| {
        let Some(path) = settings::get::<String>(c, "calendar.autoExportPath").filter(|p| !p.trim().is_empty()) else { return Ok(()) };
        let opts = ExportOptions { include_milestones: true, include_planned: true, ..Default::default() };
        let (text, _) = export_ics(c, &opts)?;
        std::fs::write(path, text)?;
        Ok(())
    });
}

// --------------------------------------------------------------- commands

async fn blocking<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&AppState) -> AppResult<T> + Send + 'static) -> AppResult<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>())).await.map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn calendar_feeds_list(state: State<AppState>) -> AppResult<Vec<Feed>> {
    state.with(|c| feeds(c))
}

#[tauri::command]
pub async fn calendar_feed_add(app: AppHandle, name: String, url: String, color: Option<String>) -> AppResult<Feed> {
    let url = normalize_url(&url)?;
    let name = if name.trim().is_empty() { "Calendar".to_string() } else { name.trim().to_string() };
    blocking(&app, move |s| {
        let id = new_id();
        s.with(|c| {
            let dup: bool = c.query_row("SELECT EXISTS (SELECT 1 FROM calendar_feeds WHERE url = ?1)", [&url], |r| r.get(0))?;
            if dup {
                return invalid("That calendar is already added.");
            }
            let now = now_ms();
            c.execute("INSERT INTO calendar_feeds(id, name, url, color, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)", params![id, name, url, color, now])?;
            Ok(())
        })?;
        // A first fetch shows straight away whether the address works.
        match refresh_one(s, &id) {
            Ok(f) => Ok(f),
            Err(e) => {
                s.with(|c| c.execute("DELETE FROM calendar_feeds WHERE id = ?1", [&id]).map_err(AppError::from))?;
                Err(e)
            }
        }
    })
    .await
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FeedPatch {
    pub name: Option<String>,
    pub color: Option<String>,
    pub enabled: Option<bool>,
}

#[tauri::command]
pub fn calendar_feed_update(state: State<AppState>, id: String, patch: FeedPatch) -> AppResult<Feed> {
    state.with(|c| {
        let now = now_ms();
        if let Some(n) = patch.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            c.execute("UPDATE calendar_feeds SET name = ?1, updated_at = ?2 WHERE id = ?3", params![n, now, id])?;
        }
        if let Some(col) = &patch.color {
            c.execute("UPDATE calendar_feeds SET color = ?1, updated_at = ?2 WHERE id = ?3", params![col, now, id])?;
        }
        if let Some(e) = patch.enabled {
            c.execute("UPDATE calendar_feeds SET enabled = ?1, updated_at = ?2 WHERE id = ?3", params![e as i64, now, id])?;
        }
        feed(c, &id)
    })
}

#[tauri::command]
pub fn calendar_feed_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM calendar_feeds WHERE id = ?1", [id])?;
        Ok(())
    })
}

/// Refreshes one subscription, or all enabled ones.
#[tauri::command]
pub async fn calendar_feed_refresh(app: AppHandle, id: Option<String>) -> AppResult<Vec<Feed>> {
    blocking(&app, move |s| {
        let ids: Vec<String> = match id {
            Some(i) => vec![i],
            None => s.with(|c| Ok(feeds(c)?.into_iter().filter(|f| f.enabled).map(|f| f.id).collect()))?,
        };
        let mut last_err = None;
        for i in &ids {
            if let Err(e) = refresh_one(s, i) {
                last_err = Some(e);
            }
        }
        if ids.len() == 1 {
            if let Some(e) = last_err {
                return Err(e);
            }
        }
        s.with(|c| feeds(c))
    })
    .await
}

#[tauri::command]
pub fn calendar_events(state: State<AppState>, from: String, to: String) -> AppResult<Vec<CalEvent>> {
    state.with(|c| events(c, &from, &to))
}

#[tauri::command]
pub fn calendar_export_ics(state: State<AppState>, path: String, options: ExportOptions) -> AppResult<usize> {
    let (text, n) = state.with(|c| export_ics(c, &options))?;
    std::fs::write(path, text)?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;

    const LONDON: &str = "BEGIN:VTIMEZONE\r\nTZID:Europe/London\r\nBEGIN:DAYLIGHT\r\nTZOFFSETFROM:+0000\r\nTZOFFSETTO:+0100\r\nDTSTART:19810329T010000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nEND:DAYLIGHT\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0000\r\nDTSTART:19961027T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n";

    fn cal(body: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{LONDON}{body}END:VCALENDAR\r\n")
    }

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn parses_folded_escaped_all_day_and_floating_events() {
        let text = cal("BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Team\\, offsite\r\n  day\r\nDTSTART;VALUE=DATE:20300610\r\nDTEND;VALUE=DATE:20300612\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Dentist\r\nLOCATION:High St\r\nDTSTART:20300611T093000\r\nDURATION:PT45M\r\nBEGIN:VALARM\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\n");
        let occ = occurrences(&text, d("2030-06-01"), d("2030-06-30")).unwrap();
        assert_eq!(occ.len(), 2);
        assert_eq!((occ[0].title.as_str(), occ[0].start.as_str(), occ[0].end.as_str(), occ[0].all_day), ("Team, offsite day", "2030-06-10", "2030-06-11", true));
        assert_eq!((occ[1].start.as_str(), occ[1].end.as_str(), occ[1].location.as_deref()), ("2030-06-11T09:30", "2030-06-11T10:15", Some("High St")));
    }

    #[test]
    fn expands_weekly_monthly_and_yearly_rules_with_exceptions() {
        let text = cal(
            "BEGIN:VEVENT\r\nUID:w\r\nSUMMARY:Standup\r\nDTSTART:20300107T090000\r\nDTEND:20300107T091500\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6\r\nEXDATE:20300109T090000\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:w\r\nRECURRENCE-ID:20300111T090000\r\nSUMMARY:Standup (moved)\r\nDTSTART:20300111T110000\r\nDTEND:20300111T111500\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:m\r\nSUMMARY:Review\r\nDTSTART;VALUE=DATE:20300131\r\nRRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20300430\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:p\r\nSUMMARY:Pay day\r\nDTSTART;VALUE=DATE:20300131\r\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:y\r\nSUMMARY:Birthday\r\nDTSTART;VALUE=DATE:20200229\r\nRRULE:FREQ=YEARLY\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Gone\r\nSTATUS:CANCELLED\r\nDTSTART:20300108T100000\r\nEND:VEVENT\r\n",
        );
        let occ = occurrences(&text, d("2030-01-01"), d("2032-12-31")).unwrap();
        let of = |uid: &str| occ.iter().filter(|o| o.uid == uid).map(|o| o.start.clone()).collect::<Vec<_>>();
        // Six standups counted from the start; Wednesday removed; Friday moved.
        assert_eq!(of("w"), vec!["2030-01-07T09:00", "2030-01-11T11:00", "2030-01-14T09:00", "2030-01-16T09:00", "2030-01-18T09:00"]);
        // DTSTART (a Thursday) is the first occurrence, then the last Fridays.
        assert_eq!(of("m"), vec!["2030-01-31", "2030-02-22", "2030-03-29", "2030-04-26"]);
        assert_eq!(of("p"), vec!["2030-01-31", "2030-02-28", "2030-03-29"]);
        // Feb 29 only exists in leap years.
        assert_eq!(of("y"), vec!["2032-02-29"]);
        assert!(of("x").is_empty());
    }

    #[test]
    fn converts_zoned_and_utc_times_to_local() {
        let text = cal("BEGIN:VEVENT\r\nUID:z\r\nSUMMARY:Call\r\nDTSTART;TZID=Europe/London:20300701T140000\r\nDTEND;TZID=Europe/London:20300701T150000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:u\r\nSUMMARY:Launch\r\nDTSTART:20300115T120000Z\r\nEND:VEVENT\r\n");
        let occ = occurrences(&text, d("2030-01-01"), d("2030-12-31")).unwrap();
        // London summer time is UTC+1: 14:00 BST = 13:00 UTC.
        let expect_summer = Utc.with_ymd_and_hms(2030, 7, 1, 13, 0, 0).unwrap().with_timezone(&Local).naive_local();
        let call = occ.iter().find(|o| o.uid == "z").unwrap();
        assert_eq!(call.start, fmt_time(expect_summer));
        assert_eq!(call.end, fmt_time(expect_summer + Duration::hours(1)));
        let launch = occ.iter().find(|o| o.uid == "u").unwrap();
        assert_eq!(launch.start, fmt_time(Utc.with_ymd_and_hms(2030, 1, 15, 12, 0, 0).unwrap().with_timezone(&Local).naive_local()));
        assert!(occurrences("not a calendar", d("2030-01-01"), d("2030-12-31")).is_err());
    }

    #[test]
    fn urls_are_normalised() {
        assert_eq!(normalize_url("webcal://example.com/cal.ics").unwrap(), "https://example.com/cal.ics");
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("nonsense").is_err());
    }

    #[test]
    fn exports_tasks_and_stores_events() {
        let mut c = open_memory();
        tasks::create_task(&c, &tasks::TaskInput { title: "Pay rent; today".into(), due_date: Some("2030-02-01".into()), ..Default::default() }).unwrap();
        tasks::create_task(&c, &tasks::TaskInput { title: "Call".into(), due_date: Some("2030-02-02".into()), due_time: Some("15:30".into()), estimate_minutes: Some(60), ..Default::default() }).unwrap();
        tasks::create_task(&c, &tasks::TaskInput { title: "Undated".into(), ..Default::default() }).unwrap();
        let (text, n) = export_ics(&c, &ExportOptions::default()).unwrap();
        assert_eq!(n, 2);
        assert!(text.contains("SUMMARY:Pay rent\\; today"));
        assert!(text.contains("DTSTART;VALUE=DATE:20300201\r\nDTEND;VALUE=DATE:20300202"));
        assert!(text.contains("DTSTART:20300202T153000\r\nDTEND:20300202T163000"));
        // The export reads back as the same events.
        let occ = occurrences(&text, d("2030-01-01"), d("2030-12-31")).unwrap();
        assert_eq!(occ.len(), 2);
        // Stored events are found by overlapping range.
        c.execute("INSERT INTO calendar_feeds(id, name, url, created_at, updated_at) VALUES ('f', 'Home', 'https://x', 1, 1)", []).unwrap();
        store(&mut c, "f", &occ).unwrap();
        assert_eq!(events(&c, "2030-02-02", "2030-02-02").unwrap().len(), 1);
        assert_eq!(events(&c, "2030-02-01", "2030-02-28").unwrap().len(), 2);
        assert_eq!(events(&c, "2030-03-01", "2030-03-31").unwrap().len(), 0);
    }
}
