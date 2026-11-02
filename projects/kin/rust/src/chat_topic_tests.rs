// "Talk later" topics (#312, ADR 0014): CHAT_TOPIC_SET (65), its replay
// rules, the command that creates it, and the topics section of a KCHP page.
// A submodule of chat_tests, so it shares that file's hand-written records,
// commands and page helpers; nothing here comes from the encoders.
use super::*;

fn topic_record(event: u32, actor: [u8; 16], device: u8, id: u8, state: u8) -> Vec<u8> {
    let mut payload = message(id).to_vec();
    payload.extend_from_slice(&[state, 0, 0, 0]);
    record(65, event, actor, device, &payload)
}

fn topic(id: u8, state: ChatTopicState) -> C {
    C::SetChatTopic {
        id: ChatMessageId(message(id)),
        state,
    }
}

/// A topic as (message, state, flagged by, changed by).
type TopicRow = ([u8; 16], ChatTopicState, [u8; 16], [u8; 16]);

/// The topics in record (insertion) order.
fn topics_of(state: &ChatState) -> Vec<TopicRow> {
    state
        .topics
        .iter()
        .map(|topic| {
            (
                topic.message_id.0,
                topic.state,
                topic.flagged_by.0,
                topic.changed_by.0,
            )
        })
        .collect()
}

/// The shown topics' message IDs, newest change first.
fn shown_ids(state: &ChatState, admins: &[[u8; 16]]) -> Vec<[u8; 16]> {
    let admins = admins.iter().copied().map(ActorId).collect::<Vec<_>>();
    state
        .shown_topics(&admins)
        .iter()
        .map(|topic| topic.message_id.0)
        .collect()
}

use ChatTopicState::{Cleared, Open, Resolved};

#[test]
fn topic_records_decode_as_documented_and_malformed_ones_are_refused() {
    for (code, state) in [(0u8, Cleared), (1, Open), (2, Resolved)] {
        let good = topic_record(2, MEMBER_2, 0x21, 1, code);
        let event = decode_event(&good).unwrap();
        assert_eq!(
            event.kind,
            EventKind::ChatTopicSet {
                message_id: ChatMessageId(message(1)),
                state
            }
        );
        assert!(event.kind.is_chat());
        assert_eq!(crate::codec::kind_code(&event.kind), CHAT_TOPIC_SET);
        // Encoding it again gives the same bytes.
        assert_eq!(crate::codec::encode_event(&event).unwrap(), good);
    }
    let payload = |edit: &dyn Fn(&mut Vec<u8>)| {
        let mut bytes = message(1).to_vec();
        bytes.extend_from_slice(&[1, 0, 0, 0]);
        edit(&mut bytes);
        record(65, 2, MEMBER_2, 0x21, &bytes)
    };
    for broken in [
        payload(&|b| b.push(0)),
        payload(&|b| {
            b.pop();
        }),
        payload(&|b| b[16] = 3),
        payload(&|b| b[16] = 0xff),
        payload(&|b| b[17] = 1),
        payload(&|b| b[19] = 1),
        payload(&|b| b[..16].fill(0)),
    ] {
        assert_eq!(decode_event(&broken), Err(KinError::MalformedProtocol));
    }
}

#[test]
fn the_household_history_refuses_topics() {
    let mut household = History::new();
    assert!(household
        .append(&batch(&[topic_record(1, MEMBER_1, 0x11, 1, 1)]))
        .is_err());
    assert!(household.is_empty());
}

