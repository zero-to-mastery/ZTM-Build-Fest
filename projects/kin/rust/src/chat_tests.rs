// Household chat (#109): CHAT_MESSAGE_POSTED (44), CHAT_MESSAGE_EDITED (45)
// and CHAT_MESSAGE_DELETED (46), their replay rules, the commands that create
// them, the KCHQ/KCHP page and the KCHT text arena. Wire records and expected
// page bytes are written out by hand; they never come from the encoders.
use crate::chat::*;
use crate::command::{
    decode_command, execute, execute_with, CommandContext, HeldHistory, HouseholdCommand as C,
};
use crate::core::{chat_page, replay_history};
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::recurrence::CivilDate;
use crate::request::{decode_context, decode_request, DecodedRequest};
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
/// Member 1 posts from device 0x11, member 2 from 0x21, member 3 (the admin
/// in these tests) from 0x31.
const MEMBER_1: [u8; 16] = [1; 16];
const MEMBER_2: [u8; 16] = [2; 16];
const ADMIN: [u8; 16] = [3; 16];
const BASE_TIME: i64 = 1_791_475_200_000;

fn record(kind: u16, event: u32, actor: [u8; 16], device: u8, payload: &[u8]) -> Vec<u8> {
    let mut record = Vec::new();
    record.extend_from_slice(&1u16.to_le_bytes());
    record.extend_from_slice(&kind.to_le_bytes());
    record.extend_from_slice(&numbered_id(event));
    record.extend_from_slice(&HOUSEHOLD);
    record.extend_from_slice(&actor);
    record.extend_from_slice(&[device; 16]);
    record.extend_from_slice(&(BASE_TIME + i64::from(event)).to_le_bytes());
    record.extend_from_slice(&u64::from(event).to_le_bytes());
    record.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    record.extend_from_slice(payload);
    record
}

fn message(id: u8) -> [u8; 16] {
    [id; 16]
}

/// Blob refs and keys are distinct per (message, version).
fn blob(id: u8, version: u8) -> [u8; 32] {
    let mut bytes = [id; 32];
    bytes[31] = version;
    bytes
}

fn key(id: u8, version: u8) -> [u8; 32] {
    let mut bytes = [!id; 32];
    bytes[31] = version;
    bytes
}

fn posted(event: u32, actor: [u8; 16], device: u8, id: u8, kind: u8) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&[kind, 0, 0, 0]);
    payload.extend_from_slice(&blob(id, 0));
    payload.extend_from_slice(&key(id, 0));
    record(44, event, actor, device, &payload)
}

/// A post of message `id` carrying blob version `version` of it.
fn posted_version(event: u32, actor: [u8; 16], device: u8, id: u8, version: u8) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&[1, 0, 0, 0]);
    payload.extend_from_slice(&blob(id, version));
    payload.extend_from_slice(&key(id, version));
    record(44, event, actor, device, &payload)
}

/// What a page can show: the messages and the admin claims.
type Shown = (
    Vec<ChatMessage>,
    std::collections::BTreeMap<ChatMessageId, Vec<ActorId>>,
);
fn shown(state: &ChatState) -> Shown {
    (state.messages.clone(), state.admin_claims.clone())
}

fn edited(event: u32, actor: [u8; 16], device: u8, id: u8, version: u8) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&blob(id, version));
    payload.extend_from_slice(&key(id, version));
    record(45, event, actor, device, &payload)
}

fn deleted(event: u32, actor: [u8; 16], device: u8, id: u8, by_admin: bool) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&[u8::from(by_admin), 0, 0, 0]);
    record(46, event, actor, device, &payload)
}

/// A chat log holding `records`, appended in the order given.
fn history_of(records: &[Vec<u8>]) -> History {
    let mut history = History::chat();
    history.append(&batch(records)).unwrap();
    history
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

fn local_context() -> DecodedRequest {
    decode_context(&kine(&[], BASE_TIME + 100, TEST_DATE, None)).unwrap()
}

/// The chat state a replay of `records` leaves.
fn chat(records: &[Vec<u8>]) -> ChatState {
    let context = local_context();
    let state = history_of(records)
        .replay(&context)
        .unwrap()
        .finalize(context.as_of, context.civil_date)
        .unwrap();
    (*state.chat).clone()
}

fn status_of(state: &ChatState, id: u8) -> ChatMessageStatus {
    state.get(&ChatMessageId(message(id))).unwrap().status
}

#[test]
fn chat_records_decode_as_documented() {
    let event = decode_event(&posted(1, MEMBER_1, 0x11, 7, 1)).unwrap();
    assert_eq!(
        event.kind,
        EventKind::ChatMessagePosted {
            mentions: Default::default(),
            message_id: ChatMessageId(message(7)),
            content_kind: ChatContentKind::Text,
            blob_ref: blob(7, 0),
            blob_key: key(7, 0),
            reply_to: None,
        }
    );
    assert_eq!(event.canonical_bytes.len(), 88 + 84);
    assert_eq!(
        decode_event(&edited(2, MEMBER_1, 0x11, 7, 1)).unwrap().kind,
        EventKind::ChatMessageEdited {
            mentions: Default::default(),
            message_id: ChatMessageId(message(7)),
            blob_ref: blob(7, 1),
            blob_key: key(7, 1),
        }
    );
    assert_eq!(
        decode_event(&deleted(3, ADMIN, 0x31, 7, true))
            .unwrap()
            .kind,
        EventKind::ChatMessageDeleted {
            message_id: ChatMessageId(message(7)),
            by_admin: true,
        }
    );
    assert_eq!(
        decode_event(&posted(1, MEMBER_1, 0x11, 7, 2)).unwrap().kind,
        EventKind::ChatMessagePosted {
            mentions: Default::default(),
            message_id: ChatMessageId(message(7)),
            content_kind: ChatContentKind::Attachment,
            blob_ref: blob(7, 0),
            blob_key: key(7, 0),
            reply_to: None,
        }
    );
}

#[test]
fn malformed_chat_records_are_rejected() {
    let good_post = posted(1, MEMBER_1, 0x11, 7, 1);
    let good_edit = edited(2, MEMBER_1, 0x11, 7, 1);
    let good_delete = deleted(3, MEMBER_1, 0x11, 7, false);
    let mut bad = Vec::new();
    // Zero message ID, unknown content kind, reserved bytes, zero ref, zero key.
    for (offset, value) in [(88, 0u8), (104, 0), (104, 3), (105, 1), (107, 1)] {
        let mut record = good_post.clone();
        if offset == 88 {
            record[88..104].fill(0);
        } else {
            record[offset] = value;
        }
        bad.push(record);
    }
    let mut zero_ref = good_post.clone();
    zero_ref[108..140].fill(0);
    bad.push(zero_ref);
    let mut zero_key = good_post.clone();
    zero_key[140..172].fill(0);
    bad.push(zero_key);
    let mut zero_edit_ref = good_edit.clone();
    zero_edit_ref[104..136].fill(0);
    bad.push(zero_edit_ref);
    let mut zero_edit_key = good_edit.clone();
    zero_edit_key[136..168].fill(0);
    bad.push(zero_edit_key);
    // by_admin must be 0 or 1; the rest reserved.
    for (offset, value) in [(104, 2u8), (105, 1), (107, 1)] {
        let mut record = good_delete.clone();
        record[offset] = value;
        bad.push(record);
    }
    // Truncated and overlong payloads.
    for good in [&good_post, &good_edit, &good_delete] {
        let mut short = good[..good.len() - 1].to_vec();
        let length = (short.len() - 88) as u32;
        short[84..88].copy_from_slice(&length.to_le_bytes());
        bad.push(short);
        let mut long = good.to_vec();
        long.push(0);
        let length = (long.len() - 88) as u32;
        long[84..88].copy_from_slice(&length.to_le_bytes());
        bad.push(long);
    }
    for record in bad {
        assert!(decode_event(&record).is_err(), "{:?}", &record[84..]);
    }
    // Chat is schema 1 only.
    let mut schema_2 = good_post;
    schema_2[..2].copy_from_slice(&2u16.to_le_bytes());
    assert_eq!(decode_event(&schema_2), Err(KinError::UnsupportedVersion));
}

#[test]
fn a_message_is_posted_edited_and_deleted() {
    let records = [
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_2, 0x21, 2, 1),
        edited(3, MEMBER_1, 0x11, 1, 1),
        edited(4, MEMBER_1, 0x12, 1, 2),
        deleted(5, MEMBER_2, 0x21, 2, false),
    ];
    let state = chat(&records);
    assert_eq!(state.messages.len(), 2);
    assert_eq!(
        state.messages[0],
        ChatMessage {
            mentions: Default::default(),
            message_id: ChatMessageId(message(1)),
            author: ActorId(MEMBER_1),
            device: DeviceId([0x11; 16]),
            posted_at: BASE_TIME + 1,
            edited_at: BASE_TIME + 4,
            status: ChatMessageStatus::Edited,
            content_kind: ChatContentKind::Text,
            blob_ref: blob(1, 2),
            blob_key: key(1, 2),
            reply_to: None,
        }
    );
    let second = &state.messages[1];
    assert_eq!(second.status, ChatMessageStatus::Deleted);
    assert_eq!((second.blob_ref, second.blob_key), ([0; 32], [0; 32]));
    // Every replaced or deleted blob is retired, in replay order.
    assert_eq!(state.retired, vec![blob(1, 0), blob(1, 1), blob(2, 0)]);
    assert!(state.admin_claims.is_empty());
}

#[test]
fn conflicting_chat_events_are_kept_and_change_nothing() {
    let base = posted(1, MEMBER_1, 0x11, 1, 1);
    let attachment = posted(2, MEMBER_1, 0x11, 2, 2);
    let expected = chat(&[base.clone(), attachment.clone()]);
    // Events that change nothing a page shows. Those bringing a new blob no
    // message will ever show retire it; the others retire nothing.
    for (conflicting, retires) in [
        // A second post of the same ID, even by the author: the first wins.
        (posted_version(3, MEMBER_2, 0x21, 1, 5), Some(blob(1, 5))),
        (posted_version(3, MEMBER_1, 0x11, 1, 6), Some(blob(1, 6))),
        // Another member edits it.
        (edited(3, MEMBER_2, 0x21, 1, 1), Some(blob(1, 1))),
        // An attachment is never edited.
        (edited(3, MEMBER_1, 0x11, 2, 1), Some(blob(2, 1))),
        // An edit to the blob the message already has.
        (edited(3, MEMBER_1, 0x11, 1, 0), None),
        // Messages this log never saw: elsewhere the edit may apply.
        (edited(3, MEMBER_1, 0x11, 9, 1), None),
        (deleted(3, MEMBER_1, 0x11, 9, false), None),
        (deleted(3, ADMIN, 0x31, 9, true), None),
        // Another member deletes it without claiming to be an admin.
        (deleted(3, MEMBER_2, 0x21, 1, false), None),
    ] {
        let state = chat(&[base.clone(), attachment.clone(), conflicting.clone()]);
        let what = format!("{:?}", decode_event(&conflicting).unwrap().kind);
        assert_eq!(shown(&state), shown(&expected), "{what}");
        assert_eq!(
            state.retired,
            retires.into_iter().collect::<Vec<_>>(),
            "{what}"
        );
    }
    // Nothing happens to a deleted message; an edit after it retires its blob.
    let gone = [base.clone(), deleted(2, MEMBER_1, 0x11, 1, false)];
    let expected = chat(&gone);
    for (after, retires) in [
        (
            edited(3, MEMBER_1, 0x11, 1, 1),
            vec![blob(1, 0), blob(1, 1)],
        ),
        (deleted(3, MEMBER_1, 0x11, 1, false), vec![blob(1, 0)]),
        (deleted(3, ADMIN, 0x31, 1, true), vec![blob(1, 0)]),
    ] {
        let mut records = gone.to_vec();
        records.push(after);
        let state = chat(&records);
        assert_eq!(shown(&state), shown(&expected));
        assert_eq!(state.retired, retires);
    }
}

#[test]
fn a_blob_a_visible_message_shows_is_never_retired() {
    // Edit A -> B -> A: the message shows A again, so only B is retired.
    let state = chat(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        edited(2, MEMBER_1, 0x11, 1, 1),
        edited(3, MEMBER_1, 0x11, 1, 0),
    ]);
    assert_eq!(
        state.get(&ChatMessageId(message(1))).unwrap().blob_ref,
        blob(1, 0)
    );
    assert_eq!(state.retired_blobs(&[]), vec![blob(1, 1)]);
    // Two messages sharing a blob: deleting one keeps the blob while the
    // other shows it; deleting both retires it once.
    let mut shared = posted(2, MEMBER_2, 0x21, 2, 1);
    shared[108..140].copy_from_slice(&blob(1, 0));
    let mut records = vec![
        posted(1, MEMBER_1, 0x11, 1, 1),
        shared,
        deleted(3, MEMBER_1, 0x11, 1, false),
    ];
    assert_eq!(chat(&records).messages.len(), 2);
    assert_eq!(chat(&records).retired_blobs(&[]), Vec::<[u8; 32]>::new());
    records.push(deleted(4, MEMBER_2, 0x21, 2, false));
    assert_eq!(chat(&records).retired_blobs(&[]), vec![blob(1, 0)]);
}

#[test]
fn a_backdated_copy_of_a_blob_neither_hides_nor_deletes_the_original() {
    // Logical times are the author's to write, and every chat member can
    // read every blob reference. A modified client copying member 1's blob
    // into an earlier-dated event:
    let original = posted(10, MEMBER_1, 0x11, 1, 1);
    // ...as a post of its own message: both messages show; the copy shows as
    // its author's (it holds the key; that can't be prevented).
    let mut repost = posted(9, MEMBER_2, 0x21, 9, 1);
    repost[108..140].copy_from_slice(&blob(1, 0));
    let state = chat(&[original.clone(), repost]);
    let authors: Vec<_> = state
        .messages
        .iter()
        .map(|message| (message.message_id, message.author))
        .collect();
    assert_eq!(
        authors,
        vec![
            (ChatMessageId(message(9)), ActorId(MEMBER_2)),
            (ChatMessageId(message(1)), ActorId(MEMBER_1))
        ]
    );
    assert!(state.retired_blobs(&[]).is_empty());
    // ...as an edit of its own attachment, which applies nowhere: the blob
    // is a candidate, but member 1's message shows it, so it isn't retired.
    let mut edit = edited(9, MEMBER_2, 0x21, 2, 0);
    edit[104..136].copy_from_slice(&blob(1, 0));
    let state = chat(&[posted(5, MEMBER_2, 0x21, 2, 2), original, edit]);
    assert_eq!(status_of(&state, 1), ChatMessageStatus::Live);
    assert!(state.retired.contains(&blob(1, 0)));
    assert!(state.retired_blobs(&[]).is_empty());
}

#[test]
fn a_delete_wins_over_a_concurrent_edit_in_either_replay_order() {
    // Same logical time from two devices of the author: replay orders them
    // by device ID, so each order is reached by swapping the devices.
    for (edit_device, delete_device) in [(0x11, 0x12), (0x12, 0x11)] {
        let mut edit = edited(2, MEMBER_1, edit_device, 1, 1);
        let mut delete = deleted(2, MEMBER_1, delete_device, 1, false);
        edit[4..20].copy_from_slice(&numbered_id(20));
        delete[4..20].copy_from_slice(&numbered_id(21));
        let state = chat(&[posted(1, MEMBER_1, 0x11, 1, 1), edit, delete]);
        assert_eq!(status_of(&state, 1), ChatMessageStatus::Deleted);
        let message = state.get(&ChatMessageId(message(1))).unwrap();
        assert_eq!(message.blob_ref, [0; 32]);
        // Both blobs the message ever had are retired, in either order:
        // the edited text doesn't survive the deletion.
        let mut retired = state.retired.clone();
        retired.sort();
        assert_eq!(
            retired,
            vec![blob(1, 0), blob(1, 1)],
            "edit on {edit_device:#x}"
        );
    }
}

#[test]
fn replay_is_deterministic_in_any_input_order() {
    let records = vec![
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_2, 0x21, 2, 1),
        edited(3, MEMBER_1, 0x11, 1, 1),
        deleted(4, ADMIN, 0x31, 2, true),
        posted(5, MEMBER_2, 0x21, 3, 2),
        deleted(6, MEMBER_1, 0x11, 1, false),
    ];
    let expected = chat(&records);
    let mut reversed = records.clone();
    reversed.reverse();
    assert_eq!(chat(&reversed), expected);
    let mut rotated = records.clone();
    rotated.rotate_left(2);
    assert_eq!(chat(&rotated), expected);
}

