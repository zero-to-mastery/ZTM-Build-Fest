//! Canonical encoding and validated metadata. Existing event bytes stay immutable.
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::wire::MAX_ITEM_TEXT_BYTES;

pub fn kind_code(kind: &EventKind) -> u16 {
    match kind {
        EventKind::ItemAdded { .. } => 1,
        EventKind::ItemCompleted { .. } => 2,
        EventKind::ItemReopened { .. } => 3,
        EventKind::ItemArchived { .. } => 4,
        EventKind::HandoffAdded { .. } => 5,
        EventKind::HandoffAcknowledged { .. } => 6,
        EventKind::HandoffArchived { .. } => 7,
        EventKind::TalkAdded { .. } => 8,
        EventKind::TalkResolved { .. } => 9,
        EventKind::TalkReopened { .. } => 10,
        EventKind::TalkArchived { .. } => 11,
        EventKind::PulseSet { .. } => 12,
        EventKind::PulseCleared => 13,
        EventKind::RoutineCreated { .. } => 14,
        EventKind::RoutineOccurrenceCompleted { .. } => 15,
        EventKind::RoutineOccurrenceReopened { .. } => 16,
        EventKind::RoutineArchived { .. } => 17,
        EventKind::AreaCreated { .. } => 18,
        EventKind::AreaRenamed { .. } => 19,
        EventKind::AreaArchived { .. } => 20,
        EventKind::ItemAreaChanged { .. } => 21,
        EventKind::NoteCreated { .. } => 22,
        EventKind::NoteUpdated { .. } => 23,
        EventKind::NoteArchived { .. } => 24,
        EventKind::ItemStepAdded { .. } => 25,
        EventKind::ItemStepCompleted { .. } => 26,
        EventKind::ItemStepReopened { .. } => 27,
        EventKind::ItemStepArchived { .. } => 28,
        EventKind::HouseholdModeChanged { .. } => 29,
        EventKind::ItemPlanningDateChanged { .. } => 30,
        EventKind::PinAdded { .. } => 31,
        EventKind::PinRemoved { .. } => 32,
        EventKind::PlaybookSaved { .. } => 33,
        EventKind::PlaybookArchived { .. } => 34,
        EventKind::ReferenceRecordSaved { .. } => 35,
        EventKind::ReferenceRecordArchived { .. } => 36,
        EventKind::MaintenanceEventSaved { .. } => 37,
        EventKind::MaintenanceEventArchived { .. } => 38,
        EventKind::AttachmentBound { .. } => 39,
        EventKind::AttachmentRemoved { .. } => 40,
        EventKind::ResponsibilityChanged { .. } => 41,
        EventKind::DeviceDescribed { .. } => 42,
        EventKind::DeviceNicknamed { .. } => 43,
        EventKind::ChatMessagePosted { .. } => 44,
        EventKind::ChatMessageEdited { .. } => 45,
        EventKind::ChatMessageDeleted { .. } => 46,
        EventKind::ChatReactionSet { .. } => 47,
        EventKind::ChatPinSet { .. } => 48,
        EventKind::ChatPollVote { .. } => 49,
        EventKind::ChatPollClosed { .. } => 50,
        EventKind::MemberNamed { .. } => 51,
        EventKind::BoardStrokeAdded { .. } => crate::board::STROKE_ADDED,
        EventKind::BoardStrokeHidden { .. } => crate::board::STROKE_HIDDEN,
        EventKind::BoardMagnetPlaced { .. } => crate::board::MAGNET_PLACED,
        EventKind::BoardMagnetMoved { .. } => crate::board::MAGNET_MOVED,
        EventKind::BoardMagnetHidden { .. } => crate::board::MAGNET_HIDDEN,
        EventKind::BoardCleared { .. } => crate::board::CLEARED,
        EventKind::BoardClearUndone { .. } => crate::board::CLEAR_UNDONE,
        EventKind::RecipeSaved { .. } => crate::meals::RECIPE_SAVED,
        EventKind::RecipeArchived { .. } => crate::meals::RECIPE_ARCHIVED,
        EventKind::DinnerSet { .. } => crate::meals::DINNER_SET,
        EventKind::DinnerCleared { .. } => crate::meals::DINNER_CLEARED,
        EventKind::DinnerCookSet { .. } => crate::meals::DINNER_COOK_SET,
        EventKind::MealSet { .. } => crate::meals::MEAL_SET,
        EventKind::MealCleared { .. } => crate::meals::MEAL_CLEARED,
        EventKind::RecipeFavouriteSet { .. } => crate::meals::RECIPE_FAVOURITE_SET,
        EventKind::ItemEmojiSet { .. } => crate::simple::ITEM_EMOJI_SET,
        EventKind::ChatTopicSet { .. } => crate::chat::CHAT_TOPIC_SET,
        EventKind::ShoppingSectionsSet { .. } => crate::store_sections::SHOPPING_SECTIONS_SET,
        EventKind::ItemSectionSet { .. } => crate::store_sections::ITEM_SECTION_SET,
        EventKind::RoutineRotationSet { .. } => crate::rotations::ROUTINE_ROTATION_SET,
        EventKind::RoutineTurnSet { .. } => crate::rotations::ROUTINE_TURN_SET,
        EventKind::SitterPageSet { .. } => crate::sitter::SITTER_PAGE_SET,
        EventKind::AlbumPhotoAdded { .. } => crate::album::ALBUM_PHOTO_ADDED,
        EventKind::AlbumPhotoRemoved { .. } => crate::album::ALBUM_PHOTO_REMOVED,
        EventKind::CalendarEventSaved(_) => crate::calendar::CALENDAR_EVENT_SAVED,
        EventKind::CalendarEventCancelled { .. } => crate::calendar::CALENDAR_EVENT_CANCELLED,
        EventKind::CalendarEventRestored { .. } => crate::calendar::CALENDAR_EVENT_RESTORED,
        EventKind::MemberColourSet { .. } => crate::calendar::MEMBER_COLOUR_SET,
        EventKind::ChorePointsSet { .. } => crate::chores::CHORE_POINTS_SET,
        EventKind::ChoreRewardSet { .. } => crate::chores::CHORE_REWARD_SET,
        EventKind::ChoreChartJoined { .. } => crate::chores::CHORE_CHART_JOINED,
        EventKind::PrivateNoteSet { .. } => crate::private::PRIVATE_NOTE_SET,
        EventKind::PrivateItem(event) => event.code(),
        EventKind::ReminderSet { .. } => crate::private_prefs::REMINDER_SET,
        EventKind::ReminderCleared { .. } => crate::private_prefs::REMINDER_CLEARED,
        EventKind::SettingSet { .. } => crate::private_prefs::SETTING_SET,
        EventKind::Journal(event) => event.code(),
    }
}

