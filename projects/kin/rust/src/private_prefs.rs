//! Reminders and personal settings that follow a member to every device
//! (#520: #522 reminders, #525 settings), as private records in the
//! member's private log (private.rs, ADR 0019). Kinds 120–129 are
//! reminders and 130–139 settings; the journal and "Just for me" list use
//! other codes of the private range.
//!
//! **Reminders** (`REMINDER_SET` 120, `REMINDER_CLEARED` 121). A reminder is
//! keyed by what it reminds about: a household item or routine
//! (`ReminderTarget`), so a member has at most one reminder per thing and
//! setting it again from any device moves it rather than adding another.
//! That makes the one-time move of a device's own reminders into the log
//! free of duplicates by construction. A reminder stores the absolute
//! instant it is due (Unix milliseconds, UTC) — every device fires at the
//! same moment whatever its time zone — plus the setter's UTC offset and
//! IANA time zone at that instant, so another device can say "9:00 where it
//! was set" when its own zone differs. Device clocks never order records:
//! the private log's replay order does (logical time, then device ID, then
//! event ID), so the latest change wins on every device alike.
//!
//! - A set replaces the target's reminder (new instant, offset and zone).
//! - A clear for "canceled" removes the target's reminder whatever its
//!   instant. "Done" and "dismissed" remove it only while it is still set
//!   for the instant they name: a dismissal of 9:00 that reaches a device
//!   after someone moved the reminder to 10:00 leaves 10:00 in place.
//!
//! **Settings** (`SETTING_SET` 130). One record per key: the latest in
//! replay order wins per key — last writer wins, by logical (Lamport) time
//! and then device ID. An empty value unsets the key. Values are short
//! lowercase tokens; the keys this engine knows have fixed vocabularies
//! (`setting_value_allowed`), and a key it doesn't know (a later release
//! added it) keeps any token, so an older engine carries it unchanged.
//!
//! KPRV gains section 12 (reminders) and section 13 (settings); readers skip
//! sections they don't know (private.rs `encode_private`).
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::error::KinError;
use crate::event::{valid_timestamp, DeviceId, EventEnvelope, EventKind};
use crate::wire::{read_i64, read_id, read_u16};

pub const REMINDER_SET: u16 = 120;
pub const REMINDER_CLEARED: u16 = 121;
pub const SETTING_SET: u16 = 130;
/// The codes this module owns: reminders 120–129, settings 130–139.
pub const FIRST_PREFS_KIND: u16 = 120;
pub const LAST_PREFS_KIND: u16 = 139;
/// KPRV sections (private.rs `encode_private`).
pub const SECTION_REMINDERS: u16 = 12;
pub const SECTION_SETTINGS: u16 = 13;
/// Longest IANA time zone name kept with a reminder, in bytes.
pub const MAX_TIME_ZONE_BYTES: usize = 64;
/// The widest UTC offsets in use (UTC−12:00 to UTC+14:00), in minutes.
pub const MIN_UTC_OFFSET_MINUTES: i16 = -720;
pub const MAX_UTC_OFFSET_MINUTES: i16 = 840;
/// Setting keys are 1–255; values at most this many bytes.
pub const MAX_SETTING_KEY: u16 = 255;
pub const MAX_SETTING_VALUE_BYTES: usize = 32;

/// The settings this engine knows (#525). Key 7 ("my private things on
/// Today") is reserved: "Just for me" (#510) keeps that setting as its own
/// kind 118, which already follows the member. Key 8 is easy mode (#617,
/// ADR 0021): bigger text and buttons, fewer things on screen.
pub const SETTING_THEME_MODE: u16 = 1;
pub const SETTING_THEME_COLOR: u16 = 2;
pub const SETTING_TEXT_SIZE: u16 = 3;
pub const SETTING_MOTION: u16 = 4;
pub const SETTING_REMINDER_ALERTS: u16 = 5;
pub const SETTING_APP_BADGE: u16 = 6;
pub const SETTING_PRIVATE_ON_TODAY: u16 = 7;
pub const SETTING_EASY_MODE: u16 = 8;

/// Whether a kind code is one of this module's (reminders or settings).
pub const fn is_prefs_code(code: u16) -> bool {
    code >= FIRST_PREFS_KIND && code <= LAST_PREFS_KIND
}

/// What a reminder is about.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ReminderTargetKind {
    Item = 1,
    Routine = 2,
}

