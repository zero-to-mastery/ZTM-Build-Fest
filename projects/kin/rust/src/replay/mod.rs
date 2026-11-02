//! Household replay: reducing canonical events into household state.
//!
//! A `Replay` holds the state built so far. Events are applied one at a time
//! in replay order, `(logical_time, device_id, event_id)`, through `apply`,
//! which checks what every event must satisfy and hands the event to its
//! domain's reducer (items.rs, conversations.rs, routines.rs, records.rs,
//! household.rs, devices.rs). `finalize` then produces the `HouseholdState` for one
//! evaluation time and civil date without changing the replay, so the same
//! replay can be finalized again later or extended with newer events.
//!
//! Only two things depend on the evaluation time and date, and both are
//! derived in `finalize`: whether a Pulse has expired, and each Routine's
//! current occurrence and next start. Everything a reducer decides depends on
//! the events alone.
//!
//! Cross-device terminal conflicts: a mutation of an entity that a different
//! device archived or completed, at the same or an earlier logical time, is
//! kept in history and changes no state. `note_archives` records those
//! terminal events before the batch is applied, and the sets stay on the
//! replay, so both sort orders and a strictly later batch see them. A second
//! archive from a different device is a recorded no-op at any logical time.
//! A device mutating something it archived itself stays invalid. A note created in an
//! area another device archived at the same or an earlier logical time is
//! kept with no area.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::error::KinError;
use crate::event::*;
use crate::recurrence::CivilDate;
use crate::state::*;

mod chat;
mod conversations;
mod devices;
mod household;
mod items;
mod records;
mod routines;

