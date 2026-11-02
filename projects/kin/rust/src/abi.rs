use std::ops::Range;
use std::sync::Mutex;

use crate::error::KinError;
use crate::history::History;
use crate::sections::SectionRevisions;
use crate::wire::{ERROR_PROTOCOL_VERSION, MAX_PROTOCOL_BYTES};

/// Live `kin_alloc` buffers. The host holds one or two at a time (an input
/// for the call in progress), so a small fixed table replaces a map: no
/// allocation per call, and a leak shows up as a failed `kin_alloc`.
const ALLOCATION_SLOTS: usize = 8;

struct Allocations {
    slots: [Option<Box<[u8]>>; ALLOCATION_SLOTS],
}

impl Allocations {
    const fn new() -> Self {
        Self {
            slots: [const { None }; ALLOCATION_SLOTS],
        }
    }

    /// Stores `buffer`; false when every slot is taken.
    fn insert(&mut self, buffer: Box<[u8]>) -> bool {
        match self.slots.iter_mut().find(|slot| slot.is_none()) {
            Some(slot) => {
                *slot = Some(buffer);
                true
            }
            None => false,
        }
    }

    /// The live buffer starting at `pointer`.
    fn get(&self, pointer: u32) -> Option<&[u8]> {
        self.slots
            .iter()
            .flatten()
            .find(|buffer| buffer_pointer(buffer) == pointer)
            .map(|buffer| &buffer[..])
    }

    /// Frees the buffer at `pointer` if it has exactly `length` bytes.
    fn remove(&mut self, pointer: u32, length: u32) -> bool {
        for slot in &mut self.slots {
            if slot.as_ref().is_some_and(|buffer| {
                buffer_pointer(buffer) == pointer && buffer.len() == length as usize
            }) {
                *slot = None;
                return true;
            }
        }
        false
    }

    fn clear(&mut self) {
        self.slots = [const { None }; ALLOCATION_SLOTS];
    }
}

fn buffer_pointer(buffer: &[u8]) -> u32 {
    buffer.as_ptr() as usize as u32
}

struct AbiState {
    allocations: Allocations,
    /// The canonical history this instance replays (history.rs).
    history: History,
    /// The chat log, apart from the household history (history.rs).
    chat_history: History,
    /// Decrypted chat texts, while unlocked (chat.rs).
    chat_texts: crate::chat::ChatTexts,
    /// The fridge log (#317, board.rs), apart from the other two.
    board_history: History,
    /// The unlocked member's private log (#489, private.rs).
    private_history: History,
    result: Vec<u8>,
    error: Vec<u8>,
    /// Where `result` holds a projection, when it does.
    projection: Option<Range<usize>>,
    /// The last emitted projection's buffer and range, kept after a later
    /// non-projection call replaced `result`, so revisions stay comparable.
    previous: Vec<u8>,
    previous_projection: Option<Range<usize>>,
    revisions: SectionRevisions,
}

impl AbiState {
    const fn new() -> Self {
        Self {
            allocations: Allocations::new(),
            history: History::new(),
            chat_history: History::chat(),
            chat_texts: crate::chat::ChatTexts::new(),
            board_history: History::board(),
            private_history: History::private(),
            result: Vec::new(),
            error: Vec::new(),
            projection: None,
            previous: Vec::new(),
            previous_projection: None,
            revisions: SectionRevisions::new(),
        }
    }

    /// Clears the published buffers before an operation. A projection in
    /// `result` moves aside (no copy) as the basis for the next revisions.
    fn begin(&mut self) {
        if let Some(range) = self.projection.take() {
            self.previous = std::mem::take(&mut self.result);
            self.previous_projection = Some(range);
        } else {
            self.result.clear();
        }
        self.error.clear();
    }

    /// Stamps the section revisions of a projection inside `result`, then
    /// drops the previous projection: `result` is the basis from now on.
    fn stamp(&mut self, result: &mut [u8], range: Range<usize>) -> Result<(), KinError> {
        let previous = self
            .previous_projection
            .as_ref()
            .and_then(|range| self.previous.get(range.clone()));
        self.revisions.stamp(&mut result[range.clone()], previous)?;
        self.previous = Vec::new();
        self.previous_projection = None;
        self.projection = Some(range);
        Ok(())
    }
}

