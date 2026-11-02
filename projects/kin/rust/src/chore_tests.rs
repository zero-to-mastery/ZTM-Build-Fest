// The chore chart (#676, ADR 0022 §6): kinds 77–79 (canonical payloads,
// replay, command rules), credit to the chore's owner (whose turn it was for
// a rotating routine), weekly points that start again each Monday, adults
// only when allowed and joined, KCCQ and KCCD. The byte vectors here are
// TEST-VECTORS 085–089.
use crate::chores::*;
use crate::codec::encode_event;
use crate::command::{decode_command, execute, CommandContext, HouseholdCommand as C};
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::recurrence::{Cadence, CivilDate};
use crate::request::DecodedRequest;
use crate::state::{rebuild, HouseholdState};
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const PARENT: [u8; 16] = [1; 16];
const MIA: [u8; 16] = [2; 16];
const LEO: [u8; 16] = [3; 16];
const OTHER_PARENT: [u8; 16] = [4; 16];
const DEVICE: [u8; 16] = [0x11; 16];
/// Monday of the test week (TEST_DATE, 2026-10-03, is its Saturday).
const MONDAY: u32 = 20260928;
const TUESDAY: u32 = 20260929;
const WEDNESDAY: u32 = 20260930;
const SUNDAY: u32 = 20261004;
const NEXT_MONDAY: u32 = 20261005;
const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;
/// "Feed the cat", daily from Monday.
const CAT: u32 = 30;
/// "Bins out", daily from Monday, taken in turns.
const BINS: u32 = 31;

fn date(value: u32) -> CivilDate {
    CivilDate::from_encoded(value).unwrap()
}

/// The UTC midnight starting `value`, in ms: the test week's days are UTC
/// days.
fn midnight(value: u32) -> i64 {
    let epoch = date(19700101).day_number();
    i64::from(date(value).day_number() - epoch) * DAY_MS
}

fn routine(n: u32) -> RoutineId {
    RoutineId(numbered_id(n))
}

fn item(n: u32) -> ItemId {
    ItemId(numbered_id(n))
}

fn query(start: u32, adults_allowed: bool, members: &[([u8; 16], ChartMemberKind)]) -> ChartQuery {
    let mut bounds = [0; CHART_DAYS + 1];
    for (day, bound) in bounds.iter_mut().enumerate() {
        *bound = midnight(start) + day as i64 * DAY_MS;
    }
    ChartQuery {
        start: date(start),
        bounds,
        adults_allowed,
        members: members
            .iter()
            .map(|(member, kind)| (ActorId(*member), *kind))
            .collect(),
    }
}

fn children() -> Vec<([u8; 16], ChartMemberKind)> {
    vec![(MIA, ChartMemberKind::Child), (LEO, ChartMemberKind::Child)]
}

struct Home {
    events: Vec<EventEnvelope>,
    next: u32,
    today: u32,
    /// Who sends the next command.
    actor: [u8; 16],
    /// The next command's time; noon of `today` when unset.
    at: Option<i64>,
}

impl Home {
    fn new() -> Self {
        Self {
            events: Vec::new(),
            next: 1,
            today: MONDAY,
            actor: PARENT,
            at: None,
        }
    }

    fn run(&mut self, command: C) -> Result<(), KinError> {
        let n = self.next;
        let context = CommandContext {
            event_id: EventId(numbered_id(1000 + n)),
            household_id: HouseholdId(HOUSEHOLD),
            actor_id: ActorId(self.actor),
            device_id: DeviceId(DEVICE),
            timestamp: self.at.unwrap_or(midnight(self.today) + 12 * HOUR_MS),
            logical_time: u64::from(n),
        };
        let request = DecodedRequest {
            events: self.events.clone(),
            as_of: midnight(self.today) + 23 * HOUR_MS,
            summary_cursor: None,
            civil_date: date(self.today),
            target_household_id: None,
            identity_bindings: vec![],
        };
        let result = execute(&command, context, request)?;
        let bytes = encode_event(&result.event).unwrap();
        assert_eq!(decode_event(&bytes).unwrap(), result.event);
        self.events.push(result.event);
        self.next += 1;
        Ok(())
    }

