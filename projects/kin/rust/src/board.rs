//! The family fridge (#317, ADR 0011): one shared board per household.
//!
//! Board events live in their own log (history.rs `Log::Board`), apart from
//! the household history and chat, so drawings never use up the household's
//! event cap and never enter the KINS projection. Hosts read the board
//! through `kin_board_state` (KBRD below).
//!
//! The board is a fixed portrait "door": x 0..=4095, y 0..=5460 (3:4).
//!
//! Replay rules (replay never fails on a decoded board event; commands
//! enforce the rules when an event is created):
//! - A stroke or magnet is added once; a second add with the same ID changes
//!   nothing. An add beyond the visible budget is kept but never shown.
//! - Erasing a stroke and removing a magnet set them hidden; undo and redo set
//!   them back. The latest event in replay order wins. Anyone may erase any
//!   stroke or move any magnet, as on a real fridge.
//! - A move puts a magnet on top (z-order is the replay order of its latest
//!   place or move).
//! - A clear hides everything visible and records what it hid; undoing that
//!   clear shows exactly those again, unless they were hidden since.
//! - Showing something again (undo, redo, undoing a clear) never exceeds the
//!   visible budget: what would exceed it stays hidden.
//! - Events naming a stroke, magnet or clear this log lacks change nothing.
//!   An honest author has always seen what it names, so its event sorts
//!   after it in replay order.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::error::KinError;
use crate::event::{ActorId, BoardId, EventEnvelope, EventKind};
use crate::wire::{read_id, read_u16};

/// Largest x coordinate; the board is 4096 units wide.
pub const MAX_X: u16 = 4095;
/// Largest y coordinate; the board is 5461 units tall (3:4).
pub const MAX_Y: u16 = 5460;
/// Most events the board log holds (as chat's).
pub const MAX_BOARD_EVENT_COUNT: usize = 250_000;
/// Most strokes and magnets shown at once.
pub const MAX_VISIBLE_STROKES: usize = 2_000;
pub const MAX_VISIBLE_MAGNETS: usize = 200;
/// Points per stroke; a single point is a dot.
pub const MAX_STROKE_POINTS: usize = 1_024;
/// Largest stroke payload, so an event always fits one envelope.
pub const MAX_STROKE_PAYLOAD_BYTES: usize = 4_096;
/// Palette colours (indices) and pen widths.
pub const PALETTE_COLOURS: u8 = 8;
pub const PEN_WIDTHS: u8 = 3;
/// Kin-drawn magnets, numbered 1..=KIN_MAGNETS.
pub const KIN_MAGNETS: u8 = 12;
/// A note magnet's text: 1–60 characters on one line.
pub const MAX_NOTE_CHARS: usize = 60;
pub const MAX_NOTE_BYTES: usize = 240;

/// Board event kind codes (codec.rs).
pub const STROKE_ADDED: u16 = 52;
pub const STROKE_HIDDEN: u16 = 53;
pub const MAGNET_PLACED: u16 = 54;
pub const MAGNET_MOVED: u16 = 55;
pub const MAGNET_HIDDEN: u16 = 56;
pub const CLEARED: u16 = 57;
pub const CLEAR_UNDONE: u16 = 58;

/// Whether a kind code is a board kind.
pub const fn is_board_code(code: u16) -> bool {
    code >= STROKE_ADDED && code <= CLEAR_UNDONE
}

/// What a magnet shows.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MagnetContent {
    /// One emoji (chat.rs `check_emoji`).
    Emoji(String),
    /// A Kin-drawn magnet, 1..=KIN_MAGNETS.
    Kin(u8),
    /// A short note, canonical (`normalize_note`).
    Note(String),
}

impl MagnetContent {
    const fn code(&self) -> u8 {
        match self {
            Self::Emoji(_) => 1,
            Self::Kin(_) => 2,
            Self::Note(_) => 3,
        }
    }
}