impl AbiState {
    /// Drops every retained buffer (`kin_clear`). Revision counters survive:
    /// a later projection must never reuse a revision a host may still hold,
    /// and without a previous projection every section counts as changed.
    fn clear(&mut self) {
        self.allocations.clear();
        self.history.clear();
        self.chat_history.clear();
        self.chat_texts.clear();
        self.board_history.clear();
        self.private_history.clear();
        self.result = Vec::new();
        self.error = Vec::new();
        self.projection = None;
        self.previous = Vec::new();
        self.previous_projection = None;
    }

    /// Empties the chat log, keeping the text arena (`kin_chat_history_reset`).
    fn reset_chat_history(&mut self) {
        self.chat_history.clear();
    }

    /// Publishes an operation's outcome as the result or error buffer and
    /// returns the status code.
    fn publish(&mut self, outcome: Result<Vec<u8>, KinError>, locate: Option<Locate>) -> i32 {
        let outcome = outcome.and_then(|mut result| {
            if let Some(range) = locate.and_then(|locate| locate(&result)) {
                self.stamp(&mut result, range)?;
            }
            Ok(result)
        });
        match outcome {
            Ok(result) => {
                self.result = result;
                0
            }
            Err(error) => {
                self.error = error_buffer(error);
                error.code()
            }
        }
    }
}

/// Locates the projection inside an operation's result.
type Locate = fn(&[u8]) -> Option<Range<usize>>;

/// A KINS result is the projection itself.
fn whole(result: &[u8]) -> Option<Range<usize>> {
    Some(0..result.len())
}

/// KCMT header: "KCMT", version u16, reserved u16, then the event, metadata
/// and projection lengths as u32 at 8, 12 and 16 (command.rs execute_request).
const KCMT_HEADER_BYTES: usize = 20;

/// A KCMT result ends with the projection, after the event and metadata.
/// None (the result is then left unstamped, revision 0) if the lengths do not
/// add up, which a well-formed result never does.
fn command_projection(result: &[u8]) -> Option<Range<usize>> {
    let length = |at: usize| -> Option<usize> {
        Some(u32::from_le_bytes(result.get(at..at + 4)?.try_into().ok()?) as usize)
    };
    let start = KCMT_HEADER_BYTES
        .checked_add(length(8)?)?
        .checked_add(length(12)?)?;
    (start.checked_add(length(16)?)? == result.len()).then_some(start..result.len())
}

// One per WASM instance: each loaded engine is its own instance with its own
// statics, which is why revisions are "per engine instance". WASM here is
// single-threaded; the Mutex is what Rust requires for a mutable static and
// what keeps native test builds, which do run threads, sound.
static ABI_STATE: Mutex<AbiState> = Mutex::new(AbiState::new());

fn lock_state() -> std::sync::MutexGuard<'static, AbiState> {
    ABI_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn request_length_is_supported(length: u32) -> bool {
    usize::try_from(length).is_ok_and(|size| size <= MAX_PROTOCOL_BYTES)
}

fn error_buffer(error: KinError) -> Vec<u8> {
    let message = error.message().as_bytes();
    let mut bytes = Vec::new();
    if bytes.try_reserve_exact(12 + message.len()).is_err() {
        return bytes;
    }
    bytes.extend_from_slice(b"KERR");
    bytes.extend_from_slice(&ERROR_PROTOCOL_VERSION.to_le_bytes());
    bytes.extend_from_slice(&(error.code() as u16).to_le_bytes());
    bytes.extend_from_slice(&(message.len() as u32).to_le_bytes());
    bytes.extend_from_slice(message);
    bytes
}

