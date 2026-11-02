//! Simple view (#344, ADR 0013): an item's picture emoji and a member's
//! "my things today".
//!
//! **Item emoji (kind 64, `ItemEmojiSet`).** An Adult gives an item one emoji
//! (validated like a chat reaction, `chat::check_emoji`) or clears it. Like
//! Meals, replay never fails on a decoded emoji event; commands enforce the
//! rules: the item exists and isn't archived, and the value changes. The
//! latest event for an item wins. An emoji on an item that is archived or
//! missing is kept but never reported.
//!
//! **My things today** is per member, from the household state at a civil
//! date: active, non-Staple items assigned to the member (responsibility kind
//! 41, target Item) whose planning date is that day or earlier, or that have
//! none; then routines assigned to the member with an occurrence open that
//! day (none while the household mode pauses routines), done or not. Items
//! come soonest-planned first (undated last), then by text; routines by
//! text. Nothing is counted.
//!
//! Hosts read emoji through `kin_item_emojis` (KIEM) and a member's things
//! through `kin_my_things` (KMTQ -> KMTD), both below.
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::error::KinError;
use crate::event::{
    ActorId, EventEnvelope, EventKind, HouseholdMode, ItemClassification, ItemId,
    ResponsibilityTargetKind,
};
use crate::meals::{push_text, read_text};
use crate::recurrence::CivilDate;
use crate::state::{HouseholdState, ItemState, ItemStatus};
use crate::wire::read_id;

pub const ITEM_EMOJI_SET: u16 = 64;

pub const fn is_simple_code(code: u16) -> bool {
    code == ITEM_EMOJI_SET
}

/// Every item's emoji as last set. Shared with finalized states.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PicturesState {
    pub emojis: BTreeMap<ItemId, String>,
}

impl PicturesState {
    fn apply(&mut self, event: &EventEnvelope) {
        if let EventKind::ItemEmojiSet { item_id, emoji } = &event.kind {
            match emoji {
                Some(emoji) => {
                    self.emojis.insert(*item_id, emoji.clone());
                }
                None => {
                    self.emojis.remove(item_id);
                }
            }
        }
    }

    /// The emoji an item shows, if it has one.
    pub fn emoji(&self, item_id: &ItemId) -> Option<&str> {
        self.emojis.get(item_id).map(String::as_str)
    }

    /// Whether `kind`, authored now, is a change these pictures accept.
    pub fn check_command(&self, kind: &EventKind, items: &[ItemState]) -> Result<(), KinError> {
        let EventKind::ItemEmojiSet { item_id, emoji } = kind else {
            return Err(KinError::InvalidEvent);
        };
        if let Some(emoji) = emoji {
            crate::chat::check_emoji(emoji)?;
        }
        let present = items
            .iter()
            .any(|item| item.item_id == *item_id && item.status != ItemStatus::Archived);
        if present && self.emoji(item_id) != emoji.as_deref() {
            Ok(())
        } else {
            Err(KinError::InvalidEvent)
        }
    }
}

/// Replays one emoji event into the shared state (copy-on-write).
pub fn apply(pictures: &mut Arc<PicturesState>, event: &EventEnvelope) -> Result<(), KinError> {
    if event.actor_id.0 == [0; 16] || event.device_id.0 == [0; 16] {
        return Err(KinError::InvalidEvent);
    }
    Arc::make_mut(pictures).apply(event);
    Ok(())
}

/// The canonical payload: item ID [16], a flag word (1 or 0, then three zero
/// bytes) and, when set, the emoji (u16 length + UTF-8).
pub fn encode_payload(kind: &EventKind) -> Result<Vec<u8>, KinError> {
    let EventKind::ItemEmojiSet { item_id, emoji } = kind else {
        return Err(KinError::Internal);
    };
    if item_id.0 == [0; 16] {
        return Err(KinError::MalformedProtocol);
    }
    let mut out = Vec::with_capacity(16 + 4 + 2 + 32);
    out.extend_from_slice(&item_id.0);
    match emoji {
        Some(emoji) => {
            crate::chat::check_emoji(emoji).map_err(|_| KinError::MalformedProtocol)?;
            out.extend_from_slice(&[1, 0, 0, 0]);
            push_text(&mut out, emoji);
        }
        None => out.extend_from_slice(&[0, 0, 0, 0]),
    }
    Ok(out)
}

/// Decodes a kind-64 payload strictly; the result re-encodes to the same
/// bytes.
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<EventKind, KinError> {
    if code != ITEM_EMOJI_SET || payload.len() < 20 {
        return Err(KinError::MalformedProtocol);
    }
    let item_id = ItemId(read_id(payload, 0)?);
    let flag = &payload[16..20];
    if flag[1..] != [0, 0, 0] {
        return Err(KinError::MalformedProtocol);
    }
    let mut at = 20;
    let emoji = match flag[0] {
        0 => None,
        1 => Some(read_text(payload, &mut at)?),
        _ => return Err(KinError::MalformedProtocol),
    };
    if at != payload.len() {
        return Err(KinError::MalformedProtocol);
    }
    let kind = EventKind::ItemEmojiSet { item_id, emoji };
    if encode_payload(&kind)? != payload {
        return Err(KinError::MalformedProtocol);
    }
    Ok(kind)
}