    fn routine(&mut self, n: u32, text: &str) {
        self.run(C::CreateRoutine {
            id: routine(n),
            text: text.into(),
            cadence: Cadence::Daily,
            created_on: date(MONDAY),
        })
        .unwrap();
    }

    fn item(&mut self, n: u32, text: &str, owner: [u8; 16], planned: Option<u32>) {
        self.run(C::AddItem {
            id: item(n),
            text: text.into(),
            classification: ItemClassification::Need,
        })
        .unwrap();
        self.assign(ResponsibilityTargetKind::Item, n, owner);
        if let Some(planned) = planned {
            self.run(C::SetItemPlanningDate {
                item_id: item(n),
                planning_date: Some(date(planned)),
            })
            .unwrap();
        }
    }

    fn assign(&mut self, target_kind: ResponsibilityTargetKind, n: u32, member: [u8; 16]) {
        self.run(C::ChangeResponsibility {
            target_kind,
            target_id: numbered_id(n),
            member_id: Some(ActorId(member)),
        })
        .unwrap();
    }

    fn complete(&mut self, n: u32, on: u32) -> Result<(), KinError> {
        self.today = on;
        self.run(C::CompleteOccurrence {
            id: routine(n),
            key: date(on),
        })
    }

    fn reopen(&mut self, n: u32, on: u32) -> Result<(), KinError> {
        self.today = on;
        self.run(C::ReopenOccurrence {
            id: routine(n),
            key: date(on),
        })
    }

    fn chore(&mut self, kind: EventKind) -> Result<(), KinError> {
        self.run(C::Chore(kind))
    }

    fn state(&self) -> HouseholdState {
        rebuild(
            &self.events,
            midnight(self.today) + 23 * HOUR_MS,
            date(self.today),
        )
        .unwrap()
    }

    fn chart(&self, query: &ChartQuery) -> Chart {
        chart(&self.state(), query, date(self.today)).unwrap()
    }

    /// Each member's (ID, points) on this week's chart.
    fn points(&self, members: &[([u8; 16], ChartMemberKind)]) -> Vec<([u8; 16], u32)> {
        self.chart(&query(date(self.today).monday().encoded(), true, members))
            .members
            .iter()
            .map(|member| (member.member.0, member.points))
            .collect()
    }
}

fn points_set(n: u32, points: u8) -> EventKind {
    EventKind::ChorePointsSet {
        routine_id: routine(n),
        points,
    }
}

fn reward(member: [u8; 16], goal: u16, text: &str) -> EventKind {
    EventKind::ChoreRewardSet {
        member_id: ActorId(member),
        goal,
        text: text.into(),
    }
}

fn joined(member: [u8; 16], joined: bool) -> EventKind {
    EventKind::ChoreChartJoined {
        member_id: ActorId(member),
        joined,
    }
}

