//! Replay of household-wide state: mode, Pins and responsibilities.
//! Moved verbatim from the former `state::rebuild_with_context` match;
//! local state became `r.<field>` (replay/mod.rs).
use super::*;

pub(super) fn apply(r: &mut Replay, event: &EventEnvelope) -> Result<(), KinError> {
    match &event.kind {
        EventKind::HouseholdModeChanged { mode: next_mode } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            r.mode = *next_mode;
        }
        EventKind::PinAdded {
            target_kind,
            target_id,
        } => {
            if *target_id == [0; 16] {
                return Err(KinError::InvalidEvent);
            }
            let (exists, active) = match target_kind {
                PinTargetKind::Item => r
                    .item_positions
                    .get(&ItemId(*target_id))
                    .map(|i| (true, r.items[*i].status != ItemStatus::Archived))
                    .unwrap_or((false, false)),
                PinTargetKind::Note => r
                    .note_positions
                    .get(&NoteId(*target_id))
                    .map(|i| (true, r.notes[*i].status != NoteStatus::Archived))
                    .unwrap_or((false, false)),
                PinTargetKind::Routine => r
                    .routine_positions
                    .get(&RoutineId(*target_id))
                    .map(|i| (true, !r.routines[*i].archived))
                    .unwrap_or((false, false)),
                PinTargetKind::Area => r
                    .area_positions
                    .get(&AreaId(*target_id))
                    .map(|i| (true, !r.areas[*i].archived))
                    .unwrap_or((false, false)),
            };
            if !exists {
                return Err(KinError::InvalidEvent);
            }
            let pin = PinState {
                target_kind: *target_kind,
                target_id: *target_id,
            };
            if active && !r.pins.contains(&pin) {
                if r.pins.len() >= MAX_PINS {
                    return Err(KinError::InvalidEvent);
                }
                r.pins.push(pin);
            }
        }
        EventKind::PinRemoved {
            target_kind,
            target_id,
        } => {
            let pin = PinState {
                target_kind: *target_kind,
                target_id: *target_id,
            };
            if let Some(position) = r.pins.iter().position(|existing| *existing == pin) {
                r.pins.remove(position);
            }
        }
        EventKind::ResponsibilityChanged {
            target_kind,
            target_id,
            member_id,
        } => {
            if *target_id == [0; 16] || member_id.is_some_and(|id| id.0 == [0; 16]) {
                return Err(KinError::InvalidEvent);
            }
            let active = match target_kind {
                ResponsibilityTargetKind::Item => r
                    .item_positions
                    .get(&crate::event::ItemId(*target_id))
                    .is_some_and(|i| r.items[*i].status != ItemStatus::Archived),
                ResponsibilityTargetKind::Routine => r
                    .routine_positions
                    .get(&RoutineId(*target_id))
                    .is_some_and(|i| !r.routines[*i].archived),
            };
            if !active {
                // An assignment racing with archive/removal is terminally
                // ignored. It must not poison replay on every device.
                let archived_target = match target_kind {
                    ResponsibilityTargetKind::Item => r
                        .item_positions
                        .get(&crate::event::ItemId(*target_id))
                        .is_some_and(|i| r.items[*i].status == ItemStatus::Archived),
                    ResponsibilityTargetKind::Routine => r
                        .routine_positions
                        .get(&RoutineId(*target_id))
                        .is_some_and(|i| r.routines[*i].archived),
                };
                let archived_by_another_device = match target_kind {
                    ResponsibilityTargetKind::Item => r
                        .item_archives
                        .get(&crate::event::ItemId(*target_id))
                        .is_some_and(|(_, device)| *device != event.device_id),
                    ResponsibilityTargetKind::Routine => r
                        .routine_archives
                        .get(&RoutineId(*target_id))
                        .is_some_and(|(_, device)| *device != event.device_id),
                };
                if archived_target && archived_by_another_device {
                    // Recorded as applied with no other effect (Replay::apply records it).
                    return Ok(());
                }
                return Err(KinError::InvalidEvent);
            }
            if *target_kind == ResponsibilityTargetKind::Routine
                && r.rotations.is_rotating(&RoutineId(*target_id))
            {
                // A rotating routine's owner is whoever's turn it is (#429);
                // a racing owner change is recorded with no effect.
                return Ok(());
            }
            if let Some(existing) = r
                .responsibilities
                .iter_mut()
                .find(|entry| entry.target_kind == *target_kind && entry.target_id == *target_id)
            {
                existing.member_id = *member_id;
            } else {
                r.responsibilities.push(ResponsibilityState {
                    target_kind: *target_kind,
                    target_id: *target_id,
                    member_id: *member_id,
                });
            }
        }
        // Replay::apply dispatches only this module's kinds here.
        _ => return Err(KinError::Internal),
    }
    Ok(())
}
