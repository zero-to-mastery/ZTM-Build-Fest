//! Byte layouts for the QR exports (docs/ABI.md, "QR codes").
//!
//! Encode input is the text's UTF-8 bytes. Its result is `KQRM`, version
//! u16 = 1, reserved u16 = 0, the side length u32, then one byte per module
//! in row-major order (1 dark, 0 light), with no quiet zone: the browser adds
//! the margin when it draws.
//!
//! Decode input is `width:u32`, `height:u32`, then `width * height` bytes of
//! 8-bit luma, row-major. Its result is the decoded payload bytes.

use std::sync::{Mutex, MutexGuard};

use super::decode::{self, Scratch};
use super::{encode, Frame, QrError};
use crate::error::KinError;

const MATRIX_MAGIC: &[u8; 4] = b"KQRM";
const MATRIX_VERSION: u16 = 1;
const FRAME_HEADER_BYTES: usize = 8;

impl From<QrError> for KinError {
    fn from(error: QrError) -> Self {
        match error {
            QrError::Empty => KinError::MalformedProtocol,
            QrError::TooLong => KinError::SizeLimit,
            QrError::BadFrame => KinError::MalformedProtocol,
            QrError::FrameTooLarge => KinError::SizeLimit,
            QrError::NotFound
            | QrError::Unsupported
            | QrError::Uncorrectable
            | QrError::Malformed => KinError::QrNotFound,
        }
    }
}

/// Encodes UTF-8 text as a KQRM matrix.
pub fn encode_request(input: &[u8]) -> Result<Vec<u8>, KinError> {
    let text = std::str::from_utf8(input).map_err(|_| KinError::MalformedProtocol)?;
    let code = encode(text.as_bytes())?;
    let side = u32::try_from(code.size).map_err(|_| KinError::Internal)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(12 + code.modules().len())
        .map_err(|_| KinError::SizeLimit)?;
    bytes.extend_from_slice(MATRIX_MAGIC);
    bytes.extend_from_slice(&MATRIX_VERSION.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&side.to_le_bytes());
    bytes.extend_from_slice(code.modules());
    Ok(bytes)
}

/// Reads the text out of a grayscale frame.
pub fn decode_request(input: &[u8]) -> Result<Vec<u8>, KinError> {
    if input.len() < FRAME_HEADER_BYTES {
        return Err(KinError::MalformedProtocol);
    }
    let width = u32::from_le_bytes([input[0], input[1], input[2], input[3]]) as usize;
    let height = u32::from_le_bytes([input[4], input[5], input[6], input[7]]) as usize;
    let luma = &input[FRAME_HEADER_BYTES..];
    let pixels = width
        .checked_mul(height)
        .ok_or(KinError::MalformedProtocol)?;
    if width == 0 || height == 0 || pixels != luma.len() {
        return Err(KinError::MalformedProtocol);
    }
    let mut scratch = lock_scratch();
    Ok(decode::decode_in(
        &Frame {
            width,
            height,
            luma,
        },
        &mut scratch,
    )?)
}

/// The decoder's working memory, kept between frames so the camera path does
/// not allocate per frame. One WASM instance is single-threaded; the lock is
/// for native test builds, which run threads.
static SCRATCH: Mutex<Scratch> = Mutex::new(Scratch::new());

fn lock_scratch() -> MutexGuard<'static, Scratch> {
    SCRATCH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Drops the decoder's retained working memory (called by `kin_clear`).
pub fn release_scratch() {
    *lock_scratch() = Scratch::new();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_bytes(width: u32, height: u32, luma: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes.extend_from_slice(luma);
        bytes
    }

    #[test]
    fn matrix_has_header_and_one_byte_per_module() {
        let bytes = encode_request(b"kin://invite/abc").unwrap();
        assert_eq!(&bytes[0..4], MATRIX_MAGIC);
        let side = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        // 16 bytes need version 2 at level M (version 1 holds 14): side 25.
        assert_eq!(side, 25);
        assert_eq!(bytes.len(), 12 + side * side);
        assert!(bytes[12..].iter().all(|&module| module <= 1));
    }

    #[test]
    fn rejects_text_that_is_not_utf8() {
        assert_eq!(
            encode_request(&[0xff, 0xfe]),
            Err(KinError::MalformedProtocol)
        );
    }

    #[test]
    fn rejects_empty_and_oversized_text() {
        assert_eq!(encode_request(b""), Err(KinError::MalformedProtocol));
        let long = vec![b'a'; encode::MAX_BYTES + 1];
        assert_eq!(encode_request(&long), Err(KinError::SizeLimit));
    }

    #[test]
    fn round_trips_through_the_frame_layout() {
        let text = b"kin://sign-in/0123456789abcdef#secret";
        let matrix = encode_request(text).unwrap();
        let side = u32::from_le_bytes(matrix[8..12].try_into().unwrap());
        // Draw 4 px per module with a 4-module quiet zone, as the browser does.
        let scale = 4usize;
        let margin = 4usize;
        let pixels = (side as usize + 2 * margin) * scale;
        let mut luma = vec![255u8; pixels * pixels];
        for row in 0..side as usize {
            for column in 0..side as usize {
                if matrix[12 + row * side as usize + column] == 1 {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            let y = (row + margin) * scale + dy;
                            let x = (column + margin) * scale + dx;
                            luma[y * pixels + x] = 0;
                        }
                    }
                }
            }
        }
        let frame = frame_bytes(pixels as u32, pixels as u32, &luma);
        assert_eq!(decode_request(&frame).unwrap(), text);
    }

    #[test]
    fn rejects_frames_whose_size_disagrees_with_their_pixels() {
        assert_eq!(decode_request(&[0; 4]), Err(KinError::MalformedProtocol));
        let short = frame_bytes(4, 4, &[0; 15]);
        assert_eq!(decode_request(&short), Err(KinError::MalformedProtocol));
        let empty = frame_bytes(0, 4, &[]);
        assert_eq!(decode_request(&empty), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn oversized_frames_report_the_size_limit() {
        // One pixel past the 720p pixel budget, and a width past 1280.
        let wide = frame_bytes(1281, 1, &[255; 1281]);
        assert_eq!(decode_request(&wide), Err(KinError::SizeLimit));
        let large = frame_bytes(1280, 721, &vec![255; 1280 * 721]);
        assert_eq!(decode_request(&large), Err(KinError::SizeLimit));
    }

    #[test]
    fn a_frame_at_the_720p_limit_is_read_not_refused() {
        let blank = frame_bytes(1280, 720, &vec![255; 1280 * 720]);
        assert_eq!(decode_request(&blank), Err(KinError::QrNotFound));
    }

    #[test]
    fn reports_a_frame_without_a_symbol_as_not_found() {
        let blank = frame_bytes(64, 64, &[255; 64 * 64]);
        assert_eq!(decode_request(&blank), Err(KinError::QrNotFound));
    }
}