// 085
#[test]
fn chore_payloads_are_canonical_and_strict() {
    let points = encode_payload(&points_set(CAT, 3)).unwrap();
    let mut expected = numbered_id(CAT).to_vec();
    expected.extend_from_slice(&[3, 0, 0, 0]);
    assert_eq!(points, expected);
    assert_eq!(
        decode_payload(CHORE_POINTS_SET, &points).unwrap(),
        points_set(CAT, 3)
    );

    let goal = encode_payload(&reward(MIA, 20, "Movie night")).unwrap();
    let mut expected = MIA.to_vec();
    expected.extend_from_slice(&[20, 0, 0, 0, 11, 0]);
    expected.extend_from_slice(b"Movie night");
    assert_eq!(goal, expected);
    assert_eq!(
        decode_payload(CHORE_REWARD_SET, &goal).unwrap(),
        reward(MIA, 20, "Movie night")
    );
    let clear = encode_payload(&reward(MIA, 0, "")).unwrap();
    assert_eq!(clear, [MIA.as_slice(), &[0, 0, 0, 0, 0, 0]].concat());

    let join = encode_payload(&joined(PARENT, true)).unwrap();
    assert_eq!(join, [PARENT.as_slice(), &[1, 0, 0, 0]].concat());
    assert_eq!(
        decode_payload(CHORE_CHART_JOINED, &join).unwrap(),
        joined(PARENT, true)
    );

    // Anything not already canonical is malformed (code 2).
    let malformed = Err(KinError::MalformedProtocol);
    for kind in [
        points_set(CAT, 11),
        EventKind::ChorePointsSet {
            routine_id: RoutineId([0; 16]),
            points: 1,
        },
        reward(MIA, 0, "Movie night"),
        reward(MIA, 20, ""),
        reward(MIA, 20, " Movie night"),
        reward(MIA, 1001, "Movie night"),
        reward(MIA, 5, &"x".repeat(121)),
        reward(MIA, 5, "Line\nbreak"),
        reward([0; 16], 5, "Ice cream"),
        joined([0; 16], true),
    ] {
        assert_eq!(encode_payload(&kind).map(|_| ()), malformed, "{kind:?}");
    }
    assert_eq!(
        encode_payload(&reward(MIA, 1000, &"é".repeat(60))).map(|_| ()),
        Ok(())
    );
    let mut bad = points.clone();
    bad[17] = 1;
    assert_eq!(
        decode_payload(CHORE_POINTS_SET, &bad).map(|_| ()),
        malformed
    );
    let mut bad = join.clone();
    bad[16] = 2;
    assert_eq!(
        decode_payload(CHORE_CHART_JOINED, &bad).map(|_| ()),
        malformed
    );
    assert_eq!(
        decode_payload(CHORE_CHART_JOINED, &join[..19]).map(|_| ()),
        malformed
    );
    let mut bad = goal.clone();
    bad.push(0);
    assert_eq!(
        decode_payload(CHORE_REWARD_SET, &bad).map(|_| ()),
        malformed
    );
    let mut bad = goal.clone();
    bad[18] = 1;
    assert_eq!(
        decode_payload(CHORE_REWARD_SET, &bad).map(|_| ()),
        malformed
    );
    assert_eq!(decode_payload(80, &points).map(|_| ()), malformed);
}

// 086
#[test]
fn settings_replay_and_commands_refuse_what_changes_nothing() {
    let mut home = Home::new();
    home.routine(CAT, "Feed the cat");
    let refused = Err(KinError::InvalidEvent);
    assert_eq!(
        home.chore(points_set(CAT, 1)),
        refused,
        "1 is already the default"
    );
    assert_eq!(home.chore(points_set(99, 3)), refused, "no such routine");
    home.chore(points_set(CAT, 3)).unwrap();
    assert_eq!(home.state().chores.routine_points(&routine(CAT)), 3);
    assert_eq!(home.chore(points_set(CAT, 3)), refused, "unchanged");
    home.chore(points_set(CAT, 0)).unwrap();
    assert_eq!(home.state().chores.routine_points(&routine(CAT)), 0);
    home.chore(points_set(CAT, 1)).unwrap();
    assert!(
        home.state().chores.points.is_empty(),
        "back to the default is stored as none"
    );

    assert_eq!(home.chore(reward(MIA, 0, "")), refused, "nothing to clear");
    home.chore(reward(MIA, 20, "Movie night")).unwrap();
    assert_eq!(home.chore(reward(MIA, 20, "Movie night")), refused);
    home.chore(reward(MIA, 25, "Movie night")).unwrap();
    assert_eq!(
        home.state().chores.rewards.get(&ActorId(MIA)),
        Some(&ChoreReward {
            goal: 25,
            text: "Movie night".into()
        })
    );
    home.chore(reward(MIA, 0, "")).unwrap();
    assert!(home.state().chores.rewards.is_empty());

    home.run(C::ArchiveRoutine(routine(CAT))).unwrap();
    assert_eq!(
        home.chore(points_set(CAT, 4)),
        refused,
        "an archived routine"
    );
}