#[derive(Clone, Default)]
pub struct Replay {
    /// The stream's household; every event must match it.
    pub(super) household_id: Option<HouseholdId>,
    pub(super) mode: HouseholdMode,
    pub(super) items: Vec<ItemState>,
    pub(super) item_positions: BTreeMap<ItemId, usize>,
    /// Which event archived an Item: (logical time, device).
    pub(super) item_archives: BTreeMap<ItemId, (u64, DeviceId)>,
    /// Every archive event per Item in the whole history, for cross-device terminal checks.
    pub(super) item_archive_events: BTreeMap<ItemId, BTreeSet<(u64, DeviceId)>>,
    /// Completion events, for an equal-logical-time step that sorts before the completion.
    /// A completion is not permanent: reopen clears `item_completions` while this set stays.
    pub(super) item_completion_events: BTreeMap<ItemId, BTreeSet<(u64, DeviceId)>>,
    /// The completion that is in effect, removed when the item is reopened.
    pub(super) item_completions: BTreeMap<ItemId, (u64, DeviceId)>,
    pub(super) step_archive_events: BTreeMap<StepId, BTreeSet<(u64, DeviceId)>>,
    /// Device that first archived a Step. A later archive from anyone else is a no-op.
    pub(super) step_archived_by: BTreeMap<StepId, (u64, DeviceId)>,
    pub(super) seen_step_ids: BTreeSet<StepId>,
    pub(super) handoffs: Vec<HandoffState>,
    pub(super) handoff_positions: BTreeMap<HandoffId, usize>,
    pub(super) handoff_archives: BTreeMap<HandoffId, (u64, DeviceId)>,
    pub(super) handoff_archive_events: BTreeMap<HandoffId, BTreeSet<(u64, DeviceId)>>,
    pub(super) talks: Vec<TalkState>,
    pub(super) talk_positions: BTreeMap<TalkId, usize>,
    pub(super) talk_archives: BTreeMap<TalkId, (u64, DeviceId)>,
    pub(super) talk_archive_events: BTreeMap<TalkId, BTreeSet<(u64, DeviceId)>>,
    /// Latest Pulse per member; `status` is set by finalize.
    pub(super) pulses: BTreeMap<ActorId, PulseState>,
    /// Occurrence fields are set by finalize.
    pub(super) routines: Vec<RoutineState>,
    pub(super) routine_positions: BTreeMap<RoutineId, usize>,
    pub(super) routine_archives: BTreeMap<RoutineId, (u64, DeviceId)>,
    pub(super) routine_archive_events: BTreeMap<RoutineId, BTreeSet<(u64, DeviceId)>>,
    /// Completed occurrences by key, projected onto the civil date in finalize.
    pub(super) completed_periods: BTreeSet<(RoutineId, CivilDate)>,
    pub(super) areas: Vec<AreaState>,
    pub(super) area_positions: BTreeMap<AreaId, usize>,
    pub(super) area_archive_events: BTreeMap<AreaId, BTreeSet<(u64, DeviceId)>>,
    pub(super) notes: Vec<NoteState>,
    pub(super) note_positions: BTreeMap<NoteId, usize>,
    pub(super) note_archive_events: BTreeMap<NoteId, BTreeSet<(u64, DeviceId)>>,
    /// Device that first archived a Note. A later archive from anyone else is a no-op.
    pub(super) note_archived_by: BTreeMap<NoteId, (u64, DeviceId)>,
    pub(super) reference_records: Vec<ReferenceRecordState>,
    pub(super) reference_positions: BTreeMap<ReferenceRecordId, usize>,
    pub(super) reference_field_owners: BTreeMap<ReferenceFieldId, ReferenceRecordId>,
    pub(super) reference_archive_events: BTreeMap<ReferenceRecordId, BTreeSet<(u64, DeviceId)>>,
    pub(super) maintenance_events: Vec<MaintenanceEventState>,
    /// Device that first archived a maintenance event. A later archive from anyone else is a no-op.
    pub(super) maintenance_archived_by: BTreeMap<MaintenanceEventId, (u64, DeviceId)>,
    /// Every maintenance archive, so an edit at the same logical time still sees it.
    pub(super) maintenance_archive_events: BTreeMap<MaintenanceEventId, BTreeSet<(u64, DeviceId)>>,
    pub(super) attachments: Vec<AttachmentState>,
    pub(super) responsibilities: Vec<ResponsibilityState>,
    /// Pins as replayed; finalize drops those whose target is archived.
    pub(super) pins: Vec<PinState>,
    pub(super) playbooks: Vec<PlaybookState>,
    pub(super) playbook_archive_events: BTreeMap<PlaybookId, BTreeSet<(u64, DeviceId)>>,
    /// Named devices by ID (replay/devices.rs).
    pub(super) devices: BTreeMap<DeviceId, DeviceNameState>,
    /// Preferred member names by member ID (replay/devices.rs, #224).
    pub(super) member_names: BTreeMap<ActorId, String>,
    /// Household chat (replay/chat.rs), shared with finalized states until
    /// it changes.
    pub(super) chat: Arc<crate::chat::ChatState>,
    /// The fridge (board.rs), shared with finalized states until it changes.
    pub(super) board: Arc<crate::board::BoardState>,
    /// Meals (meals.rs), shared with finalized states until it changes.
    pub(super) meals: Arc<crate::meals::MealsState>,
    /// Item emoji (simple.rs), shared with finalized states until it changes.
    pub(super) pictures: Arc<crate::simple::PicturesState>,
    /// Store sections (store_sections.rs), shared with finalized states
    /// until they change.
    pub(super) store_sections: Arc<crate::store_sections::StoreSectionsState>,
    /// Routine rotations (rotations.rs), shared with finalized states until
    /// they change. Applied in routines.rs, which also moves the routine's
    /// responsibility with the turn.
    pub(super) rotations: Arc<crate::rotations::RotationsState>,
    /// The sitter page (sitter.rs), shared with finalized states until it
    /// changes.
    pub(super) sitter_page: Arc<crate::sitter::SitterPageState>,
    /// The family album (album.rs), shared with finalized states until it
    /// changes.
    pub(super) album: Arc<crate::album::AlbumState>,
    /// The family calendar (calendar.rs), shared with finalized states until
    /// it changes.
    pub(super) calendar: Arc<crate::calendar::CalendarState>,
    /// The chore chart (chores.rs): its settings and the completions in
    /// effect with who they are credited to (items.rs and routines.rs add
    /// and remove credits), shared with finalized states until it changes.
    pub(super) chores: Arc<crate::chores::ChoresState>,
    /// A member's private records (private.rs). Only a private log ever
    /// fills it, and `finalize` never copies it into a household state.
    pub(super) private: Arc<crate::private::PrivateState>,
    /// Canonical bytes per applied event: an exact duplicate is skipped, a conflicting one fails. Shared, so cloning a Replay does not copy them.
    pub(super) event_bytes: BTreeMap<EventId, Arc<[u8]>>,
    /// Logical time of the last applied event; replay order never goes back.
    pub(super) last_logical_time: u64,
}

