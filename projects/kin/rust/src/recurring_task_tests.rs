// Recurring tasks are Routines. These tests pin the protocol-24 Weekdays
// cadence, the derived next occurrence, and the occurrence-level completion
// invariants the Daily UX relies on, through the same command and replay
// paths the browser uses.
use crate::command::{execute, CommandContext, HouseholdCommand as C};
use crate::core::encode_projection;
use crate::error::KinError;
use crate::event::*;
use crate::recurrence::{Cadence, CivilDate};
use crate::request::DecodedRequest;
use crate::state::{rebuild, HouseholdState};

const ROUTINE: RoutineId = RoutineId([5; 16]);
const AS_OF: i64 = 1_791_475_200_100;

fn day(value: u32) -> CivilDate {
    CivilDate::from_encoded(value).unwrap()
}

fn context(n: u8, device: u8, logical: u64) -> CommandContext {
    CommandContext {
        event_id: EventId([n.wrapping_mul(7).wrapping_add(device); 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([device; 16]),
        device_id: DeviceId([device; 16]),
        timestamp: 1_791_475_200_000 + i64::from(n),
        logical_time: logical,
    }
}

fn request(events: &[EventEnvelope], on: u32) -> DecodedRequest {
    DecodedRequest {
        events: events.to_vec(),
        as_of: AS_OF,
        summary_cursor: None,
        civil_date: day(on),
        target_household_id: None,
        identity_bindings: vec![],
    }
}

fn run(
    events: &[EventEnvelope],
    command: C,
    ctx: CommandContext,
    on: u32,
) -> Result<EventEnvelope, KinError> {
    execute(&command, ctx, request(events, on)).map(|result| result.event)
}

fn project(events: &[EventEnvelope], on: u32) -> HouseholdState {
    rebuild(events, AS_OF, day(on)).unwrap()
}

fn create(cadence: Cadence, on: u32) -> Vec<EventEnvelope> {
    vec![run(
        &[],
        C::CreateRoutine {
            id: ROUTINE,
            text: "Pack lunches".into(),
            cadence,
            created_on: day(on),
        },
        context(1, 1, 1),
        on,
    )
    .unwrap()]
}

fn complete(key: u32) -> C {
    C::CompleteOccurrence {
        id: ROUTINE,
        key: day(key),
    }
}

fn reopen(key: u32) -> C {
    C::ReopenOccurrence {
        id: ROUTINE,
        key: day(key),
    }
}

#[test]
fn weekdays_routine_roundtrips_end_to_end() {
    let events = create(Cadence::Weekdays, 20261012);
    let bytes = crate::codec::encode_event(&events[0]).unwrap();
    assert_eq!(
        crate::event_decode::decode_event(&bytes).unwrap(),
        events[0]
    );
    let state = project(&events, 20261012);
    assert_eq!(state.routines[0].cadence, Cadence::Weekdays);
    assert!(encode_projection(&request(&events, 20261012), &state).is_ok());
}

#[test]
fn projection_carries_one_next_occurrence_per_routine_before_the_summary() {
    let events = create(Cadence::Daily, 20261012);
    let state = project(&events, 20261012);
    assert_eq!(state.routines[0].next_start, Some(day(20261013)));
    let summary = crate::state::CatchUpSummary {
        entries: Vec::new(),
        total_count: 0,
        through_event_id: None,
    };
    let bytes = crate::state_encode::encode_state(&state, &summary).unwrap();
    assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), 24);
    // No summary entries, so the Routine's next-occurrence date ends the projection.
    assert_eq!(&bytes[bytes.len() - 4..], &20261013u32.to_le_bytes());
}

#[test]
fn weekday_task_is_due_monday_to_friday_and_absent_at_the_weekend() {
    let mut events = create(Cadence::Weekdays, 20261009); // Friday
    let friday = project(&events, 20261009);
    assert_eq!(friday.routines[0].occurrence_key, Some(day(20261009)));
    assert_eq!(friday.routines[0].next_start, Some(day(20261012)));
    for weekend in [20261010, 20261011] {
        let state = project(&events, weekend);
        assert_eq!(state.routines[0].occurrence_key, None);
        assert_eq!(state.routines[0].next_start, Some(day(20261012)));
        // Nothing to complete at the weekend, not even Friday's occurrence.
        assert_eq!(
            run(&events, complete(20261009), context(2, 1, 2), weekend).unwrap_err(),
            KinError::InvalidEvent
        );
        assert_eq!(
            run(&events, complete(weekend), context(2, 1, 2), weekend).unwrap_err(),
            KinError::InvalidEvent
        );
    }
    events.push(run(&events, complete(20261012), context(2, 1, 2), 20261012).unwrap());
    assert!(project(&events, 20261012).routines[0].completed);
    assert!(!project(&events, 20261013).routines[0].completed);
}