// 087
#[test]
fn only_the_member_named_joins_or_leaves() {
    let mut home = Home::new();
    let refused = Err(KinError::InvalidEvent);
    assert_eq!(
        home.chore(joined(OTHER_PARENT, true)),
        refused,
        "not for someone else"
    );
    assert_eq!(home.chore(joined(PARENT, false)), refused, "not joined yet");
    home.chore(joined(PARENT, true)).unwrap();
    assert!(home.state().chores.joined.contains(&ActorId(PARENT)));
    assert_eq!(home.chore(joined(PARENT, true)), refused, "already joined");
    home.actor = OTHER_PARENT;
    assert_eq!(
        home.chore(joined(PARENT, false)),
        refused,
        "nobody else can take them off"
    );
    home.chore(joined(OTHER_PARENT, true)).unwrap();

    // Replay records an event from anyone else with no effect.
    let mut event = home.events.last().unwrap().clone();
    event.event_id = EventId(numbered_id(9999));
    event.logical_time += 1;
    event.kind = joined(PARENT, false);
    event.canonical_bytes = encode_event(&event).unwrap();
    let decoded = decode_event(&event.canonical_bytes).unwrap();
    let mut events = home.events.clone();
    events.push(decoded);
    let state = rebuild(&events, midnight(MONDAY) + DAY_MS, date(MONDAY)).unwrap();
    assert!(
        state.chores.joined.contains(&ActorId(PARENT)),
        "still joined"
    );
    assert!(state.chores.joined.contains(&ActorId(OTHER_PARENT)));

    home.actor = PARENT;
    home.chore(joined(PARENT, false)).unwrap();
    assert!(
        !home.state().chores.joined.contains(&ActorId(PARENT)),
        "and can leave at any time"
    );
}

// 088
#[test]
fn points_go_to_the_owner_and_follow_the_turn() {
    let mut home = Home::new();
    home.routine(CAT, "Feed the cat");
    home.assign(ResponsibilityTargetKind::Routine, CAT, MIA);
    home.routine(BINS, "Bins out");
    home.run(C::Rotation(EventKind::RoutineRotationSet {
        routine_id: routine(BINS),
        members: vec![ActorId(MIA), ActorId(LEO)],
        current: 0,
    }))
    .unwrap();
    home.chore(points_set(BINS, 3)).unwrap();
    home.chore(reward(MIA, 20, "Movie night")).unwrap();

    // A parent ticks Mia's cat on Monday: Mia's point, not the parent's.
    home.complete(CAT, MONDAY).unwrap();
    // Bins on Monday is Mia's turn: 3 points to Mia, then it's Leo's.
    home.complete(BINS, MONDAY).unwrap();
    assert_eq!(home.points(&children()), vec![(MIA, 4), (LEO, 0)]);
    // Leo's turn on Tuesday, ticked by Mia's device: Leo's 3.
    home.actor = MIA;
    home.complete(BINS, TUESDAY).unwrap();
    assert_eq!(home.points(&children()), vec![(MIA, 4), (LEO, 3)]);
    // Undo takes the point back and gives the turn back.
    home.reopen(BINS, TUESDAY).unwrap();
    assert_eq!(home.points(&children()), vec![(MIA, 4), (LEO, 0)]);
    home.complete(BINS, TUESDAY).unwrap();
    assert_eq!(home.points(&children()), vec![(MIA, 4), (LEO, 3)]);

    // Wednesday's chart: done days, today's open chores, and the reward.
    home.today = WEDNESDAY;
    let chart = home.chart(&query(MONDAY, false, &children()));
    let mia = &chart.members[0];
    assert_eq!(
        mia.reward,
        Some(ChoreReward {
            goal: 20,
            text: "Movie night".into()
        })
    );
    let shown: Vec<(u32, u32, bool, bool, u8)> = mia
        .chores
        .iter()
        .map(|chore| {
            (
                u32::from_le_bytes(chore.id[..4].try_into().unwrap()),
                chore.date.encoded(),
                chore.done,
                chore.today,
                chore.points,
            )
        })
        .collect();
    assert_eq!(
        shown,
        vec![
            (BINS, MONDAY, true, false, 3),
            (CAT, MONDAY, true, false, 1),
            (CAT, TUESDAY, false, false, 1),
            // Bins is Mia's turn again today; later turns aren't known.
            (BINS, WEDNESDAY, false, true, 3),
            (CAT, WEDNESDAY, false, true, 1),
            (CAT, 20261001, false, false, 1),
            (CAT, 20261002, false, false, 1),
            (CAT, 20261003, false, false, 1),
            (CAT, SUNDAY, false, false, 1),
        ]
    );
    let leo = &chart.members[1];
    assert_eq!(
        leo.chores
            .iter()
            .map(|chore| (chore.date.encoded(), chore.done))
            .collect::<Vec<_>>(),
        vec![(TUESDAY, true)]
    );
    assert_eq!(chart.points, vec![(routine(BINS), 3)]);
    assert!(!chart.routines_paused);
}

