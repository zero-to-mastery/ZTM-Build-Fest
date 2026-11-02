// The family fridge (#317, ADR 0011): board kinds 52–58, their strict
// payloads, the board log and its replay, commands and the KBRD table. Wire
// records are written out by hand; they never come from the encoders.
use crate::board::*;
use crate::codec::encode_event;
use crate::command::{decode_command, execute_board_history};
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::request::{decode_context, decode_request, DecodedRequest};
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const SAM: [u8; 16] = [1; 16];
const ALEX: [u8; 16] = [2; 16];
const BASE_TIME: i64 = 1_791_475_200_000;

fn record_at(kind: u16, event: u32, logical_time: u64, actor: [u8; 16], payload: &[u8]) -> Vec<u8> {
    let mut record = Vec::new();
    record.extend_from_slice(&1u16.to_le_bytes());
    record.extend_from_slice(&kind.to_le_bytes());
    record.extend_from_slice(&numbered_id(event));
    record.extend_from_slice(&HOUSEHOLD);
    record.extend_from_slice(&actor);
    record.extend_from_slice(&[actor[0] + 0x10; 16]);
    record.extend_from_slice(&(BASE_TIME + i64::from(event)).to_le_bytes());
    record.extend_from_slice(&logical_time.to_le_bytes());
    record.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    record.extend_from_slice(payload);
    record
}

fn record(kind: u16, event: u32, actor: [u8; 16], payload: &[u8]) -> Vec<u8> {
    record_at(kind, event, u64::from(event), actor, payload)
}

fn id(n: u8) -> [u8; 16] {
    [n; 16]
}

/// A stroke payload: id, colour, width, count, first point, then the
/// zigzag LEB128 deltas given as raw bytes.
fn stroke_payload(
    n: u8,
    colour: u8,
    width: u8,
    count: u16,
    first: (u16, u16),
    deltas: &[u8],
) -> Vec<u8> {
    let mut payload = id(n).to_vec();
    payload.extend_from_slice(&[colour, width]);
    payload.extend_from_slice(&count.to_le_bytes());
    payload.extend_from_slice(&first.0.to_le_bytes());
    payload.extend_from_slice(&first.1.to_le_bytes());
    payload.extend_from_slice(deltas);
    payload
}

/// A two-point stroke from (100, 200) to (103, 198): deltas +3 -> 6, -2 -> 3.
fn stroke(event: u32, actor: [u8; 16], n: u8) -> Vec<u8> {
    record(
        STROKE_ADDED,
        event,
        actor,
        &stroke_payload(n, 2, 1, 2, (100, 200), &[6, 3]),
    )
}

fn hidden(kind: u16, event: u32, actor: [u8; 16], n: u8, hidden: bool) -> Vec<u8> {
    let mut payload = id(n).to_vec();
    payload.push(u8::from(hidden));
    payload.extend_from_slice(&[0; 7]);
    record(kind, event, actor, &payload)
}

fn magnet_payload(n: u8, content: u8, number: u8, x: u16, y: u16, text: &str) -> Vec<u8> {
    let mut payload = id(n).to_vec();
    payload.extend_from_slice(&[content, number]);
    payload.extend_from_slice(&x.to_le_bytes());
    payload.extend_from_slice(&y.to_le_bytes());
    payload.extend_from_slice(&(text.len() as u16).to_le_bytes());
    payload.extend_from_slice(text.as_bytes());
    payload
}

fn magnet(event: u32, actor: [u8; 16], n: u8, text: &str) -> Vec<u8> {
    record(
        MAGNET_PLACED,
        event,
        actor,
        &magnet_payload(n, 3, 0, 2000, 3000, text),
    )
}

fn moved(event: u32, actor: [u8; 16], n: u8, x: u16, y: u16) -> Vec<u8> {
    let mut payload = id(n).to_vec();
    payload.extend_from_slice(&x.to_le_bytes());
    payload.extend_from_slice(&y.to_le_bytes());
    payload.extend_from_slice(&[0; 4]);
    record(MAGNET_MOVED, event, actor, &payload)
}

fn clear(kind: u16, event: u32, actor: [u8; 16], n: u8) -> Vec<u8> {
    record(kind, event, actor, &id(n))
}

fn batch(records: &[Vec<u8>]) -> Vec<u8> {
    let mut batch = (records.len() as u32).to_le_bytes().to_vec();
    for record in records {
        batch.extend_from_slice(&(record.len() as u32).to_le_bytes());
    }
    for record in records {
        batch.extend_from_slice(record);
    }
    batch
}

