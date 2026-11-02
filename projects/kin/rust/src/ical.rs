//! iCalendar import (#666, epic #651, ADR 0022 §3): an RFC 5545 subset,
//! parsed natively, enough for Google, Apple and Outlook exports.
//!
//! `kin_ical_parse` takes a `.ics` file's bytes (at most 2 MB) and returns
//! KICS: one record per event, each carrying a canonical kind-71 payload
//! (calendar.rs) with a zero event ID for the host to fill. The host saves
//! each as `CALENDAR_EVENT_SAVED`, finding an earlier import of the same
//! source UID through KCAL ("all events") so re-importing updates rather
//! than duplicates; a calendar subscription reuses the same parse on its
//! device cache. The file never leaves the device and nothing here touches
//! household state.
//!
//! **What is read.** VCALENDAR (X-WR-CALNAME as the calendar's name) and the
//! VEVENTs in it; every other component (VTIMEZONE, VTODO, VALARM inside an
//! event, …) is skipped with everything in it. Lines are unfolded (CRLF or
//! LF, then a space or tab), parameters may be quoted, and text values are
//! unescaped (`\\`, `\;`, `\,`, `\n`). A VEVENT gives UID, SUMMARY,
//! LOCATION, DESCRIPTION, DTSTART, DTEND or DURATION, RRULE, EXDATE,
//! RECURRENCE-ID and STATUS. Invalid UTF-8 becomes U+FFFD.
//!
//! **Times.** A DATE value is all-day (DTEND exclusive, as in RFC 5545). A
//! DATE-TIME keeps its local clock time to the minute: with `Z` the zone is
//! `UTC`; with a TZID that is an IANA name (also inside a longer path, as
//! some exporters write it) that name; with a Windows zone name the IANA
//! zone from a small table; otherwise, and with no TZID, the time is
//! floating (an empty zone), flagged when a TZID wasn't understood.
//! VTIMEZONE definitions are never read: the browser has the zone rules.
//!
//! **Repeats.** RRULE maps onto Kin's subset (calendar_recur.rs): DAILY
//! (DAILY with plain BYDAY becomes WEEKLY), WEEKLY with BYDAY and WKST,
//! MONTHLY by one month day (or -1) or one nth weekday (BYDAY=2TU, or
//! BYDAY=TU;BYSETPOS=2), YEARLY in the start's month likewise; INTERVAL,
//! COUNT or UNTIL (its date). Anything else (BYHOUR, several month days, a
//! COUNT over 1,000, RDATE, …) imports the first occurrence only, flagged.
//! EXDATEs that name an occurrence become cancellations for the host to
//! save. A RECURRENCE-ID override becomes a standalone event linked to its
//! series (the host saves it with the series' ID and cancels that
//! occurrence); a cancelled override is an EXDATE. STATUS:CANCELLED on a
//! whole event is flagged for the host to skip or cancel.
//!
//! **Bounds.** 2 MB of input, 5,000 events (the rest are counted and left
//! out), 1,000 EXDATEs per event, text shortened to Kin's limits (flagged).
//! Malformed lines and events without a usable DTSTART are skipped and
//! counted; the parse itself never fails on content.
use std::collections::BTreeMap;

use crate::calendar::{
    encode_event_with, is_source_uid, is_zone_name, CalendarEvent, CalendarTime, Frequency,
    MonthlyBy, Rule, RuleEnd, Timing, MAX_CALENDAR_NOTES_BYTES, MAX_CALENDAR_PLACE_BYTES,
    MAX_CALENDAR_TITLE_BYTES, MAX_CANCELLED_OCCURRENCES, MAX_RULE_COUNT, MAX_RULE_INTERVAL,
    MAX_SOURCE_UID_BYTES, MAX_SPAN_DAYS,
};
use crate::calendar_recur::is_occurrence;
use crate::error::KinError;
use crate::event::CalendarEventId;
use crate::meals::push_text;
use crate::recurrence::CivilDate;

pub const MAX_ICAL_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_ICAL_EVENTS: usize = 5_000;
/// Components nested deeper than this are skipped whole.
pub const MAX_ICAL_DEPTH: usize = 16;
pub const MAX_CALENDAR_NAME_BYTES: usize = 200;
/// A record's master index when it has none.
pub const NO_MASTER: u32 = u32::MAX;
/// The title an event without a SUMMARY gets.
pub const UNTITLED: &str = "(No title)";

/// Record flags.
pub const FLAG_RULE_UNSUPPORTED: u32 = 1;
pub const FLAG_ZONE_UNKNOWN: u32 = 1 << 1;
pub const FLAG_CANCELLED: u32 = 1 << 2;
pub const FLAG_OVERRIDE: u32 = 1 << 3;
pub const FLAG_TEXT_SHORTENED: u32 = 1 << 4;
pub const FLAG_SPAN_SHORTENED: u32 = 1 << 5;
pub const FLAG_EXDATES_DROPPED: u32 = 1 << 6;
pub const FLAG_NO_TITLE: u32 = 1 << 7;
/// Result flag: more than 5,000 events; the rest were left out.
pub const RESULT_TRUNCATED: u32 = 1;