#[test]
fn an_admin_removal_counts_only_while_its_claimant_is_named_an_admin() {
    let records = [
        posted(1, MEMBER_1, 0x11, 1, 1),
        deleted(2, ADMIN, 0x31, 1, true),
        // A second claim by the same admin is kept once.
        deleted(3, ADMIN, 0x32, 1, true),
        deleted(4, MEMBER_2, 0x21, 1, true),
    ];
    let state = chat(&records);
    let id = ChatMessageId(message(1));
    assert_eq!(
        state.admin_claims[&id],
        vec![ActorId(ADMIN), ActorId(MEMBER_2)]
    );
    // Replay leaves the message live; the page decides.
    assert_eq!(status_of(&state, 1), ChatMessageStatus::Live);
    assert!(state.removed_by_admin(&id, &[ActorId(ADMIN)]));
    assert!(state.removed_by_admin(&id, &[ActorId([9; 16]), ActorId(MEMBER_2)]));
    assert!(!state.removed_by_admin(&id, &[ActorId(MEMBER_1)]));
    assert!(!state.removed_by_admin(&id, &[]));
    assert!(
        state.retired.is_empty(),
        "retired at page time, not in replay"
    );
}

#[test]
fn the_household_history_and_the_chat_log_refuse_each_others_events() {
    let item = item_record(1, 1, b"Milk", 0);
    let post = posted(2, MEMBER_1, 0x11, 1, 1);
    let mut household = History::new();
    assert_eq!(
        household.append(&batch(&[item.clone(), post.clone()])),
        Err(KinError::InvalidEvent)
    );
    assert!(household.is_empty(), "nothing of a refused batch is kept");
    household
        .append(&batch(std::slice::from_ref(&item)))
        .unwrap();
    let mut chat_log = History::chat();
    assert_eq!(
        chat_log.append(&batch(std::slice::from_ref(&item))),
        Err(KinError::InvalidEvent)
    );
    chat_log
        .append(&batch(std::slice::from_ref(&post)))
        .unwrap();
    // A whole household request refuses chat events too.
    assert_eq!(
        decode_request(&kine(&[item, post], 0, TEST_DATE, None)).unwrap_err(),
        KinError::InvalidEvent
    );
    // Each log has its own cap.
    assert_eq!(household.limit(), crate::wire::MAX_EVENT_COUNT);
    assert_eq!(chat_log.limit(), MAX_CHAT_EVENT_COUNT);
    const { assert!(MAX_CHAT_EVENT_COUNT > 2 * 100_000) };
}

// Commands.

fn context(event: u8, actor: [u8; 16], device: u8, logical_time: u64) -> CommandContext {
    CommandContext {
        event_id: EventId([event; 16]),
        household_id: HouseholdId(HOUSEHOLD),
        actor_id: ActorId(actor),
        device_id: DeviceId([device; 16]),
        timestamp: BASE_TIME,
        logical_time,
    }
}

/// Runs a command against the chat log and, when it succeeds, appends the
/// new event as the host would once stored.
fn run(log: &mut History, command: C, ctx: CommandContext) -> Result<(), KinError> {
    run_named(log, command, ctx, &[ADMIN])
}

/// `run` with the household admins the host names.
fn run_named(
    log: &mut History,
    command: C,
    ctx: CommandContext,
    admins: &[[u8; 16]],
) -> Result<(), KinError> {
    let held = HeldHistory::new(log, local_context())?
        .with_admins(admins.iter().copied().map(ActorId).collect());
    let result = execute_with(&command, ctx, &mut { held })?;
    assert!(
        result.encoded_projection.is_empty(),
        "a chat command has no projection"
    );
    log.append(&batch(&[result.event.canonical_bytes])).unwrap();
    Ok(())
}

fn post(id: u8, content_kind: ChatContentKind) -> C {
    C::PostChatMessage {
        mentions: Default::default(),
        id: ChatMessageId(message(id)),
        content_kind,
        blob_ref: blob(id, 0),
        blob_key: key(id, 0),
        reply_to: None,
    }
}

fn edit(id: u8, version: u8) -> C {
    C::EditChatMessage {
        mentions: Default::default(),
        id: ChatMessageId(message(id)),
        blob_ref: blob(id, version),
        blob_key: key(id, version),
    }
}

fn delete(id: u8, by_admin: bool) -> C {
    C::DeleteChatMessage {
        id: ChatMessageId(message(id)),
        by_admin,
    }
}

#[test]
fn commands_post_edit_and_delete_and_reject_what_replay_would_ignore() {
    let mut events = History::chat();
    run(
        &mut events,
        post(1, ChatContentKind::Text),
        context(1, MEMBER_1, 0x11, 1),
    )
    .unwrap();
    run(
        &mut events,
        post(2, ChatContentKind::Attachment),
        context(2, MEMBER_2, 0x21, 2),
    )
    .unwrap();
    let rejected = [
        post(1, ChatContentKind::Text),
        edit(1, 0),
        edit(2, 1),
        edit(9, 1),
        delete(9, false),
        // Your own message is deleted as yourself, someone else's as admin.
        delete(1, true),
        delete(2, false),
    ];
    for command in rejected {
        assert_eq!(
            run(&mut events, command.clone(), context(3, MEMBER_1, 0x11, 3)),
            Err(KinError::InvalidEvent),
            "{command:?}"
        );
    }
    // Zero IDs, refs and keys are not events at all.
    for (id, blob_ref, blob_key) in [
        (message(3), [0; 32], key(3, 0)),
        (message(3), blob(3, 0), [0; 32]),
        ([0; 16], blob(3, 0), key(3, 0)),
    ] {
        let command = C::PostChatMessage {
            mentions: Default::default(),
            id: ChatMessageId(id),
            content_kind: ChatContentKind::Text,
            blob_ref,
            blob_key,
            reply_to: None,
        };
        assert_eq!(
            run(&mut events, command, context(3, MEMBER_1, 0x11, 3)),
            Err(KinError::MalformedProtocol)
        );
    }
    assert_eq!(
        run(&mut events, edit(1, 1), context(3, MEMBER_2, 0x21, 3)),
        Err(KinError::InvalidEvent),
        "only the author edits"
    );
    run(&mut events, edit(1, 1), context(3, MEMBER_1, 0x12, 3)).unwrap();
    // A removal needs its actor among the admins the host names.
    for (actor, admins) in [(ADMIN, &[][..]), (MEMBER_1, &[ADMIN][..])] {
        assert_eq!(
            run_named(
                &mut events,
                delete(2, true),
                context(4, actor, 0x31, 4),
                admins
            ),
            Err(KinError::InvalidEvent)
        );
    }
    // Blob references are used once: no edit back to an earlier blob, no
    // post with another message's blob.
    assert_eq!(
        run(&mut events, edit(1, 0), context(4, MEMBER_1, 0x11, 4)),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        run(
            &mut events,
            C::PostChatMessage {
                mentions: Default::default(),
                id: ChatMessageId(message(5)),
                content_kind: ChatContentKind::Text,
                blob_ref: blob(1, 1),
                blob_key: key(5, 0),
                reply_to: None,
            },
            context(4, MEMBER_2, 0x21, 4)
        ),
        Err(KinError::InvalidEvent)
    );
    run(&mut events, delete(2, true), context(4, ADMIN, 0x31, 4)).unwrap();
    assert_eq!(
        run(&mut events, delete(2, true), context(5, ADMIN, 0x31, 5)),
        Err(KinError::InvalidEvent),
        "one claim per admin"
    );
    run(&mut events, delete(1, false), context(5, MEMBER_1, 0x11, 5)).unwrap();
    for command in [edit(1, 2), delete(1, false), delete(1, true)] {
        let actor = if matches!(command, C::DeleteChatMessage { by_admin: true, .. }) {
            ADMIN
        } else {
            MEMBER_1
        };
        assert_eq!(
            run(&mut events, command, context(6, actor, 0x11, 6)),
            Err(KinError::InvalidEvent)
        );
    }
    let context = local_context();
    let state = events
        .replay(&context)
        .unwrap()
        .finalize(context.as_of, context.civil_date)
        .unwrap();
    assert_eq!(status_of(&state.chat, 1), ChatMessageStatus::Deleted);
    assert!(state
        .chat
        .removed_by_admin(&ChatMessageId(message(2)), &[ActorId(ADMIN)]));
}