fn context_bytes() -> Vec<u8> {
    kine(&[], BASE_TIME + 1_000_000, TEST_DATE, None)
}

fn context() -> DecodedRequest {
    decode_context(&context_bytes()).unwrap()
}

fn log_of(records: &[Vec<u8>]) -> History {
    let mut history = History::board();
    history.append(&batch(records)).unwrap();
    history
}

fn board(records: &[Vec<u8>]) -> BoardState {
    log_of(records).replay(&context()).unwrap().board().clone()
}

fn kbrd(records: &[Vec<u8>]) -> Vec<u8> {
    crate::core::board_state(&context_bytes(), &mut log_of(records)).unwrap()
}

fn shown_strokes(state: &BoardState) -> Vec<[u8; 16]> {
    state.visible_strokes().map(|stroke| stroke.id.0).collect()
}

fn shown_magnets(state: &BoardState) -> Vec<[u8; 16]> {
    state
        .visible_magnets()
        .iter()
        .map(|magnet| magnet.id.0)
        .collect()
}

// --- Wire -----------------------------------------------------------------

#[test]
fn a_stroke_decodes_from_delta_encoded_points_and_reencodes_identically() {
    let bytes = stroke(1, SAM, 7);
    let event = decode_event(&bytes).unwrap();
    assert_eq!(
        event.kind,
        EventKind::BoardStrokeAdded {
            stroke_id: BoardId(id(7)),
            colour: 2,
            width: 1,
            points: vec![(100, 200), (103, 198)],
        }
    );
    assert_eq!(
        encode_event(&event).unwrap(),
        bytes,
        "canonical bytes round-trip"
    );
    // A single point is a dot.
    let dot = record(
        STROKE_ADDED,
        2,
        SAM,
        &stroke_payload(8, 0, 0, 1, (4095, 5460), &[]),
    );
    assert_eq!(encode_event(&decode_event(&dot).unwrap()).unwrap(), dot);
}

#[test]
fn every_board_kind_round_trips() {
    let records = [
        hidden(STROKE_HIDDEN, 1, SAM, 7, true),
        hidden(MAGNET_HIDDEN, 2, SAM, 7, false),
        record(MAGNET_PLACED, 3, SAM, &magnet_payload(4, 1, 0, 0, 0, "🧲")),
        record(MAGNET_PLACED, 4, SAM, &magnet_payload(5, 2, 12, 10, 20, "")),
        magnet(5, SAM, 6, "Milk please"),
        moved(6, SAM, 6, 1, 2),
        clear(CLEARED, 7, SAM, 9),
        clear(CLEAR_UNDONE, 8, SAM, 9),
    ];
    for bytes in records {
        let event = decode_event(&bytes).unwrap();
        assert!(event.kind.is_board() && !event.kind.is_chat());
        assert_eq!(encode_event(&event).unwrap(), bytes);
    }
}

