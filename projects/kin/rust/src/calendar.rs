//! Family calendar events (#656, epic #651, ADR 0022 §1).
//!
//! **Kinds** (household history, schema 1):
//! - 71 `CALENDAR_EVENT_SAVED`: the whole event, replacing any earlier
//!   version with the same ID.
//! - 72 `CALENDAR_EVENT_CANCELLED`: one occurrence (by its original start) or
//!   the whole series.
//! - 73 `CALENDAR_EVENT_RESTORED`: undoes a cancel of that occurrence or of
//!   the series.
//! - 74 `MEMBER_COLOUR_SET`: the event's own member's colour, one of 12
//!   palette entries, or back to the default. Like a preferred name (kind
//!   51), a member can only colour themselves.
//!
//! **An event** has an ID, a title (1–200 bytes), a place (0–200), notes
//! (0–2,000), up to 16 attendees (member IDs in ascending order), a
//! countdown flag, a source UID for imported events (0–255 bytes; empty when
//! made in Kin), and either an all-day span (start and last civil date,
//! inclusive) or a timed span (start and end local date-times to the minute,
//! and an IANA time-zone name checked as text only; an empty zone is a
//! floating time, shown at the same clock time wherever it is read). An
//! event lasts at most 366 days. It may repeat (calendar_recur.rs) and may be
//! linked to a series: a changed occurrence is a cancel of that occurrence
//! plus a standalone event that names the series and the occurrence's
//! original start.
//!
//! **Time zones.** Rust has no zone rules. It expands repeats in the event's
//! own local civil time, so a 9:00 weekly event stays at 9:00 across daylight
//! saving time, and the browser turns local times into instants with `Intl`
//! when it draws them.
//!
//! **Payloads are strict** like store sections: each decodes only if it
//! re-encodes to the same bytes, so text is already canonical (trimmed,
//! notes with "\n" line breaks), attendees ascend, and the span and rule are
//! consistent (code 2). Replay never fails on a decoded event. Commands
//! enforce the rest (code 4, `CalendarState::check_command`).
//!
//! **Replay is tolerant.** The latest save of an ID wins. A cancel or restore
//! is kept by event ID even when this device hasn't seen the event yet. A
//! linked event whose series is cancelled as a whole counts as cancelled too.
//! Past `MAX_CALENDAR_EVENTS` distinct IDs, or `MAX_CANCELLED_OCCURRENCES`
//! cancelled occurrences of one event, further ones are recorded no-ops.
//! Attendees are member IDs as given: Rust doesn't know membership, as for
//! responsibilities.
//!
//! Hosts read the calendar through `kin_calendar_range` (KCAQ -> KCAL,
//! calendar_range.rs); it is not part of the KINS projection.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::error::KinError;
use crate::event::{ActorId, CalendarEventId, EventEnvelope, EventKind};
use crate::meals::{push_text, read_text};
use crate::recurrence::CivilDate;
use crate::wire::{read_id, read_u16, read_u32};

pub const CALENDAR_EVENT_SAVED: u16 = 71;
pub const CALENDAR_EVENT_CANCELLED: u16 = 72;
pub const CALENDAR_EVENT_RESTORED: u16 = 73;
pub const MEMBER_COLOUR_SET: u16 = 74;

/// Most distinct event IDs a household keeps.
pub const MAX_CALENDAR_EVENTS: usize = 2_000;
pub const MAX_CALENDAR_TITLE_BYTES: usize = 200;
pub const MAX_CALENDAR_PLACE_BYTES: usize = 200;
pub const MAX_CALENDAR_NOTES_BYTES: usize = 2_000;
pub const MAX_CALENDAR_ATTENDEES: usize = 16;
pub const MAX_ZONE_BYTES: usize = 64;
pub const MAX_SOURCE_UID_BYTES: usize = 255;
/// Most days from an event's start date to its end date.
pub const MAX_SPAN_DAYS: u32 = 366;
pub const MAX_RULE_INTERVAL: u16 = 1_000;
pub const MAX_RULE_COUNT: u16 = 1_000;
/// Most cancelled occurrences one event keeps.
pub const MAX_CANCELLED_OCCURRENCES: usize = 1_000;
/// The palette has this many colours; 255 in a payload clears a choice.
pub const MEMBER_COLOURS: u8 = 12;
pub const MINUTES_PER_DAY: u16 = 1_440;
/// The kind-71 payload before the attendees and texts.
pub const EVENT_FIXED_BYTES: usize = 72;
/// The kind-72/73 payload.
pub const CANCEL_PAYLOAD_BYTES: usize = 28;

