//! Protocol-24 canonical event decoding. Event bytes are immutable history:
//! decoding validates them and never rewrites them.
use crate::error::KinError;
use crate::event::{
    valid_timestamp, ActorId, AttachmentId, AttachmentParentKind, ChatContentKind, ChatMessageId,
    DeviceId, EventEnvelope, EventId, EventKind, HandoffId, HouseholdId, HouseholdMode,
    ItemClassification, ItemId, MaintenanceEventId, PinTargetKind, PulseValue, ReferenceFieldId,
    ReferenceRecordId, ResponsibilityTargetKind, RoutineId, TalkId,
};
use crate::recurrence::{Cadence, CivilDate};
use crate::wire::{
    read_i64, read_id, read_u16, read_u32, read_u64, EVENT_HEADER_BYTES, MAX_ITEM_TEXT_BYTES,
    MAX_PROTOCOL_BYTES,
};

/// A canonical event record read in place: the fixed header fields and the
/// payload slice, without copying or decoding the payload. Header layout
/// (88 bytes): version u16 @0, kind u16 @2, event ID @4, household @20,
/// actor @36, device @52 (16 bytes each), timestamp i64 @68, logical time
/// u64 @76, payload length u32 @84.
///
/// `new` checks only the framing (header present, payload length exact).
/// The history an engine holds checks every record fully (`decode_event`)
/// when it is appended, so views of it are views of valid events; `decode`
/// gives the owned event when a reducer needs one.
#[derive(Clone, Copy, Debug)]
pub struct EventView<'a> {
    bytes: &'a [u8],
}

impl<'a> EventView<'a> {
    pub fn new(bytes: &'a [u8]) -> Result<Self, KinError> {
        if bytes.len() < EVENT_HEADER_BYTES
            || read_u32(bytes, 84)? as usize != bytes.len() - EVENT_HEADER_BYTES
        {
            return Err(KinError::MalformedProtocol);
        }
        Ok(Self { bytes })
    }

    pub fn bytes(&self) -> &'a [u8] {
        self.bytes
    }

    /// (event schema version, event kind code).
    pub fn kind_code(&self) -> (u16, u16) {
        (
            u16::from_le_bytes([self.bytes[0], self.bytes[1]]),
            u16::from_le_bytes([self.bytes[2], self.bytes[3]]),
        )
    }

    pub fn event_id(&self) -> EventId {
        EventId(self.id_at(4))
    }

    pub fn logical_time(&self) -> u64 {
        u64::from_le_bytes(self.bytes[76..84].try_into().unwrap_or([0; 8]))
    }

    pub fn payload(&self) -> &'a [u8] {
        &self.bytes[EVENT_HEADER_BYTES..]
    }

    /// The owned, fully validated event.
    pub fn decode(&self) -> Result<EventEnvelope, KinError> {
        decode_event(self.bytes)
    }

    fn id_at(&self, offset: usize) -> [u8; 16] {
        self.bytes[offset..offset + 16]
            .try_into()
            .unwrap_or([0; 16])
    }
}