#[test]
fn items_credit_their_owner_on_the_day_they_are_done() {
    let mut home = Home::new();
    home.item(40, "Tidy room", MIA, None);
    home.item(41, "Library books", LEO, Some(TUESDAY));
    home.item(42, "Pack for camp", MIA, Some(NEXT_MONDAY));
    home.item(43, "Water plants", MIA, Some(20261001));
    // Monday: Mia sees her undated item today, and Thursday's on Thursday.
    let chart = home.chart(&query(MONDAY, false, &children()));
    let mia: Vec<(u32, bool, bool)> = chart.members[0]
        .chores
        .iter()
        .map(|chore| (chore.date.encoded(), chore.done, chore.today))
        .collect();
    assert_eq!(mia, vec![(MONDAY, false, true), (20261001, false, false)]);
    // Tuesday: a parent ticks Leo's books.
    home.today = TUESDAY;
    home.run(C::CompleteItem(item(41))).unwrap();
    home.today = WEDNESDAY;
    let chart = home.chart(&query(MONDAY, false, &children()));
    let leo = &chart.members[1];
    assert_eq!((leo.points, leo.chores.len()), (1, 1));
    assert_eq!(
        (
            leo.chores[0].date.encoded(),
            leo.chores[0].done,
            leo.chores[0].today
        ),
        (TUESDAY, true, false)
    );
    // Reassigning the done item later doesn't move the point.
    home.assign(ResponsibilityTargetKind::Item, 41, MIA);
    assert_eq!(home.points(&children()), vec![(MIA, 0), (LEO, 1)]);
    // Reopen and complete again: the new completion's owner gets it.
    home.run(C::ReopenItem(item(41))).unwrap();
    home.run(C::CompleteItem(item(41))).unwrap();
    assert_eq!(home.points(&children()), vec![(MIA, 1), (LEO, 0)]);
}

#[test]
fn points_start_again_each_monday() {
    let mut home = Home::new();
    home.routine(CAT, "Feed the cat");
    home.assign(ResponsibilityTargetKind::Routine, CAT, MIA);
    home.complete(CAT, MONDAY).unwrap();
    home.today = SUNDAY;
    // Late on Sunday still counts for this week...
    home.at = Some(midnight(NEXT_MONDAY) - 1);
    home.complete(CAT, SUNDAY).unwrap();
    assert_eq!(home.points(&children()), vec![(MIA, 2), (LEO, 0)]);
    // ...and the new week starts at the next Monday's first instant.
    home.today = NEXT_MONDAY;
    home.at = Some(midnight(NEXT_MONDAY));
    home.complete(CAT, NEXT_MONDAY).unwrap();
    assert_eq!(home.points(&children()), vec![(MIA, 1), (LEO, 0)]);
    let chart = home.chart(&query(NEXT_MONDAY, false, &children()));
    assert!(
        chart.members[0]
            .chores
            .iter()
            .all(|chore| chore.date >= date(NEXT_MONDAY)),
        "nothing from last week is shown"
    );
    // Day boundaries come from the host's time zone, not UTC: where the week
    // ends two hours earlier, Sunday's late completion is next week's.
    let mut shifted = query(MONDAY, false, &children());
    for bound in &mut shifted.bounds {
        *bound -= 2 * HOUR_MS;
    }
    home.today = SUNDAY;
    let chart = home.chart(&shifted);
    assert_eq!(chart.members[0].points, 1);
}

