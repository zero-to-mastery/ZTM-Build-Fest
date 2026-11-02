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
id_type!(AreaId);
id_type!(NoteId);
id_type!(StepId);
id_type!(PlaybookId);
id_type!(ReferenceRecordId);
id_type!(ReferenceFieldId);
id_type!(MaintenanceEventId);
id_type!(AttachmentId);
id_type!(ChatMessageId);
// A fridge stroke, magnet or clear (#317, board.rs).
id_type!(BoardId);
// A saved recipe (#333, meals.rs).
id_type!(RecipeId);
// A Shopping store section, such as "Dairy" (#411, store_sections.rs).
id_type!(StoreSectionId);
// A record in a member's private log (#489, private.rs).
id_type!(PrivateRecordId);
// A family calendar event (#656, calendar.rs).
id_type!(CalendarEventId);

/// What a chat message's content blob holds (#109).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatContentKind {
    Text,
    Attachment,
    /// A poll (#135): its question and options are the blob; the number of
    /// options and whether several may be chosen are part of the event, so
    /// Rust can check votes.
    Poll(crate::chat::PollSpec),
}

impl ChatContentKind {
    /// The kind's code in events and pages: 1 text, 2 attachment, 3 poll.
    pub const fn code(self) -> u8 {
        match self {
            ChatContentKind::Text => 1,
            ChatContentKind::Attachment => 2,
            ChatContentKind::Poll(_) => 3,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum AttachmentParentKind {
    Note = 1,
    ReferenceRecord = 2,
    Maintenance = 3,
    Item = 4,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ResponsibilityTargetKind {
    Item = 1,
    Routine = 2,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum PinTargetKind {
    Item = 1,
    Note = 2,
    Routine = 3,
    Area = 4,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[repr(u8)]
pub enum HouseholdMode {
    #[default]
    Normal = 0,
    Vacation = 1,
    Guests = 2,
    Rest = 3,
}

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
    Shopping,
    Staple,
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
    ItemPlanningDateChanged {
        item_id: ItemId,
        planning_date: Option<CivilDate>,
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
    AreaCreated {
        area_id: AreaId,
        name: String,
    },
    AreaRenamed {
        area_id: AreaId,
        name: String,
    },
    AreaArchived {
        area_id: AreaId,
    },
    ItemAreaChanged {
        item_id: ItemId,
        area_id: Option<AreaId>,
    },
    NoteCreated {
        note_id: NoteId,
        title: String,
        body: String,
        area_id: Option<AreaId>,
    },
    NoteUpdated {
        note_id: NoteId,
        title: String,
        body: String,
        area_id: Option<AreaId>,
    },
    NoteArchived {
        note_id: NoteId,
    },
    ItemStepAdded {
        item_id: ItemId,
        step_id: StepId,
        text: String,
    },
    ItemStepCompleted {
        item_id: ItemId,
        step_id: StepId,
    },
    ItemStepReopened {
        item_id: ItemId,
        step_id: StepId,
    },
    ItemStepArchived {
        item_id: ItemId,
        step_id: StepId,
    },
    HouseholdModeChanged {
        mode: HouseholdMode,
    },
    PinAdded {
        target_kind: PinTargetKind,
        target_id: [u8; 16],
    },
    PinRemoved {
        target_kind: PinTargetKind,
        target_id: [u8; 16],
    },
    PlaybookSaved {
        playbook_id: PlaybookId,
        title: String,
        entries: Vec<String>,
    },
    PlaybookArchived {
        playbook_id: PlaybookId,
    },
    ReferenceRecordSaved {
        record_id: ReferenceRecordId,
        title: String,
        area_id: Option<AreaId>,
        fields: Vec<(ReferenceFieldId, String, String)>,
    },
    ReferenceRecordArchived {
        record_id: ReferenceRecordId,
    },
    MaintenanceEventSaved {
        maintenance_id: MaintenanceEventId,
        record_id: ReferenceRecordId,
        performed_on: CivilDate,
        summary: String,
        next_on: Option<CivilDate>,
        routine_id: Option<RoutineId>,
    },
    MaintenanceEventArchived {
        maintenance_id: MaintenanceEventId,
    },
    AttachmentBound {
        attachment_id: AttachmentId,
        parent_kind: AttachmentParentKind,
        parent_id: [u8; 16],
    },
    AttachmentRemoved {
        attachment_id: AttachmentId,
    },
    ResponsibilityChanged {
        target_kind: ResponsibilityTargetKind,
        target_id: [u8; 16],
        member_id: Option<ActorId>,
    },
    /// A device announces its own automatic name ("Chrome on iPhone"). The
    /// device named is the event's header device; the name is canonical
    /// (`state::normalize_device_name`).
    DeviceDescribed {
        auto_name: String,
    },
    /// Sets (Some) or clears (None) a device's nickname. Only the member the
    /// device belongs to may name it (replay/devices.rs).
    DeviceNicknamed {
        device_id: DeviceId,
        nickname: Option<String>,
    },
    /// Sets (Some) or clears (None) the event's own member's preferred
    /// display name (#218, #224). The member named is always the header actor,
    /// so a member can only ever name themselves; the name is presentation
    /// only and never authority. Canonical (`state::normalize_member_name`).
    MemberNamed {
        name: Option<String>,
    },
    /// A chat message (#109). Its content is a blob outside the log: the
    /// 32-byte content hash and the blob's own 32-byte key (chat.rs).
    ChatMessagePosted {
        message_id: ChatMessageId,
        content_kind: ChatContentKind,
        blob_ref: [u8; 32],
        blob_key: [u8; 32],
        /// The message this one answers (#129). Its text is looked up at
        /// render time, never copied.
        reply_to: Option<ChatMessageId>,
        /// Who it mentions (#130).
        mentions: crate::chat::ChatMentions,
    },
    /// The author replaces a message's content with a new blob.
    ChatMessageEdited {
        message_id: ChatMessageId,
        blob_ref: [u8; 32],
        blob_key: [u8; 32],
        /// Who the edited message mentions (#130): replaces the earlier list.
        mentions: crate::chat::ChatMentions,
    },
    /// Deletes a message for everyone: by its author, or (`by_admin`) by a
    /// household admin.
    ChatMessageDeleted {
        message_id: ChatMessageId,
        by_admin: bool,
    },
    /// A member turns one emoji reaction to a message on or off (#127). The
    /// emoji is one grapheme (`chat::check_emoji`). The last write per
    /// (member, message, emoji) in replay order wins.
    ChatReactionSet {
        message_id: ChatMessageId,
        emoji: String,
        on: bool,
    },
    /// A member pins a message, or unpins one (#131). Pinning a message that
    /// is already pinned changes nothing; any member may unpin.
    ChatPinSet {
        message_id: ChatMessageId,
        on: bool,
    },
    /// A member's vote in a poll (#135): the options chosen as a bit set
    /// (bit n is option n), which replaces their earlier vote; none clears
    /// it. Ignored once the poll is closed.
    ChatPollVote {
        message_id: ChatMessageId,
        options: u16,
    },
    /// The poll's author closes it (#135): no vote counts after this.
    ChatPollClosed {
        message_id: ChatMessageId,
    },
    /// "Talk later" (#312, ADR 0014): puts a message on the "To talk about"
    /// list (open), marks it talked about (resolved), or takes it off
    /// (cleared). The latest in replay order wins.
    ChatTopicSet {
        message_id: ChatMessageId,
        state: crate::chat::ChatTopicState,
    },
    /// The fridge (#317, board.rs): a stroke in the board's coordinates.
    BoardStrokeAdded {
        stroke_id: BoardId,
        colour: u8,
        width: u8,
        points: Vec<(u16, u16)>,
    },
    /// Erases (hidden) or restores a stroke.
    BoardStrokeHidden {
        stroke_id: BoardId,
        hidden: bool,
    },
    BoardMagnetPlaced {
        magnet_id: BoardId,
        x: u16,
        y: u16,
        content: crate::board::MagnetContent,
    },
    BoardMagnetMoved {
        magnet_id: BoardId,
        x: u16,
        y: u16,
    },
    /// Removes (hidden) or restores a magnet.
    BoardMagnetHidden {
        magnet_id: BoardId,
        hidden: bool,
    },
    BoardCleared {
        clear_id: BoardId,
    },
    /// Meals (#333, meals.rs): a recipe saved whole.
    RecipeSaved {
        recipe_id: RecipeId,
        name: String,
        ingredients: Vec<crate::meals::Ingredient>,
        notes: String,
    },
    RecipeArchived {
        recipe_id: RecipeId,
    },
    /// The dinner for one civil date: a recipe (with its name when planned)
    /// or a one-off name.
    DinnerSet {
        date: CivilDate,
        recipe_id: Option<RecipeId>,
        name: String,
    },
    DinnerCleared {
        date: CivilDate,
    },
    /// Who's cooking on a date; `None` is "No one yet".
    DinnerCookSet {
        date: CivilDate,
        member_id: Option<ActorId>,
    },
    /// Fuller meal plans (#679, ADR 0022 §7, meals.rs): a breakfast, lunch
    /// or snack for one civil date, as a recipe (with its name when planned)
    /// or a one-off name. Never dinner: dinners keep kinds 61–63.
    MealSet {
        date: CivilDate,
        slot: crate::meals::MealSlot,
        recipe_id: Option<RecipeId>,
        name: String,
    },
    MealCleared {
        date: CivilDate,
        slot: crate::meals::MealSlot,
    },
    /// A recipe marked as a favourite, or not.
    RecipeFavouriteSet {
        recipe_id: RecipeId,
        favourite: bool,
    },
    BoardClearUndone {
        clear_id: BoardId,
    },
    /// Simple view (#344, simple.rs): an item's picture emoji; `None` clears.
    ItemEmojiSet {
        item_id: ItemId,
        emoji: Option<String>,
    },
    /// Store sections (#411, store_sections.rs): the household's whole
    /// ordered section list, replacing the previous one.
    ShoppingSectionsSet {
        sections: Vec<crate::store_sections::StoreSection>,
    },
    /// An item's store section; `None` clears it.
    ItemSectionSet {
        item_id: ItemId,
        section_id: Option<StoreSectionId>,
    },
    /// Taking turns (#429, rotations.rs): a routine's ordered rotation and
    /// the index whose turn it is; an empty list ends the rotation.
    RoutineRotationSet {
        routine_id: RoutineId,
        members: Vec<ActorId>,
        current: u8,
    },
    /// It's this listed member's turn on the routine now.
    RoutineTurnSet {
        routine_id: RoutineId,
        member_id: ActorId,
    },
    /// The sitter page (#442, sitter.rs): an intro (empty for none) and the
    /// ordered entries, replacing the previous page.
    SitterPageSet {
        intro: String,
        entries: Vec<crate::sitter::SitterEntry>,
    },
    /// The family album (#673, album.rs): a photo, the album attachment
    /// holding its encrypted image, and a caption (empty for none).
    AlbumPhotoAdded {
        photo_id: [u8; 16],
        attachment_id: [u8; 16],
        caption: String,
    },
    /// Takes a photo out of the album.
    AlbumPhotoRemoved {
        photo_id: [u8; 16],
    },
    /// Family calendar (#656, calendar.rs, kind 71): the whole event,
    /// replacing any earlier version with its ID.
    CalendarEventSaved(Box<crate::calendar::CalendarEvent>),
    /// Kind 72: one occurrence (by its original start) or, with `None`, the
    /// whole series is cancelled.
    CalendarEventCancelled {
        event_id: CalendarEventId,
        occurrence: Option<crate::calendar::CalendarTime>,
    },
    /// Kind 73: undoes a cancel of that occurrence, or of the series.
    CalendarEventRestored {
        event_id: CalendarEventId,
        occurrence: Option<crate::calendar::CalendarTime>,
    },
    /// Kind 74: the event's own member's palette colour (0–11); `None` goes
    /// back to the default.
    MemberColourSet {
        colour: Option<u8>,
    },
    /// The chore chart (#676, chores.rs): a routine's points per completed
    /// occurrence, 0–10 (1 when never set).
    ChorePointsSet {
        routine_id: RoutineId,
        points: u8,
    },
    /// A member's reward goal this week and its text; goal 0 with no text
    /// clears it.
    ChoreRewardSet {
        member_id: ActorId,
        goal: u16,
        text: String,
    },
    /// A member joins or leaves the chart; only that member may say so.
    ChoreChartJoined {
        member_id: ActorId,
        joined: bool,
    },
    /// A member's private log (#489, private.rs): the placeholder private
    /// note, set to `text`; empty text removes it.
    PrivateNoteSet {
        note_id: PrivateRecordId,
        text: String,
    },
    /// "Just for me" (#510, private_items.rs, kinds 110–118), in a member's
    /// private log only.
    PrivateItem(crate::private_items::PrivateItemEvent),
    /// A reminder that follows its member (#522, private_prefs.rs): set or moved
    /// to the absolute instant `at`, with the setter's UTC offset and time
    /// zone at that instant.
    ReminderSet {
        target: crate::private_prefs::ReminderTarget,
        at: i64,
        utc_offset_minutes: i16,
        time_zone: String,
    },
    /// A reminder canceled, done or dismissed (#522, private_prefs.rs). Done and
    /// dismissed clear only the reminder still set for `at`.
    ReminderCleared {
        target: crate::private_prefs::ReminderTarget,
        reason: crate::private_prefs::ReminderClearReason,
        at: i64,
    },
    /// One personal setting that follows its member (#525, private_prefs.rs); an
    /// empty value unsets it.
    SettingSet {
        key: u16,
        value: String,
    },
    /// A member's journal (#496, journal.rs), in their private log: entry
    /// created, edited, deleted or restored (kinds 101–104).
    Journal(crate::journal::JournalEvent),
}

impl EventKind {
    /// Chat events (#109) live in the chat log, never in the household log
    /// (history.rs): the two are replayed, capped and kept apart.
    pub const fn is_chat(&self) -> bool {
        matches!(
            self,
            EventKind::ChatMessagePosted { .. }
                | EventKind::ChatMessageEdited { .. }
                | EventKind::ChatMessageDeleted { .. }
                | EventKind::ChatReactionSet { .. }
                | EventKind::ChatPinSet { .. }
                | EventKind::ChatPollVote { .. }
                | EventKind::ChatPollClosed { .. }
                | EventKind::ChatTopicSet { .. }
        )
    }

    /// Whether this is a private event (#489, ADR 0019), which only a
    /// member's private log holds.
    pub const fn is_private(&self) -> bool {
        matches!(
            self,
            EventKind::PrivateNoteSet { .. }
                | EventKind::PrivateItem(_)
                | EventKind::ReminderSet { .. }
                | EventKind::ReminderCleared { .. }
                | EventKind::SettingSet { .. }
                | EventKind::Journal(_)
        )
    }

    /// Whether this is a fridge event (#317), which only the board log holds.
    pub const fn is_board(&self) -> bool {
        matches!(
            self,
            EventKind::BoardStrokeAdded { .. }
                | EventKind::BoardStrokeHidden { .. }
                | EventKind::BoardMagnetPlaced { .. }
                | EventKind::BoardMagnetMoved { .. }
                | EventKind::BoardMagnetHidden { .. }
                | EventKind::BoardCleared { .. }
                | EventKind::BoardClearUndone { .. }
        )
    }
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