fn active_buffer_pointer(bytes: &[u8]) -> u32 {
    if bytes.is_empty() {
        0
    } else {
        bytes.as_ptr() as usize as u32
    }
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_alloc(length: u32) -> u32 {
    if length == 0 || !request_length_is_supported(length) {
        return 0;
    }
    let Ok(capacity) = usize::try_from(length) else {
        return 0;
    };
    let mut bytes = Vec::new();
    if bytes.try_reserve_exact(capacity).is_err() {
        return 0;
    }
    bytes.resize(capacity, 0);
    let allocation = bytes.into_boxed_slice();
    let pointer = buffer_pointer(&allocation);
    if pointer == 0 || !lock_state().allocations.insert(allocation) {
        return 0;
    }
    pointer
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_free(pointer: u32, length: u32) -> i32 {
    // kin_alloc returns 0 for a failed or empty allocation; freeing that
    // "nothing" succeeds, so a host can free unconditionally.
    if pointer == 0 && length == 0 {
        return 0;
    }
    if lock_state().allocations.remove(pointer, length) {
        0
    } else {
        KinError::InvalidAbi.code()
    }
}

/// Empties the instance's history (a new store generation, another history,
/// or lock). Always succeeds.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_history_reset() -> i32 {
    lock_state().history.clear();
    0
}

/// Appends a batch of canonical records (history.rs) after those held. On
/// failure nothing is appended and the error buffer says why.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_history_append(pointer: u32, length: u32) -> i32 {
    run(
        pointer,
        length,
        |input, history| history.append(input).map(|()| Vec::new()),
        None,
    )
}

/// Keeps the first `count` records: rolls back records appended only for one
/// replay (a command candidate, remote events being reconciled). Returns
/// InvalidAbi's code for a count beyond the history; result and error
/// buffers are left as they were.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_history_truncate(count: u32) -> i32 {
    match lock_state().history.truncate(count as usize) {
        Ok(()) => 0,
        Err(error) => error.code(),
    }
}

/// Replays the instance's history in the context of a record-less KINE
/// request (as_of, cursor, civil date, target household, bindings) and
/// publishes the KINS projection with its section revisions.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_project(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::core::replay_history, Some(whole))
}

/// Replays the instance's history in the context of a record-less KINE
/// request and publishes the KDEV device-name table (core.rs).
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_device_names(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::core::device_names, None)
}

/// Meals (KMLS v1, #333) in the instance's history, in the context of a
/// record-less KINE request.
#[no_mangle]
pub extern "C" fn kin_meals(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::core::meals, None)
}

/// Every meal of the day and favourites (KMLS v2, #679) in the instance's
/// history, in the context of a record-less KINE request.
#[no_mangle]
pub extern "C" fn kin_meal_plans(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::core::meal_plans, None)
}

/// A Shopping plan for a recipe, a date's meal or a week (KMPQ v1/v2 + KINE
/// context -> KMSP v1, #333, #679) against the instance's history.
#[no_mangle]
pub extern "C" fn kin_meal_shopping_plan(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::core::meal_shopping_plan, None)
}

/// Item emoji (KIEM v1, #344) of the instance's history, in the context of a
/// record-less KINE request.
#[no_mangle]
pub extern "C" fn kin_item_emojis(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::core::item_emojis, None)
}

/// Store sections and each item's section (KSHS v1, #411) of the
/// instance's history, in the context of a record-less KINE request.
#[no_mangle]
pub extern "C" fn kin_shopping_sections(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::core::shopping_sections, None)
}

/// Routine rotations (KRRS v1, #429) of the instance's history, in the
/// context of a record-less KINE request.
#[no_mangle]
pub extern "C" fn kin_routine_rotations(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::core::routine_rotations, None)
}
/// The sitter page (KSIT v1, #442) of the instance's history, in the
/// context of a record-less KINE request.
#[no_mangle]
pub extern "C" fn kin_sitter_page(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::core::sitter_page, None)
}

/// The family album (KALB v1, #673) of the instance's history, in the
/// context of a record-less KINE request.
#[no_mangle]
pub extern "C" fn kin_album(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::core::album, None)
}

/// The calendar between two dates (KCAQ + KINE context -> KCAL v1, #656)
/// against the instance's history.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_calendar_range(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::core::calendar_range, None)
}

/// An iCalendar file's events as Kin event payloads (.ics bytes -> KICS v1,
/// #666, ical.rs). Touches no household state.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_ical_parse(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::ical::parse_request)
}

/// The chore chart for a week (KCCQ + KINE context -> KCCD v1, #676,
/// chores.rs) against the instance's history.
#[no_mangle]
pub extern "C" fn kin_chore_chart(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::chores::chart_export, None)
}

/// A member's things today (KMTQ + KINE context -> KMTD v1, #344) against
/// the instance's history.
#[no_mangle]
pub extern "C" fn kin_my_things(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::core::my_things, None)
}

/// The household's week from a start date (KWKQ + KINE context -> KWKD v1,
/// #417, week.rs) against the instance's history.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_week(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::week::week_export, None)
}

