use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::error::KinError;
use crate::protocol::{ERROR_PROTOCOL_VERSION, MAX_PROTOCOL_BYTES};

struct AbiState {
    allocations: BTreeMap<u32, Box<[u8]>>,
    result: Vec<u8>,
    error: Vec<u8>,
}

impl AbiState {
    const fn new() -> Self {
        Self {
            allocations: BTreeMap::new(),
            result: Vec::new(),
            error: Vec::new(),
        }
    }
}

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
    let mut allocation = bytes.into_boxed_slice();
    let pointer = allocation.as_mut_ptr() as usize as u32;
    if pointer == 0 {
        return 0;
    }
    lock_state().allocations.insert(pointer, allocation);
    pointer
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_free(pointer: u32, length: u32) -> i32 {
    if pointer == 0 && length == 0 {
        return 0;
    }
    let mut state = lock_state();
    let Some(allocation) = state.allocations.get(&pointer) else {
        return KinError::InvalidAbi.code();
    };
    if allocation.len() != length as usize {
        return KinError::InvalidAbi.code();
    }
    state.allocations.remove(&pointer);
    0
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_apply_events(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::core::replay)
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

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_execute_command(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::command::execute_request)
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

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_plan_import(pointer: u32, length: u32) -> i32 {
    operate(pointer, length, crate::archive::plan_import)
}

fn operate(pointer: u32, length: u32, operation: fn(&[u8]) -> Result<Vec<u8>, KinError>) -> i32 {
    // Keep inputs and published buffers stable against concurrent free, clear, or calls.
    let mut state = lock_state();
    state.result.clear();
    state.error.clear();
    let outcome = if !request_length_is_supported(length) {
        Err(KinError::SizeLimit)
    } else if length == 0 {
        Err(KinError::MalformedProtocol)
    } else {
        state
            .allocations
            .get(&pointer)
            .map_or(Err(KinError::InvalidAbi), |input| {
                if input.len() != length as usize {
                    Err(KinError::InvalidAbi)
                } else {
                    operation(input)
                }
            })
    };
    match outcome {
        Ok(result) => {
            state.result = result;
            0
        }
        Err(error) => {
            state.error = error_buffer(error);
            error.code()
        }
    }
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_result_ptr() -> u32 {
    active_buffer_pointer(&lock_state().result)
}

/// Drops retained buffers on host lock, without claiming memory zeroization.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn kin_clear() {
    let mut state = lock_state();
    state.allocations.clear();
    state.result = Vec::new();
    state.error = Vec::new();
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
    use super::request_length_is_supported;
    use crate::protocol::MAX_PROTOCOL_BYTES;

    #[test]
    fn request_size_is_bounded_before_pointer_dereference() {
        assert!(request_length_is_supported(MAX_PROTOCOL_BYTES as u32));
        assert!(!request_length_is_supported(MAX_PROTOCOL_BYTES as u32 + 1));
    }
}
