//! The symbol's fixed structure, shared by the encoder and the decoder: the
//! function patterns, the order of data modules, masks, format and version
//! information, and the penalty used to choose a mask.

use super::tables;

/// The largest symbol side (version 10), and so the largest module count.
pub const MAX_SIZE: usize = 57;
pub const MAX_MODULES: usize = MAX_SIZE * MAX_SIZE;

/// Module grid, one byte per module (1 = dark), row-major, in fixed storage:
/// only the first `size * size` entries are used. Nothing here allocates.
pub struct Grid {
    pub size: usize,
    pub dark: [u8; MAX_MODULES],
    /// True for every module that is a function pattern or format/version
    /// information rather than data.
    pub reserved: [bool; MAX_MODULES],
}

impl Grid {
    /// A grid for `version` with all function patterns drawn and reserved.
    pub fn with_function_patterns(version: usize) -> Grid {
        let size = tables::size(version);
        let mut grid = Grid {
            size,
            dark: [0; MAX_MODULES],
            reserved: [false; MAX_MODULES],
        };
        grid.draw_finders();
        grid.draw_timing();
        grid.draw_alignment(version);
        grid.set_function(8, size - 8, true); // the always-dark module
        for (x, y, _) in format_modules(size) {
            grid.set_function(x, y, false); // reserved; written after masking
        }
        if version >= 7 {
            let bits = version_bits(version);
            for i in 0..18 {
                let dark = (bits >> i) & 1 == 1;
                let (a, b) = (size - 11 + i % 3, i / 3);
                grid.set_function(a, b, dark);
                grid.set_function(b, a, dark);
            }
        }
        grid
    }

    fn set_function(&mut self, x: usize, y: usize, dark: bool) {
        let index = y * self.size + x;
        self.dark[index] = dark as u8;
        self.reserved[index] = true;
    }

    fn draw_finders(&mut self) {
        let size = self.size;
        for (fx, fy) in [(0usize, 0usize), (size - 7, 0), (0, size - 7)] {
            for dy in -4isize..=4 {
                for dx in -4isize..=4 {
                    let (x, y) = (fx as isize + 3 + dx, fy as isize + 3 + dy);
                    if x < 0 || y < 0 || x >= size as isize || y >= size as isize {
                        continue;
                    }
                    let distance = dx.abs().max(dy.abs());
                    // Dark ring and centre, light ring, and a light separator.
                    let dark = distance <= 1 || distance == 3;
                    self.set_function(x as usize, y as usize, dark);
                }
            }
        }
    }

    fn draw_timing(&mut self) {
        for i in 8..self.size - 8 {
            self.set_function(6, i, i.is_multiple_of(2));
            self.set_function(i, 6, i.is_multiple_of(2));
        }
    }

    fn draw_alignment(&mut self, version: usize) {
        let centres = tables::ALIGNMENT[version - 1];
        let last = self.size - 7;
        let finder_centres = [(6, 6), (6, last), (last, 6)];
        for &cx in centres {
            for &cy in centres {
                // Skip the three centres that would overlap a finder pattern.
                if finder_centres.contains(&(cx, cy)) {
                    continue;
                }
                for dy in -2isize..=2 {
                    for dx in -2isize..=2 {
                        let distance = dx.abs().max(dy.abs());
                        self.set_function(
                            (cx as isize + dx) as usize,
                            (cy as isize + dy) as usize,
                            distance != 1,
                        );
                    }
                }
            }
        }
    }

    /// Writes the 15 format bits (both copies) into the grid.
    pub fn write_format(&mut self, bits: u32) {
        write_format_bits(&mut self.dark, self.size, bits);
    }

    /// Data module indices in placement order (see [`DataOrder`]). The
    /// iterator borrows only the reserved map, so the caller can write
    /// `dark` while walking it.
    pub fn data_order(&self) -> DataOrder<'_> {
        DataOrder::new(&self.reserved, self.size)
    }
}

/// Writes the 15 format bits into a module array of side `size`.
pub fn write_format_bits(dark: &mut [u8], size: usize, bits: u32) {
    for (x, y, bit) in format_modules(size) {
        dark[y * size + x] = ((bits >> bit) & 1) as u8;
    }
}

/// Data module indices in placement order: two columns at a time from the
/// bottom-right, alternating upward and downward, skipping column 6 and
/// every reserved module. Lazy, so no order table is built.
pub struct DataOrder<'a> {
    reserved: &'a [bool],
    size: usize,
    right: isize,
    upward: bool,
    step: usize,
    second_column: bool,
}

impl<'a> DataOrder<'a> {
    pub(super) fn new(reserved: &'a [bool], size: usize) -> DataOrder<'a> {
        DataOrder {
            reserved,
            size,
            right: size as isize - 1,
            upward: true,
            step: 0,
            second_column: false,
        }
    }
}

impl Iterator for DataOrder<'_> {
    type Item = usize;

