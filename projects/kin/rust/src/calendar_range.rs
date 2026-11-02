//! The calendar between two civil dates (#658, ADR 0022 §1): `kin_calendar_range`,
//! KCAQ -> KCAL. Calendar, Day, Week, Month, This week and Today read it.
//!
//! One read merges, for each civil date from `from` to `to` (at most 400
//! days):
//! - **Calendar events**: each occurrence that overlaps the range (an
//!   occurrence that starts before `from` and is still going on counts),
//!   with cancellations applied, at most 5,000, earliest first. With
//!   "include cancelled", cancelled ones come too, marked, so a host can
//!   offer Restore.
//! - **The next countdown**: the first occurrence, on or after the context's
//!   civil date ("today") and within 400 days of it, of an event marked as a
//!   countdown, whether or not it falls in the range.
//! - **Member colours**: every member's chosen palette colour; members
//!   without one use the host's default by join order.
//! - **Dated items, routines and meals**, as This week has them (week.rs):
//!   active items planned on a date in the range, the routine occurrences
//!   that open in it (none while the household mode pauses routines), and
//!   the meals planned in it: dinners and, since #660, breakfast, lunch and
//!   snacks (kinds 80–81), each with its slot (no format change).
//!
//! Every event an occurrence names is included once, with its canonical
//! kind-71 payload and its cancelled occurrences, so the host decodes events
//! with the same codec it encodes them with. "All events" includes every
//! event, which editing a series and import de-duplication (by source UID)
//! need.
use std::collections::{BTreeMap, BinaryHeap};

use crate::calendar::{encode_event_payload, CalendarEvent, CalendarState, CalendarTime};
use crate::calendar_recur::for_each_start;
use crate::error::KinError;
use crate::event::{
    ActorId, CalendarEventId, HouseholdMode, ItemClassification, ItemId, ResponsibilityTargetKind,
};
use crate::history::History;
use crate::meals::push_text;
use crate::recurrence::{Cadence, CivilDate};
use crate::request::decode_context;
use crate::state::{HouseholdState, ItemStatus};
use crate::wire::read_u32;

/// Most days a query spans, `from` and `to` included.
pub const MAX_RANGE_DAYS: u32 = 400;
/// Most event occurrences one read returns; the earliest are kept.
pub const MAX_RANGE_OCCURRENCES: usize = 5_000;
/// Most dated items one read returns.
pub const MAX_RANGE_ITEMS: usize = 2_000;
/// Most routine occurrences one read returns.
pub const MAX_RANGE_ROUTINES: usize = 5_000;
/// How far after today the next countdown is looked for.
pub const COUNTDOWN_HORIZON_DAYS: u32 = 400;

/// What a KCAQ asks for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RangeQuery {
    pub from: CivilDate,
    pub to: CivilDate,
    /// Every event's definition, not only those with an occurrence here.
    pub all_events: bool,
    /// Cancelled occurrences too, marked.
    pub include_cancelled: bool,
}

/// One occurrence of a calendar event.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Occurrence {
    pub event_id: CalendarEventId,
    /// Its original start, the key cancels and restores name.
    pub start: CalendarTime,
    /// An all-day occurrence's end is its last date with minute 0.
    pub end: CalendarTime,
    pub all_day: bool,
    pub countdown: bool,
    pub cancelled: bool,
    /// The event stands in for an occurrence of a series.
    pub linked: bool,
}

impl Occurrence {
    /// Date, then all-day before timed, then time, then event ID.
    fn key(&self) -> (CivilDate, bool, u16, CalendarEventId) {
        (
            self.start.date,
            !self.all_day,
            self.start.minute,
            self.event_id,
        )
    }
}

impl Ord for Occurrence {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.key().cmp(&other.key())
    }
}