/// One imported event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportedEvent {
    pub flags: u32,
    /// For an override: the index of its series in the result.
    pub master: Option<u32>,
    /// For an override with a series: the occurrence it replaces.
    pub original: Option<CalendarTime>,
    /// Occurrences of this event to cancel after saving it, ascending.
    pub exdates: Vec<CalendarTime>,
    /// The event, with a zero ID and no series link.
    pub event: CalendarEvent,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ImportedCalendar {
    pub name: String,
    pub events: Vec<ImportedEvent>,
    /// Events left out: no usable DTSTART, a repeated UID, past the limit.
    pub skipped: u32,
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Content lines.

type Params = Vec<(String, String)>;

/// One content line: upper-cased name, parameters (upper-cased names,
/// unquoted values) and the raw value.
struct Line<'a> {
    name: String,
    params: Params,
    value: &'a str,
}

fn param<'a>(params: &'a Params, name: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// `NAME *(;PARAM=VALUE *(,VALUE)) : VALUE`. Quoted parameter values may
/// hold `:`, `;` and `,`. None for a line without a name or colon.
fn parse_line(line: &str) -> Option<Line<'_>> {
    let bytes = line.as_bytes();
    let name_end = bytes.iter().position(|byte| matches!(byte, b';' | b':'))?;
    let name = line[..name_end].trim();
    if name.is_empty() {
        return None;
    }
    let mut params = Vec::new();
    let mut at = name_end;
    while bytes[at] == b';' {
        let key_start = at + 1;
        let equals = key_start + bytes[key_start..].iter().position(|byte| *byte == b'=')?;
        let key = line[key_start..equals].trim().to_ascii_uppercase();
        let mut value = String::new();
        at = equals + 1;
        loop {
            let byte = *bytes.get(at)?;
            match byte {
                b'"' => {
                    let close = at + 1 + bytes[at + 1..].iter().position(|byte| *byte == b'"')?;
                    value.push_str(&line[at + 1..close]);
                    at = close + 1;
                }
                b';' | b':' => break,
                _ => {
                    let end = at
                        + bytes[at..]
                            .iter()
                            .position(|byte| matches!(byte, b'"' | b';' | b':'))?;
                    value.push_str(&line[at..end]);
                    at = end;
                }
            }
        }
        params.push((key, value));
    }
    Some(Line {
        name: name.to_ascii_uppercase(),
        params,
        value: &line[at + 1..],
    })
}

/// Logical lines: physical lines (CRLF or LF) joined where a continuation
/// starts with a space or tab, that character removed.
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        match (raw.as_bytes().first(), lines.last_mut()) {
            (Some(b' ' | b'\t'), Some(last)) => last.push_str(&raw[1..]),
            _ => lines.push(raw.to_owned()),
        }
    }
    lines
}

