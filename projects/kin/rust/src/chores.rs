//! The chore chart (#676, ADR 0022 §6): weekly points for children, rewards,
//! and adults who chose to join.
//!
//! **Kinds** (household log, additive):
//! - 77 `CHORE_POINTS_SET`: a routine's points per completion, 0–10. A
//!   routine nobody set is worth `DEFAULT_CHORE_POINTS` (1); items are always
//!   worth 1.
//! - 78 `CHORE_REWARD_SET`: a member's reward goal, 1–1000 points with a text
//!   of 1–120 bytes ("Movie night"); goal 0 with no text clears it.
//! - 79 `CHORE_CHART_JOINED`: a member joins (true) or leaves (false) the
//!   chart. Only the member it names may say so: replay records an event from
//!   anyone else with no effect, and commands refuse it (code 4).
//!
//! Payloads are strict, as for store sections: they decode only if they
//! re-encode to the same bytes (code 2). Replay never fails on a decoded event
//! once its author is a real member and device. Commands enforce the rest
//! (code 4): a points change names a routine that exists and isn't archived,
//! and every change must change something. Who may set points and rewards
//! (Adults) and who may join (Adults, once a household admin allows it) are
//! the host's checks: Rust does not know member kinds or service settings.
//!
//! **Credit.** Replay remembers each completion that is in effect, with the
//! member it is credited to and its time: an item's completion goes to the
//! item's responsibility, a routine occurrence's to the routine's owner at
//! that moment — whose turn it was, for a rotating routine, before the turn
//! passes. Reopening removes the credit, so Undo takes the point back. The
//! person who ticked it is never credited for being the one who ticked it
//! (a parent ticking off a child's chore on the kitchen display).
//!
//! **The week** is Monday to Sunday in civil dates. The host knows the time
//! zone, so the query carries the eight instants that start each day of the
//! week and the following Monday; a completion belongs to the day whose span
//! holds its time. Points are counted for completions inside the week only,
//! so the totals start again every Monday and nothing older is reported.
//! There are no streaks and no history beyond the current week.
//!
//! Hosts read the chart through `kin_chore_chart` (KCCQ -> KCCD), below.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::error::KinError;
use crate::event::{
    ActorId, EventEnvelope, EventKind, HouseholdMode, ItemClassification, ItemId,
    ResponsibilityTargetKind, RoutineId,
};
use crate::meals::{push_text, read_text};
use crate::recurrence::CivilDate;
use crate::request::decode_context;
use crate::state::{HouseholdState, ItemStatus, RoutineState};
use crate::wire::{read_i64, read_id, read_u16, read_u32};

pub const CHORE_POINTS_SET: u16 = 77;
pub const CHORE_REWARD_SET: u16 = 78;
pub const CHORE_CHART_JOINED: u16 = 79;

/// Points per completed routine occurrence when nobody set them; every item.
pub const DEFAULT_CHORE_POINTS: u8 = 1;
pub const MAX_CHORE_POINTS: u8 = 10;
pub const MAX_REWARD_GOAL: u16 = 1000;
pub const MAX_REWARD_TEXT_BYTES: usize = 120;
/// Members a chart query may name.
pub const MAX_CHART_MEMBERS: usize = 32;
/// Chores reported per member; the rest are dropped (latest days last).
pub const MAX_CHART_CHORES: usize = 200;
/// Days in the chart's week.
pub const CHART_DAYS: usize = 7;

pub const fn is_chore_code(code: u16) -> bool {
    matches!(
        code,
        CHORE_POINTS_SET | CHORE_REWARD_SET | CHORE_CHART_JOINED
    )
}

/// A member's reward: reach `goal` points this week for `text`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChoreReward {
    pub goal: u16,
    pub text: String,
}

/// What a completion credits: an item, or one routine occurrence by key.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum CreditKey {
    Item(ItemId),
    Routine(RoutineId, CivilDate),
}