pub const fn is_calendar_code(code: u16) -> bool {
    matches!(
        code,
        CALENDAR_EVENT_SAVED
            | CALENDAR_EVENT_CANCELLED
            | CALENDAR_EVENT_RESTORED
            | MEMBER_COLOUR_SET
    )
}

/// A local civil date-time to the minute: an occurrence's start, or an
/// all-day event's date with minute 0.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct CalendarTime {
    pub date: CivilDate,
    /// Minutes after midnight, 0–1439.
    pub minute: u16,
}

impl CalendarTime {
    pub fn new(date: CivilDate, minute: u16) -> Option<Self> {
        (minute < MINUTES_PER_DAY).then_some(Self { date, minute })
    }

    /// Minutes since 0001-01-01 00:00.
    pub fn total_minutes(self) -> u64 {
        u64::from(self.date.day_number()) * u64::from(MINUTES_PER_DAY) + u64::from(self.minute)
    }

    pub fn from_total_minutes(minutes: u64) -> Option<Self> {
        let day = u32::try_from(minutes / u64::from(MINUTES_PER_DAY)).ok()?;
        Some(Self {
            date: CivilDate::from_day_number(day)?,
            minute: (minutes % u64::from(MINUTES_PER_DAY)) as u16,
        })
    }

    /// 8 bytes: date u32, minute u16, reserved u16.
    pub(crate) fn push(self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.date.encoded().to_le_bytes());
        out.extend_from_slice(&self.minute.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
    }
}

/// When an event happens.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Timing {
    /// From `start` to `end`, both civil dates, inclusive.
    AllDay { start: CivilDate, end: CivilDate },
    /// From `start` to `end` in `zone` (an IANA name; empty for floating).
    Timed {
        start: CalendarTime,
        end: CalendarTime,
        zone: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum Frequency {
    Daily = 1,
    Weekly = 2,
    Monthly = 3,
    Yearly = 4,
}

impl Frequency {
    pub const fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::Daily),
            2 => Some(Self::Weekly),
            3 => Some(Self::Monthly),
            4 => Some(Self::Yearly),
            _ => None,
        }
    }
}

/// Which day of the month a monthly or yearly rule falls on (a yearly rule
/// uses the start's month).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MonthlyBy {
    /// Daily and weekly rules.
    None,
    /// Day 1–31 (months without it are skipped), or -1 for the last day.
    MonthDay(i8),
    /// The 1st–5th (months without it are skipped) or last (-1) weekday,
    /// 0 Monday … 6 Sunday.
    NthWeekday { nth: i8, weekday: u8 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuleEnd {
    Never,
    /// This many occurrences in all, the start included (1–1,000).
    Count(u16),
    /// The last civil date an occurrence may start on (on or after the
    /// start date).
    Until(CivilDate),
}

/// A repeat: a subset of RFC 5545 RRULE. The event's start is always the
/// first occurrence, as in RFC 5545, even when the rule wouldn't choose it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Rule {
    pub frequency: Frequency,
    /// Every this many days, weeks, months or years (1–1,000).
    pub interval: u16,
    pub by: MonthlyBy,
    /// Weekly only: bit 0 Monday … bit 6 Sunday, at least one.
    pub weekdays: u8,
    /// Weekly only: the day weeks start on, 0 Monday … 6 Sunday (RFC 5545
    /// WKST), which matters for an interval above 1.
    pub week_start: u8,
    pub end: RuleEnd,
}

/// A standalone event standing in for one occurrence of a series.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SeriesLink {
    pub series_id: CalendarEventId,
    pub original: CalendarTime,
}

