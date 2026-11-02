//! Store sections for the Shopping list (#411, ADR 0015).
//!
//! **The section list (kind 66, `ShoppingSectionsSet`).** The household's
//! whole ordered list of store sections ("Produce", "Dairy", ...), at most
//! `MAX_SECTIONS`, each a non-zero ID and a name. Each event replaces the
//! previous list: the latest in replay order wins, so a section left out is
//! gone.
//!
//! **An item's section (kind 67, `ItemSectionSet`).** An item ID and a
//! section ID; all zero clears it. The latest event for an item wins.
//!
//! The payloads are strict, like meals and item pictures: a payload decodes
//! only if it re-encodes to the same bytes, so the structure is checked there
//! (at most 30 sections, non-zero and unique IDs, names already trimmed,
//! 1–40 bytes, no control characters; code 2). Replay never fails on a
//! decoded event. Commands enforce the rest (code 4): no two names equal
//! ignoring case, the list or the item's section must change, the item exists
//! and isn't archived, and the section is in the current list.
//!
//! Replay is tolerant: an item whose section is no longer listed (or was
//! never seen) projects as having none. Its event is kept, so if the same
//! section ID is listed again the item shows in it again.
//!
//! Hosts read sections through `kin_shopping_sections` (KSHS), below; they
//! are not part of the KINS projection.
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::error::KinError;
use crate::event::{EventEnvelope, EventKind, ItemId, StoreSectionId};
use crate::meals::{push_text, read_text};
use crate::state::{ItemState, ItemStatus};
use crate::wire::{read_id, read_u16};

pub const SHOPPING_SECTIONS_SET: u16 = 66;
pub const ITEM_SECTION_SET: u16 = 67;

/// At most this many sections in the list.
pub const MAX_SECTIONS: usize = 30;
/// A section name's UTF-8 length, after trimming.
pub const MAX_SECTION_NAME_BYTES: usize = 40;

pub const fn is_sections_code(code: u16) -> bool {
    matches!(code, SHOPPING_SECTIONS_SET | ITEM_SECTION_SET)
}

/// One store section: its stable ID and its name.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoreSection {
    pub section_id: StoreSectionId,
    pub name: String,
}

/// A section name in canonical form: trimmed (Unicode white space, as
/// `str::trim`), 1–40 UTF-8 bytes, no control characters.
pub fn normalize_section_name(name: &str) -> Result<String, KinError> {
    let name = name.trim();
    if name.is_empty() || name.len() > MAX_SECTION_NAME_BYTES || name.chars().any(char::is_control)
    {
        return Err(KinError::InvalidEvent);
    }
    Ok(name.to_owned())
}

/// The household's sections as last set, and every item's section as last
/// set (even one no longer listed). Shared with finalized states.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StoreSectionsState {
    pub sections: Vec<StoreSection>,
    pub item_sections: BTreeMap<ItemId, StoreSectionId>,
}

impl StoreSectionsState {
    fn apply(&mut self, event: &EventEnvelope) {
        match &event.kind {
            EventKind::ShoppingSectionsSet { sections } => self.sections = sections.clone(),
            EventKind::ItemSectionSet {
                item_id,
                section_id: Some(section_id),
            } => {
                self.item_sections.insert(*item_id, *section_id);
            }
            EventKind::ItemSectionSet {
                item_id,
                section_id: None,
            } => {
                self.item_sections.remove(item_id);
            }
            _ => {}
        }
    }

    /// Whether `section_id` is in the current list.
    pub fn is_listed(&self, section_id: StoreSectionId) -> bool {
        self.sections
            .iter()
            .any(|section| section.section_id == section_id)
    }

    /// The section an item shows under: none when it has none or its
    /// section is no longer listed.
    pub fn section_of(&self, item_id: &ItemId) -> Option<StoreSectionId> {
        self.item_sections
            .get(item_id)
            .copied()
            .filter(|id| self.is_listed(*id))
    }

    /// Whether `kind`, authored now, is a change these sections accept.
    pub fn check_command(&self, kind: &EventKind, items: &[ItemState]) -> Result<(), KinError> {
        match kind {
            EventKind::ShoppingSectionsSet { sections } => {
                check_list(sections)?;
                for (index, section) in sections.iter().enumerate() {
                    let key = section.name.to_lowercase();
                    if sections[..index]
                        .iter()
                        .any(|earlier| earlier.name.to_lowercase() == key)
                    {
                        return Err(KinError::InvalidEvent);
                    }
                }
                if *sections == self.sections {
                    return Err(KinError::InvalidEvent);
                }
                Ok(())
            }
            EventKind::ItemSectionSet {
                item_id,
                section_id,
            } => {
                let present = items
                    .iter()
                    .any(|item| item.item_id == *item_id && item.status != ItemStatus::Archived);
                let known = section_id.is_none_or(|id| self.is_listed(id));
                if present && known && self.section_of(item_id) != *section_id {
                    Ok(())
                } else {
                    Err(KinError::InvalidEvent)
                }
            }
            _ => Err(KinError::InvalidEvent),
        }
    }
}