impl PartialOrd for Occurrence {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RangeItem {
    pub item_id: ItemId,
    pub date: CivilDate,
    pub classification: ItemClassification,
    pub owner: Option<ActorId>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RangeRoutine {
    pub routine_id: [u8; 16],
    /// The date the occurrence opens (the range's first date for one already
    /// open then).
    pub opens: CivilDate,
    /// The occurrence key routine commands take.
    pub key: CivilDate,
    pub cadence: Cadence,
    pub current: bool,
    pub done: bool,
    pub owner: Option<ActorId>,
}

/// A meal's slot in KCAL (its own codes; meals.rs numbers them in planner
/// order). Dinner comes from kinds 61–63, the others from kinds 80–81.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
#[repr(u8)]
pub enum MealSlot {
    Breakfast = 1,
    Lunch = 2,
    Snack = 3,
    Dinner = 4,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RangeMeal {
    pub date: CivilDate,
    pub slot: MealSlot,
    pub recipe_id: Option<[u8; 16]>,
    pub cook: Option<ActorId>,
    pub name: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CalendarRange {
    pub query: RangeQuery,
    pub today: CivilDate,
    pub occurrences: Vec<Occurrence>,
    pub occurrences_truncated: bool,
    pub next_countdown: Option<Occurrence>,
    pub items: Vec<RangeItem>,
    pub items_truncated: bool,
    pub routines: Vec<RangeRoutine>,
    pub routines_truncated: bool,
    pub routines_paused: bool,
    pub meals: Vec<RangeMeal>,
}

fn occurrence(
    calendar: &CalendarState,
    event: &CalendarEvent,
    start: CalendarTime,
) -> Option<Occurrence> {
    Some(Occurrence {
        event_id: event.event_id,
        start,
        end: event.occurrence_end(start)?,
        all_day: event.is_all_day(),
        countdown: event.countdown,
        cancelled: calendar.hidden(event) || calendar.occurrence_cancelled(&event.event_id, start),
        linked: event.link.is_some(),
    })
}

/// Whether an occurrence is still going on at some point of `from`. A timed
/// one that ends exactly at midnight ended the day before.
fn reaches(occurrence: &Occurrence, from: CivilDate) -> bool {
    occurrence.end.date > from
        || occurrence.end.date == from
            && (occurrence.all_day
                || occurrence.end.minute > 0
                || occurrence.end == occurrence.start)
}

/// Occurrences overlapping `from..=to`, earliest first, and whether some
/// were left out past `MAX_RANGE_OCCURRENCES`.
pub fn occurrences_in(
    calendar: &CalendarState,
    from: CivilDate,
    to: CivilDate,
    include_cancelled: bool,
) -> (Vec<Occurrence>, bool) {
    // A max-heap of the earliest occurrences so far: past the cap, the
    // latest is dropped, so memory stays bounded however many events repeat.
    let mut kept: BinaryHeap<Occurrence> = BinaryHeap::new();
    let mut truncated = false;
    for event in calendar.events.values() {
        if calendar.hidden(event) && !include_cancelled {
            continue;
        }
        let low = from
            .checked_sub_days(event.span_days())
            .unwrap_or_else(|| CivilDate::from_day_number(0).unwrap_or(from));
        let minute = event.start().minute;
        for_each_start(event, low, to, |date| {
            let Some(found) = occurrence(calendar, event, CalendarTime { date, minute }) else {
                return false;
            };
            if !reaches(&found, from) || found.cancelled && !include_cancelled {
                return true;
            }
            if kept.len() == MAX_RANGE_OCCURRENCES {
                truncated = true;
                if kept.peek().is_some_and(|latest| found >= *latest) {
                    // Every later occurrence of this event sorts later still.
                    return false;
                }
                kept.pop();
            }
            kept.push(found);
            true
        });
    }
    (kept.into_sorted_vec(), truncated)
}

/// The first countdown occurrence starting from `today` to 400 days on.
pub fn next_countdown(calendar: &CalendarState, today: CivilDate) -> Option<Occurrence> {
    let horizon = today
        .checked_add_days(COUNTDOWN_HORIZON_DAYS)
        .or_else(|| CivilDate::from_encoded(99_991_231).ok())
        .unwrap_or(today);
    let mut best: Option<Occurrence> = None;
    for event in calendar
        .events
        .values()
        .filter(|event| event.countdown && !calendar.hidden(event))
    {
        let minute = event.start().minute;
        let last = best.map_or(horizon, |best| best.start.date.min(horizon));
        for_each_start(event, today, last, |date| {
            match occurrence(calendar, event, CalendarTime { date, minute }) {
                Some(found) if !found.cancelled => {
                    if best.is_none_or(|best| found < best) {
                        best = Some(found);
                    }
                    false
                }
                Some(_) => true,
                None => false,
            }
        });
    }
    best
}

fn owners(state: &HouseholdState, kind: ResponsibilityTargetKind) -> BTreeMap<[u8; 16], ActorId> {
    state
        .responsibilities
        .iter()
        .filter(|entry| entry.target_kind == kind)
        .filter_map(|entry| Some((entry.target_id, entry.member_id?)))
        .collect()
}

/// Sorts by `key`, keeps at most `cap` and says whether any were dropped.
fn sort_and_cap<T, K: Ord>(entries: &mut Vec<(K, T)>, cap: usize) -> bool {
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let dropped = entries.len() > cap;
    entries.truncate(cap);
    dropped
}

fn items_in(state: &HouseholdState, from: CivilDate, to: CivilDate) -> (Vec<RangeItem>, bool) {
    let item_owners = owners(state, ResponsibilityTargetKind::Item);
    let mut items = Vec::new();
    for item in state
        .items
        .iter()
        .filter(|item| item.status == ItemStatus::Active)
    {
        let Some(date) = item.planning_date.filter(|date| (from..=to).contains(date)) else {
            continue;
        };
        items.push((
            (date, item.text.as_str(), item.item_id),
            RangeItem {
                item_id: item.item_id,
                date,
                classification: item.classification,
                owner: item_owners.get(&item.item_id.0).copied(),
            },
        ));
    }
    let truncated = sort_and_cap(&mut items, MAX_RANGE_ITEMS);
    (items.into_iter().map(|(_, item)| item).collect(), truncated)
}

fn routines_in(
    state: &HouseholdState,
    from: CivilDate,
    to: CivilDate,
) -> (Vec<RangeRoutine>, bool) {
    let routine_owners = owners(state, ResponsibilityTargetKind::Routine);
    let mut routines = Vec::new();
    for routine in state.routines.iter().filter(|routine| !routine.archived) {
        let (cadence, created_on) = (routine.cadence, routine.created_on);
        let mut push = |opens: CivilDate, key: CivilDate| {
            let current = routine.occurrence_key == Some(key);
            routines.push((
                (opens, routine.text.as_str(), routine.routine_id.0),
                RangeRoutine {
                    routine_id: routine.routine_id.0,
                    opens,
                    key,
                    cadence,
                    current,
                    done: current && routine.completed,
                    owner: routine_owners.get(&routine.routine_id.0).copied(),
                },
            ));
        };
        // As This week: the occurrence open on the first date, then each
        // that opens later, by the cadence's own rule.
        if let Some(key) = cadence.current_key(created_on, from) {
            push(from, key);
        }
        let mut opens = cadence.next_start(created_on, from);
        while let Some(date) = opens.filter(|date| *date <= to) {
            if let Some(key) = cadence.current_key(created_on, date) {
                push(date, key);
            }
            opens = cadence.next_start(created_on, date);
        }
    }
    let truncated = sort_and_cap(&mut routines, MAX_RANGE_ROUTINES);
    (
        routines.into_iter().map(|(_, routine)| routine).collect(),
        truncated,
    )
}

/// The meals planned in the range, by date then slot (breakfast, lunch,
/// snack, dinner): dinners (kinds 61–63) with their cook, and breakfast,
/// lunch and snacks (kinds 80–81, #679), each under its recipe's current
/// name as the meals view shows it. KCAL has carried the slot from v1, so
/// the other slots joined without a format change (#660).
pub fn meals_in(state: &HouseholdState, from: CivilDate, to: CivilDate) -> Vec<RangeMeal> {
    let meals = &state.meals;
    let dinners = meals
        .dinners
        .range(from.encoded()..=to.encoded())
        .map(|(date, dinner)| (*date, MealSlot::Dinner, dinner));
    let others = meals
        .slot_meals
        .range(
            (from.encoded(), crate::meals::MealSlot::Breakfast)
                ..=(to.encoded(), crate::meals::MealSlot::Snack),
        )
        .filter_map(|((date, slot), meal)| {
            let slot = match slot {
                crate::meals::MealSlot::Breakfast => MealSlot::Breakfast,
                crate::meals::MealSlot::Lunch => MealSlot::Lunch,
                crate::meals::MealSlot::Snack => MealSlot::Snack,
                // Dinners live in `dinners`; kinds 80–81 never carry one.
                crate::meals::MealSlot::Dinner => return None,
            };
            Some((*date, slot, meal))
        });
    let mut planned: Vec<(u32, MealSlot, &crate::meals::Dinner)> = dinners.chain(others).collect();
    planned.sort_by_key(|(date, slot, _)| (*date, *slot));
    planned
        .into_iter()
        .filter_map(|(date, slot, meal)| {
            Some(RangeMeal {
                date: CivilDate::from_encoded(date).ok()?,
                slot,
                recipe_id: meal.recipe_id.map(|id| id.0),
                cook: (slot == MealSlot::Dinner)
                    .then(|| meals.cooks.get(&date).copied())
                    .flatten(),
                name: meals.dinner_name(meal),
            })
        })
        .collect()
}

/// The range in `state`, finalized at the context's civil date (`today`).
pub fn calendar_range(
    state: &HouseholdState,
    query: RangeQuery,
    today: CivilDate,
) -> CalendarRange {
    let calendar = &state.calendar;
    let (occurrences, occurrences_truncated) =
        occurrences_in(calendar, query.from, query.to, query.include_cancelled);
    let (items, items_truncated) = items_in(state, query.from, query.to);
    let routines_paused = state.mode != HouseholdMode::Normal;
    let (routines, routines_truncated) = if routines_paused {
        (Vec::new(), false)
    } else {
        routines_in(state, query.from, query.to)
    };
    CalendarRange {
        query,
        today,
        occurrences,
        occurrences_truncated,
        next_countdown: next_countdown(calendar, today),
        items,
        items_truncated,
        routines,
        routines_truncated,
        routines_paused,
        meals: meals_in(state, query.from, query.to),
    }
}

pub const OCCURRENCE_BYTES: usize = 20;
pub const COLOUR_BYTES: usize = 20;
pub const ITEM_BYTES: usize = 40;
pub const ROUTINE_BYTES: usize = 44;
pub const KCAL_HEADER_BYTES: usize = 48;

fn push_occurrence(out: &mut Vec<u8>, index: u32, occurrence: &Occurrence) {
    out.extend_from_slice(&index.to_le_bytes());
    out.extend_from_slice(&occurrence.start.date.encoded().to_le_bytes());
    out.extend_from_slice(&occurrence.start.minute.to_le_bytes());
    out.push(
        u8::from(occurrence.all_day)
            | (u8::from(occurrence.countdown) << 1)
            | (u8::from(occurrence.cancelled) << 2)
            | (u8::from(occurrence.linked) << 3),
    );
    out.push(0);
    out.extend_from_slice(&occurrence.end.date.encoded().to_le_bytes());
    out.extend_from_slice(&occurrence.end.minute.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
}

/// KCAL v1, the calendar range:
///
/// ```text
///  0 "KCAL", version u16 = 1, reserved u16
///  8 from u32, to u32, today u32 (YYYYMMDD)
/// 20 flags u32: bit 0 occurrences past 5,000 left out, 1 items past 2,000
///    left out, 2 routine occurrences past 5,000 left out, 3 the household
///    mode pauses routines, 4 a next countdown follows
/// 24 colour, event, occurrence, item, routine and meal counts, u32 each
/// 48 the next countdown, one occurrence record (20 zero bytes when none)
/// 68 colours, 20 bytes each in member order: member ID [16], colour u8
///    (0–11), 3 reserved
///    events in event-ID order: flags u8 (bit 0 cancelled as a whole, 1
///    cancelled through its series), reserved u8, cancelled occurrence
///    count u16, payload length u32, each cancelled original start (date
///    u32, minute u16, reserved u16; ascending), the canonical kind-71
///    payload
///    occurrences, 20 bytes each, earliest first: event index u32 (into the
///    events above), start date u32, start minute u16, flags u8 (bit 0
///    all-day, 1 countdown, 2 cancelled, 3 stands in for an occurrence of a
///    series), reserved u8, end date u32, end minute u16, reserved u16
///    items, 40 bytes each by date then text: item ID [16], date u32,
///    classification u8, flags u8 (bit 0 owner), reserved u16, owner [16]
///    routines, 44 bytes each by date then text: routine ID [16], opens u32,
///    occurrence key u32, cadence u8, flags u8 (bit 0 owner, 1 current,
///    2 done), reserved u16, owner [16]
///    meals by date then slot: date u32, slot u8 (1 breakfast, 2 lunch,
///    3 snack, 4 dinner), flags u8 (bit 0 recipe, 1 cook), reserved u16,
///    recipe ID [16], cook [16] (zero when none), name u16 + UTF-8
/// ```
pub fn encode_range(calendar: &CalendarState, range: &CalendarRange) -> Result<Vec<u8>, KinError> {
    // The events to describe, in ID order, and each one's index.
    let mut wanted: BTreeMap<CalendarEventId, u32> = BTreeMap::new();
    if range.query.all_events {
        wanted.extend(calendar.events.keys().map(|id| (*id, 0)));
    } else {
        wanted.extend(range.occurrences.iter().map(|found| (found.event_id, 0)));
        wanted.extend(range.next_countdown.map(|found| (found.event_id, 0)));
    }
    for (index, value) in wanted.values_mut().enumerate() {
        *value = index as u32;
    }
    let mut payloads = Vec::with_capacity(wanted.len());
    for id in wanted.keys() {
        let event = calendar.event(id).ok_or(KinError::Internal)?;
        payloads.push((event, encode_event_payload(event)?));
    }
    let size = KCAL_HEADER_BYTES
        + OCCURRENCE_BYTES
        + COLOUR_BYTES * calendar.colours.len()
        + payloads
            .iter()
            .map(|(event, payload)| {
                8 + payload.len()
                    + 8 * calendar
                        .cancellations
                        .get(&event.event_id)
                        .map_or(0, |cancelled| cancelled.occurrences.len())
            })
            .sum::<usize>()
        + OCCURRENCE_BYTES * range.occurrences.len()
        + ITEM_BYTES * range.items.len()
        + ROUTINE_BYTES * range.routines.len()
        + range
            .meals
            .iter()
            .map(|meal| 42 + meal.name.len())
            .sum::<usize>();
    let mut out = Vec::new();
    out.try_reserve_exact(size)
        .map_err(|_| KinError::SizeLimit)?;
    out.extend_from_slice(b"KCAL");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    for date in [range.query.from, range.query.to, range.today] {
        out.extend_from_slice(&date.encoded().to_le_bytes());
    }
    let flags = u32::from(range.occurrences_truncated)
        | (u32::from(range.items_truncated) << 1)
        | (u32::from(range.routines_truncated) << 2)
        | (u32::from(range.routines_paused) << 3)
        | (u32::from(range.next_countdown.is_some()) << 4);
    out.extend_from_slice(&flags.to_le_bytes());
    for count in [
        calendar.colours.len(),
        payloads.len(),
        range.occurrences.len(),
        range.items.len(),
        range.routines.len(),
        range.meals.len(),
    ] {
        out.extend_from_slice(
            &u32::try_from(count)
                .map_err(|_| KinError::SizeLimit)?
                .to_le_bytes(),
        );
    }
    match range.next_countdown {
        Some(found) => push_occurrence(&mut out, wanted[&found.event_id], &found),
        None => out.extend_from_slice(&[0; OCCURRENCE_BYTES]),
    }
    for (member, colour) in &calendar.colours {
        out.extend_from_slice(&member.0);
        out.extend_from_slice(&[*colour, 0, 0, 0]);
    }
    for (event, payload) in &payloads {
        let cancelled = calendar.cancellations.get(&event.event_id);
        let starts = cancelled.map_or(0, |cancelled| cancelled.occurrences.len());
        let own = calendar.series_cancelled(&event.event_id);
        let through_series = !own && calendar.hidden(event);
        out.extend_from_slice(&[u8::from(own) | (u8::from(through_series) << 1), 0]);
        out.extend_from_slice(&(starts as u16).to_le_bytes());
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        for start in cancelled
            .iter()
            .flat_map(|cancelled| &cancelled.occurrences)
        {
            start.push(&mut out);
        }
        out.extend_from_slice(payload);
    }
    for found in &range.occurrences {
        push_occurrence(&mut out, wanted[&found.event_id], found);
    }
    let owner = |owner: Option<ActorId>| owner.map_or([0; 16], |member| member.0);
    for item in &range.items {
        out.extend_from_slice(&item.item_id.0);
        out.extend_from_slice(&item.date.encoded().to_le_bytes());
        out.extend_from_slice(&[
            crate::state_encode::classification_code(item.classification),
            u8::from(item.owner.is_some()),
            0,
            0,
        ]);
        out.extend_from_slice(&owner(item.owner));
    }
    for routine in &range.routines {
        out.extend_from_slice(&routine.routine_id);
        out.extend_from_slice(&routine.opens.encoded().to_le_bytes());
        out.extend_from_slice(&routine.key.encoded().to_le_bytes());
        out.extend_from_slice(&[
            routine.cadence as u8,
            u8::from(routine.owner.is_some())
                | (u8::from(routine.current) << 1)
                | (u8::from(routine.done) << 2),
            0,
            0,
        ]);
        out.extend_from_slice(&owner(routine.owner));
    }
    for meal in &range.meals {
        out.extend_from_slice(&meal.date.encoded().to_le_bytes());
        out.extend_from_slice(&[
            meal.slot as u8,
            u8::from(meal.recipe_id.is_some()) | (u8::from(meal.cook.is_some()) << 1),
            0,
            0,
        ]);
        out.extend_from_slice(&meal.recipe_id.unwrap_or([0; 16]));
        out.extend_from_slice(&owner(meal.cook));
        push_text(&mut out, &meal.name);
    }
    Ok(out)
}

/// KCAQ v1, the query: "KCAQ", version u16 = 1, reserved u16, from u32, to
/// u32 (valid dates, from <= to, at most 400 days together), flags u32 (bit
/// 0 every event's definition, bit 1 cancelled occurrences too; the rest
/// zero); 20 bytes, then the record-less KINE context.
pub fn decode_query(input: &[u8]) -> Result<(RangeQuery, &[u8]), KinError> {
    let query = input.get(..20).ok_or(KinError::MalformedProtocol)?;
    if &query[..4] != b"KCAQ" || query[6..8] != [0, 0] {
        return Err(KinError::MalformedProtocol);
    }
    if u16::from_le_bytes([query[4], query[5]]) != 1 {
        return Err(KinError::UnsupportedVersion);
    }
    let from = CivilDate::from_encoded(read_u32(query, 8)?)?;
    let to = CivilDate::from_encoded(read_u32(query, 12)?)?;
    let flags = read_u32(query, 16)?;
    if to < from || to.day_number() - from.day_number() >= MAX_RANGE_DAYS || flags > 3 {
        return Err(KinError::MalformedProtocol);
    }
    Ok((
        RangeQuery {
            from,
            to,
            all_events: flags & 1 != 0,
            include_cancelled: flags & 2 != 0,
        },
        &input[20..],
    ))
}

/// The calendar range (`kin_calendar_range`): KCAQ and the record-less KINE
/// context against the household history; publishes KCAL.
pub fn calendar_range_export(input: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let (query, context) = decode_query(input)?;
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    encode_range(
        &state.calendar,
        &calendar_range(&state, query, context.civil_date),
    )
}
