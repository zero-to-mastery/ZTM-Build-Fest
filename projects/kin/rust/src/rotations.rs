//! Taking turns on routines (#429, ADR 0016).
//!
//! **A rotation (kind 68, `RoutineRotationSet`).** A routine ID, an ordered
//! list of 2–`MAX_ROTATION_MEMBERS` distinct, non-zero member IDs and the
//! index whose turn it is now. Each event replaces the routine's previous
//! rotation; an empty list ends it.
//!
//! **A turn (kind 69, `RoutineTurnSet`).** A routine ID and a member ID: "it's
//! this person's turn now" (Skip to next, Swap with...). A turn naming a
//! member the rotation no longer lists, or a routine with no rotation, is a
//! recorded no-op in replay (it raced with a new list); commands refuse it.
//!
//! **The turn passes when it's done.** Replay hooks into routine occurrences
//! (replay/routines.rs): when `ROUTINE_OCCURRENCE_COMPLETED` newly completes
//! an occurrence of a rotating routine, the turn moves to the next member in
//! the list and the occurrence key is recorded. A duplicate completion of an
//! occurrence that is already complete (two devices offline) changes
//! nothing, so the turn moves once. `ROUTINE_OCCURRENCE_REOPENED` of the
//! occurrence that moved the turn (Undo) moves it back one and forgets the
//! key; reopening any other occurrence changes nothing. Setting a rotation or
//! a turn forgets the key too, so an Undo after a manual change keeps the
//! manual change.
//!
//! **Owner.** The rotation drives the routine's ordinary responsibility:
//! whenever the turn changes, replay sets the routine's responsibility entry
//! to the current member, so the KINS responsibilities section, This week and
//! `kin_my_things` all show the current member as the owner without any
//! layout change. Ending the rotation simply stops driving it: the last
//! current member stays the owner as an ordinary responsibility, and no extra
//! event is written. While a rotation is set, a `RESPONSIBILITY_CHANGED` for
//! the routine is a recorded no-op in replay and refused as a command (code 4).
//!
//! **Members who are not active.** Membership (removed members, expired
//! temporary members) lives with the service, not in the household history,
//! so Rust cannot know it and treats every listed member as taking turns.
//! The host passes over inactive members when it shows the turn
//! (`turnAmong` in web/wasm/kin-rotations.js; fewer than two active means no
//! current turn) and, when the current member is not active, writes a
//! `ROUTINE_TURN_SET` to the next active member, just as it clears a removed
//! member's responsibilities today. That keeps every device's history, and so
//! every device's owner, the same.
//!
//! Nothing is counted: no per-member totals exist, only the list, the current
//! index and the one occurrence key that can undo the last pass.
//!
//! Hosts read rotations through `kin_routine_rotations` (KRRS), below; they
//! are not part of the KINS projection.
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::error::KinError;
use crate::event::{ActorId, EventKind, RoutineId};
use crate::recurrence::CivilDate;
use crate::state::RoutineState;
use crate::wire::{read_id, read_u16};

pub const ROUTINE_ROTATION_SET: u16 = 68;
pub const ROUTINE_TURN_SET: u16 = 69;

/// Fewest members a rotation lists (an empty list ends it).
pub const MIN_ROTATION_MEMBERS: usize = 2;
/// Most members a rotation lists.
pub const MAX_ROTATION_MEMBERS: usize = 12;

pub const fn is_rotation_code(code: u16) -> bool {
    matches!(code, ROUTINE_ROTATION_SET | ROUTINE_TURN_SET)
}

/// One routine's rotation as replayed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rotation {
    /// 2–12 distinct members in turn order.
    pub members: Vec<ActorId>,
    /// Index into `members` whose turn it is.
    pub current: usize,
    /// The occurrence whose completion last moved the turn, while an Undo
    /// (reopening it) can still move it back.
    pub advanced_by: Option<CivilDate>,
}

impl Rotation {
    /// The member whose turn it is.
    pub fn current_member(&self) -> ActorId {
        self.members[self.current]
    }

    /// The index after `current`, wrapping.
    pub fn next_index(&self) -> usize {
        (self.current + 1) % self.members.len()
    }

    /// The member after the current one in the list.
    pub fn next_member(&self) -> ActorId {
        self.members[self.next_index()]
    }
}

/// Every routine's rotation. Shared with finalized states.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RotationsState {
    pub rotations: BTreeMap<RoutineId, Rotation>,
}

impl RotationsState {
    /// The routine's rotation, if it has one.
    pub fn rotation(&self, routine_id: &RoutineId) -> Option<&Rotation> {
        self.rotations.get(routine_id)
    }

    /// Whether the routine is rotating.
    pub fn is_rotating(&self, routine_id: &RoutineId) -> bool {
        self.rotations.contains_key(routine_id)
    }

