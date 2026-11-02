// The instance-held history: append batches, truncate, clear, and replay
// that matches a whole KINE request byte for byte.
use std::path::PathBuf;

use crate::command::{execute, execute_with, CommandContext, HeldHistory, HouseholdCommand};
use crate::core::{replay, replay_history};
use crate::error::KinError;
use crate::event::{ActorId, DeviceId, EventId, HouseholdId, ItemClassification, ItemId};
use crate::event_decode::EventView;
use crate::history::History;
use crate::state::SummaryInput;
use crate::test_support::*;
use crate::wire::{BINDING_BYTES, EVENT_HEADER_BYTES, MAX_EVENT_COUNT, REQUEST_HEADER_BYTES};

/// An append batch: count, one length per record, then the records.
fn batch(records: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = (records.len() as u32).to_le_bytes().to_vec();
    for record in records {
        bytes.extend_from_slice(&(record.len() as u32).to_le_bytes());
    }
    for record in records {
        bytes.extend_from_slice(record);
    }
    bytes
}

/// A KINE request split into its record-less context and its records.
fn split(request: &[u8]) -> (Vec<u8>, Vec<Vec<u8>>) {
    let count = header_u32(request, 8) as usize;
    let bindings = u16::from_le_bytes([request[60], request[61]]) as usize;
    let mut offset = REQUEST_HEADER_BYTES + bindings * BINDING_BYTES;
    let mut context = request[..offset].to_vec();
    context[8..12].fill(0);
    let mut records = Vec::new();
    for _ in 0..count {
        let payload = header_u32(request, offset + 84) as usize;
        let end = offset + EVENT_HEADER_BYTES + payload;
        records.push(request[offset..end].to_vec());
        offset = end;
    }
    assert_eq!(offset, request.len());
    (context, records)
}

#[test]
fn replaying_held_history_matches_the_whole_request_for_every_golden_fixture() {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("rust/fixtures/golden");
    for name in ["empty", "full", "distributed", "pulse-expiry", "bulk"] {
        let request = std::fs::read(fixtures.join(format!("{name}.kine"))).unwrap();
        let (context, records) = split(&request);
        let mut history = History::new();
        // Appended in two batches, as a host appends what changed.
        let half = records.len() / 2;
        history.append(&batch(&records[..half])).unwrap();
        history.append(&batch(&records[half..])).unwrap();
        assert_eq!(history.len(), records.len(), "{name}");
        assert_eq!(
            replay_history(&context, &mut history).unwrap(),
            replay(&request).unwrap(),
            "{name}"
        );
    }
}

#[test]
fn records_round_trip_and_truncate_drops_from_the_end() {
    let records = vec![
        item_record(1, 0x11, b"Milk", 1),
        text_record(5, 2, 0x12, b"Bins"),
        item_record(3, 0x13, b"Eggs", 2),
    ];
    let mut history = History::new();
    history.append(&batch(&records)).unwrap();
    assert_eq!(
        history.records().map(<[u8]>::to_vec).collect::<Vec<_>>(),
        records
    );
    history.truncate(1).unwrap();
    assert_eq!(
        history.records().map(<[u8]>::to_vec).collect::<Vec<_>>(),
        records[..1]
    );
    assert_eq!(history.truncate(2).unwrap_err(), KinError::InvalidAbi);
    history.append(&batch(&records[2..])).unwrap();
    assert_eq!(history.len(), 2);
    history.clear();
    assert!(history.is_empty());
    history.append(&batch(&[])).unwrap();
    assert!(history.is_empty());
}