impl Replay {
    pub fn new() -> Self {
        Self::default()
    }

    /// The logical time of the last applied event (0 before any). Replay
    /// order never goes back, so it is the greatest logical time applied.
    pub fn last_logical_time(&self) -> u64 {
        self.last_logical_time
    }

    /// The household every applied event belongs to (after bindings).
    pub fn household_id(&self) -> Option<HouseholdId> {
        self.household_id
    }

    /// Whether an event with this ID has been applied.
    pub fn contains_event(&self, event_id: EventId) -> bool {
        self.event_bytes.contains_key(&event_id)
    }

    /// Records terminal events among `events` for cross-device checks (see the
    /// module doc). Call before applying them. Sets accumulate across calls.
    pub fn note_archives(&mut self, events: &[EventEnvelope]) {
        for event in events {
            let stamp = (event.logical_time, event.device_id);
            match &event.kind {
                EventKind::NoteArchived { note_id } => {
                    self.note_archive_events
                        .entry(*note_id)
                        .or_default()
                        .insert(stamp);
                }
                EventKind::ReferenceRecordArchived { record_id } => {
                    self.reference_archive_events
                        .entry(*record_id)
                        .or_default()
                        .insert(stamp);
                }
                EventKind::ItemArchived { item_id } => {
                    self.item_archive_events
                        .entry(*item_id)
                        .or_default()
                        .insert(stamp);
                }
                EventKind::ItemCompleted { item_id } => {
                    self.item_completion_events
                        .entry(*item_id)
                        .or_default()
                        .insert(stamp);
                }
                EventKind::ItemStepArchived { step_id, .. } => {
                    self.step_archive_events
                        .entry(*step_id)
                        .or_default()
                        .insert(stamp);
                }
                EventKind::MaintenanceEventArchived { maintenance_id } => {
                    self.maintenance_archive_events
                        .entry(*maintenance_id)
                        .or_default()
                        .insert(stamp);
                }
                EventKind::AreaArchived { area_id } => {
                    self.area_archive_events
                        .entry(*area_id)
                        .or_default()
                        .insert(stamp);
                }
                EventKind::RoutineArchived { routine_id } => {
                    self.routine_archive_events
                        .entry(*routine_id)
                        .or_default()
                        .insert(stamp);
                }
                EventKind::TalkArchived { talk_id } => {
                    self.talk_archive_events
                        .entry(*talk_id)
                        .or_default()
                        .insert(stamp);
                }
                EventKind::HandoffArchived { handoff_id } => {
                    self.handoff_archive_events
                        .entry(*handoff_id)
                        .or_default()
                        .insert(stamp);
                }
                EventKind::PlaybookArchived { playbook_id } => {
                    self.playbook_archive_events
                        .entry(*playbook_id)
                        .or_default()
                        .insert(stamp);
                }
                _ => {}
            }
        }
    }

