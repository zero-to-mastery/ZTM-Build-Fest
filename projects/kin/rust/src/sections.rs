//! Projection sections and their revisions.
//!
//! A KINS projection carries a section table right after its 96-byte header:
//! one `(u32 revision, u32 byte length)` entry per domain section, in body
//! order. Each section's bytes are contiguous, so a host can skip decoding a
//! section it already holds.
//!
//! A revision is a per-engine-instance counter. It increases (wrapping, never
//! 0) whenever a section differs from the same section of the last projection
//! that instance emitted; an unchanged section keeps its revision. Sections are
//! compared byte for byte together with the header fields that describe them,
//! so an equal revision means equal bytes. Revision 0 means unversioned: the
//! pure encoder writes 0 and only the ABI layer stamps revisions, so the host
//! must always decode a section whose revision is 0.
use std::ops::Range;

use crate::error::KinError;
use crate::wire::{read_u32, RESULT_HEADER_BYTES};

/// Domain sections, in table and body order.
pub const SECTIONS: [Section; 14] = [
    Section::Items,
    Section::Handoffs,
    Section::Talks,
    Section::Pulses,
    Section::Routines,
    Section::Areas,
    Section::Notes,
    Section::Pins,
    Section::Playbooks,
    Section::ReferenceRecords,
    Section::Maintenance,
    Section::Attachments,
    Section::Responsibilities,
    Section::Summary,
];
pub const SECTION_COUNT: usize = SECTIONS.len();
pub const SECTION_ENTRY_BYTES: usize = 8;
pub const SECTION_TABLE_BYTES: usize = SECTION_COUNT * SECTION_ENTRY_BYTES;
/// Offset of the first section's bytes.
pub const BODY_OFFSET: usize = RESULT_HEADER_BYTES + SECTION_TABLE_BYTES;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Items,
    Handoffs,
    Talks,
    Pulses,
    Routines,
    Areas,
    Notes,
    Pins,
    Playbooks,
    ReferenceRecords,
    Maintenance,
    Attachments,
    Responsibilities,
    Summary,
}

impl Section {
    /// Header byte ranges, as (start, end), that describe this section (its counts; for the summary
    /// also the total and through event). They belong to the section's
    /// identity: equal bytes with different counts are a different section.
    /// Steps live inside the Items section, so Items also owns the step count
    /// (64..68). The summary's total and through event are header fields, so
    /// Summary owns 24..52. section_tests.rs checks every count is owned once.
    pub fn header_fields(self) -> &'static [(usize, usize)] {
        match self {
            Section::Items => &[(8, 12), (64, 68)],
            Section::Handoffs => &[(12, 16)],
            Section::Talks => &[(16, 20)],
            Section::Pulses => &[(20, 24)],
            Section::Routines => &[(52, 56)],
            Section::Areas => &[(56, 60)],
            Section::Notes => &[(60, 64)],
            Section::Pins => &[(72, 76)],
            Section::Playbooks => &[(76, 80)],
            Section::ReferenceRecords => &[(80, 84)],
            Section::Maintenance => &[(84, 88)],
            Section::Attachments => &[(88, 92)],
            Section::Responsibilities => &[(92, 96)],
            Section::Summary => &[(24, 52)],
        }
    }
}

/// The byte range of every section, checked against the table and the
/// projection length.
pub fn section_ranges(projection: &[u8]) -> Result<[Range<usize>; SECTION_COUNT], KinError> {
    let mut ranges: [Range<usize>; SECTION_COUNT] = Default::default();
    let mut offset = BODY_OFFSET;
    for (index, range) in ranges.iter_mut().enumerate() {
        let length = read_u32(
            projection,
            RESULT_HEADER_BYTES + index * SECTION_ENTRY_BYTES + 4,
        )?;
        let end = offset
            .checked_add(length as usize)
            .ok_or(KinError::MalformedProtocol)?;
        *range = offset..end;
        offset = end;
    }
    if offset != projection.len() {
        return Err(KinError::MalformedProtocol);
    }
    Ok(ranges)
}

/// One engine instance's revision counters.
pub struct SectionRevisions {
    counters: [u32; SECTION_COUNT],
}

impl Default for SectionRevisions {
    fn default() -> Self {
        Self::new()
    }
}

impl SectionRevisions {
    pub const fn new() -> Self {
        Self {
            counters: [0; SECTION_COUNT],
        }
    }

    /// Counters that all start at `value`, to test wrapping.
    #[cfg(test)]
    pub(crate) fn starting_at(value: u32) -> Self {
        Self {
            counters: [value; SECTION_COUNT],
        }
    }

    /// Writes revisions into `current`'s table. `previous` is the last
    /// projection this instance emitted, when it is still held; without it
    /// every section counts as changed.
    pub fn stamp(&mut self, current: &mut [u8], previous: Option<&[u8]>) -> Result<(), KinError> {
        let ranges = section_ranges(current)?;
        let previous = previous.and_then(|bytes| Some((bytes, section_ranges(bytes).ok()?)));
        for (index, section) in SECTIONS.iter().enumerate() {
            // Counter 0 means this instance never emitted the section, so there
            // is nothing it could be unchanged from.
            let unchanged = self.counters[index] != 0
                && previous.as_ref().is_some_and(|(bytes, before)| {
                    same_bytes(
                        &bytes[before[index].clone()],
                        &current[ranges[index].clone()],
                    ) && section
                        .header_fields()
                        .iter()
                        .all(|&(start, end)| bytes[start..end] == current[start..end])
                });
            if !unchanged {
                self.counters[index] = match self.counters[index].wrapping_add(1) {
                    0 => 1,
                    next => next,
                };
            }
            let at = RESULT_HEADER_BYTES + index * SECTION_ENTRY_BYTES;
            current[at..at + 4].copy_from_slice(&self.counters[index].to_le_bytes());
        }
        Ok(())
    }
}

/// Byte equality eight bytes at a time. On wasm32 a slice `==` lowers to a
/// byte-at-a-time memcmp, which dominated stamping a 40 MB Items section.
fn same_bytes(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let (left_words, right_words) = (left.chunks_exact(8), right.chunks_exact(8));
    let tails_equal = left_words.remainder() == right_words.remainder();
    tails_equal
        && left_words.zip(right_words).all(|(a, b)| {
            u64::from_ne_bytes(a.try_into().unwrap()) == u64::from_ne_bytes(b.try_into().unwrap())
        })
}