fn push_text(payload: &mut Vec<u8>, text: &str) -> Result<(), KinError> {
    if text.is_empty() || text.len() > MAX_ITEM_TEXT_BYTES {
        return Err(KinError::MalformedProtocol);
    }
    payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
    payload.extend_from_slice(text.as_bytes());
    Ok(())
}

/// Encodes a protocol-24 canonical event (ITEM_ADDED schema 2, every other
/// kind schema 1). This never edits canonical source history; callers retain
/// its original bytes when decoding.
pub fn encode_event(event: &EventEnvelope) -> Result<Vec<u8>, KinError> {
    let mut payload = Vec::new();
    match &event.kind {
        EventKind::ItemAdded {
            item_id,
            text,
            classification,
        } => {
            if event.event_version != 2 {
                return Err(KinError::UnsupportedVersion);
            }
            payload.extend_from_slice(&item_id.0);
            payload.extend_from_slice(&[
                match classification {
                    ItemClassification::Today => 0,
                    ItemClassification::Need => 1,
                    ItemClassification::Shopping => 2,
                    ItemClassification::Staple => 3,
                },
                0,
                0,
                0,
            ]);
            push_text(&mut payload, text)?;
        }
        EventKind::ItemCompleted { item_id }
        | EventKind::ItemReopened { item_id }
        | EventKind::ItemArchived { item_id } => payload.extend_from_slice(&item_id.0),
        EventKind::ItemPlanningDateChanged {
            item_id,
            planning_date,
        } => {
            payload.extend_from_slice(&item_id.0);
            payload.extend_from_slice(
                &planning_date
                    .map_or(0, crate::recurrence::CivilDate::encoded)
                    .to_le_bytes(),
            );
        }
        EventKind::HandoffAdded { handoff_id, text } => {
            payload.extend_from_slice(&handoff_id.0);
            push_text(&mut payload, text)?;
        }
        EventKind::HandoffAcknowledged { handoff_id }
        | EventKind::HandoffArchived { handoff_id } => payload.extend_from_slice(&handoff_id.0),
        EventKind::TalkAdded { talk_id, text } => {
            payload.extend_from_slice(&talk_id.0);
            push_text(&mut payload, text)?;
        }
        EventKind::TalkResolved { talk_id }
        | EventKind::TalkReopened { talk_id }
        | EventKind::TalkArchived { talk_id } => payload.extend_from_slice(&talk_id.0),
        EventKind::PulseSet { value, expires_at } => {
            payload.extend_from_slice(&[*value as u8, 0, 0, 0, 0, 0, 0, 0]);
            payload.extend_from_slice(&expires_at.to_le_bytes());
        }
        EventKind::PulseCleared => {}
        EventKind::RoutineCreated {
            routine_id,
            text,
            cadence,
            created_on,
        } => {
            payload.extend_from_slice(&routine_id.0);
            payload.extend_from_slice(&[*cadence as u8, 0, 0, 0]);
            payload.extend_from_slice(&created_on.encoded().to_le_bytes());
            push_text(&mut payload, text)?;
        }
        EventKind::RoutineOccurrenceCompleted { routine_id, key }
        | EventKind::RoutineOccurrenceReopened { routine_id, key } => {
            payload.extend_from_slice(&routine_id.0);
            payload.extend_from_slice(&key.encoded().to_le_bytes());
        }
        EventKind::RoutineArchived { routine_id } => payload.extend_from_slice(&routine_id.0),
        EventKind::AreaCreated { area_id, name } | EventKind::AreaRenamed { area_id, name } => {
            payload.extend_from_slice(&area_id.0);
            push_text(&mut payload, name)?;
        }
        EventKind::AreaArchived { area_id } => payload.extend_from_slice(&area_id.0),
        EventKind::ItemAreaChanged { item_id, area_id } => {
            payload.extend_from_slice(&item_id.0);
            payload.extend_from_slice(&area_id.map_or([0; 16], |id| id.0));
        }
        EventKind::NoteCreated {
            note_id,
            title,
            body,
            area_id,
        }
        | EventKind::NoteUpdated {
            note_id,
            title,
            body,
            area_id,
        } => {
            let (title, body) = crate::state::normalize_note(title, body)?;
            payload.extend_from_slice(&note_id.0);
            payload.extend_from_slice(&area_id.map_or([0; 16], |id| id.0));
            payload.extend_from_slice(&(title.len() as u32).to_le_bytes());
            payload.extend_from_slice(&(body.len() as u32).to_le_bytes());
            payload.extend_from_slice(title.as_bytes());
            payload.extend_from_slice(body.as_bytes());
        }
        EventKind::NoteArchived { note_id } => payload.extend_from_slice(&note_id.0),
        EventKind::ItemStepAdded {
            item_id,
            step_id,
            text,
        } => {
            let text = crate::state::normalize_step_text(text)?;
            payload.extend_from_slice(&item_id.0);
            payload.extend_from_slice(&step_id.0);
            push_text(&mut payload, &text)?;
        }
        EventKind::ItemStepCompleted { item_id, step_id }
        | EventKind::ItemStepReopened { item_id, step_id }
        | EventKind::ItemStepArchived { item_id, step_id } => {
            payload.extend_from_slice(&item_id.0);
            payload.extend_from_slice(&step_id.0);
        }
        EventKind::HouseholdModeChanged { mode } => payload.push(*mode as u8),
        EventKind::PinAdded {
            target_kind,
            target_id,
        }
        | EventKind::PinRemoved {
            target_kind,
            target_id,
        } => {
            payload.push(*target_kind as u8);
            payload.extend_from_slice(&[0; 3]);
            payload.extend_from_slice(target_id);
        }
        EventKind::PlaybookSaved {
            playbook_id,
            title,
            entries,
        } => {
            let (title, entries) = crate::state::normalize_playbook(title, entries)?;
            payload.extend_from_slice(&playbook_id.0);
            payload.extend_from_slice(&(title.len() as u16).to_le_bytes());
            payload.push(entries.len() as u8);
            payload.push(0);
            payload.extend_from_slice(title.as_bytes());
            for entry in entries {
                payload.extend_from_slice(&(entry.len() as u16).to_le_bytes());
                payload.extend_from_slice(entry.as_bytes());
            }
        }
        EventKind::PlaybookArchived { playbook_id } => payload.extend_from_slice(&playbook_id.0),
        EventKind::ReferenceRecordSaved {
            record_id,
            title,
            area_id,
            fields,
        } => {
            let (title, fields) = crate::state::normalize_reference_text(title, fields)?;
            payload.extend_from_slice(&record_id.0);
            payload.extend_from_slice(&area_id.map_or([0; 16], |id| id.0));
            payload.extend_from_slice(&(title.len() as u16).to_le_bytes());
            payload.push(fields.len() as u8);
            payload.push(0);
            payload.extend_from_slice(title.as_bytes());
            for field in fields {
                payload.extend_from_slice(&field.field_id.0);
                payload.extend_from_slice(&(field.label.len() as u16).to_le_bytes());
                payload.extend_from_slice(&(field.value.len() as u16).to_le_bytes());
                payload.extend_from_slice(field.label.as_bytes());
                payload.extend_from_slice(field.value.as_bytes());
            }
        }
        EventKind::ReferenceRecordArchived { record_id } => payload.extend_from_slice(&record_id.0),
        EventKind::MaintenanceEventSaved {
            maintenance_id,
            record_id,
            performed_on,
            summary,
            next_on,
            routine_id,
        } => {
            let summary = crate::state::normalize_maintenance_summary(summary)?;
            payload.extend_from_slice(&maintenance_id.0);
            payload.extend_from_slice(&record_id.0);
            payload.extend_from_slice(&performed_on.encoded().to_le_bytes());
            payload.extend_from_slice(&next_on.map_or(0, |date| date.encoded()).to_le_bytes());
            payload.extend_from_slice(&routine_id.map_or([0; 16], |id| id.0));
            payload.extend_from_slice(&(summary.len() as u16).to_le_bytes());
            payload.extend_from_slice(summary.as_bytes());
        }
        EventKind::MaintenanceEventArchived { maintenance_id } => {
            payload.extend_from_slice(&maintenance_id.0)
        }
        EventKind::AttachmentBound {
            attachment_id,
            parent_kind,
            parent_id,
        } => {
            payload.extend_from_slice(&attachment_id.0);
            payload.push(*parent_kind as u8);
            payload.extend_from_slice(parent_id);
        }
        EventKind::AttachmentRemoved { attachment_id } => {
            payload.extend_from_slice(&attachment_id.0)
        }
        EventKind::ResponsibilityChanged {
            target_kind,
            target_id,
            member_id,
        } => {
            if *target_id == [0; 16] || member_id.is_some_and(|id| id.0 == [0; 16]) {
                return Err(KinError::MalformedProtocol);
            }
            payload.push(*target_kind as u8);
            payload.extend_from_slice(target_id);
            payload.extend_from_slice(&member_id.map_or([0; 16], |id| id.0));
        }
        EventKind::DeviceDescribed { auto_name } => {
            let name = crate::state::normalize_device_name(auto_name)?;
            payload.extend_from_slice(&(name.len() as u32).to_le_bytes());
            payload.extend_from_slice(name.as_bytes());
        }
        EventKind::DeviceNicknamed {
            device_id,
            nickname,
        } => {
            if device_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&device_id.0);
            match nickname {
                Some(nickname) => {
                    let nickname = crate::state::normalize_device_nickname(nickname)?;
                    payload.extend_from_slice(&(nickname.len() as u32).to_le_bytes());
                    payload.extend_from_slice(nickname.as_bytes());
                }
                None => payload.extend_from_slice(&0u32.to_le_bytes()),
            }
        }
        // A member's preferred name (#224): u32 length, then UTF-8; length 0
        // clears it.
        EventKind::MemberNamed { name } => match name {
            Some(name) => {
                let name = crate::state::normalize_member_name(name)?;
                payload.extend_from_slice(&(name.len() as u32).to_le_bytes());
                payload.extend_from_slice(name.as_bytes());
            }
            None => payload.extend_from_slice(&0u32.to_le_bytes()),
        },
        // Chat (#109): message ID, then the blob reference and key.
        EventKind::ChatMessagePosted {
            message_id,
            content_kind,
            blob_ref,
            blob_key,
            reply_to,
            mentions,
        } => {
            if message_id.0 == [0; 16]
                || *blob_ref == [0; 32]
                || *blob_key == [0; 32]
                || !mentions.is_valid()
                || reply_to.is_some_and(|reply| reply.0 == [0; 16] || reply == *message_id)
            {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&message_id.0);
            // A poll (#135) keeps its option count and multiple-choice flag in
            // the bytes that are zero for every other kind.
            let (options, multiple) = match content_kind {
                crate::event::ChatContentKind::Poll(spec) if spec.is_valid() => {
                    (spec.options, u8::from(spec.multiple))
                }
                crate::event::ChatContentKind::Poll(_) => return Err(KinError::MalformedProtocol),
                _ => (0, 0),
            };
            payload.extend_from_slice(&[content_kind.code(), options, multiple, 0]);
            payload.extend_from_slice(blob_ref);
            payload.extend_from_slice(blob_key);
            // A reply adds the quoted message's ID (#129), mentions their
            // list (#130).
            payload.extend_from_slice(&mentions.encode_tail(reply_to.as_ref()));
        }
        EventKind::ChatMessageEdited {
            message_id,
            blob_ref,
            blob_key,
            mentions,
        } => {
            if message_id.0 == [0; 16]
                || *blob_ref == [0; 32]
                || *blob_key == [0; 32]
                || !mentions.is_valid()
            {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&message_id.0);
            payload.extend_from_slice(blob_ref);
            payload.extend_from_slice(blob_key);
            payload.extend_from_slice(&mentions.encode_tail(None));
        }
        EventKind::ChatMessageDeleted {
            message_id,
            by_admin,
        } => {
            if message_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&message_id.0);
            payload.extend_from_slice(&[u8::from(*by_admin), 0, 0, 0]);
        }
        // Reaction (#127): message ID, on u8 and 3 reserved, emoji length
        // u32, the emoji's UTF-8.
        EventKind::ChatReactionSet {
            message_id,
            emoji,
            on,
        } => {
            if message_id.0 == [0; 16] || crate::chat::check_emoji(emoji).is_err() {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&message_id.0);
            payload.extend_from_slice(&[u8::from(*on), 0, 0, 0]);
            payload.extend_from_slice(&(emoji.len() as u32).to_le_bytes());
            payload.extend_from_slice(emoji.as_bytes());
        }
        // Pin (#131): message ID, on u8 and 3 reserved.
        EventKind::ChatPinSet { message_id, on } => {
            if message_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&message_id.0);
            payload.extend_from_slice(&[u8::from(*on), 0, 0, 0]);
        }
        // Poll vote (#135): message ID, the chosen options as a u16 bit set
        // and 2 reserved.
        EventKind::ChatPollVote {
            message_id,
            options,
        } => {
            if message_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&message_id.0);
            payload.extend_from_slice(&options.to_le_bytes());
            payload.extend_from_slice(&[0, 0]);
        }
        // Poll closed (#135): message ID and 4 reserved.
        EventKind::ChatPollClosed { message_id } => {
            if message_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&message_id.0);
            payload.extend_from_slice(&[0; 4]);
        }
        // Topic (#312): message ID, state u8 (1 open, 2 resolved, 0 cleared)
        // and 3 reserved.
        EventKind::ChatTopicSet { message_id, state } => {
            if message_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&message_id.0);
            payload.extend_from_slice(&[state.code(), 0, 0, 0]);
        }
        // The fridge (#317): board.rs owns the payloads.
        kind @ (EventKind::BoardStrokeAdded { .. }
        | EventKind::BoardStrokeHidden { .. }
        | EventKind::BoardMagnetPlaced { .. }
        | EventKind::BoardMagnetMoved { .. }
        | EventKind::BoardMagnetHidden { .. }
        | EventKind::BoardCleared { .. }
        | EventKind::BoardClearUndone { .. }) => {
            payload = crate::board::encode_payload(kind)?;
        }
        // Meals (#333): meals.rs owns the payloads.
        kind @ (EventKind::RecipeSaved { .. }
        | EventKind::RecipeArchived { .. }
        | EventKind::DinnerSet { .. }
        | EventKind::DinnerCleared { .. }
        | EventKind::DinnerCookSet { .. }
        | EventKind::MealSet { .. }
        | EventKind::MealCleared { .. }
        | EventKind::RecipeFavouriteSet { .. }) => {
            payload = crate::meals::encode_payload(kind)?;
        }
        // Item emoji (#344): simple.rs owns the payload.
        kind @ EventKind::ItemEmojiSet { .. } => {
            payload = crate::simple::encode_payload(kind)?;
        }
        // Store sections (#411): store_sections.rs owns the payloads.
        kind @ (EventKind::ShoppingSectionsSet { .. } | EventKind::ItemSectionSet { .. }) => {
            payload = crate::store_sections::encode_payload(kind)?;
        }
        // Taking turns (#429): rotations.rs owns the payloads.
        kind @ (EventKind::RoutineRotationSet { .. } | EventKind::RoutineTurnSet { .. }) => {
            payload = crate::rotations::encode_payload(kind)?;
        }
        // The sitter page (#442): sitter.rs owns the payload.
        kind @ EventKind::SitterPageSet { .. } => {
            payload = crate::sitter::encode_payload(kind)?;
        }
        // The family album (#673): album.rs owns the payloads.
        kind @ (EventKind::AlbumPhotoAdded { .. } | EventKind::AlbumPhotoRemoved { .. }) => {
            payload = crate::album::encode_payload(kind)?;
        }
        // The family calendar (#656): calendar.rs owns the payloads.
        kind @ (EventKind::CalendarEventSaved(_)
        | EventKind::CalendarEventCancelled { .. }
        | EventKind::CalendarEventRestored { .. }
        | EventKind::MemberColourSet { .. }) => {
            payload = crate::calendar::encode_payload(kind)?;
        }
        // The chore chart (#676): chores.rs owns the payloads.
        kind @ (EventKind::ChorePointsSet { .. }
        | EventKind::ChoreRewardSet { .. }
        | EventKind::ChoreChartJoined { .. }) => {
            payload = crate::chores::encode_payload(kind)?;
        }
        // A member's private log (#489): private.rs owns the payloads.
        kind @ (EventKind::PrivateNoteSet { .. }
        | EventKind::PrivateItem(_)
        | EventKind::ReminderSet { .. }
        | EventKind::ReminderCleared { .. }
        | EventKind::SettingSet { .. }
        | EventKind::Journal(_)) => {
            payload = crate::private::encode_payload(kind)?;
        }
    }
    let mut bytes = Vec::with_capacity(88 + payload.len());
    bytes.extend_from_slice(&event.event_version.to_le_bytes());
    bytes.extend_from_slice(&kind_code(&event.kind).to_le_bytes());
    bytes.extend_from_slice(&event.event_id.0);
    bytes.extend_from_slice(&event.household_id.0);
    bytes.extend_from_slice(&event.actor_id.0);
    bytes.extend_from_slice(&event.device_id.0);
    bytes.extend_from_slice(&event.timestamp.to_le_bytes());
    bytes.extend_from_slice(&event.logical_time.to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&payload);
    decode_event(&bytes)?;
    Ok(bytes)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventMetadata {
    pub event_id: EventId,
    pub household_id: HouseholdId,
    pub actor_id: ActorId,
    pub device_id: DeviceId,
    pub timestamp: i64,
    pub logical_time: u64,
    pub event_version: u16,
    pub kind: u16,
}

