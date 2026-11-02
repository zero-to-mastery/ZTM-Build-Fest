//! Portable application operations shared by the native library and manual ABI.
use crate::error::KinError;
use crate::history::History;
use crate::request::{decode_context, decode_request, DecodedRequest};
use crate::state::{self, HouseholdState};
use crate::state_encode::encode_state;

/// Deterministic replay of a decoded request at its explicit `as_of` and civil date.
pub fn project(request: &DecodedRequest) -> Result<HouseholdState, KinError> {
    state::rebuild(&request.events, request.as_of, request.civil_date)
}

/// The protocol-24 projection, including the catch-up summary after the cursor.
pub fn encode_projection(
    request: &DecodedRequest,
    household: &HouseholdState,
) -> Result<Vec<u8>, KinError> {
    let summary = state::summarize_validated(&request.events, request.summary_cursor, household)?;
    encode_state(household, &summary)
}

/// Replay of a whole KINE request (tests, golden fixtures, import plans).
pub fn replay(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    let request = decode_request(bytes)?;
    encode_projection(&request, &project(&request)?)
}

/// Replay of the history an engine instance holds, in the context a
/// record-less KINE request gives (`kin_project`).
pub fn replay_history(context: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    let summary = history.summary(&context, &state, None)?;
    crate::state_encode::encode_state(&state, &summary)
}

/// KDEV v1, the device-name table (`kin_device_names`): "KDEV", version u16,
/// reserved u16 (0), record count u32, then per device in device-ID order:
/// device ID (16 bytes), member ID (16), automatic-name length u16 (0 when
/// this history holds only a nickname for the device), nickname length u16
/// (0 when there is none), the automatic name, then the nickname, both UTF-8.
pub const DEVICE_NAMES_VERSION: u16 = 1;

/// The device names in the history an engine instance holds, in the
/// context of a record-less KINE request (as `replay_history`).
pub fn device_names(context: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    encode_device_names(&state.devices)
}

/// KMNM v1, the member-name table (`kin_member_names`, #224): "KMNM",
/// version u16, reserved u16 (0), record count u32, then per member in
/// member-ID order: member ID (16 bytes), name length u16, then the name
/// (UTF-8, nonempty). Members without a preferred name are absent; hosts
/// fall back to their existing labels.
pub const MEMBER_NAMES_VERSION: u16 = 1;

/// The preferred member names in the history an engine instance holds, in
/// the context of a record-less KINE request (as `device_names`).
pub fn member_names(context: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    encode_member_names(&state.member_names)
}

pub fn encode_member_names(members: &[state::MemberNameState]) -> Result<Vec<u8>, KinError> {
    let size = members.iter().try_fold(12usize, |size, member| {
        size.checked_add(18 + member.name.len())
    });
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size.ok_or(KinError::SizeLimit)?)
        .map_err(|_| KinError::SizeLimit)?;
    bytes.extend_from_slice(b"KMNM");
    bytes.extend_from_slice(&MEMBER_NAMES_VERSION.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    let count = u32::try_from(members.len()).map_err(|_| KinError::SizeLimit)?;
    bytes.extend_from_slice(&count.to_le_bytes());
    for member in members {
        // Canonical names are at most MAX_MEMBER_NAME_CHARS * 4 bytes.
        let length = u16::try_from(member.name.len()).map_err(|_| KinError::Internal)?;
        bytes.extend_from_slice(&member.member_id.0);
        bytes.extend_from_slice(&length.to_le_bytes());
        bytes.extend_from_slice(member.name.as_bytes());
    }
    Ok(bytes)
}

/// Meals (`kin_meals`, #333): the record-less KINE context against the
/// household history; publishes KMLS (meals.rs). Dinners within the window
/// around the context's civil date.
pub fn meals(context: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    crate::meals::encode_meals(&state.meals, &state.items, context.civil_date)
}

/// Every meal of the day and favourites (`kin_meal_plans`, #679): the
/// record-less KINE context against the household history; publishes KMLS
/// v2 (meals.rs). `kin_meals` keeps publishing KMLS v1 unchanged.
pub fn meal_plans(context: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    crate::meals::encode_meal_plans(&state.meals, &state.items, context.civil_date)
}

