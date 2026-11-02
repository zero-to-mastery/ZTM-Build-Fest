//! Repeating calendar events (#658, ADR 0022 §1): occurrence start dates in
//! the event's own local civil time.
//!
//! An occurrence keeps the event's start time of day and lasts as long as
//! the event, so nothing here needs a time zone: a 9:00 weekly event is at
//! 9:00 every week, across daylight saving time, and the browser turns it
//! into an instant when it draws it.
//!
//! The rule is a subset of RFC 5545 RRULE, expanded the RFC's way:
//! - the event's start is always the first occurrence, even when the rule
//!   wouldn't choose it, and it counts toward COUNT;
//! - DAILY steps `interval` days; WEEKLY takes the chosen weekdays in every
//!   `interval`-th week, weeks starting on the rule's week start (WKST);
//!   MONTHLY takes one day in every `interval`-th month; YEARLY one day of
//!   the start's month in every `interval`-th year;
//! - a month without the chosen day (the 31st, a 5th Tuesday, February 29)
//!   has no occurrence, rather than moving it to another day;
//! - UNTIL is the last civil date an occurrence may start on.
//!
//! Each period is computed directly from its index, so a rule without COUNT
//! skips straight to the window: the work is bounded by the window, not by
//! how long ago the event started. With COUNT (at most 1,000) the periods are
//! walked from the start, which is bounded by the count and by 9999-12-31.
use crate::calendar::{CalendarEvent, CalendarTime, Frequency, MonthlyBy, Rule, RuleEnd};
use crate::recurrence::{days_in_month, CivilDate};

/// The first day of the week holding `date`, weeks starting on `week_start`
/// (0 Monday … 6 Sunday). Near 0001-01-01 it stays at `date`.
fn week_start_of(date: CivilDate, week_start: u8) -> CivilDate {
    let back = (date.weekday() + 7 - u32::from(week_start)) % 7;
    date.checked_sub_days(back).unwrap_or(date)
}

/// Months since year 0 for (year, month).
fn month_index(date: CivilDate) -> u64 {
    u64::from(date.year()) * 12 + u64::from(date.month() - 1)
}

/// The day `by` picks in (year, month), if that month has it.
fn resolve(by: MonthlyBy, year: u32, month: u32) -> Option<CivilDate> {
    let last = days_in_month(year, month);
    match by {
        MonthlyBy::None => None,
        MonthlyBy::MonthDay(-1) => CivilDate::from_ymd(year, month, last),
        MonthlyBy::MonthDay(day) => {
            let day = u32::try_from(day).ok()?;
            (day <= last).then(|| CivilDate::from_ymd(year, month, day))?
        }
        MonthlyBy::NthWeekday { nth, weekday } => {
            let weekday = u32::from(weekday);
            if nth == -1 {
                let last_date = CivilDate::from_ymd(year, month, last)?;
                let back = (last_date.weekday() + 7 - weekday) % 7;
                CivilDate::from_ymd(year, month, last - back)
            } else {
                let first = CivilDate::from_ymd(year, month, 1)?;
                let first_match = 1 + (weekday + 7 - first.weekday()) % 7;
                let day = first_match + (u32::try_from(nth).ok()? - 1) * 7;
                (day <= last).then(|| CivilDate::from_ymd(year, month, day))?
            }
        }
    }
}

/// (year, month) of period `period` for a monthly or yearly rule.
fn period_month(rule: &Rule, start: CivilDate, period: u64) -> Option<(u32, u32)> {
    let step = u64::from(rule.interval).checked_mul(period)?;
    let index = match rule.frequency {
        Frequency::Monthly => month_index(start).checked_add(step)?,
        _ => month_index(start).checked_add(step.checked_mul(12)?)?,
    };
    let year = u32::try_from(index / 12).ok()?;
    (year <= 9999).then_some((year, (index % 12) as u32 + 1))
}

