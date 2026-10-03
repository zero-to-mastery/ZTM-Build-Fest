use crate::recurrence::{Cadence, CivilDate};
use core::fmt;

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(pub [u8; 16]);

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                for byte in self.0 {
                    write!(formatter, "{byte:02x}")?;
                }
                Ok(())
            }
        }
    };
}

id_type!(EventId);
id_type!(HouseholdId);
id_type!(ActorId);
id_type!(DeviceId);
id_type!(ItemId);
id_type!(HandoffId);
id_type!(TalkId);
id_type!(RoutineId);

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct IdentityBinding {
    pub legacy_household_id: HouseholdId,
    pub legacy_actor_id: ActorId,
    pub legacy_device_id: DeviceId,
    pub household_id: HouseholdId,
    pub actor_id: ActorId,
    pub device_id: DeviceId,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ItemClassification {
    Today,
    Need,
}

// Protocol identifiers, never scores or severity levels.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum PulseValue {
    Good = 0,
    Okay = 1,
    Drained = 2,
    RoughDay = 3,
    NeedQuiet = 4,
}

pub const MAX_TIMESTAMP: i64 = 8_640_000_000_000_000;
pub fn valid_timestamp(value: i64) -> bool {
    (-MAX_TIMESTAMP..=MAX_TIMESTAMP).contains(&value)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EventKind {
    RoutineCreated {
        routine_id: RoutineId,
        text: String,
        cadence: Cadence,
        created_on: CivilDate,
    },
    RoutineOccurrenceCompleted {
        routine_id: RoutineId,
        key: CivilDate,
    },
    RoutineOccurrenceReopened {
        routine_id: RoutineId,
        key: CivilDate,
    },
    RoutineArchived {
        routine_id: RoutineId,
    },
    PulseSet {
        value: PulseValue,
        expires_at: i64,
    },
    PulseCleared,
    TalkAdded {
        talk_id: TalkId,
        text: String,
    },
    TalkResolved {
        talk_id: TalkId,
    },
    TalkReopened {
        talk_id: TalkId,
    },
    TalkArchived {
        talk_id: TalkId,
    },
    HandoffAdded {
        handoff_id: HandoffId,
        text: String,
    },
    HandoffAcknowledged {
        handoff_id: HandoffId,
    },
    HandoffArchived {
        handoff_id: HandoffId,
    },
    ItemAdded {
        item_id: ItemId,
        text: String,
        classification: ItemClassification,
    },
    ItemCompleted {
        item_id: ItemId,
    },
    ItemReopened {
        item_id: ItemId,
    },
    ItemArchived {
        item_id: ItemId,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventEnvelope {
    pub event_id: EventId,
    pub household_id: HouseholdId,
    pub actor_id: ActorId,
    pub device_id: DeviceId,
    pub timestamp: i64,
    pub logical_time: u64,
    pub event_version: u16,
    pub kind: EventKind,
    pub canonical_bytes: Vec<u8>,
}