#[test]
fn completing_the_current_occurrence_leaves_history_and_future_independent() {
    let mut events = create(Cadence::Daily, 20261012);
    events.push(run(&events, complete(20261012), context(2, 1, 2), 20261012).unwrap());
    // Tomorrow is a separate, open occurrence; today's completion is history.
    let tomorrow = project(&events, 20261013);
    assert_eq!(tomorrow.routines[0].occurrence_key, Some(day(20261013)));
    assert!(!tomorrow.routines[0].completed);
    events.push(run(&events, complete(20261013), context(3, 1, 3), 20261013).unwrap());
    events.push(run(&events, reopen(20261013), context(4, 1, 4), 20261013).unwrap());
    assert!(project(&events, 20261012).routines[0].completed);
    assert!(!project(&events, 20261013).routines[0].completed);
    // Only one Routine ever exists: occurrences are keys, not copies.
    assert_eq!(project(&events, 20261020).routines.len(), 1);
}

#[test]
fn stale_or_repeated_occurrence_commands_are_rejected() {
    let mut events = create(Cadence::Daily, 20261012);
    events.push(run(&events, complete(20261012), context(2, 1, 2), 20261012).unwrap());
    // A second completion of the same occurrence (another tab, a retry, a
    // replayed undo) changes nothing and is refused.
    assert_eq!(
        run(&events, complete(20261012), context(3, 1, 3), 20261012).unwrap_err(),
        KinError::InvalidEvent
    );
    // Yesterday's occurrence cannot be completed or reopened from a stale view.
    assert_eq!(
        run(&events, reopen(20261012), context(3, 1, 3), 20261013).unwrap_err(),
        KinError::InvalidEvent
    );
    assert_eq!(
        run(&events, complete(20261012), context(3, 1, 3), 20261013).unwrap_err(),
        KinError::InvalidEvent
    );
    // A future occurrence cannot be completed early.
    assert_eq!(
        run(&events, complete(20261013), context(3, 1, 3), 20261012).unwrap_err(),
        KinError::InvalidEvent
    );
    // Reopening an open occurrence is refused too.
    assert_eq!(
        run(&events, reopen(20261013), context(3, 1, 3), 20261013).unwrap_err(),
        KinError::InvalidEvent
    );
}

#[test]
fn synchronized_duplicates_and_concurrent_completions_converge_on_one_occurrence() {
    let base = create(Cadence::Weekly, 20261012);
    // Two devices each complete the same week's occurrence before syncing.
    let mine = run(&base, complete(20261012), context(2, 1, 2), 20261014).unwrap();
    let theirs = run(&base, complete(20261012), context(2, 2, 2), 20261014).unwrap();
    assert_ne!(mine.event_id, theirs.event_id);
    let mut merged = base.clone();
    merged.extend([mine.clone(), theirs, mine]);
    let state = project(&merged, 20261014);
    assert_eq!(state.routines.len(), 1);
    assert!(state.routines[0].completed);
    assert_eq!(state.routines[0].next_start, Some(day(20261019)));
    // Next week is untouched by either completion.
    assert!(!project(&merged, 20261019).routines[0].completed);
    // A device that has seen the merge cannot complete it a third time.
    assert_eq!(
        run(&merged, complete(20261012), context(3, 1, 3), 20261014).unwrap_err(),
        KinError::InvalidEvent
    );
}

