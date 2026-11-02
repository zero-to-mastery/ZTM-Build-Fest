//! Replay of routines (creation, occurrence completion, archive, rotations)
//! and Playbooks.
//! Moved verbatim from the former `state::rebuild_with_context` match;
//! local state became `r.<field>` (replay/mod.rs).
use super::*;

pub(super) fn apply(r: &mut Replay, event: &EventEnvelope) -> Result<(), KinError> {
    match &event.kind {
        EventKind::RoutineCreated {
            routine_id,
            text,
            cadence,
            created_on,
        } => {
            if !valid_timestamp(event.timestamp) || text.len() > 4096 || text.is_empty() {
                return Err(KinError::MalformedProtocol);
            }
            if text.trim().is_empty() || r.routine_positions.contains_key(routine_id) {
                return Err(KinError::InvalidEvent);
            }
            r.routine_positions.insert(*routine_id, r.routines.len());
            r.routines.push(RoutineState {
                routine_id: *routine_id,
                text: text.clone(),
                created_by: event.actor_id,
                created_at: event.timestamp,
                created_on: *created_on,
                cadence: *cadence,
                archived: false,
                // Occurrence fields depend on the civil date: set in finalize.
                occurrence_key: None,
                completed: false,
                next_start: None,
            });
        }
        EventKind::RoutineOccurrenceCompleted { routine_id, key }
        | EventKind::RoutineOccurrenceReopened { routine_id, key } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            let position = r
                .routine_positions
                .get(routine_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            let routine = &r.routines[position];
            routine.cadence.validate_key(routine.created_on, *key)?;
            if other_device_archived(r.routine_archive_events.get(routine_id), event) {
                // Recorded as applied with no other effect (Replay::apply records it).
                return Ok(());
            }
            if routine.archived {
                return Err(KinError::InvalidEvent);
            }
            // Only a real change moves a rotation's turn (#429): a duplicate
            // completion, or reopening an open occurrence, changes nothing.
            let credit_key = crate::chores::CreditKey::Routine(*routine_id, *key);
            let owner = if matches!(event.kind, EventKind::RoutineOccurrenceCompleted { .. }) {
                if r.completed_periods.insert((*routine_id, *key)) {
                    // The chore chart (#676): credited to the routine's owner
                    // now, whose turn it was, before the turn passes on.
                    let credited = routine_owner(r, routine_id);
                    crate::chores::credit(&mut r.chores, credit_key, credited, event.timestamp);
                    crate::rotations::occurrence_completed(&mut r.rotations, *routine_id, *key)
                } else {
                    None
                }
            } else if r.completed_periods.remove(&(*routine_id, *key)) {
                crate::chores::uncredit(&mut r.chores, credit_key);
                crate::rotations::occurrence_reopened(&mut r.rotations, *routine_id, *key)
            } else {
                None
            };
            if let Some(member) = owner {
                set_routine_owner(r, *routine_id, member);
            }
        }
        EventKind::RoutineRotationSet { routine_id, .. }
        | EventKind::RoutineTurnSet { routine_id, .. } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            if event.actor_id.0 == [0; 16] || event.device_id.0 == [0; 16] {
                return Err(KinError::InvalidEvent);
            }
            let position = r
                .routine_positions
                .get(routine_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            if r.routines[position].archived {
                // A turn racing with archive changes nothing: the routine is
                // gone, and its rotation with it (Replay::apply records it).
                return Ok(());
            }
            if let Some(member) = crate::rotations::apply(&mut r.rotations, &event.kind)? {
                set_routine_owner(r, *routine_id, member);
            }
        }
        EventKind::RoutineArchived { routine_id } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            let position = r
                .routine_positions
                .get(routine_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            let routine = &mut r.routines[position];
            if routine.archived {
                if !archived_by_other_device(r.routine_archives.get(routine_id).copied(), event) {
                    return Err(KinError::InvalidEvent);
                }
            } else {
                routine.archived = true;
                routine.occurrence_key = None;
                routine.next_start = None;
                r.routine_archives
                    .insert(*routine_id, (event.logical_time, event.device_id));
            }
            r.pins.retain(|pin| {
                !(pin.target_kind == PinTargetKind::Routine && pin.target_id == routine_id.0)
            });
        }
        EventKind::PlaybookSaved {
            playbook_id,
            title,
            entries,
        } => {
            let (title, entries) = normalize_playbook(title, entries)?;
            if !valid_timestamp(event.timestamp) || playbook_id.0 == [0; 16] {
                return Err(KinError::InvalidEvent);
            }
            if let Some(existing) = r
                .playbooks
                .iter_mut()
                .find(|record| record.playbook_id == *playbook_id)
            {
                if other_device_archived(r.playbook_archive_events.get(playbook_id), event) {
                    // Recorded as applied with no other effect (Replay::apply records it).
                    return Ok(());
                }
                if existing.archived {
                    return Err(KinError::InvalidEvent);
                }
                existing.title = title;
                existing.entries = entries;
            } else {
                if r.playbooks.len() >= MAX_PLAYBOOKS {
                    return Err(KinError::InvalidEvent);
                }
                r.playbooks.push(PlaybookState {
                    playbook_id: *playbook_id,
                    title,
                    entries,
                    archived: false,
                });
            }
        }
        EventKind::PlaybookArchived { playbook_id } => {
            let record = r
                .playbooks
                .iter_mut()
                .find(|record| record.playbook_id == *playbook_id)
                .ok_or(KinError::InvalidEvent)?;
            record.archived = true;
        }
        // Replay::apply dispatches only this module's kinds here.
        _ => return Err(KinError::Internal),
    }
    Ok(())
}

/// The member a routine is assigned to now (whose turn it is, while it
/// rotates), if any.
fn routine_owner(r: &Replay, routine_id: &RoutineId) -> Option<ActorId> {
    r.responsibilities
        .iter()
        .find(|entry| {
            entry.target_kind == ResponsibilityTargetKind::Routine
                && entry.target_id == routine_id.0
        })
        .and_then(|entry| entry.member_id)
}

/// While a routine rotates, its responsibility follows the turn (#429,
/// rotations.rs): the entry names the current member, as a
/// `RESPONSIBILITY_CHANGED` would. Ending the rotation leaves it as it is.
fn set_routine_owner(r: &mut Replay, routine_id: RoutineId, member: ActorId) {
    if let Some(entry) = r.responsibilities.iter_mut().find(|entry| {
        entry.target_kind == ResponsibilityTargetKind::Routine && entry.target_id == routine_id.0
    }) {
        entry.member_id = Some(member);
    } else {
        r.responsibilities.push(ResponsibilityState {
            target_kind: ResponsibilityTargetKind::Routine,
            target_id: routine_id.0,
            member_id: Some(member),
        });
    }
}