#[test]
fn malformed_board_payloads_are_refused() {
    let bad_payloads: Vec<(u16, Vec<u8>)> = vec![
        // Colour 8 and width 3 are out of range.
        (STROKE_ADDED, stroke_payload(1, 8, 0, 2, (0, 0), &[2, 2])),
        (STROKE_ADDED, stroke_payload(1, 0, 3, 2, (0, 0), &[2, 2])),
        // No points, or more deltas than the count says.
        (STROKE_ADDED, stroke_payload(1, 0, 0, 0, (0, 0), &[])),
        (STROKE_ADDED, stroke_payload(1, 0, 0, 1, (0, 0), &[2, 2])),
        // A non-minimal varint (0x82 0x00 is 2 written long).
        (
            STROKE_ADDED,
            stroke_payload(1, 0, 0, 2, (0, 0), &[0x82, 0x00, 2]),
        ),
        // A delta leaving the board (x 4095 + 1).
        (STROKE_ADDED, stroke_payload(1, 0, 0, 2, (4095, 0), &[2, 0])),
        // A first point below the board (y 5461).
        (STROKE_ADDED, stroke_payload(1, 0, 0, 1, (0, 5461), &[])),
        // A zero ID.
        (STROKE_ADDED, stroke_payload(0, 0, 0, 1, (0, 0), &[])),
        // Hidden flags must be 0 or 1 with zero reserved bytes.
        (
            STROKE_HIDDEN,
            [&id(1)[..], &[2, 0, 0, 0, 0, 0, 0, 0]].concat(),
        ),
        (
            MAGNET_HIDDEN,
            [&id(1)[..], &[1, 0, 0, 0, 0, 0, 0, 9]].concat(),
        ),
        // Magnets: a note with surrounding space, a line break, too long;
        // Kin magnets 0 and 13; an emoji that is plain text; text on a Kin magnet.
        (MAGNET_PLACED, magnet_payload(1, 3, 0, 0, 0, " Milk")),
        (MAGNET_PLACED, magnet_payload(1, 3, 0, 0, 0, "a\nb")),
        (
            MAGNET_PLACED,
            magnet_payload(1, 3, 0, 0, 0, &"x".repeat(61)),
        ),
        (MAGNET_PLACED, magnet_payload(1, 2, 0, 0, 0, "")),
        (MAGNET_PLACED, magnet_payload(1, 2, 13, 0, 0, "")),
        (MAGNET_PLACED, magnet_payload(1, 1, 0, 0, 0, "hi")),
        (MAGNET_PLACED, magnet_payload(1, 2, 1, 0, 0, "x")),
        (MAGNET_PLACED, magnet_payload(1, 4, 0, 0, 0, "x")),
        (MAGNET_PLACED, magnet_payload(1, 3, 0, 4096, 0, "x")),
        // Moves need zero reserved bytes; clears are exactly an ID.
        (
            MAGNET_MOVED,
            [&id(1)[..], &[0, 0, 0, 0, 0, 0, 0, 1]].concat(),
        ),
        (CLEARED, [&id(1)[..], &[0]].concat()),
        (CLEAR_UNDONE, id(0).to_vec()),
    ];
    for (index, (kind, payload)) in bad_payloads.iter().enumerate() {
        assert_eq!(
            decode_event(&record(*kind, 1, SAM, payload)).map(|_| ()),
            Err(KinError::MalformedProtocol),
            "payload {index}"
        );
    }
    // A stroke payload over 4,096 bytes.
    let long = stroke_payload(1, 0, 0, 1024, (0, 0), &[0x80; 4096]);
    assert!(decode_event(&record(STROKE_ADDED, 1, SAM, &long)).is_err());
}

#[test]
fn notes_are_canonical_one_line_texts() {
    assert_eq!(normalize_note("  Milk please ").unwrap(), "Milk please");
    assert_eq!(normalize_note(&"é".repeat(60)).unwrap().chars().count(), 60);
    for bad in ["", "   ", "a\tb", &"é".repeat(61)] {
        assert!(normalize_note(bad).is_err(), "{bad:?}");
    }
}

// --- Logs -----------------------------------------------------------------

