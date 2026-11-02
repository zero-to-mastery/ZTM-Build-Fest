//! Household intent validation. Browser capabilities supply identity, randomness
//! and time explicitly; authentication/pairing are separate adapter concerns.
use crate::codec::{encode_event, encode_metadata};
use crate::core::{encode_projection, project};
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::recurrence::{Cadence, CivilDate};
use crate::request::{decode_request, DecodedRequest};
use crate::state::{
    normalize_area_name, normalize_step_text, HouseholdState, ItemStatus, MAX_STEPS_PER_ITEM,
};
use crate::wire::{MAX_EVENT_COUNT, MAX_PROTOCOL_BYTES};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HouseholdCommand {
    AddItem {
        id: ItemId,
        text: String,
        classification: ItemClassification,
    },
    CompleteItem(ItemId),
    ReopenItem(ItemId),
    ArchiveItem(ItemId),
    AddItemStep {
        item_id: ItemId,
        step_id: StepId,
        text: String,
    },
    CompleteItemStep {
        item_id: ItemId,
        step_id: StepId,
    },
    ReopenItemStep {
        item_id: ItemId,
        step_id: StepId,
    },
    ArchiveItemStep {
        item_id: ItemId,
        step_id: StepId,
    },
    CaptureHandoff {
        id: HandoffId,
        text: String,
    },
    AcknowledgeHandoff(HandoffId),
    ArchiveHandoff(HandoffId),
    CaptureTalk {
        id: TalkId,
        text: String,
    },
    ResolveTalk(TalkId),
    ReopenTalk(TalkId),
    ArchiveTalk(TalkId),
    SetPulse {
        value: PulseValue,
        expires_at: i64,
    },
    ClearPulse,
    CreateRoutine {
        id: RoutineId,
        text: String,
        cadence: Cadence,
        created_on: CivilDate,
    },
    CompleteOccurrence {
        id: RoutineId,
        key: CivilDate,
    },
    ReopenOccurrence {
        id: RoutineId,
        key: CivilDate,
    },
    ArchiveRoutine(RoutineId),
    CreateArea {
        id: AreaId,
        name: String,
    },
    RenameArea {
        id: AreaId,
        name: String,
    },
    ArchiveArea(AreaId),
    ChangeItemArea {
        item_id: ItemId,
        area_id: Option<AreaId>,
    },
    CreateNote {
        id: NoteId,
        title: String,
        body: String,
        area_id: Option<AreaId>,
    },
    UpdateNote {
        id: NoteId,
        title: String,
        body: String,
        area_id: Option<AreaId>,
    },
    ArchiveNote(NoteId),
    SetHouseholdMode(HouseholdMode),
    SetItemPlanningDate {
        item_id: ItemId,
        planning_date: Option<CivilDate>,
    },
    Pin {
        target_kind: PinTargetKind,
        target_id: [u8; 16],
    },
    Unpin {
        target_kind: PinTargetKind,
        target_id: [u8; 16],
    },
    SavePlaybook {
        id: PlaybookId,
        title: String,
        entries: Vec<String>,
    },
    ArchivePlaybook(PlaybookId),
    SaveReferenceRecord {
        id: ReferenceRecordId,
        title: String,
        area_id: Option<AreaId>,
        fields: Vec<(ReferenceFieldId, String, String)>,
    },
    ArchiveReferenceRecord(ReferenceRecordId),
    SaveMaintenanceEvent {
        id: MaintenanceEventId,
        record_id: ReferenceRecordId,
        performed_on: CivilDate,
        summary: String,
        next_on: Option<CivilDate>,
        routine_id: Option<RoutineId>,
    },
    ArchiveMaintenanceEvent(MaintenanceEventId),
    BindAttachment {
        id: AttachmentId,
        parent_kind: AttachmentParentKind,
        parent_id: [u8; 16],
    },
    RemoveAttachment(AttachmentId),
    ChangeResponsibility {
        target_kind: ResponsibilityTargetKind,
        target_id: [u8; 16],
        member_id: Option<ActorId>,
    },
    /// The context's device announces its automatic name.
    DescribeDevice {
        auto_name: String,
    },
    /// Sets (Some) or clears (None) the nickname of one of the context
    /// member's devices.
    NicknameDevice {
        device_id: DeviceId,
        nickname: Option<String>,
    },
    /// Sets (Some) or clears (None) the context member's own preferred
    /// display name (#224). There is no target: a member names only themselves.
    NameMember {
        name: Option<String>,
    },
    /// Posts a chat message whose content is the blob `blob_ref` (its
    /// SHA-256), encrypted with `blob_key` (#109, #110).
    PostChatMessage {
        id: ChatMessageId,
        content_kind: ChatContentKind,
        blob_ref: [u8; 32],
        blob_key: [u8; 32],
        /// The message this one answers (#129).
        reply_to: Option<ChatMessageId>,
        /// Who it mentions (#130).
        mentions: crate::chat::ChatMentions,
    },
    /// The author replaces a text message's content blob (and the mentions
    /// it carries).
    EditChatMessage {
        id: ChatMessageId,
        blob_ref: [u8; 32],
        blob_key: [u8; 32],
        mentions: crate::chat::ChatMentions,
    },
    /// The author deletes for everyone (`by_admin` false), or an admin
    /// removes another member's message (`by_admin` true).
    DeleteChatMessage {
        id: ChatMessageId,
        by_admin: bool,
    },
    /// Turns the context member's reaction `emoji` to a message on or off
    /// (#127). It must change what the member's reaction is.
    ReactChatMessage {
        id: ChatMessageId,
        emoji: String,
        on: bool,
    },
    /// Pins a message or unpins one (#131). A pin needs a message that shows
    /// and room under the limit; an unpin needs a message that is pinned.
    PinChatMessage {
        id: ChatMessageId,
        on: bool,
    },
    /// The context member votes in a poll (#135): `options` is the choice as
    /// a bit set (bit n is option n), replacing their earlier vote; none
    /// clears it. The poll must be open and the vote must change something.
    VoteChatPoll {
        id: ChatMessageId,
        options: u16,
    },
    /// The poll's author closes it (#135).
    CloseChatPoll {
        id: ChatMessageId,
    },
    /// "Talk later" (#312): opens, resolves or clears the topic on a message.
    /// Open needs a message that shows, no topic or a resolved one, and room
    /// under `MAX_TOPICS`; resolved needs a message that shows and an open
    /// topic; cleared needs a topic on a message not deleted. Anyone who may
    /// post may set it (the host and the relay check that, as for pins).
    SetChatTopic {
        id: ChatMessageId,
        state: crate::chat::ChatTopicState,
    },
    /// A fridge event (#317, board.rs), against the board log only. KCMD
    /// actions 52–58 carry the event's exact payload; the board's rules
    /// (`BoardState::check_command`) decide whether it applies.
    Board(EventKind),
    /// A meals event (#333, kinds 59–63), carried whole like a board event;
    /// `MealsState::check_command` decides whether it applies.
    Meal(EventKind),
    /// An item's emoji (#344, kind 64), carried whole like a meals event;
    /// `PicturesState::check_command` decides whether it applies.
    Picture(EventKind),
    /// A store-sections event (#411, kinds 66–67), carried whole like a
    /// meals event; `StoreSectionsState::check_command` decides whether it
    /// applies.
    StoreSection(EventKind),
    /// A routine rotation or turn (#429, kinds 68–69), carried whole like a
    /// meals event; `RotationsState::check_command` decides whether it
    /// applies.
    Rotation(EventKind),
    /// The sitter page (#442, kind 70), carried whole like a meals event;
    /// `SitterPageState::check_command` decides whether it applies. Only an
    /// Adult may send it; the host checks that (sitter.rs).
    SitterPage(EventKind),
    /// The family album (#673, kinds 75–76), carried whole like a meals
    /// event; `AlbumState::check_command` decides whether it applies. Who
    /// may remove a photo is the host's check (album.rs).
    Album(EventKind),
    /// The family calendar (#656, kinds 71–74), carried whole like a meals
    /// event; `CalendarState::check_command` decides whether it applies.
    Calendar(EventKind),
    /// The chore chart (#676, kinds 77–79), carried whole like a meals event;
    /// `ChoresState::check_command` decides whether it applies. Points and
    /// rewards are the host's to gate to Adults (chores.rs).
    Chore(EventKind),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommandContext {
    pub event_id: EventId,
    pub household_id: HouseholdId,
    pub actor_id: ActorId,
    pub device_id: DeviceId,
    pub timestamp: i64,
    pub logical_time: u64,
}

pub fn create_event(
    command: &HouseholdCommand,
    context: CommandContext,
) -> Result<EventEnvelope, KinError> {
    use HouseholdCommand::*;
    let kind = match command {
        AddItem {
            id,
            text,
            classification,
        } => EventKind::ItemAdded {
            item_id: *id,
            text: text.clone(),
            classification: *classification,
        },
        CompleteItem(id) => EventKind::ItemCompleted { item_id: *id },
        ReopenItem(id) => EventKind::ItemReopened { item_id: *id },
        ArchiveItem(id) => EventKind::ItemArchived { item_id: *id },
        AddItemStep {
            item_id,
            step_id,
            text,
        } => EventKind::ItemStepAdded {
            item_id: *item_id,
            step_id: *step_id,
            text: normalize_step_text(text)?,
        },
        CompleteItemStep { item_id, step_id } => EventKind::ItemStepCompleted {
            item_id: *item_id,
            step_id: *step_id,
        },
        ReopenItemStep { item_id, step_id } => EventKind::ItemStepReopened {
            item_id: *item_id,
            step_id: *step_id,
        },
        ArchiveItemStep { item_id, step_id } => EventKind::ItemStepArchived {
            item_id: *item_id,
            step_id: *step_id,
        },
        CaptureHandoff { id, text } => EventKind::HandoffAdded {
            handoff_id: *id,
            text: text.clone(),
        },
        AcknowledgeHandoff(id) => EventKind::HandoffAcknowledged { handoff_id: *id },
        ArchiveHandoff(id) => EventKind::HandoffArchived { handoff_id: *id },
        CaptureTalk { id, text } => EventKind::TalkAdded {
            talk_id: *id,
            text: text.clone(),
        },
        ResolveTalk(id) => EventKind::TalkResolved { talk_id: *id },
        ReopenTalk(id) => EventKind::TalkReopened { talk_id: *id },
        ArchiveTalk(id) => EventKind::TalkArchived { talk_id: *id },
        SetPulse { value, expires_at } => EventKind::PulseSet {
            value: *value,
            expires_at: *expires_at,
        },
        ClearPulse => EventKind::PulseCleared,
        CreateRoutine {
            id,
            text,
            cadence,
            created_on,
        } => EventKind::RoutineCreated {
            routine_id: *id,
            text: text.clone(),
            cadence: *cadence,
            created_on: *created_on,
        },
        CompleteOccurrence { id, key } => EventKind::RoutineOccurrenceCompleted {
            routine_id: *id,
            key: *key,
        },
        ReopenOccurrence { id, key } => EventKind::RoutineOccurrenceReopened {
            routine_id: *id,
            key: *key,
        },
        ArchiveRoutine(id) => EventKind::RoutineArchived { routine_id: *id },
        CreateArea { id, name } => EventKind::AreaCreated {
            area_id: *id,
            name: normalize_area_name(name)?,
        },
        RenameArea { id, name } => EventKind::AreaRenamed {
            area_id: *id,
            name: normalize_area_name(name)?,
        },
        ArchiveArea(id) => EventKind::AreaArchived { area_id: *id },
        ChangeItemArea { item_id, area_id } => EventKind::ItemAreaChanged {
            item_id: *item_id,
            area_id: *area_id,
        },
        CreateNote {
            id,
            title,
            body,
            area_id,
        } => {
            let (title, body) = crate::state::normalize_note(title, body)?;
            EventKind::NoteCreated {
                note_id: *id,
                title,
                body,
                area_id: *area_id,
            }
        }
        UpdateNote {
            id,
            title,
            body,
            area_id,
        } => {
            let (title, body) = crate::state::normalize_note(title, body)?;
            EventKind::NoteUpdated {
                note_id: *id,
                title,
                body,
                area_id: *area_id,
            }
        }
        ArchiveNote(id) => EventKind::NoteArchived { note_id: *id },
        SetHouseholdMode(mode) => EventKind::HouseholdModeChanged { mode: *mode },
        SetItemPlanningDate {
            item_id,
            planning_date,
        } => EventKind::ItemPlanningDateChanged {
            item_id: *item_id,
            planning_date: *planning_date,
        },
        Pin {
            target_kind,
            target_id,
        } => EventKind::PinAdded {
            target_kind: *target_kind,
            target_id: *target_id,
        },
        Unpin {
            target_kind,
            target_id,
        } => EventKind::PinRemoved {
            target_kind: *target_kind,
            target_id: *target_id,
        },
        SavePlaybook { id, title, entries } => EventKind::PlaybookSaved {
            playbook_id: *id,
            title: title.clone(),
            entries: entries.clone(),
        },
        ArchivePlaybook(id) => EventKind::PlaybookArchived { playbook_id: *id },
        SaveReferenceRecord {
            id,
            title,
            area_id,
            fields,
        } => EventKind::ReferenceRecordSaved {
            record_id: *id,
            title: title.clone(),
            area_id: *area_id,
            fields: fields.clone(),
        },
        ArchiveReferenceRecord(id) => EventKind::ReferenceRecordArchived { record_id: *id },
        SaveMaintenanceEvent {
            id,
            record_id,
            performed_on,
            summary,
            next_on,
            routine_id,
        } => EventKind::MaintenanceEventSaved {
            maintenance_id: *id,
            record_id: *record_id,
            performed_on: *performed_on,
            summary: summary.clone(),
            next_on: *next_on,
            routine_id: *routine_id,
        },
        ArchiveMaintenanceEvent(id) => EventKind::MaintenanceEventArchived {
            maintenance_id: *id,
        },
        BindAttachment {
            id,
            parent_kind,
            parent_id,
        } => EventKind::AttachmentBound {
            attachment_id: *id,
            parent_kind: *parent_kind,
            parent_id: *parent_id,
        },
        RemoveAttachment(id) => EventKind::AttachmentRemoved { attachment_id: *id },
        ChangeResponsibility {
            target_kind,
            target_id,
            member_id,
        } => EventKind::ResponsibilityChanged {
            target_kind: *target_kind,
            target_id: *target_id,
            member_id: *member_id,
        },
        DescribeDevice { auto_name } => EventKind::DeviceDescribed {
            auto_name: crate::state::normalize_device_name(auto_name)?,
        },
        NicknameDevice {
            device_id,
            nickname,
        } => EventKind::DeviceNicknamed {
            device_id: *device_id,
            nickname: nickname
                .as_deref()
                .map(crate::state::normalize_device_nickname)
                .transpose()?,
        },
        NameMember { name } => EventKind::MemberNamed {
            name: name
                .as_deref()
                .map(crate::state::normalize_member_name)
                .transpose()?,
        },
        PostChatMessage {
            id,
            content_kind,
            blob_ref,
            blob_key,
            reply_to,
            mentions,
        } => EventKind::ChatMessagePosted {
            message_id: *id,
            content_kind: *content_kind,
            blob_ref: *blob_ref,
            blob_key: *blob_key,
            reply_to: *reply_to,
            mentions: mentions.clone(),
        },
        EditChatMessage {
            id,
            blob_ref,
            blob_key,
            mentions,
        } => EventKind::ChatMessageEdited {
            message_id: *id,
            blob_ref: *blob_ref,
            blob_key: *blob_key,
            mentions: mentions.clone(),
        },
        DeleteChatMessage { id, by_admin } => EventKind::ChatMessageDeleted {
            message_id: *id,
            by_admin: *by_admin,
        },
        ReactChatMessage { id, emoji, on } => EventKind::ChatReactionSet {
            message_id: *id,
            emoji: emoji.clone(),
            on: *on,
        },
        PinChatMessage { id, on } => EventKind::ChatPinSet {
            message_id: *id,
            on: *on,
        },
        VoteChatPoll { id, options } => EventKind::ChatPollVote {
            message_id: *id,
            options: *options,
        },
        CloseChatPoll { id } => EventKind::ChatPollClosed { message_id: *id },
        SetChatTopic { id, state } => EventKind::ChatTopicSet {
            message_id: *id,
            state: *state,
        },
        Board(kind) => {
            if !kind.is_board() {
                return Err(KinError::InvalidEvent);
            }
            kind.clone()
        }
        Meal(kind) => {
            if !crate::meals::is_meals_code(crate::codec::kind_code(kind)) {
                return Err(KinError::InvalidEvent);
            }
            kind.clone()
        }
        Picture(kind) => {
            if !crate::simple::is_simple_code(crate::codec::kind_code(kind)) {
                return Err(KinError::InvalidEvent);
            }
            kind.clone()
        }
        StoreSection(kind) => {
            if !crate::store_sections::is_sections_code(crate::codec::kind_code(kind)) {
                return Err(KinError::InvalidEvent);
            }
            kind.clone()
        }
        Rotation(kind) => {
            if !crate::rotations::is_rotation_code(crate::codec::kind_code(kind)) {
                return Err(KinError::InvalidEvent);
            }
            kind.clone()
        }
        SitterPage(kind) => {
            if !crate::sitter::is_sitter_code(crate::codec::kind_code(kind)) {
                return Err(KinError::InvalidEvent);
            }
            kind.clone()
        }
        Album(kind) => {
            if !crate::album::is_album_code(crate::codec::kind_code(kind)) {
                return Err(KinError::InvalidEvent);
            }
            kind.clone()
        }
        Calendar(kind) => {
            if !crate::calendar::is_calendar_code(crate::codec::kind_code(kind)) {
                return Err(KinError::InvalidEvent);
            }
            kind.clone()
        }
        Chore(kind) => {
            if !crate::chores::is_chore_code(crate::codec::kind_code(kind)) {
                return Err(KinError::InvalidEvent);
            }
            kind.clone()
        }
    };
    let event = EventEnvelope {
        event_id: context.event_id,
        household_id: context.household_id,
        actor_id: context.actor_id,
        device_id: context.device_id,
        timestamp: context.timestamp,
        logical_time: context.logical_time,
        event_version: if matches!(command, AddItem { .. }) {
            2
        } else {
            1
        },
        kind,
        canonical_bytes: Vec::new(),
    };
    decode_event(&encode_event(&event)?)
}

#[derive(Debug)]
pub struct CommandResult {
    pub event: EventEnvelope,
    /// The household with the event applied. For a chat command against the
    /// chat log: the state before it, and `encoded_projection` is empty.
    pub projection: HouseholdState,
    pub encoded_projection: Vec<u8>,
}

/// Full validation happens before the adapter persists anything. Historical
/// replay remains idempotent; a stale local Routine intent is rejected here.
/// What a command needs from the history it extends.
pub trait CommandHistory {
    /// The replay context: as_of, civil date, cursor, target household.
    fn context(&self) -> &DecodedRequest;
    /// How many events the history holds.
    fn event_count(&self) -> usize;
    /// Most events it may hold.
    fn limit(&self) -> usize {
        MAX_EVENT_COUNT
    }
    /// Whether it is the chat log, which takes chat commands only; every
    /// other history takes every other command.
    fn is_chat(&self) -> bool {
        false
    }
    /// Whether it is the board log (#317), which takes board commands only.
    fn is_board(&self) -> bool {
        false
    }
    /// The household admins the host names for a chat command
    /// (`kin_chat_execute`); an admin removal needs its actor among them.
    fn chat_admins(&self) -> &[ActorId] {
        &[]
    }
    /// The members the host names as able to read chat (#130): the only ones
    /// a message may mention by name.
    fn chat_members(&self) -> &[ActorId] {
        &[]
    }
    /// Whether some event rules out a new event with `context`: it belongs to
    /// another household, is not earlier, or has the same event ID.
    fn conflicts_with(&self, context: &CommandContext) -> bool;
    /// The household as the history projects it.
    fn current(&mut self) -> Result<HouseholdState, KinError>;
    /// The household with `event` appended (it comes strictly later than
    /// every event held), and its KINS projection bytes.
    fn with_event(&mut self, event: &EventEnvelope) -> Result<(HouseholdState, Vec<u8>), KinError>;
}

/// A whole decoded request: both projections are full replays (tests).
pub struct WholeRequest(pub DecodedRequest);

impl CommandHistory for WholeRequest {
    fn context(&self) -> &DecodedRequest {
        &self.0
    }
    fn event_count(&self) -> usize {
        self.0.events.len()
    }
    fn conflicts_with(&self, context: &CommandContext) -> bool {
        self.0.events.iter().any(|event| {
            event.household_id != context.household_id
                || event.logical_time >= context.logical_time
                || event.event_id == context.event_id
        })
    }
    fn current(&mut self) -> Result<HouseholdState, KinError> {
        project(&self.0)
    }
    fn with_event(&mut self, event: &EventEnvelope) -> Result<(HouseholdState, Vec<u8>), KinError> {
        self.0.events.push(event.clone());
        let projection = project(&self.0)?;
        let encoded = encode_projection(&self.0, &projection)?;
        Ok((projection, encoded))
    }
}

/// The history an engine instance holds: the checkpoint gives the current
/// state, the new event is applied to a copy of it, and the summary reads the
/// records in place.
pub struct HeldHistory<'h> {
    history: &'h mut crate::history::History,
    context: DecodedRequest,
    admins: Vec<ActorId>,
    members: Vec<ActorId>,
}