/// One event as saved (kind 71).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CalendarEvent {
    pub event_id: CalendarEventId,
    pub title: String,
    pub place: String,
    pub notes: String,
    /// Member IDs, strictly ascending.
    pub attendees: Vec<ActorId>,
    pub countdown: bool,
    pub source_uid: String,
    pub timing: Timing,
    pub rule: Option<Rule>,
    pub link: Option<SeriesLink>,
}

impl CalendarEvent {
    pub fn is_all_day(&self) -> bool {
        matches!(self.timing, Timing::AllDay { .. })
    }

    /// The first occurrence's start (minute 0 when all-day).
    pub fn start(&self) -> CalendarTime {
        match &self.timing {
            Timing::AllDay { start, .. } => CalendarTime {
                date: *start,
                minute: 0,
            },
            Timing::Timed { start, .. } => *start,
        }
    }

    /// Days from an occurrence's start date to its end date.
    pub fn span_days(&self) -> u32 {
        match &self.timing {
            Timing::AllDay { start, end } => end.day_number() - start.day_number(),
            Timing::Timed { start, end, .. } => end.date.day_number() - start.date.day_number(),
        }
    }

    /// The end of the occurrence starting at `start` (an all-day end is its
    /// last date with minute 0).
    pub fn occurrence_end(&self, start: CalendarTime) -> Option<CalendarTime> {
        match &self.timing {
            Timing::AllDay {
                start: first,
                end: last,
            } => Some(CalendarTime {
                date: start
                    .date
                    .checked_add_days(last.day_number() - first.day_number())?,
                minute: 0,
            }),
            Timing::Timed {
                start: first,
                end: last,
                ..
            } => CalendarTime::from_total_minutes(
                start.total_minutes() + (last.total_minutes() - first.total_minutes()),
            ),
        }
    }

    pub fn zone(&self) -> &str {
        match &self.timing {
            Timing::AllDay { .. } => "",
            Timing::Timed { zone, .. } => zone,
        }
    }
}

// ---------------------------------------------------------------------------
// Canonical text.

fn single_line(text: &str, max_bytes: usize, required: bool) -> Result<String, KinError> {
    let text = text.trim();
    if text.len() > max_bytes || (required && text.is_empty()) || text.chars().any(char::is_control)
    {
        return Err(KinError::InvalidEvent);
    }
    Ok(text.to_owned())
}

/// A title: trimmed, one line, no control characters, 1–200 bytes.
pub fn normalize_title(title: &str) -> Result<String, KinError> {
    single_line(title, MAX_CALENDAR_TITLE_BYTES, true)
}

/// A place: as a title, but may be empty.
pub fn normalize_place(place: &str) -> Result<String, KinError> {
    single_line(place, MAX_CALENDAR_PLACE_BYTES, false)
}

/// Notes keep their lines: CRLF and CR become LF, each line's trailing white
/// space goes, and the whole is trimmed. No control characters but newline;
/// at most 2,000 bytes; may be empty.
pub fn normalize_calendar_notes(notes: &str) -> Result<String, KinError> {
    let unified = notes.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = unified.split('\n').map(str::trim_end).collect();
    let text = lines.join("\n").trim().to_owned();
    if text.len() > MAX_CALENDAR_NOTES_BYTES || text.chars().any(|c| c.is_control() && c != '\n') {
        return Err(KinError::InvalidEvent);
    }
    Ok(text)
}

/// An IANA time-zone name, checked as text only: 1–64 bytes of ASCII
/// letters, digits, `/`, `_`, `-` and `+`, with no empty path segment.
pub fn is_zone_name(zone: &str) -> bool {
    !zone.is_empty()
        && zone.len() <= MAX_ZONE_BYTES
        && zone
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b'+'))
        && zone.split('/').all(|segment| !segment.is_empty())
}

/// A source UID: 0–255 bytes, trimmed, no control characters.
pub fn is_source_uid(uid: &str) -> bool {
    uid.len() <= MAX_SOURCE_UID_BYTES && uid.trim() == uid && !uid.chars().any(char::is_control)
}

// ---------------------------------------------------------------------------
// Structure (code 2).