/// Decodes one canonical protocol-24 event record. `canonical_bytes` keeps an
/// exact copy of the record; the envelope's identity fields are decoded from it.
pub fn decode_event(record: &[u8]) -> Result<EventEnvelope, KinError> {
    if record.len() > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    if record.len() < EVENT_HEADER_BYTES {
        return Err(KinError::MalformedProtocol);
    }
    // Every kind uses event schema 1 except ITEM_ADDED, which uses schema 2.
    let event_version = read_u16(record, 0)?;
    if !matches!(event_version, 1 | 2) {
        return Err(KinError::UnsupportedVersion);
    }
    let event_kind = read_u16(record, 2)?;
    let payload_length = read_u32(record, 84)? as usize;
    let expected_length = EVENT_HEADER_BYTES
        .checked_add(payload_length)
        .ok_or(KinError::MalformedProtocol)?;
    if record.len() != expected_length {
        return Err(KinError::MalformedProtocol);
    }

    let payload = &record[EVENT_HEADER_BYTES..];
    let kind = match (event_version, event_kind) {
        (1, 14) => {
            if payload.len() < 28
                || payload[17..20] != [0; 3]
                || !valid_timestamp(read_i64(record, 68)?)
            {
                return Err(KinError::MalformedProtocol);
            }
            let length = read_u32(payload, 24)? as usize;
            if !(1..=MAX_ITEM_TEXT_BYTES).contains(&length) || payload.len() != 28 + length {
                return Err(KinError::MalformedProtocol);
            }
            let cadence = Cadence::try_from(payload[16])?;
            EventKind::RoutineCreated {
                routine_id: RoutineId(read_id(payload, 0)?),
                cadence,
                created_on: CivilDate::from_encoded(read_u32(payload, 20)?)?,
                text: std::str::from_utf8(&payload[28..])
                    .map_err(|_| KinError::MalformedProtocol)?
                    .to_owned(),
            }
        }
        (1, 18..=21) => match event_kind {
            18 | 19 => {
                if payload.len() < 20 {
                    return Err(KinError::MalformedProtocol);
                }
                let length = read_u32(payload, 16)? as usize;
                if !(1..=96).contains(&length) || payload.len() != 20 + length {
                    return Err(KinError::MalformedProtocol);
                }
                let name = std::str::from_utf8(&payload[20..])
                    .map_err(|_| KinError::MalformedProtocol)?
                    .to_owned();
                if event_kind == 18 {
                    EventKind::AreaCreated {
                        area_id: crate::event::AreaId(read_id(payload, 0)?),
                        name,
                    }
                } else {
                    EventKind::AreaRenamed {
                        area_id: crate::event::AreaId(read_id(payload, 0)?),
                        name,
                    }
                }
            }
            20 => {
                if payload.len() != 16 {
                    return Err(KinError::MalformedProtocol);
                }
                EventKind::AreaArchived {
                    area_id: crate::event::AreaId(read_id(payload, 0)?),
                }
            }
            _ => {
                if payload.len() != 32 {
                    return Err(KinError::MalformedProtocol);
                }
                let id = read_id(payload, 16)?;
                EventKind::ItemAreaChanged {
                    item_id: ItemId(read_id(payload, 0)?),
                    area_id: (id != [0; 16]).then_some(crate::event::AreaId(id)),
                }
            }
        },
        (1, 22..=24) => match event_kind {
            24 if payload.len() == 16 => EventKind::NoteArchived {
                note_id: crate::event::NoteId(read_id(payload, 0)?),
            },
            22 | 23 if payload.len() >= 40 => {
                let title_len = read_u32(payload, 32)? as usize;
                let body_len = read_u32(payload, 36)? as usize;
                if title_len > crate::state::MAX_NOTE_TITLE_BYTES
                    || body_len > crate::state::MAX_NOTE_BODY_BYTES
                    || payload.len() != 40 + title_len + body_len
                {
                    return Err(KinError::MalformedProtocol);
                }
                let title = std::str::from_utf8(&payload[40..40 + title_len])
                    .map_err(|_| KinError::MalformedProtocol)?
                    .to_owned();
                let body = std::str::from_utf8(&payload[40 + title_len..])
                    .map_err(|_| KinError::MalformedProtocol)?
                    .to_owned();
                let raw = read_id(payload, 16)?;
                let area_id = (raw != [0; 16]).then_some(crate::event::AreaId(raw));
                if event_kind == 22 {
                    EventKind::NoteCreated {
                        note_id: crate::event::NoteId(read_id(payload, 0)?),
                        title,
                        body,
                        area_id,
                    }
                } else {
                    EventKind::NoteUpdated {
                        note_id: crate::event::NoteId(read_id(payload, 0)?),
                        title,
                        body,
                        area_id,
                    }
                }
            }
            _ => return Err(KinError::MalformedProtocol),
        },
        (1, 25..=28) => match event_kind {
            25 if payload.len() >= 37 => {
                let text_length = read_u32(payload, 32)? as usize;
                if !(1..=crate::state::MAX_STEP_TEXT_BYTES).contains(&text_length)
                    || payload.len() != 36 + text_length
                {
                    return Err(KinError::MalformedProtocol);
                }
                EventKind::ItemStepAdded {
                    item_id: ItemId(read_id(payload, 0)?),
                    step_id: crate::event::StepId(read_id(payload, 16)?),
                    text: std::str::from_utf8(&payload[36..])
                        .map_err(|_| KinError::MalformedProtocol)?
                        .to_owned(),
                }
            }
            26..=28 if payload.len() == 32 => {
                let item_id = ItemId(read_id(payload, 0)?);
                let step_id = crate::event::StepId(read_id(payload, 16)?);
                match event_kind {
                    26 => EventKind::ItemStepCompleted { item_id, step_id },
                    27 => EventKind::ItemStepReopened { item_id, step_id },
                    _ => EventKind::ItemStepArchived { item_id, step_id },
                }
            }
            _ => return Err(KinError::MalformedProtocol),
        },
        (1, 29) => {
            if payload.len() != 1 {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::HouseholdModeChanged {
                mode: match payload[0] {
                    0 => HouseholdMode::Normal,
                    1 => HouseholdMode::Vacation,
                    2 => HouseholdMode::Guests,
                    3 => HouseholdMode::Rest,
                    _ => return Err(KinError::MalformedProtocol),
                },
            }
        }
        (1, 30) => {
            if payload.len() != 20 {
                return Err(KinError::MalformedProtocol);
            }
            let encoded_date = read_u32(payload, 16)?;
            EventKind::ItemPlanningDateChanged {
                item_id: ItemId(read_id(payload, 0)?),
                planning_date: (encoded_date != 0)
                    .then(|| CivilDate::from_encoded(encoded_date))
                    .transpose()?,
            }
        }
        (1, 31 | 32) => {
            if payload.len() != 20 || payload[1..4] != [0; 3] {
                return Err(KinError::MalformedProtocol);
            }
            let target_kind = match payload[0] {
                1 => PinTargetKind::Item,
                2 => PinTargetKind::Note,
                3 => PinTargetKind::Routine,
                4 => PinTargetKind::Area,
                _ => return Err(KinError::MalformedProtocol),
            };
            let target_id = read_id(payload, 4)?;
            if target_id == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            if event_kind == 31 {
                EventKind::PinAdded {
                    target_kind,
                    target_id,
                }
            } else {
                EventKind::PinRemoved {
                    target_kind,
                    target_id,
                }
            }
        }
        (1, 33) => {
            if payload.len() < 20 || payload[19] != 0 {
                return Err(KinError::MalformedProtocol);
            }
            let title_len = u16::from_le_bytes(payload[16..18].try_into().unwrap()) as usize;
            let count = payload[18] as usize;
            if count == 0
                || count > crate::state::MAX_PLAYBOOK_ENTRIES
                || title_len == 0
                || title_len > crate::state::MAX_PLAYBOOK_TITLE_BYTES
            {
                return Err(KinError::MalformedProtocol);
            }
            let mut offset = 20usize;
            let title_end = offset
                .checked_add(title_len)
                .ok_or(KinError::MalformedProtocol)?;
            let title = std::str::from_utf8(
                payload
                    .get(offset..title_end)
                    .ok_or(KinError::MalformedProtocol)?,
            )
            .map_err(|_| KinError::MalformedProtocol)?
            .to_owned();
            offset = title_end;
            let mut entries = Vec::with_capacity(count);
            for _ in 0..count {
                let len = u16::from_le_bytes(
                    payload
                        .get(offset..offset + 2)
                        .ok_or(KinError::MalformedProtocol)?
                        .try_into()
                        .unwrap(),
                ) as usize;
                offset += 2;
                let end = offset.checked_add(len).ok_or(KinError::MalformedProtocol)?;
                entries.push(
                    std::str::from_utf8(
                        payload
                            .get(offset..end)
                            .ok_or(KinError::MalformedProtocol)?,
                    )
                    .map_err(|_| KinError::MalformedProtocol)?
                    .to_owned(),
                );
                offset = end;
            }
            if offset != payload.len() {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::PlaybookSaved {
                playbook_id: crate::event::PlaybookId(read_id(payload, 0)?),
                title,
                entries,
            }
        }
        (1, 34) if payload.len() == 16 => EventKind::PlaybookArchived {
            playbook_id: crate::event::PlaybookId(read_id(payload, 0)?),
        },
        (1, 35) => {
            if payload.len() < 36
                || payload[34] == 0
                || payload[34] as usize > crate::state::MAX_REFERENCE_FIELDS
                || payload[35] != 0
            {
                return Err(KinError::MalformedProtocol);
            }
            let record_id = ReferenceRecordId(read_id(payload, 0)?);
            let area = read_id(payload, 16)?;
            let title_len = read_u16(payload, 32)? as usize;
            if record_id.0 == [0; 16]
                || title_len == 0
                || title_len > crate::state::MAX_REFERENCE_TITLE_BYTES
            {
                return Err(KinError::MalformedProtocol);
            }
            let mut offset = 36usize;
            let title_end = offset
                .checked_add(title_len)
                .ok_or(KinError::MalformedProtocol)?;
            let title = std::str::from_utf8(
                payload
                    .get(offset..title_end)
                    .ok_or(KinError::MalformedProtocol)?,
            )
            .map_err(|_| KinError::MalformedProtocol)?
            .to_owned();
            offset = title_end;
            let mut fields = Vec::with_capacity(payload[34] as usize);
            for _ in 0..payload[34] {
                let id = ReferenceFieldId(read_id(payload, offset)?);
                let label_len = read_u16(payload, offset + 16)? as usize;
                let value_len = read_u16(payload, offset + 18)? as usize;
                offset += 20;
                if id.0 == [0; 16]
                    || label_len == 0
                    || label_len > crate::state::MAX_REFERENCE_LABEL_BYTES
                    || value_len > crate::state::MAX_REFERENCE_VALUE_BYTES
                {
                    return Err(KinError::MalformedProtocol);
                }
                let end = offset
                    .checked_add(label_len)
                    .and_then(|v| v.checked_add(value_len))
                    .ok_or(KinError::MalformedProtocol)?;
                let label_end = offset + label_len;
                let label = std::str::from_utf8(
                    payload
                        .get(offset..label_end)
                        .ok_or(KinError::MalformedProtocol)?,
                )
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
                let value = std::str::from_utf8(
                    payload
                        .get(label_end..end)
                        .ok_or(KinError::MalformedProtocol)?,
                )
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
                fields.push((id, label, value));
                offset = end;
            }
            if offset != payload.len() {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ReferenceRecordSaved {
                record_id,
                title,
                area_id: (area != [0; 16]).then_some(crate::event::AreaId(area)),
                fields,
            }
        }
        (1, 36) if payload.len() == 16 => {
            let record_id = ReferenceRecordId(read_id(payload, 0)?);
            if record_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ReferenceRecordArchived { record_id }
        }
        (1, 37) => {
            if payload.len() < 58 {
                return Err(KinError::MalformedProtocol);
            }
            let maintenance_id = MaintenanceEventId(read_id(payload, 0)?);
            let record_id = ReferenceRecordId(read_id(payload, 16)?);
            let performed_on = CivilDate::from_encoded(read_u32(payload, 32)?)?;
            let next_value = read_u32(payload, 36)?;
            let next_on = if next_value == 0 {
                None
            } else {
                Some(CivilDate::from_encoded(next_value)?)
            };
            let routine = read_id(payload, 40)?;
            let summary_len = read_u16(payload, 56)? as usize;
            if maintenance_id.0 == [0; 16]
                || record_id.0 == [0; 16]
                || summary_len == 0
                || summary_len > crate::state::MAX_MAINTENANCE_SUMMARY_BYTES
                || payload.len() != 58 + summary_len
            {
                return Err(KinError::MalformedProtocol);
            }
            let summary = std::str::from_utf8(&payload[58..])
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
            EventKind::MaintenanceEventSaved {
                maintenance_id,
                record_id,
                performed_on,
                summary,
                next_on,
                routine_id: (routine != [0; 16]).then_some(RoutineId(routine)),
            }
        }
        (1, 38) if payload.len() == 16 => {
            let maintenance_id = MaintenanceEventId(read_id(payload, 0)?);
            if maintenance_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::MaintenanceEventArchived { maintenance_id }
        }
        (1, 39) if payload.len() == 33 => {
            let attachment_id = AttachmentId(read_id(payload, 0)?);
            let parent_kind = match payload[16] {
                1 => AttachmentParentKind::Note,
                2 => AttachmentParentKind::ReferenceRecord,
                3 => AttachmentParentKind::Maintenance,
                4 => AttachmentParentKind::Item,
                _ => return Err(KinError::MalformedProtocol),
            };
            let parent_id = read_id(payload, 17)?;
            if attachment_id.0 == [0; 16] || parent_id == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::AttachmentBound {
                attachment_id,
                parent_kind,
                parent_id,
            }
        }
        (1, 40) if payload.len() == 16 => {
            let attachment_id = AttachmentId(read_id(payload, 0)?);
            if attachment_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::AttachmentRemoved { attachment_id }
        }
        (1, 41) if payload.len() == 33 => {
            let target_kind = match payload[0] {
                1 => ResponsibilityTargetKind::Item,
                2 => ResponsibilityTargetKind::Routine,
                _ => return Err(KinError::MalformedProtocol),
            };
            let target_id = read_id(payload, 1)?;
            let member = read_id(payload, 17)?;
            if target_id == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ResponsibilityChanged {
                target_kind,
                target_id,
                member_id: (member != [0; 16]).then_some(ActorId(member)),
            }
        }
        (1, 42) => {
            let auto_name = device_text(payload, 0)?.ok_or(KinError::MalformedProtocol)?;
            if crate::state::normalize_device_name(auto_name)
                .ok()
                .as_deref()
                != Some(auto_name)
            {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::DeviceDescribed {
                auto_name: auto_name.to_owned(),
            }
        }
        (1, 43) => {
            let device_id = DeviceId(read_id(payload, 0)?);
            if device_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            let nickname = match device_text(payload, 16)? {
                Some(nickname) => {
                    if crate::state::normalize_device_nickname(nickname)
                        .ok()
                        .as_deref()
                        != Some(nickname)
                    {
                        return Err(KinError::MalformedProtocol);
                    }
                    Some(nickname.to_owned())
                }
                None => None,
            };
            EventKind::DeviceNicknamed {
                device_id,
                nickname,
            }
        }
        // A member's preferred name (#224): length 0 clears it; a name must
        // already be canonical.
        (1, 51) => {
            let name = match device_text(payload, 0)? {
                Some(name) => {
                    if crate::state::normalize_member_name(name).ok().as_deref() != Some(name) {
                        return Err(KinError::MalformedProtocol);
                    }
                    Some(name.to_owned())
                }
                None => None,
            };
            EventKind::MemberNamed { name }
        }
        // The fridge (#317): board.rs decodes its payloads strictly.
        (1, code) if crate::board::is_board_code(code) => {
            if !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            crate::board::decode_payload(code, payload)?
        }
        // Item emoji (#344): simple.rs decodes its payload strictly.
        (1, code) if crate::simple::is_simple_code(code) => {
            if !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            crate::simple::decode_payload(code, payload)?
        }
        // Store sections (#411): store_sections.rs decodes its payloads
        // strictly.
        (1, code) if crate::store_sections::is_sections_code(code) => {
            if !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            crate::store_sections::decode_payload(code, payload)?
        }
        // Taking turns (#429): rotations.rs decodes its payloads strictly.
        (1, code) if crate::rotations::is_rotation_code(code) => {
            if !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            crate::rotations::decode_payload(code, payload)?
        }
        // The sitter page (#442): sitter.rs decodes its payload strictly.
        (1, code) if crate::sitter::is_sitter_code(code) => {
            if !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            crate::sitter::decode_payload(code, payload)?
        }
        // The family album (#673): album.rs decodes its payloads strictly.
        (1, code) if crate::album::is_album_code(code) => {
            if !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            crate::album::decode_payload(code, payload)?
        }
        // The family calendar (#656): calendar.rs decodes its payloads
        // strictly.
        (1, code) if crate::calendar::is_calendar_code(code) => {
            if !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            crate::calendar::decode_payload(code, payload)?
        }
        // The chore chart (#676): chores.rs decodes its payloads strictly.
        (1, code) if crate::chores::is_chore_code(code) => {
            if !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            crate::chores::decode_payload(code, payload)?
        }
        // A member's private log (#489, kinds 100–199): private.rs decodes
        // its payloads strictly.
        (1, code) if crate::private::is_private_code(code) => {
            if !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            crate::private::decode_payload(code, payload)?
        }
        // Meals (#333): meals.rs decodes its payloads strictly.
        (1, code) if crate::meals::is_meals_code(code) => {
            if !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            crate::meals::decode_payload(code, payload)?
        }
        // Chat (#109). IDs, blob references and keys are never zero.
        (1, 44) => {
            if payload.len() < 84 || !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            let message_id = ChatMessageId(read_id(payload, 0)?);
            // Bytes 17..20 are zero except for a poll (#135): its option
            // count, a multiple-choice flag (0 or 1) and a zero.
            let content_kind = match payload[16] {
                1 if payload[17..20] == [0; 3] => ChatContentKind::Text,
                2 if payload[17..20] == [0; 3] => ChatContentKind::Attachment,
                3 if payload[19] == 0 && payload[18] <= 1 => {
                    let spec = crate::chat::PollSpec {
                        options: payload[17],
                        multiple: payload[18] == 1,
                    };
                    if !spec.is_valid() {
                        return Err(KinError::MalformedProtocol);
                    }
                    ChatContentKind::Poll(spec)
                }
                _ => return Err(KinError::MalformedProtocol),
            };
            let blob_ref = read_32(payload, 20)?;
            let blob_key = read_32(payload, 52)?;
            // After the fixed 84 bytes: a reply's ID and/or mentions (#129, #130).
            let (mentions, reply_to) =
                crate::chat::ChatMentions::decode_tail(&payload[84..], true)?;
            if message_id.0 == [0; 16]
                || blob_ref == [0; 32]
                || blob_key == [0; 32]
                || reply_to.is_some_and(|reply| reply == message_id)
            {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ChatMessagePosted {
                message_id,
                content_kind,
                blob_ref,
                blob_key,
                reply_to,
                mentions,
            }
        }
        (1, 45) => {
            if payload.len() < 80 || !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            let message_id = ChatMessageId(read_id(payload, 0)?);
            let blob_ref = read_32(payload, 16)?;
            let blob_key = read_32(payload, 48)?;
            let (mentions, _) = crate::chat::ChatMentions::decode_tail(&payload[80..], false)?;
            if message_id.0 == [0; 16] || blob_ref == [0; 32] || blob_key == [0; 32] {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ChatMessageEdited {
                message_id,
                blob_ref,
                blob_key,
                mentions,
            }
        }
        (1, 46) => {
            if payload.len() != 20
                || payload[17..20] != [0; 3]
                || payload[16] > 1
                || !valid_timestamp(read_i64(record, 68)?)
            {
                return Err(KinError::MalformedProtocol);
            }
            let message_id = ChatMessageId(read_id(payload, 0)?);
            if message_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ChatMessageDeleted {
                message_id,
                by_admin: payload[16] == 1,
            }
        }
        (1, 47) => {
            if payload.len() < 25
                || payload.len() > 24 + crate::chat::MAX_EMOJI_BYTES
                || payload[17..20] != [0; 3]
                || payload[16] > 1
                || !valid_timestamp(read_i64(record, 68)?)
            {
                return Err(KinError::MalformedProtocol);
            }
            let message_id = ChatMessageId(read_id(payload, 0)?);
            let length = read_u32(payload, 20)? as usize;
            if message_id.0 == [0; 16] || payload.len() != 24 + length {
                return Err(KinError::MalformedProtocol);
            }
            let emoji =
                std::str::from_utf8(&payload[24..]).map_err(|_| KinError::MalformedProtocol)?;
            crate::chat::check_emoji(emoji).map_err(|_| KinError::MalformedProtocol)?;
            EventKind::ChatReactionSet {
                message_id,
                emoji: emoji.to_owned(),
                on: payload[16] == 1,
            }
        }
        (1, 48) => {
            if payload.len() != 20
                || payload[17..20] != [0; 3]
                || payload[16] > 1
                || !valid_timestamp(read_i64(record, 68)?)
            {
                return Err(KinError::MalformedProtocol);
            }
            let message_id = ChatMessageId(read_id(payload, 0)?);
            if message_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ChatPinSet {
                message_id,
                on: payload[16] == 1,
            }
        }
        (1, 49) => {
            if payload.len() != 20
                || payload[18..20] != [0; 2]
                || !valid_timestamp(read_i64(record, 68)?)
            {
                return Err(KinError::MalformedProtocol);
            }
            let message_id = ChatMessageId(read_id(payload, 0)?);
            if message_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ChatPollVote {
                message_id,
                options: u16::from_le_bytes([payload[16], payload[17]]),
            }
        }
        (1, 50) => {
            if payload.len() != 20
                || payload[16..20] != [0; 4]
                || !valid_timestamp(read_i64(record, 68)?)
            {
                return Err(KinError::MalformedProtocol);
            }
            let message_id = ChatMessageId(read_id(payload, 0)?);
            if message_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ChatPollClosed { message_id }
        }
        // Topic (#312): message ID, state u8 (0 cleared, 1 open, 2
        // resolved), 3 reserved.
        (1, crate::chat::CHAT_TOPIC_SET) => {
            if payload.len() != 20
                || payload[17..20] != [0; 3]
                || !valid_timestamp(read_i64(record, 68)?)
            {
                return Err(KinError::MalformedProtocol);
            }
            let message_id = ChatMessageId(read_id(payload, 0)?);
            let state = crate::chat::ChatTopicState::from_code(payload[16])
                .ok_or(KinError::MalformedProtocol)?;
            if message_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ChatTopicSet { message_id, state }
        }
        (1, 15..=17) => {
            if payload.len() != if event_kind == 17 { 16 } else { 20 }
                || !valid_timestamp(read_i64(record, 68)?)
            {
                return Err(KinError::MalformedProtocol);
            }
            let routine_id = RoutineId(read_id(payload, 0)?);
            if event_kind == 17 {
                EventKind::RoutineArchived { routine_id }
            } else {
                let key = CivilDate::from_encoded(read_u32(payload, 16)?)?;
                if event_kind == 15 {
                    EventKind::RoutineOccurrenceCompleted { routine_id, key }
                } else {
                    EventKind::RoutineOccurrenceReopened { routine_id, key }
                }
            }
        }
        (1, 12) => {
            if payload.len() != 16 || payload[1..8] != [0; 7] {
                return Err(KinError::MalformedProtocol);
            }
            let value = match payload[0] {
                0 => PulseValue::Good,
                1 => PulseValue::Okay,
                2 => PulseValue::Drained,
                3 => PulseValue::RoughDay,
                4 => PulseValue::NeedQuiet,
                _ => return Err(KinError::MalformedProtocol),
            };
            let expires_at = read_i64(payload, 8)?;
            if !valid_timestamp(expires_at) || !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::PulseSet { value, expires_at }
        }
        (1, 13) => {
            if !payload.is_empty() || !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::PulseCleared
        }
        (2, 1) => {
            if payload.len() < 24 {
                return Err(KinError::MalformedProtocol);
            }
            let classification = match payload[16] {
                0 => ItemClassification::Today,
                1 => ItemClassification::Need,
                2 => ItemClassification::Shopping,
                3 => ItemClassification::Staple,
                _ => return Err(KinError::MalformedProtocol),
            };
            if payload[17..20] != [0; 3] {
                return Err(KinError::MalformedProtocol);
            }
            let text_length = read_u32(payload, 20)? as usize;
            if !(1..=MAX_ITEM_TEXT_BYTES).contains(&text_length)
                || payload.len()
                    != 24usize
                        .checked_add(text_length)
                        .ok_or(KinError::MalformedProtocol)?
            {
                return Err(KinError::MalformedProtocol);
            }
            let decoded_text =
                std::str::from_utf8(&payload[24..]).map_err(|_| KinError::MalformedProtocol)?;
            let mut text = String::new();
            text.try_reserve_exact(text_length)
                .map_err(|_| KinError::SizeLimit)?;
            text.push_str(decoded_text);
            EventKind::ItemAdded {
                item_id: ItemId(read_id(payload, 0)?),
                text,
                classification,
            }
        }
        (1, 2) => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ItemCompleted {
                item_id: ItemId(read_id(payload, 0)?),
            }
        }
        (1, 3) => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ItemReopened {
                item_id: ItemId(read_id(payload, 0)?),
            }
        }
        (1, 4) => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ItemArchived {
                item_id: ItemId(read_id(payload, 0)?),
            }
        }
        (1, 5) => {
            if payload.len() < 20 {
                return Err(KinError::MalformedProtocol);
            }
            let length = read_u32(payload, 16)? as usize;
            if !(1..=MAX_ITEM_TEXT_BYTES).contains(&length)
                || payload.len()
                    != 20usize
                        .checked_add(length)
                        .ok_or(KinError::MalformedProtocol)?
            {
                return Err(KinError::MalformedProtocol);
            }
            let text =
                std::str::from_utf8(&payload[20..]).map_err(|_| KinError::MalformedProtocol)?;
            EventKind::HandoffAdded {
                handoff_id: HandoffId(read_id(payload, 0)?),
                text: text.to_owned(),
            }
        }
        (1, 6 | 7) => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            let handoff_id = HandoffId(read_id(payload, 0)?);
            if event_kind == 6 {
                EventKind::HandoffAcknowledged { handoff_id }
            } else {
                EventKind::HandoffArchived { handoff_id }
            }
        }
        (1, 8) => {
            if payload.len() < 20 {
                return Err(KinError::MalformedProtocol);
            }
            let length = read_u32(payload, 16)? as usize;
            if !(1..=MAX_ITEM_TEXT_BYTES).contains(&length)
                || payload.len()
                    != 20usize
                        .checked_add(length)
                        .ok_or(KinError::MalformedProtocol)?
            {
                return Err(KinError::MalformedProtocol);
            }
            let text =
                std::str::from_utf8(&payload[20..]).map_err(|_| KinError::MalformedProtocol)?;
            EventKind::TalkAdded {
                talk_id: TalkId(read_id(payload, 0)?),
                text: text.to_owned(),
            }
        }
        (1, 9..=11) => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            let talk_id = TalkId(read_id(payload, 0)?);
            if event_kind == 9 {
                EventKind::TalkResolved { talk_id }
            } else if event_kind == 10 {
                EventKind::TalkReopened { talk_id }
            } else {
                EventKind::TalkArchived { talk_id }
            }
        }
        _ => return Err(KinError::UnsupportedVersion),
    };

    let mut canonical_bytes = Vec::new();
    canonical_bytes
        .try_reserve_exact(record.len())
        .map_err(|_| KinError::SizeLimit)?;
    canonical_bytes.extend_from_slice(record);
    Ok(EventEnvelope {
        event_id: EventId(read_id(record, 4)?),
        household_id: HouseholdId(read_id(record, 20)?),
        actor_id: ActorId(read_id(record, 36)?),
        device_id: DeviceId(read_id(record, 52)?),
        timestamp: read_i64(record, 68)?,
        logical_time: read_u64(record, 76)?,
        event_version,
        kind,
        canonical_bytes,
    })
}

/// A device-name field: u32 length at `at`, then exactly that many UTF-8
/// bytes ending the payload. None for length 0 (a cleared nickname).
fn device_text(payload: &[u8], at: usize) -> Result<Option<&str>, KinError> {
    let length = read_u32(payload, at)? as usize;
    let start = at + 4;
    if payload.len() != start + length || length > crate::state::MAX_DEVICE_NAME_BYTES {
        return Err(KinError::MalformedProtocol);
    }
    if length == 0 {
        return Ok(None);
    }
    std::str::from_utf8(&payload[start..])
        .map(Some)
        .map_err(|_| KinError::MalformedProtocol)
}

/// 32 bytes at `offset` (blob references and keys).
fn read_32(bytes: &[u8], offset: usize) -> Result<[u8; 32], KinError> {
    bytes
        .get(offset..offset + 32)
        .and_then(|slice| slice.try_into().ok())
        .ok_or(KinError::MalformedProtocol)
}