#[test]
fn each_log_refuses_the_others_events() {
    let household = item_record(1, 1, b"Milk", 2);
    let mut board_log = History::board();
    assert_eq!(
        board_log.append(&batch(std::slice::from_ref(&household))),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(board_log.limit(), MAX_BOARD_EVENT_COUNT);
    let mut household_log = History::new();
    assert_eq!(
        household_log.append(&batch(&[stroke(1, SAM, 1)])),
        Err(KinError::InvalidEvent)
    );
    let mut chat_log = History::chat();
    assert_eq!(
        chat_log.append(&batch(&[stroke(1, SAM, 1)])),
        Err(KinError::InvalidEvent)
    );
    // A household request never carries board events either.
    assert_eq!(
        decode_request(&kine(&[stroke(1, SAM, 1)], 0, TEST_DATE, None)).map(|_| ()),
        Err(KinError::InvalidEvent)
    );
}

// --- Replay ---------------------------------------------------------------

#[test]
fn erase_undo_and_redo_are_visibility_and_the_latest_wins() {
    let records = [
        stroke(1, SAM, 1),
        stroke(2, ALEX, 2),
        hidden(STROKE_HIDDEN, 3, ALEX, 1, true),
        hidden(STROKE_HIDDEN, 4, SAM, 1, false),
        hidden(STROKE_HIDDEN, 5, SAM, 2, true),
    ];
    let state = board(&records);
    assert_eq!(
        shown_strokes(&state),
        vec![id(1)],
        "anyone may erase any stroke; undo brings it back"
    );
    assert_eq!(
        state.stroke(&BoardId(id(2))).unwrap().author.0,
        ALEX,
        "attribution stays"
    );
}

#[test]
fn the_first_add_wins_and_unknown_targets_change_nothing() {
    let mut second = stroke_payload(1, 5, 2, 1, (9, 9), &[]);
    second[16] = 5;
    let records = [
        stroke(1, SAM, 1),
        record(STROKE_ADDED, 2, ALEX, &second),
        hidden(STROKE_HIDDEN, 3, SAM, 9, true),
        moved(4, SAM, 9, 1, 1),
        clear(CLEAR_UNDONE, 5, SAM, 9),
    ];
    let state = board(&records);
    assert_eq!(shown_strokes(&state), vec![id(1)]);
    assert_eq!(state.stroke(&BoardId(id(1))).unwrap().colour, 2);
    assert_eq!(state.visible_magnet_count(), 0);
}

#[test]
fn moving_a_magnet_puts_it_on_top() {
    let records = [
        magnet(1, SAM, 1, "One"),
        magnet(2, SAM, 2, "Two"),
        magnet(3, ALEX, 3, "Three"),
        moved(4, ALEX, 1, 10, 20),
    ];
    let state = board(&records);
    assert_eq!(shown_magnets(&state), vec![id(2), id(3), id(1)]);
    let top = state.magnet(&BoardId(id(1))).unwrap();
    assert_eq!((top.x, top.y), (10, 20));
}

#[test]
fn a_clear_hides_everything_and_undoing_it_shows_exactly_that_again() {
    let records = [
        stroke(1, SAM, 1),
        stroke(2, SAM, 2),
        magnet(3, ALEX, 3, "Hi"),
        hidden(STROKE_HIDDEN, 4, SAM, 2, true),
        clear(CLEARED, 5, ALEX, 50),
        stroke(6, SAM, 4),
    ];
    let cleared = board(&records);
    assert_eq!(shown_strokes(&cleared), vec![id(4)]);
    assert_eq!(cleared.visible_magnet_count(), 0);
    assert_eq!(cleared.open_clear(), Some(BoardId(id(50))));

    let mut undone = records.to_vec();
    // Stroke 1 was erased after the clear: it stays hidden after the undo.
    undone.push(hidden(STROKE_HIDDEN, 7, SAM, 1, true));
    undone.push(clear(CLEAR_UNDONE, 8, SAM, 50));
    let state = board(&undone);
    assert_eq!(
        shown_strokes(&state),
        vec![id(4)],
        "erased since the clear: still hidden"
    );
    assert_eq!(shown_magnets(&state), vec![id(3)]);
    assert_eq!(state.open_clear(), None);
    // Stroke 2 was erased before the clear and stays erased.
    assert!(!state.stroke_shown(&BoardId(id(2))));

    let mut plain_undo = records.to_vec();
    plain_undo.push(clear(CLEAR_UNDONE, 7, SAM, 50));
    assert_eq!(shown_strokes(&board(&plain_undo)), vec![id(1), id(4)]);
}

#[test]
fn an_offline_stroke_that_sorts_before_a_clear_is_cleared_too() {
    // Alex drew at logical time 5 while offline; Sam's clear has time 6 and
    // reached this device first.
    let offline = record_at(
        STROKE_ADDED,
        3,
        5,
        ALEX,
        &stroke_payload(2, 0, 0, 1, (1, 1), &[]),
    );
    let arrived_late = [
        stroke(1, SAM, 1),
        record_at(CLEARED, 2, 6, SAM, &id(50)),
        offline.clone(),
    ];
    let arrived_early = [
        stroke(1, SAM, 1),
        offline,
        record_at(CLEARED, 2, 6, SAM, &id(50)),
    ];
    // Replay order is logical time, so both arrival orders agree.
    assert_eq!(kbrd(&arrived_late), kbrd(&arrived_early));
    assert!(shown_strokes(&board(&arrived_late)).is_empty());
}

#[test]
fn the_visible_budget_refuses_extra_strokes_and_bounds_restores() {
    let mut records = Vec::new();
    let mut event = 0u32;
    let mut next = || {
        event += 1;
        event
    };
    let stroke_with = |n: u16| {
        let mut payload = stroke_payload(1, 0, 0, 1, (0, 0), &[]);
        payload[..2].copy_from_slice(&n.to_le_bytes());
        payload
    };
    for n in 1..=MAX_VISIBLE_STROKES as u16 {
        records.push(record(STROKE_ADDED, next(), SAM, &stroke_with(n)));
    }
    // One past the budget: kept, never shown.
    records.push(record(STROKE_ADDED, next(), SAM, &stroke_with(9_000)));
    let state = board(&records);
    assert_eq!(state.visible_stroke_count(), MAX_VISIBLE_STROKES);
    assert!(state
        .stroke(&BoardId(stroke_with(9_000)[..16].try_into().unwrap()))
        .is_some());
    assert!(!state.stroke_shown(&BoardId(stroke_with(9_000)[..16].try_into().unwrap())));
    // Clear, draw a full board again, then undo the clear: nothing exceeds it.
    records.push(record(CLEARED, next(), SAM, &id(77)));
    for n in 10_001..=10_000 + MAX_VISIBLE_STROKES as u16 {
        records.push(record(STROKE_ADDED, next(), SAM, &stroke_with(n)));
    }
    records.push(record(CLEAR_UNDONE, next(), SAM, &id(77)));
    assert_eq!(board(&records).visible_stroke_count(), MAX_VISIBLE_STROKES);
}

#[test]
fn every_arrival_order_converges_to_the_same_board() {
    let records = vec![
        stroke(1, SAM, 1),
        magnet(2, ALEX, 2, "Hi"),
        stroke(3, ALEX, 3),
        moved(4, SAM, 2, 5, 5),
        hidden(STROKE_HIDDEN, 5, ALEX, 1, true),
        clear(CLEARED, 6, SAM, 40),
        stroke(7, SAM, 4),
        clear(CLEAR_UNDONE, 8, ALEX, 40),
        hidden(MAGNET_HIDDEN, 9, SAM, 2, true),
    ];
    let expected = kbrd(&records);
    let mut reversed = records.clone();
    reversed.reverse();
    assert_eq!(kbrd(&reversed), expected);
    let mut interleaved: Vec<Vec<u8>> = records.iter().step_by(2).cloned().collect();
    interleaved.extend(records.iter().skip(1).step_by(2).cloned());
    assert_eq!(kbrd(&interleaved), expected);
}

// --- KBRD -----------------------------------------------------------------

#[test]
fn kbrd_lists_visible_strokes_then_magnets_bottom_to_top() {
    let bytes = kbrd(&[
        stroke(1, SAM, 1),
        record(MAGNET_PLACED, 2, ALEX, &magnet_payload(2, 1, 0, 7, 8, "🧲")),
        clear(CLEARED, 3, SAM, 30),
        clear(CLEAR_UNDONE, 4, SAM, 30),
        clear(CLEARED, 5, SAM, 31),
        clear(CLEAR_UNDONE, 6, SAM, 31),
    ]);
    assert_eq!(&bytes[..8], b"KBRD\x01\0\0\0");
    assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), 1);
    assert_eq!(&bytes[16..36], &[0; 20], "no clear is open");
    let first = &bytes[36..36 + 36 + 8];
    assert_eq!(&first[..16], &id(1));
    assert_eq!(&first[16..32], &SAM);
    assert_eq!(&first[32..36], &[2, 1, 2, 0]);
    assert_eq!(&first[36..], &[100, 0, 200, 0, 103, 0, 198, 0]);
    let magnet = &bytes[80..];
    assert_eq!(&magnet[..16], &id(2));
    assert_eq!(&magnet[16..32], &ALEX);
    assert_eq!(&magnet[32..40], &[1, 0, 7, 0, 8, 0, 4, 0]);
    assert_eq!(&magnet[40..], "🧲".as_bytes());

    let open = kbrd(&[stroke(1, SAM, 1), clear(CLEARED, 2, SAM, 30)]);
    assert_eq!(&open[16..20], &[1, 0, 0, 0]);
    assert_eq!(&open[20..36], &id(30));
}