pub fn metadata(bytes: &[u8]) -> Result<EventMetadata, KinError> {
    let event = decode_event(bytes)?;
    Ok(EventMetadata {
        event_id: event.event_id,
        household_id: event.household_id,
        actor_id: event.actor_id,
        device_id: event.device_id,
        timestamp: event.timestamp,
        logical_time: event.logical_time,
        event_version: event.event_version,
        kind: kind_code(&event.kind),
    })
}

pub fn encode_metadata(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    let m = metadata(bytes)?;
    let mut output = Vec::with_capacity(92);
    output.extend_from_slice(b"KMET\x01\0\0\0");
    output.extend_from_slice(&m.event_id.0);
    output.extend_from_slice(&m.household_id.0);
    output.extend_from_slice(&m.actor_id.0);
    output.extend_from_slice(&m.device_id.0);
    output.extend_from_slice(&m.timestamp.to_le_bytes());
    output.extend_from_slice(&m.logical_time.to_le_bytes());
    output.extend_from_slice(&m.event_version.to_le_bytes());
    output.extend_from_slice(&m.kind.to_le_bytes());
    Ok(output)
}

/// A complete batch is validated before returning metadata. Each source record
/// remains authoritative; there is no partial result for a corrupt row.
pub fn encode_metadata_batch(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    use crate::wire::{MAX_EVENT_COUNT, MAX_PROTOCOL_BYTES};
    if bytes.len() < 12 || bytes.len() > MAX_PROTOCOL_BYTES || &bytes[..4] != b"KMDQ" {
        return Err(KinError::MalformedProtocol);
    }
    if bytes[4..6] != [1, 0] {
        return Err(KinError::UnsupportedVersion);
    }
    if bytes[6..8] != [0; 2] {
        return Err(KinError::MalformedProtocol);
    }
    let count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if count > MAX_EVENT_COUNT {
        return Err(KinError::SizeLimit);
    }
    let mut output = Vec::with_capacity(12 + 92 * count);
    output.extend_from_slice(b"KMDL\x01\0\0\0");
    output.extend_from_slice(&(count as u32).to_le_bytes());
    let mut offset = 12usize;
    for _ in 0..count {
        let length_bytes = bytes
            .get(offset..offset + 4)
            .ok_or(KinError::MalformedProtocol)?;
        let length = u32::from_le_bytes(length_bytes.try_into().unwrap()) as usize;
        offset += 4;
        let end = offset
            .checked_add(length)
            .ok_or(KinError::MalformedProtocol)?;
        output.extend_from_slice(&encode_metadata(
            bytes.get(offset..end).ok_or(KinError::MalformedProtocol)?,
        )?);
        offset = end;
    }
    if offset != bytes.len() {
        return Err(KinError::MalformedProtocol);
    }
    Ok(output)
}