fn check_rule(rule: &Rule, start: CivilDate) -> bool {
    if !(1..=MAX_RULE_INTERVAL).contains(&rule.interval) || rule.week_start > 6 {
        return false;
    }
    let end_ok = match rule.end {
        RuleEnd::Never => true,
        RuleEnd::Count(count) => (1..=MAX_RULE_COUNT).contains(&count),
        RuleEnd::Until(until) => until >= start,
    };
    let by_ok = match rule.by {
        MonthlyBy::None => true,
        MonthlyBy::MonthDay(day) => day == -1 || (1..=31).contains(&day),
        MonthlyBy::NthWeekday { nth, weekday } => {
            (nth == -1 || (1..=5).contains(&nth)) && weekday <= 6
        }
    };
    let shape_ok = match rule.frequency {
        Frequency::Daily => {
            rule.by == MonthlyBy::None && rule.weekdays == 0 && rule.week_start == 0
        }
        Frequency::Weekly => {
            rule.by == MonthlyBy::None && rule.weekdays != 0 && rule.weekdays < 0x80
        }
        Frequency::Monthly | Frequency::Yearly => {
            rule.by != MonthlyBy::None && rule.weekdays == 0 && rule.week_start == 0
        }
    };
    end_ok && by_ok && shape_ok
}