#[test]
fn replay_lets_the_latest_topic_event_win_and_keeps_who_flagged_it() {
    let state = chat(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_1, 0x11, 2, 1),
        topic_record(3, MEMBER_2, 0x21, 2, 1),
        topic_record(4, MEMBER_1, 0x11, 1, 1),
        topic_record(5, MEMBER_1, 0x11, 2, 2),
    ]);
    assert_eq!(
        topics_of(&state),
        vec![
            (message(2), Resolved, MEMBER_2, MEMBER_1),
            (message(1), Open, MEMBER_1, MEMBER_1),
        ],
        "insertion order; the first opener stays, the last changer is kept"
    );
    assert_eq!(
        shown_ids(&state, &[]),
        vec![message(2), message(1)],
        "newest change first"
    );
    // Reopened by member 2, then cleared and opened again by member 2: the
    // record starts over and moves to the end.
    let state = chat(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_1, 0x11, 2, 1),
        topic_record(3, MEMBER_1, 0x11, 1, 1),
        topic_record(4, MEMBER_1, 0x11, 2, 1),
        topic_record(5, MEMBER_2, 0x21, 1, 2),
        topic_record(6, MEMBER_2, 0x21, 1, 1),
        topic_record(7, MEMBER_2, 0x21, 2, 0),
        topic_record(8, MEMBER_2, 0x21, 2, 1),
    ]);
    assert_eq!(
        topics_of(&state),
        vec![
            (message(1), Open, MEMBER_1, MEMBER_2),
            (message(2), Open, MEMBER_2, MEMBER_2),
        ]
    );
    assert_eq!(shown_ids(&state, &[]), vec![message(2), message(1)]);
}

#[test]
fn replay_is_tolerant_of_out_of_order_unknown_and_deleted_messages() {
    // Replay doesn't hold events to the command rules: resolving a message
    // with no topic lists it resolved; the same state again changes nothing
    // (not even who last changed it); clearing none changes nothing.
    let state = chat(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        topic_record(2, MEMBER_2, 0x21, 1, 2),
        topic_record(3, MEMBER_1, 0x11, 1, 2),
        topic_record(4, MEMBER_1, 0x11, 9, 1),
        topic_record(5, MEMBER_1, 0x11, 9, 0),
    ]);
    assert_eq!(
        topics_of(&state),
        vec![(message(1), Resolved, MEMBER_2, MEMBER_2)]
    );
    assert_eq!(state.topic_clock, 1);
    // A topic event before its message's post (in log order) changes
    // nothing: replay order decides, not arrival.
    let state = chat(&[
        topic_record(1, MEMBER_2, 0x21, 1, 1),
        posted(2, MEMBER_1, 0x11, 1, 1),
    ]);
    assert!(state.topics.is_empty());
    // Whatever order the records arrive in, replay sorts them the same way.
    let records = [
        posted(1, MEMBER_1, 0x11, 1, 1),
        topic_record(2, MEMBER_2, 0x21, 1, 1),
        topic_record(3, MEMBER_1, 0x11, 1, 2),
    ];
    let forward = chat(&records);
    let backward = chat(&[records[2].clone(), records[1].clone(), records[0].clone()]);
    assert_eq!(forward.topics, backward.topics);
    assert_eq!(
        topics_of(&forward),
        vec![(message(1), Resolved, MEMBER_2, MEMBER_1)]
    );
    // The author's deletion drops the topic, and a later flag changes nothing.
    let state = chat(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_1, 0x11, 2, 1),
        topic_record(3, MEMBER_2, 0x21, 1, 1),
        topic_record(4, MEMBER_2, 0x21, 2, 1),
        deleted(5, MEMBER_1, 0x11, 1, false),
        topic_record(6, MEMBER_2, 0x21, 1, 1),
    ]);
    assert_eq!(
        topics_of(&state),
        vec![(message(2), Open, MEMBER_2, MEMBER_2)]
    );
    // An admin's removal keeps the record but hides it from a page naming
    // that admin.
    let state = chat(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        topic_record(2, MEMBER_2, 0x21, 1, 1),
        deleted(3, ADMIN, 0x31, 1, true),
    ]);
    assert_eq!(state.topics.len(), 1);
    assert!(shown_ids(&state, &[ADMIN]).is_empty());
    assert_eq!(shown_ids(&state, &[]), vec![message(1)]);
}