#[test]
fn adults_are_on_the_chart_only_when_allowed_and_joined() {
    let mut home = Home::new();
    home.routine(CAT, "Feed the cat");
    home.assign(ResponsibilityTargetKind::Routine, CAT, PARENT);
    home.complete(CAT, MONDAY).unwrap();
    let everyone = vec![
        (MIA, ChartMemberKind::Child),
        (PARENT, ChartMemberKind::Adult),
        (OTHER_PARENT, ChartMemberKind::Adult),
    ];
    let on = |home: &Home, allowed: bool| -> Vec<[u8; 16]> {
        home.chart(&query(MONDAY, allowed, &everyone))
            .members
            .iter()
            .map(|member| member.member.0)
            .collect()
    };
    assert_eq!(on(&home, false), vec![MIA], "not by default");
    assert_eq!(on(&home, true), vec![MIA], "allowed, but nobody joined");
    home.chore(joined(PARENT, true)).unwrap();
    assert_eq!(
        on(&home, false),
        vec![MIA],
        "joined, but an admin doesn't allow it"
    );
    assert_eq!(on(&home, true), vec![MIA, PARENT]);
    let chart = home.chart(&query(MONDAY, true, &everyone));
    assert_eq!(
        (chart.members[1].kind, chart.members[1].points),
        (ChartMemberKind::Adult, 1)
    );
    home.chore(joined(PARENT, false)).unwrap();
    assert_eq!(on(&home, true), vec![MIA], "left");
}

#[test]
fn paused_routines_show_only_what_was_done() {
    let mut home = Home::new();
    home.routine(CAT, "Feed the cat");
    home.assign(ResponsibilityTargetKind::Routine, CAT, MIA);
    home.complete(CAT, MONDAY).unwrap();
    home.today = TUESDAY;
    home.run(C::SetHouseholdMode(HouseholdMode::Vacation))
        .unwrap();
    let chart = home.chart(&query(MONDAY, false, &children()));
    assert!(chart.routines_paused);
    assert_eq!(chart.members[0].chores.len(), 1);
    assert!(chart.members[0].chores[0].done);
    assert_eq!(chart.members[0].points, 1);
}

fn kccq(start: u32, flags: u8, bounds: &[i64], members: &[([u8; 16], u8)]) -> Vec<u8> {
    let mut out = b"KCCQ\x01\x00\x00\x00".to_vec();
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&[flags, 0, 0, 0]);
    for bound in bounds {
        out.extend_from_slice(&bound.to_le_bytes());
    }
    out.extend_from_slice(&(members.len() as u16).to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    for (member, kind) in members {
        out.extend_from_slice(member);
        out.extend_from_slice(&[*kind, 0, 0, 0]);
    }
    out
}

fn utc_bounds(start: u32) -> Vec<i64> {
    (0..=7).map(|day| midnight(start) + day * DAY_MS).collect()
}