#[test]
fn stopping_repetition_keeps_completed_history_and_blocks_new_occurrences() {
    let mut events = create(Cadence::Monthly, 20261012);
    events.push(run(&events, complete(20261001), context(2, 1, 2), 20261012).unwrap());
    events.push(
        run(
            &events,
            C::ArchiveRoutine(ROUTINE),
            context(3, 1, 3),
            20261012,
        )
        .unwrap(),
    );
    let state = project(&events, 20261012);
    assert!(state.routines[0].archived);
    assert_eq!(state.routines[0].occurrence_key, None);
    assert_eq!(state.routines[0].next_start, None);
    // History replays unchanged; nothing new can be recorded.
    assert_eq!(project(&events, 20261101).routines[0].next_start, None);
    for command in [complete(20261101), reopen(20261001)] {
        assert_eq!(
            run(&events, command, context(4, 1, 4), 20261101).unwrap_err(),
            KinError::InvalidEvent
        );
    }
    assert_eq!(
        run(
            &events,
            C::ArchiveRoutine(ROUTINE),
            context(4, 1, 4),
            20261101
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
}

#[test]
fn paused_household_mode_rejects_occurrence_changes() {
    let mut events = create(Cadence::Weekdays, 20261012);
    events.push(
        run(
            &events,
            C::SetHouseholdMode(HouseholdMode::Vacation),
            context(2, 1, 2),
            20261012,
        )
        .unwrap(),
    );
    assert_eq!(
        run(&events, complete(20261012), context(3, 1, 3), 20261012).unwrap_err(),
        KinError::InvalidEvent
    );
}

// A schedule change is create-replacement then archive-original, so two
// devices changing one Routine offline each archive the same original. These
// pin today's behaviour (a documented PR 53 limitation, see
// docs/DAILY-UX-HARDENING.md); they are not a statement of the desired rule.
fn change_schedule(
    base: &[EventEnvelope],
    replacement: RoutineId,
    cadence: Cadence,
    device: u8,
    logical: u64,
) -> Vec<EventEnvelope> {
    let created = run(
        base,
        C::CreateRoutine {
            id: replacement,
            text: "Pack lunches".into(),
            cadence,
            created_on: day(20261014),
        },
        context(10 + device, device, logical),
        20261014,
    )
    .unwrap();
    let mut seen = base.to_vec();
    seen.push(created.clone());
    let archived = run(
        &seen,
        C::ArchiveRoutine(ROUTINE),
        context(20 + device, device, logical + 1),
        20261014,
    )
    .unwrap();
    vec![created, archived]
}

#[test]
fn concurrent_schedule_changes_at_one_logical_time_keep_both_replacements_in_any_order() {
    let base = create(Cadence::Daily, 20261012);
    let a = change_schedule(&base, RoutineId([6; 16]), Cadence::Weekly, 1, 2);
    let b = change_schedule(&base, RoutineId([7; 16]), Cadence::Weekdays, 2, 2);
    let orders = [
        [base.clone(), a.clone(), b.clone()].concat(),
        [base.clone(), b.clone(), a.clone()].concat(),
        [b.clone(), base.clone(), a.clone()].concat(),
        [a[1..].to_vec(), b.clone(), base.clone(), a[..1].to_vec()].concat(),
    ];
    let first = project(&orders[0], 20261014);
    for events in &orders {
        // Same event set, same projection on every device. (The encoded
        // catch-up summary describes the request's own order, so only the
        // projection is compared.)
        assert_eq!(project(events, 20261014), first);
    }
    // No history is lost: the original is stopped once, and BOTH
    // replacements remain active. This is the known limitation.
    let routine = |id: RoutineId| first.routines.iter().find(|r| r.routine_id == id).unwrap();
    assert_eq!(first.routines.len(), 3);
    assert!(routine(ROUTINE).archived);
    assert!(!routine(RoutineId([6; 16])).archived);
    assert!(!routine(RoutineId([7; 16])).archived);
    assert_eq!(routine(RoutineId([6; 16])).cadence, Cadence::Weekly);
    assert_eq!(routine(RoutineId([7; 16])).cadence, Cadence::Weekdays);
}

#[test]
fn concurrent_schedule_changes_at_different_logical_times_keep_both_replacements() {
    let base = create(Cadence::Daily, 20261012);
    let a = change_schedule(&base, RoutineId([6; 16]), Cadence::Weekly, 1, 2);
    // Device B did more offline work first, so its archive is later.
    let b = change_schedule(&base, RoutineId([7; 16]), Cadence::Weekdays, 2, 4);
    let orders = [
        [base.clone(), a.clone(), b.clone()].concat(),
        [base.clone(), b.clone(), a.clone()].concat(),
    ];
    let first = project(&orders[0], 20261014);
    for events in &orders {
        assert_eq!(project(events, 20261014), first);
    }
    let routine = |id: RoutineId| first.routines.iter().find(|r| r.routine_id == id).unwrap();
    assert!(routine(ROUTINE).archived);
    assert!(!routine(RoutineId([6; 16])).archived);
    assert!(!routine(RoutineId([7; 16])).archived);
    // Each device's own history still replays on its own.
    for own in [&a, &b] {
        let state = project(&[base.clone(), own.to_vec()].concat(), 20261014);
        assert_eq!(state.routines.iter().filter(|r| !r.archived).count(), 1);
    }
}

#[test]
fn weekdays_skip_the_weekend_across_both_daylight_saving_transitions() {
    // US DST starts Sun 2026-03-08 and ends Sun 2026-11-01. Keys are civil
    // dates, so a 23- or 25-hour weekend neither adds nor drops a weekday.
    for (friday, saturday, sunday, monday) in [
        (20260306, 20260307, 20260308, 20260309),
        (20261030, 20261031, 20261101, 20261102),
    ] {
        let events = create(Cadence::Weekdays, friday);
        let state = project(&events, friday);
        assert_eq!(state.routines[0].occurrence_key, Some(day(friday)));
        assert_eq!(state.routines[0].next_start, Some(day(monday)));
        for weekend in [saturday, sunday] {
            let state = project(&events, weekend);
            assert_eq!(state.routines[0].occurrence_key, None);
            assert_eq!(state.routines[0].next_start, Some(day(monday)));
        }
        assert_eq!(
            project(&events, monday).routines[0].occurrence_key,
            Some(day(monday))
        );
    }
}