/// A completion in effect: who it is credited to (nobody, for a chore with
/// no owner) and the completing event's time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Credit {
    pub member: Option<ActorId>,
    pub at: i64,
}

/// The chart's settings and the completions in effect. Shared with
/// finalized states.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ChoresState {
    /// Routines whose points differ from the default.
    pub points: BTreeMap<RoutineId, u8>,
    pub rewards: BTreeMap<ActorId, ChoreReward>,
    /// Members who joined the chart themselves (kind 79).
    pub joined: BTreeSet<ActorId>,
    pub credits: BTreeMap<CreditKey, Credit>,
}

impl ChoresState {
    /// A routine's points per completed occurrence.
    pub fn routine_points(&self, routine_id: &RoutineId) -> u8 {
        self.points
            .get(routine_id)
            .copied()
            .unwrap_or(DEFAULT_CHORE_POINTS)
    }

    fn apply(&mut self, event: &EventEnvelope) {
        match &event.kind {
            EventKind::ChorePointsSet { routine_id, points } => {
                if *points == DEFAULT_CHORE_POINTS {
                    self.points.remove(routine_id);
                } else {
                    self.points.insert(*routine_id, *points);
                }
            }
            EventKind::ChoreRewardSet {
                member_id,
                goal,
                text,
            } => {
                if *goal == 0 {
                    self.rewards.remove(member_id);
                } else {
                    self.rewards.insert(
                        *member_id,
                        ChoreReward {
                            goal: *goal,
                            text: text.clone(),
                        },
                    );
                }
            }
            EventKind::ChoreChartJoined { member_id, joined } => {
                // Only the member it names may join or leave (module docs).
                if event.actor_id != *member_id {
                    return;
                }
                if *joined {
                    self.joined.insert(*member_id);
                } else {
                    self.joined.remove(member_id);
                }
            }
            _ => {}
        }
    }

    /// Whether `kind`, authored now by `actor`, is a change this chart
    /// accepts. Who may author points and rewards is the host's check.
    pub fn check_command(
        &self,
        kind: &EventKind,
        actor: ActorId,
        routines: &[RoutineState],
    ) -> Result<(), KinError> {
        let changes = match kind {
            EventKind::ChorePointsSet { routine_id, points } => {
                check_points(*points)?;
                routines
                    .iter()
                    .any(|routine| routine.routine_id == *routine_id && !routine.archived)
                    && self.routine_points(routine_id) != *points
            }
            EventKind::ChoreRewardSet {
                member_id,
                goal,
                text,
            } => {
                check_reward(*member_id, *goal, text)?;
                match self.rewards.get(member_id) {
                    Some(reward) => reward.goal != *goal || reward.text != *text,
                    None => *goal != 0,
                }
            }
            EventKind::ChoreChartJoined { member_id, joined } => {
                check_member(*member_id)?;
                actor == *member_id && self.joined.contains(member_id) != *joined
            }
            _ => return Err(KinError::InvalidEvent),
        };
        if changes {
            Ok(())
        } else {
            Err(KinError::InvalidEvent)
        }
    }
}

/// Replays one chore-chart event into the shared state (copy-on-write).
pub fn apply(chores: &mut Arc<ChoresState>, event: &EventEnvelope) -> Result<(), KinError> {
    if event.actor_id.0 == [0; 16] || event.device_id.0 == [0; 16] {
        return Err(KinError::InvalidEvent);
    }
    Arc::make_mut(chores).apply(event);
    Ok(())
}

/// A completion took effect (replay/items.rs, replay/routines.rs): credit it
/// to `member`, replacing an earlier credit for the same chore.
pub fn credit(chores: &mut Arc<ChoresState>, key: CreditKey, member: Option<ActorId>, at: i64) {
    Arc::make_mut(chores)
        .credits
        .insert(key, Credit { member, at });
}

/// A completion was reopened: its credit goes.
pub fn uncredit(chores: &mut Arc<ChoresState>, key: CreditKey) {
    if chores.credits.contains_key(&key) {
        Arc::make_mut(chores).credits.remove(&key);
    }
}