#[test]
fn replay_keeps_at_most_max_topics() {
    let count = MAX_TOPICS as u32 + 1;
    let mut records = Vec::new();
    for n in 0..count {
        let mut payload = numbered_id(1000 + n).to_vec();
        payload.extend_from_slice(&[1, 0, 0, 0]);
        payload.extend_from_slice(&[0xb0; 32]);
        payload[51] = n as u8;
        payload[50] = (n >> 8) as u8;
        payload.extend_from_slice(&[0xc0; 32]);
        records.push(record(44, 1 + n, MEMBER_1, 0x11, &payload));
    }
    for n in 0..count {
        let mut payload = numbered_id(1000 + n).to_vec();
        payload.extend_from_slice(&[1, 0, 0, 0]);
        records.push(record(65, 1000 + n, MEMBER_2, 0x21, &payload));
    }
    let state = chat(&records);
    assert_eq!(state.topics.len(), MAX_TOPICS);
    assert!(state
        .topic(&ChatMessageId(numbered_id(1000 + count - 1)))
        .is_none());
}

/// A chat log with messages 1..=`count` posted by member 1.
fn log_with(count: u8) -> History {
    let mut log = History::chat();
    for id in 1..=count {
        run(
            &mut log,
            post(id, ChatContentKind::Text),
            context(id, MEMBER_1, 0x11, id.into()),
        )
        .unwrap();
    }
    log
}

#[test]
fn commands_open_resolve_reopen_and_clear_and_refuse_what_changes_nothing() {
    let mut log = log_with(3);
    let mut next = 20u8;
    let mut step = |log: &mut History, command: C, actor: [u8; 16]| {
        next += 1;
        run(
            log,
            command,
            context(next, actor, actor[0], u64::from(next)),
        )
    };
    let refused = Err(KinError::InvalidEvent);
    // Nothing to resolve or clear yet.
    assert_eq!(step(&mut log, topic(1, Resolved), MEMBER_2), refused);
    assert_eq!(step(&mut log, topic(1, Cleared), MEMBER_2), refused);
    // Anyone who can post opens it; opening it again changes nothing.
    step(&mut log, topic(1, Open), MEMBER_2).unwrap();
    assert_eq!(step(&mut log, topic(1, Open), MEMBER_1), refused);
    // Resolve, not twice; reopen from resolved; resolve and clear.
    step(&mut log, topic(1, Resolved), MEMBER_1).unwrap();
    assert_eq!(step(&mut log, topic(1, Resolved), MEMBER_2), refused);
    step(&mut log, topic(1, Open), MEMBER_1).unwrap();
    step(&mut log, topic(1, Resolved), MEMBER_2).unwrap();
    step(&mut log, topic(1, Cleared), MEMBER_2).unwrap();
    assert_eq!(step(&mut log, topic(1, Cleared), MEMBER_2), refused);
    // Clear from open too.
    step(&mut log, topic(2, Open), MEMBER_1).unwrap();
    step(&mut log, topic(2, Cleared), MEMBER_1).unwrap();
    // A message the log lacks.
    assert_eq!(step(&mut log, topic(99, Open), MEMBER_1), refused);
    let context = local_context();
    let state = log
        .replay(&context)
        .unwrap()
        .finalize(context.as_of, context.civil_date)
        .unwrap();
    assert!(state.chat.topics.is_empty());
    // A message deleted for everyone: nothing at all, and deleting drops an
    // open topic.
    step(&mut log, topic(3, Open), MEMBER_2).unwrap();
    step(&mut log, delete(3, false), MEMBER_1).unwrap();
    for state in [Open, Resolved, Cleared] {
        assert_eq!(step(&mut log, topic(3, state), MEMBER_2), refused);
    }
}