#[test]
fn chat_commands_run_against_the_chat_log_only() {
    let household_request = DecodedRequest {
        events: vec![],
        as_of: BASE_TIME + 100,
        summary_cursor: None,
        civil_date: CivilDate::from_encoded(TEST_DATE).unwrap(),
        target_household_id: None,
        identity_bindings: vec![],
    };
    assert_eq!(
        execute(
            &post(1, ChatContentKind::Text),
            context(1, MEMBER_1, 0x11, 1),
            household_request
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
    let mut household = History::new();
    assert_eq!(
        execute_with(
            &post(1, ChatContentKind::Text),
            context(1, MEMBER_1, 0x11, 1),
            &mut HeldHistory::new(&mut household, local_context()).unwrap()
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
    let mut log = History::chat();
    assert_eq!(
        run(&mut log, C::ClearPulse, context(1, MEMBER_1, 0x11, 1)),
        Err(KinError::InvalidEvent)
    );
    // Through the kin_chat_execute layout.
    let mut intent = kcmd(44, message(1), 1, &[blob(1, 0), key(1, 0)].concat());
    intent[12..28].copy_from_slice(&[9; 16]);
    intent[28..44].copy_from_slice(&HOUSEHOLD);
    intent[44..60].copy_from_slice(&MEMBER_1);
    intent[60..76].copy_from_slice(&[0x11; 16]);
    intent[76..84].copy_from_slice(&BASE_TIME.to_le_bytes());
    let mut input = (intent.len() as u32).to_le_bytes().to_vec();
    input.extend_from_slice(&intent);
    input.extend_from_slice(&0u32.to_le_bytes());
    // No members named (#130).
    input.extend_from_slice(&0u32.to_le_bytes());
    input.extend_from_slice(&kine(&[], BASE_TIME + 100, TEST_DATE, None));
    let result = crate::command::execute_chat_history(&input, &mut log).unwrap();
    assert_eq!(&result[..8], b"KCMT\x01\0\0\0");
    assert_eq!(u32_at(&result, 8), 88 + 84);
    assert_eq!(u32_at(&result, 16), 0, "no projection");
    assert!(log.is_empty(), "executing appends nothing");
    // Admins in the layout: at most 16, non-zero, all present.
    for (count, admin) in [(17u32, [3u8; 16]), (1, [0; 16]), (2, [3; 16])] {
        let mut input = (intent.len() as u32).to_le_bytes().to_vec();
        input.extend_from_slice(&intent);
        input.extend_from_slice(&count.to_le_bytes());
        input.extend_from_slice(&admin);
        input.extend_from_slice(&0u32.to_le_bytes());
        input.extend_from_slice(&kine(&[], BASE_TIME + 100, TEST_DATE, None));
        assert!(crate::command::execute_chat_history(&input, &mut log).is_err());
    }
}

fn kcmd(kind: u16, id: [u8; 16], option: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0; 128];
    bytes[..4].copy_from_slice(b"KCMD");
    bytes[4..6].copy_from_slice(&1u16.to_le_bytes());
    bytes[8..10].copy_from_slice(&kind.to_le_bytes());
    bytes[84..92].copy_from_slice(&1u64.to_le_bytes());
    bytes[92..108].copy_from_slice(&id);
    bytes[112] = option;
    bytes[124..128].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

#[test]
fn kcmd_carries_chat_commands() {
    let mut refs = blob(1, 0).to_vec();
    refs.extend_from_slice(&key(1, 0));
    assert_eq!(
        decode_command(&kcmd(44, message(1), 1, &refs)).unwrap().0,
        post(1, ChatContentKind::Text)
    );
    assert_eq!(
        decode_command(&kcmd(44, message(1), 2, &refs)).unwrap().0,
        post(1, ChatContentKind::Attachment)
    );
    let mut edit_refs = blob(1, 1).to_vec();
    edit_refs.extend_from_slice(&key(1, 1));
    assert_eq!(
        decode_command(&kcmd(45, message(1), 0, &edit_refs))
            .unwrap()
            .0,
        edit(1, 1)
    );
    assert_eq!(
        decode_command(&kcmd(46, message(1), 0, &[])).unwrap().0,
        delete(1, false)
    );
    assert_eq!(
        decode_command(&kcmd(46, message(1), 1, &[])).unwrap().0,
        delete(1, true)
    );
    for bytes in [
        kcmd(44, [0; 16], 1, &refs),
        kcmd(44, message(1), 0, &refs),
        kcmd(44, message(1), 3, &refs),
        kcmd(44, message(1), 1, &refs[..63]),
        kcmd(44, message(1), 1, &[refs.as_slice(), &[0]].concat()),
        kcmd(45, message(1), 1, &edit_refs),
        kcmd(45, [0; 16], 0, &edit_refs),
        kcmd(45, message(1), 0, &[]),
        kcmd(46, message(1), 2, &[]),
        kcmd(46, [0; 16], 0, &[]),
        kcmd(46, message(1), 0, &[0; 16]),
        kcmd(44, message(1), 1, &[[0; 32], key(1, 0)].concat()),
        kcmd(45, message(1), 0, &[blob(1, 1), [0; 32]].concat()),
    ] {
        assert_eq!(
            decode_command(&bytes).unwrap_err(),
            KinError::MalformedProtocol,
            "{:?}",
            &bytes[8..10]
        );
    }
    // A date or expiry is not part of a chat command.
    let mut dated = kcmd(46, message(1), 0, &[]);
    dated[108..112].copy_from_slice(&TEST_DATE.to_le_bytes());
    assert_eq!(
        decode_command(&dated).unwrap_err(),
        KinError::MalformedProtocol
    );
}

// Texts and pages.

#[test]
fn texts_are_checked() {
    for good in ["hi", "a\tb\nc", "🏠 home", &"é".repeat(MAX_CHAT_TEXT_CHARS)] {
        assert!(check_text(good.as_bytes()).is_ok(), "{good:?}");
    }
    for bad in [
        &b""[..],
        b" \n\t ",
        b"a\rb",
        b"\x00",
        b"a\x1bb",
        "\u{85}".as_bytes(),
        &[0xff, 0xfe],
    ] {
        assert_eq!(check_text(bad), Err(KinError::InvalidEvent), "{bad:?}");
    }
    let too_long = "a".repeat(MAX_CHAT_TEXT_CHARS + 1);
    assert_eq!(check_text(too_long.as_bytes()), Err(KinError::InvalidEvent));
    // Emoji count as their scalar values, not as graphemes (#113): a
    // five-scalar family emoji is five toward the limit, as the client's
    // chatTextProblem counts them.
    let family = "👨\u{200d}👩\u{200d}👧";
    assert_eq!(family.chars().count(), 5);
    let at_limit = family.repeat(MAX_CHAT_TEXT_CHARS / 5);
    assert!(check_text(at_limit.as_bytes()).is_ok());
    let past_limit = format!("{at_limit}a");
    assert_eq!(
        check_text(past_limit.as_bytes()),
        Err(KinError::InvalidEvent)
    );
}

fn kcht(entries: &[([u8; 32], &[u8])]) -> Vec<u8> {
    let mut bytes = b"KCHT\x01\0\0\0".to_vec();
    bytes.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (blob_ref, text) in entries {
        bytes.extend_from_slice(blob_ref);
        bytes.extend_from_slice(&(text.len() as u32).to_le_bytes());
        bytes.extend_from_slice(text);
    }
    bytes
}

#[test]
fn the_text_arena_stores_each_text_alone_and_forgets_by_zeroing() {
    let mut texts = ChatTexts::new();
    let result = put_texts(
        &kcht(&[
            (blob(1, 0), b"Dinner at 6"),
            (blob(2, 0), b"\x07bell"),
            (blob(1, 0), b"ignored"),
        ]),
        &mut texts,
    )
    .unwrap();
    assert_eq!(result, b"KCHS\x01\0\0\0\x03\0\0\0\x00\x01\x00");
    // Content-addressed: the first text for a blob stays.
    assert_eq!(texts.get(&blob(1, 0)), Some(&b"Dinner at 6"[..]));
    assert_eq!(texts.get(&blob(2, 0)), None);
    assert_eq!(texts.len(), 1);
    // A malformed request stores nothing.
    let mut short = kcht(&[(blob(3, 0), b"ok"), (blob(4, 0), b"cut")]);
    short.pop();
    assert_eq!(
        put_texts(&short, &mut texts),
        Err(KinError::MalformedProtocol)
    );
    assert_eq!(texts.get(&blob(3, 0)), None);
    for bad in [
        kcht(&[]),
        kcht(&[([0; 32], b"zero ref")]),
        [kcht(&[(blob(3, 0), b"ok")]), vec![0]].concat(),
        b"KCHT\x02\0\0\0\x01\0\0\0".to_vec(),
    ] {
        assert!(put_texts(&bad, &mut texts).is_err());
    }
    texts.forget(&blob(1, 0));
    assert_eq!(texts.get(&blob(1, 0)), None);
    assert!(texts.is_empty());
    texts.clear();
}

#[test]
fn a_batch_that_fills_the_arena_starts_it_over_first_and_keeps_every_text_it_reports() {
    let mut texts = ChatTexts::new();
    // Fill the arena to within a few bytes, in full-length texts, growing
    // its buffer by hand along the way.
    let long = "a".repeat(MAX_CHAT_TEXT_CHARS);
    let mut stored = 0usize;
    let mut index = 0u32;
    while stored + long.len() <= MAX_CHAT_ARENA_BYTES {
        let mut blob_ref = [0x70; 32];
        blob_ref[..4].copy_from_slice(&index.to_le_bytes());
        texts.make_room(long.len());
        texts.put(blob_ref, long.as_bytes()).unwrap();
        stored += long.len();
        index += 1;
    }
    let mut first = [0x70; 32];
    first[..4].copy_from_slice(&0u32.to_le_bytes());
    assert!(
        texts.get(&first) == Some(long.as_bytes()),
        "texts survive growth"
    );
    // A batch that doesn't fit starts the arena over once, before storing,
    // so both of its texts are held afterwards.
    let result = put_texts(
        &kcht(&[(blob(1, 0), long.as_bytes()), (blob(2, 0), long.as_bytes())]),
        &mut texts,
    )
    .unwrap();
    assert_eq!(&result[12..], &[0, 0]);
    assert!(texts.get(&blob(1, 0)) == Some(long.as_bytes()));
    assert!(texts.get(&blob(2, 0)) == Some(long.as_bytes()));
    assert!(texts.get(&first).is_none());
    assert_eq!(texts.len(), 2);
}

fn kchq(before: u32, limit: u16, flags: u8, admins: &[[u8; 16]], context: &[u8]) -> Vec<u8> {
    let mut bytes = b"KCHQ\x01\0\0\0".to_vec();
    bytes.extend_from_slice(&before.to_le_bytes());
    bytes.extend_from_slice(&limit.to_le_bytes());
    bytes.push(flags);
    bytes.push(0);
    bytes.extend_from_slice(&(admins.len() as u32).to_le_bytes());
    for admin in admins {
        bytes.extend_from_slice(admin);
    }
    bytes.extend_from_slice(context);
    bytes
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

#[test]
fn the_kchp_page_is_laid_out_as_documented() {
    let records = vec![
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_2, 0x21, 2, 1),
        edited(3, MEMBER_1, 0x11, 1, 1),
        posted(4, MEMBER_2, 0x21, 3, 2),
        deleted(5, ADMIN, 0x31, 3, true),
        posted(6, MEMBER_1, 0x11, 4, 1),
        deleted(7, MEMBER_1, 0x11, 4, false),
    ];
    let mut history = history_of(&records);
    let mut texts = ChatTexts::new();
    put_texts(
        &kcht(&[
            (blob(1, 1), b"Edited"),
            (blob(2, 0), b"Hello"),
            (blob(1, 0), b"Old"),
            (blob(4, 0), b"Gone"),
        ]),
        &mut texts,
    )
    .unwrap();
    let context = kine(&[], 0, TEST_DATE, None);
    // The newest three, texts and retired blobs, with the admin named.
    let page = chat_page(
        &kchq(u32::MAX, 3, 0b11, &[ADMIN], &context),
        &mut history,
        &mut texts,
    )
    .unwrap();
    let mut expected = b"KCHP\x01\0\0\0".to_vec();
    for value in [4u32, 1, 3, 5, 3] {
        expected.extend_from_slice(&value.to_le_bytes());
    }
    let mut record = |id: u8,
                      author: [u8; 16],
                      device: u8,
                      posted: i64,
                      status: u8,
                      kind: u8,
                      blob_ref: [u8; 32],
                      text: (u32, u32)| {
        expected.extend_from_slice(&message(id));
        expected.extend_from_slice(&author);
        expected.extend_from_slice(&[device; 16]);
        expected.extend_from_slice(&(BASE_TIME + posted).to_le_bytes());
        expected.extend_from_slice(&0i64.to_le_bytes());
        expected.extend_from_slice(&u32::from(id - 1).to_le_bytes());
        expected.extend_from_slice(&[status, kind, 0, 0]);
        expected.extend_from_slice(&blob_ref);
        expected.extend_from_slice(&text.0.to_le_bytes());
        expected.extend_from_slice(&text.1.to_le_bytes());
        expected.extend_from_slice(&[0; 16]);
    };
    record(2, MEMBER_2, 0x21, 2, 0, 1, blob(2, 0), (0, 5));
    record(3, MEMBER_2, 0x21, 4, 3, 2, [0; 32], (0, 0));
    record(4, MEMBER_1, 0x11, 6, 2, 1, [0; 32], (0, 0));
    expected.extend_from_slice(&key(2, 0));
    expected.extend_from_slice(&[0; 64]);
    expected.extend_from_slice(b"Hello");
    for retired in [blob(1, 0), blob(4, 0), blob(3, 0)] {
        expected.extend_from_slice(&retired);
    }
    assert_eq!(page, expected);
    // Reading the page forgot the texts of retired blobs.
    assert_eq!(texts.get(&blob(1, 0)), None);
    assert_eq!(texts.get(&blob(4, 0)), None);
    assert_eq!(texts.get(&blob(1, 1)), Some(&b"Edited"[..]));

    // The page before it: message 1, edited, with its text at offset 0.
    let older = chat_page(
        &kchq(1, 50, 0b01, &[ADMIN], &context),
        &mut history,
        &mut texts,
    )
    .unwrap();
    assert_eq!(
        [u32_at(&older, 8), u32_at(&older, 12), u32_at(&older, 16)],
        [4, 0, 1]
    );
    assert_eq!(older[28 + 68], ChatMessageStatus::Edited as u8);
    assert_eq!(
        i64::from_le_bytes(older[28 + 56..28 + 64].try_into().unwrap()),
        BASE_TIME + 3
    );
    assert_eq!(&older[28 + 72..28 + 104], &blob(1, 1));
    assert_eq!(&older[older.len() - 6..], b"Edited");
    assert_eq!(u32_at(&older, 24), 0, "no retired list asked for");

    // Without the admin named, message 3 is live again (its blob and key
    // return) and nothing retires it.
    let unnamed = chat_page(
        &kchq(u32::MAX, 3, 0b10, &[], &context),
        &mut history,
        &mut texts,
    )
    .unwrap();
    let second = 28 + 128;
    assert_eq!(unnamed[second + 68], ChatMessageStatus::Live as u8);
    assert_eq!(&unnamed[second + 72..second + 104], &blob(3, 0));
    assert_eq!(u32_at(&unnamed, 20), 0, "texts not asked for");
    assert_eq!(u32_at(&unnamed, 24), 2);
}

#[test]
fn malformed_page_requests_are_rejected() {
    let context = kine(&[], 0, TEST_DATE, None);
    let mut history = history_of(&[posted(1, MEMBER_1, 0x11, 1, 1)]);
    let mut texts = ChatTexts::new();
    let mut bad = vec![
        kchq(u32::MAX, 0, 0, &[], &context),
        kchq(u32::MAX, 501, 0, &[], &context),
        // Bit 5 asks for topics (#312); bit 6 is reserved.
        kchq(u32::MAX, 10, 0b100_0000, &[], &context),
        kchq(u32::MAX, 10, 0, &[[0; 16]], &context),
        kchq(u32::MAX, 10, 0, &[[3; 16]; 17], &context),
        kchq(
            u32::MAX,
            10,
            0,
            &[],
            &kine(&[posted(1, MEMBER_1, 0x11, 1, 1)], 0, TEST_DATE, None),
        ),
        kchq(u32::MAX, 10, 0, &[], &[]),
    ];
    let mut reserved = kchq(u32::MAX, 10, 0, &[], &context);
    reserved[15] = 1;
    bad.push(reserved);
    let mut admins_past_end = kchq(u32::MAX, 10, 0, &[], &[]);
    admins_past_end[16] = 1;
    bad.push(admins_past_end);
    for request in bad {
        assert!(
            chat_page(&request, &mut history, &mut texts).is_err(),
            "{:?}",
            &request[..20]
        );
    }
    let mut version = kchq(u32::MAX, 10, 0, &[], &context);
    version[4] = 2;
    assert_eq!(
        chat_page(&version, &mut history, &mut texts),
        Err(KinError::UnsupportedVersion)
    );
    // An empty chat is an empty page.
    let mut empty = History::chat();
    let page = chat_page(
        &kchq(u32::MAX, 10, 0b11, &[], &context),
        &mut empty,
        &mut texts,
    )
    .unwrap();
    assert_eq!(
        page,
        b"KCHP\x01\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0"
    );
    // The household projection never sees the chat.
    let mut household = History::new();
    household
        .append(&batch(&[item_record(1, 1, b"Milk", 0)]))
        .unwrap();
    assert!(replay_history(&context, &mut household).is_ok());
}

#[test]
fn identity_bindings_apply_to_chat_authors() {
    // A message written before the household was bound replays under the
    // bound member and device.
    let placeholder = [0x70; 16];
    let records = vec![posted(1, placeholder, 0x76, 1, 1)];
    let mut records = records;
    records[0][20..36].copy_from_slice(&[0x75; 16]);
    let binding = IdentityBinding {
        legacy_household_id: HouseholdId([0x75; 16]),
        legacy_actor_id: ActorId(placeholder),
        legacy_device_id: DeviceId([0x76; 16]),
        household_id: HouseholdId(HOUSEHOLD),
        actor_id: ActorId(MEMBER_1),
        device_id: DeviceId([0x11; 16]),
    };
    let context = bound_kine(&[], 0, TEST_DATE, None, Some(HOUSEHOLD), &[binding]);
    let mut history = history_of(&records);
    let page = chat_page(
        &kchq(u32::MAX, 10, 0, &[], &context),
        &mut history,
        &mut ChatTexts::new(),
    )
    .unwrap();
    assert_eq!(&page[28 + 16..28 + 32], &MEMBER_1);
    assert_eq!(&page[28 + 32..28 + 48], &[0x11; 16]);
}

#[test]
fn a_long_chat_replays_and_pages_quickly() {
    // 100,000 messages, one in ten edited and one in twenty deleted.
    const MESSAGES: u32 = 100_000;
    let mut records = Vec::with_capacity(MESSAGES as usize * 2);
    let mut event = 0u32;
    for index in 0..MESSAGES {
        let id = {
            let mut id = [0x40; 16];
            id[..4].copy_from_slice(&index.to_le_bytes());
            id
        };
        let mut reference = [0x50; 32];
        reference[..4].copy_from_slice(&index.to_le_bytes());
        event += 1;
        let mut payload = id.to_vec();
        payload.extend_from_slice(&[1, 0, 0, 0]);
        payload.extend_from_slice(&reference);
        payload.extend_from_slice(&[0x60; 32]);
        records.push(record(44, event, MEMBER_1, 0x11, &payload));
        if index % 10 == 0 {
            event += 1;
            let mut payload = id.to_vec();
            reference[31] = 1;
            payload.extend_from_slice(&reference);
            payload.extend_from_slice(&[0x61; 32]);
            records.push(record(45, event, MEMBER_1, 0x11, &payload));
        }
        if index % 20 == 5 {
            event += 1;
            let mut payload = id.to_vec();
            payload.extend_from_slice(&[0, 0, 0, 0]);
            records.push(record(46, event, MEMBER_1, 0x11, &payload));
        }
    }
    let mut history = history_of(&records);
    let context = kine(&[], 0, TEST_DATE, None);
    let started = std::time::Instant::now();
    let page = chat_page(
        &kchq(u32::MAX, 50, 0b01, &[], &context),
        &mut history,
        &mut ChatTexts::new(),
    )
    .unwrap();
    let first = started.elapsed();
    assert_eq!(u32_at(&page, 8), MESSAGES);
    assert_eq!(u32_at(&page, 16), 50);
    // A second page reuses the replay the history holds.
    let started = std::time::Instant::now();
    chat_page(
        &kchq(MESSAGES - 50, 50, 0, &[], &context),
        &mut history,
        &mut ChatTexts::new(),
    )
    .unwrap();
    let second = started.elapsed();
    // Generous bounds for unoptimized test builds on shared CI machines.
    assert!(first.as_secs() < 20, "first page took {first:?}");
    assert!(second.as_secs() < 5, "second page took {second:?}");
    assert!(
        history.last_replay_reused(),
        "the second page used the checkpoint"
    );
}

// Reactions (#127).

/// A reaction record: message `id`, `on`, and the emoji, by hand.
fn reacted(event: u32, actor: [u8; 16], device: u8, id: u8, emoji: &str, on: bool) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&[u8::from(on), 0, 0, 0]);
    payload.extend_from_slice(&(emoji.len() as u32).to_le_bytes());
    payload.extend_from_slice(emoji.as_bytes());
    record(47, event, actor, device, &payload)
}

/// The same record at an explicit logical time.
fn reacted_at(
    event: u32,
    logical: u64,
    actor: [u8; 16],
    device: u8,
    id: u8,
    emoji: &str,
    on: bool,
) -> Vec<u8> {
    let mut bytes = reacted(event, actor, device, id, emoji, on);
    bytes[76..84].copy_from_slice(&logical.to_le_bytes());
    bytes
}

fn react(id: u8, emoji: &str, on: bool) -> C {
    C::ReactChatMessage {
        id: ChatMessageId(message(id)),
        emoji: emoji.to_owned(),
        on,
    }
}

fn reactions_on(state: &ChatState, id: u8) -> Vec<(String, Vec<[u8; 16]>)> {
    state
        .reactions
        .get(&ChatMessageId(message(id)))
        .map(|groups| {
            groups
                .iter()
                .map(|group| {
                    (
                        group.emoji.clone(),
                        group.actors.iter().map(|a| a.0).collect(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn an_emoji_is_one_grapheme_from_the_emoji_ranges() {
    for emoji in [
        "\u{1F44D}",
        "\u{2764}\u{FE0F}",
        "\u{2764}",
        "\u{1F602}",
        "\u{1F44D}\u{1F3FD}",
        "\u{1F1FA}\u{1F1F8}",
        "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}",
        "\u{1F469}\u{1F3FD}\u{200D}\u{2695}\u{FE0F}",
        "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
        "1\u{FE0F}\u{20E3}",
        "#\u{20E3}",
        "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
        "\u{1FAE0}",
    ] {
        assert_eq!(check_emoji(emoji), Ok(()), "{emoji:?}");
    }
    let too_long = "\u{1F468}\u{200D}".repeat(5) + "\u{1F468}";
    assert!(too_long.len() > MAX_EMOJI_BYTES);
    for emoji in [
        "",
        "a",
        "1",
        "#",
        " ",
        "\n",
        "hi",
        "\u{1F44D}a",
        "a\u{1F44D}",
        "\u{1F44D}\u{1F44D}",
        "\u{1F44D}\u{200D}",
        "\u{200D}\u{1F44D}",
        "\u{FE0F}",
        "\u{1F3FD}\u{1F44D}x",
        "\u{1F1FA}",
        "\u{1F1FA}\u{1F1F8}\u{1F1E7}",
        "\u{1F3F4}\u{E0067}",
        "1\u{20E3}\u{20E3}",
        "\u{0}",
        "<b>",
        "\u{1F44D}\u{200D}\u{1F1FA}\u{1F1F8}",
        "\u{1F1FA}\u{1F1F8}\u{200D}\u{1F1FA}\u{1F1F8}",
        "1\u{20E3}\u{200D}\u{1F44D}",
        "\u{1F44D}\u{1F3FD}\u{FE0F}",
        &too_long,
    ] {
        assert_eq!(check_emoji(emoji), Err(KinError::InvalidEvent), "{emoji:?}");
    }
}

#[test]
fn every_picker_emoji_is_accepted() {
    // The picker's table (web/chat/emoji.json): each entry is `["emoji", "name"]`.
    let table = include_str!("../../web/chat/emoji.json");
    let mut checked = 0;
    for line in table.lines() {
        let mut rest = line;
        while let Some(at) = rest.find("[\"") {
            let after = &rest[at + 2..];
            let Some(end) = after.find('"') else { break };
            let emoji = &after[..end];
            if !emoji.is_empty() && !emoji.is_ascii() {
                assert_eq!(
                    check_emoji(emoji),
                    Ok(()),
                    "{emoji:?} ({:x?})",
                    emoji.chars().map(|c| c as u32).collect::<Vec<_>>()
                );
                checked += 1;
            }
            rest = &after[end..];
        }
    }
    assert!(checked > 300, "read {checked} emoji");
}

#[test]
fn reaction_records_decode_as_documented() {
    let event = decode_event(&reacted(1, MEMBER_1, 0x11, 7, "\u{1F44D}", true)).unwrap();
    assert_eq!(
        event.kind,
        EventKind::ChatReactionSet {
            message_id: ChatMessageId(message(7)),
            emoji: "\u{1F44D}".to_owned(),
            on: true,
        }
    );
    assert_eq!(event.canonical_bytes.len(), 88 + 24 + 4);
    assert!(event.kind.is_chat());
    let off = decode_event(&reacted(2, MEMBER_1, 0x11, 7, "\u{2764}\u{FE0F}", false)).unwrap();
    assert_eq!(
        off.kind,
        EventKind::ChatReactionSet {
            message_id: ChatMessageId(message(7)),
            emoji: "\u{2764}\u{FE0F}".to_owned(),
            on: false,
        }
    );
    // The encoder writes the same bytes.
    assert_eq!(
        crate::codec::encode_event(&off).unwrap(),
        reacted(2, MEMBER_1, 0x11, 7, "\u{2764}\u{FE0F}", false)
    );

    // Malformed records are refused.
    let mut bad = Vec::new();
    bad.push(reacted(1, MEMBER_1, 0x11, 7, "a", true));
    bad.push(reacted(1, MEMBER_1, 0x11, 7, "", true));
    bad.push(reacted(1, MEMBER_1, 0x11, 7, "\u{1F44D}\u{1F44D}", true));
    let mut zero_message = reacted(1, MEMBER_1, 0x11, 7, "\u{1F44D}", true);
    zero_message[88..104].fill(0);
    bad.push(zero_message);
    let mut flag = reacted(1, MEMBER_1, 0x11, 7, "\u{1F44D}", true);
    flag[104] = 2;
    bad.push(flag);
    let mut reserved = reacted(1, MEMBER_1, 0x11, 7, "\u{1F44D}", true);
    reserved[106] = 1;
    bad.push(reserved);
    let mut length = reacted(1, MEMBER_1, 0x11, 7, "\u{1F44D}", true);
    length[108] = 5;
    bad.push(length);
    let mut cut = reacted(1, MEMBER_1, 0x11, 7, "\u{1F44D}", true);
    cut.truncate(cut.len() - 1);
    let new_length = (cut.len() - 88) as u32;
    cut[84..88].copy_from_slice(&new_length.to_le_bytes());
    bad.push(cut);
    for record in bad {
        assert!(decode_event(&record).is_err());
    }
}

#[test]
fn replay_keeps_the_last_reaction_write_per_member_message_and_emoji() {
    let thumbs = "\u{1F44D}";
    let heart = "\u{2764}\u{FE0F}";
    let state = chat(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        reacted(2, MEMBER_2, 0x21, 1, thumbs, true),
        reacted(3, MEMBER_1, 0x11, 1, thumbs, true),
        reacted(4, MEMBER_2, 0x21, 1, heart, true),
        // Adding twice changes nothing.
        reacted(5, MEMBER_2, 0x21, 1, thumbs, true),
        // Another device of member 2 takes the thumbs-up back.
        reacted(6, MEMBER_2, 0x22, 1, thumbs, false),
        // Taking back what was never added changes nothing.
        reacted(7, ADMIN, 0x31, 1, thumbs, false),
    ]);
    assert_eq!(
        reactions_on(&state, 1),
        vec![
            (thumbs.to_owned(), vec![MEMBER_1]),
            (heart.to_owned(), vec![MEMBER_2]),
        ]
    );
    // Taking the last one back leaves no group and no entry.
    let state = chat(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        reacted(2, MEMBER_1, 0x11, 1, thumbs, true),
        reacted(3, MEMBER_1, 0x11, 1, thumbs, false),
    ]);
    assert!(state.reactions.is_empty());
    // A reaction to a message this log lacks changes nothing.
    let state = chat(&[reacted(1, MEMBER_1, 0x11, 9, thumbs, true)]);
    assert!(state.reactions.is_empty());
}

#[test]
fn two_devices_of_one_member_converge_whatever_order_they_arrive_in() {
    let thumbs = "\u{1F44D}";
    // Both devices toggle at the same logical time; replay order is total
    // (logical time, then event ID), so the result doesn't depend on which
    // arrived first.
    let post = posted(1, MEMBER_1, 0x11, 1, 1);
    let on = reacted_at(2, 5, MEMBER_2, 0x21, 1, thumbs, true);
    let off = reacted_at(3, 5, MEMBER_2, 0x22, 1, thumbs, false);
    let forward = chat(&[post.clone(), on.clone(), off.clone()]);
    let backward = chat(&[post.clone(), off.clone(), on.clone()]);
    assert_eq!(forward.reactions, backward.reactions);
    // Event 3 sorts after event 2: the later write (off) wins.
    assert!(forward.reactions.is_empty());
    // And replaying the same log again gives the same projection.
    let again = chat(&[post, on, off]);
    assert_eq!(again.reactions, forward.reactions);
}

#[test]
fn commands_react_and_refuse_what_changes_nothing() {
    let thumbs = "\u{1F44D}";
    let mut events = History::chat();
    run(
        &mut events,
        post(1, ChatContentKind::Text),
        context(1, MEMBER_1, 0x11, 1),
    )
    .unwrap();
    run(
        &mut events,
        post(2, ChatContentKind::Text),
        context(2, MEMBER_1, 0x11, 2),
    )
    .unwrap();
    run(
        &mut events,
        react(1, thumbs, true),
        context(3, MEMBER_2, 0x21, 3),
    )
    .unwrap();
    // Reacting twice, taking back what isn't there, a message that isn't
    // there, a bad emoji and a deleted message are all refused.
    run(&mut events, delete(2, false), context(4, MEMBER_1, 0x11, 4)).unwrap();
    for (command, actor) in [
        (react(1, thumbs, true), MEMBER_2),
        (react(1, thumbs, false), MEMBER_1),
        (react(1, "\u{2764}\u{FE0F}", false), MEMBER_2),
        (react(9, thumbs, true), MEMBER_2),
        (react(1, "a", true), MEMBER_2),
        (react(1, "\u{1F44D}\u{1F44D}", true), MEMBER_2),
        (react(2, thumbs, true), MEMBER_2),
    ] {
        assert!(run(&mut events, command, context(9, actor, 0x21, 9)).is_err());
    }
    // Another member may add the same emoji, and a member may add another.
    run(
        &mut events,
        react(1, thumbs, true),
        context(5, MEMBER_1, 0x11, 5),
    )
    .unwrap();
    run(
        &mut events,
        react(1, "\u{2764}\u{FE0F}", true),
        context(6, MEMBER_2, 0x21, 6),
    )
    .unwrap();
    run(
        &mut events,
        react(1, thumbs, false),
        context(7, MEMBER_2, 0x21, 7),
    )
    .unwrap();
    let context = local_context();
    let state = events
        .replay(&context)
        .unwrap()
        .finalize(context.as_of, context.civil_date)
        .unwrap();
    assert_eq!(
        reactions_on(&state.chat, 1),
        vec![
            (thumbs.to_owned(), vec![MEMBER_1]),
            ("\u{2764}\u{FE0F}".to_owned(), vec![MEMBER_2]),
        ]
    );
}

#[test]
fn a_message_collects_a_bounded_number_of_different_emoji() {
    let mut events = History::chat();
    run(
        &mut events,
        post(1, ChatContentKind::Text),
        context(1, MEMBER_1, 0x11, 1),
    )
    .unwrap();
    // 24 distinct emoji from the first block of faces.
    for (index, scalar) in (0x1F600u32..0x1F600 + MAX_REACTION_GROUPS as u32).enumerate() {
        let emoji = char::from_u32(scalar).unwrap().to_string();
        run(
            &mut events,
            react(1, &emoji, true),
            context(2 + index as u8, MEMBER_2, 0x21, 2 + index as u64),
        )
        .unwrap();
    }
    let next = char::from_u32(0x1F600 + MAX_REACTION_GROUPS as u32)
        .unwrap()
        .to_string();
    assert!(run(
        &mut events,
        react(1, &next, true),
        context(100, MEMBER_2, 0x21, 100)
    )
    .is_err());
    // Another member adding one of the 24 is still fine.
    let first = char::from_u32(0x1F600).unwrap().to_string();
    run(
        &mut events,
        react(1, &first, true),
        context(101, MEMBER_1, 0x11, 101),
    )
    .unwrap();
}

#[test]
fn the_wire_command_reacts() {
    // KCMD 47: the message in the entity ID, `on` in the option byte, the
    // emoji as the text.
    let mut bytes = vec![0u8; 128];
    bytes[..4].copy_from_slice(b"KCMD");
    bytes[4] = 1;
    bytes[8] = 47;
    bytes[12..28].copy_from_slice(&[7; 16]);
    bytes[28..44].copy_from_slice(&HOUSEHOLD);
    bytes[44..60].copy_from_slice(&MEMBER_2);
    bytes[60..76].copy_from_slice(&[0x21; 16]);
    bytes[76..84].copy_from_slice(&BASE_TIME.to_le_bytes());
    bytes[84..92].copy_from_slice(&5u64.to_le_bytes());
    bytes[92..108].copy_from_slice(&message(1));
    bytes[112] = 1;
    let emoji = "\u{1F44D}";
    bytes[124..128].copy_from_slice(&(emoji.len() as u32).to_le_bytes());
    bytes.extend_from_slice(emoji.as_bytes());
    let (command, _) = decode_command(&bytes).unwrap();
    assert_eq!(command, react(1, emoji, true));
    let mut off = bytes.clone();
    off[112] = 0;
    assert_eq!(decode_command(&off).unwrap().0, react(1, emoji, false));
    for broken in [
        {
            let mut b = bytes.clone();
            b[112] = 2;
            b
        },
        {
            let mut b = bytes.clone();
            b[92..108].fill(0);
            b
        },
        {
            // No emoji.
            let mut b = bytes[..128].to_vec();
            b[124..128].copy_from_slice(&0u32.to_le_bytes());
            b
        },
        {
            // Past 32 bytes.
            let mut b = bytes[..128].to_vec();
            b.extend_from_slice(&[b'x'; 33]);
            b[124..128].copy_from_slice(&33u32.to_le_bytes());
            b
        },
    ] {
        assert!(decode_command(&broken).is_err());
    }
}

#[test]
fn a_page_lists_reactions_and_drops_those_of_deleted_messages() {
    let thumbs = "\u{1F44D}";
    let heart = "\u{2764}\u{FE0F}";
    let records = vec![
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_2, 0x21, 2, 1),
        posted(3, MEMBER_2, 0x21, 3, 1),
        reacted(4, MEMBER_2, 0x21, 1, thumbs, true),
        reacted(5, MEMBER_1, 0x11, 1, thumbs, true),
        reacted(6, MEMBER_1, 0x11, 1, heart, true),
        reacted(7, MEMBER_1, 0x11, 2, thumbs, true),
        reacted(8, MEMBER_1, 0x11, 3, thumbs, true),
        deleted(9, MEMBER_2, 0x21, 2, false),
        deleted(10, ADMIN, 0x31, 3, true),
    ];
    let mut history = history_of(&records);
    let mut texts = ChatTexts::new();
    let context = kine(&[], 0, TEST_DATE, None);
    let page = chat_page(
        &kchq(u32::MAX, 10, 0b100, &[ADMIN], &context),
        &mut history,
        &mut texts,
    )
    .unwrap();
    assert_eq!(&page[..4], b"KCHP");
    // Header: total 3, start 0, 3 records, no texts, no retired blobs.
    assert_eq!(
        [
            u32_at(&page, 8),
            u32_at(&page, 12),
            u32_at(&page, 16),
            u32_at(&page, 20),
            u32_at(&page, 24)
        ],
        [3, 0, 3, 0, 0]
    );
    // Group counts in each record: two groups, none (deleted), none (removed).
    let counts: Vec<u32> = (0..3)
        .map(|index| u32_at(&page, 28 + index * 128 + 112))
        .collect();
    assert_eq!(counts, [2, 0, 0]);
    for index in 0..3 {
        assert_eq!(
            page[28 + index * 128 + 116..28 + index * 128 + 128],
            [0; 12]
        );
    }
    // After 3 records and 3 keys: the reactions, by hand.
    let mut expected = Vec::new();
    for (emoji, actors) in [(thumbs, vec![MEMBER_2, MEMBER_1]), (heart, vec![MEMBER_1])] {
        expected.push(emoji.len() as u8);
        expected.extend_from_slice(emoji.as_bytes());
        expected.extend_from_slice(&(actors.len() as u32).to_le_bytes());
        for actor in actors {
            expected.extend_from_slice(&actor);
        }
    }
    assert_eq!(&page[28 + 3 * 128 + 3 * 32..], expected.as_slice());
    // Not asked for, not sent.
    let plain = chat_page(
        &kchq(u32::MAX, 10, 0, &[ADMIN], &context),
        &mut history,
        &mut texts,
    )
    .unwrap();
    assert_eq!(plain.len(), 28 + 3 * 128 + 3 * 32);
    assert_eq!(u32_at(&plain, 28 + 112), 0);
    // Without the admin named, the removed message is live again and shows its reaction.
    let unnamed = chat_page(
        &kchq(u32::MAX, 10, 0b100, &[], &context),
        &mut history,
        &mut texts,
    )
    .unwrap();
    assert_eq!(u32_at(&unnamed, 28 + 2 * 128 + 112), 1);
}

#[test]
fn replay_ignores_a_new_emoji_past_the_cap() {
    let mut records = vec![posted(1, MEMBER_1, 0x11, 1, 1)];
    for index in 0..=MAX_REACTION_GROUPS as u32 {
        let emoji = char::from_u32(0x1F600 + index).unwrap().to_string();
        records.push(reacted(2 + index, MEMBER_2, 0x21, 1, &emoji, true));
    }
    let state = chat(&records);
    assert_eq!(reactions_on(&state, 1).len(), MAX_REACTION_GROUPS);
    // Taking one back makes room for the next to apply.
    let first = char::from_u32(0x1F600).unwrap().to_string();
    let extra = char::from_u32(0x1F600 + MAX_REACTION_GROUPS as u32)
        .unwrap()
        .to_string();
    let n = records.len() as u32;
    records.push(reacted(n + 2, MEMBER_2, 0x21, 1, &first, false));
    records.push(reacted(n + 3, MEMBER_2, 0x21, 1, &extra, true));
    let state = chat(&records);
    let groups = reactions_on(&state, 1);
    assert_eq!(groups.len(), MAX_REACTION_GROUPS);
    assert!(groups.iter().all(|(emoji, _)| *emoji != first));
    assert_eq!(groups.last().unwrap().0, extra);
}

// Replies (#129).

/// A post of message `id` (text, blob version 0) that answers `original`.
fn replied(event: u32, actor: [u8; 16], device: u8, id: u8, original: [u8; 16]) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&[1, 0, 0, 0]);
    payload.extend_from_slice(&blob(id, 0));
    payload.extend_from_slice(&key(id, 0));
    payload.extend_from_slice(&original);
    record(44, event, actor, device, &payload)
}

#[test]
fn reply_records_decode_as_documented() {
    let event = decode_event(&replied(2, MEMBER_2, 0x21, 2, message(1))).unwrap();
    assert_eq!(
        event.kind,
        EventKind::ChatMessagePosted {
            mentions: Default::default(),
            message_id: ChatMessageId(message(2)),
            content_kind: ChatContentKind::Text,
            blob_ref: blob(2, 0),
            blob_key: key(2, 0),
            reply_to: Some(ChatMessageId(message(1))),
        }
    );
    assert_eq!(event.canonical_bytes.len(), 88 + 100);
    // The encoder writes the same bytes, and a post without a reply keeps
    // its 84-byte payload.
    assert_eq!(
        crate::codec::encode_event(&event).unwrap(),
        replied(2, MEMBER_2, 0x21, 2, message(1))
    );
    assert_eq!(
        decode_event(&posted(1, MEMBER_1, 0x11, 1, 1))
            .unwrap()
            .canonical_bytes
            .len(),
        88 + 84
    );
    // Zero, itself, and a payload of the wrong length are malformed.
    let payload_of = |reply: [u8; 16]| replied(2, MEMBER_2, 0x21, 2, reply);
    let mut short = payload_of(message(1));
    short.truncate(short.len() - 8);
    let new_length = (short.len() - 88) as u32;
    short[84..88].copy_from_slice(&new_length.to_le_bytes());
    for bytes in [payload_of([0; 16]), payload_of(message(2)), short] {
        assert!(decode_event(&bytes).is_err());
    }
}

#[test]
fn replay_stores_the_reply_and_a_page_quotes_the_original_live() {
    let records = vec![
        posted(1, MEMBER_1, 0x11, 1, 1),
        edited(2, MEMBER_1, 0x11, 1, 1),
        replied(3, MEMBER_2, 0x21, 2, message(1)),
        // The original is deleted, and one answers a message this log lacks.
        posted(4, MEMBER_1, 0x11, 3, 1),
        replied(5, MEMBER_2, 0x21, 4, message(3)),
        deleted(6, MEMBER_1, 0x11, 3, false),
        replied(7, MEMBER_2, 0x21, 5, message(9)),
    ];
    let state = chat(&records);
    assert_eq!(
        state.get(&ChatMessageId(message(2))).unwrap().reply_to,
        Some(ChatMessageId(message(1)))
    );
    let mut history = history_of(&records);
    let mut texts = ChatTexts::new();
    put_texts(&kcht(&[(blob(1, 1), b"Edited original")]), &mut texts).unwrap();
    let context = kine(&[], 0, TEST_DATE, None);
    let page = chat_page(
        &kchq(u32::MAX, 10, 0b01, &[], &context),
        &mut history,
        &mut texts,
    )
    .unwrap();
    let count = u32_at(&page, 16) as usize;
    assert_eq!(count, 5);
    // Flags at byte 70: replies 2 (message 2), 4 (message 4) show a quote;
    // the deleted original's own record has none, and message 5's original
    // is unknown but the reply still quotes.
    let flags: Vec<u8> = (0..count)
        .map(|index| page[28 + index * 128 + 70])
        .collect();
    assert_eq!(flags, [0, 1, 0, 1, 1]);
    let texts_len = u32_at(&page, 20) as usize;
    let mut at = 28 + count * 160 + texts_len;
    let quote = |at: usize| {
        (
            page[at + 16],
            page[at + 17],
            u32_at(&page, at + 100),
            u32_at(&page, at + 104) as usize,
        )
    };
    // Message 2 quotes message 1, edited, with its text.
    assert_eq!(&page[at..at + 16], &message(1));
    let (state_byte, kind, index, length) = quote(at);
    assert_eq!((state_byte, kind, index, length), (2, 1, 0, 15));
    assert_eq!(&page[at + 20..at + 36], &MEMBER_1);
    assert_eq!(&page[at + 36..at + 68], &blob(1, 1));
    assert_eq!(&page[at + 68..at + 100], &key(1, 1));
    assert_eq!(&page[at + 108..at + 108 + length], b"Edited original");
    at += 108 + length;
    // Message 4 quotes message 3, deleted: no blob, no text.
    assert_eq!(&page[at..at + 16], &message(3));
    assert_eq!(quote(at), (3, 1, 2, 0));
    assert_eq!(&page[at + 36..at + 100], &[0; 64]);
    at += 108;
    // Message 5 quotes a message this log lacks.
    assert_eq!(&page[at..at + 16], &message(9));
    assert_eq!(quote(at), (0, 0, u32::MAX, 0));
    assert_eq!(&page[at + 20..at + 100], &[0; 80]);
    at += 108;
    assert_eq!(at, page.len());
    // Texts not asked for: the quote has none.
    let bare = chat_page(
        &kchq(u32::MAX, 10, 0, &[], &context),
        &mut history,
        &mut texts,
    )
    .unwrap();
    let from = 28 + count * 160;
    assert_eq!(u32_at(&bare, from + 104), 0);
    // A removed original, once its remover is a named admin.
    let removed = vec![
        posted(1, MEMBER_1, 0x11, 1, 1),
        replied(2, MEMBER_2, 0x21, 2, message(1)),
        deleted(3, ADMIN, 0x31, 1, true),
    ];
    let mut history = history_of(&removed);
    let page = chat_page(
        &kchq(u32::MAX, 10, 0, &[ADMIN], &context),
        &mut history,
        &mut texts,
    )
    .unwrap();
    assert_eq!(page[28 + 128 + 70], 1);
    assert_eq!(page[28 + 2 * 160 + 16], 4);
}

#[test]
fn a_command_replies_only_to_a_message_that_still_shows() {
    let mut events = History::chat();
    run(
        &mut events,
        post(1, ChatContentKind::Text),
        context(1, MEMBER_1, 0x11, 1),
    )
    .unwrap();
    run(
        &mut events,
        post(2, ChatContentKind::Text),
        context(2, MEMBER_1, 0x11, 2),
    )
    .unwrap();
    let reply = |id: u8, original: u8| C::PostChatMessage {
        mentions: Default::default(),
        id: ChatMessageId(message(id)),
        content_kind: ChatContentKind::Text,
        blob_ref: blob(id, 0),
        blob_key: key(id, 0),
        reply_to: Some(ChatMessageId(message(original))),
    };
    run(&mut events, reply(3, 1), context(3, MEMBER_2, 0x21, 3)).unwrap();
    run(&mut events, delete(2, false), context(4, MEMBER_1, 0x11, 4)).unwrap();
    assert!(
        run(&mut events, reply(4, 2), context(5, MEMBER_2, 0x21, 5)).is_err(),
        "deleted"
    );
    assert!(
        run(&mut events, reply(4, 9), context(5, MEMBER_2, 0x21, 5)).is_err(),
        "unknown"
    );
    assert!(
        run(&mut events, reply(4, 4), context(5, MEMBER_2, 0x21, 5)).is_err(),
        "itself"
    );
    // A reply to a reply is fine: no threads, only a quote.
    run(&mut events, reply(4, 3), context(5, MEMBER_1, 0x11, 5)).unwrap();
}

#[test]
fn the_wire_command_posts_a_reply() {
    let mut payload = blob(1, 0).to_vec();
    payload.extend_from_slice(&key(1, 0));
    payload.extend_from_slice(&message(7));
    let (command, _) = decode_command(&kcmd(44, message(1), 1, &payload)).unwrap();
    assert_eq!(
        command,
        C::PostChatMessage {
            mentions: Default::default(),
            id: ChatMessageId(message(1)),
            content_kind: ChatContentKind::Text,
            blob_ref: blob(1, 0),
            blob_key: key(1, 0),
            reply_to: Some(ChatMessageId(message(7))),
        }
    );
    for bad in [
        [&payload[..64], &[0u8; 16][..]].concat(),
        payload[..72].to_vec(),
        [payload.as_slice(), &[0]].concat(),
    ] {
        assert_eq!(
            decode_command(&kcmd(44, message(1), 1, &bad)).unwrap_err(),
            KinError::MalformedProtocol
        );
    }
    // Edits take no reply.
    assert!(decode_command(&kcmd(45, message(1), 0, &payload)).is_err());
}

#[test]
fn a_quote_carries_only_the_first_line_of_a_long_original() {
    let records = vec![
        posted(1, MEMBER_1, 0x11, 1, 1),
        replied(2, MEMBER_2, 0x21, 2, message(1)),
    ];
    let mut history = history_of(&records);
    let mut texts = ChatTexts::new();
    let long = format!("\n  \nFirst line {}\nSecond line", "\u{1F600}".repeat(100));
    put_texts(&kcht(&[(blob(1, 0), long.as_bytes())]), &mut texts).unwrap();
    let context = kine(&[], 0, TEST_DATE, None);
    let page = chat_page(
        &kchq(u32::MAX, 10, 0b01, &[], &context),
        &mut history,
        &mut texts,
    )
    .unwrap();
    let texts_len = u32_at(&page, 20) as usize;
    let at = 28 + 2 * 160 + texts_len;
    let length = u32_at(&page, at + 104) as usize;
    let quoted = std::str::from_utf8(&page[at + 108..at + 108 + length]).unwrap();
    assert!(length <= MAX_QUOTE_BYTES);
    assert!(quoted.starts_with("First line \u{1F600}"));
    assert!(!quoted.contains("Second"));
}

// ---- search (#124) ----------------------------------------------------

#[derive(Default)]
struct Find<'a> {
    query: &'a str,
    limit: u32,
    flags: u32,
    from: i64,
    to: i64,
    authors: Vec<[u8; 16]>,
    excluded: Vec<[u8; 16]>,
    mentioning: Option<[u8; 16]>,
}

fn kchf(find: &Find<'_>, context: &[u8]) -> Vec<u8> {
    let mut bytes = b"KCHF\x01\0\0\0".to_vec();
    bytes.extend_from_slice(&find.limit.max(1).to_le_bytes());
    let flags = find.flags | if find.mentioning.is_some() { 2 } else { 0 };
    bytes.extend_from_slice(&flags.to_le_bytes());
    bytes.extend_from_slice(&find.from.to_le_bytes());
    bytes.extend_from_slice(&find.to.to_le_bytes());
    bytes.extend_from_slice(&(find.query.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&(find.authors.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(find.excluded.len() as u32).to_le_bytes());
    bytes.extend_from_slice(find.query.as_bytes());
    for id in find.authors.iter().chain(&find.excluded) {
        bytes.extend_from_slice(id);
    }
    if let Some(member) = find.mentioning {
        bytes.extend_from_slice(&member);
    }
    bytes.extend_from_slice(context);
    bytes
}

/// A decoded KCHR: total, results (id, index, ranges), unsearched total and
/// the listed (id, ref, key).
type Found = (
    u32,
    Vec<([u8; 16], u32, Vec<(u32, u32)>)>,
    u32,
    Vec<[u8; 16]>,
);

fn found(bytes: &[u8]) -> Found {
    assert_eq!(&bytes[..4], b"KCHR");
    let count = u32_at(bytes, 12) as usize;
    let listed = u32_at(bytes, 20) as usize;
    let mut at = 24;
    let mut results = Vec::new();
    for _ in 0..count {
        let id: [u8; 16] = bytes[at..at + 16].try_into().unwrap();
        let index = u32_at(bytes, at + 16);
        let ranges = u32_at(bytes, at + 20) as usize;
        let excerpt = u32_at(bytes, at + 56) as usize;
        let ranges = (0..ranges)
            .map(|n| {
                (
                    u32_at(bytes, at + 60 + n * 8),
                    u32_at(bytes, at + 64 + n * 8),
                )
            })
            .collect::<Vec<_>>();
        at += 60 + ranges.len() * 8 + excerpt;
        results.push((id, index, ranges));
    }
    let unsearched = (0..listed)
        .map(|n| bytes[at + n * 80..at + n * 80 + 16].try_into().unwrap())
        .collect();
    assert_eq!(bytes.len(), at + listed * 80);
    (u32_at(bytes, 8), results, u32_at(bytes, 16), unsearched)
}

/// Messages `1..` by MEMBER_1, with `texts[n]` as the text of message n+1.
fn talk(texts: &[&str]) -> (History, ChatTexts) {
    let records = (0..texts.len())
        .map(|n| posted((n + 1) as u32, MEMBER_1, 0x11, (n + 1) as u8, 1))
        .collect::<Vec<_>>();
    let history = history_of(&records);
    let mut arena = ChatTexts::new();
    for (n, text) in texts.iter().enumerate() {
        put_texts(
            &kcht(&[(blob((n + 1) as u8, 0), text.as_bytes())]),
            &mut arena,
        )
        .unwrap();
    }
    (history, arena)
}

fn search(history: &mut History, texts: &mut ChatTexts, find: &Find<'_>) -> Found {
    let context = kine(&[], 0, TEST_DATE, None);
    found(&crate::core::chat_search(&kchf(find, &context), history, texts).unwrap())
}

fn ids_of(found: &Found) -> Vec<u8> {
    found.1.iter().map(|(id, _, _)| id[0]).collect()
}

#[test]
fn search_folds_case_and_accents_and_reports_byte_ranges() {
    let (mut history, mut texts) = talk(&[
        "Café Résumé",
        "STRASSE or Straße",
        "Łódź at Zürich",
        "cafe\u{301} decomposed",
        "nothing here",
    ]);
    let query = |query| Find {
        query,
        limit: 10,
        ..Find::default()
    };
    let result = search(&mut history, &mut texts, &query("cafe"));
    assert_eq!(ids_of(&result), [4, 1]);
    // "Café" is bytes 0..5 (é is two); the decomposed one runs to 6 (e + mark).
    assert_eq!(result.1[1].2, [(0, 5)]);
    assert_eq!(result.1[0].2, [(0, 6)]);
    assert_eq!(
        ids_of(&search(&mut history, &mut texts, &query("RESUME"))),
        [1]
    );
    let strasse = search(&mut history, &mut texts, &query("strasse"));
    assert_eq!(ids_of(&strasse), [2]);
    assert_eq!(strasse.1[0].2, [(0, 7), (11, 18)]);
    assert_eq!(
        ids_of(&search(&mut history, &mut texts, &query("lodz"))),
        [3]
    );
    assert_eq!(
        ids_of(&search(&mut history, &mut texts, &query("zurich"))),
        [3]
    );
    // The accent in the query folds too.
    assert_eq!(
        ids_of(&search(&mut history, &mut texts, &query("CAFÉ"))),
        [4, 1]
    );
    assert_eq!(search(&mut history, &mut texts, &query("zzz")).0, 0);
}

#[test]
fn search_never_cuts_an_emoji_sequence() {
    let (mut history, mut texts) = talk(&[
        "great \u{1F44D} job",
        "tone \u{1F44D}\u{1F3FD} here",
        "family \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} out",
        "heart \u{2764}\u{FE0F} done",
        "flag \u{1F1FA}\u{1F1F8}",
    ]);
    let query = |query| Find {
        query,
        limit: 10,
        ..Find::default()
    };
    // A thumbs-up is found alone, and with its tone only when asked for.
    assert_eq!(
        ids_of(&search(&mut history, &mut texts, &query("\u{1F44D}"))),
        [1]
    );
    assert_eq!(
        ids_of(&search(
            &mut history,
            &mut texts,
            &query("\u{1F44D}\u{1F3FD}")
        )),
        [2]
    );
    // One person of a family is not the family.
    assert_eq!(
        ids_of(&search(&mut history, &mut texts, &query("\u{1F469}"))),
        Vec::<u8>::new()
    );
    assert_eq!(
        ids_of(&search(&mut history, &mut texts, &query("\u{1F468}"))),
        Vec::<u8>::new()
    );
    assert_eq!(
        ids_of(&search(
            &mut history,
            &mut texts,
            &query("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}")
        )),
        [3]
    );
    // With or without the emoji selector, and the range includes it.
    let heart = search(&mut history, &mut texts, &query("\u{2764}"));
    assert_eq!(ids_of(&heart), [4]);
    assert_eq!(heart.1[0].2, [(6, 12)]);
    assert_eq!(
        ids_of(&search(
            &mut history,
            &mut texts,
            &query("\u{2764}\u{FE0F}")
        )),
        [4]
    );
    assert_eq!(
        ids_of(&search(
            &mut history,
            &mut texts,
            &query("\u{1F1FA}\u{1F1F8}")
        )),
        [5]
    );
}

#[test]
fn search_skips_deleted_hidden_and_removed_messages() {
    let mut records = vec![
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_1, 0x11, 2, 1),
        posted(3, MEMBER_2, 0x21, 3, 1),
        posted(4, MEMBER_2, 0x21, 4, 1),
        deleted(5, MEMBER_1, 0x11, 1, false),
        deleted(6, MEMBER_1, 0x11, 4, true),
    ];
    let mut history = history_of(&records);
    let mut texts = ChatTexts::new();
    for n in 1..=4u8 {
        put_texts(&kcht(&[(blob(n, 0), b"the code is 1234")]), &mut texts).unwrap();
    }
    let find = Find {
        query: "code",
        limit: 10,
        ..Find::default()
    };
    // Deleted by its author (1) and removed by a named admin (4, if named).
    let result = search(&mut history, &mut texts, &find);
    assert_eq!(ids_of(&result), [4, 3, 2]);
    assert!(
        texts.get(&blob(1, 0)).is_none(),
        "a deleted text is forgotten"
    );
    // Hidden for me.
    let hidden = Find {
        excluded: vec![message(3)],
        ..Find {
            query: "code",
            limit: 10,
            ..Find::default()
        }
    };
    assert_eq!(ids_of(&search(&mut history, &mut texts, &hidden)), [4, 2]);
    records.clear();
}

#[test]
fn search_filters_by_person_date_and_attachments_and_limits() {
    let records = vec![
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_2, 0x21, 2, 1),
        posted(3, MEMBER_1, 0x11, 3, 2),
        posted(4, MEMBER_2, 0x21, 4, 1),
    ];
    let mut history = history_of(&records);
    let mut texts = ChatTexts::new();
    for n in [1u8, 2, 4] {
        put_texts(&kcht(&[(blob(n, 0), b"plan the trip")]), &mut texts).unwrap();
    }
    let run = |history: &mut History, texts: &mut ChatTexts, find: Find<'_>| {
        search(history, texts, &find)
    };
    let all = Find {
        query: "trip",
        limit: 10,
        ..Find::default()
    };
    assert_eq!(
        ids_of(&run(&mut history, &mut texts, Find { ..all_of(&all) })),
        [4, 2, 1]
    );
    let by = Find {
        authors: vec![MEMBER_2],
        ..all_of(&all)
    };
    assert_eq!(ids_of(&run(&mut history, &mut texts, by)), [4, 2]);
    // Posted at BASE_TIME + event: from 2 up to (not including) 4.
    let dated = Find {
        from: BASE_TIME + 2,
        to: BASE_TIME + 4,
        ..all_of(&all)
    };
    assert_eq!(ids_of(&run(&mut history, &mut texts, dated)), [2]);
    // Attachments only, with no query: message 3 is the attachment.
    let files = Find {
        flags: 1,
        ..Find {
            limit: 10,
            ..Find::default()
        }
    };
    assert_eq!(ids_of(&run(&mut history, &mut texts, files)), [3]);
    // Limit keeps the newest and still counts the rest.
    let limited = Find {
        limit: 2,
        ..all_of(&all)
    };
    let result = run(&mut history, &mut texts, limited);
    assert_eq!((result.0, ids_of(&result)), (3, vec![4, 2]));
    // No query lists everything shown that passes the filters.
    let everything = Find {
        limit: 10,
        ..Find::default()
    };
    assert_eq!(run(&mut history, &mut texts, everything).0, 4);
}

fn all_of<'a>(find: &Find<'a>) -> Find<'a> {
    Find {
        query: find.query,
        limit: find.limit,
        flags: find.flags,
        from: find.from,
        to: find.to,
        authors: find.authors.clone(),
        excluded: find.excluded.clone(),
        mentioning: find.mentioning,
    }
}