    /// Applies one event in replay order. An exact duplicate of an applied
    /// event is skipped; anything invalid fails, and the replay must then be
    /// discarded, since an event may be partly applied.
    pub fn apply(&mut self, event: &EventEnvelope) -> Result<(), KinError> {
        if let Some(previous_bytes) = self.event_bytes.get(&event.event_id) {
            if previous_bytes.as_ref() == event.canonical_bytes.as_slice() {
                return Ok(());
            }
            return Err(KinError::InvalidEvent);
        }
        if let Some(stream_household) = self.household_id {
            if stream_household != event.household_id {
                return Err(KinError::InvalidEvent);
            }
        } else {
            self.household_id = Some(event.household_id);
        }
        // Equal logical times are valid (distributed devices); going back is not.
        if event.logical_time == 0
            || event.logical_time > MAX_LOGICAL_TIME
            || event.logical_time.saturating_sub(self.last_logical_time) > MAX_LOGICAL_TIME_ADVANCE
            || event.logical_time < self.last_logical_time
        {
            return Err(KinError::InvalidEvent);
        }
        use EventKind as K;
        match &event.kind {
            K::ItemAdded { .. }
            | K::ItemAreaChanged { .. }
            | K::ItemPlanningDateChanged { .. }
            | K::ItemStepAdded { .. }
            | K::ItemStepCompleted { .. }
            | K::ItemStepReopened { .. }
            | K::ItemStepArchived { .. }
            | K::ItemCompleted { .. }
            | K::ItemReopened { .. }
            | K::ItemArchived { .. } => items::apply(self, event)?,
            K::HandoffAdded { .. }
            | K::HandoffAcknowledged { .. }
            | K::HandoffArchived { .. }
            | K::TalkAdded { .. }
            | K::TalkResolved { .. }
            | K::TalkReopened { .. }
            | K::TalkArchived { .. }
            | K::PulseSet { .. }
            | K::PulseCleared => conversations::apply(self, event)?,
            K::RoutineCreated { .. }
            | K::RoutineOccurrenceCompleted { .. }
            | K::RoutineOccurrenceReopened { .. }
            | K::RoutineArchived { .. }
            | K::RoutineRotationSet { .. }
            | K::RoutineTurnSet { .. }
            | K::PlaybookSaved { .. }
            | K::PlaybookArchived { .. } => routines::apply(self, event)?,
            K::AreaCreated { .. }
            | K::AreaRenamed { .. }
            | K::AreaArchived { .. }
            | K::NoteCreated { .. }
            | K::NoteUpdated { .. }
            | K::NoteArchived { .. }
            | K::ReferenceRecordSaved { .. }
            | K::ReferenceRecordArchived { .. }
            | K::MaintenanceEventSaved { .. }
            | K::MaintenanceEventArchived { .. }
            | K::AttachmentBound { .. }
            | K::AttachmentRemoved { .. } => records::apply(self, event)?,
            K::HouseholdModeChanged { .. }
            | K::PinAdded { .. }
            | K::PinRemoved { .. }
            | K::ResponsibilityChanged { .. } => household::apply(self, event)?,
            K::DeviceDescribed { .. } | K::DeviceNicknamed { .. } | K::MemberNamed { .. } => {
                devices::apply(self, event)?
            }
            K::ChatMessagePosted { .. }
            | K::ChatMessageEdited { .. }
            | K::ChatMessageDeleted { .. }
            | K::ChatReactionSet { .. }
            | K::ChatPinSet { .. }
            | K::ChatPollVote { .. }
            | K::ChatPollClosed { .. }
            | K::ChatTopicSet { .. } => chat::apply(self, event)?,
            K::BoardStrokeAdded { .. }
            | K::BoardStrokeHidden { .. }
            | K::BoardMagnetPlaced { .. }
            | K::BoardMagnetMoved { .. }
            | K::BoardMagnetHidden { .. }
            | K::BoardCleared { .. }
            | K::BoardClearUndone { .. } => crate::board::apply(&mut self.board, event)?,
            K::RecipeSaved { .. }
            | K::RecipeArchived { .. }
            | K::DinnerSet { .. }
            | K::DinnerCleared { .. }
            | K::DinnerCookSet { .. }
            | K::MealSet { .. }
            | K::MealCleared { .. }
            | K::RecipeFavouriteSet { .. } => crate::meals::apply(&mut self.meals, event)?,
            K::ItemEmojiSet { .. } => crate::simple::apply(&mut self.pictures, event)?,
            K::ShoppingSectionsSet { .. } | K::ItemSectionSet { .. } => {
                crate::store_sections::apply(&mut self.store_sections, event)?
            }
            K::SitterPageSet { .. } => crate::sitter::apply(&mut self.sitter_page, event)?,
            K::AlbumPhotoAdded { .. } | K::AlbumPhotoRemoved { .. } => {
                crate::album::apply(&mut self.album, event)?
            }
            K::CalendarEventSaved(_)
            | K::CalendarEventCancelled { .. }
            | K::CalendarEventRestored { .. }
            | K::MemberColourSet { .. } => crate::calendar::apply(&mut self.calendar, event)?,
            K::ChorePointsSet { .. } | K::ChoreRewardSet { .. } | K::ChoreChartJoined { .. } => {
                crate::chores::apply(&mut self.chores, event)?
            }
            K::PrivateNoteSet { .. }
            | K::PrivateItem(_)
            | K::ReminderSet { .. }
            | K::ReminderCleared { .. }
            | K::SettingSet { .. }
            | K::Journal(_) => crate::private::apply(&mut self.private, event)?,
        }
        self.last_logical_time = event.logical_time;
        self.event_bytes
            .insert(event.event_id, Arc::from(event.canonical_bytes.as_slice()));
        Ok(())
    }