/// A household item or routine, by ID (never zero).
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ReminderTarget {
    pub kind: ReminderTargetKind,
    pub id: [u8; 16],
}

/// Why a reminder was cleared.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReminderClearReason {
    /// The member took it off ("Cancel reminder").
    Canceled = 1,
    /// The thing was done (the item completed or archived, the routine
    /// archived).
    Done = 2,
    /// The member dealt with the notification on one of their devices.
    Dismissed = 3,
}

fn target_at(payload: &[u8], kind_at: usize, id_at: usize) -> Result<ReminderTarget, KinError> {
    let kind = match payload.get(kind_at) {
        Some(1) => ReminderTargetKind::Item,
        Some(2) => ReminderTargetKind::Routine,
        _ => return Err(KinError::MalformedProtocol),
    };
    let id = read_id(payload, id_at)?;
    if id == [0; 16] {
        return Err(KinError::MalformedProtocol);
    }
    Ok(ReminderTarget { kind, id })
}

/// An IANA zone name as browsers report it: empty (unknown) or ASCII
/// letters, digits and `/ _ + -`.
fn valid_time_zone(zone: &str) -> bool {
    zone.len() <= MAX_TIME_ZONE_BYTES
        && zone
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'+' | b'-'))
}

fn valid_offset(minutes: i16) -> bool {
    (MIN_UTC_OFFSET_MINUTES..=MAX_UTC_OFFSET_MINUTES).contains(&minutes)
}