#[test]
fn search_lists_texts_it_could_not_look_at() {
    let (mut history, _) = talk(&["one", "two", "three"]);
    let mut texts = ChatTexts::new();
    put_texts(&kcht(&[(blob(2, 0), b"two trip")]), &mut texts).unwrap();
    let find = Find {
        query: "trip",
        limit: 10,
        ..Find::default()
    };
    let result = search(&mut history, &mut texts, &find);
    assert_eq!(ids_of(&result), [2]);
    // Messages 3 and 1 have no text yet: newest first.
    assert_eq!((result.2, result.3), (2, vec![message(3), message(1)]));
}

#[test]
fn search_requests_are_checked() {
    let context = kine(&[], 0, TEST_DATE, None);
    let good = Find {
        query: "a",
        limit: 5,
        ..Find::default()
    };
    let valid = kchf(&good, &context);
    let (mut history, mut texts) = talk(&["a"]);
    let mut run = |bytes: &[u8]| crate::core::chat_search(bytes, &mut history, &mut texts);
    assert!(run(&valid).is_ok());
    let mut bad_magic = valid.clone();
    bad_magic[0] = b'X';
    assert_eq!(run(&bad_magic), Err(KinError::MalformedProtocol));
    let mut version = valid.clone();
    version[4] = 2;
    assert_eq!(run(&version), Err(KinError::UnsupportedVersion));
    let mut flags = valid.clone();
    flags[12] = 2;
    assert_eq!(run(&flags), Err(KinError::MalformedProtocol));
    let mut zero_limit = valid.clone();
    zero_limit[8..12].copy_from_slice(&0u32.to_le_bytes());
    assert_eq!(run(&zero_limit), Err(KinError::MalformedProtocol));
    let mut huge_limit = valid.clone();
    huge_limit[8..12].copy_from_slice(&201u32.to_le_bytes());
    assert_eq!(run(&huge_limit), Err(KinError::MalformedProtocol));
    let backwards = Find {
        from: 9,
        to: 5,
        ..Find {
            query: "a",
            limit: 5,
            ..Find::default()
        }
    };
    assert_eq!(
        run(&kchf(&backwards, &context)),
        Err(KinError::MalformedProtocol)
    );
    let long = "a".repeat(257);
    let too_long = Find {
        query: &long,
        limit: 5,
        ..Find::default()
    };
    assert_eq!(
        run(&kchf(&too_long, &context)),
        Err(KinError::MalformedProtocol)
    );
    let zero_author = Find {
        authors: vec![[0; 16]],
        query: "a",
        limit: 5,
        ..Find::default()
    };
    assert_eq!(
        run(&kchf(&zero_author, &context)),
        Err(KinError::MalformedProtocol)
    );
    assert_eq!(run(&valid[..40]), Err(KinError::MalformedProtocol));
    // Not UTF-8.
    let mut bytes = valid.clone();
    bytes[48] = 0xff;
    assert_eq!(run(&bytes), Err(KinError::MalformedProtocol));
}