    /// Whether `kind`, authored now, is a change these rotations accept for
    /// a routine that exists and isn't archived. Anyone who may edit routines
    /// may change a rotation; as for owners, the engine has no further role
    /// rule.
    pub fn check_command(
        &self,
        kind: &EventKind,
        routines: &[RoutineState],
    ) -> Result<(), KinError> {
        let routine_id = match kind {
            EventKind::RoutineRotationSet { routine_id, .. }
            | EventKind::RoutineTurnSet { routine_id, .. } => routine_id,
            _ => return Err(KinError::InvalidEvent),
        };
        if !routines
            .iter()
            .any(|routine| routine.routine_id == *routine_id && !routine.archived)
        {
            return Err(KinError::InvalidEvent);
        }
        let existing = self.rotation(routine_id);
        match kind {
            EventKind::RoutineRotationSet {
                members, current, ..
            } => {
                check_list(members, *current)?;
                let unchanged = if members.is_empty() {
                    existing.is_none()
                } else {
                    existing.is_some_and(|rotation| {
                        rotation.members == *members && rotation.current == usize::from(*current)
                    })
                };
                if unchanged {
                    return Err(KinError::InvalidEvent);
                }
                Ok(())
            }
            EventKind::RoutineTurnSet { member_id, .. } => match existing {
                Some(rotation)
                    if rotation.members.contains(member_id)
                        && rotation.current_member() != *member_id =>
                {
                    Ok(())
                }
                _ => Err(KinError::InvalidEvent),
            },
            _ => Err(KinError::InvalidEvent),
        }
    }

    /// Kind 68 replayed: the routine's new rotation, or none. Returns the
    /// member who now owns the routine, if the rotation names one.
    fn set(&mut self, routine_id: RoutineId, members: &[ActorId], current: u8) -> Option<ActorId> {
        if members.is_empty() {
            // The last current member stays the owner: nothing else changes.
            self.rotations.remove(&routine_id);
            return None;
        }
        let rotation = Rotation {
            members: members.to_vec(),
            current: usize::from(current),
            advanced_by: None,
        };
        let owner = rotation.current_member();
        self.rotations.insert(routine_id, rotation);
        Some(owner)
    }

    /// Kind 69 replayed: the turn moves to `member` if the rotation lists
    /// them. Returns the new owner.
    fn turn(&mut self, routine_id: RoutineId, member: ActorId) -> Option<ActorId> {
        let rotation = self.rotations.get_mut(&routine_id)?;
        let index = rotation.members.iter().position(|id| *id == member)?;
        rotation.current = index;
        rotation.advanced_by = None;
        Some(member)
    }

    /// An occurrence of `routine_id` newly completed: the turn passes on.
    fn completed(&mut self, routine_id: RoutineId, key: CivilDate) -> Option<ActorId> {
        let rotation = self.rotations.get_mut(&routine_id)?;
        rotation.current = rotation.next_index();
        rotation.advanced_by = Some(key);
        Some(rotation.current_member())
    }

    /// An occurrence of `routine_id` newly reopened: if it is the one that
    /// passed the turn, the turn comes back.
    fn reopened(&mut self, routine_id: RoutineId, key: CivilDate) -> Option<ActorId> {
        let rotation = self.rotations.get_mut(&routine_id)?;
        if rotation.advanced_by != Some(key) {
            return None;
        }
        let count = rotation.members.len();
        rotation.current = (rotation.current + count - 1) % count;
        rotation.advanced_by = None;
        Some(rotation.current_member())
    }
}

/// Kind 68 or 69 replayed against a routine that exists and isn't archived
/// (replay/routines.rs checks that). Returns the routine's new owner, if
/// the turn names one. Copy-on-write: the shared state is copied only when a
/// rotation changes.
pub(crate) fn apply(
    rotations: &mut Arc<RotationsState>,
    kind: &EventKind,
) -> Result<Option<ActorId>, KinError> {
    match kind {
        EventKind::RoutineRotationSet {
            routine_id,
            members,
            current,
        } => {
            if members.is_empty() && !rotations.is_rotating(routine_id) {
                return Ok(None);
            }
            Ok(Arc::make_mut(rotations).set(*routine_id, members, *current))
        }
        EventKind::RoutineTurnSet {
            routine_id,
            member_id,
        } => {
            let listed = rotations
                .rotation(routine_id)
                .is_some_and(|rotation| rotation.members.contains(member_id));
            if !listed {
                // Raced with a list that dropped the member: no effect.
                return Ok(None);
            }
            Ok(Arc::make_mut(rotations).turn(*routine_id, *member_id))
        }
        _ => Err(KinError::Internal),
    }
}

/// A newly completed occurrence (replay/routines.rs). Returns the new owner
/// when the routine rotates.
pub(crate) fn occurrence_completed(
    rotations: &mut Arc<RotationsState>,
    routine_id: RoutineId,
    key: CivilDate,
) -> Option<ActorId> {
    if !rotations.is_rotating(&routine_id) {
        return None;
    }
    Arc::make_mut(rotations).completed(routine_id, key)
}