    fn next(&mut self) -> Option<usize> {
        let size = self.size;
        loop {
            if self.right < 1 {
                return None;
            }
            if self.step == size {
                // The pair of columns is done: move two left, skipping the
                // vertical timing column.
                self.step = 0;
                self.second_column = false;
                self.upward = !self.upward;
                self.right -= 2;
                if self.right == 6 {
                    self.right -= 1;
                }
                continue;
            }
            let y = if self.upward {
                size - 1 - self.step
            } else {
                self.step
            };
            let column = if self.second_column {
                self.right - 1
            } else {
                self.right
            };
            if self.second_column {
                self.second_column = false;
                self.step += 1;
            } else {
                self.second_column = true;
            }
            let index = y * size + column as usize;
            if !self.reserved[index] {
                return Some(index);
            }
        }
    }
}

/// Positions of the 15 format-information bits: (x, y, bit index). Each bit
/// appears twice, around the top-left finder and split across the others.
pub fn format_modules(size: usize) -> [(usize, usize, u32); 30] {
    let mut modules = [(0usize, 0usize, 0u32); 30];
    let mut count = 0;
    let mut push = |module: (usize, usize, u32)| {
        modules[count] = module;
        count += 1;
    };
    for i in 0..=5 {
        push((8, i, i as u32));
    }
    push((8, 7, 6));
    push((8, 8, 7));
    push((7, 8, 8));
    for i in 9..15 {
        push((14 - i, 8, i as u32));
    }
    for i in 0..8 {
        push((size - 1 - i, 8, i as u32));
    }
    for i in 8..15 {
        push((8, size - 15 + i, i as u32));
    }
    modules
}

/// Format information for level M and `mask`: BCH(15,5), then masked.
pub fn format_bits(mask: u8) -> u32 {
    const GENERATOR: u32 = 0x537;
    const MASK: u32 = 0x5412;
    let data = u32::from(mask); // level M is 0b00
    let mut remainder = data;
    for _ in 0..10 {
        remainder = (remainder << 1) ^ ((remainder >> 9) * GENERATOR);
    }
    ((data << 10) | remainder) ^ MASK
}

/// The 15 valid format words, for matching a damaged read.
pub fn all_format_words() -> [u32; 8] {
    let mut words = [0u32; 8];
    for mask in 0..8u8 {
        words[mask as usize] = format_bits(mask);
    }
    words
}

/// Version information for versions 7 and above: BCH(18,6).
pub fn version_bits(version: usize) -> u32 {
    const GENERATOR: u32 = 0x1F25;
    let mut remainder = version as u32;
    for _ in 0..12 {
        remainder = (remainder << 1) ^ ((remainder >> 11) * GENERATOR);
    }
    ((version as u32) << 12) | remainder
}

/// Whether the data module at (row `i`, column `j`) is inverted by `mask`.
pub fn mask_applies(mask: u8, i: usize, j: usize) -> bool {
    match mask {
        0 => (i + j).is_multiple_of(2),
        1 => i.is_multiple_of(2),
        2 => j.is_multiple_of(3),
        3 => (i + j).is_multiple_of(3),
        4 => (i / 2 + j / 3).is_multiple_of(2),
        5 => (i * j) % 2 + (i * j) % 3 == 0,
        6 => ((i * j) % 2 + (i * j) % 3).is_multiple_of(2),
        _ => ((i + j) % 2 + (i * j) % 3).is_multiple_of(2),
    }
}

/// The mask penalty (ISO/IEC 18004 §8.8.2): runs, 2×2 blocks, finder-like
/// patterns and the dark/light balance.
pub fn penalty(dark: &[u8], size: usize) -> u32 {
    let at = |x: usize, y: usize| dark[y * size + x] == 1;
    let mut score = 0u32;
    // Rule 1: runs of five or more in a row or column.
    for line in 0..size {
        for horizontal in [true, false] {
            let get = |k: usize| if horizontal { at(k, line) } else { at(line, k) };
            let mut run = 1u32;
            let mut previous = get(0);
            for k in 1..size {
                let current = get(k);
                if current == previous {
                    run += 1;
                } else {
                    if run >= 5 {
                        score += 3 + (run - 5);
                    }
                    run = 1;
                    previous = current;
                }
            }
            if run >= 5 {
                score += 3 + (run - 5);
            }
        }
    }
    // Rule 2: 2×2 blocks of one colour.
    for y in 0..size - 1 {
        for x in 0..size - 1 {
            let c = at(x, y);
            if c == at(x + 1, y) && c == at(x, y + 1) && c == at(x + 1, y + 1) {
                score += 3;
            }
        }
    }
    // Rule 3: 1:1:3:1:1 finder-like sequences with four light modules beside.
    const LIKE_A: [u8; 11] = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const LIKE_B: [u8; 11] = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for line in 0..size {
        for horizontal in [true, false] {
            let get = |k: usize| u8::from(if horizontal { at(k, line) } else { at(line, k) });
            for start in 0..=size.saturating_sub(11) {
                let window: [u8; 11] = std::array::from_fn(|k| get(start + k));
                if window == LIKE_A || window == LIKE_B {
                    score += 40;
                }
            }
        }
    }
    // Rule 4: dark proportion, measured in steps of five percent.
    let dark_count = dark.iter().filter(|&&d| d == 1).count();
    let percent = dark_count * 100 / (size * size);
    let previous = (percent - percent % 5) as i32;
    let k1 = (previous - 50).abs() / 5;
    let k2 = (previous + 5 - 50).abs() / 5;
    score += 10 * k1.min(k2) as u32;
    score
}