#[test]
fn a_bad_record_or_layout_leaves_the_history_unchanged() {
    let good = item_record(1, 0x11, b"Milk", 1);
    let mut bad = item_record(2, 0x12, b"Eggs", 1);
    bad[2] = 99; // unknown event kind (u16 at byte 2)
    let mut history = History::new();
    history.append(&batch(std::slice::from_ref(&good))).unwrap();
    assert!(history.append(&batch(&[good.clone(), bad])).is_err());
    assert_eq!(history.len(), 1);
    let mut short = batch(std::slice::from_ref(&good));
    short.pop();
    assert_eq!(
        history.append(&short).unwrap_err(),
        KinError::MalformedProtocol
    );
    let mut long = batch(std::slice::from_ref(&good));
    long.push(0);
    assert_eq!(
        history.append(&long).unwrap_err(),
        KinError::MalformedProtocol
    );
    assert_eq!(
        history.append(&[1, 0]).unwrap_err(),
        KinError::MalformedProtocol
    );
    let mut huge = (MAX_EVENT_COUNT as u32).to_le_bytes().to_vec();
    huge.extend_from_slice(&[0; 8]);
    assert_eq!(history.append(&huge).unwrap_err(), KinError::SizeLimit);
    assert_eq!(history.len(), 1);
}

#[test]
fn a_projection_context_must_carry_no_records() {
    let records = [item_record(1, 0x11, b"Milk", 1)];
    let request = kine(&records, 0, TEST_DATE, None);
    let mut history = History::new();
    assert_eq!(
        replay_history(&request, &mut history).unwrap_err(),
        KinError::MalformedProtocol
    );
}

/// The whole KINE request for `context` (record-less) and `records`.
fn whole(context: &[u8], records: &[Vec<u8>]) -> Vec<u8> {
    let mut request = context.to_vec();
    request[8..12].copy_from_slice(&(records.len() as u32).to_le_bytes());
    for record in records {
        request.extend_from_slice(record);
    }
    request
}

fn golden(name: &str) -> (Vec<u8>, Vec<Vec<u8>>) {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("rust/fixtures/golden");
    split(&std::fs::read(fixtures.join(format!("{name}.kine"))).unwrap())
}

#[test]
fn the_checkpoint_matches_a_full_replay_after_every_appended_record() {
    for name in ["full", "distributed", "pulse-expiry", "bulk"] {
        let (context, records) = golden(name);
        let mut history = History::new();
        let mut reused = 0;
        for n in 0..records.len() {
            history.append(&batch(&records[n..=n])).unwrap();
            // A prefix in arrival order may itself be invalid (an event can
            // need one that arrived later but replays earlier); then both
            // replays must fail the same way.
            assert_eq!(
                replay_history(&context, &mut history),
                replay(&whole(&context, &records[..=n])),
                "{name} after record {n}"
            );
            reused += usize::from(history.last_replay_reused());
        }
        // Single-device histories grow strictly in replay order, so every
        // projection after the first reuses the checkpoint.
        if name == "bulk" {
            assert_eq!(reused, records.len() - 1, "{name}");
        }
    }
}

#[test]
fn equal_logical_times_another_context_or_a_truncation_rebuild() {
    let (context, records) = golden("bulk");
    // The first prefix of at least 10 records that is valid on its own.
    let k = (10..records.len())
        .find(|&k| replay(&whole(&context, &records[..k])).is_ok())
        .unwrap();
    let mut history = History::new();
    history.append(&batch(&records[..k])).unwrap();
    replay_history(&context, &mut history).unwrap();

    // A record at the checkpoint's last logical time could be concurrent with
    // an earlier decision: rebuild.
    let mut equal_time = records[k].clone();
    equal_time[72..80].copy_from_slice(&records[k - 1][72..80]);
    history
        .append(&batch(std::slice::from_ref(&equal_time)))
        .unwrap();
    let mut expected = records[..k].to_vec();
    expected.push(equal_time);
    assert_eq!(
        replay_history(&context, &mut history),
        replay(&whole(&context, &expected))
    );
    assert!(!history.last_replay_reused());

    // Truncating below the checkpoint drops it.
    history.truncate(k).unwrap();
    replay_history(&context, &mut history).unwrap();
    assert!(!history.last_replay_reused());
    replay_history(&context, &mut history).unwrap();
    assert!(history.last_replay_reused(), "nothing new, same context");

    // Another identity context (a target household) rebuilds.
    let mut targeted = context.clone();
    targeted[44..60].copy_from_slice(&records[0][20..36]);
    assert_eq!(
        replay_history(&targeted, &mut history).unwrap(),
        replay(&whole(&targeted, &records[..k])).unwrap()
    );
    assert!(!history.last_replay_reused());
}

