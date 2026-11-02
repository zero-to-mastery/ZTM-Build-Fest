// Reminders and settings that follow a member (#520, private_prefs.rs):
// kinds 120, 121 and 130 in the private log, their strict payloads, replay
// (moves, clears that name a stale instant, per-key last-writer-wins by
// logical time then device), convergence in any arrival order, device clocks
// and time zones that never decide anything, the commands
// `kin_private_execute` takes, and KPRV sections 12 and 13. Wire records
// are written out by hand; they never come from the encoders.
use crate::codec::encode_event;
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::private::is_private_code;
use crate::private_command::execute as execute_private_history;
use crate::private_prefs::*;
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const SAM: [u8; 16] = [1; 16];
const ALEX: [u8; 16] = [2; 16];
const PHONE: [u8; 16] = [0x11; 16];
const LAPTOP: [u8; 16] = [0x12; 16];
const BASE_TIME: i64 = 1_791_475_200_000;
/// 2026-10-20 09:00 in New York (UTC−4): 13:00 UTC.
const NINE_NEW_YORK: i64 = 1_792_501_200_000;
const ITEM: [u8; 16] = [0x5a; 16];
const ROUTINE: [u8; 16] = [0x5b; 16];

struct Record {
    kind: u16,
    event: u32,
    logical_time: u64,
    actor: [u8; 16],
    device: [u8; 16],
    timestamp: i64,
    payload: Vec<u8>,
}

impl Record {
    fn new(kind: u16, event: u32, logical_time: u64, payload: Vec<u8>) -> Self {
        Record {
            kind,
            event,
            logical_time,
            actor: SAM,
            device: PHONE,
            timestamp: BASE_TIME + i64::from(event),
            payload,
        }
    }
    fn from(mut self, device: [u8; 16]) -> Self {
        self.device = device;
        self
    }
    fn by(mut self, actor: [u8; 16]) -> Self {
        self.actor = actor;
        self
    }
    fn stamped(mut self, timestamp: i64) -> Self {
        self.timestamp = timestamp;
        self
    }
    fn bytes(&self) -> Vec<u8> {
        let mut record = Vec::new();
        record.extend_from_slice(&1u16.to_le_bytes());
        record.extend_from_slice(&self.kind.to_le_bytes());
        record.extend_from_slice(&numbered_id(self.event));
        record.extend_from_slice(&HOUSEHOLD);
        record.extend_from_slice(&self.actor);
        record.extend_from_slice(&self.device);
        record.extend_from_slice(&self.timestamp.to_le_bytes());
        record.extend_from_slice(&self.logical_time.to_le_bytes());
        record.extend_from_slice(&(self.payload.len() as u32).to_le_bytes());
        record.extend_from_slice(&self.payload);
        record
    }
}

fn set_payload(kind: u8, id: [u8; 16], at: i64, offset: i16, zone: &[u8]) -> Vec<u8> {
    let mut payload = vec![kind, 0, 0, 0];
    payload.extend_from_slice(&id);
    payload.extend_from_slice(&at.to_le_bytes());
    payload.extend_from_slice(&offset.to_le_bytes());
    payload.extend_from_slice(&[zone.len() as u8, 0]);
    payload.extend_from_slice(zone);
    payload
}

fn clear_payload(kind: u8, reason: u8, id: [u8; 16], at: i64) -> Vec<u8> {
    let mut payload = vec![kind, reason, 0, 0];
    payload.extend_from_slice(&id);
    payload.extend_from_slice(&at.to_le_bytes());
    payload
}

fn setting_payload(key: u16, value: &[u8]) -> Vec<u8> {
    let mut payload = key.to_le_bytes().to_vec();
    payload.extend_from_slice(&[value.len() as u8, 0]);
    payload.extend_from_slice(value);
    payload
}

fn set(event: u32, logical_time: u64, at: i64) -> Record {
    Record::new(
        REMINDER_SET,
        event,
        logical_time,
        set_payload(1, ITEM, at, -240, b"America/New_York"),
    )
}

fn clear(event: u32, logical_time: u64, reason: u8, at: i64) -> Record {
    Record::new(
        REMINDER_CLEARED,
        event,
        logical_time,
        clear_payload(1, reason, ITEM, at),
    )
}