    /// The chat domain as replayed so far, without finalizing the rest of the
    /// household (searching needs only this).
    pub fn chat(&self) -> &crate::chat::ChatState {
        &self.chat
    }

    /// The fridge as replayed so far (board.rs).
    pub fn board(&self) -> &crate::board::BoardState {
        &self.board
    }

    /// A member's private records as replayed so far (private.rs).
    pub fn private(&self) -> &crate::private::PrivateState {
        &self.private
    }

    /// The household state at `as_of` (UTC milliseconds) on `civil_date`.
    /// Copies the replayed state; the replay itself is unchanged.
    pub fn finalize(&self, as_of: i64, civil_date: CivilDate) -> Result<HouseholdState, KinError> {
        if !valid_timestamp(as_of) {
            return Err(KinError::MalformedProtocol);
        }
        let mut routines = self.routines.clone();
        for routine in &mut routines {
            if routine.archived {
                routine.occurrence_key = None;
                routine.next_start = None;
            } else {
                routine.occurrence_key =
                    routine.cadence.current_key(routine.created_on, civil_date);
                routine.next_start = routine.cadence.next_start(routine.created_on, civil_date);
            }
            routine.completed = routine
                .occurrence_key
                .is_some_and(|key| self.completed_periods.contains(&(routine.routine_id, key)));
        }
        let pulses = self
            .pulses
            .values()
            .map(|pulse| PulseState {
                status: if as_of < pulse.expires_at {
                    PulseStatus::Active
                } else {
                    PulseStatus::Expired
                },
                ..pulse.clone()
            })
            .collect();
        // Pins whose target was archived are dropped from the result only:
        // while replaying they still count, as they always have.
        let mut pins = self.pins.clone();
        pins.retain(|pin| match pin.target_kind {
            PinTargetKind::Item => self
                .item_positions
                .get(&ItemId(pin.target_id))
                .is_some_and(|i| self.items[*i].status != ItemStatus::Archived),
            PinTargetKind::Note => self
                .note_positions
                .get(&NoteId(pin.target_id))
                .is_some_and(|i| self.notes[*i].status != NoteStatus::Archived),
            PinTargetKind::Routine => self
                .routine_positions
                .get(&RoutineId(pin.target_id))
                .is_some_and(|i| !self.routines[*i].archived),
            PinTargetKind::Area => self
                .area_positions
                .get(&AreaId(pin.target_id))
                .is_some_and(|i| !self.areas[*i].archived),
        });
        Ok(HouseholdState {
            household_id: self.household_id,
            mode: self.mode,
            items: self.items.clone(),
            handoffs: self.handoffs.clone(),
            talks: self.talks.clone(),
            pulses,
            routines,
            areas: self.areas.clone(),
            notes: self.notes.clone(),
            pins,
            playbooks: self.playbooks.clone(),
            reference_records: self.reference_records.clone(),
            maintenance_events: self.maintenance_events.clone(),
            attachments: self.attachments.clone(),
            responsibilities: self.responsibilities.clone(),
            devices: self.devices.values().cloned().collect(),
            member_names: self
                .member_names
                .iter()
                .map(|(member_id, name)| MemberNameState {
                    member_id: *member_id,
                    name: name.clone(),
                })
                .collect(),
            chat: Arc::clone(&self.chat),
            board: Arc::clone(&self.board),
            meals: Arc::clone(&self.meals),
            pictures: Arc::clone(&self.pictures),
            store_sections: Arc::clone(&self.store_sections),
            rotations: Arc::clone(&self.rotations),
            sitter_page: Arc::clone(&self.sitter_page),
            album: Arc::clone(&self.album),
            calendar: Arc::clone(&self.calendar),
            chores: Arc::clone(&self.chores),
        })
    }
}

