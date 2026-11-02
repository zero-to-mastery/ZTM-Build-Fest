//! "This week" (#417, epic #416): the household's dated things for seven
//! consecutive civil days, so the host never derives dates itself.
//!
//! A read-only projection over the finalized household state. For each day
//! from the requested start date:
//! - **Items**: active items (any classification) whose planning date is that
//!   day. Completed and archived items, undated items and items planned before
//!   the start (overdue; Today shows those) are left out.
//! - **Routines**: each occurrence that opens that day, from the routine's own
//!   cadence (`Cadence::current_key` / `Cadence::next_start`). An occurrence
//!   already open on the start date is reported on the start date. Archived
//!   routines have none, and while the household mode is not Normal no
//!   routine has any (modes pause occurrences). Completion is known only for
//!   the occurrence open on the context's civil date ("current"); every other
//!   occurrence reports not done.
//! - **Meals**: the dinner planned for that day, if any, with its cook.
//! - **Maintenance**: maintenance entries, not archived and on a reference
//!   record that isn't archived, whose next date is that day. Every such
//!   entry is reported, as the reference page shows each entry's next date.
//!
//! The household mode is the one the history holds at the context's as-of;
//! a mode change is never projected into the future. Entries within a day
//! sort by text (meals have one per day), then by ID; past each cap the rest
//! of that day's entries of that kind are dropped and counted in the day's
//! omitted count. Hosts read it through `kin_week` (KWKQ -> KWKD), below.
use std::collections::BTreeMap;

use crate::error::KinError;
use crate::event::{ActorId, HouseholdMode, ItemClassification, ItemId, ResponsibilityTargetKind};
use crate::history::History;
use crate::meals::push_text;
use crate::recurrence::{Cadence, CivilDate};
use crate::request::decode_context;
use crate::state::{HouseholdState, ItemStatus};
use crate::wire::read_u32;