fn check_points(points: u8) -> Result<(), KinError> {
    if points > MAX_CHORE_POINTS {
        return Err(KinError::MalformedProtocol);
    }
    Ok(())
}

fn check_member(member: ActorId) -> Result<(), KinError> {
    if member.0 == [0; 16] {
        return Err(KinError::MalformedProtocol);
    }
    Ok(())
}

/// A reward text in canonical form: trimmed (as `str::trim`), 1–120 UTF-8
/// bytes, no control characters.
pub fn normalize_reward_text(text: &str) -> Result<String, KinError> {
    let text = text.trim();
    if text.is_empty() || text.len() > MAX_REWARD_TEXT_BYTES || text.chars().any(char::is_control) {
        return Err(KinError::InvalidEvent);
    }
    Ok(text.to_owned())
}

/// A reward is a goal of 1–1000 with a canonical text, or the clear (goal 0,
/// no text). Code 2: the payload isn't canonical.
fn check_reward(member: ActorId, goal: u16, text: &str) -> Result<(), KinError> {
    check_member(member)?;
    let valid = if goal == 0 {
        text.is_empty()
    } else {
        goal <= MAX_REWARD_GOAL && normalize_reward_text(text).ok().as_deref() == Some(text)
    };
    if valid {
        Ok(())
    } else {
        Err(KinError::MalformedProtocol)
    }
}

/// The canonical payloads:
/// - 77: routine ID [16], points u8, three reserved; 20 bytes.
/// - 78: member ID [16], goal u16, reserved u16, text (u16 length + UTF-8;
///   0 when cleared).
/// - 79: member ID [16], joined u8 (1 or 0), three reserved; 20 bytes.
pub fn encode_payload(kind: &EventKind) -> Result<Vec<u8>, KinError> {
    match kind {
        EventKind::ChorePointsSet { routine_id, points } => {
            if routine_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            check_points(*points)?;
            let mut out = Vec::with_capacity(20);
            out.extend_from_slice(&routine_id.0);
            out.extend_from_slice(&[*points, 0, 0, 0]);
            Ok(out)
        }
        EventKind::ChoreRewardSet {
            member_id,
            goal,
            text,
        } => {
            check_reward(*member_id, *goal, text)?;
            let mut out = Vec::with_capacity(22 + text.len());
            out.extend_from_slice(&member_id.0);
            out.extend_from_slice(&goal.to_le_bytes());
            out.extend_from_slice(&[0, 0]);
            push_text(&mut out, text);
            Ok(out)
        }
        EventKind::ChoreChartJoined { member_id, joined } => {
            check_member(*member_id)?;
            let mut out = Vec::with_capacity(20);
            out.extend_from_slice(&member_id.0);
            out.extend_from_slice(&[u8::from(*joined), 0, 0, 0]);
            Ok(out)
        }
        _ => Err(KinError::Internal),
    }
}