/// KIEM v1, item emoji as the host shows them: "KIEM", version u16 = 1,
/// reserved u16, count u32; then each item that exists and isn't archived,
/// in ID order: item ID [16], emoji (u16 length + UTF-8).
pub fn encode_emojis(pictures: &PicturesState, items: &[ItemState]) -> Vec<u8> {
    let shown: Vec<(&ItemId, &String)> = pictures
        .emojis
        .iter()
        .filter(|(id, _)| {
            items
                .iter()
                .any(|item| item.item_id == **id && item.status != ItemStatus::Archived)
        })
        .collect();
    let mut out = Vec::with_capacity(12 + shown.len() * 24);
    out.extend_from_slice(b"KIEM");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&(shown.len() as u32).to_le_bytes());
    for (id, emoji) in shown {
        out.extend_from_slice(&id.0);
        push_text(&mut out, emoji);
    }
    out
}

/// One entry of a member's things today.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MyThing {
    Item(ItemId),
    /// A routine with the occurrence open on the day, and whether it's done.
    Routine {
        routine_id: [u8; 16],
        occurrence: CivilDate,
        done: bool,
    },
}

/// The member assigned to a target, by the latest responsibility event.
fn assigned_to(
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

/// `member`'s things on `today`, as described above.
pub fn my_things(state: &HouseholdState, member: ActorId, today: CivilDate) -> Vec<MyThing> {
    let mut items: Vec<&ItemState> = state
        .items
        .iter()
        .filter(|item| {
            item.status == ItemStatus::Active
                && item.classification != ItemClassification::Staple
                && item.planning_date.is_none_or(|date| date <= today)
                && assigned_to(state, ResponsibilityTargetKind::Item, item.item_id.0)
                    == Some(member)
        })
        .collect();
    items.sort_by(|left, right| {
        let key = |item: &ItemState| item.planning_date.map_or(u32::MAX, CivilDate::encoded);
        key(left)
            .cmp(&key(right))
            .then_with(|| left.text.cmp(&right.text))
            .then_with(|| left.item_id.cmp(&right.item_id))
    });
    let mut things: Vec<MyThing> = items
        .into_iter()
        .map(|item| MyThing::Item(item.item_id))
        .collect();
    if state.mode == HouseholdMode::Normal {
        let mut routines: Vec<_> = state
            .routines
            .iter()
            .filter(|routine| {
                !routine.archived
                    && routine.occurrence_key.is_some()
                    && assigned_to(
                        state,
                        ResponsibilityTargetKind::Routine,
                        routine.routine_id.0,
                    ) == Some(member)
            })
            .collect();
        routines.sort_by(|left, right| {
            left.text
                .cmp(&right.text)
                .then_with(|| left.routine_id.cmp(&right.routine_id))
        });
        things.extend(routines.into_iter().filter_map(|routine| {
            Some(MyThing::Routine {
                routine_id: routine.routine_id.0,
                occurrence: routine.occurrence_key?,
                done: routine.completed,
            })
        }));
    }
    things
}

/// KMTD v1, a member's things today: "KMTD", version u16 = 1, reserved u16,
/// count u32; then each thing: kind u8 (1 item, 2 routine), done u8 (0 or
/// 1; always 0 for an item), reserved u16, ID [16], occurrence date u32
/// (YYYYMMDD; 0 for an item). 28 bytes each.
pub fn encode_my_things(things: &[MyThing]) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + things.len() * 28);
    out.extend_from_slice(b"KMTD");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&(things.len() as u32).to_le_bytes());
    for thing in things {
        match thing {
            MyThing::Item(id) => {
                out.extend_from_slice(&[1, 0, 0, 0]);
                out.extend_from_slice(&id.0);
                out.extend_from_slice(&0u32.to_le_bytes());
            }
            MyThing::Routine {
                routine_id,
                occurrence,
                done,
            } => {
                out.extend_from_slice(&[2, u8::from(*done), 0, 0]);
                out.extend_from_slice(routine_id);
                out.extend_from_slice(&occurrence.encoded().to_le_bytes());
            }
        }
    }
    out
}

/// KMTQ v1, the query: "KMTQ", version u16 = 1, reserved u16, member ID
/// [16]; 24 bytes, then the record-less KINE context. The member ID is never
/// zero.
pub fn decode_query(input: &[u8]) -> Result<(ActorId, &[u8]), KinError> {
    let query = input.get(..24).ok_or(KinError::MalformedProtocol)?;
    if &query[..4] != b"KMTQ" || query[6..8] != [0, 0] {
        return Err(KinError::MalformedProtocol);
    }
    if u16::from_le_bytes([query[4], query[5]]) != 1 {
        return Err(KinError::UnsupportedVersion);
    }
    let member = read_id(query, 8)?;
    if member == [0; 16] {
        return Err(KinError::MalformedProtocol);
    }
    Ok((ActorId(member), &input[24..]))
}