// 089
#[test]
fn the_chart_reads_through_kccq_and_kccd() {
    let mut home = Home::new();
    home.routine(CAT, "Feed the cat");
    home.assign(ResponsibilityTargetKind::Routine, CAT, MIA);
    home.chore(points_set(CAT, 2)).unwrap();
    home.chore(reward(MIA, 10, "Ice cream")).unwrap();
    home.complete(CAT, MONDAY).unwrap();
    let records: Vec<Vec<u8>> = home
        .events
        .iter()
        .map(|event| encode_event(event).unwrap())
        .collect();
    let mut batch = (records.len() as u32).to_le_bytes().to_vec();
    for record in &records {
        batch.extend_from_slice(&(record.len() as u32).to_le_bytes());
    }
    for record in &records {
        batch.extend_from_slice(record);
    }
    let mut history = History::default();
    history.append(&batch).unwrap();

    let mut input = kccq(MONDAY, 0, &utc_bounds(MONDAY), &[(MIA, 1), (PARENT, 2)]);
    input.extend_from_slice(&kine(&[], midnight(TUESDAY) + HOUR_MS, TUESDAY, None));
    let out = chart_export(&input, &mut history).unwrap();

    let mut expected = b"KCCD\x01\x00\x00\x00".to_vec();
    expected.extend_from_slice(&MONDAY.to_le_bytes());
    expected.extend_from_slice(&TUESDAY.to_le_bytes());
    expected.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0]);
    expected.extend_from_slice(&numbered_id(CAT));
    expected.extend_from_slice(&[2, 0, 0, 0]);
    expected.extend_from_slice(&MIA);
    expected.extend_from_slice(&[2, 0, 2, 0, 10, 0, 7, 0, 9, 0]);
    expected.extend_from_slice(b"Ice cream");
    for (day, flags) in [
        (MONDAY, 1u8),
        (TUESDAY, 2),
        (WEDNESDAY, 0),
        (20261001, 0),
        (20261002, 0),
        (20261003, 0),
        (SUNDAY, 0),
    ] {
        expected.extend_from_slice(&[2, flags, 2, 0]);
        expected.extend_from_slice(&numbered_id(CAT));
        expected.extend_from_slice(&day.to_le_bytes());
        expected.extend_from_slice(&day.to_le_bytes());
    }
    assert_eq!(out, expected);

    // The query is strict.
    let context = kine(&[], midnight(TUESDAY), TUESDAY, None);
    let run = |query: Vec<u8>, history: &mut History| {
        let mut input = query;
        input.extend_from_slice(&context);
        chart_export(&input, history)
    };
    let malformed = Err(KinError::MalformedProtocol);
    let good = utc_bounds(MONDAY);
    assert_eq!(
        run(kccq(TUESDAY, 0, &utc_bounds(TUESDAY), &[]), &mut history),
        malformed,
        "not a Monday"
    );
    assert_eq!(
        run(
            kccq(NEXT_MONDAY, 0, &utc_bounds(NEXT_MONDAY), &[]),
            &mut history
        ),
        malformed,
        "today isn't in the week"
    );
    assert_eq!(
        run(kccq(MONDAY, 2, &good, &[]), &mut history),
        malformed,
        "unknown flag"
    );
    let mut short = good.clone();
    short[3] = short[2];
    assert_eq!(
        run(kccq(MONDAY, 0, &short, &[]), &mut history),
        malformed,
        "an empty day"
    );
    let mut long = good.clone();
    long[7] = long[6] + 26 * HOUR_MS;
    assert_eq!(
        run(kccq(MONDAY, 0, &long, &[]), &mut history),
        malformed,
        "a day over 25 hours"
    );
    assert_eq!(
        run(kccq(MONDAY, 0, &good, &[(MIA, 1), (MIA, 2)]), &mut history),
        malformed,
        "a member twice"
    );
    assert_eq!(
        run(kccq(MONDAY, 0, &good, &[([0; 16], 1)]), &mut history),
        malformed,
        "no member"
    );
    assert_eq!(
        run(kccq(MONDAY, 0, &good, &[(MIA, 3)]), &mut history),
        malformed,
        "an unknown kind"
    );
    let many: Vec<([u8; 16], u8)> = (1..=33).map(|n| (numbered_id(n), 1)).collect();
    assert_eq!(
        run(kccq(MONDAY, 0, &good, &many), &mut history),
        malformed,
        "too many members"
    );
    let mut version = kccq(MONDAY, 0, &good, &[]);
    version[4] = 2;
    assert_eq!(
        run(version, &mut history),
        Err(KinError::UnsupportedVersion)
    );
    assert_eq!(
        run(kccq(MONDAY, 0, &good, &[]), &mut history).map(|bytes| bytes.len()),
        Ok(44),
        "no members, one setting"
    );
}

#[test]
fn kcmd_carries_chore_payloads() {
    let mut packet = b"KCMD\x01\x00\x00\x00".to_vec();
    packet.extend_from_slice(&CHORE_CHART_JOINED.to_le_bytes());
    packet.extend_from_slice(&[0, 0]);
    packet.extend_from_slice(&numbered_id(1));
    packet.extend_from_slice(&HOUSEHOLD);
    packet.extend_from_slice(&PARENT);
    packet.extend_from_slice(&DEVICE);
    packet.extend_from_slice(&1_791_475_200_000i64.to_le_bytes());
    packet.extend_from_slice(&1u64.to_le_bytes());
    packet.resize(124, 0);
    let payload = [PARENT.as_slice(), &[1, 0, 0, 0]].concat();
    packet.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    packet.extend_from_slice(&payload);
    let (command, context) = decode_command(&packet).unwrap();
    assert_eq!(command, C::Chore(joined(PARENT, true)));
    assert_eq!(context.actor_id, ActorId(PARENT));
    let mut bad = packet.clone();
    bad[128 + 16] = 2;
    assert_eq!(
        decode_command(&bad).map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
    let mut bad = packet;
    bad[92] = 1;
    assert_eq!(
        decode_command(&bad).map(|_| ()),
        Err(KinError::MalformedProtocol),
        "no entity field"
    );
}
