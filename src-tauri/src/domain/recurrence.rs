//! Recurrence rules for repeating tasks.
//!
//! Model: a recurring series is a chain of task rows sharing `series_id`.
//! Only the *current* (open) occurrence carries the rule. Completing it
//! keeps the completed row as history and spawns the next occurrence,
//! so the series is never overwritten.
//!
//! Missed occurrences: the next occurrence is the first scheduled date after
//! the completed occurrence's date that is after today. Missed dates are
//! skipped, never back-filled, so finishing a task that was due last week
//! doesn't flood today with duplicates. With `fromCompletion`, the schedule
//! is anchored to the completion day instead (e.g. "every 3 days after done").

use chrono::{Datelike, Duration, Months, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recurrence {
    /// daily | weekdays | weekly | monthly | yearly
    pub freq: String,
    #[serde(default = "one")]
    pub interval: i64,
    /// For weekly rules: ISO weekdays 1 (Mon) .. 7 (Sun).
    #[serde(default)]
    pub weekdays: Vec<u32>,
    /// For monthly rules: preferred day of month (clamped to month length).
    #[serde(default)]
    pub day_of_month: Option<u32>,
    #[serde(default)]
    pub from_completion: bool,
}

fn one() -> i64 {
    1
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(28)
}

fn is_weekday(d: NaiveDate) -> bool {
    !matches!(d.weekday(), Weekday::Sat | Weekday::Sun)
}

impl Recurrence {
    pub fn validate(&self) -> Result<(), String> {
        match self.freq.as_str() {
            "daily" | "weekdays" | "weekly" | "monthly" | "yearly" => {}
            other => return Err(format!("Unknown repeat frequency '{other}'.")),
        }
        if self.interval < 1 || self.interval > 365 {
            return Err("Repeat interval must be between 1 and 365.".into());
        }
        if self.weekdays.iter().any(|d| *d < 1 || *d > 7) {
            return Err("Weekdays must be between 1 (Mon) and 7 (Sun).".into());
        }
        Ok(())
    }

    /// One step forward from `d` according to the rule.
    pub fn step(&self, d: NaiveDate) -> NaiveDate {
        let n = self.interval.max(1);
        match self.freq.as_str() {
            "daily" => d + Duration::days(n),
            "weekdays" => {
                let mut next = d + Duration::days(1);
                while !is_weekday(next) {
                    next += Duration::days(1);
                }
                next
            }
            "weekly" => {
                if self.weekdays.is_empty() {
                    return d + Duration::weeks(n);
                }
                let mut days: Vec<u32> = self.weekdays.clone();
                days.sort_unstable();
                days.dedup();
                let cur = d.weekday().number_from_monday();
                if let Some(next_day) = days.iter().find(|wd| **wd > cur) {
                    d + Duration::days((*next_day - cur) as i64)
                } else {
                    // Wrap to the first selected weekday of the week `n` weeks on.
                    let week_start = d - Duration::days((cur - 1) as i64);
                    week_start + Duration::weeks(n) + Duration::days((days[0] - 1) as i64)
                }
            }
            "monthly" => {
                let target = d.checked_add_months(Months::new(n as u32)).unwrap_or(d);
                match self.day_of_month {
                    Some(dom) => {
                        let day = dom.min(days_in_month(target.year(), target.month())).max(1);
                        NaiveDate::from_ymd_opt(target.year(), target.month(), day).unwrap_or(target)
                    }
                    None => target,
                }
            }
            "yearly" => d.checked_add_months(Months::new(12 * n as u32)).unwrap_or(d),
            _ => d + Duration::days(1),
        }
    }

    /// Next occurrence after completing an occurrence due `due` (or undated),
    /// completed on `today`.
    pub fn next_occurrence(&self, due: Option<NaiveDate>, today: NaiveDate) -> NaiveDate {
        let anchor = if self.from_completion { today } else { due.unwrap_or(today) };
        let mut next = self.step(anchor);
        let mut guard = 0;
        while next <= today && guard < 5000 {
            next = self.step(next);
            guard += 1;
        }
        // A weekday rule anchored on a weekend should land on a weekday.
        if self.freq == "weekdays" {
            while !is_weekday(next) {
                next += Duration::days(1);
            }
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }
    fn rule(freq: &str) -> Recurrence {
        Recurrence { freq: freq.into(), interval: 1, weekdays: vec![], day_of_month: None, from_completion: false }
    }

    #[test]
    fn daily_on_time() {
        assert_eq!(rule("daily").next_occurrence(Some(d("2026-03-10")), d("2026-03-10")), d("2026-03-11"));
    }

    #[test]
    fn daily_skips_missed() {
        // Due on the 1st, completed on the 10th: next is the 11th, not the 2nd.
        assert_eq!(rule("daily").next_occurrence(Some(d("2026-03-01")), d("2026-03-10")), d("2026-03-11"));
    }

    #[test]
    fn weekdays_skip_weekend() {
        // 2026-03-13 is a Friday.
        assert_eq!(rule("weekdays").next_occurrence(Some(d("2026-03-13")), d("2026-03-13")), d("2026-03-16"));
    }

    #[test]
    fn weekly_selected_days() {
        let mut r = rule("weekly");
        r.weekdays = vec![1, 4]; // Mon, Thu
        // 2026-03-10 is a Tuesday -> Thursday 12th.
        assert_eq!(r.next_occurrence(Some(d("2026-03-10")), d("2026-03-10")), d("2026-03-12"));
        // Thursday -> next Monday.
        assert_eq!(r.next_occurrence(Some(d("2026-03-12")), d("2026-03-12")), d("2026-03-16"));
    }

    #[test]
    fn biweekly_wraps_two_weeks() {
        let mut r = rule("weekly");
        r.interval = 2;
        r.weekdays = vec![1];
        assert_eq!(r.next_occurrence(Some(d("2026-03-09")), d("2026-03-09")), d("2026-03-23"));
    }

    #[test]
    fn monthly_keeps_day_of_month() {
        let mut r = rule("monthly");
        r.day_of_month = Some(31);
        assert_eq!(r.step(d("2026-01-31")), d("2026-02-28"));
        assert_eq!(r.step(d("2026-02-28")), d("2026-03-31"));
    }

    #[test]
    fn yearly_leap_day() {
        assert_eq!(rule("yearly").step(d("2028-02-29")), d("2029-02-28"));
    }

    #[test]
    fn from_completion_anchors_today() {
        let mut r = rule("daily");
        r.interval = 3;
        r.from_completion = true;
        assert_eq!(r.next_occurrence(Some(d("2026-03-01")), d("2026-03-10")), d("2026-03-13"));
    }
}
