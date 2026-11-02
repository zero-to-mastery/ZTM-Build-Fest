//! QR codes written from scratch (ISO/IEC 18004), with no crates.
//!
//! Kin uses two halves: [`encode`] turns text into a symbol that the browser
//! draws, and [`decode`] reads a camera frame back into the text. Both
//! support byte mode, level M and versions 1–10, which holds about 200 bytes.
//! That covers an invitation or sign-in link with room to spare.

pub mod decode;
pub mod encode;
pub mod layout;
pub mod rs;
pub mod tables;
pub mod wire;

pub use decode::{decode, Frame};
pub use encode::{encode, Code, MAX_BYTES};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QrError {
    /// Nothing to encode.
    Empty,
    /// More bytes than version 10 at level M holds.
    TooLong,
    /// The frame doesn't contain a symbol Kin can read.
    NotFound,
    /// A symbol was found but its format is outside byte mode, level M, or
    /// versions 1–10.
    Unsupported,
    /// Too damaged to correct.
    Uncorrectable,
    /// The corrected data isn't a byte-mode payload of the stated length.
    Malformed,
    /// The frame's size is zero, or its pixel count doesn't match its width
    /// and height.
    BadFrame,
    /// The frame exceeds the largest size decode accepts (decode.rs).
    FrameTooLarge,
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod coverage;
