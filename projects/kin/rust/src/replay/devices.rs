//! Replay of device names (#71).
//!
//! Device names are cosmetic, so no device-name event ever fails replay once
//! it has decoded: an event that conflicts with what this history already
//! knows is kept and changes nothing. The strict rules are enforced when a
//! command creates the event (`command::execute_with`).
//!
//! `DeviceDescribed` records the automatic name a device announces for
//! itself: the device is the event's header device and its member is the
//! header actor, both after identity bindings. A device keeps the member that
//! first described it; a later description from another member changes
//! nothing. A device may describe itself again (a browser update changes its
//! name), and the latest description in replay order wins.
//!
//! `DeviceNicknamed` sets or clears a nickname, and only the device's member
//! may give one. A member who joined later never receives descriptions made
//! before they joined (history starts at their first key epoch), so a
//! nickname can arrive for a device this history has never seen described.
//! It is kept as a nickname-only entry owned by its author (and dropped
//! again if that nickname is cleared). A later
//! description by the same member completes it; one by another member wins,
//! as the description names its own device, and drops the nickname.
//!
//! `MemberNamed` (#224) sets or clears the header actor's own preferred
//! display name. Nobody can name another member: the name always belongs to
//! the event's (bound) actor. The latest event in replay order wins, so every
//! device converges on the same name; a cleared name removes the entry and
//! hosts fall back to their existing member labels.
//!
//! Names are canonical by the time they get here: the decoder rejects
//! anything `normalize_device_name`, `normalize_device_nickname` or
//! `normalize_member_name` would change.
use super::*;

pub(super) fn apply(r: &mut Replay, event: &EventEnvelope) -> Result<(), KinError> {
    match &event.kind {
        EventKind::DeviceDescribed { auto_name } => {
            if event.device_id.0 == [0; 16] || event.actor_id.0 == [0; 16] {
                return Err(KinError::InvalidEvent);
            }
            match r.devices.get_mut(&event.device_id) {
                Some(device) if device.member_id == event.actor_id => {
                    device.auto_name = Some(auto_name.clone());
                }
                // Only a nickname-only entry: the description is authoritative.
                Some(device) if device.auto_name.is_none() => {
                    device.member_id = event.actor_id;
                    device.auto_name = Some(auto_name.clone());
                    device.nickname = None;
                }
                Some(_) => {}
                None => {
                    r.devices.insert(
                        event.device_id,
                        DeviceNameState {
                            device_id: event.device_id,
                            member_id: event.actor_id,
                            auto_name: Some(auto_name.clone()),
                            nickname: None,
                        },
                    );
                }
            }
        }
        EventKind::DeviceNicknamed {
            device_id,
            nickname,
        } => match r.devices.get_mut(device_id) {
            // Clearing the only name this history has for a device leaves
            // nothing to show, so the entry goes: every entry has a name.
            Some(device)
                if device.member_id == event.actor_id
                    && device.auto_name.is_none()
                    && nickname.is_none() =>
            {
                r.devices.remove(device_id);
            }
            Some(device) if device.member_id == event.actor_id => {
                device.nickname.clone_from(nickname)
            }
            Some(_) => {}
            None if nickname.is_none() => {}
            None => {
                r.devices.insert(
                    *device_id,
                    DeviceNameState {
                        device_id: *device_id,
                        member_id: event.actor_id,
                        auto_name: None,
                        nickname: nickname.clone(),
                    },
                );
            }
        },
        EventKind::MemberNamed { name } => {
            if event.actor_id.0 == [0; 16] {
                return Err(KinError::InvalidEvent);
            }
            match name {
                Some(name) => {
                    r.member_names.insert(event.actor_id, name.clone());
                }
                None => {
                    r.member_names.remove(&event.actor_id);
                }
            }
        }
        _ => return Err(KinError::Internal),
    }
    Ok(())
}