/// A hundred thousand messages already in memory search in well under 50 ms
/// (checked in release builds; a debug build is an order of magnitude slower).
#[test]
fn search_scans_a_hundred_thousand_messages_quickly() {
    const COUNT: u32 = 100_000;
    let mut state = ChatState::default();
    let mut texts = ChatTexts::new();
    let words = [
        "pick up the kids",
        "Café run at 5",
        "grocery list: milk",
        "remember the code 4821",
        "see you soon 👍",
    ];
    for n in 0..COUNT {
        let mut id = [0u8; 16];
        id[..4].copy_from_slice(&n.to_le_bytes());
        let mut blob_ref = [0u8; 32];
        blob_ref[..4].copy_from_slice(&(n + 1).to_le_bytes());
        let text = format!("{} {}", words[(n % 5) as usize], n);
        texts.put(blob_ref, text.as_bytes()).ok();
        state.positions.insert(ChatMessageId(id), n as usize);
        state.messages.push(ChatMessage {
            mentions: Default::default(),
            message_id: ChatMessageId(id),
            author: ActorId(MEMBER_1),
            device: DeviceId([0x11; 16]),
            posted_at: BASE_TIME + i64::from(n),
            edited_at: 0,
            status: ChatMessageStatus::Live,
            content_kind: ChatContentKind::Text,
            blob_ref,
            blob_key: [7; 32],
            reply_to: None,
        });
    }
    let context = kine(&[], 0, TEST_DATE, None);
    for (query, ascii) in [("grocery", true), ("cafe", false)] {
        let request = kchf(
            &Find {
                query,
                limit: 50,
                ..Find::default()
            },
            &context,
        );
        let request = crate::chat_search::decode_search_request(&request).unwrap();
        let started = std::time::Instant::now();
        let bytes = crate::chat_search::encode_search(&state, &request, &texts).unwrap();
        let elapsed = started.elapsed();
        let result = found(&bytes);
        // The arena is bounded, so only the texts it kept can match.
        assert!(result.0 > 0, "{query} ({ascii}) found nothing");
        #[cfg(not(debug_assertions))]
        assert!(elapsed.as_millis() < 50, "{query} took {elapsed:?}");
        eprintln!("search {query}: {elapsed:?}");
    }
}