/// The event's structure. `allow_zero_id` is for imported events, which the
/// host gives an ID before saving.
fn check_event(event: &CalendarEvent, allow_zero_id: bool) -> Result<(), KinError> {
    let malformed = Err(KinError::MalformedProtocol);
    if (!allow_zero_id && event.event_id.0 == [0; 16])
        || normalize_title(&event.title).ok().as_deref() != Some(event.title.as_str())
        || normalize_place(&event.place).ok().as_deref() != Some(event.place.as_str())
        || normalize_calendar_notes(&event.notes).ok().as_deref() != Some(event.notes.as_str())
        || !is_source_uid(&event.source_uid)
        || event.attendees.len() > MAX_CALENDAR_ATTENDEES
        || event.attendees.iter().any(|member| member.0 == [0; 16])
        || event.attendees.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return malformed;
    }
    let (start, span_ok) = match &event.timing {
        Timing::AllDay { start, end } => (
            *start,
            end >= start && end.day_number() - start.day_number() <= MAX_SPAN_DAYS,
        ),
        Timing::Timed { start, end, zone } => (
            start.date,
            start.minute < MINUTES_PER_DAY
                && end.minute < MINUTES_PER_DAY
                && end >= start
                && end.date.day_number() - start.date.day_number() <= MAX_SPAN_DAYS
                && (zone.is_empty() || is_zone_name(zone)),
        ),
    };
    if !span_ok || event.rule.is_some_and(|rule| !check_rule(&rule, start)) {
        return malformed;
    }
    if let Some(link) = event.link {
        if link.series_id.0 == [0; 16]
            || link.series_id == event.event_id
            || link.original.minute >= MINUTES_PER_DAY
        {
            return malformed;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Payloads.

/// The canonical kind-71 payload (72 fixed bytes, then the attendees and
/// texts):
///
/// ```text
///  0 event ID [16]
/// 16 flags u8: bit 0 all-day, 1 countdown, 2 repeats, 3 linked to a series
/// 17 attendee count u8 (0–16)
/// 18 reserved u16
/// 20 start date u32
/// 24 start minute u16 (0 when all-day)
/// 26 end minute u16 (0 when all-day)
/// 28 end date u32 (all-day: the last date, inclusive)
/// 32 rule, 16 bytes, all zero without one: frequency u8 (1 daily, 2 weekly,
///    3 monthly, 4 yearly), by u8 (0 none, 1 day of month, 2 nth weekday),
///    weekdays u8 (bit 0 Monday … 6 Sunday), week start u8, interval u16,
///    count u16 (0 none), until u32 (0 none), month day i8, nth i8,
///    nth weekday u8, reserved u8
/// 48 series ID [16] (zero unless linked)
/// 64 original start date u32, minute u16, reserved u16 (zero unless linked)
/// 72 attendee IDs [16] each, ascending
///    title, place, notes, zone, source UID: each u16 length + UTF-8
/// ```
pub fn encode_event_payload(event: &CalendarEvent) -> Result<Vec<u8>, KinError> {
    encode_event_with(event, false)
}

pub(crate) fn encode_event_with(
    event: &CalendarEvent,
    allow_zero_id: bool,
) -> Result<Vec<u8>, KinError> {
    check_event(event, allow_zero_id)?;
    let mut out = Vec::with_capacity(
        EVENT_FIXED_BYTES
            + 16 * event.attendees.len()
            + 10
            + event.title.len()
            + event.place.len()
            + event.notes.len()
            + event.zone().len()
            + event.source_uid.len(),
    );
    out.extend_from_slice(&event.event_id.0);
    let flags = u8::from(event.is_all_day())
        | (u8::from(event.countdown) << 1)
        | (u8::from(event.rule.is_some()) << 2)
        | (u8::from(event.link.is_some()) << 3);
    out.extend_from_slice(&[flags, event.attendees.len() as u8, 0, 0]);
    let (start, end) = match &event.timing {
        Timing::AllDay { start, end } => (
            CalendarTime {
                date: *start,
                minute: 0,
            },
            CalendarTime {
                date: *end,
                minute: 0,
            },
        ),
        Timing::Timed { start, end, .. } => (*start, *end),
    };
    out.extend_from_slice(&start.date.encoded().to_le_bytes());
    out.extend_from_slice(&start.minute.to_le_bytes());
    out.extend_from_slice(&end.minute.to_le_bytes());
    out.extend_from_slice(&end.date.encoded().to_le_bytes());
    let mut rule_bytes = [0u8; 16];
    if let Some(rule) = event.rule {
        rule_bytes[0] = rule.frequency as u8;
        let (by, month_day, nth, nth_weekday) = match rule.by {
            MonthlyBy::None => (0, 0, 0, 0),
            MonthlyBy::MonthDay(day) => (1, day, 0, 0),
            MonthlyBy::NthWeekday { nth, weekday } => (2, 0, nth, weekday),
        };
        rule_bytes[1] = by;
        rule_bytes[2] = rule.weekdays;
        rule_bytes[3] = rule.week_start;
        rule_bytes[4..6].copy_from_slice(&rule.interval.to_le_bytes());
        let (count, until) = match rule.end {
            RuleEnd::Never => (0, 0),
            RuleEnd::Count(count) => (count, 0),
            RuleEnd::Until(until) => (0, until.encoded()),
        };
        rule_bytes[6..8].copy_from_slice(&count.to_le_bytes());
        rule_bytes[8..12].copy_from_slice(&until.to_le_bytes());
        rule_bytes[12] = month_day as u8;
        rule_bytes[13] = nth as u8;
        rule_bytes[14] = nth_weekday;
    }
    out.extend_from_slice(&rule_bytes);
    match event.link {
        Some(link) => {
            out.extend_from_slice(&link.series_id.0);
            link.original.push(&mut out);
        }
        None => out.extend_from_slice(&[0; 24]),
    }
    for member in &event.attendees {
        out.extend_from_slice(&member.0);
    }
    for text in [
        event.title.as_str(),
        &event.place,
        &event.notes,
        event.zone(),
        &event.source_uid,
    ] {
        push_text(&mut out, text);
    }
    Ok(out)
}

fn read_time(payload: &[u8], at: usize) -> Result<CalendarTime, KinError> {
    let date = CivilDate::from_encoded(read_u32(payload, at)?)?;
    let minute = read_u16(payload, at + 4)?;
    if read_u16(payload, at + 6)? != 0 {
        return Err(KinError::MalformedProtocol);
    }
    CalendarTime::new(date, minute).ok_or(KinError::MalformedProtocol)
}

/// Decodes a kind-71 payload strictly; the result re-encodes to the same
/// bytes.
pub fn decode_event_payload(payload: &[u8]) -> Result<CalendarEvent, KinError> {
    decode_event_with(payload, false)
}

pub(crate) fn decode_event_with(
    payload: &[u8],
    allow_zero_id: bool,
) -> Result<CalendarEvent, KinError> {
    let malformed = || KinError::MalformedProtocol;
    if payload.len() < EVENT_FIXED_BYTES {
        return Err(malformed());
    }
    let event_id = CalendarEventId(read_id(payload, 0)?);
    let flags = payload[16];
    let attendee_count = usize::from(payload[17]);
    if flags > 0x0f || read_u16(payload, 18)? != 0 || attendee_count > MAX_CALENDAR_ATTENDEES {
        return Err(malformed());
    }
    let start_date = CivilDate::from_encoded(read_u32(payload, 20)?)?;
    let start_minute = read_u16(payload, 24)?;
    let end_minute = read_u16(payload, 26)?;
    let end_date = CivilDate::from_encoded(read_u32(payload, 28)?)?;
    let rule_bytes = &payload[32..48];
    let rule = if flags & 4 != 0 {
        let frequency = Frequency::from_code(rule_bytes[0]).ok_or_else(malformed)?;
        let by = match rule_bytes[1] {
            0 => MonthlyBy::None,
            1 => MonthlyBy::MonthDay(rule_bytes[12] as i8),
            2 => MonthlyBy::NthWeekday {
                nth: rule_bytes[13] as i8,
                weekday: rule_bytes[14],
            },
            _ => return Err(malformed()),
        };
        let count = read_u16(rule_bytes, 6)?;
        let until = read_u32(rule_bytes, 8)?;
        let end = match (count, until) {
            (0, 0) => RuleEnd::Never,
            (count, 0) => RuleEnd::Count(count),
            (0, until) => RuleEnd::Until(CivilDate::from_encoded(until)?),
            _ => return Err(malformed()),
        };
        Some(Rule {
            frequency,
            interval: read_u16(rule_bytes, 4)?,
            by,
            weekdays: rule_bytes[2],
            week_start: rule_bytes[3],
            end,
        })
    } else {
        None
    };
    let link = if flags & 8 != 0 {
        Some(SeriesLink {
            series_id: CalendarEventId(read_id(payload, 48)?),
            original: read_time(payload, 64)?,
        })
    } else {
        None
    };
    let mut at = EVENT_FIXED_BYTES;
    let mut attendees = Vec::with_capacity(attendee_count);
    for _ in 0..attendee_count {
        attendees.push(ActorId(read_id(payload, at)?));
        at += 16;
    }
    let title = read_text(payload, &mut at)?;
    let place = read_text(payload, &mut at)?;
    let notes = read_text(payload, &mut at)?;
    let zone = read_text(payload, &mut at)?;
    let source_uid = read_text(payload, &mut at)?;
    if at != payload.len() {
        return Err(malformed());
    }
    let timing = if flags & 1 != 0 {
        Timing::AllDay {
            start: start_date,
            end: end_date,
        }
    } else {
        Timing::Timed {
            start: CalendarTime::new(start_date, start_minute).ok_or_else(malformed)?,
            end: CalendarTime::new(end_date, end_minute).ok_or_else(malformed)?,
            zone,
        }
    };
    let event = CalendarEvent {
        event_id,
        title,
        place,
        notes,
        attendees,
        countdown: flags & 2 != 0,
        source_uid,
        timing,
        rule,
        link,
    };
    // Re-encoding catches every non-canonical field: reserved bytes, minutes
    // on an all-day event, a zone on one, rule bytes that don't belong.
    if encode_event_with(&event, allow_zero_id)? != payload {
        return Err(malformed());
    }
    Ok(event)
}

fn encode_cancel(event_id: &CalendarEventId, occurrence: Option<CalendarTime>) -> Vec<u8> {
    let mut out = Vec::with_capacity(CANCEL_PAYLOAD_BYTES);
    out.extend_from_slice(&event_id.0);
    match occurrence {
        Some(time) => {
            out.extend_from_slice(&[1, 0, 0, 0]);
            time.push(&mut out);
        }
        None => out.extend_from_slice(&[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    }
    out
}

/// The canonical payloads of kinds 71–74:
/// - 71: `encode_event_payload`.
/// - 72 and 73: event ID [16], scope u8 (1 one occurrence, 2 the series),
///   3 reserved, then the occurrence's original start date u32, minute u16
///   and reserved u16 (all zero for the series). 28 bytes.
/// - 74: colour u8 (0–11, or 255 for the default), 3 reserved. 4 bytes.
pub fn encode_payload(kind: &EventKind) -> Result<Vec<u8>, KinError> {
    match kind {
        EventKind::CalendarEventSaved(event) => encode_event_payload(event),
        EventKind::CalendarEventCancelled {
            event_id,
            occurrence,
        }
        | EventKind::CalendarEventRestored {
            event_id,
            occurrence,
        } => {
            if event_id.0 == [0; 16]
                || occurrence.is_some_and(|time| time.minute >= MINUTES_PER_DAY)
            {
                return Err(KinError::MalformedProtocol);
            }
            Ok(encode_cancel(event_id, *occurrence))
        }
        EventKind::MemberColourSet { colour } => {
            if colour.is_some_and(|colour| colour >= MEMBER_COLOURS) {
                return Err(KinError::MalformedProtocol);
            }
            Ok(vec![colour.unwrap_or(255), 0, 0, 0])
        }
        _ => Err(KinError::Internal),
    }
}

/// Decodes a kind 71–74 payload strictly; the result re-encodes to the same
/// bytes.
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<EventKind, KinError> {
    let kind = match code {
        CALENDAR_EVENT_SAVED => {
            return Ok(EventKind::CalendarEventSaved(Box::new(
                decode_event_payload(payload)?,
            )))
        }
        CALENDAR_EVENT_CANCELLED | CALENDAR_EVENT_RESTORED
            if payload.len() == CANCEL_PAYLOAD_BYTES =>
        {
            let event_id = CalendarEventId(read_id(payload, 0)?);
            let occurrence = match payload[16] {
                1 => Some(read_time(payload, 20)?),
                2 => None,
                _ => return Err(KinError::MalformedProtocol),
            };
            if code == CALENDAR_EVENT_CANCELLED {
                EventKind::CalendarEventCancelled {
                    event_id,
                    occurrence,
                }
            } else {
                EventKind::CalendarEventRestored {
                    event_id,
                    occurrence,
                }
            }
        }
        MEMBER_COLOUR_SET if payload.len() == 4 => EventKind::MemberColourSet {
            colour: (payload[0] != 255).then_some(payload[0]),
        },
        _ => return Err(KinError::MalformedProtocol),
    };
    if encode_payload(&kind)? != payload {
        return Err(KinError::MalformedProtocol);
    }
    Ok(kind)
}

// ---------------------------------------------------------------------------
// State.

/// What is cancelled of one event.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Cancellations {
    pub series: bool,
    pub occurrences: BTreeSet<CalendarTime>,
}

/// The household's calendar as replayed. Shared with finalized states.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CalendarState {
    pub events: BTreeMap<CalendarEventId, CalendarEvent>,
    /// By event ID, kept even for an event this device hasn't seen.
    pub cancellations: BTreeMap<CalendarEventId, Cancellations>,
    /// Members' chosen palette colours (0–11).
    pub colours: BTreeMap<ActorId, u8>,
}

impl CalendarState {
    pub fn event(&self, event_id: &CalendarEventId) -> Option<&CalendarEvent> {
        self.events.get(event_id)
    }

    /// The event was cancelled as a whole.
    pub fn series_cancelled(&self, event_id: &CalendarEventId) -> bool {
        self.cancellations
            .get(event_id)
            .is_some_and(|cancelled| cancelled.series)
    }

    /// Cancelled as a whole, itself or through the series it stands in for.
    pub fn hidden(&self, event: &CalendarEvent) -> bool {
        self.series_cancelled(&event.event_id)
            || event
                .link
                .is_some_and(|link| self.series_cancelled(&link.series_id))
    }

    pub fn occurrence_cancelled(&self, event_id: &CalendarEventId, start: CalendarTime) -> bool {
        self.cancellations
            .get(event_id)
            .is_some_and(|cancelled| cancelled.occurrences.contains(&start))
    }

    fn apply(&mut self, event: &EventEnvelope) {
        match &event.kind {
            EventKind::CalendarEventSaved(saved) => {
                if self.events.contains_key(&saved.event_id)
                    || self.events.len() < MAX_CALENDAR_EVENTS
                {
                    self.events.insert(saved.event_id, (**saved).clone());
                }
            }
            EventKind::CalendarEventCancelled {
                event_id,
                occurrence,
            } => {
                if !self.cancellations.contains_key(event_id)
                    && self.cancellations.len() >= 2 * MAX_CALENDAR_EVENTS
                {
                    return;
                }
                let cancelled = self.cancellations.entry(*event_id).or_default();
                match occurrence {
                    None => cancelled.series = true,
                    Some(time) => {
                        if cancelled.occurrences.len() < MAX_CANCELLED_OCCURRENCES {
                            cancelled.occurrences.insert(*time);
                        }
                    }
                }
            }
            EventKind::CalendarEventRestored {
                event_id,
                occurrence,
            } => {
                if let Some(cancelled) = self.cancellations.get_mut(event_id) {
                    match occurrence {
                        None => cancelled.series = false,
                        Some(time) => {
                            cancelled.occurrences.remove(time);
                        }
                    }
                    if !cancelled.series && cancelled.occurrences.is_empty() {
                        self.cancellations.remove(event_id);
                    }
                }
            }
            EventKind::MemberColourSet { colour } => match colour {
                Some(colour) => {
                    self.colours.insert(event.actor_id, *colour);
                }
                None => {
                    self.colours.remove(&event.actor_id);
                }
            },
            _ => {}
        }
    }

    /// Whether `kind`, authored now by `actor`, is a change this calendar
    /// accepts (code 4 otherwise):
    /// - a save adds an event under the 2,000 limit or changes one that
    ///   isn't cancelled as a whole; a link names another event that
    ///   repeats, isn't itself linked or cancelled, and has an occurrence at
    ///   the original start;
    /// - a cancel names an event that isn't cancelled as a whole, and an
    ///   occurrence it really has and that isn't cancelled yet;
    /// - a restore undoes a cancel that is in effect;
    /// - a colour changes the actor's own colour.
    pub fn check_command(&self, kind: &EventKind, actor: ActorId) -> Result<(), KinError> {
        let ok = match kind {
            EventKind::CalendarEventSaved(saved) => {
                let allowed = match self.event(&saved.event_id) {
                    Some(existing) => {
                        !self.hidden(existing) && **saved != *existing && !self.hidden(saved)
                    }
                    None => {
                        self.events.len() < MAX_CALENDAR_EVENTS
                            && !self.series_cancelled(&saved.event_id)
                            && !self.hidden(saved)
                    }
                };
                allowed
                    && saved.link.is_none_or(|link| {
                        self.event(&link.series_id).is_some_and(|series| {
                            series.rule.is_some()
                                && series.link.is_none()
                                && crate::calendar_recur::is_occurrence(series, link.original)
                        })
                    })
            }
            EventKind::CalendarEventCancelled {
                event_id,
                occurrence,
            } => self.event(event_id).is_some_and(|event| {
                !self.hidden(event)
                    && match occurrence {
                        None => true,
                        Some(time) => {
                            !self.occurrence_cancelled(event_id, *time)
                                && self
                                    .cancellations
                                    .get(event_id)
                                    .is_none_or(|c| c.occurrences.len() < MAX_CANCELLED_OCCURRENCES)
                                && crate::calendar_recur::is_occurrence(event, *time)
                        }
                    }
            }),
            EventKind::CalendarEventRestored {
                event_id,
                occurrence,
            } => {
                self.event(event_id).is_some()
                    && match occurrence {
                        None => self.series_cancelled(event_id),
                        Some(time) => {
                            !self.series_cancelled(event_id)
                                && self.occurrence_cancelled(event_id, *time)
                        }
                    }
            }
            EventKind::MemberColourSet { colour } => self.colours.get(&actor) != colour.as_ref(),
            _ => false,
        };
        if ok {
            Ok(())
        } else {
            Err(KinError::InvalidEvent)
        }
    }
}

/// Replays one calendar event into the shared state (copy-on-write).
pub fn apply(calendar: &mut Arc<CalendarState>, event: &EventEnvelope) -> Result<(), KinError> {
    if event.actor_id.0 == [0; 16] || event.device_id.0 == [0; 16] {
        return Err(KinError::InvalidEvent);
    }
    Arc::make_mut(calendar).apply(event);
    Ok(())
}