#[test]
fn a_rejected_record_drops_the_checkpoint_and_the_next_replay_rebuilds() {
    let records = vec![item_record(1, 0x11, b"Milk", 1)];
    let context = kine(&[], 0, TEST_DATE, None);
    let mut history = History::new();
    history.append(&batch(&records)).unwrap();
    replay_history(&context, &mut history).unwrap();
    // Decodes, but completes an Item that does not exist.
    let orphan = reference_record(2, 9, 0x77);
    history
        .append(&batch(std::slice::from_ref(&orphan)))
        .unwrap();
    assert_eq!(
        replay_history(&context, &mut history).unwrap_err(),
        replay(&whole(&context, &[records[0].clone(), orphan])).unwrap_err()
    );
    history.truncate(1).unwrap();
    assert_eq!(
        replay_history(&context, &mut history).unwrap(),
        replay(&whole(&context, &records)).unwrap()
    );
    assert!(!history.last_replay_reused());
}

#[test]
fn a_command_from_the_checkpoint_matches_one_from_a_full_replay() {
    let context = |sequence: u8| CommandContext {
        event_id: EventId([sequence; 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([3; 16]),
        timestamp: 1_234 + i64::from(sequence),
        logical_time: u64::from(sequence),
    };
    let add = |id: u8| HouseholdCommand::AddItem {
        id: ItemId([id; 16]),
        text: format!("Item {id}"),
        classification: ItemClassification::Need,
    };
    let request = |records: &[Vec<u8>]| {
        crate::request::decode_request(&kine(records, 5_000, TEST_DATE, None)).unwrap()
    };
    let mut records = Vec::new();
    for (sequence, command) in [
        (1, add(0x41)),
        (2, add(0x42)),
        (3, HouseholdCommand::ArchiveItem(ItemId([0x41; 16]))),
    ] {
        records.push(
            execute(&command, context(sequence), request(&records))
                .unwrap()
                .event
                .canonical_bytes,
        );
    }
    let mut history = History::new();
    history.append(&batch(&records)).unwrap();
    let next = HouseholdCommand::CompleteItem(ItemId([0x42; 16]));
    let full = execute(&next, context(4), request(&records)).unwrap();
    let mut held = HeldHistory::new(&mut history, request(&[])).unwrap();
    let from_checkpoint = execute_with(&next, context(4), &mut held).unwrap();
    assert_eq!(
        from_checkpoint.event.canonical_bytes,
        full.event.canonical_bytes
    );
    assert_eq!(from_checkpoint.encoded_projection, full.encoded_projection);

    // Conflicts are judged the same way: a logical time that is not later,
    // an event ID already held, or another household.
    let stale = CommandContext {
        logical_time: 3,
        ..context(9)
    };
    let reused = CommandContext {
        event_id: EventId([2; 16]),
        ..context(9)
    };
    let foreign = CommandContext {
        household_id: HouseholdId([8; 16]),
        ..context(9)
    };
    for bad in [stale, reused, foreign] {
        let mut held = HeldHistory::new(&mut history, request(&[])).unwrap();
        assert_eq!(
            execute_with(&next, bad, &mut held).unwrap_err(),
            execute(&next, bad, request(&records)).unwrap_err()
        );
    }
}

#[test]
fn reading_a_record_in_place_gives_the_summary_what_decoding_gives() {
    for name in ["empty", "full", "distributed", "pulse-expiry", "bulk"] {
        let (_, records) = golden(name);
        for record in &records {
            let view = EventView::new(record).unwrap();
            let event = view.decode().unwrap();
            assert_eq!(view.event_id(), event.event_id, "{name}");
            assert_eq!(view.logical_time(), event.logical_time, "{name}");
            assert_eq!(
                SummaryInput::from_view(&view),
                SummaryInput::from_kind(&event.kind),
                "{name}: {:?}",
                event.kind
            );
        }
    }
}
