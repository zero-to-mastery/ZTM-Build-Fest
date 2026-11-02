// Protocol-24 golden fixtures. Each scenario is built through the same command
// path the browser uses, then frozen twice: the complete KINE request (which
// pins every canonical event byte) and the KINS projection Rust returns for it.
// Refactors of decoding, replay or encoding must reproduce both files exactly.
// `web/wasm/golden.test.mjs` replays the same files through the release WASM.
//
// Regenerate deliberately with `KIN_UPDATE_GOLDEN=1 cargo test golden` and
// review the binary diff; an unexplained change is a protocol break.
use std::path::PathBuf;

use crate::command::{execute, CommandContext, HouseholdCommand as C};
use crate::core::replay;
use crate::event::*;
use crate::recurrence::{Cadence, CivilDate};
use crate::request::DecodedRequest;
use crate::wire::PROTOCOL_VERSION;

const HOUSEHOLD: HouseholdId = HouseholdId([1; 16]);
const LEGACY_HOUSEHOLD: HouseholdId = HouseholdId([9; 16]);
const BASE_TIME: i64 = 1_791_900_000_000;
const ON: u32 = 20261014;

fn date(value: u32) -> CivilDate {
    CivilDate::from_encoded(value).unwrap()
}

fn id(tag: u8, n: u16) -> [u8; 16] {
    let mut bytes = [tag; 16];
    bytes[14..].copy_from_slice(&n.to_le_bytes());
    bytes
}

struct Scenario {
    events: Vec<EventEnvelope>,
    next: u16,
    household: HouseholdId,
    target: Option<HouseholdId>,
    bindings: Vec<IdentityBinding>,
    floor: u64,
}

impl Scenario {
    fn new() -> Self {
        Self {
            events: vec![],
            next: 1,
            household: HOUSEHOLD,
            target: None,
            bindings: vec![],
            floor: 0,
        }
    }

    fn request(&self, events: &[EventEnvelope]) -> DecodedRequest {
        DecodedRequest {
            events: events.to_vec(),
            as_of: BASE_TIME + 1_000_000,
            summary_cursor: None,
            civil_date: date(ON),
            target_household_id: self.target,
            identity_bindings: self.bindings.clone(),
        }
    }

    /// Executes against `prefix` events of the history (all of it when None),
    /// as an offline device would, and returns the new event without storing it.
    fn create(
        &mut self,
        command: C,
        device: u8,
        logical: u64,
        prefix: Option<usize>,
    ) -> EventEnvelope {
        let n = self.next;
        self.next += 1;
        let context = CommandContext {
            event_id: EventId(id(0xe0, n)),
            household_id: self.household,
            actor_id: ActorId([device; 16]),
            device_id: DeviceId([device; 16]),
            timestamp: BASE_TIME + i64::from(n) * 1_000,
            logical_time: logical,
        };
        let history = &self.events[..prefix.unwrap_or(self.events.len())];
        execute(&command, context, self.request(history))
            .unwrap_or_else(|error| panic!("golden command {n} rejected: {error:?}"))
            .event
    }

    fn push(&mut self, command: C, device: u8) {
        let logical = self
            .events
            .iter()
            .map(|event| event.logical_time)
            .max()
            .unwrap_or(self.floor)
            + 1;
        let event = self.create(command, device, logical, None);
        self.events.push(event);
    }

