use crate::command::{execute, CommandContext, HouseholdCommand as C};
use crate::event::*;
use crate::event_decode::decode_event;
use crate::recurrence::CivilDate;
use crate::request::DecodedRequest;
use crate::state::rebuild;

fn ctx(n: u8, device: u8) -> CommandContext {
    CommandContext {
        event_id: EventId([n.wrapping_add(device); 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([device; 16]),
        timestamp: 1_791_475_200_000 + i64::from(n),
        logical_time: u64::from(n),
    }
}
fn req(events: Vec<EventEnvelope>) -> DecodedRequest {
    DecodedRequest {
        events,
        as_of: 1_791_475_200_000,
        summary_cursor: None,
        civil_date: CivilDate::from_encoded(20261009).unwrap(),
        target_household_id: None,
        identity_bindings: vec![],
    }
}
fn commit(
    events: &mut Vec<EventEnvelope>,
    command: C,
    n: u8,
) -> Result<(), crate::error::KinError> {
    let event = execute(&command, ctx(n, 3), req(events.clone()))?;
    events.push(event.event);
    Ok(())
}

#[test]
fn attachment_binding_is_canonical_bounded_and_removable() {
    let mut events = vec![];
    commit(
        &mut events,
        C::SaveReferenceRecord {
            id: ReferenceRecordId([4; 16]),
            title: "Furnace".into(),
            area_id: None,
            fields: vec![(ReferenceFieldId([5; 16]), "Model".into(), "A1".into())],
        },
        1,
    )
    .unwrap();
    let id = AttachmentId([8; 16]);
    commit(
        &mut events,
        C::BindAttachment {
            id,
            parent_kind: AttachmentParentKind::ReferenceRecord,
            parent_id: [4; 16],
        },
        2,
    )
    .unwrap();
    assert_eq!(decode_event(&events[1].canonical_bytes).unwrap(), events[1]);
    let state = rebuild(
        &events,
        1_791_475_200_003,
        CivilDate::from_encoded(20261009).unwrap(),
    )
    .unwrap();
    assert_eq!(state.attachments.len(), 1);
    assert!(!state.attachments[0].removed);
    commit(&mut events, C::RemoveAttachment(id), 3).unwrap();
    assert!(
        rebuild(
            &events,
            1_791_475_200_004,
            CivilDate::from_encoded(20261009).unwrap()
        )
        .unwrap()
        .attachments[0]
            .removed
    );
    assert!(commit(&mut events, C::RemoveAttachment(id), 4).is_err());
}

#[test]
fn attachment_binding_requires_a_known_parent_and_caps_per_parent() {
    let mut events = vec![];
    commit(
        &mut events,
        C::BindAttachment {
            id: AttachmentId([9; 16]),
            parent_kind: AttachmentParentKind::Item,
            parent_id: [4; 16],
        },
        1,
    )
    .unwrap_err();
    commit(
        &mut events,
        C::AddItem {
            id: ItemId([4; 16]),
            text: "Get filters".into(),
            classification: ItemClassification::Need,
        },
        1,
    )
    .unwrap();
    for number in 0..5u8 {
        commit(
            &mut events,
            C::BindAttachment {
                id: AttachmentId([number + 10; 16]),
                parent_kind: AttachmentParentKind::Item,
                parent_id: [4; 16],
            },
            number + 2,
        )
        .unwrap();
    }
    assert!(commit(
        &mut events,
        C::BindAttachment {
            id: AttachmentId([20; 16]),
            parent_kind: AttachmentParentKind::Item,
            parent_id: [4; 16]
        },
        8
    )
    .is_err());
}