/// Replays one store-sections event into the shared state (copy-on-write).
pub fn apply(
    sections: &mut Arc<StoreSectionsState>,
    event: &EventEnvelope,
) -> Result<(), KinError> {
    if event.actor_id.0 == [0; 16] || event.device_id.0 == [0; 16] {
        return Err(KinError::InvalidEvent);
    }
    Arc::make_mut(sections).apply(event);
    Ok(())
}

/// The list's structure: at most 30, IDs non-zero and unique, names
/// canonical. Code 2: the payload isn't canonical.
fn check_list(sections: &[StoreSection]) -> Result<(), KinError> {
    if sections.len() > MAX_SECTIONS {
        return Err(KinError::MalformedProtocol);
    }
    for (index, section) in sections.iter().enumerate() {
        if section.section_id.0 == [0; 16]
            || sections[..index]
                .iter()
                .any(|earlier| earlier.section_id == section.section_id)
            || normalize_section_name(&section.name).ok().as_deref() != Some(section.name.as_str())
        {
            return Err(KinError::MalformedProtocol);
        }
    }
    Ok(())
}

/// The canonical payloads:
/// - kind 66: count u16, reserved u16, then each section: section ID [16],
///   name (u16 length + UTF-8);
/// - kind 67: item ID [16], section ID [16] (all zero: none). 32 bytes.
pub fn encode_payload(kind: &EventKind) -> Result<Vec<u8>, KinError> {
    match kind {
        EventKind::ShoppingSectionsSet { sections } => {
            check_list(sections)?;
            let mut out =
                Vec::with_capacity(4 + sections.len() * (16 + 2 + MAX_SECTION_NAME_BYTES));
            out.extend_from_slice(&(sections.len() as u16).to_le_bytes());
            out.extend_from_slice(&[0, 0]);
            for section in sections {
                out.extend_from_slice(&section.section_id.0);
                push_text(&mut out, &section.name);
            }
            Ok(out)
        }
        EventKind::ItemSectionSet {
            item_id,
            section_id,
        } => {
            if item_id.0 == [0; 16] || section_id.is_some_and(|id| id.0 == [0; 16]) {
                return Err(KinError::MalformedProtocol);
            }
            let mut out = Vec::with_capacity(32);
            out.extend_from_slice(&item_id.0);
            out.extend_from_slice(&section_id.map_or([0; 16], |id| id.0));
            Ok(out)
        }
        _ => Err(KinError::Internal),
    }
}

/// Decodes a kind-66 or kind-67 payload strictly; the result re-encodes to
/// the same bytes.
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<EventKind, KinError> {
    let kind = match code {
        SHOPPING_SECTIONS_SET => {
            let count = usize::from(read_u16(payload, 0)?);
            if count > MAX_SECTIONS || read_u16(payload, 2)? != 0 {
                return Err(KinError::MalformedProtocol);
            }
            let mut at = 4;
            let mut sections = Vec::with_capacity(count);
            for _ in 0..count {
                let section_id = StoreSectionId(read_id(payload, at)?);
                at += 16;
                let name = read_text(payload, &mut at)?;
                sections.push(StoreSection { section_id, name });
            }
            if at != payload.len() {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ShoppingSectionsSet { sections }
        }
        ITEM_SECTION_SET if payload.len() == 32 => {
            let section = read_id(payload, 16)?;
            EventKind::ItemSectionSet {
                item_id: ItemId(read_id(payload, 0)?),
                section_id: (section != [0; 16]).then_some(StoreSectionId(section)),
            }
        }
        _ => return Err(KinError::MalformedProtocol),
    };
    if encode_payload(&kind)? != payload {
        return Err(KinError::MalformedProtocol);
    }
    Ok(kind)
}

/// KSHS v1, store sections as the host shows them: "KSHS", version u16 = 1,
/// reserved u16, section count u32; each section in the household's order:
/// section ID [16], name (u16 length + UTF-8); then item count u32 and each
/// item that exists, isn't archived and whose section is listed, in item-ID
/// order: item ID [16], section ID [16].
pub fn encode_sections(state: &StoreSectionsState, items: &[ItemState]) -> Vec<u8> {
    let shown: Vec<(&ItemId, &StoreSectionId)> = state
        .item_sections
        .iter()
        .filter(|(item_id, section_id)| {
            state.is_listed(**section_id)
                && items
                    .iter()
                    .any(|item| item.item_id == **item_id && item.status != ItemStatus::Archived)
        })
        .collect();
    let mut out = Vec::with_capacity(
        16 + state.sections.len() * (16 + 2 + MAX_SECTION_NAME_BYTES) + shown.len() * 32,
    );
    out.extend_from_slice(b"KSHS");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&(state.sections.len() as u32).to_le_bytes());
    for section in &state.sections {
        out.extend_from_slice(&section.section_id.0);
        push_text(&mut out, &section.name);
    }
    out.extend_from_slice(&(shown.len() as u32).to_le_bytes());
    for (item_id, section_id) in shown {
        out.extend_from_slice(&item_id.0);
        out.extend_from_slice(&section_id.0);
    }
    out
}