/// Days in a week projection.
pub const WEEK_DAYS: usize = 7;
/// Items reported per day; the rest are counted as omitted.
pub const MAX_WEEK_ITEMS_PER_DAY: usize = 64;
/// Routine occurrences reported per day; the rest are counted as omitted.
pub const MAX_WEEK_ROUTINES_PER_DAY: usize = 64;
/// Maintenance entries reported per day; the rest are counted as omitted.
pub const MAX_WEEK_MAINTENANCE_PER_DAY: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WeekItem {
    pub item_id: ItemId,
    pub classification: ItemClassification,
    pub owner: Option<ActorId>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WeekRoutine {
    pub routine_id: [u8; 16],
    /// The occurrence key (YYYYMMDD), as routine commands take it.
    pub occurrence: CivilDate,
    pub cadence: Cadence,
    /// The occurrence open on the context's civil date.
    pub current: bool,
    /// Completed; only ever true for the current occurrence.
    pub done: bool,
    pub owner: Option<ActorId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WeekMeal {
    pub recipe_id: Option<[u8; 16]>,
    pub cook: Option<ActorId>,
    /// The dinner's name as shown (meals.rs `dinner_name`).
    pub name: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WeekMaintenance {
    pub maintenance_id: [u8; 16],
    pub record_id: [u8; 16],
    pub performed_on: CivilDate,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WeekDay {
    pub date: CivilDate,
    pub items: Vec<WeekItem>,
    pub routines: Vec<WeekRoutine>,
    pub meals: Vec<WeekMeal>,
    pub maintenance: Vec<WeekMaintenance>,
    /// Entries left out by the caps above.
    pub omitted: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Week {
    pub start: CivilDate,
    /// The household mode pauses routine occurrences for the whole week.
    pub routines_paused: bool,
    pub days: Vec<WeekDay>,
}

/// The seven days from `start`, or `MalformedProtocol` when they run past
/// 9999-12-31.
fn week_dates(start: CivilDate) -> Result<[CivilDate; WEEK_DAYS], KinError> {
    let mut dates = [start; WEEK_DAYS];
    for (offset, date) in (0u32..).zip(dates.iter_mut()) {
        *date = start
            .checked_add_days(offset)
            .ok_or(KinError::MalformedProtocol)?;
    }
    Ok(dates)
}

/// Index of `date` in the week starting `start`, if it falls inside it.
fn day_index(start: CivilDate, date: CivilDate) -> Option<usize> {
    let offset = date.day_number().checked_sub(start.day_number())?;
    usize::try_from(offset)
        .ok()
        .filter(|&offset| offset < WEEK_DAYS)
}

/// Members assigned to items and routines, by the latest responsibility.
fn owners(state: &HouseholdState, kind: ResponsibilityTargetKind) -> BTreeMap<[u8; 16], ActorId> {
    state
        .responsibilities
        .iter()
        .filter(|entry| entry.target_kind == kind)
        .filter_map(|entry| Some((entry.target_id, entry.member_id?)))
        .collect()
}

/// Each day's entries of one kind, with their sort key (text, then ID).
type PerDay<'a, T> = [Vec<((&'a str, [u8; 16]), T)>; WEEK_DAYS];

/// Sorts by `key`, keeps at most `cap` and returns how many were dropped.
fn sort_and_cap<T, K: Ord>(entries: &mut Vec<(K, T)>, cap: usize) -> u32 {
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let dropped = entries.len().saturating_sub(cap);
    entries.truncate(cap);
    u32::try_from(dropped).unwrap_or(u32::MAX)
}

/// The week from `start` in `state` (finalized at the context's civil date).
pub fn week(state: &HouseholdState, start: CivilDate) -> Result<Week, KinError> {
    let dates = week_dates(start)?;
    let end = dates[WEEK_DAYS - 1];
    let item_owners = owners(state, ResponsibilityTargetKind::Item);
    let routine_owners = owners(state, ResponsibilityTargetKind::Routine);

    let mut items: PerDay<WeekItem> = Default::default();
    for item in &state.items {
        if item.status != ItemStatus::Active {
            continue;
        }
        let Some(index) = item.planning_date.and_then(|date| day_index(start, date)) else {
            continue;
        };
        items[index].push((
            (item.text.as_str(), item.item_id.0),
            WeekItem {
                item_id: item.item_id,
                classification: item.classification,
                owner: item_owners.get(&item.item_id.0).copied(),
            },
        ));
    }

    let routines_paused = state.mode != HouseholdMode::Normal;
    let mut routines: PerDay<WeekRoutine> = Default::default();
    if !routines_paused {
        for routine in state.routines.iter().filter(|routine| !routine.archived) {
            let (cadence, created_on) = (routine.cadence, routine.created_on);
            let mut push = |opens: CivilDate, key: CivilDate| {
                let Some(index) = day_index(start, opens) else {
                    return;
                };
                let current = routine.occurrence_key == Some(key);
                routines[index].push((
                    (routine.text.as_str(), routine.routine_id.0),
                    WeekRoutine {
                        routine_id: routine.routine_id.0,
                        occurrence: key,
                        cadence,
                        current,
                        done: current && routine.completed,
                        owner: routine_owners.get(&routine.routine_id.0).copied(),
                    },
                ));
            };
            // The occurrence open on the start date, then each that opens
            // later in the week, by the cadence's own next-occurrence rule.
            if let Some(key) = cadence.current_key(created_on, start) {
                push(start, key);
            }
            let mut opens = cadence.next_start(created_on, start);
            while let Some(date) = opens.filter(|date| *date <= end) {
                if let Some(key) = cadence.current_key(created_on, date) {
                    push(date, key);
                }
                opens = cadence.next_start(created_on, date);
            }
        }
    }

    let mut maintenance: PerDay<WeekMaintenance> = Default::default();
    for entry in state
        .maintenance_events
        .iter()
        .filter(|entry| !entry.archived)
    {
        let Some(index) = entry.next_on.and_then(|date| day_index(start, date)) else {
            continue;
        };
        let record_shown = state
            .reference_records
            .iter()
            .any(|record| record.record_id == entry.record_id && !record.archived);
        if record_shown {
            maintenance[index].push((
                (entry.summary.as_str(), entry.maintenance_id.0),
                WeekMaintenance {
                    maintenance_id: entry.maintenance_id.0,
                    record_id: entry.record_id.0,
                    performed_on: entry.performed_on,
                },
            ));
        }
    }

    let mut days = Vec::with_capacity(WEEK_DAYS);
    for (index, date) in dates.into_iter().enumerate() {
        let mut omitted = sort_and_cap(&mut items[index], MAX_WEEK_ITEMS_PER_DAY);
        omitted = omitted.saturating_add(sort_and_cap(
            &mut routines[index],
            MAX_WEEK_ROUTINES_PER_DAY,
        ));
        omitted = omitted.saturating_add(sort_and_cap(
            &mut maintenance[index],
            MAX_WEEK_MAINTENANCE_PER_DAY,
        ));
        let meals = state
            .meals
            .dinners
            .get(&date.encoded())
            .map(|dinner| WeekMeal {
                recipe_id: dinner.recipe_id.map(|id| id.0),
                cook: state.meals.cooks.get(&date.encoded()).copied(),
                name: state.meals.dinner_name(dinner),
            })
            .into_iter()
            .collect();
        days.push(WeekDay {
            date,
            items: items[index].iter().map(|(_, entry)| *entry).collect(),
            routines: routines[index].iter().map(|(_, entry)| *entry).collect(),
            meals,
            maintenance: maintenance[index].iter().map(|(_, entry)| *entry).collect(),
            omitted,
        });
    }
    Ok(Week {
        start,
        routines_paused,
        days,
    })
}

const ITEM_BYTES: usize = 36;
const ROUTINE_BYTES: usize = 40;
const MAINTENANCE_BYTES: usize = 36;

/// KWKD v1, the week: "KWKD", version u16 = 1, reserved u16, start date u32
/// (YYYYMMDD), day count u8 (7), flags u8 (bit 0: the household mode pauses
/// routines), reserved u16; 16 bytes. Then each day: date u32, item count
/// u16, routine count u16, meal count u8 (0 or 1), maintenance count u8,
/// omitted u16 (entries past the caps, saturating); 12 bytes, then its
/// entries in that order:
/// - item (36): item ID [16], classification u8 (0 Today, 1 Need, 2
///   Shopping, 3 Staple), flags u8 (bit 0 owner), reserved u16, owner member
///   ID [16] (zero when none);
/// - routine (40): routine ID [16], occurrence key u32, cadence u8 (as
///   KINS), flags u8 (bit 0 owner, bit 1 current, bit 2 done), reserved
///   u16, owner member ID [16] (zero when none);
/// - meal: flags u8 (bit 0 recipe, bit 1 cook), 3 reserved, recipe ID [16]
///   (zero when none), cook member ID [16] (zero when none), name as shown
///   (u16 length + UTF-8);
/// - maintenance (36): maintenance ID [16], reference record ID [16],
///   performed date u32.
pub fn encode_week(week: &Week) -> Vec<u8> {
    let size = week.days.iter().fold(16, |size, day| {
        size + 12
            + day.items.len() * ITEM_BYTES
            + day.routines.len() * ROUTINE_BYTES
            + day
                .meals
                .iter()
                .map(|meal| 38 + meal.name.len())
                .sum::<usize>()
            + day.maintenance.len() * MAINTENANCE_BYTES
    });
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(b"KWKD");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&week.start.encoded().to_le_bytes());
    // Days, items and routines are capped well inside u8 and u16.
    out.extend_from_slice(&[week.days.len() as u8, u8::from(week.routines_paused), 0, 0]);
    let owner = |owner: Option<ActorId>| owner.map_or([0; 16], |member| member.0);
    for day in &week.days {
        out.extend_from_slice(&day.date.encoded().to_le_bytes());
        out.extend_from_slice(&(day.items.len() as u16).to_le_bytes());
        out.extend_from_slice(&(day.routines.len() as u16).to_le_bytes());
        out.extend_from_slice(&[day.meals.len() as u8, day.maintenance.len() as u8]);
        out.extend_from_slice(&u16::try_from(day.omitted).unwrap_or(u16::MAX).to_le_bytes());
        for item in &day.items {
            out.extend_from_slice(&item.item_id.0);
            out.extend_from_slice(&[
                crate::state_encode::classification_code(item.classification),
                u8::from(item.owner.is_some()),
                0,
                0,
            ]);
            out.extend_from_slice(&owner(item.owner));
        }
        for routine in &day.routines {
            out.extend_from_slice(&routine.routine_id);
            out.extend_from_slice(&routine.occurrence.encoded().to_le_bytes());
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
        for meal in &day.meals {
            out.extend_from_slice(&[
                u8::from(meal.recipe_id.is_some()) | (u8::from(meal.cook.is_some()) << 1),
                0,
                0,
                0,
            ]);
            out.extend_from_slice(&meal.recipe_id.unwrap_or([0; 16]));
            out.extend_from_slice(&owner(meal.cook));
            push_text(&mut out, &meal.name);
        }
        for entry in &day.maintenance {
            out.extend_from_slice(&entry.maintenance_id);
            out.extend_from_slice(&entry.record_id);
            out.extend_from_slice(&entry.performed_on.encoded().to_le_bytes());
        }
    }
    out
}

/// KWKQ v1, the query: "KWKQ", version u16 = 1, reserved u16, start date
/// u32 (YYYYMMDD, valid, with six more days before 9999-12-31), reserved
/// u32 (0); 16 bytes, then the record-less KINE context.
pub fn decode_query(input: &[u8]) -> Result<(CivilDate, &[u8]), KinError> {
    let query = input.get(..16).ok_or(KinError::MalformedProtocol)?;
    if &query[..4] != b"KWKQ" || query[6..8] != [0, 0] || query[12..16] != [0, 0, 0, 0] {
        return Err(KinError::MalformedProtocol);
    }
    if u16::from_le_bytes([query[4], query[5]]) != 1 {
        return Err(KinError::UnsupportedVersion);
    }
    let start = CivilDate::from_encoded(read_u32(query, 8)?)?;
    week_dates(start)?;
    Ok((start, &input[16..]))
}

/// The week (`kin_week`, #417): KWKQ and the record-less KINE context
/// against the household history; publishes KWKD. "Current" and "done" are
/// judged at the context's civil date.
pub fn week_export(input: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let (start, context) = decode_query(input)?;
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    Ok(encode_week(&week(&state, start)?))
}
