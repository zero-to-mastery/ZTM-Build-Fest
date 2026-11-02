//! Replay of handoffs, Talks and Pulses.
//! Moved verbatim from the former `state::rebuild_with_context` match;
//! local state became `r.<field>` (replay/mod.rs).
use super::*;

pub(super) fn apply(r: &mut Replay, event: &EventEnvelope) -> Result<(), KinError> {
    match &event.kind {
        EventKind::HandoffAdded { handoff_id, text } => {
            if text.trim().is_empty() || r.handoff_positions.contains_key(handoff_id) {
                return Err(KinError::InvalidEvent);
            }
            r.handoff_positions.insert(*handoff_id, r.handoffs.len());
            r.handoffs.push(HandoffState {
                handoff_id: *handoff_id,
                text: text.clone(),
                created_by: event.actor_id,
                created_at: event.timestamp,
                status: HandoffStatus::Unacknowledged,
            });
        }
        EventKind::HandoffAcknowledged { handoff_id }
        | EventKind::HandoffArchived { handoff_id } => {
            let position = r
                .handoff_positions
                .get(handoff_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            let handoff = &mut r.handoffs[position];
            if matches!(event.kind, EventKind::HandoffAcknowledged { .. })
                && other_device_archived(r.handoff_archive_events.get(handoff_id), event)
            {
                // Recorded as applied with no other effect (Replay::apply records it).
                return Ok(());
            }
            if handoff.status == HandoffStatus::Archived {
                if !archived_by_other_device(r.handoff_archives.get(handoff_id).copied(), event) {
                    return Err(KinError::InvalidEvent);
                }
            } else if matches!(event.kind, EventKind::HandoffArchived { .. }) {
                handoff.status = HandoffStatus::Archived;
                r.handoff_archives
                    .insert(*handoff_id, (event.logical_time, event.device_id));
            } else {
                handoff.status = HandoffStatus::Acknowledged;
            }
        }
        EventKind::TalkAdded { talk_id, text } => {
            if text.trim().is_empty() || r.talk_positions.contains_key(talk_id) {
                return Err(KinError::InvalidEvent);
            }
            r.talk_positions.insert(*talk_id, r.talks.len());
            r.talks.push(TalkState {
                talk_id: *talk_id,
                text: text.clone(),
                created_by: event.actor_id,
                created_at: event.timestamp,
                status: TalkStatus::Open,
            });
        }
        EventKind::TalkResolved { talk_id }
        | EventKind::TalkReopened { talk_id }
        | EventKind::TalkArchived { talk_id } => {
            let position = r
                .talk_positions
                .get(talk_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            let talk = &mut r.talks[position];
            if !matches!(event.kind, EventKind::TalkArchived { .. })
                && other_device_archived(r.talk_archive_events.get(talk_id), event)
            {
                // Recorded as applied with no other effect (Replay::apply records it).
                return Ok(());
            }
            if talk.status == TalkStatus::Archived {
                if !archived_by_other_device(r.talk_archives.get(talk_id).copied(), event) {
                    return Err(KinError::InvalidEvent);
                }
            } else if matches!(event.kind, EventKind::TalkArchived { .. }) {
                talk.status = TalkStatus::Archived;
                r.talk_archives
                    .insert(*talk_id, (event.logical_time, event.device_id));
            } else {
                talk.status = match event.kind {
                    EventKind::TalkResolved { .. } => TalkStatus::Resolved,
                    EventKind::TalkReopened { .. } => TalkStatus::Open,
                    _ => return Err(KinError::InvalidEvent),
                };
            }
        }
        EventKind::PulseSet { value, expires_at } => {
            if !valid_timestamp(event.timestamp) || !valid_timestamp(*expires_at) {
                return Err(KinError::MalformedProtocol);
            }
            if *expires_at <= event.timestamp {
                return Err(KinError::InvalidEvent);
            }
            r.pulses.insert(
                event.actor_id,
                PulseState {
                    actor_id: event.actor_id,
                    value: *value,
                    set_at: event.timestamp,
                    expires_at: *expires_at,
                    // Active or expired depends on the evaluation time: set in finalize.
                    status: PulseStatus::Active,
                },
            );
        }
        EventKind::PulseCleared => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            r.pulses.remove(&event.actor_id);
        }
        // Replay::apply dispatches only this module's kinds here.
        _ => return Err(KinError::Internal),
    }
    Ok(())
}