#[test]
fn search_excerpts_hold_the_first_match_on_character_boundaries() {
    let long = format!("{}needle é{}", "é".repeat(200), "x".repeat(400));
    let (mut history, mut texts) = talk(&[&long, "short needle"]);
    let context = kine(&[], 0, TEST_DATE, None);
    let find = Find {
        query: "needle",
        limit: 10,
        ..Find::default()
    };
    let bytes = crate::core::chat_search(&kchf(&find, &context), &mut history, &mut texts).unwrap();
    let mut at = 24;
    let mut excerpts = Vec::new();
    for _ in 0..u32_at(&bytes, 12) {
        let ranges = u32_at(&bytes, at + 20) as usize;
        let (offset, length) = (
            u32_at(&bytes, at + 52) as usize,
            u32_at(&bytes, at + 56) as usize,
        );
        let first = (
            u32_at(&bytes, at + 60) as usize,
            u32_at(&bytes, at + 64) as usize,
        );
        let start = at + 60 + ranges * 8;
        let text = std::str::from_utf8(&bytes[start..start + length]).unwrap();
        // The first range is relative to the whole text; the match is inside.
        assert_eq!(&text[first.0 - offset..first.1 - offset], "needle");
        assert_eq!(u32_at(&bytes, at + 48), 1, "a text message");
        excerpts.push((offset, text.to_owned()));
        at = start + length;
    }
    assert_eq!(excerpts[0], (0, "short needle".to_owned()));
    assert!(excerpts[1].0 > 0 && excerpts[1].1.len() <= 160 + 4);
}

/// The whole `kin_chat_search` path (replay checkpoint, retired blobs, search)
/// over a hundred thousand real chat events stays under 50 ms once warm.
/// Release builds only: a debug build is an order of magnitude slower.
#[test]
#[cfg_attr(debug_assertions, ignore = "timing needs a release build")]
fn search_over_a_hundred_thousand_events_stays_under_fifty_milliseconds() {
    const COUNT: u32 = 100_000;
    let records: Vec<Vec<u8>> = (1..=COUNT)
        .map(|n| {
            let mut payload = [0u8; 16].to_vec();
            payload[..4].copy_from_slice(&n.to_le_bytes());
            payload.extend_from_slice(&[1, 0, 0, 0]);
            let mut blob_ref = [0u8; 32];
            blob_ref[..4].copy_from_slice(&n.to_le_bytes());
            payload.extend_from_slice(&blob_ref);
            payload.extend_from_slice(&[7u8; 32]);
            record(44, n, MEMBER_1, 0x11, &payload)
        })
        .collect();
    let mut history = history_of(&records);
    let mut texts = ChatTexts::new();
    for n in 1..=COUNT {
        let mut blob_ref = [0u8; 32];
        blob_ref[..4].copy_from_slice(&n.to_le_bytes());
        texts
            .put(blob_ref, format!("grocery list {n}").as_bytes())
            .ok();
    }
    let context = kine(&[], 0, TEST_DATE, None);
    let request = kchf(
        &Find {
            query: "grocery",
            limit: 50,
            ..Find::default()
        },
        &context,
    );
    // The first search replays the log; the ones after reuse the checkpoint.
    crate::core::chat_search(&request, &mut history, &mut texts).unwrap();
    let mut best = std::time::Duration::MAX;
    for _ in 0..5 {
        let started = std::time::Instant::now();
        let bytes = crate::core::chat_search(&request, &mut history, &mut texts).unwrap();
        best = best.min(started.elapsed());
        assert_eq!(found(&bytes).0, COUNT);
    }
    assert!(best.as_millis() < 50, "took {best:?}");
}

#[test]
fn search_folds_vietnamese_romanian_greek_and_dotted_capitals() {
    let (mut history, mut texts) =
        talk(&["Thương và Người, Việt", "școala, țară", "İstanbul", "ΟΔΟΣ"]);
    let query = |query| Find {
        query,
        limit: 10,
        ..Find::default()
    };
    for (word, expected) in [
        ("thuong", 1),
        ("nguoi", 1),
        ("viet", 1),
        ("scoala", 2),
        ("tara", 2),
        ("istanbul", 3),
        ("οδος", 4),
        ("οδοσ", 4),
    ] {
        assert_eq!(
            ids_of(&search(&mut history, &mut texts, &query(word))),
            [expected],
            "{word}"
        );
    }
}

#[test]
fn search_does_not_split_graphemes_at_either_end() {
    let (mut history, mut texts) = talk(&[
        "\u{1F1FA}\u{1F1F8}\u{1F1EB}\u{1F1F7}",
        "e\u{301}x and \u{1F468}\u{200D}\u{1F469}",
    ]);
    let query = |query| Find {
        query,
        limit: 10,
        ..Find::default()
    };
    // Flags pair up from the start: US|FR, never U|SF|R.
    assert_eq!(
        ids_of(&search(
            &mut history,
            &mut texts,
            &query("\u{1F1F8}\u{1F1EB}")
        )),
        Vec::<u8>::new()
    );
    assert_eq!(
        ids_of(&search(
            &mut history,
            &mut texts,
            &query("\u{1F1FA}\u{1F1F8}")
        )),
        [1]
    );
    assert_eq!(
        ids_of(&search(
            &mut history,
            &mut texts,
            &query("\u{1F1EB}\u{1F1F7}")
        )),
        [1]
    );
    // A combining mark stays with its letter (so "e" finds "é", whole); a
    // joiner with its pair.
    assert_eq!(ids_of(&search(&mut history, &mut texts, &query("e"))), [2]);
    assert_eq!(
        ids_of(&search(&mut history, &mut texts, &query("\u{1F469}"))),
        Vec::<u8>::new()
    );
    assert_eq!(
        ids_of(&search(&mut history, &mut texts, &query("\u{1F468}"))),
        Vec::<u8>::new()
    );
}

// ---- mentions (#130) --------------------------------------------------

fn mention(members: &[[u8; 16]], everyone: bool) -> crate::chat::ChatMentions {
    crate::chat::ChatMentions {
        everyone,
        members: members.iter().copied().map(ActorId).collect(),
    }
}

fn post_mentioning(id: u8, mentions: crate::chat::ChatMentions) -> C {
    C::PostChatMessage {
        mentions,
        id: ChatMessageId(message(id)),
        content_kind: ChatContentKind::Text,
        blob_ref: blob(id, 0),
        blob_key: key(id, 0),
        reply_to: None,
    }
}

fn reply_mentioning(id: u8, original: u8, mentions: crate::chat::ChatMentions) -> C {
    match post_mentioning(id, mentions) {
        C::PostChatMessage {
            mentions,
            id,
            content_kind,
            blob_ref,
            blob_key,
            ..
        } => C::PostChatMessage {
            mentions,
            id,
            content_kind,
            blob_ref,
            blob_key,
            reply_to: Some(ChatMessageId(message(original))),
        },
        other => other,
    }
}

/// `run` naming the members able to read chat.
fn run_members(
    log: &mut History,
    command: C,
    ctx: CommandContext,
    members: &[[u8; 16]],
) -> Result<(), KinError> {
    let held = HeldHistory::new(log, local_context())?
        .with_admins(vec![ActorId(ADMIN)])
        .with_members(members.iter().copied().map(ActorId).collect());
    let result = execute_with(&command, ctx, &mut { held })?;
    log.append(&batch(&[result.event.canonical_bytes])).unwrap();
    Ok(())
}

#[test]
fn the_wire_command_carries_mentions() {
    let mut base = blob(1, 0).to_vec();
    base.extend_from_slice(&key(1, 0));
    let tail = |flags: u8, ids: &[[u8; 16]], reply: Option<[u8; 16]>| {
        let mut bytes = base.clone();
        bytes.extend_from_slice(&[flags, ids.len() as u8]);
        for id in ids {
            bytes.extend_from_slice(id);
        }
        bytes.extend(reply.into_iter().flatten());
        bytes
    };
    let (command, _) = decode_command(&kcmd(
        44,
        message(1),
        1,
        &tail(0b01, &[MEMBER_1, MEMBER_2], None),
    ))
    .unwrap();
    assert_eq!(
        command,
        post_mentioning(1, mention(&[MEMBER_1, MEMBER_2], true))
    );
    // With a reply too.
    let (command, _) = decode_command(&kcmd(
        44,
        message(1),
        1,
        &tail(0b10, &[MEMBER_2], Some(message(7))),
    ))
    .unwrap();
    assert_eq!(command, reply_mentioning(1, 7, mention(&[MEMBER_2], false)));
    // An edit carries mentions, never a reply.
    let (command, _) = decode_command(&kcmd(45, message(1), 0, &tail(0b01, &[], None))).unwrap();
    assert!(
        matches!(command, C::EditChatMessage { mentions, .. } if mentions == mention(&[], true))
    );
    for bad in [
        tail(0b01, &[MEMBER_2, MEMBER_1], None),   // out of order
        tail(0b00, &[MEMBER_1, MEMBER_1], None),   // repeated
        tail(0b00, &[[0; 16]], None),              // zero ID
        tail(0b00, &[], None),                     // says nothing: not the one encoding
        tail(0b100, &[MEMBER_1], None),            // unknown flag
        tail(0b10, &[MEMBER_1], None),             // reply flagged, absent
        tail(0b00, &[MEMBER_1], Some(message(7))), // reply present, unflagged
        tail(0b10, &[MEMBER_1], Some([0; 16])),    // zero reply
        tail(0b00, &vec![[9u8; 16]; 21], None),    // too many
        [base.as_slice(), &[1]].concat(),          // one stray byte
    ] {
        assert_eq!(
            decode_command(&kcmd(44, message(1), 1, &bad)).unwrap_err(),
            KinError::MalformedProtocol,
            "{bad:?}"
        );
    }
    assert!(decode_command(&kcmd(
        45,
        message(1),
        0,
        &tail(0b10, &[MEMBER_1], Some(message(7)))
    ))
    .is_err());
}

#[test]
fn mentions_round_trip_through_the_event_and_keep_older_events_readable() {
    let ctx = || context(1, MEMBER_1, 0x11, 1);
    let mentions = mention(&[MEMBER_2, ADMIN], true);
    let event = crate::command::create_event(&post_mentioning(1, mentions.clone()), ctx()).unwrap();
    let decoded = decode_event(&event.canonical_bytes).unwrap();
    assert!(
        matches!(&decoded.kind, EventKind::ChatMessagePosted { mentions: found, reply_to: None, .. } if *found == mentions)
    );
    // A reply with mentions, and an edit.
    let both = reply_mentioning(1, 9, mention(&[MEMBER_2], false));
    let decoded = decode_event(
        &crate::command::create_event(&both, ctx())
            .unwrap()
            .canonical_bytes,
    )
    .unwrap();
    assert!(
        matches!(&decoded.kind, EventKind::ChatMessagePosted { mentions, reply_to: Some(_), .. } if mentions.members.len() == 1)
    );
    let edit = C::EditChatMessage {
        id: ChatMessageId(message(1)),
        blob_ref: blob(1, 1),
        blob_key: key(1, 1),
        mentions: mention(&[MEMBER_2], false),
    };
    let decoded = decode_event(
        &crate::command::create_event(&edit, ctx())
            .unwrap()
            .canonical_bytes,
    )
    .unwrap();
    assert!(
        matches!(&decoded.kind, EventKind::ChatMessageEdited { mentions, .. } if mentions.members == vec![ActorId(MEMBER_2)])
    );
    // No mentions: the earlier 84- and 100-byte posts and 80-byte edits.
    for command in [
        post(1, ChatContentKind::Text),
        reply_mentioning(1, 9, mention(&[], false)),
    ] {
        let bytes = crate::command::create_event(&command, ctx())
            .unwrap()
            .canonical_bytes;
        assert!(
            matches!(decode_event(&bytes).unwrap().kind, EventKind::ChatMessagePosted { mentions, .. } if mentions.is_empty())
        );
    }
    // Refused when built: unsorted or zero member IDs.
    for bad in [
        mention(&[MEMBER_2, MEMBER_1], false),
        mention(&[[0; 16]], false),
        mention(&[MEMBER_1, MEMBER_1], false),
    ] {
        assert!(crate::command::create_event(&post_mentioning(1, bad), ctx()).is_err());
    }
}