    fn encode(&self, as_of: i64, cursor: Option<EventId>) -> Vec<u8> {
        let mut bytes = b"KINE".to_vec();
        bytes.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&(self.events.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&as_of.to_le_bytes());
        bytes.push(u8::from(cursor.is_some()));
        bytes.extend_from_slice(&[0; 3]);
        bytes.extend_from_slice(&cursor.map_or([0; 16], |cursor| cursor.0));
        bytes.extend_from_slice(&ON.to_le_bytes());
        bytes.extend_from_slice(&self.target.map_or([0; 16], |target| target.0));
        bytes.extend_from_slice(&(self.bindings.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        for binding in &self.bindings {
            for part in [
                binding.legacy_household_id.0,
                binding.legacy_actor_id.0,
                binding.legacy_device_id.0,
                binding.household_id.0,
                binding.actor_id.0,
                binding.device_id.0,
            ] {
                bytes.extend_from_slice(&part);
            }
        }
        for event in &self.events {
            bytes.extend_from_slice(&event.canonical_bytes);
        }
        bytes
    }
}

fn full_household() -> Scenario {
    let mut s = Scenario::new();
    let item = ItemId(id(0x11, 1));
    let shopping = ItemId(id(0x11, 2));
    let staple = ItemId(id(0x11, 3));
    let today = ItemId(id(0x11, 4));
    let area = AreaId(id(0x22, 1));
    let note = NoteId(id(0x33, 1));
    let daily = RoutineId(id(0x44, 1));
    let weekdays = RoutineId(id(0x44, 2));
    let record = ReferenceRecordId(id(0x55, 1));
    let step = StepId(id(0x66, 1));
    s.push(
        C::CreateArea {
            id: area,
            name: "Kitchen".into(),
        },
        3,
    );
    s.push(
        C::AddItem {
            id: item,
            text: "Fix the tap 🚰".into(),
            classification: ItemClassification::Need,
        },
        3,
    );
    s.push(
        C::AddItem {
            id: shopping,
            text: "Oat milk".into(),
            classification: ItemClassification::Shopping,
        },
        3,
    );
    s.push(
        C::AddItem {
            id: staple,
            text: "Coffee".into(),
            classification: ItemClassification::Staple,
        },
        3,
    );
    s.push(
        C::AddItem {
            id: today,
            text: "Call school".into(),
            classification: ItemClassification::Today,
        },
        3,
    );
    s.push(
        C::AddItemStep {
            item_id: item,
            step_id: step,
            text: "Buy washer".into(),
        },
        3,
    );
    s.push(
        C::AddItemStep {
            item_id: item,
            step_id: StepId(id(0x66, 2)),
            text: "Shut valve".into(),
        },
        3,
    );
    s.push(
        C::CompleteItemStep {
            item_id: item,
            step_id: step,
        },
        3,
    );
    s.push(
        C::ChangeItemArea {
            item_id: item,
            area_id: Some(area),
        },
        3,
    );
    s.push(
        C::SetItemPlanningDate {
            item_id: item,
            planning_date: Some(date(20261016)),
        },
        3,
    );
    s.push(C::CompleteItem(shopping), 3);
    s.push(C::CompleteItem(today), 3);
    s.push(C::ReopenItem(today), 3);
    s.push(
        C::CaptureHandoff {
            id: HandoffId(id(0x77, 1)),
            text: "Dog fed at 7".into(),
        },
        3,
    );
    s.push(
        C::CaptureHandoff {
            id: HandoffId(id(0x77, 2)),
            text: "Package on porch".into(),
        },
        3,
    );
    s.push(C::AcknowledgeHandoff(HandoffId(id(0x77, 1))), 4);
    s.push(
        C::CaptureTalk {
            id: TalkId(id(0x88, 1)),
            text: "Weekend plans".into(),
        },
        3,
    );
    s.push(C::ResolveTalk(TalkId(id(0x88, 1))), 4);
    s.push(
        C::SetPulse {
            value: PulseValue::Drained,
            expires_at: BASE_TIME + 9_000_000,
        },
        3,
    );
    s.push(
        C::SetPulse {
            value: PulseValue::Good,
            expires_at: BASE_TIME + 9_000_000,
        },
        4,
    );
    s.push(
        C::CreateRoutine {
            id: daily,
            text: "Water plants".into(),
            cadence: Cadence::Daily,
            created_on: date(ON),
        },
        3,
    );
    s.push(
        C::CreateRoutine {
            id: weekdays,
            text: "Pack lunch".into(),
            cadence: Cadence::Weekdays,
            created_on: date(ON),
        },
        3,
    );
    s.push(
        C::CreateRoutine {
            id: RoutineId(id(0x44, 3)),
            text: "Bins".into(),
            cadence: Cadence::Weekly,
            created_on: date(ON),
        },
        3,
    );
    s.push(
        C::CreateRoutine {
            id: RoutineId(id(0x44, 4)),
            text: "Sheets".into(),
            cadence: Cadence::Biweekly,
            created_on: date(ON),
        },
        3,
    );
    s.push(
        C::CreateRoutine {
            id: RoutineId(id(0x44, 5)),
            text: "Filter".into(),
            cadence: Cadence::Monthly,
            created_on: date(ON),
        },
        3,
    );
    s.push(
        C::CompleteOccurrence {
            id: daily,
            key: date(ON),
        },
        3,
    );
    s.push(
        C::CompleteOccurrence {
            id: weekdays,
            key: date(ON),
        },
        4,
    );
    s.push(
        C::ReopenOccurrence {
            id: weekdays,
            key: date(ON),
        },
        4,
    );
    s.push(
        C::CreateNote {
            id: note,
            title: "Wi-Fi".into(),
            body: "Router in hall".into(),
            area_id: Some(area),
        },
        3,
    );
    s.push(
        C::UpdateNote {
            id: note,
            title: "Wi-Fi".into(),
            body: "Router in the hall cupboard".into(),
            area_id: None,
        },
        4,
    );
    s.push(
        C::Pin {
            target_kind: PinTargetKind::Item,
            target_id: item.0,
        },
        3,
    );
    s.push(
        C::Pin {
            target_kind: PinTargetKind::Note,
            target_id: note.0,
        },
        3,
    );
    s.push(
        C::Unpin {
            target_kind: PinTargetKind::Note,
            target_id: note.0,
        },
        3,
    );
    s.push(
        C::SavePlaybook {
            id: PlaybookId(id(0x99, 1)),
            title: "Trip prep".into(),
            entries: vec!["Passports".into(), "Chargers".into()],
        },
        3,
    );
    s.push(
        C::SaveReferenceRecord {
            id: record,
            title: "Boiler".into(),
            area_id: Some(area),
            fields: vec![(
                ReferenceFieldId(id(0xaa, 1)),
                "Model".into(),
                "K-200".into(),
            )],
        },
        3,
    );
    s.push(
        C::SaveMaintenanceEvent {
            id: MaintenanceEventId(id(0xbb, 1)),
            record_id: record,
            performed_on: date(20261010),
            summary: "Annual service".into(),
            next_on: Some(date(20271010)),
            routine_id: Some(RoutineId(id(0x44, 5))),
        },
        3,
    );
    s.push(
        C::BindAttachment {
            id: AttachmentId(id(0xcc, 1)),
            parent_kind: AttachmentParentKind::Item,
            parent_id: item.0,
        },
        3,
    );
    s.push(
        C::BindAttachment {
            id: AttachmentId(id(0xcc, 2)),
            parent_kind: AttachmentParentKind::Note,
            parent_id: note.0,
        },
        3,
    );
    s.push(C::RemoveAttachment(AttachmentId(id(0xcc, 2))), 3);
    s.push(
        C::ChangeResponsibility {
            target_kind: ResponsibilityTargetKind::Item,
            target_id: item.0,
            member_id: Some(ActorId([4; 16])),
        },
        3,
    );
    s.push(
        C::ChangeResponsibility {
            target_kind: ResponsibilityTargetKind::Routine,
            target_id: daily.0,
            member_id: Some(ActorId([3; 16])),
        },
        3,
    );
    s.push(
        C::ArchiveItemStep {
            item_id: item,
            step_id: StepId(id(0x66, 2)),
        },
        3,
    );
    s.push(C::ArchiveHandoff(HandoffId(id(0x77, 2))), 3);
    s.push(C::ArchiveRoutine(RoutineId(id(0x44, 4))), 3);
    s.push(
        C::RenameArea {
            id: area,
            name: "Kitchen & pantry".into(),
        },
        4,
    );
    s.push(C::SetHouseholdMode(HouseholdMode::Guests), 3);
    s
}

fn distributed() -> Scenario {
    // Pre-sync history under a local placeholder household, bound to the
    // authenticated household; then two devices diverge offline and the second
    // device's equal-logical-time events arrive after the first device's.
    // Commands validate against one household, so the placeholder history is
    // built separately and prepended, exactly as sync would hold it.
    let mut legacy = Scenario::new();
    legacy.household = LEGACY_HOUSEHOLD;
    legacy.push(
        C::AddItem {
            id: ItemId(id(0x11, 1)),
            text: "Pre-sync item".into(),
            classification: ItemClassification::Need,
        },
        3,
    );
    legacy.push(
        C::CaptureTalk {
            id: TalkId(id(0x88, 1)),
            text: "Pre-sync topic".into(),
        },
        3,
    );
    let mut s = Scenario::new();
    s.next = legacy.next;
    s.floor = 2;
    s.target = Some(HOUSEHOLD);
    let shared = ItemId(id(0x11, 2));
    s.push(
        C::AddItem {
            id: shared,
            text: "Shared item".into(),
            classification: ItemClassification::Shopping,
        },
        5,
    );
    s.push(
        C::AddItem {
            id: ItemId(id(0x11, 4)),
            text: "Second shared".into(),
            classification: ItemClassification::Need,
        },
        5,
    );
    let fork = s.events.len();
    let base = s
        .events
        .iter()
        .map(|event| event.logical_time)
        .max()
        .unwrap();
    // Device 5 continues online.
    s.push(C::CompleteItem(ItemId(id(0x11, 4))), 5);
    s.push(C::ArchiveItem(shared), 5);
    // Device 6 worked offline from the fork with equal logical times.
    let offline = [
        s.create(
            C::AddItem {
                id: ItemId(id(0x11, 3)),
                text: "Offline item".into(),
                classification: ItemClassification::Today,
            },
            6,
            base + 1,
            Some(fork),
        ),
        s.create(C::CompleteItem(shared), 6, base + 2, Some(fork)),
    ];
    s.events.extend(offline);
    s.push(
        C::CaptureHandoff {
            id: HandoffId(id(0x77, 1)),
            text: "After reconnect".into(),
        },
        6,
    );
    let mut events = legacy.events;
    events.append(&mut s.events);
    s.events = events;
    s.bindings = vec![IdentityBinding {
        legacy_household_id: LEGACY_HOUSEHOLD,
        legacy_actor_id: ActorId([3; 16]),
        legacy_device_id: DeviceId([3; 16]),
        household_id: HOUSEHOLD,
        actor_id: ActorId([5; 16]),
        device_id: DeviceId([5; 16]),
    }];
    s
}

fn pulse_expiry() -> Scenario {
    let mut s = Scenario::new();
    s.push(
        C::SetPulse {
            value: PulseValue::NeedQuiet,
            expires_at: BASE_TIME + 5_000,
        },
        3,
    );
    s.push(
        C::SetPulse {
            value: PulseValue::Okay,
            expires_at: BASE_TIME + 90_000_000,
        },
        4,
    );
    s.push(C::ClearPulse, 4);
    s.push(C::SetHouseholdMode(HouseholdMode::Vacation), 3);
    s
}

fn bulk() -> Scenario {
    let mut s = Scenario::new();
    for n in 0..400u16 {
        let item = ItemId(id(0x11, n));
        let classification = [
            ItemClassification::Today,
            ItemClassification::Need,
            ItemClassification::Shopping,
        ][usize::from(n % 3)];
        s.push(
            C::AddItem {
                id: item,
                text: format!("Household entry {n}"),
                classification,
            },
            3 + (n % 2) as u8,
        );
        if n % 10 == 0 {
            s.push(
                C::AddItemStep {
                    item_id: item,
                    step_id: StepId(id(0x66, n)),
                    text: format!("Step {n}"),
                },
                3,
            );
        }
        if n % 4 == 0 {
            s.push(C::CompleteItem(item), 3);
        }
    }
    s
}

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("rust/fixtures/golden")
        .join(name)
}

fn check(name: &str, scenario: &Scenario, as_of: i64, cursor: Option<EventId>) {
    let request = scenario.encode(as_of, cursor);
    let mut projection =
        replay(&request).unwrap_or_else(|error| panic!("{name} replay failed: {error:?}"));
    // Revisions as a fresh engine instance stamps them: every section is new.
    crate::sections::SectionRevisions::new()
        .stamp(&mut projection, None)
        .unwrap();
    let kine = fixture_path(&format!("{name}.kine"));
    let kins = fixture_path(&format!("{name}.kins"));
    if std::env::var_os("KIN_UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(kine.parent().unwrap()).unwrap();
        std::fs::write(&kine, &request).unwrap();
        std::fs::write(&kins, &projection).unwrap();
        return;
    }
    let expected_request =
        std::fs::read(&kine).unwrap_or_else(|_| panic!("missing golden fixture {name}.kine"));
    let expected_projection =
        std::fs::read(&kins).unwrap_or_else(|_| panic!("missing golden fixture {name}.kins"));
    assert!(
        request == expected_request,
        "{name}: canonical request bytes changed"
    );
    assert!(
        projection == expected_projection,
        "{name}: protocol-24 projection bytes changed"
    );
}

#[test]
fn golden_empty_household() {
    check("empty", &Scenario::new(), BASE_TIME, None);
}

#[test]
fn golden_full_household() {
    let scenario = full_household();
    let cursor = scenario.events[20].event_id;
    check("full", &scenario, BASE_TIME + 1_000_000, Some(cursor));
}

#[test]
fn golden_distributed_bound_history() {
    let scenario = distributed();
    let cursor = scenario.events[1].event_id;
    check(
        "distributed",
        &scenario,
        BASE_TIME + 1_000_000,
        Some(cursor),
    );
}

#[test]
fn golden_expired_pulse_and_paused_mode() {
    check("pulse-expiry", &pulse_expiry(), BASE_TIME + 60_000, None);
}

#[test]
fn golden_bulk_history() {
    let scenario = bulk();
    let cursor = scenario.events[scenario.events.len() / 2].event_id;
    check("bulk", &scenario, BASE_TIME + 1_000_000, Some(cursor));
}