/// Item emoji (`kin_item_emojis`, #344): the record-less KINE context
/// against the household history; publishes KIEM (simple.rs).
pub fn item_emojis(context: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    Ok(crate::simple::encode_emojis(&state.pictures, &state.items))
}

/// Store sections (`kin_shopping_sections`, #411): the record-less KINE
/// context against the household history; publishes KSHS
/// (store_sections.rs).
pub fn shopping_sections(context: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    Ok(crate::store_sections::encode_sections(
        &state.store_sections,
        &state.items,
    ))
}

/// Routine rotations (`kin_routine_rotations`, #429): the record-less KINE
/// context against the household history; publishes KRRS (rotations.rs).
pub fn routine_rotations(context: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    Ok(crate::rotations::encode_rotations(
        &state.rotations,
        &state.routines,
    ))
}

/// The sitter page (`kin_sitter_page`, #442): the record-less KINE context
/// against the household history; publishes KSIT (sitter.rs).
pub fn sitter_page(context: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    Ok(crate::sitter::encode_page(
        &state.sitter_page,
        state.sitter_records(),
    ))
}

/// The family album (`kin_album`, #673): the record-less KINE context
/// against the household history; publishes KALB (album.rs).
pub fn album(context: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    Ok(crate::album::encode_album(&state.album))
}

/// The calendar between two dates (`kin_calendar_range`, #656): KCAQ and
/// the record-less KINE context; publishes KCAL (calendar_range.rs).
pub fn calendar_range(input: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    crate::calendar_range::calendar_range_export(input, history)
}