/// A setting value's grammar: at most 32 bytes of `a-z`, `0-9` and `-`.
fn valid_token(value: &str) -> bool {
    value.len() <= MAX_SETTING_VALUE_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Whether `value` may be stored for `key`. Empty always may (it unsets the
/// key). A key this engine doesn't know takes any token.
pub fn setting_value_allowed(key: u16, value: &str) -> bool {
    if key == 0 || key > MAX_SETTING_KEY || !valid_token(value) {
        return false;
    }
    if value.is_empty() {
        return true;
    }
    let one_of = |choices: &[&str]| choices.contains(&value);
    match key {
        SETTING_THEME_MODE => one_of(&["household", "system", "light", "dark"]),
        SETTING_THEME_COLOR => {
            one_of(&["household", "default"])
                || ["preset-", "custom-"].iter().any(|prefix| {
                    value.strip_prefix(prefix).is_some_and(|hex| {
                        hex.len() == 6
                            && hex
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    })
                })
        }
        SETTING_TEXT_SIZE => one_of(&["standard", "large", "larger"]),
        SETTING_MOTION => one_of(&["system", "reduce"]),
        SETTING_REMINDER_ALERTS | SETTING_PRIVATE_ON_TODAY | SETTING_EASY_MODE => {
            one_of(&["on", "off"])
        }
        SETTING_APP_BADGE => one_of(&["off", "messages", "messages-and-mine"]),
        _ => true,
    }
}

/// The canonical payloads (docs/EVENTS.md, docs/ABI.md):
///
/// - `REMINDER_SET` (120): target kind u8 (1 item, 2 routine), 3 reserved,
///   target ID [16] (non-zero), due instant i64 (Unix ms), UTC offset i16
///   (minutes, −720 to 840), zone length u8 (0–64), reserved u8, zone
///   (ASCII): 32 + length bytes.
/// - `REMINDER_CLEARED` (121): target kind u8, reason u8 (1 canceled, 2 done,
///   3 dismissed), 2 reserved, target ID [16], instant i64: 28 bytes.
/// - `SETTING_SET` (130): key u16 (1–255), value length u8 (0–32), reserved
///   u8, value (`a-z 0-9 -`): 4 + length bytes.
pub fn encode_payload(kind: &EventKind) -> Result<Vec<u8>, KinError> {
    let mut payload = Vec::new();
    match kind {
        EventKind::ReminderSet {
            target,
            at,
            utc_offset_minutes,
            time_zone,
        } => {
            if target.id == [0; 16]
                || !valid_timestamp(*at)
                || !valid_offset(*utc_offset_minutes)
                || !valid_time_zone(time_zone)
            {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&[target.kind as u8, 0, 0, 0]);
            payload.extend_from_slice(&target.id);
            payload.extend_from_slice(&at.to_le_bytes());
            payload.extend_from_slice(&utc_offset_minutes.to_le_bytes());
            payload.extend_from_slice(&[time_zone.len() as u8, 0]);
            payload.extend_from_slice(time_zone.as_bytes());
        }
        EventKind::ReminderCleared { target, reason, at } => {
            if target.id == [0; 16] || !valid_timestamp(*at) {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&[target.kind as u8, *reason as u8, 0, 0]);
            payload.extend_from_slice(&target.id);
            payload.extend_from_slice(&at.to_le_bytes());
        }
        EventKind::SettingSet { key, value } => {
            if !setting_value_allowed(*key, value) {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&key.to_le_bytes());
            payload.extend_from_slice(&[value.len() as u8, 0]);
            payload.extend_from_slice(value.as_bytes());
        }
        _ => return Err(KinError::InvalidEvent),
    }
    Ok(payload)
}

/// Decodes one of this module's payloads strictly (fixed fields exactly,
/// reserved bytes zero, nothing left over). A code in 120–139 this engine
/// doesn't define is unsupported (a later release added it).
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<EventKind, KinError> {
    match code {
        REMINDER_SET => {
            if payload.len() < 32 || payload[1..4] != [0; 3] || payload[31] != 0 {
                return Err(KinError::MalformedProtocol);
            }
            let target = target_at(payload, 0, 4)?;
            let at = read_i64(payload, 20)?;
            let utc_offset_minutes = read_u16(payload, 28)? as i16;
            let length = usize::from(payload[30]);
            if payload.len() != 32 + length
                || !valid_timestamp(at)
                || !valid_offset(utc_offset_minutes)
            {
                return Err(KinError::MalformedProtocol);
            }
            let time_zone =
                std::str::from_utf8(&payload[32..]).map_err(|_| KinError::MalformedProtocol)?;
            if !valid_time_zone(time_zone) {
                return Err(KinError::MalformedProtocol);
            }
            Ok(EventKind::ReminderSet {
                target,
                at,
                utc_offset_minutes,
                time_zone: time_zone.to_owned(),
            })
        }
        REMINDER_CLEARED => {
            if payload.len() != 28 || payload[2..4] != [0; 2] {
                return Err(KinError::MalformedProtocol);
            }
            let target = target_at(payload, 0, 4)?;
            let reason = match payload[1] {
                1 => ReminderClearReason::Canceled,
                2 => ReminderClearReason::Done,
                3 => ReminderClearReason::Dismissed,
                _ => return Err(KinError::MalformedProtocol),
            };
            let at = read_i64(payload, 20)?;
            if !valid_timestamp(at) {
                return Err(KinError::MalformedProtocol);
            }
            Ok(EventKind::ReminderCleared { target, reason, at })
        }
        SETTING_SET => {
            if payload.len() < 4 || payload[3] != 0 {
                return Err(KinError::MalformedProtocol);
            }
            let key = read_u16(payload, 0)?;
            let length = usize::from(payload[2]);
            if payload.len() != 4 + length {
                return Err(KinError::MalformedProtocol);
            }
            let value =
                std::str::from_utf8(&payload[4..]).map_err(|_| KinError::MalformedProtocol)?;
            if !setting_value_allowed(key, value) {
                return Err(KinError::MalformedProtocol);
            }
            Ok(EventKind::SettingSet {
                key,
                value: value.to_owned(),
            })
        }
        _ => Err(KinError::UnsupportedVersion),
    }
}

/// One reminder as replayed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reminder {
    /// When it is due: Unix milliseconds (UTC).
    pub at: i64,
    /// The setter's UTC offset and IANA zone at `at` (empty when unknown).
    pub utc_offset_minutes: i16,
    pub time_zone: String,
    /// The event that set it.
    pub logical_time: u64,
    pub device_id: DeviceId,
}

/// One setting as replayed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Setting {
    pub value: String,
    pub logical_time: u64,
    pub device_id: DeviceId,
}

/// A member's reminders and settings as replayed.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PrefsState {
    reminders: BTreeMap<ReminderTarget, Reminder>,
    settings: BTreeMap<u16, Setting>,
}

impl PrefsState {
    /// Reminders by target (ascending kind, then ID).
    pub fn reminders(&self) -> impl Iterator<Item = (&ReminderTarget, &Reminder)> {
        self.reminders.iter()
    }

    pub fn reminder(&self, target: &ReminderTarget) -> Option<&Reminder> {
        self.reminders.get(target)
    }

    /// Settings by key (ascending).
    pub fn settings(&self) -> impl Iterator<Item = (&u16, &Setting)> {
        self.settings.iter()
    }

