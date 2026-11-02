//! The catch-up summary: what changed after the cursor, in arrival order.
//!
//! The summary needs little from each event: its ID and, for the kinds it
//! reports, either the text the event added or the ID of the record it
//! changed. `SummaryInput` is that borrowed extract. It comes from an owned
//! event (`from_kind`) or straight from canonical bytes (`from_view`), so
//! the history an engine holds is summarized without decoding every event.
use super::*;
use crate::event_decode::EventView;

/// What the summary reads from one event; borrowed, nothing is copied.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SummaryInput<'a> {
    /// An event that adds a record and carries its text.
    Added {
        kind: SummaryKind,
        entity_kind: SummaryEntityKind,
        text: &'a str,
        classification: Option<ItemClassification>,
    },
    /// An event that changes an existing record, reported with its current text.
    Item(SummaryKind, ItemId),
    Handoff(SummaryKind, HandoffId),
    Talk(SummaryKind, TalkId),
    Routine(SummaryKind, RoutineId),
    /// A kind the summary does not report.
    Other,
}

impl<'a> SummaryInput<'a> {
    pub fn from_kind(kind: &'a EventKind) -> Self {
        use SummaryEntityKind as E;
        use SummaryKind as S;
        match kind {
            EventKind::ItemAdded {
                text,
                classification,
                ..
            } => Self::Added {
                kind: S::ItemAdded,
                entity_kind: E::Item,
                text,
                classification: Some(*classification),
            },
            EventKind::HandoffAdded { text, .. } => Self::Added {
                kind: S::HandoffAdded,
                entity_kind: E::Handoff,
                text,
                classification: None,
            },
            EventKind::TalkAdded { text, .. } => Self::Added {
                kind: S::TalkAdded,
                entity_kind: E::Talk,
                text,
                classification: None,
            },
            EventKind::RoutineCreated { text, .. } => Self::Added {
                kind: S::RoutineCreated,
                entity_kind: E::Routine,
                text,
                classification: None,
            },
            EventKind::ItemCompleted { item_id } => Self::Item(S::ItemCompleted, *item_id),
            EventKind::ItemReopened { item_id } => Self::Item(S::ItemReopened, *item_id),
            EventKind::ItemArchived { item_id } => Self::Item(S::ItemArchived, *item_id),
            EventKind::HandoffAcknowledged { handoff_id } => {
                Self::Handoff(S::HandoffAcknowledged, *handoff_id)
            }
            EventKind::HandoffArchived { handoff_id } => {
                Self::Handoff(S::HandoffArchived, *handoff_id)
            }
            EventKind::TalkResolved { talk_id } => Self::Talk(S::TalkResolved, *talk_id),
            EventKind::TalkReopened { talk_id } => Self::Talk(S::TalkReopened, *talk_id),
            EventKind::TalkArchived { talk_id } => Self::Talk(S::TalkArchived, *talk_id),
            EventKind::RoutineOccurrenceCompleted { routine_id, .. } => {
                Self::Routine(S::RoutineOccurrenceCompleted, *routine_id)
            }
            EventKind::RoutineOccurrenceReopened { routine_id, .. } => {
                Self::Routine(S::RoutineOccurrenceReopened, *routine_id)
            }
            EventKind::RoutineArchived { routine_id } => {
                Self::Routine(S::RoutineArchived, *routine_id)
            }
            _ => Self::Other,
        }
    }

    /// The same extract read from an event's canonical bytes. The record must
    /// already be valid (history.rs checks every record when it is appended);
    /// the offsets are those `event_decode::decode_event` reads. The summary
    /// tests require this to agree with `from_kind` for every golden record.
    pub fn from_view(view: &EventView<'a>) -> Self {
        use SummaryEntityKind as E;
        use SummaryKind as S;
        let payload = view.payload();
        let id = || -> [u8; 16] { payload[..16].try_into().unwrap_or([0; 16]) };
        // A record id, a u32 length at `at`, then the UTF-8 text.
        let text =
            |at: usize| -> &'a str { std::str::from_utf8(&payload[at + 4..]).unwrap_or_default() };
        match view.kind_code() {
            (2, 1) => Self::Added {
                kind: S::ItemAdded,
                entity_kind: E::Item,
                text: text(20),
                classification: Some(match payload[16] {
                    0 => ItemClassification::Today,
                    1 => ItemClassification::Need,
                    2 => ItemClassification::Shopping,
                    _ => ItemClassification::Staple,
                }),
            },
            (1, 2) => Self::Item(S::ItemCompleted, ItemId(id())),
            (1, 3) => Self::Item(S::ItemReopened, ItemId(id())),
            (1, 4) => Self::Item(S::ItemArchived, ItemId(id())),
            (1, 5) => Self::Added {
                kind: S::HandoffAdded,
                entity_kind: E::Handoff,
                text: text(16),
                classification: None,
            },
            (1, 6) => Self::Handoff(S::HandoffAcknowledged, HandoffId(id())),
            (1, 7) => Self::Handoff(S::HandoffArchived, HandoffId(id())),
            (1, 8) => Self::Added {
                kind: S::TalkAdded,
                entity_kind: E::Talk,
                text: text(16),
                classification: None,
            },
            (1, 9) => Self::Talk(S::TalkResolved, TalkId(id())),
            (1, 10) => Self::Talk(S::TalkReopened, TalkId(id())),
            (1, 11) => Self::Talk(S::TalkArchived, TalkId(id())),
            (1, 14) => Self::Added {
                kind: S::RoutineCreated,
                entity_kind: E::Routine,
                text: text(24),
                classification: None,
            },
            (1, 15) => Self::Routine(S::RoutineOccurrenceCompleted, RoutineId(id())),
            (1, 16) => Self::Routine(S::RoutineOccurrenceReopened, RoutineId(id())),
            (1, 17) => Self::Routine(S::RoutineArchived, RoutineId(id())),
            _ => Self::Other,
        }
    }
}