#[test]
fn only_members_who_can_read_chat_may_be_mentioned() {
    let mut log = History::chat();
    let members = [MEMBER_1, MEMBER_2];
    run_members(
        &mut log,
        post_mentioning(1, mention(&[MEMBER_2], false)),
        context(1, MEMBER_1, 0x11, 1),
        &members,
    )
    .unwrap();
    // Someone the host did not name (left, or shut out of chat) is refused.
    assert_eq!(
        run_members(
            &mut log,
            post_mentioning(2, mention(&[ADMIN], false)),
            context(2, MEMBER_1, 0x11, 2),
            &members
        ),
        Err(KinError::InvalidEvent)
    );
    // With no list at all, nobody can be named; @everyone still can.
    assert!(run(
        &mut log,
        post_mentioning(2, mention(&[MEMBER_2], false)),
        context(2, MEMBER_1, 0x11, 2)
    )
    .is_err());
    run(
        &mut log,
        post_mentioning(2, mention(&[], true)),
        context(2, MEMBER_1, 0x11, 2),
    )
    .unwrap();
    // An edit is checked the same way and replaces the list.
    let edit = |mentions| C::EditChatMessage {
        id: ChatMessageId(message(1)),
        blob_ref: blob(1, 1),
        blob_key: key(1, 1),
        mentions,
    };
    assert!(run_members(
        &mut log,
        edit(mention(&[ADMIN], false)),
        context(3, MEMBER_1, 0x11, 3),
        &members
    )
    .is_err());
    run_members(
        &mut log,
        edit(mention(&[MEMBER_1], false)),
        context(3, MEMBER_1, 0x11, 3),
        &members,
    )
    .unwrap();
    let state = log.replay(&local_context()).unwrap().chat().clone();
    assert_eq!(
        state.get(&ChatMessageId(message(1))).unwrap().mentions,
        mention(&[MEMBER_1], false)
    );
    assert_eq!(
        state.get(&ChatMessageId(message(2))).unwrap().mentions,
        mention(&[], true)
    );
}

#[test]
fn a_page_lists_mentions_of_messages_that_show() {
    let mut log = History::chat();
    let members = [MEMBER_1, MEMBER_2, ADMIN];
    run_members(
        &mut log,
        post_mentioning(1, mention(&[MEMBER_2, ADMIN], false)),
        context(1, MEMBER_1, 0x11, 1),
        &members,
    )
    .unwrap();
    run_members(
        &mut log,
        post_mentioning(2, mention(&[], true)),
        context(2, MEMBER_1, 0x11, 2),
        &members,
    )
    .unwrap();
    run_members(
        &mut log,
        post(3, ChatContentKind::Text),
        context(3, MEMBER_1, 0x11, 3),
        &members,
    )
    .unwrap();
    run_members(
        &mut log,
        post_mentioning(4, mention(&[MEMBER_1], true)),
        context(4, MEMBER_2, 0x21, 4),
        &members,
    )
    .unwrap();
    let mut texts = ChatTexts::new();
    let kctx = kine(&[], 0, TEST_DATE, None);
    let page = chat_page(&kchq(u32::MAX, 10, 0, &[], &kctx), &mut log, &mut texts).unwrap();
    let record = |n: usize| 28 + n * 128;
    assert_eq!(page[record(0) + 71], 0b10, "names members");
    assert_eq!(
        u16::from_le_bytes([page[record(0) + 116], page[record(0) + 117]]),
        2
    );
    assert_eq!(page[record(1) + 71], 0b01, "everyone");
    assert_eq!(page[record(2) + 71], 0, "none");
    assert_eq!(page[record(3) + 71], 0b11, "both");
    // The named IDs close the page, in record order, ascending.
    let tail = &page[page.len() - 3 * 16..];
    // Record 0 names ADMIN and MEMBER_2 (stored ascending: 2, then 3), record 3 MEMBER_1.
    assert_eq!(
        tail,
        [MEMBER_2.as_slice(), ADMIN.as_slice(), MEMBER_1.as_slice()]
            .concat()
            .as_slice()
    );
    // A deleted message shows none.
    run_members(
        &mut log,
        delete(1, false),
        context(5, MEMBER_1, 0x11, 5),
        &members,
    )
    .unwrap();
    let page = chat_page(&kchq(u32::MAX, 10, 0, &[], &kctx), &mut log, &mut texts).unwrap();
    assert_eq!(page[record(0) + 71], 0);
    assert_eq!(
        u16::from_le_bytes([page[record(0) + 116], page[record(0) + 117]]),
        0
    );
    assert_eq!(
        page.len(),
        28 + 4 * 160 + 16,
        "only message 4 still names a member"
    );
}

#[test]
fn search_can_list_only_messages_that_mention_a_member() {
    let mut log = History::chat();
    let members = [MEMBER_1, MEMBER_2];
    run_members(
        &mut log,
        post_mentioning(1, mention(&[MEMBER_2], false)),
        context(1, MEMBER_1, 0x11, 1),
        &members,
    )
    .unwrap();
    run_members(
        &mut log,
        post_mentioning(2, mention(&[], true)),
        context(2, MEMBER_1, 0x11, 2),
        &members,
    )
    .unwrap();
    run_members(
        &mut log,
        post_mentioning(3, mention(&[MEMBER_1], false)),
        context(3, MEMBER_2, 0x21, 3),
        &members,
    )
    .unwrap();
    run_members(
        &mut log,
        post(4, ChatContentKind::Text),
        context(4, MEMBER_1, 0x11, 4),
        &members,
    )
    .unwrap();
    let mut texts = ChatTexts::new();
    let kctx = kine(&[], 0, TEST_DATE, None);
    let mut list = |mentioning: Option<[u8; 16]>| {
        let find = Find {
            limit: 10,
            mentioning,
            ..Find::default()
        };
        let (total, results, ..) =
            found(&crate::core::chat_search(&kchf(&find, &kctx), &mut log, &mut texts).unwrap());
        (
            total,
            results.into_iter().map(|(id, ..)| id).collect::<Vec<_>>(),
        )
    };
    assert_eq!(list(None).0, 4);
    // Newest first; @everyone counts for everyone.
    assert_eq!(list(Some(MEMBER_2)).1, vec![message(2), message(1)]);
    assert_eq!(list(Some(MEMBER_1)).1, vec![message(3), message(2)]);
    assert_eq!(list(Some(ADMIN)).1, vec![message(2)]);
    // The member must be named, non-zero.
    let find = Find {
        limit: 10,
        mentioning: Some([0; 16]),
        ..Find::default()
    };
    assert!(crate::core::chat_search(&kchf(&find, &kctx), &mut log, &mut texts).is_err());
}

#[test]
fn malformed_mention_tails_are_refused() {
    let id = |byte: u8| [byte; 16];
    let tail = |flags: u8, count: u8, ids: &[[u8; 16]]| {
        let mut out = vec![flags, count];
        for one in ids {
            out.extend_from_slice(one);
        }
        out
    };
    // Unknown flag bits, nothing mentioned, a reply flag where none is allowed.
    assert!(ChatMentions::decode_tail(&tail(4, 0, &[]), true).is_err());
    assert!(ChatMentions::decode_tail(&tail(2, 0, &[]), true).is_err());
    assert!(ChatMentions::decode_tail(&tail(1, 0, &[id(1)]), false).is_err());
    assert!(ChatMentions::decode_tail(&tail(3, 0, &[id(1)]), false).is_err());
    // Too many, unsorted, duplicate, zero, and truncated or trailing bytes.
    let many: Vec<[u8; 16]> = (1..=21).map(id).collect();
    assert!(ChatMentions::decode_tail(&tail(0, 21, &many), false).is_err());
    assert!(ChatMentions::decode_tail(&tail(0, 2, &[id(2), id(1)]), false).is_err());
    assert!(ChatMentions::decode_tail(&tail(0, 2, &[id(1), id(1)]), false).is_err());
    assert!(ChatMentions::decode_tail(&tail(0, 1, &[id(0)]), false).is_err());
    let mut short = tail(0, 1, &[id(1)]);
    short.pop();
    assert!(ChatMentions::decode_tail(&short, false).is_err());
    let mut long = tail(0, 1, &[id(1)]);
    long.push(0);
    assert!(ChatMentions::decode_tail(&long, false).is_err());
    assert!(ChatMentions::decode_tail(&tail(0, 1, &[id(1)]), false).is_ok());
}

fn pin_record(event: u32, actor: [u8; 16], device: u8, id: u8, on: bool) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&[u8::from(on), 0, 0, 0]);
    record(48, event, actor, device, &payload)
}

fn pin(id: u8, on: bool) -> C {
    C::PinChatMessage {
        id: ChatMessageId(message(id)),
        on,
    }
}

fn pinned_ids(state: &ChatState) -> Vec<([u8; 16], [u8; 16])> {
    state
        .pins
        .iter()
        .map(|pin| (pin.message_id.0, pin.by.0))
        .collect()
}

#[test]
fn pin_records_decode_as_documented_and_malformed_ones_are_refused() {
    let good = pin_record(2, MEMBER_2, 0x21, 1, true);
    let event = decode_event(&good).unwrap();
    assert_eq!(
        event.kind,
        EventKind::ChatPinSet {
            message_id: ChatMessageId(message(1)),
            on: true
        }
    );
    assert!(event.kind.is_chat());
    // Encoding it again gives the same bytes.
    assert_eq!(crate::codec::encode_event(&event).unwrap(), good);
    let payload = |edit: &dyn Fn(&mut Vec<u8>)| {
        let mut bytes = message(1).to_vec();
        bytes.extend_from_slice(&[1, 0, 0, 0]);
        edit(&mut bytes);
        record(48, 2, MEMBER_2, 0x21, &bytes)
    };
    for broken in [
        payload(&|b| b.push(0)),
        payload(&|b| {
            b.pop();
        }),
        payload(&|b| b[16] = 2),
        payload(&|b| b[17] = 1),
        payload(&|b| b[..16].fill(0)),
    ] {
        assert!(decode_event(&broken).is_err());
    }
}

#[test]
fn replay_pins_in_order_keeps_the_first_pinner_and_drops_deleted_messages() {
    let state = chat(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_1, 0x11, 2, 1),
        pin_record(3, MEMBER_2, 0x21, 2, true),
        pin_record(4, MEMBER_1, 0x11, 1, true),
        pin_record(5, MEMBER_1, 0x11, 2, true),
        pin_record(6, MEMBER_1, 0x11, 9, true),
    ]);
    assert_eq!(
        pinned_ids(&state),
        vec![(message(2), MEMBER_2), (message(1), MEMBER_1)],
        "oldest pin first; a second pin or a pin of an unknown message changes nothing"
    );
    let state = chat(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_1, 0x11, 2, 1),
        pin_record(3, MEMBER_2, 0x21, 1, true),
        pin_record(4, MEMBER_2, 0x21, 2, true),
        pin_record(5, MEMBER_2, 0x21, 1, false),
        pin_record(6, MEMBER_2, 0x21, 1, false),
    ]);
    assert_eq!(pinned_ids(&state), vec![(message(2), MEMBER_2)]);
    // The author's deletion unpins; an admin's removal hides the pin.
    let state = chat(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_1, 0x11, 2, 1),
        pin_record(3, MEMBER_2, 0x21, 1, true),
        pin_record(4, MEMBER_2, 0x21, 2, true),
        deleted(5, MEMBER_1, 0x11, 1, false),
        deleted(6, ADMIN, 0x31, 2, true),
    ]);
    assert_eq!(pinned_ids(&state), vec![(message(2), MEMBER_2)]);
    assert_eq!(state.shown_pins(&[ActorId(ADMIN)]).len(), 0);
    assert_eq!(
        state.shown_pins(&[]).len(),
        1,
        "no named admin: the removal doesn't count"
    );
}

#[test]
fn commands_pin_up_to_the_limit_and_refuse_what_changes_nothing() {
    let mut log = History::chat();
    for id in 1..=12u8 {
        run(
            &mut log,
            post(id, ChatContentKind::Text),
            context(id, MEMBER_1, 0x11, id.into()),
        )
        .unwrap();
    }
    let mut next = 20u8;
    let mut step = |log: &mut History, command: C, actor: [u8; 16]| {
        next += 1;
        run(
            log,
            command,
            context(next, actor, actor[0], u64::from(next)),
        )
    };
    // Anyone who can post may pin; a message once, and only if it exists.
    step(&mut log, pin(1, true), MEMBER_2).unwrap();
    assert_eq!(
        step(&mut log, pin(1, true), MEMBER_1),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        step(&mut log, pin(99, true), MEMBER_1),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        step(&mut log, pin(2, false), MEMBER_1),
        Err(KinError::InvalidEvent)
    );
    for id in 2..=MAX_PINS as u8 {
        step(&mut log, pin(id, true), MEMBER_1).unwrap();
    }
    // The 11th is refused until one is unpinned, by anyone.
    assert_eq!(
        step(&mut log, pin(11, true), MEMBER_1),
        Err(KinError::InvalidEvent)
    );
    step(&mut log, pin(1, false), MEMBER_1).unwrap();
    step(&mut log, pin(11, true), MEMBER_2).unwrap();
    assert_eq!(
        step(&mut log, pin(12, true), MEMBER_1),
        Err(KinError::InvalidEvent)
    );
    // Deleting a pinned message for everyone frees its slot; it can't be pinned again.
    step(&mut log, delete(2, false), MEMBER_1).unwrap();
    assert_eq!(
        step(&mut log, pin(2, true), MEMBER_1),
        Err(KinError::InvalidEvent)
    );
    step(&mut log, pin(12, true), MEMBER_1).unwrap();
    // An admin's removal also frees the slot.
    assert_eq!(
        step(&mut log, pin(1, true), MEMBER_1),
        Err(KinError::InvalidEvent)
    );
    step(&mut log, delete(3, true), ADMIN).unwrap();
    step(&mut log, pin(1, true), MEMBER_1).unwrap();
}

#[test]
fn the_wire_command_pins() {
    let bytes = kcmd(48, message(1), 1, &[]);
    assert_eq!(decode_command(&bytes).unwrap().0, pin(1, true));
    assert_eq!(
        decode_command(&kcmd(48, message(1), 0, &[])).unwrap().0,
        pin(1, false)
    );
    for broken in [
        kcmd(48, message(1), 2, &[]),
        kcmd(48, [0; 16], 1, &[]),
        kcmd(48, message(1), 1, &[1]),
    ] {
        assert!(decode_command(&broken).is_err());
    }
}

#[test]
fn a_page_lists_pins_with_who_pinned_and_the_message_as_a_quote() {
    let state_records = [
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_1, 0x11, 2, 1),
        posted(3, MEMBER_1, 0x11, 3, 1),
        pin_record(4, MEMBER_2, 0x21, 2, true),
        pin_record(5, MEMBER_1, 0x11, 1, true),
        pin_record(6, MEMBER_1, 0x11, 3, true),
        deleted(7, MEMBER_1, 0x11, 3, false),
    ];
    let mut log = history_of(&state_records);
    let mut texts = ChatTexts::new();
    let kctx = kine(&[], 0, TEST_DATE, None);
    let without = chat_page(&kchq(u32::MAX, 10, 0, &[], &kctx), &mut log, &mut texts).unwrap();
    let with = chat_page(&kchq(u32::MAX, 10, 8, &[], &kctx), &mut log, &mut texts).unwrap();
    assert!(with.len() > without.len());
    assert_eq!(&with[..without.len()], &without[..], "pins only append");
    let tail = &with[without.len()..];
    assert_eq!(
        u32_at(tail, 0),
        2,
        "the deleted message is no longer pinned"
    );
    // Per pin: who pinned it, then a quote entry starting with the message ID.
    assert_eq!(&tail[4..20], &MEMBER_2);
    assert_eq!(&tail[20..36], &message(2));
    assert_eq!(tail[36], 1, "live");
    let second = 4 + 16 + 108;
    assert_eq!(&tail[second..second + 16], &MEMBER_1);
    assert_eq!(&tail[second + 16..second + 32], &message(1));
    assert_eq!(tail.len(), 4 + 2 * (16 + 108));
    // An admin's removal hides the pin from a page that names that admin.
    let mut log = history_of(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        pin_record(2, MEMBER_2, 0x21, 1, true),
        deleted(3, ADMIN, 0x31, 1, true),
    ]);
    let hidden = chat_page(
        &kchq(u32::MAX, 10, 8, &[ADMIN], &kctx),
        &mut log,
        &mut texts,
    )
    .unwrap();
    assert_eq!(u32_at(&hidden, hidden.len() - 4), 0);
    let shown = chat_page(&kchq(u32::MAX, 10, 8, &[], &kctx), &mut log, &mut texts).unwrap();
    assert_eq!(u32_at(&shown, shown.len() - (4 + 16 + 108)), 1);
}