// --- Commands -------------------------------------------------------------

fn kcmd(kind: u16, event: u32, logical_time: u64, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0; 128];
    bytes[..4].copy_from_slice(b"KCMD");
    bytes[4..6].copy_from_slice(&1u16.to_le_bytes());
    bytes[8..10].copy_from_slice(&kind.to_le_bytes());
    bytes[12..28].copy_from_slice(&numbered_id(event));
    bytes[28..44].copy_from_slice(&HOUSEHOLD);
    bytes[44..60].copy_from_slice(&SAM);
    bytes[60..76].copy_from_slice(&[0x11; 16]);
    bytes[76..84].copy_from_slice(&(BASE_TIME + i64::from(event)).to_le_bytes());
    bytes[84..92].copy_from_slice(&logical_time.to_le_bytes());
    bytes[124..128].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn run(log: &mut History, command: &[u8]) -> Result<Vec<u8>, KinError> {
    let mut input = (command.len() as u32).to_le_bytes().to_vec();
    input.extend_from_slice(command);
    input.extend_from_slice(&context_bytes());
    execute_board_history(&input, log)
}

/// The canonical event a KCMT carries.
fn event_of(kcmt: &[u8]) -> Vec<u8> {
    let length = u32::from_le_bytes(kcmt[8..12].try_into().unwrap()) as usize;
    kcmt[20..20 + length].to_vec()
}