#[test]
fn commands_on_a_message_an_admin_removed_only_clear() {
    let mut log = log_with(2);
    run(&mut log, topic(1, Open), context(21, MEMBER_2, 0x21, 21)).unwrap();
    run(&mut log, delete(1, true), context(22, ADMIN, 0x31, 22)).unwrap();
    run(&mut log, delete(2, true), context(23, ADMIN, 0x31, 23)).unwrap();
    for (n, command) in [topic(1, Resolved), topic(2, Open)].into_iter().enumerate() {
        assert_eq!(
            run(
                &mut log,
                command,
                context(30 + n as u8, MEMBER_2, 0x21, 30 + n as u64)
            ),
            Err(KinError::InvalidEvent)
        );
    }
    run(&mut log, topic(1, Cleared), context(40, MEMBER_2, 0x21, 40)).unwrap();
}

#[test]
fn commands_refuse_the_topic_past_max_topics() {
    let mut log = History::chat();
    let count = MAX_TOPICS as u32 + 1;
    let mut records = Vec::new();
    for n in 0..count {
        let mut payload = numbered_id(1000 + n).to_vec();
        payload.extend_from_slice(&[1, 0, 0, 0]);
        payload.extend_from_slice(&[0xb0; 32]);
        payload[51] = n as u8;
        payload[50] = (n >> 8) as u8;
        payload.extend_from_slice(&[0xc0; 32]);
        records.push(record(44, 1 + n, MEMBER_1, 0x11, &payload));
    }
    for n in 0..MAX_TOPICS as u32 {
        let mut payload = numbered_id(1000 + n).to_vec();
        payload.extend_from_slice(&[1, 0, 0, 0]);
        records.push(record(65, 1000 + n, MEMBER_2, 0x21, &payload));
    }
    log.append(&batch(&records)).unwrap();
    let last = ChatMessageId(numbered_id(1000 + count - 1));
    let at = |n: u64| CommandContext {
        logical_time: 5000 + n,
        ..context(0xee - n as u8, MEMBER_1, 0x11, 0)
    };
    let open_last = C::SetChatTopic {
        id: last,
        state: Open,
    };
    assert_eq!(
        run(&mut log, open_last.clone(), at(0)),
        Err(KinError::InvalidEvent),
        "the 201st is refused"
    );
    // Resolving one at the limit is fine; clearing one makes room.
    let first = ChatMessageId(numbered_id(1000));
    run(
        &mut log,
        C::SetChatTopic {
            id: first,
            state: Resolved,
        },
        at(1),
    )
    .unwrap();
    run(
        &mut log,
        C::SetChatTopic {
            id: first,
            state: Cleared,
        },
        at(2),
    )
    .unwrap();
    run(&mut log, open_last, at(3)).unwrap();
}

#[test]
fn the_wire_command_sets_a_topic() {
    for (option, state) in [(0u8, Cleared), (1, Open), (2, Resolved)] {
        assert_eq!(
            decode_command(&kcmd(65, message(1), option, &[]))
                .unwrap()
                .0,
            topic(1, state)
        );
    }
    let mut dated = kcmd(65, message(1), 1, &[]);
    dated[108] = 1;
    for broken in [
        kcmd(65, message(1), 3, &[]),
        kcmd(65, [0; 16], 1, &[]),
        kcmd(65, message(1), 1, &[1]),
        dated,
    ] {
        assert!(decode_command(&broken).is_err());
    }
    // A topic command is a chat command: the household history refuses it.
    let mut household = History::new();
    assert_eq!(
        execute_with(
            &topic(1, Open),
            context(1, MEMBER_1, 0x11, 1),
            &mut HeldHistory::new(&mut household, local_context()).unwrap()
        )
        .map(|_| ()),
        Err(KinError::InvalidEvent)
    );
}