/// The earliest date period `period` can hold: every candidate of the
/// period is on or after it, and it grows with the period.
fn period_base(rule: &Rule, start: CivilDate, period: u64) -> Option<CivilDate> {
    let days = |unit: u64| -> Option<u32> {
        u32::try_from(
            u64::from(rule.interval)
                .checked_mul(period)?
                .checked_mul(unit)?,
        )
        .ok()
    };
    match rule.frequency {
        Frequency::Daily => start.checked_add_days(days(1)?),
        Frequency::Weekly => week_start_of(start, rule.week_start).checked_add_days(days(7)?),
        Frequency::Monthly | Frequency::Yearly => {
            let (year, month) = period_month(rule, start, period)?;
            CivilDate::from_ymd(year, month, 1)
        }
    }
}

/// The candidates of period `period`, ascending, into `out`.
fn candidates(rule: &Rule, start: CivilDate, period: u64, out: &mut Vec<CivilDate>) {
    out.clear();
    let Some(base) = period_base(rule, start, period) else {
        return;
    };
    match rule.frequency {
        Frequency::Daily => out.push(base),
        Frequency::Weekly => {
            for offset in 0..7 {
                if let Some(date) = base.checked_add_days(offset) {
                    if rule.weekdays & (1 << date.weekday()) != 0 {
                        out.push(date);
                    }
                }
            }
        }
        Frequency::Monthly | Frequency::Yearly => {
            if let Some(date) = resolve(rule.by, base.year(), base.month()) {
                out.push(date);
            }
        }
    }
}

/// The index of a period that starts on or before `date` and is no later
/// than the one holding it: where a rule without COUNT can start walking.
fn period_at(rule: &Rule, start: CivilDate, date: CivilDate) -> u64 {
    if date <= start {
        return 0;
    }
    let interval = u64::from(rule.interval);
    match rule.frequency {
        Frequency::Daily => u64::from(date.day_number() - start.day_number()) / interval,
        Frequency::Weekly => {
            let first = week_start_of(start, rule.week_start).day_number();
            let here = week_start_of(date, rule.week_start).day_number();
            u64::from(here.saturating_sub(first) / 7) / interval
        }
        Frequency::Monthly => (month_index(date) - month_index(start)) / interval,
        Frequency::Yearly => u64::from(date.year() - start.year()) / interval,
    }
}

/// Calls `visit` with each occurrence's start date in `low..=high`,
/// ascending, until it returns false.
pub fn for_each_start(
    event: &CalendarEvent,
    low: CivilDate,
    high: CivilDate,
    mut visit: impl FnMut(CivilDate) -> bool,
) {
    let start = event.start().date;
    if high < start || high < low {
        return;
    }
    if start >= low && !visit(start) {
        return;
    }
    let Some(rule) = event.rule else {
        return;
    };
    let (count, until) = match rule.end {
        RuleEnd::Never => (None, None),
        RuleEnd::Count(count) => (Some(u32::from(count)), None),
        RuleEnd::Until(until) => (None, Some(until)),
    };
    // The start was the first occurrence.
    let mut emitted = 1u32;
    let mut period = if count.is_none() {
        period_at(&rule, start, low)
    } else {
        0
    };
    let mut dates = Vec::with_capacity(7);
    loop {
        let Some(base) = period_base(&rule, start, period) else {
            return;
        };
        if base > high || until.is_some_and(|until| base > until) {
            return;
        }
        candidates(&rule, start, period, &mut dates);
        for &date in &dates {
            if date <= start {
                continue;
            }
            if until.is_some_and(|until| date > until)
                || count.is_some_and(|count| emitted >= count)
                || date > high
            {
                return;
            }
            emitted += 1;
            if date >= low && !visit(date) {
                return;
            }
        }
        period += 1;
    }
}

/// Whether `time` is the start of one of the event's occurrences.
pub fn is_occurrence(event: &CalendarEvent, time: CalendarTime) -> bool {
    if time.minute != event.start().minute {
        return false;
    }
    let mut found = false;
    for_each_start(event, time.date, time.date, |_| {
        found = true;
        false
    });
    found
}