/// The member-name table (KMNM v1, #224) of the instance's history, in the
/// context of a record-less KINE request, as `kin_device_names`.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_member_names(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::core::member_names, None)
}

/// Empties the instance's chat log. Always succeeds. The text arena stays:
/// its texts are content-addressed and independent of the log, and the
/// history mirror resets the log whenever it is handed a plain array, so
/// clearing texts here would drop them before every such page. `kin_clear`
/// drops both on lock.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_chat_history_reset() -> i32 {
    lock_state().reset_chat_history();
    0
}

/// Appends a batch of chat records to the chat log, as
/// `kin_history_append` does for the household history. Either log refuses
/// the other's events.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_chat_history_append(pointer: u32, length: u32) -> i32 {
    run_chat(pointer, length, |input, chat, _| {
        chat.append(input).map(|()| Vec::new())
    })
}

/// Keeps the chat log's first `count` records, as `kin_history_truncate`.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_chat_history_truncate(count: u32) -> i32 {
    match lock_state().chat_history.truncate(count as usize) {
        Ok(()) => 0,
        Err(error) => error.code(),
    }
}

/// Validates a chat command against the chat log (u32 intent length, KCMD,
/// u32 admin count, admins, record-less KINE context; command.rs
/// `execute_chat_history`) and publishes KCMT with an empty projection. The
/// log is not changed.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_chat_execute(pointer: u32, length: u32) -> i32 {
    run_chat(pointer, length, |input, chat, _| {
        crate::command::execute_chat_history(input, chat)
    })
}

/// A chat page: a KCHQ request with its record-less KINE context, against
/// the chat log and the chat-text arena; publishes KCHP (chat.rs).
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_chat_page(pointer: u32, length: u32) -> i32 {
    run_chat(pointer, length, crate::core::chat_page)
}

/// A chat search: a KCHF request with its record-less KINE context, against
/// the chat log and the chat-text arena; publishes KCHR (chat_search.rs).
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_chat_search(pointer: u32, length: u32) -> i32 {
    run_chat(pointer, length, crate::core::chat_search)
}

/// Drops every decrypted chat text (zero-filling the arena), for a member
/// who lost access to chat while unlocked. Always succeeds.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_chat_texts_clear() -> i32 {
    lock_state().chat_texts.clear();
    0
}

/// Stores decrypted chat texts (KCHT) in the instance's arena; publishes
/// the per-text KCHS statuses (chat.rs).
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_chat_text(pointer: u32, length: u32) -> i32 {
    run_chat(pointer, length, |input, _, texts| {
        crate::chat::put_texts(input, texts)
    })
}

/// Empties the instance's fridge log (#317). Always succeeds.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_board_history_reset() -> i32 {
    lock_state().board_history.clear();
    0
}

/// Appends a batch of board records to the fridge log, as
/// `kin_history_append` does; every log refuses the others' events.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_board_history_append(pointer: u32, length: u32) -> i32 {
    run_board(pointer, length, |input, board| {
        board.append(input).map(|()| Vec::new())
    })
}

/// Keeps the fridge log's first `count` records.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_board_history_truncate(count: u32) -> i32 {
    match lock_state().board_history.truncate(count as usize) {
        Ok(()) => 0,
        Err(error) => error.code(),
    }
}

/// Validates a fridge command against the board log (u32 command length,
/// KCMD with action 52–58, record-less KINE context; command.rs
/// `execute_board_history`) and publishes KCMT. The log is not changed.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_board_execute(pointer: u32, length: u32) -> i32 {
    run_board(pointer, length, crate::command::execute_board_history)
}

/// The fridge as drawn: a record-less KINE context against the board log;
/// publishes KBRD (board.rs).
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_board_state(pointer: u32, length: u32) -> i32 {
    run_board(pointer, length, crate::core::board_state)
}

/// Empties the instance's private log (#489). Always succeeds.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_private_history_reset() -> i32 {
    lock_state().private_history.clear();
    0
}

/// Appends a batch of private records to the private log, as
/// `kin_history_append` does; every log refuses the others' events.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_private_history_append(pointer: u32, length: u32) -> i32 {
    run_private(pointer, length, |input, private| {
        private.append(input).map(|()| Vec::new())
    })
}