#[test]
fn a_page_lists_topics_newest_change_first_after_everything_else() {
    let records = [
        posted(1, MEMBER_1, 0x11, 1, 1),
        posted(2, MEMBER_2, 0x21, 2, 1),
        posted(3, MEMBER_1, 0x11, 3, 1),
        pin_record(4, MEMBER_1, 0x11, 1, true),
        topic_record(5, MEMBER_2, 0x21, 1, 1),
        topic_record(6, MEMBER_1, 0x11, 2, 1),
        topic_record(7, MEMBER_1, 0x11, 1, 2),
        topic_record(8, MEMBER_2, 0x21, 3, 1),
        deleted(9, MEMBER_1, 0x11, 3, false),
    ];
    let mut log = history_of(&records);
    let mut texts = ChatTexts::new();
    put_texts(&kcht(&[(blob(1, 0), b"Holiday plans\nmore")]), &mut texts).unwrap();
    let kctx = kine(&[], 0, TEST_DATE, None);
    // Every other section asked for (texts, reactions, pins, polls): topics
    // only append.
    let without = chat_page(
        &kchq(u32::MAX, 10, 0b01_1101, &[], &kctx),
        &mut log,
        &mut texts,
    )
    .unwrap();
    let with = chat_page(
        &kchq(u32::MAX, 10, 0b11_1101, &[], &kctx),
        &mut log,
        &mut texts,
    )
    .unwrap();
    assert_eq!(&with[..without.len()], &without[..], "topics only append");
    let mut expected = 2u32.to_le_bytes().to_vec();
    // Message 1: resolved, flagged by member 2, quoted with its first line.
    expected.extend_from_slice(&message(1));
    expected.extend_from_slice(&[2, 0, 0, 0]);
    expected.extend_from_slice(&MEMBER_2);
    expected.extend_from_slice(&message(1));
    expected.extend_from_slice(&[1, 1, 0, 0]);
    expected.extend_from_slice(&MEMBER_1);
    expected.extend_from_slice(&blob(1, 0));
    expected.extend_from_slice(&key(1, 0));
    expected.extend_from_slice(&0u32.to_le_bytes());
    expected.extend_from_slice(&13u32.to_le_bytes());
    expected.extend_from_slice(b"Holiday plans");
    // Message 2: open, flagged by member 1, no text held.
    expected.extend_from_slice(&message(2));
    expected.extend_from_slice(&[1, 0, 0, 0]);
    expected.extend_from_slice(&MEMBER_1);
    expected.extend_from_slice(&message(2));
    expected.extend_from_slice(&[1, 1, 0, 0]);
    expected.extend_from_slice(&MEMBER_2);
    expected.extend_from_slice(&blob(2, 0));
    expected.extend_from_slice(&key(2, 0));
    expected.extend_from_slice(&1u32.to_le_bytes());
    expected.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(&with[without.len()..], &expected[..]);
    // Not asked for: no section at all. Asked for alone: the count and
    // entries follow the named mentions.
    let none = chat_page(&kchq(u32::MAX, 10, 0, &[], &kctx), &mut log, &mut texts).unwrap();
    let only = chat_page(
        &kchq(u32::MAX, 10, 0b10_0000, &[], &kctx),
        &mut log,
        &mut texts,
    )
    .unwrap();
    assert_eq!(&only[..none.len()], &none[..]);
    assert_eq!(u32_at(&only, none.len()), 2);
    assert_eq!(
        only.len(),
        none.len() + 4 + 2 * (36 + 108),
        "no texts asked for"
    );
    // An admin's removal hides a topic from a page naming that admin.
    let mut log = history_of(&[
        posted(1, MEMBER_1, 0x11, 1, 1),
        topic_record(2, MEMBER_2, 0x21, 1, 1),
        deleted(3, ADMIN, 0x31, 1, true),
    ]);
    let hidden = chat_page(
        &kchq(u32::MAX, 10, 32, &[ADMIN], &kctx),
        &mut log,
        &mut texts,
    )
    .unwrap();
    assert_eq!(u32_at(&hidden, hidden.len() - 4), 0);
    let shown = chat_page(&kchq(u32::MAX, 10, 32, &[], &kctx), &mut log, &mut texts).unwrap();
    assert_eq!(u32_at(&shown, shown.len() - (4 + 36 + 108)), 1);
    // Bit 6 is still reserved.
    assert!(chat_page(&kchq(u32::MAX, 10, 64, &[], &kctx), &mut log, &mut texts).is_err());
}