#[test]
fn kcmd_carries_the_exact_board_payload() {
    let payload = stroke_payload(1, 2, 1, 2, (100, 200), &[6, 3]);
    let (command, _) = decode_command(&kcmd(STROKE_ADDED, 1, 1, &payload)).unwrap();
    assert_eq!(
        command,
        crate::command::HouseholdCommand::Board(EventKind::BoardStrokeAdded {
            stroke_id: BoardId(id(1)),
            colour: 2,
            width: 1,
            points: vec![(100, 200), (103, 198)],
        })
    );
    // An ID, option, date or expiry outside the payload is refused.
    let mut with_id = kcmd(STROKE_ADDED, 1, 1, &payload);
    with_id[92] = 1;
    assert_eq!(
        decode_command(&with_id).map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
    let mut with_option = kcmd(STROKE_ADDED, 1, 1, &payload);
    with_option[112] = 1;
    assert_eq!(
        decode_command(&with_option).map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
}

#[test]
fn board_commands_follow_the_board_rules() {
    let mut log = History::board();
    let added = run(
        &mut log,
        &kcmd(STROKE_ADDED, 1, 1, &stroke_payload(1, 0, 0, 1, (5, 5), &[])),
    )
    .unwrap();
    let event = event_of(&added);
    assert!(decode_event(&event).unwrap().kind.is_board());
    log.append(&batch(&[event])).unwrap();
    // The same stroke ID again, a no-op restore and an unknown magnet are refused.
    for (kind, payload) in [
        (STROKE_ADDED, stroke_payload(1, 0, 0, 1, (5, 5), &[])),
        (STROKE_HIDDEN, [&id(1)[..], &[0; 8]].concat()),
        (
            MAGNET_MOVED,
            [&id(9)[..], &[1, 0, 1, 0, 0, 0, 0, 0]].concat(),
        ),
        (CLEAR_UNDONE, id(9).to_vec()),
    ] {
        assert_eq!(
            run(&mut log, &kcmd(kind, 2, 2, &payload)).map(|_| ()),
            Err(KinError::InvalidEvent),
            "kind {kind}"
        );
    }
    // Erase it, then a clear of an empty board is refused.
    let erased = run(
        &mut log,
        &kcmd(
            STROKE_HIDDEN,
            2,
            2,
            &[&id(1)[..], &[1, 0, 0, 0, 0, 0, 0, 0]].concat(),
        ),
    )
    .unwrap();
    log.append(&batch(&[event_of(&erased)])).unwrap();
    assert_eq!(
        run(&mut log, &kcmd(CLEARED, 3, 3, &id(30))).map(|_| ()),
        Err(KinError::InvalidEvent)
    );
    // A logical time not after the log's latest is refused.
    assert_eq!(
        run(
            &mut log,
            &kcmd(STROKE_ADDED, 4, 2, &stroke_payload(2, 0, 0, 1, (5, 5), &[]))
        )
        .map(|_| ()),
        Err(KinError::InvalidEvent)
    );
}

#[test]
fn board_commands_need_the_board_log_and_other_commands_refuse_it() {
    let payload = stroke_payload(1, 0, 0, 1, (5, 5), &[]);
    let mut household = History::new();
    assert_eq!(
        run(&mut household, &kcmd(STROKE_ADDED, 1, 1, &payload)).map(|_| ()),
        Err(KinError::InvalidEvent)
    );
    let mut chat = History::chat();
    assert_eq!(
        run(&mut chat, &kcmd(STROKE_ADDED, 1, 1, &payload)).map(|_| ()),
        Err(KinError::InvalidEvent)
    );
    // A household command (ADD_ITEM) on the board log is refused.
    let mut add = kcmd(1, 1, 1, b"Milk");
    add[92..108].copy_from_slice(&id(3));
    let mut board_log = History::board();
    assert_eq!(
        run(&mut board_log, &add).map(|_| ()),
        Err(KinError::InvalidEvent)
    );
}