/// Keeps the private log's first `count` records.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_private_history_truncate(count: u32) -> i32 {
    match lock_state().private_history.truncate(count as usize) {
        Ok(()) => 0,
        Err(error) => error.code(),
    }
}

/// A new private event validated against the private log (#511): u32
/// command length, KCMD with a private action (100–199) carrying the exact
/// payload, record-less KINE context (private_command.rs). Publishes KCMT
/// with an empty projection; the log is not changed.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_private_execute(pointer: u32, length: u32) -> i32 {
    run_private(pointer, length, crate::private_command::execute)
}

/// The member's private projection: a record-less KINE context against the
/// private log; publishes KPRV (private.rs).
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_private_state(pointer: u32, length: u32) -> i32 {
    run_private(pointer, length, crate::core::private_state)
}

/// Reduces decoded voice-message samples to 64 waveform peaks (#134):
/// KAPQ -> KAPR. Touches no household or chat state.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_audio_peaks(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::audio::encode_peaks)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_event_metadata(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::codec::encode_metadata)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_event_metadata_batch(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::codec::encode_metadata_batch)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_encode_command(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::command::encode_command)
}

/// Validates a command against the instance's history (u32 intent length,
/// KCMD, record-less KINE context) and publishes the KCMT result. The
/// history is not changed.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_execute(pointer: u32, length: u32) -> i32 {
    run(
        pointer,
        length,
        crate::command::execute_history,
        Some(command_projection),
    )
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_encode_archive(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::archive::build_request)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_decode_archive(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::archive::validate_request)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_archive_header(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::archive::header_request)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_archive_layout(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::archive::layout_request)
}

/// UTF-8 text -> KQRM matrix of a QR symbol (qr/wire.rs). The browser draws it.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_qr_encode(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::qr::wire::encode_request)
}

/// width, height and 8-bit luma of a camera frame -> the QR payload bytes.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_qr_decode(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::qr::wire::decode_request)
}

/// The import plan (KIMP) for the instance's history, which the host has
/// filled with a decrypted archive's records, in the context of a
/// record-less KINE request.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_plan_import(pointer: u32, length: u32) -> i32 {
    run(pointer, length, crate::archive::plan_import_history, None)
}

/// An operation on its input alone.
fn operate(pointer: u32, length: u32, operation: fn(&[u8]) -> Result<Vec<u8>, KinError>) -> i32 {
    run(pointer, length, |input, _| operation(input), None)
}

/// Runs `operation` on the live input buffer and the instance's history, then
/// publishes its result or error. With `locate`, the result carries a
/// projection whose section revisions are stamped against the last
/// projection this instance emitted.
fn run(
    pointer: u32,
    length: u32,
    operation: impl FnOnce(&[u8], &mut History) -> Result<Vec<u8>, KinError>,
    locate: Option<Locate>,
) -> i32 {
    run_parts(
        pointer,
        length,
        |input, parts| operation(input, parts.history),
        locate,
    )
}

/// `run` for an operation on the chat log and the chat-text arena.
fn run_chat(
    pointer: u32,
    length: u32,
    operation: impl FnOnce(
        &[u8],
        &mut History,
        &mut crate::chat::ChatTexts,
    ) -> Result<Vec<u8>, KinError>,
) -> i32 {
    run_parts(
        pointer,
        length,
        |input, parts| operation(input, parts.chat_history, parts.chat_texts),
        None,
    )
}

fn run_board(
    pointer: u32,
    length: u32,
    operation: impl FnOnce(&[u8], &mut History) -> Result<Vec<u8>, KinError>,
) -> i32 {
    run_parts(
        pointer,
        length,
        |input, parts| operation(input, parts.board_history),
        None,
    )
}

fn run_private(
    pointer: u32,
    length: u32,
    operation: impl FnOnce(&[u8], &mut History) -> Result<Vec<u8>, KinError>,
) -> i32 {
    run_parts(
        pointer,
        length,
        |input, parts| operation(input, parts.private_history),
        None,
    )
}

/// The instance's logs and arena, borrowed for one operation.
struct Parts<'a> {
    history: &'a mut History,
    chat_history: &'a mut History,
    chat_texts: &'a mut crate::chat::ChatTexts,
    board_history: &'a mut History,
    private_history: &'a mut History,
}