/// A note magnet's canonical text: trimmed, one line, 1–60 characters, no
/// control characters.
pub fn normalize_note(text: &str) -> Result<String, KinError> {
    let trimmed = text.trim();
    let chars = trimmed.chars().count();
    if chars == 0
        || chars > MAX_NOTE_CHARS
        || trimmed.len() > MAX_NOTE_BYTES
        || trimmed.chars().any(char::is_control)
    {
        return Err(KinError::InvalidEvent);
    }
    Ok(trimmed.to_owned())
}

fn valid_point(x: u16, y: u16) -> bool {
    x <= MAX_X && y <= MAX_Y
}

fn zigzag(value: i32) -> u32 {
    ((value << 1) ^ (value >> 31)) as u32
}

fn unzigzag(value: u32) -> i32 {
    ((value >> 1) as i32) ^ -((value & 1) as i32)
}

fn put_varint(out: &mut Vec<u8>, mut value: u32) {
    while value >= 0x80 {
        out.push((value as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

/// A minimal (canonical) LEB128 varint of at most 3 bytes (deltas are
/// below 2^15 after zigzag, so 3 bytes always suffice).
fn read_varint(bytes: &[u8], at: &mut usize) -> Result<u32, KinError> {
    let mut value = 0u32;
    for index in 0..3 {
        let byte = *bytes.get(*at).ok_or(KinError::MalformedProtocol)?;
        *at += 1;
        value |= u32::from(byte & 0x7f) << (7 * index);
        if byte & 0x80 == 0 {
            if index > 0 && byte == 0 {
                return Err(KinError::MalformedProtocol);
            }
            return Ok(value);
        }
    }
    Err(KinError::MalformedProtocol)
}

fn check_id(id: &BoardId) -> Result<(), KinError> {
    if id.0 == [0; 16] {
        return Err(KinError::MalformedProtocol);
    }
    Ok(())
}

/// The canonical payload of a board event.
pub fn encode_payload(kind: &EventKind) -> Result<Vec<u8>, KinError> {
    let mut payload = Vec::new();
    match kind {
        EventKind::BoardStrokeAdded {
            stroke_id,
            colour,
            width,
            points,
        } => {
            check_id(stroke_id)?;
            if *colour >= PALETTE_COLOURS
                || *width >= PEN_WIDTHS
                || points.is_empty()
                || points.len() > MAX_STROKE_POINTS
                || points.iter().any(|&(x, y)| !valid_point(x, y))
            {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&stroke_id.0);
            payload.push(*colour);
            payload.push(*width);
            payload.extend_from_slice(&(points.len() as u16).to_le_bytes());
            payload.extend_from_slice(&points[0].0.to_le_bytes());
            payload.extend_from_slice(&points[0].1.to_le_bytes());
            for pair in points.windows(2) {
                put_varint(
                    &mut payload,
                    zigzag(i32::from(pair[1].0) - i32::from(pair[0].0)),
                );
                put_varint(
                    &mut payload,
                    zigzag(i32::from(pair[1].1) - i32::from(pair[0].1)),
                );
            }
            if payload.len() > MAX_STROKE_PAYLOAD_BYTES {
                return Err(KinError::SizeLimit);
            }
        }
        EventKind::BoardStrokeHidden { stroke_id, hidden }
        | EventKind::BoardMagnetHidden {
            magnet_id: stroke_id,
            hidden,
        } => {
            check_id(stroke_id)?;
            payload.extend_from_slice(&stroke_id.0);
            payload.push(u8::from(*hidden));
            payload.extend_from_slice(&[0; 7]);
        }
        EventKind::BoardMagnetPlaced {
            magnet_id,
            x,
            y,
            content,
        } => {
            check_id(magnet_id)?;
            if !valid_point(*x, *y) {
                return Err(KinError::MalformedProtocol);
            }
            let (number, text): (u8, &str) = match content {
                MagnetContent::Emoji(emoji) => {
                    crate::chat::check_emoji(emoji).map_err(|_| KinError::MalformedProtocol)?;
                    (0, emoji)
                }
                MagnetContent::Kin(number) => {
                    if !(1..=KIN_MAGNETS).contains(number) {
                        return Err(KinError::MalformedProtocol);
                    }
                    (*number, "")
                }
                MagnetContent::Note(text) => {
                    if normalize_note(text).ok().as_deref() != Some(text.as_str()) {
                        return Err(KinError::MalformedProtocol);
                    }
                    (0, text)
                }
            };
            payload.extend_from_slice(&magnet_id.0);
            payload.push(content.code());
            payload.push(number);
            payload.extend_from_slice(&x.to_le_bytes());
            payload.extend_from_slice(&y.to_le_bytes());
            payload.extend_from_slice(&(text.len() as u16).to_le_bytes());
            payload.extend_from_slice(text.as_bytes());
        }
        EventKind::BoardMagnetMoved { magnet_id, x, y } => {
            check_id(magnet_id)?;
            if !valid_point(*x, *y) {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&magnet_id.0);
            payload.extend_from_slice(&x.to_le_bytes());
            payload.extend_from_slice(&y.to_le_bytes());
            payload.extend_from_slice(&[0; 4]);
        }
        EventKind::BoardCleared { clear_id } | EventKind::BoardClearUndone { clear_id } => {
            check_id(clear_id)?;
            payload.extend_from_slice(&clear_id.0);
        }
        _ => return Err(KinError::InvalidEvent),
    }
    Ok(payload)
}

/// Decodes a board payload strictly: every reserved byte zero, every value
/// in range, varints minimal, and nothing left over.
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<EventKind, KinError> {
    let id = |offset| -> Result<BoardId, KinError> {
        let id = BoardId(read_id(payload, offset)?);
        check_id(&id)?;
        Ok(id)
    };
    let kind = match code {
        STROKE_ADDED => {
            if payload.len() < 24 || payload.len() > MAX_STROKE_PAYLOAD_BYTES {
                return Err(KinError::MalformedProtocol);
            }
            let stroke_id = id(0)?;
            let (colour, width) = (payload[16], payload[17]);
            let count = usize::from(read_u16(payload, 18)?);
            if colour >= PALETTE_COLOURS
                || width >= PEN_WIDTHS
                || !(1..=MAX_STROKE_POINTS).contains(&count)
            {
                return Err(KinError::MalformedProtocol);
            }
            let mut point = (read_u16(payload, 20)?, read_u16(payload, 22)?);
            if !valid_point(point.0, point.1) {
                return Err(KinError::MalformedProtocol);
            }
            let mut points = Vec::with_capacity(count);
            points.push(point);
            let mut at = 24;
            for _ in 1..count {
                let dx = unzigzag(read_varint(payload, &mut at)?);
                let dy = unzigzag(read_varint(payload, &mut at)?);
                let x = i32::from(point.0) + dx;
                let y = i32::from(point.1) + dy;
                if !(0..=i32::from(MAX_X)).contains(&x) || !(0..=i32::from(MAX_Y)).contains(&y) {
                    return Err(KinError::MalformedProtocol);
                }
                point = (x as u16, y as u16);
                points.push(point);
            }
            if at != payload.len() {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::BoardStrokeAdded {
                stroke_id,
                colour,
                width,
                points,
            }
        }
        STROKE_HIDDEN | MAGNET_HIDDEN => {
            if payload.len() != 24 || payload[16] > 1 || payload[17..24] != [0; 7] {
                return Err(KinError::MalformedProtocol);
            }
            let target = id(0)?;
            let hidden = payload[16] == 1;
            if code == STROKE_HIDDEN {
                EventKind::BoardStrokeHidden {
                    stroke_id: target,
                    hidden,
                }
            } else {
                EventKind::BoardMagnetHidden {
                    magnet_id: target,
                    hidden,
                }
            }
        }
        MAGNET_PLACED => {
            if payload.len() < 24 {
                return Err(KinError::MalformedProtocol);
            }
            let magnet_id = id(0)?;
            let (content_code, number) = (payload[16], payload[17]);
            let (x, y) = (read_u16(payload, 18)?, read_u16(payload, 20)?);
            let length = usize::from(read_u16(payload, 22)?);
            if !valid_point(x, y) || payload.len() != 24 + length {
                return Err(KinError::MalformedProtocol);
            }
            let text =
                std::str::from_utf8(&payload[24..]).map_err(|_| KinError::MalformedProtocol)?;
            let content = match content_code {
                1 if number == 0 && crate::chat::check_emoji(text).is_ok() => {
                    MagnetContent::Emoji(text.to_owned())
                }
                2 if (1..=KIN_MAGNETS).contains(&number) && length == 0 => {
                    MagnetContent::Kin(number)
                }
                3 if number == 0 && normalize_note(text).ok().as_deref() == Some(text) => {
                    MagnetContent::Note(text.to_owned())
                }
                _ => return Err(KinError::MalformedProtocol),
            };
            EventKind::BoardMagnetPlaced {
                magnet_id,
                x,
                y,
                content,
            }
        }
        MAGNET_MOVED => {
            if payload.len() != 24 || payload[20..24] != [0; 4] {
                return Err(KinError::MalformedProtocol);
            }
            let (x, y) = (read_u16(payload, 16)?, read_u16(payload, 18)?);
            if !valid_point(x, y) {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::BoardMagnetMoved {
                magnet_id: id(0)?,
                x,
                y,
            }
        }
        CLEARED | CLEAR_UNDONE => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            let clear_id = id(0)?;
            if code == CLEARED {
                EventKind::BoardCleared { clear_id }
            } else {
                EventKind::BoardClearUndone { clear_id }
            }
        }
        _ => return Err(KinError::MalformedProtocol),
    };
    Ok(kind)
}

/// A stroke as replayed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoardStroke {
    pub id: BoardId,
    pub author: ActorId,
    pub colour: u8,
    pub width: u8,
    pub points: Arc<[(u16, u16)]>,
    hidden: bool,
    cleared_by: Option<BoardId>,
    /// Added beyond the visible budget: kept, never shown.
    refused: bool,
}

/// A magnet as replayed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoardMagnet {
    pub id: BoardId,
    pub author: ActorId,
    pub content: MagnetContent,
    pub x: u16,
    pub y: u16,
    /// Stacking order: greater is on top.
    pub z: u64,
    hidden: bool,
    cleared_by: Option<BoardId>,
    refused: bool,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum Target {
    Stroke(usize),
    Magnet(usize),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ClearRecord {
    items: Vec<Target>,
    undone: bool,
}

/// The board as replayed. Strokes keep the order they were first added in
/// (their drawing order); magnets carry their own stacking order.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BoardState {
    strokes: Vec<BoardStroke>,
    stroke_index: BTreeMap<BoardId, usize>,
    magnets: Vec<BoardMagnet>,
    magnet_index: BTreeMap<BoardId, usize>,
    clears: BTreeMap<BoardId, ClearRecord>,
    /// The clears in replay order, for "the latest clear still in effect".
    clear_order: Vec<BoardId>,
    visible_strokes: BTreeSet<usize>,
    visible_magnets: BTreeSet<usize>,
    next_z: u64,
}

impl BoardStroke {
    fn shown(&self) -> bool {
        !self.hidden && self.cleared_by.is_none() && !self.refused
    }
}

impl BoardMagnet {
    fn shown(&self) -> bool {
        !self.hidden && self.cleared_by.is_none() && !self.refused
    }
}

impl BoardState {
    pub fn visible_stroke_count(&self) -> usize {
        self.visible_strokes.len()
    }

    pub fn visible_magnet_count(&self) -> usize {
        self.visible_magnets.len()
    }

    /// Visible strokes in drawing order.
    pub fn visible_strokes(&self) -> impl Iterator<Item = &BoardStroke> {
        self.visible_strokes
            .iter()
            .map(|&index| &self.strokes[index])
    }

    /// Visible magnets from the bottom of the stack to the top.
    pub fn visible_magnets(&self) -> Vec<&BoardMagnet> {
        let mut magnets: Vec<&BoardMagnet> = self
            .visible_magnets
            .iter()
            .map(|&index| &self.magnets[index])
            .collect();
        magnets.sort_by_key(|magnet| magnet.z);
        magnets
    }

    pub fn stroke(&self, id: &BoardId) -> Option<&BoardStroke> {
        self.stroke_index.get(id).map(|&index| &self.strokes[index])
    }

    pub fn magnet(&self, id: &BoardId) -> Option<&BoardMagnet> {
        self.magnet_index.get(id).map(|&index| &self.magnets[index])
    }

    /// Whether a stroke is shown now.
    pub fn stroke_shown(&self, id: &BoardId) -> bool {
        self.stroke(id).is_some_and(BoardStroke::shown)
    }

    pub fn magnet_shown(&self, id: &BoardId) -> bool {
        self.magnet(id).is_some_and(BoardMagnet::shown)
    }

    /// The latest clear in replay order that is not undone, if any.
    pub fn open_clear(&self) -> Option<BoardId> {
        self.clear_order
            .iter()
            .rev()
            .find(|id| self.clears.get(id).is_some_and(|clear| !clear.undone))
            .copied()
    }

    fn refresh(&mut self, target: Target) {
        match target {
            Target::Stroke(index) => {
                if self.strokes[index].shown() {
                    self.visible_strokes.insert(index);
                } else {
                    self.visible_strokes.remove(&index);
                }
            }
            Target::Magnet(index) => {
                if self.magnets[index].shown() {
                    self.visible_magnets.insert(index);
                } else {
                    self.visible_magnets.remove(&index);
                }
            }
        }
    }

    /// Whether showing `target` again would stay within the budget.
    fn room_for(&self, target: Target) -> bool {
        match target {
            Target::Stroke(_) => self.visible_strokes.len() < MAX_VISIBLE_STROKES,
            Target::Magnet(_) => self.visible_magnets.len() < MAX_VISIBLE_MAGNETS,
        }
    }

    fn apply(&mut self, event: &EventEnvelope) {
        match &event.kind {
            EventKind::BoardStrokeAdded {
                stroke_id,
                colour,
                width,
                points,
            } => {
                if self.stroke_index.contains_key(stroke_id) {
                    return;
                }
                let index = self.strokes.len();
                let refused = self.visible_strokes.len() >= MAX_VISIBLE_STROKES;
                self.strokes.push(BoardStroke {
                    id: *stroke_id,
                    author: event.actor_id,
                    colour: *colour,
                    width: *width,
                    points: Arc::from(points.as_slice()),
                    hidden: false,
                    cleared_by: None,
                    refused,
                });
                self.stroke_index.insert(*stroke_id, index);
                self.refresh(Target::Stroke(index));
            }
            EventKind::BoardStrokeHidden { stroke_id, hidden } => {
                let Some(&index) = self.stroke_index.get(stroke_id) else {
                    return;
                };
                let target = Target::Stroke(index);
                let stroke = &self.strokes[index];
                if !*hidden
                    && stroke.hidden
                    && stroke.cleared_by.is_none()
                    && !stroke.refused
                    && !self.room_for(target)
                {
                    return;
                }
                self.strokes[index].hidden = *hidden;
                self.refresh(target);
            }
            EventKind::BoardMagnetPlaced {
                magnet_id,
                x,
                y,
                content,
            } => {
                if self.magnet_index.contains_key(magnet_id) {
                    return;
                }
                let index = self.magnets.len();
                let refused = self.visible_magnets.len() >= MAX_VISIBLE_MAGNETS;
                self.next_z += 1;
                self.magnets.push(BoardMagnet {
                    id: *magnet_id,
                    author: event.actor_id,
                    content: content.clone(),
                    x: *x,
                    y: *y,
                    z: self.next_z,
                    hidden: false,
                    cleared_by: None,
                    refused,
                });
                self.magnet_index.insert(*magnet_id, index);
                self.refresh(Target::Magnet(index));
            }
            EventKind::BoardMagnetMoved { magnet_id, x, y } => {
                let Some(&index) = self.magnet_index.get(magnet_id) else {
                    return;
                };
                self.next_z += 1;
                let magnet = &mut self.magnets[index];
                magnet.x = *x;
                magnet.y = *y;
                magnet.z = self.next_z;
            }
            EventKind::BoardMagnetHidden { magnet_id, hidden } => {
                let Some(&index) = self.magnet_index.get(magnet_id) else {
                    return;
                };
                let target = Target::Magnet(index);
                let magnet = &self.magnets[index];
                if !*hidden
                    && magnet.hidden
                    && magnet.cleared_by.is_none()
                    && !magnet.refused
                    && !self.room_for(target)
                {
                    return;
                }
                self.magnets[index].hidden = *hidden;
                self.refresh(target);
            }
            EventKind::BoardCleared { clear_id } => {
                if self.clears.contains_key(clear_id) {
                    return;
                }
                let mut items: Vec<Target> = self
                    .visible_strokes
                    .iter()
                    .map(|&index| Target::Stroke(index))
                    .collect();
                items.extend(
                    self.visible_magnets
                        .iter()
                        .map(|&index| Target::Magnet(index)),
                );
                for &target in &items {
                    match target {
                        Target::Stroke(index) => self.strokes[index].cleared_by = Some(*clear_id),
                        Target::Magnet(index) => self.magnets[index].cleared_by = Some(*clear_id),
                    }
                    self.refresh(target);
                }
                self.clears.insert(
                    *clear_id,
                    ClearRecord {
                        items,
                        undone: false,
                    },
                );
                self.clear_order.push(*clear_id);
            }
            EventKind::BoardClearUndone { clear_id } => {
                let Some(record) = self.clears.get_mut(clear_id) else {
                    return;
                };
                if record.undone {
                    return;
                }
                record.undone = true;
                let items = record.items.clone();
                for target in items {
                    let cleared_here = match target {
                        Target::Stroke(index) => self.strokes[index].cleared_by == Some(*clear_id),
                        Target::Magnet(index) => self.magnets[index].cleared_by == Some(*clear_id),
                    };
                    // What would exceed the budget stays cleared.
                    if !cleared_here || !self.room_for(target) {
                        continue;
                    }
                    match target {
                        Target::Stroke(index) => self.strokes[index].cleared_by = None,
                        Target::Magnet(index) => self.magnets[index].cleared_by = None,
                    }
                    self.refresh(target);
                }
            }
            _ => {}
        }
    }

    /// Whether `kind`, authored now, is a change this board accepts. Replay
    /// accepts anything decoded; this is the rule for new events.
    pub fn check_command(&self, kind: &EventKind) -> Result<(), KinError> {
        let ok = match kind {
            EventKind::BoardStrokeAdded { stroke_id, .. } => {
                !self.stroke_index.contains_key(stroke_id)
                    && self.visible_strokes.len() < MAX_VISIBLE_STROKES
            }
            EventKind::BoardStrokeHidden { stroke_id, hidden } => {
                self.stroke(stroke_id).is_some_and(|stroke| {
                    stroke.hidden != *hidden
                        && stroke.cleared_by.is_none()
                        && !stroke.refused
                        && (*hidden || self.visible_strokes.len() < MAX_VISIBLE_STROKES)
                })
            }
            EventKind::BoardMagnetPlaced { magnet_id, .. } => {
                !self.magnet_index.contains_key(magnet_id)
                    && self.visible_magnets.len() < MAX_VISIBLE_MAGNETS
            }
            EventKind::BoardMagnetMoved { magnet_id, x, y } => self
                .magnet(magnet_id)
                .is_some_and(|magnet| magnet.shown() && (magnet.x, magnet.y) != (*x, *y)),
            EventKind::BoardMagnetHidden { magnet_id, hidden } => {
                self.magnet(magnet_id).is_some_and(|magnet| {
                    magnet.hidden != *hidden
                        && magnet.cleared_by.is_none()
                        && !magnet.refused
                        && (*hidden || self.visible_magnets.len() < MAX_VISIBLE_MAGNETS)
                })
            }
            EventKind::BoardCleared { clear_id } => {
                !self.clears.contains_key(clear_id)
                    && (!self.visible_strokes.is_empty() || !self.visible_magnets.is_empty())
            }
            EventKind::BoardClearUndone { clear_id } => {
                self.clears.get(clear_id).is_some_and(|clear| !clear.undone)
            }
            _ => false,
        };
        if ok {
            Ok(())
        } else {
            Err(KinError::InvalidEvent)
        }
    }
}

/// Replays one board event into the shared state (copy-on-write).
pub fn apply(board: &mut Arc<BoardState>, event: &EventEnvelope) -> Result<(), KinError> {
    if event.actor_id.0 == [0; 16] || event.device_id.0 == [0; 16] {
        return Err(KinError::InvalidEvent);
    }
    Arc::make_mut(board).apply(event);
    Ok(())
}

/// KBRD v1, the board as the host draws it:
/// "KBRD", version u16 = 1, reserved u16; visible stroke count u32, visible
/// magnet count u32; open clear flag u8 + 3 reserved, open clear ID [16]
/// (zero when none); then each visible stroke in drawing order: ID [16],
/// author [16], colour u8, width u8, point count u16, points (x u16, y u16);
/// then each visible magnet bottom to top: ID [16], author [16], content
/// kind u8 (1 emoji, 2 Kin, 3 note), Kin number u8, x u16, y u16, text
/// length u16, text.
pub fn encode_board(board: &BoardState) -> Result<Vec<u8>, KinError> {
    let magnets = board.visible_magnets();
    let mut size = 36usize;
    for stroke in board.visible_strokes() {
        size = size
            .checked_add(36 + stroke.points.len() * 4)
            .ok_or(KinError::SizeLimit)?;
    }
    for magnet in &magnets {
        let text = match &magnet.content {
            MagnetContent::Emoji(text) | MagnetContent::Note(text) => text.len(),
            MagnetContent::Kin(_) => 0,
        };
        size = size.checked_add(40 + text).ok_or(KinError::SizeLimit)?;
    }
    if size > crate::wire::MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let mut out = Vec::new();
    out.try_reserve_exact(size)
        .map_err(|_| KinError::SizeLimit)?;
    out.extend_from_slice(b"KBRD");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0; 2]);
    out.extend_from_slice(&(board.visible_stroke_count() as u32).to_le_bytes());
    out.extend_from_slice(&(magnets.len() as u32).to_le_bytes());
    match board.open_clear() {
        Some(id) => {
            out.extend_from_slice(&[1, 0, 0, 0]);
            out.extend_from_slice(&id.0);
        }
        None => {
            out.extend_from_slice(&[0; 4]);
            out.extend_from_slice(&[0; 16]);
        }
    }
    for stroke in board.visible_strokes() {
        out.extend_from_slice(&stroke.id.0);
        out.extend_from_slice(&stroke.author.0);
        out.push(stroke.colour);
        out.push(stroke.width);
        out.extend_from_slice(&(stroke.points.len() as u16).to_le_bytes());
        for &(x, y) in stroke.points.iter() {
            out.extend_from_slice(&x.to_le_bytes());
            out.extend_from_slice(&y.to_le_bytes());
        }
    }
    for magnet in magnets {
        out.extend_from_slice(&magnet.id.0);
        out.extend_from_slice(&magnet.author.0);
        let (number, text) = match &magnet.content {
            MagnetContent::Emoji(text) | MagnetContent::Note(text) => (0, text.as_str()),
            MagnetContent::Kin(number) => (*number, ""),
        };
        out.push(magnet.content.code());
        out.push(number);
        out.extend_from_slice(&magnet.x.to_le_bytes());
        out.extend_from_slice(&magnet.y.to_le_bytes());
        out.extend_from_slice(&(text.len() as u16).to_le_bytes());
        out.extend_from_slice(text.as_bytes());
    }
    Ok(out)
}