pub(super) fn has_concurrent_archive(
    archives: Option<&BTreeSet<(u64, DeviceId)>>,
    event: &EventEnvelope,
) -> bool {
    archives.is_some_and(|archives| {
        archives.iter().any(|(logical_time, device_id)| {
            *logical_time == event.logical_time && *device_id != event.device_id
        })
    })
}

/// Whether a different device made this entity terminal at or before `event`.
///
/// `known` is every terminal event [`Replay::note_archives`] has recorded. The
/// set accumulates across batches, so a strictly later batch still sees an
/// earlier archive. Equal logical time counts even when that terminal event
/// sorts later, which keeps both device orders the same. The same device does
/// not match: its own later mutation stays invalid.
///
/// Completions are not passed here. Reopen clears a completion, so callers use
/// [`other_device_completed`] for the completion that is still in effect.
pub(super) fn other_device_archived(
    known: Option<&BTreeSet<(u64, DeviceId)>>,
    event: &EventEnvelope,
) -> bool {
    known.is_some_and(|events| {
        events.iter().any(|(logical_time, device_id)| {
            *device_id != event.device_id && *logical_time <= event.logical_time
        })
    })
}

/// Whether a different device completed this item and it has not been reopened.
///
/// `applied` is the completion currently in effect. `concurrent` is every
/// completion event, consulted only at equal logical time, because a completion
/// that sorts later has not been applied yet. An earlier completion that was
/// reopened is absent from `applied` and does not match here.
pub(super) fn other_device_completed(
    applied: Option<(u64, DeviceId)>,
    concurrent: Option<&BTreeSet<(u64, DeviceId)>>,
    event: &EventEnvelope,
) -> bool {
    let applied_by_other = applied.is_some_and(|(logical_time, device_id)| {
        device_id != event.device_id && logical_time <= event.logical_time
    });
    let concurrent_other = concurrent.is_some_and(|events| {
        events.iter().any(|(logical_time, device_id)| {
            *logical_time == event.logical_time && *device_id != event.device_id
        })
    });
    applied_by_other || concurrent_other
}

/// The entity is already archived, and the device that archived it is not `event`'s.
///
/// A second archive from another device is a recorded no-op at any logical time.
/// The same device archiving its own archived entity again stays invalid.
/// Replay has already applied the earlier archive, so logical time is not compared.
pub(super) fn archived_by_other_device(
    archived_by: Option<(u64, DeviceId)>,
    event: &EventEnvelope,
) -> bool {
    archived_by.is_some_and(|(_, device_id)| device_id != event.device_id)
}