impl<'h> HeldHistory<'h> {
    /// Brings the history's replay up to date for `context`.
    pub fn new(
        history: &'h mut crate::history::History,
        context: DecodedRequest,
    ) -> Result<Self, KinError> {
        history.replay(&context)?;
        Ok(Self {
            history,
            context,
            admins: Vec::new(),
            members: Vec::new(),
        })
    }

    /// Names the household admins for chat commands.
    pub fn with_admins(mut self, admins: Vec<ActorId>) -> Self {
        self.admins = admins;
        self
    }

    /// Names the members who may be mentioned in chat commands (#130).
    pub fn with_members(mut self, members: Vec<ActorId>) -> Self {
        self.members = members;
        self
    }

    fn replay(&self) -> Result<&crate::replay::Replay, KinError> {
        self.history.replayed().ok_or(KinError::Internal)
    }
}

impl CommandHistory for HeldHistory<'_> {
    fn context(&self) -> &DecodedRequest {
        &self.context
    }
    fn event_count(&self) -> usize {
        self.history.len()
    }
    fn limit(&self) -> usize {
        self.history.limit()
    }
    fn is_chat(&self) -> bool {
        self.history.log() == crate::history::Log::Chat
    }
    fn is_board(&self) -> bool {
        self.history.log() == crate::history::Log::Board
    }
    fn chat_admins(&self) -> &[ActorId] {
        &self.admins
    }
    fn chat_members(&self) -> &[ActorId] {
        &self.members
    }
    // Every applied event shares the replay's household, its last logical
    // time is the greatest, and it knows every applied event ID.
    fn conflicts_with(&self, context: &CommandContext) -> bool {
        let Ok(replay) = self.replay() else {
            return true;
        };
        !self.history.is_empty()
            && (replay.household_id() != Some(context.household_id)
                || replay.last_logical_time() >= context.logical_time
                || replay.contains_event(context.event_id))
    }
    fn current(&mut self) -> Result<HouseholdState, KinError> {
        self.replay()?
            .finalize(self.context.as_of, self.context.civil_date)
    }
    fn with_event(&mut self, event: &EventEnvelope) -> Result<(HouseholdState, Vec<u8>), KinError> {
        if self.is_chat() || self.is_board() {
            // A chat or board event changes no projection. Applying it to a copy would
            // copy the whole chat (copy-on-write), so the result carries the
            // state before the event and no KINS bytes; the host reads the
            // chat through a page once it has stored the event.
            return Ok((self.current()?, Vec::new()));
        }
        let mut candidate = self.replay()?.clone();
        candidate.note_archives(std::slice::from_ref(event));
        candidate.apply(event)?;
        let projection = candidate.finalize(self.context.as_of, self.context.civil_date)?;
        let summary = self
            .history
            .summary(&self.context, &projection, Some(event))?;
        let encoded = crate::state_encode::encode_state(&projection, &summary)?;
        Ok((projection, encoded))
    }
}