/// A newly reopened occurrence (replay/routines.rs). Returns the new owner
/// when it undid the last pass.
pub(crate) fn occurrence_reopened(
    rotations: &mut Arc<RotationsState>,
    routine_id: RoutineId,
    key: CivilDate,
) -> Option<ActorId> {
    if rotations
        .rotation(&routine_id)
        .is_none_or(|rotation| rotation.advanced_by != Some(key))
    {
        return None;
    }
    Arc::make_mut(rotations).reopened(routine_id, key)
}

/// The list's structure: empty with index 0, or 2–12 distinct non-zero
/// members with the index inside the list. Code 2: not canonical.
fn check_list(members: &[ActorId], current: u8) -> Result<(), KinError> {
    let count = members.len();
    let sized = count == 0 && current == 0
        || (MIN_ROTATION_MEMBERS..=MAX_ROTATION_MEMBERS).contains(&count)
            && usize::from(current) < count;
    if !sized {
        return Err(KinError::MalformedProtocol);
    }
    for (index, member) in members.iter().enumerate() {
        if member.0 == [0; 16] || members[..index].contains(member) {
            return Err(KinError::MalformedProtocol);
        }
    }
    Ok(())
}

/// The canonical payloads:
/// - kind 68: routine ID [16], member count u8 (0 or 2–12), current index
///   u8 (below the count; 0 when empty), reserved u16, then each member ID
///   [16]. 20 + 16 × count bytes.
/// - kind 69: routine ID [16], member ID [16]. 32 bytes.
pub fn encode_payload(kind: &EventKind) -> Result<Vec<u8>, KinError> {
    match kind {
        EventKind::RoutineRotationSet {
            routine_id,
            members,
            current,
        } => {
            if routine_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            check_list(members, *current)?;
            let mut out = Vec::with_capacity(20 + 16 * members.len());
            out.extend_from_slice(&routine_id.0);
            out.extend_from_slice(&[members.len() as u8, *current, 0, 0]);
            for member in members {
                out.extend_from_slice(&member.0);
            }
            Ok(out)
        }
        EventKind::RoutineTurnSet {
            routine_id,
            member_id,
        } => {
            if routine_id.0 == [0; 16] || member_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            let mut out = Vec::with_capacity(32);
            out.extend_from_slice(&routine_id.0);
            out.extend_from_slice(&member_id.0);
            Ok(out)
        }
        _ => Err(KinError::Internal),
    }
}

/// Decodes a kind-68 or kind-69 payload strictly; the result re-encodes to
/// the same bytes.
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<EventKind, KinError> {
    let kind = match code {
        ROUTINE_ROTATION_SET => {
            let routine_id = RoutineId(read_id(payload, 0)?);
            let count = usize::from(*payload.get(16).ok_or(KinError::MalformedProtocol)?);
            let current = *payload.get(17).ok_or(KinError::MalformedProtocol)?;
            if read_u16(payload, 18)? != 0
                || count > MAX_ROTATION_MEMBERS
                || payload.len() != 20 + 16 * count
            {
                return Err(KinError::MalformedProtocol);
            }
            let members = (0..count)
                .map(|index| read_id(payload, 20 + 16 * index).map(ActorId))
                .collect::<Result<Vec<_>, _>>()?;
            EventKind::RoutineRotationSet {
                routine_id,
                members,
                current,
            }
        }
        ROUTINE_TURN_SET if payload.len() == 32 => EventKind::RoutineTurnSet {
            routine_id: RoutineId(read_id(payload, 0)?),
            member_id: ActorId(read_id(payload, 16)?),
        },
        _ => return Err(KinError::MalformedProtocol),
    };
    if encode_payload(&kind)? != payload {
        return Err(KinError::MalformedProtocol);
    }
    Ok(kind)
}

/// KRRS v1, routine rotations as the host shows them: "KRRS", version u16 =
/// 1, reserved u16, count u32; then, for each routine that exists, isn't
/// archived and has a rotation, in routine-ID order: routine ID [16], member
/// count u8 (2–12), current index u8, next index u8, reserved u8, then each
/// member ID [16] in turn order. Every listed member is counted as taking
/// turns; the host passes over inactive members (see the module doc).
pub fn encode_rotations(state: &RotationsState, routines: &[RoutineState]) -> Vec<u8> {
    let shown: Vec<(&RoutineId, &Rotation)> = state
        .rotations
        .iter()
        .filter(|(routine_id, _)| {
            routines
                .iter()
                .any(|routine| routine.routine_id == **routine_id && !routine.archived)
        })
        .collect();
    let mut out = Vec::with_capacity(
        12 + shown
            .iter()
            .map(|(_, rotation)| 20 + 16 * rotation.members.len())
            .sum::<usize>(),
    );
    out.extend_from_slice(b"KRRS");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&(shown.len() as u32).to_le_bytes());
    for (routine_id, rotation) in shown {
        out.extend_from_slice(&routine_id.0);
        out.extend_from_slice(&[
            rotation.members.len() as u8,
            rotation.current as u8,
            rotation.next_index() as u8,
            0,
        ]);
        for member in &rotation.members {
            out.extend_from_slice(&member.0);
        }
    }
    out
}