#[test]
fn a_late_pin_of_a_deleted_message_changes_nothing_and_extra_pins_wait_their_turn() {
    let state = chat(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        deleted(2, MEMBER_1, 0x11, 1, false),
        pin_record(3, MEMBER_2, 0x21, 1, true),
    ]);
    assert!(state.pins.is_empty() && !state.is_pinned(&ChatMessageId(message(1))));
    // Twelve pins raced past the limit: the page shows the first ten, and an
    // unpin brings the next one back.
    let mut records = Vec::new();
    for id in 1..=12u8 {
        records.push(posted(u32::from(id), MEMBER_1, 0x11, id, 1));
    }
    for id in 1..=12u8 {
        records.push(pin_record(20 + u32::from(id), MEMBER_2, 0x21, id, true));
    }
    let state = chat(&records);
    let ids = |state: &ChatState| {
        state
            .shown_pins(&[])
            .iter()
            .map(|pin| pin.message_id.0)
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&state), (1..=10).map(message).collect::<Vec<_>>());
    records.push(pin_record(40, MEMBER_1, 0x11, 1, false));
    let state = chat(&records);
    assert_eq!(ids(&state), (2..=11).map(message).collect::<Vec<_>>());
}

// Polls (#135).

fn poll_spec(options: u8, multiple: bool) -> ChatContentKind {
    ChatContentKind::Poll(crate::chat::PollSpec { options, multiple })
}

fn poll_record(
    event: u32,
    actor: [u8; 16],
    device: u8,
    id: u8,
    options: u8,
    multiple: bool,
) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&[3, options, u8::from(multiple), 0]);
    payload.extend_from_slice(&blob(id, 0));
    payload.extend_from_slice(&key(id, 0));
    record(44, event, actor, device, &payload)
}

fn vote_record(event: u32, actor: [u8; 16], device: u8, id: u8, choice: u16) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&choice.to_le_bytes());
    payload.extend_from_slice(&[0, 0]);
    record(49, event, actor, device, &payload)
}

fn close_record(event: u32, actor: [u8; 16], device: u8, id: u8) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&[0; 4]);
    record(50, event, actor, device, &payload)
}

fn vote(id: u8, options: u16) -> C {
    C::VoteChatPoll {
        id: ChatMessageId(message(id)),
        options,
    }
}

fn close_poll(id: u8) -> C {
    C::CloseChatPoll {
        id: ChatMessageId(message(id)),
    }
}

fn votes_of(state: &ChatState, id: u8) -> Vec<([u8; 16], u16)> {
    state
        .polls
        .get(&ChatMessageId(message(id)))
        .map(|poll| poll.votes.iter().map(|(who, c)| (who.0, *c)).collect())
        .unwrap_or_default()
}

#[test]
fn poll_records_decode_as_documented_and_malformed_ones_are_refused() {
    let good = poll_record(1, MEMBER_1, 0x11, 1, 3, true);
    let event = decode_event(&good).unwrap();
    assert!(matches!(
        event.kind,
        EventKind::ChatMessagePosted {
            content_kind: ChatContentKind::Poll(crate::chat::PollSpec {
                options: 3,
                multiple: true
            }),
            ..
        }
    ));
    assert_eq!(crate::codec::encode_event(&event).unwrap(), good);
    // The option count is 2..=10, the flag 0 or 1, and only a poll has them.
    for (options, multiple) in [(0u8, 0u8), (1, 0), (11, 0), (3, 2)] {
        let mut payload = message(1).to_vec();
        payload.extend_from_slice(&[3, options, multiple, 0]);
        payload.extend_from_slice(&blob(1, 0));
        payload.extend_from_slice(&key(1, 0));
        assert!(decode_event(&record(44, 1, MEMBER_1, 0x11, &payload)).is_err());
    }
    for kind in [1u8, 2] {
        let mut payload = message(1).to_vec();
        payload.extend_from_slice(&[kind, 3, 0, 0]);
        payload.extend_from_slice(&blob(1, 0));
        payload.extend_from_slice(&key(1, 0));
        assert!(decode_event(&record(44, 1, MEMBER_1, 0x11, &payload)).is_err());
    }
    let vote_bytes = vote_record(2, MEMBER_2, 0x21, 1, 0b101);
    let event = decode_event(&vote_bytes).unwrap();
    assert_eq!(
        event.kind,
        EventKind::ChatPollVote {
            message_id: ChatMessageId(message(1)),
            options: 0b101
        }
    );
    assert!(event.kind.is_chat());
    assert_eq!(crate::codec::encode_event(&event).unwrap(), vote_bytes);
    let close_bytes = close_record(3, MEMBER_1, 0x11, 1);
    let event = decode_event(&close_bytes).unwrap();
    assert_eq!(
        event.kind,
        EventKind::ChatPollClosed {
            message_id: ChatMessageId(message(1))
        }
    );
    assert_eq!(crate::codec::encode_event(&event).unwrap(), close_bytes);
    let broken = |kind: u16, edit: &dyn Fn(&mut Vec<u8>)| {
        let mut bytes = message(1).to_vec();
        bytes.extend_from_slice(&[1, 0, 0, 0]);
        edit(&mut bytes);
        record(kind, 2, MEMBER_2, 0x21, &bytes)
    };
    for bad in [
        broken(49, &|b| b.push(0)),
        broken(49, &|b| {
            b.pop();
        }),
        broken(49, &|b| b[18] = 1),
        broken(49, &|b| b[..16].fill(0)),
        broken(50, &|b| b[16] = 1),
        broken(50, &|b| b.push(0)),
        broken(50, &|b| b[..16].fill(0)),
    ] {
        assert!(decode_event(&bad).is_err());
    }
}

#[test]
fn replay_counts_the_last_vote_per_member_and_stops_at_the_authors_close() {
    let state = chat(&[
        poll_record(1, MEMBER_1, 0x11, 1, 3, false),
        vote_record(2, MEMBER_1, 0x11, 1, 0b001),
        vote_record(3, MEMBER_2, 0x21, 1, 0b010),
        vote_record(4, MEMBER_1, 0x11, 1, 0b100),
        // Not a choice this poll has, and two choices in a single-choice poll.
        vote_record(5, MEMBER_2, 0x21, 1, 0b1000),
        vote_record(6, MEMBER_2, 0x21, 1, 0b011),
    ]);
    assert_eq!(
        votes_of(&state, 1),
        vec![(MEMBER_1, 0b100), (MEMBER_2, 0b010)]
    );
    // Several choices where the poll allows them; none clears a vote.
    let state = chat(&[
        poll_record(1, MEMBER_1, 0x11, 1, 4, true),
        vote_record(2, MEMBER_2, 0x21, 1, 0b0101),
        vote_record(3, MEMBER_1, 0x11, 1, 0b1111),
        vote_record(4, MEMBER_1, 0x11, 1, 0),
    ]);
    assert_eq!(votes_of(&state, 1), vec![(MEMBER_2, 0b0101)]);
    // Only the author closes; later votes don't count; the first close stands.
    let state = chat(&[
        poll_record(1, MEMBER_1, 0x11, 1, 2, false),
        vote_record(2, MEMBER_2, 0x21, 1, 0b01),
        close_record(3, MEMBER_2, 0x21, 1),
        vote_record(4, MEMBER_2, 0x21, 1, 0b10),
        close_record(5, MEMBER_1, 0x11, 1),
        vote_record(6, MEMBER_2, 0x21, 1, 0b01),
        vote_record(7, MEMBER_1, 0x11, 1, 0b10),
        close_record(8, MEMBER_1, 0x11, 1),
    ]);
    assert_eq!(votes_of(&state, 1), vec![(MEMBER_2, 0b10)]);
    assert!(state.polls[&ChatMessageId(message(1))].closed);
    // A vote or close for a text message, or one this history lacks, changes nothing.
    let state = chat(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        vote_record(2, MEMBER_2, 0x21, 1, 0b1),
        close_record(3, MEMBER_1, 0x11, 1),
        vote_record(4, MEMBER_2, 0x21, 9, 0b1),
    ]);
    assert!(state.polls.is_empty());
    // The author's deletion deletes the votes; an admin's removal hides the poll.
    let state = chat(&[
        poll_record(1, MEMBER_1, 0x11, 1, 2, false),
        vote_record(2, MEMBER_2, 0x21, 1, 0b01),
        deleted(3, MEMBER_1, 0x11, 1, false),
        vote_record(4, MEMBER_2, 0x21, 1, 0b10),
    ]);
    assert!(state.polls.is_empty(), "votes go with the poll");
}

#[test]
fn two_devices_of_one_member_converge_on_the_later_vote() {
    let one = [
        poll_record(1, MEMBER_1, 0x11, 1, 3, false),
        vote_record(2, MEMBER_2, 0x21, 1, 0b001),
        vote_record(3, MEMBER_2, 0x22, 1, 0b100),
    ];
    // Replay orders by logical time whatever the arrival order.
    let state = chat(&one);
    assert_eq!(votes_of(&state, 1), vec![(MEMBER_2, 0b100)]);
    let state = chat(&[one[0].clone(), one[2].clone(), one[1].clone()]);
    assert_eq!(votes_of(&state, 1), vec![(MEMBER_2, 0b100)]);
}

#[test]
fn commands_post_polls_vote_and_close_under_the_rules_replay_applies() {
    let mut log = History::chat();
    let mut next = 0u8;
    let mut step = |log: &mut History, command: C, actor: [u8; 16]| {
        next += 1;
        run(
            log,
            command,
            context(next, actor, actor[0], u64::from(next)),
        )
    };
    // Shape: 2..=10 options; a poll stands alone.
    for spec in [poll_spec(1, false), poll_spec(11, false)] {
        assert_eq!(
            step(&mut log, post(1, spec), MEMBER_1),
            Err(KinError::InvalidEvent)
        );
    }
    let mut reply = post(1, poll_spec(3, false));
    if let C::PostChatMessage { reply_to, .. } = &mut reply {
        *reply_to = Some(ChatMessageId(message(2)));
    }
    assert_eq!(step(&mut log, reply, MEMBER_1), Err(KinError::InvalidEvent));
    step(&mut log, post(1, poll_spec(3, false)), MEMBER_1).unwrap();
    step(&mut log, post(2, poll_spec(4, true)), MEMBER_1).unwrap();
    step(&mut log, post(3, ChatContentKind::Text), MEMBER_1).unwrap();
    // A poll can't be edited.
    assert_eq!(
        step(&mut log, edit(1, 1), MEMBER_1),
        Err(KinError::InvalidEvent)
    );
    // Votes: the poll's own options, one in a single-choice poll, a change each time.
    step(&mut log, vote(1, 0b001), MEMBER_2).unwrap();
    for refused in [vote(1, 0b001), vote(1, 0b1000), vote(1, 0b011)] {
        assert_eq!(
            step(&mut log, refused, MEMBER_2),
            Err(KinError::InvalidEvent)
        );
    }
    step(&mut log, vote(1, 0b100), MEMBER_2).unwrap();
    step(&mut log, vote(1, 0), MEMBER_2).unwrap();
    assert_eq!(
        step(&mut log, vote(1, 0), MEMBER_2),
        Err(KinError::InvalidEvent),
        "clearing a vote that isn't there changes nothing"
    );
    step(&mut log, vote(2, 0b1011), MEMBER_2).unwrap();
    for refused in [vote(3, 0b1), vote(9, 0b1)] {
        assert_eq!(
            step(&mut log, refused, MEMBER_2),
            Err(KinError::InvalidEvent)
        );
    }
    // Only the author closes, once; nobody votes in a closed poll.
    assert_eq!(
        step(&mut log, close_poll(1), MEMBER_2),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        step(&mut log, close_poll(3), MEMBER_1),
        Err(KinError::InvalidEvent)
    );
    step(&mut log, close_poll(1), MEMBER_1).unwrap();
    assert_eq!(
        step(&mut log, close_poll(1), MEMBER_1),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        step(&mut log, vote(1, 0b010), ADMIN),
        Err(KinError::InvalidEvent)
    );
    // A deleted poll takes no votes and can't be closed.
    step(&mut log, delete(2, false), MEMBER_1).unwrap();
    assert_eq!(
        step(&mut log, vote(2, 0b1), ADMIN),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        step(&mut log, close_poll(2), MEMBER_1),
        Err(KinError::InvalidEvent)
    );
}

#[test]
fn the_wire_commands_post_vote_and_close_polls() {
    let mut refs = blob(1, 0).to_vec();
    refs.extend_from_slice(&key(1, 0));
    let with_date = |mut bytes: Vec<u8>, date: u32| {
        bytes[108..112].copy_from_slice(&date.to_le_bytes());
        bytes
    };
    // The date field holds the option count and, in the next byte, the flag.
    assert_eq!(
        decode_command(&with_date(kcmd(44, message(1), 3, &refs), 0x0104))
            .unwrap()
            .0,
        post(1, poll_spec(4, true))
    );
    assert_eq!(
        decode_command(&with_date(kcmd(44, message(1), 3, &refs), 3))
            .unwrap()
            .0,
        post(1, poll_spec(3, false))
    );
    for broken in [
        with_date(kcmd(44, message(1), 3, &refs), 1),
        with_date(kcmd(44, message(1), 3, &refs), 11),
        with_date(kcmd(44, message(1), 3, &refs), 0x0203),
        with_date(kcmd(44, message(1), 3, &refs), 0x1_0003),
        with_date(kcmd(44, message(1), 1, &refs), 3),
        kcmd(44, message(1), 4, &refs),
    ] {
        assert!(decode_command(&broken).is_err());
    }
    assert_eq!(
        decode_command(&with_date(kcmd(49, message(1), 0, &[]), 0b101))
            .unwrap()
            .0,
        vote(1, 0b101)
    );
    assert_eq!(
        decode_command(&kcmd(49, message(1), 0, &[])).unwrap().0,
        vote(1, 0)
    );
    for broken in [
        with_date(kcmd(49, message(1), 0, &[]), 0x1_0000),
        kcmd(49, message(1), 1, &[]),
        kcmd(49, [0; 16], 0, &[]),
        kcmd(49, message(1), 0, &[1]),
    ] {
        assert!(decode_command(&broken).is_err());
    }
    assert_eq!(
        decode_command(&kcmd(50, message(1), 0, &[])).unwrap().0,
        close_poll(1)
    );
    for broken in [
        kcmd(50, message(1), 1, &[]),
        kcmd(50, [0; 16], 0, &[]),
        kcmd(50, message(1), 0, &[1]),
        with_date(kcmd(50, message(1), 0, &[]), 1),
    ] {
        assert!(decode_command(&broken).is_err());
    }
}

#[test]
fn a_page_lists_polls_with_their_state_and_who_voted_for_what() {
    let mut log = history_of(&[
        poll_record(1, MEMBER_1, 0x11, 1, 3, true),
        posted(2, MEMBER_1, 0x11, 2, 1),
        vote_record(3, MEMBER_2, 0x21, 1, 0b011),
        vote_record(4, MEMBER_1, 0x11, 1, 0b100),
        close_record(5, MEMBER_1, 0x11, 1),
    ]);
    let mut texts = ChatTexts::new();
    let kctx = kine(&[], 0, TEST_DATE, None);
    let without = chat_page(&kchq(u32::MAX, 10, 0, &[], &kctx), &mut log, &mut texts).unwrap();
    let with = chat_page(&kchq(u32::MAX, 10, 16, &[], &kctx), &mut log, &mut texts).unwrap();
    // Without the flag a poll is an ordinary record of kind 3.
    assert_eq!(without[28 + 69], 3);
    assert_eq!(&without[28 + 118..28 + 128], &[0; 10]);
    // With it: option count, flags (multiple 1, closed 2), voter count.
    assert_eq!(with[28 + 69], 3);
    assert_eq!(with[28 + 118], 3);
    assert_eq!(with[28 + 119], 3);
    assert_eq!(u16::from_le_bytes([with[28 + 120], with[28 + 121]]), 2);
    // The text message has none.
    assert_eq!(&with[28 + 128 + 118..28 + 128 + 128], &[0; 10]);
    // The votes close the page, voters in ascending actor order.
    let tail = &with[with.len() - 40..];
    assert_eq!(&tail[..16], &MEMBER_1);
    assert_eq!(u16::from_le_bytes([tail[16], tail[17]]), 0b100);
    assert_eq!(&tail[20..36], &MEMBER_2);
    assert_eq!(u16::from_le_bytes([tail[36], tail[37]]), 0b011);
    assert_eq!(with.len() - without.len(), 40);
    // A deleted or removed poll shows none of it.
    let mut gone = history_of(&[
        poll_record(1, MEMBER_1, 0x11, 1, 3, true),
        vote_record(2, MEMBER_2, 0x21, 1, 0b01),
        deleted(3, ADMIN, 0x31, 1, true),
    ]);
    let hidden = chat_page(
        &kchq(u32::MAX, 10, 16, &[ADMIN], &kctx),
        &mut gone,
        &mut texts,
    )
    .unwrap();
    assert_eq!(&hidden[28 + 118..28 + 128], &[0; 10]);
    assert_eq!(
        hidden.len(),
        chat_page(
            &kchq(u32::MAX, 10, 0, &[ADMIN], &kctx),
            &mut gone,
            &mut texts
        )
        .unwrap()
        .len()
    );
}

// "Talk later" topics (#312): their own file, sharing these helpers.
#[path = "chat_topic_tests.rs"]
mod topic_tests;