/// TEXT unescaping: `\\`, `\;`, `\,`, `\n`/`\N`; any other escaped character
/// stands for itself.
fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            out.push(character);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// At most `max` bytes of `text`, cut at a character boundary.
fn clip(text: &str, max: usize) -> (&str, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

/// One line of plain text within `max` bytes: line breaks and tabs become
/// spaces, other control characters go, then trimmed and shortened.
fn one_line(text: &str, max: usize) -> (String, bool) {
    let cleaned: String = text
        .chars()
        .filter_map(|c| match c {
            '\n' | '\r' | '\t' => Some(' '),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect();
    let (clipped, shortened) = clip(cleaned.trim(), max);
    (clipped.trim().to_owned(), shortened)
}

/// Notes within 2,000 bytes, in calendar.rs's canonical form.
fn notes_text(text: &str) -> (String, bool) {
    let cleaned: String = text
        .chars()
        .filter_map(|c| match c {
            '\t' => Some(' '),
            '\n' | '\r' => Some(c),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect();
    let normalized = normalize_calendar_notes_lenient(&cleaned);
    let (clipped, shortened) = clip(&normalized, MAX_CALENDAR_NOTES_BYTES);
    (normalize_calendar_notes_lenient(clipped), shortened)
}

/// calendar.rs's notes normalization without its length limit.
fn normalize_calendar_notes_lenient(text: &str) -> String {
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = unified.split('\n').map(str::trim_end).collect();
    lines.join("\n").trim().to_owned()
}

// ---------------------------------------------------------------------------
// Time zones.

/// IANA areas, for a TZID that holds an IANA name inside a longer path
/// (`/mozilla.org/20050126_1/America/New_York`).
const IANA_AREAS: [&str; 11] = [
    "Africa/",
    "America/",
    "Antarctica/",
    "Arctic/",
    "Asia/",
    "Atlantic/",
    "Australia/",
    "Europe/",
    "Indian/",
    "Pacific/",
    "Etc/",
];

/// Windows zone names (Outlook, Exchange) and their usual IANA zones (the
/// CLDR "001" territory), for the zones households most often meet.
const WINDOWS_ZONES: [(&str, &str); 48] = [
    ("Dateline Standard Time", "Etc/GMT+12"),
    ("Hawaiian Standard Time", "Pacific/Honolulu"),
    ("Alaskan Standard Time", "America/Anchorage"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("Pacific Standard Time (Mexico)", "America/Tijuana"),
    ("US Mountain Standard Time", "America/Phoenix"),
    ("Mountain Standard Time", "America/Denver"),
    ("Central America Standard Time", "America/Guatemala"),
    ("Central Standard Time", "America/Chicago"),
    ("Central Standard Time (Mexico)", "America/Mexico_City"),
    ("Canada Central Standard Time", "America/Regina"),
    ("SA Pacific Standard Time", "America/Bogota"),
    ("Eastern Standard Time", "America/New_York"),
    ("US Eastern Standard Time", "America/Indiana/Indianapolis"),
    ("Atlantic Standard Time", "America/Halifax"),
    ("Newfoundland Standard Time", "America/St_Johns"),
    ("E. South America Standard Time", "America/Sao_Paulo"),
    ("Argentina Standard Time", "America/Buenos_Aires"),
    ("UTC", "UTC"),
    ("Coordinated Universal Time", "UTC"),
    ("GMT Standard Time", "Europe/London"),
    ("Greenwich Standard Time", "Atlantic/Reykjavik"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("Central Europe Standard Time", "Europe/Budapest"),
    ("Romance Standard Time", "Europe/Paris"),
    ("Central European Standard Time", "Europe/Warsaw"),
    ("W. Central Africa Standard Time", "Africa/Lagos"),
    ("GTB Standard Time", "Europe/Bucharest"),
    ("E. Europe Standard Time", "Europe/Chisinau"),
    ("FLE Standard Time", "Europe/Kiev"),
    ("Israel Standard Time", "Asia/Jerusalem"),
    ("South Africa Standard Time", "Africa/Johannesburg"),
    ("Egypt Standard Time", "Africa/Cairo"),
    ("Turkey Standard Time", "Europe/Istanbul"),
    ("Russian Standard Time", "Europe/Moscow"),
    ("Arabian Standard Time", "Asia/Dubai"),
    ("Pakistan Standard Time", "Asia/Karachi"),
    ("India Standard Time", "Asia/Calcutta"),
    ("Bangladesh Standard Time", "Asia/Dhaka"),
    ("SE Asia Standard Time", "Asia/Bangkok"),
    ("China Standard Time", "Asia/Shanghai"),
    ("Singapore Standard Time", "Asia/Singapore"),
    ("Taipei Standard Time", "Asia/Taipei"),
    ("Tokyo Standard Time", "Asia/Tokyo"),
    ("Korea Standard Time", "Asia/Seoul"),
    ("AUS Eastern Standard Time", "Australia/Sydney"),
    ("E. Australia Standard Time", "Australia/Brisbane"),
    ("New Zealand Standard Time", "Pacific/Auckland"),
];

/// Outlook's display names, "(UTC-05:00) Eastern Time (US & Canada)", by
/// what follows the offset.
const DISPLAY_ZONES: [(&str, &str); 8] = [
    ("Eastern Time (US & Canada)", "America/New_York"),
    ("Central Time (US & Canada)", "America/Chicago"),
    ("Mountain Time (US & Canada)", "America/Denver"),
    ("Pacific Time (US & Canada)", "America/Los_Angeles"),
    ("Dublin, Edinburgh, Lisbon, London", "Europe/London"),
    (
        "Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna",
        "Europe/Berlin",
    ),
    ("Brussels, Copenhagen, Madrid, Paris", "Europe/Paris"),
    ("Canberra, Melbourne, Sydney", "Australia/Sydney"),
];

/// The IANA zone a TZID names, or None when it isn't understood.
pub fn map_zone(tzid: &str) -> Option<String> {
    let tzid = tzid.trim().trim_matches('"').trim();
    if ["UTC", "GMT", "Z", "Etc/UTC", "Etc/GMT", "UCT"]
        .iter()
        .any(|name| tzid.eq_ignore_ascii_case(name))
    {
        return Some("UTC".to_owned());
    }
    for area in IANA_AREAS {
        if let Some(at) = tzid.find(area) {
            let candidate = &tzid[at..];
            if is_zone_name(candidate) {
                return Some(candidate.to_owned());
            }
        }
    }
    if let Some((_, zone)) = WINDOWS_ZONES
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(tzid))
    {
        return Some((*zone).to_owned());
    }
    let display = tzid
        .strip_prefix('(')
        .and_then(|rest| rest.split_once(')'))
        .map_or(tzid, |(_, rest)| rest.trim());
    DISPLAY_ZONES
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(display))
        .map(|(_, zone)| (*zone).to_owned())
}

// ---------------------------------------------------------------------------
// Dates and times.

#[derive(Clone, Debug, Eq, PartialEq)]
enum Zone {
    /// The IANA zone, "UTC" for `Z`.
    Named(String),
    Floating,
    /// A TZID that wasn't understood; treated as floating.
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum IcalTime {
    Date(CivilDate),
    DateTime { time: CalendarTime, zone: Zone },
}

fn digits(text: &str) -> Option<u32> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn parse_date(text: &str) -> Option<CivilDate> {
    if text.len() != 8 {
        return None;
    }
    CivilDate::from_encoded(digits(text)?).ok()
}

/// A DATE or DATE-TIME value with its TZID parameter. Seconds are dropped.
fn parse_time(params: &Params, value: &str) -> Option<IcalTime> {
    let value = value.trim();
    let is_date = param(params, "VALUE").is_some_and(|kind| kind.eq_ignore_ascii_case("DATE"));
    if is_date || value.len() == 8 {
        return parse_date(value.get(..8)?).map(IcalTime::Date);
    }
    let (date, rest) = value.split_once(['T', 't'])?;
    let date = parse_date(date)?;
    let (clock, utc) = match rest.strip_suffix(['Z', 'z']) {
        Some(clock) => (clock, true),
        None => (rest, false),
    };
    if clock.len() != 6 {
        return None;
    }
    let hour = digits(clock.get(..2)?)?;
    let minute = digits(clock.get(2..4)?)?;
    let second = digits(clock.get(4..6)?)?;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let zone = if utc {
        Zone::Named("UTC".to_owned())
    } else {
        match param(params, "TZID") {
            None => Zone::Floating,
            Some(tzid) => map_zone(tzid).map_or(Zone::Unknown, Zone::Named),
        }
    };
    Some(IcalTime::DateTime {
        time: CalendarTime::new(date, (hour * 60 + minute) as u16)?,
        zone,
    })
}

/// A DURATION in seconds (`[+-]P[nW][nD][T[nH][nM][nS]]`); negative ones
/// are None.
fn parse_duration(value: &str) -> Option<u64> {
    let value = value.trim();
    let value = match value.as_bytes().first()? {
        b'+' => &value[1..],
        b'-' => return None,
        _ => value,
    };
    let mut rest = value.strip_prefix(['P', 'p'])?;
    let mut seconds = 0u64;
    let mut in_time = false;
    let mut any = false;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix(['T', 't']) {
            in_time = true;
            rest = after;
            continue;
        }
        let length = rest.bytes().take_while(u8::is_ascii_digit).count();
        let number: u64 = rest.get(..length)?.parse().ok()?;
        let unit = rest.as_bytes().get(length)?.to_ascii_uppercase();
        let scale = match (unit, in_time) {
            (b'W', false) => 604_800,
            (b'D', false) => 86_400,
            (b'H', true) => 3_600,
            (b'M', true) => 60,
            (b'S', true) => 1,
            _ => return None,
        };
        seconds = seconds.checked_add(number.checked_mul(scale)?)?;
        any = true;
        rest = &rest[length + 1..];
    }
    any.then_some(seconds)
}

// ---------------------------------------------------------------------------
// Repeats.

fn weekday_code(text: &str) -> Option<u8> {
    match text.to_ascii_uppercase().as_str() {
        "MO" => Some(0),
        "TU" => Some(1),
        "WE" => Some(2),
        "TH" => Some(3),
        "FR" => Some(4),
        "SA" => Some(5),
        "SU" => Some(6),
        _ => None,
    }
}

/// A BYDAY entry: an optional signed ordinal and the weekday.
fn by_day(text: &str) -> Option<(Option<i8>, u8)> {
    let text = text.trim();
    let split = text.len().checked_sub(2)?;
    let (ordinal, day) = (text.get(..split)?, text.get(split..)?);
    let weekday = weekday_code(day)?;
    if ordinal.is_empty() {
        return Some((None, weekday));
    }
    let ordinal: i8 = ordinal.strip_prefix('+').unwrap_or(ordinal).parse().ok()?;
    Some((Some(ordinal), weekday))
}

fn nth_ok(nth: i8) -> bool {
    nth == -1 || (1..=5).contains(&nth)
}

/// An RRULE as Kin's rule, or None when Kin can't represent it.
pub(crate) fn map_rule(value: &str, start: CivilDate) -> Option<Rule> {
    let mut parts: BTreeMap<String, String> = BTreeMap::new();
    for part in value.trim().split(';').filter(|part| !part.is_empty()) {
        let (key, value) = part.split_once('=')?;
        let key = key.trim().to_ascii_uppercase();
        if parts.insert(key, value.trim().to_owned()).is_some() {
            return None;
        }
    }
    let frequency = match parts.remove("FREQ")?.to_ascii_uppercase().as_str() {
        "DAILY" => Frequency::Daily,
        "WEEKLY" => Frequency::Weekly,
        "MONTHLY" => Frequency::Monthly,
        "YEARLY" => Frequency::Yearly,
        _ => return None,
    };
    let interval: u16 = match parts.remove("INTERVAL") {
        Some(value) => value.parse().ok()?,
        None => 1,
    };
    if !(1..=MAX_RULE_INTERVAL).contains(&interval) {
        return None;
    }
    let end = match (parts.remove("COUNT"), parts.remove("UNTIL")) {
        (None, None) => RuleEnd::Never,
        (Some(count), None) => {
            let count: u16 = count.parse().ok()?;
            if !(1..=MAX_RULE_COUNT).contains(&count) {
                return None;
            }
            RuleEnd::Count(count)
        }
        (None, Some(until)) => RuleEnd::Until(parse_date(until.get(..8)?)?.max(start)),
        (Some(_), Some(_)) => return None,
    };
    let week_start = match parts.remove("WKST") {
        Some(day) => weekday_code(&day)?,
        None => 0,
    };
    let days: Vec<(Option<i8>, u8)> = match parts.remove("BYDAY") {
        Some(list) => list.split(',').map(by_day).collect::<Option<_>>()?,
        None => Vec::new(),
    };
    let month_days: Vec<i8> = match parts.remove("BYMONTHDAY") {
        Some(list) => list
            .split(',')
            .map(|day| day.trim().parse().ok())
            .collect::<Option<_>>()?,
        None => Vec::new(),
    };
    let months: Vec<u32> = match parts.remove("BYMONTH") {
        Some(list) => list
            .split(',')
            .map(|month| month.trim().parse().ok())
            .collect::<Option<_>>()?,
        None => Vec::new(),
    };
    let set_positions: Vec<i8> = match parts.remove("BYSETPOS") {
        Some(list) => list
            .split(',')
            .map(|position| position.trim().parse().ok())
            .collect::<Option<_>>()?,
        None => Vec::new(),
    };
    // BYHOUR, BYMINUTE, BYYEARDAY, BYWEEKNO, RSCALE, X- parts, ….
    if !parts.is_empty() {
        return None;
    }
    let plain_mask = || -> Option<u8> {
        days.iter().try_fold(0u8, |mask, (ordinal, weekday)| {
            ordinal.is_none().then_some(mask | (1 << weekday))
        })
    };
    let rule = |frequency, by, weekdays, week_start| Rule {
        frequency,
        interval,
        by,
        weekdays,
        week_start,
        end,
    };
    match frequency {
        Frequency::Daily => {
            if !month_days.is_empty() || !months.is_empty() || !set_positions.is_empty() {
                return None;
            }
            if days.is_empty() {
                return Some(rule(Frequency::Daily, MonthlyBy::None, 0, 0));
            }
            // Every listed weekday is a weekly rule, when every day counts.
            if interval != 1 {
                return None;
            }
            Some(rule(Frequency::Weekly, MonthlyBy::None, plain_mask()?, 0))
        }
        Frequency::Weekly => {
            if !month_days.is_empty() || !months.is_empty() || !set_positions.is_empty() {
                return None;
            }
            let mask = if days.is_empty() {
                1 << start.weekday()
            } else {
                plain_mask()?
            };
            Some(rule(Frequency::Weekly, MonthlyBy::None, mask, week_start))
        }
        Frequency::Monthly | Frequency::Yearly => {
            if frequency == Frequency::Yearly && !(months.is_empty() || months == [start.month()])
                || frequency == Frequency::Monthly && !months.is_empty()
            {
                return None;
            }
            let by = match (
                days.as_slice(),
                month_days.as_slice(),
                set_positions.as_slice(),
            ) {
                ([], [], []) => MonthlyBy::MonthDay(start.day() as i8),
                ([], [day], []) if *day == -1 || (1..=31).contains(day) => {
                    MonthlyBy::MonthDay(*day)
                }
                ([(Some(nth), weekday)], [], []) if nth_ok(*nth) => MonthlyBy::NthWeekday {
                    nth: *nth,
                    weekday: *weekday,
                },
                ([(None, weekday)], [], [nth]) if nth_ok(*nth) => MonthlyBy::NthWeekday {
                    nth: *nth,
                    weekday: *weekday,
                },
                _ => return None,
            };
            Some(rule(frequency, by, 0, 0))
        }
    }
}

// ---------------------------------------------------------------------------
// Events.

#[derive(Default)]
struct RawEvent {
    uid: Option<String>,
    summary: Option<String>,
    location: Option<String>,
    description: Option<String>,
    start: Option<(Params, String)>,
    end: Option<(Params, String)>,
    duration: Option<String>,
    rules: Vec<String>,
    has_rdate: bool,
    exdates: Vec<(Params, String)>,
    recurrence_id: Option<(Params, String)>,
    cancelled: bool,
}

impl RawEvent {
    fn take(&mut self, line: Line<'_>) {
        let text = || Some(unescape(line.value));
        let timed = || Some((line.params.clone(), line.value.to_owned()));
        match line.name.as_str() {
            "UID" => self.uid = text(),
            "SUMMARY" => self.summary = text(),
            "LOCATION" => self.location = text(),
            "DESCRIPTION" => self.description = text(),
            "DTSTART" => self.start = timed(),
            "DTEND" => self.end = timed(),
            "DURATION" => self.duration = Some(line.value.to_owned()),
            "RRULE" => self.rules.push(line.value.to_owned()),
            "RDATE" => self.has_rdate = true,
            "EXDATE" => {
                for value in line.value.split(',') {
                    self.exdates.push((line.params.clone(), value.to_owned()));
                }
            }
            "RECURRENCE-ID" => self.recurrence_id = timed(),
            "STATUS" => self.cancelled = line.value.trim().eq_ignore_ascii_case("CANCELLED"),
            _ => {}
        }
    }
}

/// A parsed VEVENT before overrides are matched to their series.
struct Candidate {
    imported: ImportedEvent,
    uid: String,
    recurrence_id: Option<IcalTime>,
}

/// An instant named in a list (EXDATE, RECURRENCE-ID) as the occurrence
/// start of `event` it means: a date is that day at the event's start time;
/// a time in the event's own zone is taken as it is; a time in another zone
/// can't be converted without zone rules, so it is taken as that day.
fn occurrence_key(event: &CalendarEvent, time: &IcalTime) -> CalendarTime {
    let start = event.start();
    match time {
        IcalTime::Date(date) => CalendarTime {
            date: *date,
            minute: start.minute,
        },
        IcalTime::DateTime { time, zone } => {
            let same_zone = match zone {
                Zone::Named(name) => name == event.zone(),
                Zone::Floating | Zone::Unknown => event.zone().is_empty(),
            };
            if same_zone && !event.is_all_day() {
                *time
            } else {
                CalendarTime {
                    date: time.date,
                    minute: start.minute,
                }
            }
        }
    }
}

/// A VEVENT as a Kin event, or None without a usable DTSTART.
fn convert(raw: &RawEvent) -> Option<Candidate> {
    let mut flags = 0u32;
    let (start_params, start_value) = raw.start.as_ref()?;
    let start = parse_time(start_params, start_value)?;
    let end = raw
        .end
        .as_ref()
        .and_then(|(params, value)| parse_time(params, value));
    let duration = raw.duration.as_deref().and_then(parse_duration);
    let timing = match start {
        IcalTime::Date(first) => {
            let last = match (&end, duration) {
                (Some(IcalTime::Date(end)), _) => end.checked_sub_days(1).unwrap_or(first),
                (None, Some(seconds)) => {
                    let days = u32::try_from(seconds.div_ceil(86_400)).unwrap_or(u32::MAX);
                    first
                        .checked_add_days(days.saturating_sub(1).min(MAX_SPAN_DAYS + 1))
                        .unwrap_or(first)
                }
                _ => first,
            }
            .max(first);
            let limit = first.checked_add_days(MAX_SPAN_DAYS).unwrap_or(last);
            if last > limit {
                flags |= FLAG_SPAN_SHORTENED;
            }
            Timing::AllDay {
                start: first,
                end: last.min(limit),
            }
        }
        IcalTime::DateTime { time, ref zone } => {
            let zone_name = match zone {
                Zone::Named(name) => name.clone(),
                Zone::Floating => String::new(),
                Zone::Unknown => {
                    flags |= FLAG_ZONE_UNKNOWN;
                    String::new()
                }
            };
            let until = match (&end, duration) {
                (Some(IcalTime::DateTime { time: end, .. }), _) => *end,
                (None, Some(seconds)) => {
                    // Past the longest span it is shortened below anyway.
                    let longest = u64::from(MAX_SPAN_DAYS + 1) * 86_400;
                    CalendarTime::from_total_minutes(
                        time.total_minutes() + seconds.min(longest) / 60,
                    )
                    .unwrap_or(time)
                }
                _ => time,
            }
            .max(time);
            let limit_date = time
                .date
                .checked_add_days(MAX_SPAN_DAYS)
                .unwrap_or(time.date);
            let until = if until.date > limit_date {
                flags |= FLAG_SPAN_SHORTENED;
                CalendarTime {
                    date: limit_date,
                    minute: time.minute,
                }
            } else {
                until
            };
            Timing::Timed {
                start: time,
                end: until,
                zone: zone_name,
            }
        }
    };
    let start_date = match &timing {
        Timing::AllDay { start, .. } => *start,
        Timing::Timed { start, .. } => start.date,
    };
    let rule = match raw.rules.as_slice() {
        [] => None,
        [rule] => {
            let mapped = map_rule(rule, start_date);
            if mapped.is_none() {
                flags |= FLAG_RULE_UNSUPPORTED;
            }
            mapped
        }
        _ => {
            flags |= FLAG_RULE_UNSUPPORTED;
            None
        }
    };
    if raw.has_rdate {
        flags |= FLAG_RULE_UNSUPPORTED;
    }
    let (title, title_short) = one_line(
        raw.summary.as_deref().unwrap_or(""),
        MAX_CALENDAR_TITLE_BYTES,
    );
    let title = if title.is_empty() {
        flags |= FLAG_NO_TITLE;
        UNTITLED.to_owned()
    } else {
        title
    };
    let (place, place_short) = one_line(
        raw.location.as_deref().unwrap_or(""),
        MAX_CALENDAR_PLACE_BYTES,
    );
    let (notes, notes_short) = notes_text(raw.description.as_deref().unwrap_or(""));
    let (uid, _) = one_line(raw.uid.as_deref().unwrap_or(""), MAX_SOURCE_UID_BYTES);
    if title_short || place_short || notes_short {
        flags |= FLAG_TEXT_SHORTENED;
    }
    if raw.cancelled {
        flags |= FLAG_CANCELLED;
    }
    let event = CalendarEvent {
        event_id: CalendarEventId([0; 16]),
        title,
        place,
        notes,
        attendees: Vec::new(),
        countdown: false,
        source_uid: if is_source_uid(&uid) {
            uid.clone()
        } else {
            String::new()
        },
        timing,
        rule,
        link: None,
    };
    let recurrence_id = raw
        .recurrence_id
        .as_ref()
        .and_then(|(params, value)| parse_time(params, value));
    let mut exdates = Vec::new();
    if event.rule.is_some() {
        for (params, value) in &raw.exdates {
            let Some(time) = parse_time(params, value) else {
                flags |= FLAG_EXDATES_DROPPED;
                continue;
            };
            let key = occurrence_key(&event, &time);
            if is_occurrence(&event, key) {
                exdates.push(key);
            }
        }
    }
    exdates.sort();
    exdates.dedup();
    if exdates.len() > MAX_CANCELLED_OCCURRENCES {
        exdates.truncate(MAX_CANCELLED_OCCURRENCES);
        flags |= FLAG_EXDATES_DROPPED;
    }
    if recurrence_id.is_some() {
        flags |= FLAG_OVERRIDE;
    }
    Some(Candidate {
        imported: ImportedEvent {
            flags,
            master: None,
            original: None,
            exdates,
            event,
        },
        uid,
        recurrence_id,
    })
}

/// Parses an iCalendar file. Fails only past 2 MB (code 5); content Kin
/// can't use is skipped and counted.
pub fn parse(bytes: &[u8]) -> Result<ImportedCalendar, KinError> {
    if bytes.len() > MAX_ICAL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let text = String::from_utf8_lossy(bytes);
    let mut calendar = ImportedCalendar::default();
    let mut candidates: Vec<Candidate> = Vec::new();
    // Open components, innermost last. Past MAX_ICAL_DEPTH only a count is
    // kept and everything inside is skipped.
    let mut stack: Vec<String> = Vec::new();
    let mut overflow = 0usize;
    let mut raw: Option<RawEvent> = None;
    let mut seen_events = 0usize;
    for logical in unfold(&text) {
        let Some(line) = parse_line(&logical) else {
            continue;
        };
        match line.name.as_str() {
            "BEGIN" => {
                let component = line.value.trim().to_ascii_uppercase();
                if overflow > 0 || stack.len() >= MAX_ICAL_DEPTH {
                    overflow += 1;
                    continue;
                }
                if component == "VEVENT" && raw.is_none() {
                    seen_events += 1;
                    if seen_events > MAX_ICAL_EVENTS {
                        calendar.truncated = true;
                    } else {
                        raw = Some(RawEvent::default());
                    }
                }
                stack.push(component);
            }
            "END" => {
                if overflow > 0 {
                    overflow -= 1;
                    continue;
                }
                let component = line.value.trim().to_ascii_uppercase();
                // An END without its BEGIN closes nothing; one that skips
                // inner components closes them too.
                let Some(depth) = stack.iter().rposition(|open| *open == component) else {
                    continue;
                };
                let closes_event = stack[depth..].iter().any(|open| open == "VEVENT")
                    && stack[..depth].iter().all(|open| open != "VEVENT");
                stack.truncate(depth);
                if closes_event {
                    if let Some(event) = raw.take() {
                        match convert(&event) {
                            Some(candidate) => candidates.push(candidate),
                            None => calendar.skipped += 1,
                        }
                    }
                }
            }
            _ if overflow > 0 => {}
            _ => match stack.last().map(String::as_str) {
                Some("VEVENT") => {
                    if let Some(event) = raw.as_mut() {
                        event.take(line);
                    }
                }
                Some("VCALENDAR") if line.name == "X-WR-CALNAME" => {
                    calendar.name = one_line(&unescape(line.value), MAX_CALENDAR_NAME_BYTES).0;
                }
                _ => {}
            },
        }
    }
    // An unterminated last event still counts.
    if let Some(event) = raw.take() {
        match convert(&event) {
            Some(candidate) => candidates.push(candidate),
            None => calendar.skipped += 1,
        }
    }
    if calendar.truncated {
        calendar.skipped = calendar
            .skipped
            .saturating_add(u32::try_from(seen_events - MAX_ICAL_EVENTS).unwrap_or(u32::MAX));
    }
    resolve_overrides(&mut calendar, candidates);
    Ok(calendar)
}

/// Matches overrides to their series, folds cancelled overrides into the
/// series' EXDATEs, drops repeated UIDs and numbers what is kept.
fn resolve_overrides(calendar: &mut ImportedCalendar, mut candidates: Vec<Candidate>) {
    // The series for each UID: the first event with that UID and no
    // RECURRENCE-ID. A later one with the same UID is a duplicate.
    let mut series: BTreeMap<String, usize> = BTreeMap::new();
    let mut keep = vec![true; candidates.len()];
    let mut duplicates = 0u32;
    for (index, candidate) in candidates.iter().enumerate() {
        if candidate.recurrence_id.is_some() || candidate.uid.is_empty() {
            continue;
        }
        if series.contains_key(&candidate.uid) {
            keep[index] = false;
            duplicates += 1;
        } else {
            series.insert(candidate.uid.clone(), index);
        }
    }
    let mut links: Vec<Option<(usize, CalendarTime)>> = vec![None; candidates.len()];
    for index in 0..candidates.len() {
        let Some(recurrence_id) = candidates[index].recurrence_id.clone() else {
            continue;
        };
        let Some(&master) = series.get(&candidates[index].uid) else {
            continue;
        };
        if !keep[master] || candidates[master].imported.event.rule.is_none() {
            continue;
        }
        let original = occurrence_key(&candidates[master].imported.event, &recurrence_id);
        if !is_occurrence(&candidates[master].imported.event, original) {
            continue;
        }
        if candidates[index].imported.flags & FLAG_CANCELLED != 0 {
            // A cancelled occurrence: an EXDATE of the series.
            let exdates = &mut candidates[master].imported.exdates;
            if let Err(at) = exdates.binary_search(&original) {
                if exdates.len() < MAX_CANCELLED_OCCURRENCES {
                    exdates.insert(at, original);
                }
            }
            keep[index] = false;
        } else {
            links[index] = Some((master, original));
        }
    }
    let mut numbers = vec![NO_MASTER; candidates.len()];
    let mut next = 0u32;
    for (index, kept) in keep.iter().enumerate() {
        if *kept {
            numbers[index] = next;
            next += 1;
        }
    }
    // Cancelled overrides were folded into their series, not skipped.
    calendar.skipped = calendar.skipped.saturating_add(duplicates);
    for (index, candidate) in candidates.into_iter().enumerate() {
        if !keep[index] {
            continue;
        }
        let mut imported = candidate.imported;
        if let Some((master, original)) = links[index] {
            imported.master = Some(numbers[master]);
            imported.original = Some(original);
        }
        calendar.events.push(imported);
    }
}

/// KICS v1, an iCalendar file as Kin events:
///
/// ```text
///  0 "KICS", version u16 = 1, reserved u16
///  8 event count u32, skipped count u32, flags u32 (bit 0 more than 5,000
///    events, the rest left out)
/// 20 the calendar's name (X-WR-CALNAME): u16 length + UTF-8
///    then per event: flags u32 (bit 0 repeat not kept, first occurrence
///    only; 1 time zone not understood, floating; 2 STATUS:CANCELLED;
///    3 an override (RECURRENCE-ID); 4 text shortened; 5 length shortened;
///    6 EXDATEs left out; 7 no title), series index u32 (0xFFFFFFFF none),
///    original start date u32, minute u16, reserved u16 (zero without a
///    series), EXDATE count u16, reserved u16, payload length u32, each
///    EXDATE (date u32, minute u16, reserved u16; ascending), then the
///    kind-71 payload with a zero event ID and no series link
/// ```
pub fn encode_calendar(calendar: &ImportedCalendar) -> Result<Vec<u8>, KinError> {
    let mut out = Vec::new();
    out.extend_from_slice(b"KICS");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&(calendar.events.len() as u32).to_le_bytes());
    out.extend_from_slice(&calendar.skipped.to_le_bytes());
    out.extend_from_slice(&u32::from(calendar.truncated).to_le_bytes());
    push_text(&mut out, &calendar.name);
    for imported in &calendar.events {
        let payload = encode_event_with(&imported.event, true)?;
        out.extend_from_slice(&imported.flags.to_le_bytes());
        out.extend_from_slice(&imported.master.unwrap_or(NO_MASTER).to_le_bytes());
        match imported.original {
            Some(original) => original.push(&mut out),
            None => out.extend_from_slice(&[0; 8]),
        }
        out.extend_from_slice(&(imported.exdates.len() as u16).to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        for exdate in &imported.exdates {
            exdate.push(&mut out);
        }
        out.extend_from_slice(&payload);
    }
    Ok(out)
}

/// `kin_ical_parse`: the file's bytes -> KICS.
pub fn parse_request(input: &[u8]) -> Result<Vec<u8>, KinError> {
    encode_calendar(&parse(input)?)
}