    pub fn setting(&self, key: u16) -> Option<&Setting> {
        self.settings.get(&key)
    }
}

/// Replays one reminder or setting event (private.rs has already checked
/// the author). Never fails on a decoded event of these kinds.
pub fn apply(state: &mut Arc<PrefsState>, event: &EventEnvelope) -> Result<(), KinError> {
    match &event.kind {
        EventKind::ReminderSet {
            target,
            at,
            utc_offset_minutes,
            time_zone,
        } => {
            Arc::make_mut(state).reminders.insert(
                *target,
                Reminder {
                    at: *at,
                    utc_offset_minutes: *utc_offset_minutes,
                    time_zone: time_zone.clone(),
                    logical_time: event.logical_time,
                    device_id: event.device_id,
                },
            );
            Ok(())
        }
        EventKind::ReminderCleared { target, reason, at } => {
            let clears = state.reminders.get(target).is_some_and(|reminder| {
                *reason == ReminderClearReason::Canceled || reminder.at == *at
            });
            if clears {
                Arc::make_mut(state).reminders.remove(target);
            }
            Ok(())
        }
        EventKind::SettingSet { key, value } => {
            let state = Arc::make_mut(state);
            if value.is_empty() {
                state.settings.remove(key);
            } else {
                state.settings.insert(
                    *key,
                    Setting {
                        value: value.clone(),
                        logical_time: event.logical_time,
                        device_id: event.device_id,
                    },
                );
            }
            Ok(())
        }
        _ => Err(KinError::InvalidEvent),
    }
}

/// Command rules (`kin_private_execute`): a change must change something.
/// Setting a reminder exactly as it is, clearing one that isn't set (or a
/// done or dismissed for an instant it is no longer set for), or setting a
/// key to its current value is refused, so a retried or repeated action —
/// and the move of a device's reminders into the log — never adds a record
/// that does nothing.
pub fn check_command(state: &PrefsState, kind: &EventKind) -> Result<(), KinError> {
    let unchanged = match kind {
        EventKind::ReminderSet {
            target,
            at,
            utc_offset_minutes,
            time_zone,
        } => state.reminders.get(target).is_some_and(|reminder| {
            reminder.at == *at
                && reminder.utc_offset_minutes == *utc_offset_minutes
                && reminder.time_zone == *time_zone
        }),
        EventKind::ReminderCleared { target, reason, at } => !state
            .reminders
            .get(target)
            .is_some_and(|reminder| *reason == ReminderClearReason::Canceled || reminder.at == *at),
        EventKind::SettingSet { key, value } => {
            state
                .settings
                .get(key)
                .map_or("", |setting| setting.value.as_str())
                == value
        }
        _ => return Err(KinError::InvalidEvent),
    };
    if unchanged {
        Err(KinError::InvalidEvent)
    } else {
        Ok(())
    }
}

/// KPRV section 12, reminders: count u32, then each in ascending target
/// order: target kind u8, 3 reserved, target ID [16], instant i64, UTC
/// offset i16, zone length u8, reserved u8, logical time u64, device ID
/// [16], zone.
pub fn encode_reminders(state: &PrefsState) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(state.reminders.len() as u32).to_le_bytes());
    for (target, reminder) in &state.reminders {
        out.extend_from_slice(&[target.kind as u8, 0, 0, 0]);
        out.extend_from_slice(&target.id);
        out.extend_from_slice(&reminder.at.to_le_bytes());
        out.extend_from_slice(&reminder.utc_offset_minutes.to_le_bytes());
        out.extend_from_slice(&[reminder.time_zone.len() as u8, 0]);
        out.extend_from_slice(&reminder.logical_time.to_le_bytes());
        out.extend_from_slice(&reminder.device_id.0);
        out.extend_from_slice(reminder.time_zone.as_bytes());
    }
    out
}

/// KPRV section 13, settings: count u32, then each in ascending key order:
/// key u16, value length u8, reserved u8, logical time u64, device ID
/// [16], value.
pub fn encode_settings(state: &PrefsState) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(state.settings.len() as u32).to_le_bytes());
    for (key, setting) in &state.settings {
        out.extend_from_slice(&key.to_le_bytes());
        out.extend_from_slice(&[setting.value.len() as u8, 0]);
        out.extend_from_slice(&setting.logical_time.to_le_bytes());
        out.extend_from_slice(&setting.device_id.0);
        out.extend_from_slice(setting.value.as_bytes());
    }
    out
}
