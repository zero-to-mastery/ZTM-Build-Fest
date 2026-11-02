//! Version and error-correction tables (ISO/IEC 18004), for level M only.
//! Level M is the only level Kin generates or reads: it's the best balance of
//! capacity and damage tolerance for a code shown on a screen.

/// Data codewords per version (index 0 is version 1).
pub const DATA_CODEWORDS: [usize; 10] = [16, 28, 44, 64, 86, 108, 124, 154, 182, 216];

/// Error-correction codewords per block.
pub const EC_PER_BLOCK: [usize; 10] = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];

/// (blocks, data codewords per block) for the two block groups; the second
/// group is longer by one in some versions.
pub const BLOCK_GROUPS: [((usize, usize), (usize, usize)); 10] = [
    ((1, 16), (0, 0)),
    ((1, 28), (0, 0)),
    ((1, 44), (0, 0)),
    ((2, 32), (0, 0)),
    ((2, 43), (0, 0)),
    ((4, 27), (0, 0)),
    ((4, 31), (0, 0)),
    ((2, 38), (2, 39)),
    ((3, 36), (2, 37)),
    ((4, 43), (1, 44)),
];

/// Alignment pattern centres (module coordinates) per version.
pub const ALIGNMENT: [&[usize]; 10] = [
    &[],
    &[6, 18],
    &[6, 22],
    &[6, 26],
    &[6, 30],
    &[6, 34],
    &[6, 22, 38],
    &[6, 24, 42],
    &[6, 26, 46],
    &[6, 28, 50],
];

/// Width of the byte-mode character count: 8 bits up to version 9, 16 from 10.
pub fn count_bits(version: usize) -> usize {
    if version <= 9 {
        8
    } else {
        16
    }
}

/// The module width of a version-`v` symbol.
pub fn size(version: usize) -> usize {
    17 + 4 * version
}

/// Most blocks any version uses (versions 9 and 10).
pub const MAX_BLOCKS: usize = 5;
/// Most check codewords per block (version 10).
pub const MAX_EC: usize = 26;
/// Largest data-plus-check block (version 10: 44 + 26).
pub const MAX_BLOCK_BYTES: usize = 70;
/// Most codewords in a symbol (version 10).
pub const MAX_CODEWORDS: usize = 346;
/// Most data codewords in a symbol (version 10).
pub const MAX_DATA_CODEWORDS: usize = 216;

/// The data-codeword count of each block, in order, in fixed storage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockLengths {
    pub count: usize,
    pub data: [usize; MAX_BLOCKS],
}

impl BlockLengths {
    pub fn as_slice(&self) -> &[usize] {
        &self.data[..self.count]
    }
}

/// The block layout of a version: (data codewords per block, block count) per
/// group, flattened to a list of block data lengths in order.
pub fn block_data_lengths(version: usize) -> BlockLengths {
    let ((n1, d1), (n2, d2)) = BLOCK_GROUPS[version - 1];
    let mut lengths = BlockLengths {
        count: n1 + n2,
        data: [0; MAX_BLOCKS],
    };
    for (slot, length) in lengths
        .data
        .iter_mut()
        .zip(std::iter::repeat_n(d1, n1).chain(std::iter::repeat_n(d2, n2)))
    {
        *slot = length;
    }
    lengths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_layouts_match_the_standard_totals() {
        // Total codewords per version at level M (ISO/IEC 18004 table 9).
        const TOTALS: [usize; 10] = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
        for version in 1..=10 {
            let lengths = block_data_lengths(version);
            assert_eq!(
                lengths.as_slice().iter().sum::<usize>(),
                DATA_CODEWORDS[version - 1],
                "version {version} data"
            );
            assert_eq!(
                DATA_CODEWORDS[version - 1] + lengths.count * EC_PER_BLOCK[version - 1],
                TOTALS[version - 1],
                "version {version} total"
            );
        }
    }

    #[test]
    fn fixed_bounds_cover_every_version() {
        for version in 1..=10 {
            let lengths = block_data_lengths(version);
            let ec = EC_PER_BLOCK[version - 1];
            assert!(lengths.count <= MAX_BLOCKS, "version {version} blocks");
            assert!(ec <= MAX_EC, "version {version} check count");
            assert!(DATA_CODEWORDS[version - 1] <= MAX_DATA_CODEWORDS);
            assert!(
                lengths.as_slice().iter().max().copied().unwrap_or(0) + ec <= MAX_BLOCK_BYTES,
                "version {version} block bytes"
            );
            assert!(
                DATA_CODEWORDS[version - 1] + lengths.count * ec <= MAX_CODEWORDS,
                "version {version} codewords"
            );
        }
    }
}