fn setting(event: u32, logical_time: u64, key: u16, value: &[u8]) -> Record {
    Record::new(
        SETTING_SET,
        event,
        logical_time,
        setting_payload(key, value),
    )
}

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

fn log_of(records: &[&Record]) -> History {
    let mut log = History::private();
    let bytes: Vec<Vec<u8>> = records.iter().map(|record| record.bytes()).collect();
    log.append(&batch(&bytes)).unwrap();
    log
}

fn context() -> Vec<u8> {
    kine(&[], 0, TEST_DATE, None)
}

fn kprv(log: &mut History) -> Vec<u8> {
    crate::core::private_state(&context(), log).unwrap()
}

fn prefs(log: &mut History) -> crate::private_prefs::PrefsState {
    let context = crate::request::decode_context(&context()).unwrap();
    log.replay(&context).unwrap().private().prefs().clone()
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

const fn item() -> ReminderTarget {
    ReminderTarget {
        kind: ReminderTargetKind::Item,
        id: ITEM,
    }
}

// --- Format ---------------------------------------------------------------

#[test]
fn the_reminder_and_setting_vectors_decode_and_reencode_byte_for_byte() {
    // docs/TEST-VECTORS.md 100.
    let record = set(1, 1, NINE_NEW_YORK).bytes();
    let event = decode_event(&record).unwrap();
    assert_eq!(
        event.kind,
        EventKind::ReminderSet {
            target: item(),
            at: NINE_NEW_YORK,
            utc_offset_minutes: -240,
            time_zone: "America/New_York".to_owned(),
        }
    );
    assert!(event.kind.is_private());
    assert_eq!(encode_event(&event).unwrap(), record);
    assert_eq!(&record[2..4], &[120, 0]);
    assert_eq!(&record[84..88], &[48, 0, 0, 0], "32 + 16 zone bytes");
    assert_eq!(&record[88..92], &[1, 0, 0, 0]);
    assert_eq!(&record[116..118], &(-240i16).to_le_bytes());
    assert_eq!(&record[118..120], &[16, 0]);
    assert_eq!(record.len(), 88 + 48);

    let record = clear(2, 2, 3, NINE_NEW_YORK).bytes();
    let event = decode_event(&record).unwrap();
    assert_eq!(
        event.kind,
        EventKind::ReminderCleared {
            target: item(),
            reason: ReminderClearReason::Dismissed,
            at: NINE_NEW_YORK,
        }
    );
    assert_eq!(encode_event(&event).unwrap(), record);
    assert_eq!(&record[2..4], &[121, 0]);
    assert_eq!(record.len(), 88 + 28);

    let record = setting(3, 3, SETTING_THEME_MODE, b"dark").bytes();
    let event = decode_event(&record).unwrap();
    assert_eq!(
        event.kind,
        EventKind::SettingSet {
            key: 1,
            value: "dark".to_owned(),
        }
    );
    assert_eq!(encode_event(&event).unwrap(), record);
    assert_eq!(&record[2..4], &[130, 0]);
    assert_eq!(&record[88..], &[1, 0, 4, 0, b'd', b'a', b'r', b'k']);
    // A routine reminder with no zone (a browser that can't tell).
    let routine = Record::new(
        REMINDER_SET,
        4,
        4,
        set_payload(2, ROUTINE, BASE_TIME, 60, b""),
    );
    assert!(matches!(
        decode_event(&routine.bytes()).unwrap().kind,
        EventKind::ReminderSet { target: ReminderTarget { kind: ReminderTargetKind::Routine, .. }, ref time_zone, .. } if time_zone.is_empty()
    ));
}

#[test]
fn reminder_and_setting_payloads_decode_strictly() {
    let bad = |kind: u16, payload: Vec<u8>| {
        decode_event(&Record::new(kind, 1, 1, payload).bytes()).map(|_| ())
    };
    let malformed = Err(KinError::MalformedProtocol);
    let zone = b"Europe/London";
    // Targets: kind 1 or 2, never a zero ID.
    assert_eq!(
        bad(REMINDER_SET, set_payload(0, ITEM, BASE_TIME, 0, zone)),
        malformed
    );
    assert_eq!(
        bad(REMINDER_SET, set_payload(3, ITEM, BASE_TIME, 0, zone)),
        malformed
    );
    assert_eq!(
        bad(REMINDER_SET, set_payload(1, [0; 16], BASE_TIME, 0, zone)),
        malformed
    );
    // Reserved bytes, the length, the instant, the offset and the zone.
    let mut reserved = set_payload(1, ITEM, BASE_TIME, 0, zone);
    reserved[2] = 1;
    assert_eq!(bad(REMINDER_SET, reserved), malformed);
    let mut trailing = set_payload(1, ITEM, BASE_TIME, 0, zone);
    trailing.push(b'x');
    assert_eq!(bad(REMINDER_SET, trailing), malformed);
    assert_eq!(
        bad(REMINDER_SET, set_payload(1, ITEM, i64::MAX, 0, zone)),
        malformed
    );
    assert_eq!(
        bad(REMINDER_SET, set_payload(1, ITEM, BASE_TIME, -721, zone)),
        malformed
    );
    assert_eq!(
        bad(REMINDER_SET, set_payload(1, ITEM, BASE_TIME, 841, zone)),
        malformed
    );
    assert_eq!(
        bad(
            REMINDER_SET,
            set_payload(1, ITEM, BASE_TIME, 0, b"Europe/Lon don")
        ),
        malformed
    );
    assert_eq!(
        bad(
            REMINDER_SET,
            set_payload(1, ITEM, BASE_TIME, 0, &[b'a'; 65])
        ),
        malformed
    );
    assert!(bad(
        REMINDER_SET,
        set_payload(1, ITEM, BASE_TIME, 840, &[b'a'; 64])
    )
    .is_ok());
    assert!(bad(
        REMINDER_SET,
        set_payload(2, ITEM, BASE_TIME, -720, b"Etc/GMT+12")
    )
    .is_ok());
    assert_eq!(bad(REMINDER_SET, vec![1; 31]), malformed);
    // Clears: a known reason, exactly 28 bytes.
    for reason in [0, 4] {
        assert_eq!(
            bad(REMINDER_CLEARED, clear_payload(1, reason, ITEM, BASE_TIME)),
            malformed
        );
    }
    let mut long = clear_payload(1, 1, ITEM, BASE_TIME);
    long.push(0);
    assert_eq!(bad(REMINDER_CLEARED, long), malformed);
    let mut reserved = clear_payload(1, 1, ITEM, BASE_TIME);
    reserved[3] = 9;
    assert_eq!(bad(REMINDER_CLEARED, reserved), malformed);
    // Settings: keys 1–255, short lowercase tokens, known vocabularies.
    assert_eq!(bad(SETTING_SET, setting_payload(0, b"dark")), malformed);
    assert_eq!(bad(SETTING_SET, setting_payload(256, b"x")), malformed);
    assert_eq!(bad(SETTING_SET, setting_payload(1, b"Dark")), malformed);
    assert_eq!(bad(SETTING_SET, setting_payload(1, b"sepia")), malformed);
    assert_eq!(
        bad(SETTING_SET, setting_payload(2, b"preset-39705")),
        malformed
    );
    assert_eq!(
        bad(SETTING_SET, setting_payload(2, b"preset-39705g")),
        malformed
    );
    assert_eq!(bad(SETTING_SET, setting_payload(3, b"huge")), malformed);
    assert_eq!(bad(SETTING_SET, setting_payload(8, b"yes")), malformed);
    assert_eq!(
        bad(SETTING_SET, setting_payload(99, &[b'a'; 33])),
        malformed
    );
    let mut reserved = setting_payload(1, b"dark");
    reserved[3] = 1;
    assert_eq!(bad(SETTING_SET, reserved), malformed);
    for (key, value) in [
        (1, &b"household"[..]),
        (2, b"preset-397052"),
        (2, b"custom-a14f68"),
        (2, b"default"),
        (3, b"larger"),
        (4, b"reduce"),
        (5, b"off"),
        (6, b"messages-and-mine"),
        (7, b"on"),
        (8, b"on"),
        (8, b"off"),
        (99, b"anything-a-later-release-says"),
        (1, b""),
    ] {
        assert!(
            bad(SETTING_SET, setting_payload(key, value)).is_ok(),
            "{key} {value:?}"
        );
    }
    // Codes 122–129 and 131–139 are this story's, still unassigned.
    for code in [122, 129, 131, 139] {
        assert!(is_private_code(code) && is_prefs_code(code));
        assert_eq!(
            decode_event(&Record::new(code, 1, 1, setting_payload(1, b"dark")).bytes()).map(|_| ()),
            Err(KinError::UnsupportedVersion)
        );
    }
}

#[test]
fn reminders_and_settings_stay_in_the_private_log() {
    let record = setting(1, 1, SETTING_TEXT_SIZE, b"large").bytes();
    for mut log in [History::new(), History::chat(), History::board()] {
        assert_eq!(
            log.append(&batch(std::slice::from_ref(&record))),
            Err(KinError::InvalidEvent)
        );
    }
    assert_eq!(
        crate::request::decode_request(&kine(&[set(1, 1, BASE_TIME).bytes()], 0, TEST_DATE, None))
            .map(|_| ()),
        Err(KinError::InvalidEvent)
    );
    // One member per log, as for every private record.
    let mut log = log_of(&[&set(1, 1, BASE_TIME), &setting(2, 2, 1, b"dark").by(ALEX)]);
    let context = crate::request::decode_context(&context()).unwrap();
    assert_eq!(
        log.replay(&context).map(|_| ()),
        Err(KinError::InvalidEvent)
    );
}

// --- Reminder replay ------------------------------------------------------

#[test]
fn setting_a_reminder_again_moves_it_instead_of_adding_one() {
    let later = NINE_NEW_YORK + 3_600_000;
    let mut log = log_of(&[&set(1, 1, NINE_NEW_YORK), &set(2, 2, later).from(LAPTOP)]);
    let state = prefs(&mut log);
    let reminders: Vec<_> = state.reminders().collect();
    assert_eq!(reminders.len(), 1);
    assert_eq!(reminders[0].1.at, later);
    assert_eq!(reminders[0].1.device_id, DeviceId(LAPTOP));
    assert_eq!(reminders[0].1.logical_time, 2);
}

#[test]
fn canceled_clears_whatever_is_set_and_done_or_dismissed_only_the_named_instant() {
    let later = NINE_NEW_YORK + 3_600_000;
    for reason in [1u8, 2, 3] {
        // Cleared for the instant it is set for: gone, whatever the reason.
        let mut log = log_of(&[
            &set(1, 1, NINE_NEW_YORK),
            &clear(2, 2, reason, NINE_NEW_YORK),
        ]);
        assert_eq!(prefs(&mut log).reminders().count(), 0, "reason {reason}");
        // The laptop moved it to 10:00 before the phone's 9:00 clear
        // arrived: canceled still clears it, done and dismissed don't.
        let mut log = log_of(&[
            &set(1, 1, NINE_NEW_YORK),
            &set(2, 2, later).from(LAPTOP),
            &clear(3, 3, reason, NINE_NEW_YORK),
        ]);
        let state = prefs(&mut log);
        assert_eq!(
            state.reminder(&item()).map(|reminder| reminder.at),
            if reason == 1 { None } else { Some(later) },
            "reason {reason}"
        );
    }
    // A clear for a thing with no reminder changes nothing.
    let mut log = log_of(&[&clear(1, 1, 1, NINE_NEW_YORK)]);
    assert_eq!(prefs(&mut log).reminders().count(), 0);
}

#[test]
fn device_clocks_and_time_zones_never_order_reminders() {
    // The phone's clock runs a day fast and the laptop's an hour slow; the
    // laptop's later change (logical time 2) still wins, and every device
    // keeps the same absolute instant with the setter's zone beside it.
    let tokyo = NINE_NEW_YORK + 7_200_000;
    let mut log = log_of(&[
        &set(1, 1, NINE_NEW_YORK).stamped(BASE_TIME + 86_400_000),
        &Record::new(
            REMINDER_SET,
            2,
            2,
            set_payload(1, ITEM, tokyo, 540, b"Asia/Tokyo"),
        )
        .from(LAPTOP)
        .stamped(BASE_TIME - 3_600_000),
    ]);
    let state = prefs(&mut log);
    let reminder = state.reminder(&item()).unwrap();
    assert_eq!(reminder.at, tokyo);
    assert_eq!(reminder.utc_offset_minutes, 540);
    assert_eq!(reminder.time_zone, "Asia/Tokyo");
    // A dismissal stamped (by a fast clock) after the move but ordered
    // before it in logical time changes nothing.
    let mut log = log_of(&[
        &set(1, 1, NINE_NEW_YORK),
        &set(2, 3, tokyo).from(LAPTOP).stamped(BASE_TIME),
        &clear(3, 2, 3, tokyo).stamped(BASE_TIME + 86_400_000),
    ]);
    assert_eq!(
        prefs(&mut log)
            .reminder(&item())
            .map(|reminder| reminder.at),
        Some(tokyo)
    );
}

// --- Settings replay ------------------------------------------------------

#[test]
fn settings_are_last_writer_wins_per_key_by_logical_time_then_device() {
    let mut log = log_of(&[
        &setting(1, 1, SETTING_THEME_MODE, b"dark"),
        &setting(2, 2, SETTING_TEXT_SIZE, b"large").from(LAPTOP),
        // The same logical time from both devices: the larger device ID
        // (the laptop, 0x12…) wins on every device, whatever arrives first.
        &setting(3, 3, SETTING_THEME_MODE, b"light").from(LAPTOP),
        &setting(4, 3, SETTING_THEME_MODE, b"system"),
        // An older change to the text size never overrides a newer one.
        &setting(5, 1, SETTING_TEXT_SIZE, b"larger"),
    ]);
    let state = prefs(&mut log);
    assert_eq!(state.setting(SETTING_THEME_MODE).unwrap().value, "light");
    assert_eq!(
        state.setting(SETTING_THEME_MODE).unwrap().device_id,
        DeviceId(LAPTOP)
    );
    assert_eq!(state.setting(SETTING_TEXT_SIZE).unwrap().value, "large");
    // Empty unsets; a key this engine doesn't know is kept as it came.
    let mut log = log_of(&[
        &setting(1, 1, SETTING_MOTION, b"reduce"),
        &setting(2, 2, SETTING_MOTION, b""),
        &setting(3, 3, 42, b"from-a-later-kin"),
    ]);
    let state = prefs(&mut log);
    assert!(state.setting(SETTING_MOTION).is_none());
    assert_eq!(state.setting(42).unwrap().value, "from-a-later-kin");
}

#[test]
fn every_arrival_order_converges_on_the_same_projection() {
    let later = NINE_NEW_YORK + 3_600_000;
    let records = [
        set(1, 1, NINE_NEW_YORK),
        setting(2, 2, SETTING_THEME_MODE, b"dark"),
        set(3, 3, later).from(LAPTOP),
        clear(4, 3, 3, NINE_NEW_YORK),
        setting(5, 4, SETTING_THEME_MODE, b"light").from(LAPTOP),
        setting(6, 4, SETTING_THEME_MODE, b"system"),
        Record::new(
            REMINDER_SET,
            7,
            5,
            set_payload(2, ROUTINE, later, 60, b"Europe/Paris"),
        ),
        Record::new(REMINDER_CLEARED, 8, 6, clear_payload(2, 2, ROUTINE, later)).from(LAPTOP),
    ];
    let mut expected = None;
    // Every rotation and its reverse: devices receive one another's records
    // in different orders.
    for start in 0..records.len() {
        for reverse in [false, true] {
            let mut order: Vec<&Record> = records
                .iter()
                .cycle()
                .skip(start)
                .take(records.len())
                .collect();
            if reverse {
                order.reverse();
            }
            let bytes = kprv(&mut log_of(&order));
            match &expected {
                None => expected = Some(bytes),
                Some(first) => assert_eq!(&bytes, first, "start {start} reverse {reverse}"),
            }
        }
    }
    let mut log = log_of(&records.iter().collect::<Vec<_>>());
    let state = prefs(&mut log);
    assert_eq!(
        state.reminder(&item()).map(|reminder| reminder.at),
        Some(later)
    );
    assert_eq!(
        state.reminders().count(),
        1,
        "the routine's reminder is done"
    );
    assert_eq!(state.setting(SETTING_THEME_MODE).unwrap().value, "light");
}

// --- Commands -------------------------------------------------------------

struct Command {
    kind: u16,
    event: u32,
    logical_time: u64,
    actor: [u8; 16],
    payload: Vec<u8>,
}

impl Command {
    fn packet(&self) -> Vec<u8> {
        let mut kcmd = vec![0u8; 128];
        kcmd[..4].copy_from_slice(b"KCMD");
        kcmd[4..6].copy_from_slice(&1u16.to_le_bytes());
        kcmd[8..10].copy_from_slice(&self.kind.to_le_bytes());
        kcmd[12..28].copy_from_slice(&numbered_id(self.event));
        kcmd[28..44].copy_from_slice(&HOUSEHOLD);
        kcmd[44..60].copy_from_slice(&self.actor);
        kcmd[60..76].copy_from_slice(&PHONE);
        kcmd[76..84].copy_from_slice(&(BASE_TIME + i64::from(self.event)).to_le_bytes());
        kcmd[84..92].copy_from_slice(&self.logical_time.to_le_bytes());
        kcmd[124..128].copy_from_slice(&(self.payload.len() as u32).to_le_bytes());
        kcmd.extend_from_slice(&self.payload);
        let mut input = (kcmd.len() as u32).to_le_bytes().to_vec();
        input.extend_from_slice(&kcmd);
        input.extend_from_slice(&context());
        input
    }
}

fn command(kind: u16, event: u32, logical_time: u64, payload: Vec<u8>) -> Command {
    Command {
        kind,
        event,
        logical_time,
        actor: SAM,
        payload,
    }
}

fn run(log: &mut History, command: &Command) -> Result<Vec<u8>, KinError> {
    let kcmt = execute_private_history(&command.packet(), log)?;
    assert_eq!(&kcmt[..8], b"KCMT\x01\0\0\0");
    let event_length = u32_at(&kcmt, 8) as usize;
    assert_eq!(u32_at(&kcmt, 16), 0, "no projection");
    assert_eq!(kcmt.len(), 20 + event_length + 92);
    Ok(kcmt[20..20 + event_length].to_vec())
}

#[test]
fn commands_make_canonical_events_and_refuse_changes_that_change_nothing() {
    let mut log = History::private();
    let set_nine = command(
        REMINDER_SET,
        1,
        1,
        set_payload(1, ITEM, NINE_NEW_YORK, -240, b"America/New_York"),
    );
    let event = run(&mut log, &set_nine).unwrap();
    assert_eq!(event, set(1, 1, NINE_NEW_YORK).bytes());
    log.append(&batch(&[event])).unwrap();
    // The same reminder again (a retry, or moving a device's reminders in
    // twice) adds nothing.
    let again = command(
        REMINDER_SET,
        2,
        2,
        set_payload(1, ITEM, NINE_NEW_YORK, -240, b"America/New_York"),
    );
    assert_eq!(run(&mut log, &again), Err(KinError::InvalidEvent));
    // Dismissing another instant, or clearing a thing with no reminder.
    let stale = command(
        REMINDER_CLEARED,
        2,
        2,
        clear_payload(1, 3, ITEM, NINE_NEW_YORK + 1),
    );
    assert_eq!(run(&mut log, &stale), Err(KinError::InvalidEvent));
    let none = command(
        REMINDER_CLEARED,
        2,
        2,
        clear_payload(2, 1, ROUTINE, NINE_NEW_YORK),
    );
    assert_eq!(run(&mut log, &none), Err(KinError::InvalidEvent));
    // A logical time that isn't after the log's latest, an event ID it
    // holds, or another member.
    let early = command(
        REMINDER_CLEARED,
        2,
        1,
        clear_payload(1, 3, ITEM, NINE_NEW_YORK),
    );
    assert_eq!(run(&mut log, &early), Err(KinError::InvalidEvent));
    let reused = command(
        REMINDER_CLEARED,
        1,
        2,
        clear_payload(1, 3, ITEM, NINE_NEW_YORK),
    );
    assert_eq!(run(&mut log, &reused), Err(KinError::InvalidEvent));
    let mut alex = command(
        REMINDER_CLEARED,
        2,
        2,
        clear_payload(1, 3, ITEM, NINE_NEW_YORK),
    );
    alex.actor = ALEX;
    assert_eq!(run(&mut log, &alex), Err(KinError::InvalidEvent));
    let dismiss = command(
        REMINDER_CLEARED,
        2,
        2,
        clear_payload(1, 3, ITEM, NINE_NEW_YORK),
    );
    let dismissed = run(&mut log, &dismiss).unwrap();
    log.append(&batch(&[dismissed])).unwrap();
    assert_eq!(prefs(&mut log).reminders().count(), 0);
    // Settings: a new value, then the same value refused; unsetting a key
    // that isn't set is refused too.
    let dark = command(SETTING_SET, 3, 3, setting_payload(1, b"dark"));
    let darkened = run(&mut log, &dark).unwrap();
    log.append(&batch(&[darkened])).unwrap();
    let dark_again = command(SETTING_SET, 4, 4, setting_payload(1, b"dark"));
    assert_eq!(run(&mut log, &dark_again), Err(KinError::InvalidEvent));
    let unset = command(SETTING_SET, 4, 4, setting_payload(3, b""));
    assert_eq!(run(&mut log, &unset), Err(KinError::InvalidEvent));
    // A malformed payload is a protocol error, as when decoding.
    let sepia = command(SETTING_SET, 4, 4, setting_payload(1, b"sepia"));
    assert_eq!(run(&mut log, &sepia), Err(KinError::MalformedProtocol));
}

#[test]
fn private_commands_need_a_private_kind_and_the_private_log() {
    let mut household = History::new();
    let dark = command(SETTING_SET, 1, 1, setting_payload(1, b"dark"));
    assert_eq!(run(&mut household, &dark), Err(KinError::InvalidEvent));
    let mut log = History::private();
    let item = command(1, 1, 1, b"Milk".to_vec());
    assert_eq!(run(&mut log, &item), Err(KinError::UnsupportedVersion));
    // An entity ID, date, option or expiry is malformed for a private
    // command.
    let mut packet = dark.packet();
    packet[4 + 92] = 1;
    assert_eq!(
        execute_private_history(&packet, &mut log).map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
}

// --- KPRV -----------------------------------------------------------------

#[test]
fn kprv_lays_out_reminders_in_section_12_and_settings_in_section_13() {
    let mut log = log_of(&[
        &Record::new(
            REMINDER_SET,
            1,
            1,
            set_payload(2, ROUTINE, BASE_TIME, 60, b"Europe/Paris"),
        ),
        &set(2, 2, NINE_NEW_YORK).from(LAPTOP),
        &setting(3, 3, SETTING_TEXT_SIZE, b"large"),
        &setting(4, 4, SETTING_THEME_MODE, b"dark"),
    ]);
    let bytes = kprv(&mut log);
    assert_eq!(&bytes[..4], b"KPRV");
    assert_eq!(u32_at(&bytes, 24), 4);
    assert_eq!(&bytes[28..32], &[3, 0, 0, 0], "three sections");
    // Section 1: no notes.
    assert_eq!(&bytes[32..36], &[1, 0, 0, 0]);
    assert_eq!(u32_at(&bytes, 36), 4);
    let reminders = 44;
    assert_eq!(&bytes[reminders..reminders + 4], &[12, 0, 0, 0]);
    let length = u32_at(&bytes, reminders + 4) as usize;
    assert_eq!(length, 4 + (56 + 16) + (56 + 12));
    let body = &bytes[reminders + 8..reminders + 8 + length];
    assert_eq!(u32_at(body, 0), 2);
    // Item (kind 1) before routine (kind 2).
    let first = &body[4..4 + 56 + 16];
    assert_eq!(&first[..4], &[1, 0, 0, 0]);
    assert_eq!(&first[4..20], &ITEM);
    assert_eq!(&first[20..28], &NINE_NEW_YORK.to_le_bytes());
    assert_eq!(&first[28..30], &(-240i16).to_le_bytes());
    assert_eq!(&first[30..32], &[16, 0]);
    assert_eq!(&first[32..40], &2u64.to_le_bytes());
    assert_eq!(&first[40..56], &LAPTOP);
    assert_eq!(&first[56..], b"America/New_York");
    let second = &body[4 + 72..];
    assert_eq!(&second[..4], &[2, 0, 0, 0]);
    assert_eq!(&second[56..], b"Europe/Paris");
    let settings = reminders + 8 + length;
    assert_eq!(&bytes[settings..settings + 4], &[13, 0, 0, 0]);
    let length = u32_at(&bytes, settings + 4) as usize;
    let body = &bytes[settings + 8..];
    assert_eq!(body.len(), length);
    assert_eq!(u32_at(body, 0), 2);
    // Key 1 before key 3.
    assert_eq!(&body[4..8], &[1, 0, 4, 0]);
    assert_eq!(&body[8..16], &4u64.to_le_bytes());
    assert_eq!(&body[16..32], &PHONE);
    assert_eq!(&body[32..36], b"dark");
    assert_eq!(&body[36..40], &[3, 0, 5, 0]);
    assert_eq!(&body[64..], b"large");
}