/// A command against a whole request: the projections before and after the
/// new event are full replays.
pub fn execute(
    command: &HouseholdCommand,
    context: CommandContext,
    request: DecodedRequest,
) -> Result<CommandResult, KinError> {
    execute_with(command, context, &mut WholeRequest(request))
}

/// Validates and builds a command's event against `history`.
pub fn execute_with(
    command: &HouseholdCommand,
    context: CommandContext,
    history: &mut dyn CommandHistory,
) -> Result<CommandResult, KinError> {
    let chat_command = matches!(
        command,
        HouseholdCommand::PostChatMessage { .. }
            | HouseholdCommand::EditChatMessage { .. }
            | HouseholdCommand::DeleteChatMessage { .. }
            | HouseholdCommand::ReactChatMessage { .. }
            | HouseholdCommand::PinChatMessage { .. }
            | HouseholdCommand::VoteChatPoll { .. }
            | HouseholdCommand::CloseChatPoll { .. }
            | HouseholdCommand::SetChatTopic { .. }
    );
    let board_command = matches!(command, HouseholdCommand::Board(_));
    if history.event_count() >= history.limit()
        || chat_command != history.is_chat()
        || board_command != history.is_board()
        || !valid_timestamp(context.timestamp)
        || context.logical_time == 0
        || context.logical_time > crate::state::MAX_LOGICAL_TIME
    {
        return Err(KinError::InvalidEvent);
    }
    if history
        .context()
        .target_household_id
        .is_some_and(|household| household != context.household_id)
        || history.conflicts_with(&context)
    {
        return Err(KinError::InvalidEvent);
    }
    let current = history.current()?;
    if let HouseholdCommand::Board(kind) = command {
        current.board.check_command(kind)?;
    }
    if let HouseholdCommand::Meal(kind) = command {
        current.meals.check_command(kind, &current.items)?;
    }
    if let HouseholdCommand::Picture(kind) = command {
        current.pictures.check_command(kind, &current.items)?;
    }
    if let HouseholdCommand::StoreSection(kind) = command {
        current.store_sections.check_command(kind, &current.items)?;
    }
    if let HouseholdCommand::Rotation(kind) = command {
        current.rotations.check_command(kind, &current.routines)?;
    }
    if let HouseholdCommand::SitterPage(kind) = command {
        current
            .sitter_page
            .check_command(kind, current.sitter_records())?;
    }
    if let HouseholdCommand::Album(kind) = command {
        current.album.check_command(kind)?;
    }
    if let HouseholdCommand::Calendar(kind) = command {
        current.calendar.check_command(kind, context.actor_id)?;
    }
    if let HouseholdCommand::Chore(kind) = command {
        current
            .chores
            .check_command(kind, context.actor_id, &current.routines)?;
    }
    if let HouseholdCommand::ChangeResponsibility {
        target_kind,
        target_id,
        member_id,
    } = command
    {
        if *target_id == [0; 16] || member_id.is_some_and(|id| id.0 == [0; 16]) {
            return Err(KinError::InvalidEvent);
        }
        let active = match target_kind {
            ResponsibilityTargetKind::Item => current
                .items
                .iter()
                .any(|item| item.item_id.0 == *target_id && item.status != ItemStatus::Archived),
            ResponsibilityTargetKind::Routine => current
                .routines
                .iter()
                .any(|routine| routine.routine_id.0 == *target_id && !routine.archived),
        };
        // A rotating routine's owner is whoever's turn it is (#429).
        let rotating = *target_kind == ResponsibilityTargetKind::Routine
            && current.rotations.is_rotating(&RoutineId(*target_id));
        if !active
            || rotating
            || current
                .responsibilities
                .iter()
                .find(|entry| entry.target_kind == *target_kind && entry.target_id == *target_id)
                .is_some_and(|entry| entry.member_id == *member_id)
        {
            return Err(KinError::InvalidEvent);
        }
    }
    // A device name must change something: describing a device under the
    // name it already has, or giving a nickname it already has, records
    // nothing new. A device keeps its member, and only that member names it.
    match command {
        HouseholdCommand::DescribeDevice { auto_name } => {
            let auto_name = crate::state::normalize_device_name(auto_name)?;
            if current
                .devices
                .iter()
                .find(|device| device.device_id == context.device_id)
                .is_some_and(|device| {
                    if device.member_id == context.actor_id {
                        device.auto_name.as_deref() == Some(auto_name.as_str())
                    } else {
                        // Another member's description; a nickname-only
                        // entry gives way to the device's own description.
                        device.auto_name.is_some()
                    }
                })
            {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::NicknameDevice {
            device_id,
            nickname,
        } => {
            let nickname = nickname
                .as_deref()
                .map(crate::state::normalize_device_nickname)
                .transpose()?;
            if !current.devices.iter().any(|device| {
                device.device_id == *device_id
                    && device.member_id == context.actor_id
                    && device.nickname != nickname
            }) {
                return Err(KinError::InvalidEvent);
            }
        }
        // A preferred name must change something: setting the name a member
        // already has, or clearing one they never set, records nothing.
        HouseholdCommand::NameMember { name } => {
            let name = name
                .as_deref()
                .map(crate::state::normalize_member_name)
                .transpose()?;
            let current_name = current
                .member_names
                .iter()
                .find(|entry| entry.member_id == context.actor_id)
                .map(|entry| entry.name.as_str());
            if current_name == name.as_deref() {
                return Err(KinError::InvalidEvent);
            }
        }
        _ => {}
    }
    // Chat: a command must change the chat, under the rules replay applies
    // (replay/chat.rs). Whether a remover is an admin is the service's to
    // say; the host offers removal only to admins, and a page counts a
    // removal only while its claimant is one.
    match command {
        // A blob reference is used once in a log (chat.rs `seen`).
        HouseholdCommand::PostChatMessage {
            id,
            content_kind,
            blob_ref,
            reply_to,
            mentions,
            ..
        } => {
            if current.chat.get(id).is_some() || current.chat.seen.contains(blob_ref) {
                return Err(KinError::InvalidEvent);
            }
            // A poll stands alone: no reply, no mentions, a valid shape.
            if let ChatContentKind::Poll(spec) = content_kind {
                if !spec.is_valid() || reply_to.is_some() || !mentions.is_empty() {
                    return Err(KinError::InvalidEvent);
                }
            }
            check_mentions(mentions, history.chat_members())?;
            // A reply answers a message this log holds that still shows.
            if let Some(original) = reply_to {
                let message = current.chat.get(original).ok_or(KinError::InvalidEvent)?;
                if !matches!(
                    current.chat.shown_status(message, history.chat_admins()),
                    crate::chat::ChatMessageStatus::Live | crate::chat::ChatMessageStatus::Edited
                ) {
                    return Err(KinError::InvalidEvent);
                }
            }
        }
        HouseholdCommand::EditChatMessage {
            id,
            blob_ref,
            mentions,
            ..
        } => {
            check_mentions(mentions, history.chat_members())?;
            if current.chat.seen.contains(blob_ref)
                || !current.chat.get(id).is_some_and(|message| {
                    message.author == context.actor_id
                        && message.status != crate::chat::ChatMessageStatus::Deleted
                        && message.content_kind == ChatContentKind::Text
                })
            {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::DeleteChatMessage { id, by_admin } => {
            let message = current.chat.get(id).ok_or(KinError::InvalidEvent)?;
            let own = message.author == context.actor_id;
            if message.status == crate::chat::ChatMessageStatus::Deleted
                || *by_admin == own
                || *by_admin
                    && (!history.chat_admins().contains(&context.actor_id)
                        || current
                            .chat
                            .admin_claims
                            .get(id)
                            .is_some_and(|claims| claims.contains(&context.actor_id)))
            {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::ReactChatMessage { id, emoji, on } => {
            crate::chat::check_emoji(emoji)?;
            let message = current.chat.get(id).ok_or(KinError::InvalidEvent)?;
            if !matches!(
                current.chat.shown_status(message, history.chat_admins()),
                crate::chat::ChatMessageStatus::Live | crate::chat::ChatMessageStatus::Edited
            ) {
                return Err(KinError::InvalidEvent);
            }
            let groups = current
                .chat
                .reactions
                .get(id)
                .map_or(&[][..], Vec::as_slice);
            let group = groups.iter().find(|group| group.emoji == *emoji);
            let mine = group.is_some_and(|group| group.actors.contains(&context.actor_id));
            if mine == *on
                || *on && group.is_none() && groups.len() >= crate::chat::MAX_REACTION_GROUPS
            {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::PinChatMessage { id, on } => {
            let pinned = current.chat.is_pinned(id);
            if *on {
                let message = current.chat.get(id).ok_or(KinError::InvalidEvent)?;
                if pinned
                    || !matches!(
                        current.chat.shown_status(message, history.chat_admins()),
                        crate::chat::ChatMessageStatus::Live
                            | crate::chat::ChatMessageStatus::Edited
                    )
                    || current.chat.pins.len() >= crate::chat::MAX_PIN_RECORDS
                    || current.chat.shown_pins(history.chat_admins()).len() >= crate::chat::MAX_PINS
                {
                    return Err(KinError::InvalidEvent);
                }
            } else if !pinned {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::VoteChatPoll { id, options } => {
            let message = current.chat.get(id).ok_or(KinError::InvalidEvent)?;
            let (spec, closed) = current.chat.poll_of(id).ok_or(KinError::InvalidEvent)?;
            let earlier = current
                .chat
                .polls
                .get(id)
                .and_then(|poll| poll.votes.get(&context.actor_id))
                .copied()
                .unwrap_or(0);
            let full = earlier == 0
                && current
                    .chat
                    .polls
                    .get(id)
                    .is_some_and(|poll| poll.votes.len() >= crate::chat::MAX_POLL_VOTERS);
            if closed
                || full
                || !spec.allows(*options)
                || earlier == *options
                || !matches!(
                    current.chat.shown_status(message, history.chat_admins()),
                    crate::chat::ChatMessageStatus::Live
                )
            {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::CloseChatPoll { id } => {
            let message = current.chat.get(id).ok_or(KinError::InvalidEvent)?;
            let (_, closed) = current.chat.poll_of(id).ok_or(KinError::InvalidEvent)?;
            if closed
                || message.author != context.actor_id
                || !matches!(
                    current.chat.shown_status(message, history.chat_admins()),
                    crate::chat::ChatMessageStatus::Live
                )
            {
                return Err(KinError::InvalidEvent);
            }
        }
        // A topic (#312) must change where the message stands. Opening or
        // resolving needs a message that shows; clearing needs only a
        // message not deleted, so a topic whose message an admin removed can
        // still be taken off the list.
        HouseholdCommand::SetChatTopic { id, state } => {
            use crate::chat::{ChatMessageStatus, ChatTopicState};
            let message = current.chat.get(id).ok_or(KinError::InvalidEvent)?;
            let shows = matches!(
                current.chat.shown_status(message, history.chat_admins()),
                ChatMessageStatus::Live | ChatMessageStatus::Edited
            );
            let now = current.chat.topic(id).map(|topic| topic.state);
            let allowed = match state {
                ChatTopicState::Open => {
                    shows
                        && match now {
                            None => current.chat.topics.len() < crate::chat::MAX_TOPICS,
                            Some(now) => now == ChatTopicState::Resolved,
                        }
                }
                ChatTopicState::Resolved => shows && now == Some(ChatTopicState::Open),
                ChatTopicState::Cleared => now.is_some(),
            };
            if message.status == ChatMessageStatus::Deleted || !allowed {
                return Err(KinError::InvalidEvent);
            }
        }
        _ => {}
    }
    if let HouseholdCommand::SetHouseholdMode(mode) = command {
        if current.mode == *mode {
            return Err(KinError::InvalidEvent);
        }
    }
    // A new completion or reopening must change the Item's status. The check
    // runs against the full local history inside the adapter's append
    // transaction, so a stale or repeated intent (a bulk action, its undo, or
    // a second tab) is rejected instead of recording a redundant fact. Replay
    // of historical duplicates stays idempotent.
    let item_intent = match command {
        HouseholdCommand::CompleteItem(id) => Some((id, ItemStatus::Active)),
        HouseholdCommand::ReopenItem(id) => Some((id, ItemStatus::Completed)),
        _ => None,
    };
    if let Some((id, required)) = item_intent {
        if !current
            .items
            .iter()
            .any(|item| item.item_id == *id && item.status == required)
        {
            return Err(KinError::InvalidEvent);
        }
    }
    if let HouseholdCommand::SetItemPlanningDate {
        item_id,
        planning_date,
    } = command
    {
        let item = current
            .items
            .iter()
            .find(|item| item.item_id == *item_id)
            .ok_or(KinError::InvalidEvent)?;
        if item.status == ItemStatus::Archived || item.planning_date == *planning_date {
            return Err(KinError::InvalidEvent);
        }
    }
    let routine_intent = match command {
        HouseholdCommand::CompleteOccurrence { id, key } => Some((id, key, false)),
        HouseholdCommand::ReopenOccurrence { id, key } => Some((id, key, true)),
        _ => None,
    };
    if let Some((id, key, completed)) = routine_intent {
        let routine = current
            .routines
            .iter()
            .find(|r| r.routine_id == *id)
            .ok_or(KinError::InvalidEvent)?;
        if routine.archived
            || current.mode != HouseholdMode::Normal
            || routine.occurrence_key != Some(*key)
            || routine.completed != completed
        {
            return Err(KinError::InvalidEvent);
        }
    }
    match command {
        HouseholdCommand::AddItemStep {
            item_id,
            step_id,
            text,
        } => {
            normalize_step_text(text)?;
            let item = current
                .items
                .iter()
                .find(|item| item.item_id == *item_id)
                .ok_or(KinError::InvalidEvent)?;
            if item.status != ItemStatus::Active
                || item.steps.len() >= MAX_STEPS_PER_ITEM
                || step_id.0 == [0; 16]
                || current
                    .items
                    .iter()
                    .any(|item| item.steps.iter().any(|step| step.step_id == *step_id))
            {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::CompleteItemStep { item_id, step_id }
        | HouseholdCommand::ReopenItemStep { item_id, step_id }
        | HouseholdCommand::ArchiveItemStep { item_id, step_id } => {
            let item = current
                .items
                .iter()
                .find(|item| item.item_id == *item_id && item.status == ItemStatus::Active)
                .ok_or(KinError::InvalidEvent)?;
            let step = item
                .steps
                .iter()
                .find(|step| step.step_id == *step_id && !step.archived)
                .ok_or(KinError::InvalidEvent)?;
            let valid_action = match command {
                HouseholdCommand::CompleteItemStep { .. } => !step.completed,
                HouseholdCommand::ReopenItemStep { .. } => step.completed,
                HouseholdCommand::ArchiveItemStep { .. } => true,
                _ => false,
            };
            if !valid_action {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::CreateArea { id, name } | HouseholdCommand::RenameArea { id, name } => {
            let normalized = normalize_area_name(name)?;
            if current.areas.iter().any(|area| {
                area.area_id != *id && area.name.to_lowercase() == normalized.to_lowercase()
            }) {
                return Err(KinError::InvalidEvent);
            }
            if matches!(command, HouseholdCommand::RenameArea { .. })
                && !current
                    .areas
                    .iter()
                    .any(|area| area.area_id == *id && !area.archived)
            {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::ArchiveArea(id)
            if current
                .areas
                .iter()
                .any(|area| area.area_id == *id && area.archived) =>
        {
            return Err(KinError::InvalidEvent)
        }
        HouseholdCommand::ArchiveArea(id)
            if !current.areas.iter().any(|area| area.area_id == *id) =>
        {
            return Err(KinError::InvalidEvent)
        }
        HouseholdCommand::ChangeItemArea { item_id, area_id } => {
            current
                .items
                .iter()
                .find(|item| item.item_id == *item_id && item.status != ItemStatus::Archived)
                .ok_or(KinError::InvalidEvent)?;
            if area_id.is_some_and(|id| {
                !current
                    .areas
                    .iter()
                    .any(|area| area.area_id == id && !area.archived)
            }) {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::CreateNote {
            id,
            title,
            body,
            area_id,
        } => {
            crate::state::normalize_note(title, body)?;
            if id.0 == [0; 16]
                || current.notes.len() >= crate::state::MAX_NOTES
                || current.notes.iter().any(|note| note.note_id == *id)
                || area_id.is_some_and(|area_id| {
                    !current
                        .areas
                        .iter()
                        .any(|area| area.area_id == area_id && !area.archived)
                })
            {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::UpdateNote {
            id,
            title,
            body,
            area_id,
        } => {
            crate::state::normalize_note(title, body)?;
            if !current
                .notes
                .iter()
                .any(|note| note.note_id == *id && note.status == crate::state::NoteStatus::Active)
                || area_id.is_some_and(|area_id| {
                    !current
                        .areas
                        .iter()
                        .any(|area| area.area_id == area_id && !area.archived)
                        && !current
                            .notes
                            .iter()
                            .any(|note| note.note_id == *id && note.area_id == Some(area_id))
                })
            {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::ArchiveNote(id)
            if !current.notes.iter().any(|note| {
                note.note_id == *id && note.status == crate::state::NoteStatus::Active
            }) =>
        {
            return Err(KinError::InvalidEvent)
        }
        HouseholdCommand::BindAttachment {
            id,
            parent_kind,
            parent_id,
        } => {
            if id.0 == [0; 16]
                || current.attachments.len() >= crate::state::MAX_ATTACHMENTS
                || current
                    .attachments
                    .iter()
                    .any(|attachment| attachment.attachment_id == *id)
                || current
                    .attachments
                    .iter()
                    .filter(|attachment| {
                        attachment.parent_kind == *parent_kind
                            && attachment.parent_id == *parent_id
                            && !attachment.removed
                    })
                    .count()
                    >= 5
            {
                return Err(KinError::InvalidEvent);
            }
            let exists = match parent_kind {
                AttachmentParentKind::Note => current
                    .notes
                    .iter()
                    .any(|item| item.note_id.0 == *parent_id),
                AttachmentParentKind::ReferenceRecord => current
                    .reference_records
                    .iter()
                    .any(|item| item.record_id.0 == *parent_id),
                AttachmentParentKind::Maintenance => current
                    .maintenance_events
                    .iter()
                    .any(|item| item.maintenance_id.0 == *parent_id),
                AttachmentParentKind::Item => current
                    .items
                    .iter()
                    .any(|item| item.item_id.0 == *parent_id),
            };
            if !exists {
                return Err(KinError::InvalidEvent);
            }
        }
        HouseholdCommand::RemoveAttachment(id)
            if !current
                .attachments
                .iter()
                .any(|item| item.attachment_id == *id && !item.removed) =>
        {
            return Err(KinError::InvalidEvent)
        }
        _ => {}
    }
    if let HouseholdCommand::CreateRoutine { created_on, .. } = command {
        if history.context().civil_date != *created_on {
            return Err(KinError::InvalidEvent);
        }
    }
    let event = create_event(command, context)?;
    let (projection, encoded_projection) = history.with_event(&event)?;
    Ok(CommandResult {
        event,
        projection,
        encoded_projection,
    })
}

fn field<const N: usize>(bytes: &[u8], offset: usize) -> Result<[u8; N], KinError> {
    bytes
        .get(offset..offset + N)
        .ok_or(KinError::MalformedProtocol)?
        .try_into()
        .map_err(|_| KinError::MalformedProtocol)
}

/// KCMD v1 is an intent transport, independent of immutable event schemas.
pub fn decode_command(bytes: &[u8]) -> Result<(HouseholdCommand, CommandContext), KinError> {
    if bytes.len() < 128
        || bytes.len()
            > 128
                + 24
                + crate::state::MAX_NOTE_TITLE_BYTES
                + crate::state::MAX_NOTE_BODY_BYTES.max(16 + crate::state::MAX_STEP_TEXT_BYTES)
        || &bytes[..4] != b"KCMD"
    {
        return Err(KinError::MalformedProtocol);
    }
    if u16::from_le_bytes(field(bytes, 4)?) != 1 {
        return Err(KinError::UnsupportedVersion);
    }
    if bytes[6..8] != [0; 2] || bytes[10..12] != [0; 2] || bytes[113..116] != [0; 3] {
        return Err(KinError::MalformedProtocol);
    }
    let kind = u16::from_le_bytes(field(bytes, 8)?);
    let id = field(bytes, 92)?;
    let date = u32::from_le_bytes(field(bytes, 108)?);
    let option = bytes[112];
    let expires = i64::from_le_bytes(field(bytes, 116)?);
    let text_length = u32::from_le_bytes(field(bytes, 124)?) as usize;
    if bytes.len() != 128 + text_length {
        return Err(KinError::MalformedProtocol);
    }
    // The fridge (#317): the text is the event's exact payload.
    if crate::board::is_board_code(kind) {
        if id != [0; 16] || date != 0 || option != 0 || expires != 0 {
            return Err(KinError::MalformedProtocol);
        }
        let event_kind = crate::board::decode_payload(kind, &bytes[128..])?;
        return Ok((HouseholdCommand::Board(event_kind), command_context(bytes)?));
    }
    // Meals (#333): likewise, the text is the event's exact payload.
    if crate::meals::is_meals_code(kind) {
        if id != [0; 16] || date != 0 || option != 0 || expires != 0 {
            return Err(KinError::MalformedProtocol);
        }
        let event_kind = crate::meals::decode_payload(kind, &bytes[128..])?;
        return Ok((HouseholdCommand::Meal(event_kind), command_context(bytes)?));
    }
    // Item emoji (#344): likewise.
    if crate::simple::is_simple_code(kind) {
        if id != [0; 16] || date != 0 || option != 0 || expires != 0 {
            return Err(KinError::MalformedProtocol);
        }
        let event_kind = crate::simple::decode_payload(kind, &bytes[128..])?;
        return Ok((
            HouseholdCommand::Picture(event_kind),
            command_context(bytes)?,
        ));
    }
    // Store sections (#411): likewise.
    if crate::store_sections::is_sections_code(kind) {
        if id != [0; 16] || date != 0 || option != 0 || expires != 0 {
            return Err(KinError::MalformedProtocol);
        }
        let event_kind = crate::store_sections::decode_payload(kind, &bytes[128..])?;
        return Ok((
            HouseholdCommand::StoreSection(event_kind),
            command_context(bytes)?,
        ));
    }
    // Routine rotations (#429): likewise.
    if crate::rotations::is_rotation_code(kind) {
        if id != [0; 16] || date != 0 || option != 0 || expires != 0 {
            return Err(KinError::MalformedProtocol);
        }
        let event_kind = crate::rotations::decode_payload(kind, &bytes[128..])?;
        return Ok((
            HouseholdCommand::Rotation(event_kind),
            command_context(bytes)?,
        ));
    }
    // The sitter page (#442): likewise.
    if crate::sitter::is_sitter_code(kind) {
        if id != [0; 16] || date != 0 || option != 0 || expires != 0 {
            return Err(KinError::MalformedProtocol);
        }
        let event_kind = crate::sitter::decode_payload(kind, &bytes[128..])?;
        return Ok((
            HouseholdCommand::SitterPage(event_kind),
            command_context(bytes)?,
        ));
    }
    // The family album (#673): likewise.
    if crate::album::is_album_code(kind) {
        if id != [0; 16] || date != 0 || option != 0 || expires != 0 {
            return Err(KinError::MalformedProtocol);
        }
        let event_kind = crate::album::decode_payload(kind, &bytes[128..])?;
        return Ok((HouseholdCommand::Album(event_kind), command_context(bytes)?));
    }
    // The family calendar (#656): likewise.
    if crate::calendar::is_calendar_code(kind) {
        if id != [0; 16] || date != 0 || option != 0 || expires != 0 {
            return Err(KinError::MalformedProtocol);
        }
        let event_kind = crate::calendar::decode_payload(kind, &bytes[128..])?;
        return Ok((
            HouseholdCommand::Calendar(event_kind),
            command_context(bytes)?,
        ));
    }
    // The chore chart (#676): likewise.
    if crate::chores::is_chore_code(kind) {
        if id != [0; 16] || date != 0 || option != 0 || expires != 0 {
            return Err(KinError::MalformedProtocol);
        }
        let event_kind = crate::chores::decode_payload(kind, &bytes[128..])?;
        return Ok((HouseholdCommand::Chore(event_kind), command_context(bytes)?));
    }
    let text = if matches!(kind, 21..=28 | 33 | 35 | 37 | 39 | 41 | 44..=46 | 48..=50 | 65) {
        String::new()
    } else {
        std::str::from_utf8(&bytes[128..])
            .map_err(|_| KinError::MalformedProtocol)?
            .to_owned()
    };
    let accepts_payload = matches!(kind, 1 | 5 | 8 | 14 | 18 | 19 | 42 | 43 | 47 | 51)
        || kind == 21 && text_length == 16
        || matches!(kind, 22 | 23) && text_length >= 24
        || kind == 25 && (17..=16 + crate::state::MAX_STEP_TEXT_BYTES).contains(&text_length)
        || kind == 39 && text_length == 16
        || kind == 41 && text_length == 16
        || matches!(kind, 44 | 45)
            && (64..=64 + 2 + 16 * crate::chat::MAX_CHAT_MENTIONS + 16).contains(&text_length);
    if !text.is_empty() && !accepts_payload
        || !(matches!(kind, 14..=16 | 30 | 49) || kind == 44 && option == 3) && date != 0
        || !matches!(
            kind,
            1 | 12 | 14 | 29 | 31 | 32 | 39 | 41 | 44 | 46 | 47 | 48 | 65
        ) && option != 0
        || kind != 12 && expires != 0
        || matches!(kind, 12 | 13 | 29) && id != [0; 16]
        || kind == 21 && text_length != 16
        || kind == 24 && text_length != 0
        || kind == 25 && !(17..=16 + crate::state::MAX_STEP_TEXT_BYTES).contains(&text_length)
        || matches!(kind, 26..=28) && text_length != 16
        || matches!(kind, 31 | 32 | 34 | 36) && text_length != 0
        || matches!(kind, 33..=41) && id == [0; 16]
        || kind == 37 && text_length < 42
        || kind == 38 && text_length != 0
        || kind == 39 && !matches!(option, 1..=4)
        || kind == 40 && text_length != 0
        || kind == 41 && (!matches!(option, 1..=2) || text_length != 16)
        || kind == 42 && (id != [0; 16] || text.is_empty())
        || kind == 43 && id == [0; 16]
        || matches!(kind, 42 | 43 | 51) && text_length > crate::state::MAX_DEVICE_NAME_BYTES
        || kind == 51 && id != [0; 16]
        || matches!(kind, 44..=50 | 65) && id == [0; 16]
        || kind == 65 && (text_length != 0 || option > 2)
        || kind == 49 && date > u32::from(u16::MAX)
        || matches!(kind, 49 | 50) && text_length != 0
        || kind == 47
            && (option > 1 || text.is_empty() || text_length > crate::chat::MAX_EMOJI_BYTES)
        || matches!(kind, 44 | 45) && text_length < 64
        || kind == 44 && !matches!(option, 1..=3)
        || kind == 44 && option == 3 && date > 0x1ff
        || kind == 44 && option == 3 && date >> 8 > 1
        || kind == 44 && option == 3 && !(2..=10).contains(&(date & 0xff))
        || matches!(kind, 46 | 48) && (text_length != 0 || option > 1)
        || matches!(kind, 44 | 45) && (bytes[128..160] == [0; 32] || bytes[160..192] == [0; 32])
    {
        return Err(KinError::MalformedProtocol);
    }
    use HouseholdCommand::*;
    let command = match kind {
        1 => AddItem {
            id: ItemId(id),
            text,
            classification: match option {
                0 => ItemClassification::Today,
                1 => ItemClassification::Need,
                2 => ItemClassification::Shopping,
                3 => ItemClassification::Staple,
                _ => return Err(KinError::MalformedProtocol),
            },
        },
        2 => CompleteItem(ItemId(id)),
        3 => ReopenItem(ItemId(id)),
        4 => ArchiveItem(ItemId(id)),
        25 if text_length >= 17 => {
            let item_id = ItemId(field(bytes, 128)?);
            let text = std::str::from_utf8(&bytes[144..])
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
            AddItemStep {
                item_id,
                step_id: StepId(id),
                text,
            }
        }
        26..=28 if text_length == 16 => {
            let item_id = ItemId(field(bytes, 128)?);
            match kind {
                26 => CompleteItemStep {
                    item_id,
                    step_id: StepId(id),
                },
                27 => ReopenItemStep {
                    item_id,
                    step_id: StepId(id),
                },
                _ => ArchiveItemStep {
                    item_id,
                    step_id: StepId(id),
                },
            }
        }
        5 => CaptureHandoff {
            id: HandoffId(id),
            text,
        },
        6 => AcknowledgeHandoff(HandoffId(id)),
        7 => ArchiveHandoff(HandoffId(id)),
        8 => CaptureTalk {
            id: TalkId(id),
            text,
        },
        9 => ResolveTalk(TalkId(id)),
        10 => ReopenTalk(TalkId(id)),
        11 => ArchiveTalk(TalkId(id)),
        12 => SetPulse {
            value: match option {
                0 => PulseValue::Good,
                1 => PulseValue::Okay,
                2 => PulseValue::Drained,
                3 => PulseValue::RoughDay,
                4 => PulseValue::NeedQuiet,
                _ => return Err(KinError::MalformedProtocol),
            },
            expires_at: expires,
        },
        13 => ClearPulse,
        14 => CreateRoutine {
            id: RoutineId(id),
            text,
            cadence: Cadence::try_from(option)?,
            created_on: CivilDate::from_encoded(date)?,
        },
        15 => CompleteOccurrence {
            id: RoutineId(id),
            key: CivilDate::from_encoded(date)?,
        },
        16 => ReopenOccurrence {
            id: RoutineId(id),
            key: CivilDate::from_encoded(date)?,
        },
        17 => ArchiveRoutine(RoutineId(id)),
        18 => CreateArea {
            id: AreaId(id),
            name: text,
        },
        19 => RenameArea {
            id: AreaId(id),
            name: text,
        },
        20 => ArchiveArea(AreaId(id)),
        21 if text_length == 16 => {
            let area: [u8; 16] = bytes[128..144]
                .try_into()
                .map_err(|_| KinError::MalformedProtocol)?;
            ChangeItemArea {
                item_id: ItemId(id),
                area_id: (area != [0; 16]).then_some(AreaId(area)),
            }
        }
        22 | 23 if text_length >= 24 => {
            let title_len = u32::from_le_bytes(field(bytes, 128 + 16)?) as usize;
            let body_len = u32::from_le_bytes(field(bytes, 128 + 20)?) as usize;
            if 24usize
                .checked_add(title_len)
                .and_then(|v| v.checked_add(body_len))
                != Some(text_length)
            {
                return Err(KinError::MalformedProtocol);
            }
            let title = std::str::from_utf8(&bytes[152..152 + title_len])
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
            let body = std::str::from_utf8(&bytes[152 + title_len..])
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
            let area: [u8; 16] = field(bytes, 128)?;
            let area_id = (area != [0; 16]).then_some(AreaId(area));
            if kind == 22 {
                CreateNote {
                    id: NoteId(id),
                    title,
                    body,
                    area_id,
                }
            } else {
                UpdateNote {
                    id: NoteId(id),
                    title,
                    body,
                    area_id,
                }
            }
        }
        24 if text_length == 0 => ArchiveNote(NoteId(id)),
        29 if text_length == 0 => SetHouseholdMode(match option {
            0 => HouseholdMode::Normal,
            1 => HouseholdMode::Vacation,
            2 => HouseholdMode::Guests,
            3 => HouseholdMode::Rest,
            _ => return Err(KinError::MalformedProtocol),
        }),
        30 if text_length == 0 => SetItemPlanningDate {
            item_id: ItemId(id),
            planning_date: (date != 0)
                .then(|| CivilDate::from_encoded(date))
                .transpose()?,
        },
        31 | 32 if text_length == 0 => {
            let target_kind = match option {
                1 => PinTargetKind::Item,
                2 => PinTargetKind::Note,
                3 => PinTargetKind::Routine,
                4 => PinTargetKind::Area,
                _ => return Err(KinError::MalformedProtocol),
            };
            if id == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            if kind == 31 {
                Pin {
                    target_kind,
                    target_id: id,
                }
            } else {
                Unpin {
                    target_kind,
                    target_id: id,
                }
            }
        }
        33 if text_length >= 4 => {
            let payload = &bytes[128..];
            let title_len = u16::from_le_bytes(field(payload, 0)?) as usize;
            let count = payload[2] as usize;
            if payload[3] != 0 || count == 0 || count > crate::state::MAX_PLAYBOOK_ENTRIES {
                return Err(KinError::MalformedProtocol);
            }
            let title_end = 4usize
                .checked_add(title_len)
                .ok_or(KinError::MalformedProtocol)?;
            let title = std::str::from_utf8(
                payload
                    .get(4..title_end)
                    .ok_or(KinError::MalformedProtocol)?,
            )
            .map_err(|_| KinError::MalformedProtocol)?
            .to_owned();
            let mut offset = title_end;
            let mut entries = Vec::with_capacity(count);
            for _ in 0..count {
                let length = u16::from_le_bytes(field(payload, offset)?) as usize;
                offset += 2;
                let end = offset
                    .checked_add(length)
                    .ok_or(KinError::MalformedProtocol)?;
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
            SavePlaybook {
                id: PlaybookId(id),
                title,
                entries,
            }
        }
        34 if text_length == 0 => ArchivePlaybook(PlaybookId(id)),
        35 if text_length >= 58 => {
            let payload = &bytes[128..];
            let area = field(payload, 16)?;
            let title_len = u16::from_le_bytes(field(payload, 32)?) as usize;
            let count = payload[34] as usize;
            if payload[35] != 0 || count == 0 || count > crate::state::MAX_REFERENCE_FIELDS {
                return Err(KinError::MalformedProtocol);
            }
            let title_end = 36usize
                .checked_add(title_len)
                .ok_or(KinError::MalformedProtocol)?;
            let title = std::str::from_utf8(
                payload
                    .get(36..title_end)
                    .ok_or(KinError::MalformedProtocol)?,
            )
            .map_err(|_| KinError::MalformedProtocol)?
            .to_owned();
            let mut offset = title_end;
            let mut fields = Vec::with_capacity(count);
            for _ in 0..count {
                let field_id = ReferenceFieldId(field(payload, offset)?);
                let label_len = u16::from_le_bytes(field(payload, offset + 16)?) as usize;
                let value_len = u16::from_le_bytes(field(payload, offset + 18)?) as usize;
                offset += 20;
                let label_end = offset
                    .checked_add(label_len)
                    .ok_or(KinError::MalformedProtocol)?;
                let value_end = label_end
                    .checked_add(value_len)
                    .ok_or(KinError::MalformedProtocol)?;
                let label = std::str::from_utf8(
                    payload
                        .get(offset..label_end)
                        .ok_or(KinError::MalformedProtocol)?,
                )
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
                let value = std::str::from_utf8(
                    payload
                        .get(label_end..value_end)
                        .ok_or(KinError::MalformedProtocol)?,
                )
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
                fields.push((field_id, label, value));
                offset = value_end;
            }
            if offset != payload.len() {
                return Err(KinError::MalformedProtocol);
            }
            SaveReferenceRecord {
                id: ReferenceRecordId(id),
                title,
                area_id: (area != [0; 16]).then_some(AreaId(area)),
                fields,
            }
        }
        36 if text_length == 0 => ArchiveReferenceRecord(ReferenceRecordId(id)),
        37 if text_length >= 42 => {
            let payload = bytes.get(128..).ok_or(KinError::MalformedProtocol)?;
            if payload.len() != text_length {
                return Err(KinError::MalformedProtocol);
            }
            let record_id = ReferenceRecordId(field(payload, 0)?);
            let performed_on = CivilDate::from_encoded(u32::from_le_bytes(field(payload, 16)?))?;
            let next_raw = u32::from_le_bytes(field(payload, 20)?);
            let routine = field(payload, 24)?;
            let summary_len = u16::from_le_bytes(field(payload, 40)?) as usize;
            if summary_len == 0 || payload.len() != 42 + summary_len {
                return Err(KinError::MalformedProtocol);
            }
            let summary = std::str::from_utf8(&payload[42..])
                .map_err(|_| KinError::MalformedProtocol)?
                .to_owned();
            SaveMaintenanceEvent {
                id: MaintenanceEventId(id),
                record_id,
                performed_on,
                summary,
                next_on: if next_raw == 0 {
                    None
                } else {
                    Some(CivilDate::from_encoded(next_raw)?)
                },
                routine_id: (routine != [0; 16]).then_some(RoutineId(routine)),
            }
        }
        38 if text_length == 0 => ArchiveMaintenanceEvent(MaintenanceEventId(id)),
        39 if text_length == 16 => BindAttachment {
            id: AttachmentId(id),
            parent_kind: match option {
                1 => AttachmentParentKind::Note,
                2 => AttachmentParentKind::ReferenceRecord,
                3 => AttachmentParentKind::Maintenance,
                4 => AttachmentParentKind::Item,
                _ => return Err(KinError::MalformedProtocol),
            },
            parent_id: field(bytes, 128)?,
        },
        40 if text_length == 0 => RemoveAttachment(AttachmentId(id)),
        41 if text_length == 16 => ChangeResponsibility {
            target_kind: match option {
                1 => ResponsibilityTargetKind::Item,
                2 => ResponsibilityTargetKind::Routine,
                _ => return Err(KinError::MalformedProtocol),
            },
            target_id: id,
            member_id: {
                let value = field(bytes, 128)?;
                (value != [0; 16]).then_some(ActorId(value))
            },
        },
        42 => DescribeDevice { auto_name: text },
        43 => NicknameDevice {
            device_id: DeviceId(id),
            nickname: (!text.is_empty()).then_some(text),
        },
        51 => NameMember {
            name: (!text.is_empty()).then_some(text),
        },
        44 | 45 => {
            let blob_ref = field(bytes, 128)?;
            let blob_key = field(bytes, 160)?;
            // After the blob: a reply's ID and/or mentions (#129, #130).
            let (mentions, reply_to) =
                crate::chat::ChatMentions::decode_tail(&bytes[192..], kind == 44)?;
            if kind == 44 {
                PostChatMessage {
                    id: ChatMessageId(id),
                    content_kind: match option {
                        1 => ChatContentKind::Text,
                        2 => ChatContentKind::Attachment,
                        // A poll: the option count in the low byte of the
                        // date field and a multiple-choice flag in the next.
                        _ => ChatContentKind::Poll(crate::chat::PollSpec {
                            options: (date & 0xff) as u8,
                            multiple: date >> 8 == 1,
                        }),
                    },
                    blob_ref,
                    blob_key,
                    reply_to,
                    mentions,
                }
            } else {
                EditChatMessage {
                    id: ChatMessageId(id),
                    blob_ref,
                    blob_key,
                    mentions,
                }
            }
        }
        46 => DeleteChatMessage {
            id: ChatMessageId(id),
            by_admin: option == 1,
        },
        47 => ReactChatMessage {
            id: ChatMessageId(id),
            emoji: text,
            on: option == 1,
        },
        48 => PinChatMessage {
            id: ChatMessageId(id),
            on: option == 1,
        },
        49 => VoteChatPoll {
            id: ChatMessageId(id),
            options: date as u16,
        },
        50 => CloseChatPoll {
            id: ChatMessageId(id),
        },
        65 => SetChatTopic {
            id: ChatMessageId(id),
            state: crate::chat::ChatTopicState::from_code(option)
                .ok_or(KinError::MalformedProtocol)?,
        },
        _ => return Err(KinError::UnsupportedVersion),
    };
    Ok((command, command_context(bytes)?))
}

/// The identity and time a KCMD names for its event.
fn command_context(bytes: &[u8]) -> Result<CommandContext, KinError> {
    Ok(CommandContext {
        event_id: EventId(field(bytes, 12)?),
        household_id: HouseholdId(field(bytes, 28)?),
        actor_id: ActorId(field(bytes, 44)?),
        device_id: DeviceId(field(bytes, 60)?),
        timestamp: i64::from_le_bytes(field(bytes, 76)?),
        logical_time: u64::from_le_bytes(field(bytes, 84)?),
    })
}

/// Validates a fridge command against the board log (#317): u32 command
/// length, KCMD (actions 52–58), then the record-less KINE context. Publishes
/// KCMT with an empty projection; the log is not changed.
pub fn execute_board_history(
    bytes: &[u8],
    history: &mut crate::history::History,
) -> Result<Vec<u8>, KinError> {
    if bytes.len() > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let command_length = u32::from_le_bytes(field(bytes, 0)?) as usize;
    let end = 4usize
        .checked_add(command_length)
        .ok_or(KinError::MalformedProtocol)?;
    let (command, context) = decode_command(bytes.get(4..end).ok_or(KinError::MalformedProtocol)?)?;
    let replay_context =
        crate::request::decode_context(bytes.get(end..).ok_or(KinError::MalformedProtocol)?)?;
    let mut held = HeldHistory::new(history, replay_context)?;
    command_result(execute_with(&command, context, &mut held)?)
}

pub fn encode_command(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    let (command, context) = decode_command(bytes)?;
    Ok(create_event(&command, context)?.canonical_bytes)
}

/// A command against the history an engine instance holds (`kin_execute`):
/// u32 intent length, the KCMD intent, then a record-less KINE request giving
/// the replay context. The history itself is not changed; the host appends
/// the new event once it is stored.
pub fn execute_history(
    bytes: &[u8],
    history: &mut crate::history::History,
) -> Result<Vec<u8>, KinError> {
    if bytes.len() > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let command_length = u32::from_le_bytes(field(bytes, 0)?) as usize;
    let end = 4usize
        .checked_add(command_length)
        .ok_or(KinError::MalformedProtocol)?;
    let (command, context) = decode_command(bytes.get(4..end).ok_or(KinError::MalformedProtocol)?)?;
    let replay_context =
        crate::request::decode_context(bytes.get(end..).ok_or(KinError::MalformedProtocol)?)?;
    let mut held = HeldHistory::new(history, replay_context)?;
    command_result(execute_with(&command, context, &mut held)?)
}

/// A message may mention only members the host names as able to read chat
/// (#130); `@everyone` needs no list.
fn check_mentions(
    mentions: &crate::chat::ChatMentions,
    members: &[ActorId],
) -> Result<(), KinError> {
    if mentions
        .members
        .iter()
        .all(|member| members.contains(member))
    {
        Ok(())
    } else {
        Err(KinError::InvalidEvent)
    }
}

/// A chat command against the instance's chat log (`kin_chat_execute`): u32
/// intent length, the KCMD intent, u32 admin count (at most 16), the
/// household admins' member IDs (16 bytes each, non-zero), u32 member count
/// (at most 64) and the IDs of members who can read chat (#130), then a
/// record-less KINE context. The admins are the service's word on who may
/// remove other members' messages; an honest client offers removal only to
/// them, and Rust refuses a removal by anyone else.
pub fn execute_chat_history(
    bytes: &[u8],
    history: &mut crate::history::History,
) -> Result<Vec<u8>, KinError> {
    if bytes.len() > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let command_length = u32::from_le_bytes(field(bytes, 0)?) as usize;
    let end = 4usize
        .checked_add(command_length)
        .ok_or(KinError::MalformedProtocol)?;
    let (command, context) = decode_command(bytes.get(4..end).ok_or(KinError::MalformedProtocol)?)?;
    let admin_count = u32::from_le_bytes(field(bytes, end)?) as usize;
    if admin_count > crate::chat::MAX_CHAT_ADMINS {
        return Err(KinError::MalformedProtocol);
    }
    let admins_end = end + 4 + admin_count * 16;
    let admins = bytes
        .get(end + 4..admins_end)
        .ok_or(KinError::MalformedProtocol)?
        .chunks_exact(16)
        .map(|chunk| ActorId(chunk.try_into().unwrap()))
        .collect::<Vec<_>>();
    if admins.iter().any(|admin| admin.0 == [0; 16]) {
        return Err(KinError::MalformedProtocol);
    }
    // The members able to read chat (#130), after the admins.
    let member_count = u32::from_le_bytes(field(bytes, admins_end)?) as usize;
    if member_count > crate::chat::MAX_CHAT_MEMBERS {
        return Err(KinError::MalformedProtocol);
    }
    let members_end = admins_end + 4 + member_count * 16;
    let members = bytes
        .get(admins_end + 4..members_end)
        .ok_or(KinError::MalformedProtocol)?
        .chunks_exact(16)
        .map(|chunk| ActorId(chunk.try_into().unwrap()))
        .collect::<Vec<_>>();
    if members.iter().any(|member| member.0 == [0; 16]) {
        return Err(KinError::MalformedProtocol);
    }
    let replay_context = crate::request::decode_context(
        bytes
            .get(members_end..)
            .ok_or(KinError::MalformedProtocol)?,
    )?;
    let mut held = HeldHistory::new(history, replay_context)?
        .with_admins(admins)
        .with_members(members);
    command_result(execute_with(&command, context, &mut held)?)
}

/// The same command against a whole KINE request (tests).
pub fn execute_request(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    if bytes.len() > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let command_length = u32::from_le_bytes(field(bytes, 0)?) as usize;
    let end = 4usize
        .checked_add(command_length)
        .ok_or(KinError::MalformedProtocol)?;
    let (command, context) = decode_command(bytes.get(4..end).ok_or(KinError::MalformedProtocol)?)?;
    let request = decode_request(bytes.get(end..).ok_or(KinError::MalformedProtocol)?)?;
    command_result(execute(&command, context, request)?)
}

/// KCMT: the new event, its metadata and the candidate projection.
fn command_result(result: CommandResult) -> Result<Vec<u8>, KinError> {
    let metadata = encode_metadata(&result.event.canonical_bytes)?;
    let length =
        20 + result.event.canonical_bytes.len() + metadata.len() + result.encoded_projection.len();
    if length > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let mut output = Vec::with_capacity(length);
    output.extend_from_slice(b"KCMT\x01\0\0\0");
    output.extend_from_slice(&(result.event.canonical_bytes.len() as u32).to_le_bytes());
    output.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    output.extend_from_slice(&(result.encoded_projection.len() as u32).to_le_bytes());
    output.extend_from_slice(&result.event.canonical_bytes);
    output.extend_from_slice(&metadata);
    output.extend_from_slice(&result.encoded_projection);
    Ok(output)
}
