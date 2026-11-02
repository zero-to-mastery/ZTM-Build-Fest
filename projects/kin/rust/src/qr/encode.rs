//! Byte-mode QR encoder, level M, versions 1–10. The whole encode path works
//! in fixed-size storage: the module grid, the bit stream and the blocks are
//! arrays sized for version 10, so encoding does not allocate. Nothing is
//! parsed or re-decoded.

use super::{
    layout::{self, DataOrder, Grid, MAX_MODULES},
    rs, tables, QrError,
};

/// A finished symbol: `size` × `size` modules, one byte each (1 = dark), in
/// fixed storage. Only the first `size * size` bytes are meaningful.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Code {
    pub size: usize,
    pub dark: [u8; MAX_MODULES],
}

impl Code {
    /// The `size * size` module bytes, row-major.
    pub fn modules(&self) -> &[u8] {
        &self.dark[..self.size * self.size]
    }
}

/// The longest byte payload that fits version 10 at level M.
pub const MAX_BYTES: usize = 213;

/// Encodes `data` (any bytes; Kin passes UTF-8 text) as a QR symbol.
pub fn encode(data: &[u8]) -> Result<Code, QrError> {
    encode_with_mask(data, None)
}

/// Encodes with `forced` as the mask, or with the lowest-penalty mask when
/// `None`. Tests use the forced form to cover every mask pattern.
pub(crate) fn encode_with_mask(data: &[u8], forced: Option<u8>) -> Result<Code, QrError> {
    if data.is_empty() {
        return Err(QrError::Empty);
    }
    let version = choose_version(data.len())?;
    let mut stream = [0u8; tables::MAX_CODEWORDS];
    let total = codewords(data, version, &mut stream);
    let mut grid = Grid::with_function_patterns(version);
    let size = grid.size;
    // Remainder modules (beyond the codeword bits) stay light.
    let order = DataOrder::new(&grid.reserved, size);
    for (position, index) in order.enumerate().take(total * 8) {
        grid.dark[index] = (stream[position / 8] >> (7 - position % 8)) & 1;
    }
    let mut best: Option<(u32, [u8; MAX_MODULES])> = None;
    for mask in 0..8u8 {
        if forced.is_some_and(|fixed| fixed != mask) {
            continue;
        }
        let mut masked = Grid {
            size,
            dark: grid.dark,
            reserved: grid.reserved,
        };
        for index in DataOrder::new(&grid.reserved, size) {
            if layout::mask_applies(mask, index / size, index % size) {
                masked.dark[index] ^= 1;
            }
        }
        masked.write_format(layout::format_bits(mask));
        let score = layout::penalty(&masked.dark[..size * size], size);
        if best.as_ref().is_none_or(|(lowest, _)| score < *lowest) {
            best = Some((score, masked.dark));
        }
    }
    let (_, dark) = best.ok_or(QrError::Unsupported)?;
    Ok(Code { size, dark })
}

/// The smallest version whose byte-mode capacity holds `length` bytes.
fn choose_version(length: usize) -> Result<usize, QrError> {
    for version in 1..=10 {
        let capacity_bits = tables::DATA_CODEWORDS[version - 1] * 8;
        let needed = 4 + tables::count_bits(version) + 8 * length;
        if needed <= capacity_bits {
            return Ok(version);
        }
    }
    Err(QrError::TooLong)
}

/// Writes the data and error-correction codewords of `data` into `out`,
/// interleaved in placement order. Returns how many were written.
fn codewords(data: &[u8], version: usize, out: &mut [u8; tables::MAX_CODEWORDS]) -> usize {
    let capacity = tables::DATA_CODEWORDS[version - 1];
    let mut stream = [0u8; tables::MAX_CODEWORDS];
    let mut bits = BitWriter {
        bytes: &mut stream,
        bits: 0,
    };
    bits.push(0b0100, 4); // byte mode
    bits.push(data.len() as u32, tables::count_bits(version));
    for &byte in data {
        bits.push(u32::from(byte), 8);
    }
    let terminator = (capacity * 8 - bits.bits).min(4);
    bits.push(0, terminator);
    bits.pad_to_byte();
    let filled = bits.bits / 8;
    for (offset, slot) in stream[filled..capacity].iter_mut().enumerate() {
        *slot = if offset.is_multiple_of(2) { 0xEC } else { 0x11 };
    }

    // Split into blocks, compute each block's check codewords.
    let lengths = tables::block_data_lengths(version);
    let check_length = tables::EC_PER_BLOCK[version - 1];
    let mut starts = [0usize; tables::MAX_BLOCKS];
    let mut checks = [[0u8; tables::MAX_EC]; tables::MAX_BLOCKS];
    let mut offset = 0;
    for (index, &length) in lengths.as_slice().iter().enumerate() {
        starts[index] = offset;
        rs::encode_into(
            &stream[offset..offset + length],
            &mut checks[index][..check_length],
        );
        offset += length;
    }

    let mut k = 0;
    let longest = lengths.as_slice().iter().copied().max().unwrap_or(0);
    for i in 0..longest {
        for (index, &length) in lengths.as_slice().iter().enumerate() {
            if i < length {
                out[k] = stream[starts[index] + i];
                k += 1;
            }
        }
    }
    for i in 0..check_length {
        for block in &checks[..lengths.count] {
            out[k] = block[i];
            k += 1;
        }
    }
    k
}

/// Packs bit fields most significant bit first into a zeroed byte array.
struct BitWriter<'a> {
    bytes: &'a mut [u8],
    bits: usize,
}

impl BitWriter<'_> {
    fn push(&mut self, value: u32, width: usize) {
        for shift in (0..width).rev() {
            let bit = ((value >> shift) & 1) as u8;
            self.bytes[self.bits / 8] |= bit << (7 - self.bits % 8);
            self.bits += 1;
        }
    }

    fn pad_to_byte(&mut self) {
        if !self.bits.is_multiple_of(8) {
            self.bits += 8 - self.bits % 8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_grow_with_the_payload() {
        assert_eq!(choose_version(1), Ok(1));
        assert_eq!(choose_version(17), Ok(2));
        assert_eq!(choose_version(MAX_BYTES), Ok(10));
        assert_eq!(choose_version(MAX_BYTES + 1), Err(QrError::TooLong));
    }

    #[test]
    fn symbol_sizes_follow_the_version() {
        assert_eq!(encode(b"A").unwrap().size, 21);
        let long = vec![b'k'; 120];
        assert_eq!(encode(&long).unwrap().size, 17 + 4 * 7);
        assert_eq!(encode(&[]).unwrap_err(), QrError::Empty);
    }

    #[test]
    fn the_always_dark_module_and_finder_corners_are_drawn() {
        let code = encode(b"https://example.org/#abc").unwrap();
        let size = code.size;
        assert_eq!(code.dark[(size - 8) * size + 8], 1, "dark module");
        assert_eq!(code.dark[0], 1, "finder corner");
    }
}