/// The summary of whole decoded events (a full request, tests).
pub fn summarize_validated(
    events: &[EventEnvelope],
    cursor: Option<EventId>,
    state: &HouseholdState,
) -> Result<CatchUpSummary, KinError> {
    let inputs: Vec<(EventId, SummaryInput<'_>)> = events
        .iter()
        .map(|event| (event.event_id, SummaryInput::from_kind(&event.kind)))
        .collect();
    summarize(&inputs, cursor, state)
}

/// The summary of `inputs` (event ID and extract, in arrival order) after
/// `cursor`, which must name one of them. The last 8 reportable events become
/// entries; `total_count` counts all of them. Duplicate event IDs count once.
pub fn summarize(
    inputs: &[(EventId, SummaryInput<'_>)],
    cursor: Option<EventId>,
    state: &HouseholdState,
) -> Result<CatchUpSummary, KinError> {
    let start = match cursor {
        Some(cursor_id) => inputs
            .iter()
            .position(|(event_id, _)| *event_id == cursor_id)
            .map(|index| index + 1)
            .ok_or(KinError::InvalidEvent)?,
        None => 0,
    };
    let mut seen: BTreeSet<EventId> = inputs[..start]
        .iter()
        .map(|(event_id, _)| *event_id)
        .collect();
    let items: BTreeMap<ItemId, (&str, ItemClassification)> = state
        .items
        .iter()
        .map(|item| (item.item_id, (item.text.as_str(), item.classification)))
        .collect();
    let handoffs: BTreeMap<HandoffId, &str> = state
        .handoffs
        .iter()
        .map(|handoff| (handoff.handoff_id, handoff.text.as_str()))
        .collect();
    let talks: BTreeMap<TalkId, &str> = state
        .talks
        .iter()
        .map(|talk| (talk.talk_id, talk.text.as_str()))
        .collect();
    let routines: BTreeMap<RoutineId, &str> = state
        .routines
        .iter()
        .map(|routine| (routine.routine_id, routine.text.as_str()))
        .collect();
    // Borrowed until the end: only the entries kept are copied.
    let mut kept: std::collections::VecDeque<(
        EventId,
        SummaryKind,
        SummaryEntityKind,
        &str,
        Option<ItemClassification>,
    )> = std::collections::VecDeque::with_capacity(MAX_SUMMARY_ENTRIES + 1);
    let mut total_count = 0u32;
    for (event_id, input) in &inputs[start..] {
        if !seen.insert(*event_id) {
            continue;
        }
        let entry = match *input {
            SummaryInput::Added {
                kind,
                entity_kind,
                text,
                classification,
            } => Some((kind, entity_kind, text, classification)),
            SummaryInput::Item(kind, id) => items.get(&id).map(|(text, classification)| {
                (kind, SummaryEntityKind::Item, *text, Some(*classification))
            }),
            SummaryInput::Handoff(kind, id) => handoffs
                .get(&id)
                .map(|text| (kind, SummaryEntityKind::Handoff, *text, None)),
            SummaryInput::Talk(kind, id) => talks
                .get(&id)
                .map(|text| (kind, SummaryEntityKind::Talk, *text, None)),
            SummaryInput::Routine(kind, id) => routines
                .get(&id)
                .map(|text| (kind, SummaryEntityKind::Routine, *text, None)),
            SummaryInput::Other => None,
        };
        if let Some((kind, entity_kind, text, classification)) = entry {
            total_count = total_count.checked_add(1).ok_or(KinError::SizeLimit)?;
            if kept.len() == MAX_SUMMARY_ENTRIES {
                kept.pop_front();
            }
            kept.push_back((*event_id, kind, entity_kind, text, classification));
        }
    }
    Ok(CatchUpSummary {
        entries: kept
            .into_iter()
            .map(
                |(event_id, kind, entity_kind, text, classification)| SummaryEntry {
                    event_id,
                    kind,
                    entity_kind,
                    text: text.to_owned(),
                    classification,
                },
            )
            .collect(),
        total_count,
        through_event_id: inputs.last().map(|(event_id, _)| *event_id),
    })
}