/// Decodes a kind 77–79 payload strictly; the result re-encodes to the same
/// bytes.
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<EventKind, KinError> {
    let kind = match code {
        CHORE_POINTS_SET => {
            if payload.len() != 20 || payload[17..20] != [0, 0, 0] {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ChorePointsSet {
                routine_id: RoutineId(read_id(payload, 0)?),
                points: payload[16],
            }
        }
        CHORE_REWARD_SET => {
            if payload.len() < 22 || payload[18..20] != [0, 0] {
                return Err(KinError::MalformedProtocol);
            }
            let mut at = 20;
            let text = read_text(payload, &mut at)?;
            if at != payload.len() {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ChoreRewardSet {
                member_id: ActorId(read_id(payload, 0)?),
                goal: read_u16(payload, 16)?,
                text,
            }
        }
        CHORE_CHART_JOINED => {
            if payload.len() != 20 || payload[16] > 1 || payload[17..20] != [0, 0, 0] {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ChoreChartJoined {
                member_id: ActorId(read_id(payload, 0)?),
                joined: payload[16] == 1,
            }
        }
        _ => return Err(KinError::MalformedProtocol),
    };
    if encode_payload(&kind)? != payload {
        return Err(KinError::MalformedProtocol);
    }
    Ok(kind)
}

/// Who a chart query names: a child (Limited member) is always on the chart;
/// an Adult only when a household admin allows adults and they joined.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChartMemberKind {
    Child = 1,
    Adult = 2,
}

/// The query: the week, its day boundaries, whether adults may join, and the
/// household's children and Adults in the host's order (join order).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChartQuery {
    pub start: CivilDate,
    /// The instants (ms) that start each day, Monday first, and the
    /// following Monday: day `n` is `[bounds[n], bounds[n + 1])`.
    pub bounds: [i64; CHART_DAYS + 1],
    pub adults_allowed: bool,
    pub members: Vec<(ActorId, ChartMemberKind)>,
}

impl ChartQuery {
    /// The index of the day holding instant `at`, if it falls in the week.
    fn day_of(&self, at: i64) -> Option<usize> {
        (0..CHART_DAYS).find(|&day| self.bounds[day] <= at && at < self.bounds[day + 1])
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChoreKind {
    Item = 1,
    Routine = 2,
}

/// One chore on a member's chart.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Chore {
    pub kind: ChoreKind,
    pub id: [u8; 16],
    /// The day it shows on: an item's planned day (today for undated or
    /// overdue items), the day it was done; a routine occurrence's opening
    /// day.
    pub date: CivilDate,
    /// The occurrence key a routine command takes; `None` for an item.
    pub occurrence: Option<CivilDate>,
    pub done: bool,
    /// It can be ticked (or unticked) today: an item on today, or the
    /// routine's current occurrence.
    pub today: bool,
    pub points: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChartMember {
    pub member: ActorId,
    pub kind: ChartMemberKind,
    /// Points for completions credited to the member this week.
    pub points: u32,
    pub reward: Option<ChoreReward>,
    pub chores: Vec<Chore>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Chart {
    pub start: CivilDate,
    pub today: CivilDate,
    pub routines_paused: bool,
    /// Live routines whose points differ from the default, in ID order.
    pub points: Vec<(RoutineId, u8)>,
    pub members: Vec<ChartMember>,
}

/// The member an item or routine is assigned to, by the latest
/// responsibility (a rotating routine's is whoever's turn it is).
fn owner(
    state: &HouseholdState,
    kind: ResponsibilityTargetKind,
    target: [u8; 16],
) -> Option<ActorId> {
    state
        .responsibilities
        .iter()
        .find(|entry| entry.target_kind == kind && entry.target_id == target)
        .and_then(|entry| entry.member_id)
}

/// The chart for `query` in `state`, finalized at `today` (which must lie in
/// the query's week).
pub fn chart(
    state: &HouseholdState,
    query: &ChartQuery,
    today: CivilDate,
) -> Result<Chart, KinError> {
    let mut dates = [query.start; CHART_DAYS];
    for (offset, date) in (0u32..).zip(dates.iter_mut()) {
        *date = query
            .start
            .checked_add_days(offset)
            .ok_or(KinError::MalformedProtocol)?;
    }
    let end = dates[CHART_DAYS - 1];
    if today < query.start || today > end {
        return Err(KinError::MalformedProtocol);
    }
    let chores = &state.chores;
    let on_chart: Vec<(ActorId, ChartMemberKind)> = query
        .members
        .iter()
        .copied()
        .filter(|(member, kind)| match kind {
            ChartMemberKind::Child => true,
            ChartMemberKind::Adult => query.adults_allowed && chores.joined.contains(member),
        })
        .collect();
    let mut lists: BTreeMap<ActorId, Vec<(Chore, &str)>> = on_chart
        .iter()
        .map(|(member, _)| (*member, Vec::new()))
        .collect();
    let mut points: BTreeMap<ActorId, u32> = BTreeMap::new();
    let credited_day = |credit: &Credit| query.day_of(credit.at).map(|day| dates[day]);

    // Points: every completion in effect whose time falls in the week.
    for (key, credit) in &chores.credits {
        let (Some(member), Some(_)) = (credit.member, credited_day(credit)) else {
            continue;
        };
        if !lists.contains_key(&member) {
            continue;
        }
        let value = match key {
            CreditKey::Item(_) => DEFAULT_CHORE_POINTS,
            CreditKey::Routine(routine_id, _) => chores.routine_points(routine_id),
        };
        *points.entry(member).or_default() += u32::from(value);
    }

    // Items: open ones assigned to the member (undated or overdue show
    // today, planned ones on their day this week); done ones on the day they
    // were done this week, for whoever they were credited to.
    for item in &state.items {
        if item.classification == ItemClassification::Staple {
            continue;
        }
        let (member, date, done) = match item.status {
            ItemStatus::Active => {
                let date = match item.planning_date {
                    Some(date) if date > end => continue,
                    Some(date) if date > today => date,
                    _ => today,
                };
                let Some(member) = owner(state, ResponsibilityTargetKind::Item, item.item_id.0)
                else {
                    continue;
                };
                (member, date, false)
            }
            ItemStatus::Completed => {
                let Some(credit) = chores.credits.get(&CreditKey::Item(item.item_id)) else {
                    continue;
                };
                let (Some(member), Some(date)) = (credit.member, credited_day(credit)) else {
                    continue;
                };
                (member, date, true)
            }
            ItemStatus::Archived => continue,
        };
        if let Some(list) = lists.get_mut(&member) {
            list.push((
                Chore {
                    kind: ChoreKind::Item,
                    id: item.item_id.0,
                    date,
                    occurrence: None,
                    done,
                    today: date == today,
                    points: DEFAULT_CHORE_POINTS,
                },
                item.text.as_str(),
            ));
        }
    }

    // Routines: each occurrence that opens this week (as This week, week.rs).
    // A done one is on its credited member's chart. An open one is on the
    // owner's: every open occurrence of a routine with a fixed owner, but
    // only the current one of a rotating routine, since later turns aren't
    // known yet. While the household mode pauses routines, only done ones
    // show.
    let routines_paused = state.mode != HouseholdMode::Normal;
    for routine in state.routines.iter().filter(|routine| !routine.archived) {
        let rotating = state.rotations.is_rotating(&routine.routine_id);
        let routine_owner = owner(
            state,
            ResponsibilityTargetKind::Routine,
            routine.routine_id.0,
        );
        let value = chores.routine_points(&routine.routine_id);
        let (cadence, created_on) = (routine.cadence, routine.created_on);
        let mut occurrences: Vec<(CivilDate, CivilDate)> = Vec::new();
        if let Some(key) = cadence.current_key(created_on, query.start) {
            occurrences.push((query.start, key));
        }
        let mut opens = cadence.next_start(created_on, query.start);
        while let Some(date) = opens.filter(|date| *date <= end) {
            if let Some(key) = cadence.current_key(created_on, date) {
                occurrences.push((date, key));
            }
            opens = cadence.next_start(created_on, date);
        }
        for (date, key) in occurrences {
            let current = routine.occurrence_key == Some(key) && !routines_paused;
            let credit = chores
                .credits
                .get(&CreditKey::Routine(routine.routine_id, key));
            let member = match credit {
                Some(credit) => credit.member,
                None if routines_paused || (rotating && !current) => None,
                None => routine_owner,
            };
            let Some(list) = member.and_then(|member| lists.get_mut(&member)) else {
                continue;
            };
            list.push((
                Chore {
                    kind: ChoreKind::Routine,
                    id: routine.routine_id.0,
                    date,
                    occurrence: Some(key),
                    done: credit.is_some(),
                    today: current,
                    points: value,
                },
                routine.text.as_str(),
            ));
        }
    }

    let members = on_chart
        .into_iter()
        .map(|(member, kind)| {
            let mut list = lists.remove(&member).unwrap_or_default();
            list.sort_by(|(left, left_text), (right, right_text)| {
                left.date
                    .cmp(&right.date)
                    .then_with(|| (left.kind as u8).cmp(&(right.kind as u8)))
                    .then_with(|| left_text.cmp(right_text))
                    .then_with(|| left.id.cmp(&right.id))
                    .then_with(|| left.occurrence.cmp(&right.occurrence))
            });
            list.truncate(MAX_CHART_CHORES);
            ChartMember {
                member,
                kind,
                points: points.get(&member).copied().unwrap_or(0),
                reward: chores.rewards.get(&member).cloned(),
                chores: list.into_iter().map(|(chore, _)| chore).collect(),
            }
        })
        .collect();
    let live = |routine_id: &RoutineId| {
        state
            .routines
            .iter()
            .any(|routine| routine.routine_id == *routine_id && !routine.archived)
    };
    Ok(Chart {
        start: query.start,
        today,
        routines_paused,
        points: chores
            .points
            .iter()
            .filter(|(routine_id, _)| live(routine_id))
            .map(|(routine_id, points)| (*routine_id, *points))
            .collect(),
        members,
    })
}

/// KCCQ v1, the query: "KCCQ", version u16 = 1, reserved u16, week start
/// u32 (a Monday, YYYYMMDD), flags u8 (bit 0: a household admin allows
/// adults on the chart), three reserved, then eight day boundaries i64 (ms;
/// each Monday–Sunday day's first instant and the next Monday's, strictly
/// increasing, each day 1–25 hours long), member count u16, reserved u16;
/// 84 bytes. Then each member: ID [16], kind u8 (1 child, 2 Adult), three
/// reserved; 20 bytes each, at most 32, distinct and non-zero. Then the
/// record-less KINE context.
pub fn decode_query(input: &[u8]) -> Result<(ChartQuery, &[u8]), KinError> {
    const HEADER: usize = 84;
    let header = input.get(..HEADER).ok_or(KinError::MalformedProtocol)?;
    if &header[..4] != b"KCCQ" || header[6..8] != [0, 0] || header[13..16] != [0, 0, 0] {
        return Err(KinError::MalformedProtocol);
    }
    if u16::from_le_bytes([header[4], header[5]]) != 1 {
        return Err(KinError::UnsupportedVersion);
    }
    let start = CivilDate::from_encoded(read_u32(header, 8)?)?;
    if start.monday() != start || start.checked_add_days(CHART_DAYS as u32).is_none() {
        return Err(KinError::MalformedProtocol);
    }
    if header[12] > 1 || header[82..84] != [0, 0] {
        return Err(KinError::MalformedProtocol);
    }
    let mut bounds = [0i64; CHART_DAYS + 1];
    for (index, bound) in bounds.iter_mut().enumerate() {
        *bound = read_i64(header, 16 + index * 8)?;
    }
    const HOUR: i64 = 3_600_000;
    if !bounds.windows(2).all(|pair| {
        pair[1]
            .checked_sub(pair[0])
            .is_some_and(|span| (HOUR..=25 * HOUR).contains(&span))
    }) {
        return Err(KinError::MalformedProtocol);
    }
    let count = usize::from(read_u16(header, 80)?);
    if count > MAX_CHART_MEMBERS {
        return Err(KinError::MalformedProtocol);
    }
    let end = HEADER + count * 20;
    let entries = input.get(HEADER..end).ok_or(KinError::MalformedProtocol)?;
    let mut members: Vec<(ActorId, ChartMemberKind)> = Vec::with_capacity(count);
    for entry in entries.chunks_exact(20) {
        let member = ActorId(read_id(entry, 0)?);
        let kind = match entry[16] {
            1 => ChartMemberKind::Child,
            2 => ChartMemberKind::Adult,
            _ => return Err(KinError::MalformedProtocol),
        };
        if entry[17..20] != [0, 0, 0]
            || member.0 == [0; 16]
            || members.iter().any(|(seen, _)| *seen == member)
        {
            return Err(KinError::MalformedProtocol);
        }
        members.push((member, kind));
    }
    Ok((
        ChartQuery {
            start,
            bounds,
            adults_allowed: header[12] == 1,
            members,
        },
        &input[end..],
    ))
}

/// KCCD v1, the chart: "KCCD", version u16 = 1, reserved u16, week start
/// u32, today u32, flags u8 (bit 0: the household mode pauses routines),
/// three reserved, member count u16, points-setting count u16; 24 bytes.
/// Then each points setting (live routines not worth the default): routine
/// ID [16], points u8, three reserved; 20 bytes. Then each member on the
/// chart, in the query's order: member ID [16], flags u8 (bit 0 Adult, bit 1
/// reward), reserved u8, points this week u16 (saturating), reward goal u16
/// (0 for none), chore count u16, reward text (u16 length + UTF-8), then its
/// chores (28 bytes each): kind u8 (1 item, 2 routine), flags u8 (bit 0
/// done, bit 1 today), points u8, reserved u8, ID [16], date u32, occurrence
/// key u32 (0 for an item).
pub fn encode_chart(chart: &Chart) -> Vec<u8> {
    let size = chart
        .members
        .iter()
        .fold(24 + chart.points.len() * 20, |size, member| {
            size + 26
                + member.reward.as_ref().map_or(0, |reward| reward.text.len())
                + member.chores.len() * 28
        });
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(b"KCCD");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&chart.start.encoded().to_le_bytes());
    out.extend_from_slice(&chart.today.encoded().to_le_bytes());
    out.extend_from_slice(&[u8::from(chart.routines_paused), 0, 0, 0]);
    // Members are capped at 32 and settings by the routine count's bound.
    out.extend_from_slice(&(chart.members.len() as u16).to_le_bytes());
    out.extend_from_slice(
        &u16::try_from(chart.points.len())
            .unwrap_or(u16::MAX)
            .to_le_bytes(),
    );
    for (routine_id, points) in chart.points.iter().take(usize::from(u16::MAX)) {
        out.extend_from_slice(&routine_id.0);
        out.extend_from_slice(&[*points, 0, 0, 0]);
    }
    for member in &chart.members {
        out.extend_from_slice(&member.member.0);
        let adult = member.kind == ChartMemberKind::Adult;
        out.extend_from_slice(&[
            u8::from(adult) | (u8::from(member.reward.is_some()) << 1),
            0,
        ]);
        out.extend_from_slice(
            &u16::try_from(member.points)
                .unwrap_or(u16::MAX)
                .to_le_bytes(),
        );
        out.extend_from_slice(
            &member
                .reward
                .as_ref()
                .map_or(0, |reward| reward.goal)
                .to_le_bytes(),
        );
        out.extend_from_slice(&(member.chores.len() as u16).to_le_bytes());
        push_text(
            &mut out,
            member
                .reward
                .as_ref()
                .map_or("", |reward| reward.text.as_str()),
        );
        for chore in &member.chores {
            out.extend_from_slice(&[
                chore.kind as u8,
                u8::from(chore.done) | (u8::from(chore.today) << 1),
                chore.points,
                0,
            ]);
            out.extend_from_slice(&chore.id);
            out.extend_from_slice(&chore.date.encoded().to_le_bytes());
            out.extend_from_slice(&chore.occurrence.map_or(0, CivilDate::encoded).to_le_bytes());
        }
    }
    out
}

/// The chore chart (`kin_chore_chart`, #676): KCCQ and the record-less KINE
/// context against the household history; publishes KCCD. "Today" is the
/// context's civil date, which must fall in the queried week.
pub fn chart_export(
    input: &[u8],
    history: &mut crate::history::History,
) -> Result<Vec<u8>, KinError> {
    let (query, context) = decode_query(input)?;
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    Ok(encode_chart(&chart(&state, &query, context.civil_date)?))
}