fn run_parts(
    pointer: u32,
    length: u32,
    operation: impl FnOnce(&[u8], Parts<'_>) -> Result<Vec<u8>, KinError>,
    locate: Option<Locate>,
) -> i32 {
    // Keep inputs and published buffers stable against concurrent free, clear, or calls.
    let mut state = lock_state();
    state.begin();
    let AbiState {
        allocations,
        history,
        chat_history,
        chat_texts,
        board_history,
        private_history,
        ..
    } = &mut *state;
    let outcome = if !request_length_is_supported(length) {
        Err(KinError::SizeLimit)
    } else if length == 0 {
        Err(KinError::MalformedProtocol)
    } else {
        allocations
            .get(pointer)
            .map_or(Err(KinError::InvalidAbi), |input| {
                if input.len() != length as usize {
                    Err(KinError::InvalidAbi)
                } else {
                    operation(
                        input,
                        Parts {
                            history,
                            chat_history,
                            chat_texts,
                            board_history,
                            private_history,
                        },
                    )
                }
            })
    };
    state.publish(outcome, locate)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_result_ptr() -> u32 {
    active_buffer_pointer(&lock_state().result)
}

/// Drops retained buffers and the history on host lock. The history's bytes
/// are zero-filled first; that covers this buffer only, not physical memory.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_clear() {
    lock_state().clear();
    crate::qr::wire::release_scratch();
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_result_len() -> u32 {
    lock_state().result.len() as u32
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_error_ptr() -> u32 {
    active_buffer_pointer(&lock_state().error)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_error_len() -> u32 {
    lock_state().error.len() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{item_record, kine, text_record, TEST_DATE};

    /// One projection call through the ABI state, returning its revisions.
    fn emit(state: &mut AbiState, records: &[Vec<u8>]) -> Vec<u32> {
        state.begin();
        let outcome = crate::core::replay(&kine(records, 0, TEST_DATE, None));
        assert_eq!(state.publish(outcome, Some(whole)), 0);
        revisions(&state.result)
    }

    fn revisions(projection: &[u8]) -> Vec<u32> {
        (0..14)
            .map(|index| {
                let at = 96 + index * 8;
                u32::from_le_bytes(projection[at..at + 4].try_into().unwrap())
            })
            .collect()
    }

    #[test]
    fn revisions_advance_only_for_changed_sections_across_calls() {
        let mut state = AbiState::new();
        let item = item_record(1, 0x11, b"Milk", 1);
        let first = emit(&mut state, std::slice::from_ref(&item));
        assert_eq!(
            first,
            vec![1; 14],
            "a fresh instance stamps every section 1"
        );
        assert_eq!(emit(&mut state, std::slice::from_ref(&item)), first);

        // A Handoff changes Handoffs and the catch-up summary, nothing else.
        let handoff = text_record(5, 2, 0x12, b"Bins are out");
        let second = emit(&mut state, &[item.clone(), handoff.clone()]);
        let mut expected = first.clone();
        expected[1] = 2;
        expected[13] = 2;
        assert_eq!(second, expected);

        // A non-projection call in between keeps the comparison basis.
        state.begin();
        assert_ne!(state.publish(Err(KinError::InvalidEvent), Some(whole)), 0);
        state.begin();
        assert_eq!(state.publish(Ok(b"metadata".to_vec()), None), 0);
        assert_eq!(emit(&mut state, &[item.clone(), handoff]), expected);

        // Returning to earlier content is still a change: counters never go back.
        let third = emit(&mut state, std::slice::from_ref(&item));
        expected[1] = 3;
        expected[13] = 3;
        assert_eq!(third, expected);
    }

    #[test]
    fn a_lost_basis_advances_every_section_and_never_reuses_a_revision() {
        let mut state = AbiState::new();
        let item = item_record(1, 0x11, b"Milk", 1);
        assert_eq!(emit(&mut state, std::slice::from_ref(&item)), vec![1; 14]);
        // kin_clear drops buffers but keeps counters.
        state.clear();
        assert_eq!(emit(&mut state, std::slice::from_ref(&item)), vec![2; 14]);
    }

    #[test]
    fn the_allocation_table_is_fixed_and_frees_only_exact_ranges() {
        let mut table = Allocations::new();
        let buffers: Vec<Box<[u8]>> = (0..ALLOCATION_SLOTS)
            .map(|n| vec![n as u8; n + 1].into_boxed_slice())
            .collect();
        let pointers: Vec<u32> = buffers
            .iter()
            .map(|buffer| buffer_pointer(buffer))
            .collect();
        for buffer in buffers {
            assert!(table.insert(buffer));
        }
        assert!(
            !table.insert(vec![0].into_boxed_slice()),
            "a full table refuses"
        );
        assert_eq!(table.get(pointers[2]), Some(&[2, 2, 2][..]));
        assert!(!table.remove(pointers[2], 2), "the length must match");
        assert!(table.remove(pointers[2], 3));
        assert_eq!(table.get(pointers[2]), None);
        assert!(
            table.insert(vec![9].into_boxed_slice()),
            "a freed slot is reused"
        );
        table.clear();
        assert_eq!(table.get(pointers[0]), None);
    }

    #[test]
    fn command_results_locate_their_trailing_projection() {
        let mut result = b"KCMT\x01\0\0\0".to_vec();
        for length in [3u32, 2, 4] {
            result.extend_from_slice(&length.to_le_bytes());
        }
        result.extend_from_slice(&[0xee; 9]);
        assert_eq!(command_projection(&result), Some(25..29));
        result.push(0);
        assert_eq!(
            command_projection(&result),
            None,
            "lengths must cover the result"
        );
        assert_eq!(command_projection(&result[..10]), None);
    }

    #[test]
    fn resetting_the_chat_log_keeps_texts_and_clearing_drops_both() {
        let mut state = AbiState::new();
        let mut post = vec![0u8; 88 + 84];
        post[..2].copy_from_slice(&1u16.to_le_bytes());
        post[2..4].copy_from_slice(&44u16.to_le_bytes());
        for range in [4..20, 20..36, 36..52, 52..68] {
            post[range].fill(0x11);
        }
        post[68..76].copy_from_slice(&1_791_475_200_000i64.to_le_bytes());
        post[76..84].copy_from_slice(&1u64.to_le_bytes());
        post[84..88].copy_from_slice(&84u32.to_le_bytes());
        post[88..104].fill(0x07);
        post[104] = 1;
        post[108..140].fill(0xa1);
        post[140..172].fill(0xc1);
        let mut batch = 1u32.to_le_bytes().to_vec();
        batch.extend_from_slice(&(post.len() as u32).to_le_bytes());
        batch.extend_from_slice(&post);
        state.chat_history.append(&batch).unwrap();
        state.chat_texts.put([0xa1; 32], b"Dinner at 6").unwrap();
        // The history mirror resets the log before re-sending a plain array;
        // the texts it was given must survive that.
        state.reset_chat_history();
        assert!(state.chat_history.is_empty());
        assert_eq!(state.chat_texts.get(&[0xa1; 32]), Some(&b"Dinner at 6"[..]));
        state.chat_history.append(&batch).unwrap();
        state.clear();
        assert!(state.chat_history.is_empty());
        assert!(state.chat_texts.is_empty());
    }

    #[test]
    fn clearing_drops_the_private_log_too() {
        let mut state = AbiState::new();
        let mut note = vec![0u8; 88 + 21];
        note[..2].copy_from_slice(&1u16.to_le_bytes());
        note[2..4].copy_from_slice(&crate::private::PRIVATE_NOTE_SET.to_le_bytes());
        for range in [4..20, 20..36, 36..52, 52..68] {
            note[range].fill(0x11);
        }
        note[68..76].copy_from_slice(&1_791_475_200_000i64.to_le_bytes());
        note[76..84].copy_from_slice(&1u64.to_le_bytes());
        note[84..88].copy_from_slice(&21u32.to_le_bytes());
        note[88..104].fill(0x07);
        note[104..108].copy_from_slice(&1u32.to_le_bytes());
        note[108] = b'x';
        let mut batch = 1u32.to_le_bytes().to_vec();
        batch.extend_from_slice(&(note.len() as u32).to_le_bytes());
        batch.extend_from_slice(&note);
        state.private_history.append(&batch).unwrap();
        assert_eq!(state.private_history.len(), 1);
        state.clear();
        assert!(state.private_history.is_empty());
    }

    #[test]
    fn request_size_is_bounded_before_pointer_dereference() {
        assert!(request_length_is_supported(MAX_PROTOCOL_BYTES as u32));
        assert!(!request_length_is_supported(MAX_PROTOCOL_BYTES as u32 + 1));
    }
}
