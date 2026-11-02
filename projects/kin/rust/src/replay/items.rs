//! Replay of items and their Steps: adding, completing, reopening, archiving, Area and planning date.
//! Moved verbatim from the former `state::rebuild_with_context` match;
//! local state became `r.<field>` (replay/mod.rs).
use super::*;

pub(super) fn apply(r: &mut Replay, event: &EventEnvelope) -> Result<(), KinError> {
    match &event.kind {
        EventKind::ItemAdded {
            item_id,
            text,
            classification,
        } => {
            if text.trim().is_empty() || r.item_positions.contains_key(item_id) {
                return Err(KinError::InvalidEvent);
            }
            r.item_positions.insert(*item_id, r.items.len());
            r.items.push(ItemState {
                item_id: *item_id,
                text: text.clone(),
                created_by: event.actor_id,
                created_at: event.timestamp,
                last_changed_at: event.timestamp,
                classification: *classification,
                planning_date: None,
                status: ItemStatus::Active,
                area_id: None,
                steps: Vec::new(),
            });
        }
        EventKind::ItemAreaChanged { item_id, area_id } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            if area_id.is_some_and(|id| !r.area_positions.contains_key(&id)) {
                return Err(KinError::InvalidEvent);
            }
            if r.items[position].area_id != *area_id {
                r.items[position].area_id = *area_id;
                r.items[position].last_changed_at = event.timestamp;
            }
        }
        EventKind::ItemPlanningDateChanged {
            item_id,
            planning_date,
        } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            if r.items[position].planning_date != *planning_date {
                r.items[position].planning_date = *planning_date;
                r.items[position].last_changed_at = event.timestamp;
            }
        }
        EventKind::ItemStepAdded {
            item_id,
            step_id,
            text,
        } => {
            let text = normalize_step_text(text)?;
            if !valid_timestamp(event.timestamp)
                || step_id.0 == [0; 16]
                || !r.seen_step_ids.insert(*step_id)
            {
                return Err(KinError::InvalidEvent);
            }
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            if closed_by_other_device(r, item_id, event) {
                // Another device already archived or completed the parent.
            } else if r.items[position].status != ItemStatus::Active
                || r.items[position].steps.len() >= MAX_STEPS_PER_ITEM
            {
                return Err(KinError::InvalidEvent);
            } else {
                r.items[position].steps.push(ItemStepState {
                    step_id: *step_id,
                    text,
                    completed: false,
                    archived: false,
                });
                r.items[position].last_changed_at = event.timestamp;
            }
        }
        EventKind::ItemStepCompleted { item_id, step_id }
        | EventKind::ItemStepReopened { item_id, step_id }
        | EventKind::ItemStepArchived { item_id, step_id } => {
            if !valid_timestamp(event.timestamp) {
                return Err(KinError::MalformedProtocol);
            }
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            if closed_by_other_device(r, item_id, event) {
                // Another device already archived or completed the parent.
                // Recorded as applied with no other effect (Replay::apply records it).
                return Ok(());
            }
            let step_archived_by_other =
                other_device_archived(r.step_archive_events.get(step_id), event);
            if step_archived_by_other && !matches!(event.kind, EventKind::ItemStepArchived { .. }) {
                // Recorded as applied with no other effect (Replay::apply records it).
                return Ok(());
            }
            if r.items[position].status != ItemStatus::Active {
                return Err(KinError::InvalidEvent);
            }
            let step = r.items[position]
                .steps
                .iter_mut()
                .find(|step| step.step_id == *step_id)
                .ok_or(KinError::InvalidEvent)?;
            if step.archived {
                if matches!(event.kind, EventKind::ItemStepArchived { .. })
                    && archived_by_other_device(r.step_archived_by.get(step_id).copied(), event)
                {
                    // A second archive from another device is a recorded no-op
                    // at any logical time. The same device stays invalid.
                    return Ok(());
                }
                return Err(KinError::InvalidEvent);
            }
            let changed = match event.kind {
                EventKind::ItemStepCompleted { .. } => {
                    let changed = !step.completed;
                    step.completed = true;
                    changed
                }
                EventKind::ItemStepReopened { .. } => {
                    let changed = step.completed;
                    step.completed = false;
                    changed
                }
                EventKind::ItemStepArchived { .. } => {
                    step.archived = true;
                    true
                }
                _ => unreachable!(),
            };
            if changed {
                if matches!(event.kind, EventKind::ItemStepArchived { .. }) {
                    r.step_archived_by
                        .insert(*step_id, (event.logical_time, event.device_id));
                }
                r.items[position].last_changed_at = event.timestamp;
            }
        }
        EventKind::ItemCompleted { item_id } => {
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            match r.items[position].status {
                ItemStatus::Active => {
                    r.items[position].status = ItemStatus::Completed;
                    r.items[position].last_changed_at = event.timestamp;
                    r.item_completions
                        .insert(*item_id, (event.logical_time, event.device_id));
                    // The chore chart (#676): the point goes to the item's
                    // owner, whoever ticked it.
                    let owner = item_owner(r, item_id);
                    crate::chores::credit(
                        &mut r.chores,
                        crate::chores::CreditKey::Item(*item_id),
                        owner,
                        event.timestamp,
                    );
                }
                ItemStatus::Completed => {}
                ItemStatus::Archived => {
                    if r.item_archives
                        .get(item_id)
                        .is_some_and(|(_, device)| *device != event.device_id)
                    {
                        // A different device may have authored this while
                        // offline; archive wins without poisoning replay.
                    } else {
                        return Err(KinError::InvalidEvent);
                    }
                }
            }
        }
        EventKind::ItemReopened { item_id } => {
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            match r.items[position].status {
                ItemStatus::Active => {}
                ItemStatus::Completed => {
                    r.items[position].status = ItemStatus::Active;
                    r.items[position].last_changed_at = event.timestamp;
                    r.item_completions.remove(item_id);
                    crate::chores::uncredit(
                        &mut r.chores,
                        crate::chores::CreditKey::Item(*item_id),
                    );
                }
                ItemStatus::Archived => {
                    if r.item_archives
                        .get(item_id)
                        .is_some_and(|(_, device)| *device != event.device_id)
                    {
                        // A different device may have authored this while
                        // offline; archive wins without poisoning replay.
                    } else {
                        return Err(KinError::InvalidEvent);
                    }
                }
            }
        }
        EventKind::ItemArchived { item_id } => {
            let position = r
                .item_positions
                .get(item_id)
                .copied()
                .ok_or(KinError::InvalidEvent)?;
            match r.items[position].status {
                ItemStatus::Active | ItemStatus::Completed => {
                    r.items[position].status = ItemStatus::Archived;
                    r.items[position].last_changed_at = event.timestamp;
                    r.item_archives
                        .insert(*item_id, (event.logical_time, event.device_id));
                }
                ItemStatus::Archived => {
                    if !archived_by_other_device(r.item_archives.get(item_id).copied(), event) {
                        return Err(KinError::InvalidEvent);
                    }
                }
            }
        }
        // Replay::apply dispatches only this module's kinds here.
        _ => return Err(KinError::Internal),
    }
    Ok(())
}

/// The member an item is assigned to now, if any.
fn item_owner(r: &Replay, item_id: &ItemId) -> Option<ActorId> {
    r.responsibilities
        .iter()
        .find(|entry| {
            entry.target_kind == ResponsibilityTargetKind::Item && entry.target_id == item_id.0
        })
        .and_then(|entry| entry.member_id)
}

/// Another device archived this item, or completed it and has not reopened it.
fn closed_by_other_device(r: &Replay, item_id: &ItemId, event: &EventEnvelope) -> bool {
    other_device_archived(r.item_archive_events.get(item_id), event)
        || other_device_completed(
            r.item_completions.get(item_id).copied(),
            r.item_completion_events.get(item_id),
            event,
        )
}