/// A member's things today (`kin_my_things`, #344): KMTQ (simple.rs) and the
/// record-less KINE context; publishes KMTD for the context's civil date.
pub fn my_things(input: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let (member, context) = crate::simple::decode_query(input)?;
    let context = decode_context(context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    Ok(crate::simple::encode_my_things(&crate::simple::my_things(
        &state,
        member,
        context.civil_date,
    )))
}

/// KMPQ v1, a Shopping plan query (`kin_meal_shopping_plan`, #333): "KMPQ",
/// version u16 = 1, reserved u16, source u8 (1 recipe, 2 a date's dinner),
/// 3 reserved, recipe ID [16] (zero for a date), date u32 (zero for a
/// recipe); 32 bytes, then the record-less KINE context. Publishes KMSP.
///
/// KMPQ v2 (#679) is the same 32 bytes with version 2, where byte 9 is a
/// slot (1 breakfast, 2 lunch, 3 dinner, 4 snack) for source 3 and zero
/// otherwise, and two sources are added: 3 a date's meal in that slot, 4 every
/// meal with a recipe in the seven days from the date (empty when there are
/// none). v1 queries are read as before; sources 3 and 4 need v2.
pub fn meal_shopping_plan(input: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    use crate::meals::{MealSlot, PlanSource};
    use crate::recurrence::CivilDate;
    let query = input.get(..32).ok_or(KinError::MalformedProtocol)?;
    if &query[..4] != b"KMPQ" || query[6..8] != [0, 0] || query[10..12] != [0, 0] {
        return Err(KinError::MalformedProtocol);
    }
    let version = u16::from_le_bytes([query[4], query[5]]);
    if version != 1 && version != 2 {
        return Err(KinError::UnsupportedVersion);
    }
    let recipe = <[u8; 16]>::try_from(&query[12..28]).map_err(|_| KinError::MalformedProtocol)?;
    let date = u32::from_le_bytes([query[28], query[29], query[30], query[31]]);
    let slot = query[9];
    let source = match (query[8], slot) {
        (1, 0) if recipe != [0; 16] && date == 0 => {
            PlanSource::Recipe(crate::event::RecipeId(recipe))
        }
        (2, 0) if recipe == [0; 16] => PlanSource::Dinner(CivilDate::from_encoded(date)?),
        (3, slot) if version == 2 && recipe == [0; 16] => PlanSource::Meal(
            CivilDate::from_encoded(date)?,
            MealSlot::from_code(slot).ok_or(KinError::MalformedProtocol)?,
        ),
        (4, 0) if version == 2 && recipe == [0; 16] => {
            let start = CivilDate::from_encoded(date)?;
            // Six more days must exist (as KWKQ).
            start
                .checked_add_days(6)
                .ok_or(KinError::MalformedProtocol)?;
            PlanSource::Week(start)
        }
        _ => return Err(KinError::MalformedProtocol),
    };
    let context = decode_context(&input[32..])?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    Ok(crate::meals::encode_plan(
        &state.meals.shopping_plan(source, &state.items)?,
    ))
}

/// A chat page (`kin_chat_page`): a KCHQ request (chat.rs) carrying the
/// record-less KINE context, against the instance's history. Texts of
/// retired blobs, and of messages the page shows as deleted or removed, are
/// forgotten from the arena first, so a deleted message's text never comes
/// back out.
pub fn chat_page(
    input: &[u8],
    history: &mut History,
    texts: &mut crate::chat::ChatTexts,
) -> Result<Vec<u8>, KinError> {
    let request = crate::chat::decode_page_request(input)?;
    let context = decode_context(request.context)?;
    let state = history
        .replay(&context)?
        .finalize(context.as_of, context.civil_date)?;
    let chat = &state.chat;
    let retired = chat.retired_blobs(&request.admins);
    for blob in &retired {
        texts.forget(blob);
    }
    crate::chat::encode_page(chat, &request, texts, &retired)
}

/// A chat search (`kin_chat_search`): a KCHF request (chat_search.rs)
/// against the instance's chat log and text arena. Texts of retired blobs
/// are forgotten first, as a page does, so a deleted message never matches.
pub fn chat_search(
    input: &[u8],
    history: &mut History,
    texts: &mut crate::chat::ChatTexts,
) -> Result<Vec<u8>, KinError> {
    let request = crate::chat_search::decode_search_request(input)?;
    let context = decode_context(request.context)?;
    let chat = history.replay(&context)?.chat();
    for blob in &chat.retired_blobs(&request.admins) {
        texts.forget(blob);
    }
    crate::chat_search::encode_search(chat, &request, texts)
}

pub fn encode_device_names(devices: &[state::DeviceNameState]) -> Result<Vec<u8>, KinError> {
    let size = devices.iter().try_fold(12usize, |size, device| {
        size.checked_add(
            36 + device.auto_name.as_ref().map_or(0, String::len)
                + device.nickname.as_ref().map_or(0, String::len),
        )
    });
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size.ok_or(KinError::SizeLimit)?)
        .map_err(|_| KinError::SizeLimit)?;
    bytes.extend_from_slice(b"KDEV");
    bytes.extend_from_slice(&DEVICE_NAMES_VERSION.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    let count = u32::try_from(devices.len()).map_err(|_| KinError::SizeLimit)?;
    bytes.extend_from_slice(&count.to_le_bytes());
    for device in devices {
        let auto_name = device.auto_name.as_deref().unwrap_or("");
        let nickname = device.nickname.as_deref().unwrap_or("");
        // Canonical names are at most MAX_DEVICE_NAME_BYTES, well inside u16.
        let auto_length = u16::try_from(auto_name.len()).map_err(|_| KinError::Internal)?;
        let nickname_length = u16::try_from(nickname.len()).map_err(|_| KinError::Internal)?;
        bytes.extend_from_slice(&device.device_id.0);
        bytes.extend_from_slice(&device.member_id.0);
        bytes.extend_from_slice(&auto_length.to_le_bytes());
        bytes.extend_from_slice(&nickname_length.to_le_bytes());
        bytes.extend_from_slice(auto_name.as_bytes());
        bytes.extend_from_slice(nickname.as_bytes());
    }
    Ok(bytes)
}

/// The fridge (`kin_board_state`, #317): the record-less KINE context against
/// the board log; publishes KBRD (board.rs).
pub fn board_state(input: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(input)?;
    crate::board::encode_board(history.replay(&context)?.board())
}

/// A member's private projection (`kin_private_state`, #489): the
/// record-less KINE context against the private log; publishes KPRV
/// (private.rs).
pub fn private_state(input: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    let context = decode_context(input)?;
    let count = history.len();
    crate::private::encode_private(history.replay(&context)?.private(), count)
}
