// KINS section table: contiguous per-domain sections and their revisions.
use crate::core::replay;
use crate::error::KinError;
use crate::sections::{section_ranges, SectionRevisions, BODY_OFFSET, SECTION_COUNT};
use crate::test_support::*;

fn projection(records: &[Vec<u8>]) -> Vec<u8> {
    replay(&kine(records, 0, TEST_DATE, None)).unwrap()
}

fn revision(bytes: &[u8], index: usize) -> u32 {
    header_u32(bytes, 96 + index * 8)
}

#[test]
fn sections_are_contiguous_in_body_order_and_cover_the_body() {
    let bytes = projection(&[
        item_record(1, 0x11, b"Milk", 1),
        text_record(5, 2, 0x12, b"Bins"),
        text_record(8, 3, 0x13, b"Rota"),
    ]);
    assert_eq!(BODY, BODY_OFFSET);
    let ranges = section_ranges(&bytes).unwrap();
    // Item record (48 + text), then its Area ID, planning date and last change.
    assert_eq!(section_length(&bytes, 0), 48 + 4 + 16 + 4 + 8);
    assert_eq!(section_length(&bytes, 1), 48 + 4, "Handoffs");
    assert_eq!(section_length(&bytes, 2), 48 + 4, "Talks");
    for empty in 3..13 {
        assert_eq!(section_length(&bytes, empty), 0);
    }
    assert_eq!(
        section_length(&bytes, 13),
        3 * (24 + 4),
        "three summary entries"
    );
    assert_eq!(
        &bytes[ranges[1].start..ranges[1].start + 16],
        &numbered_id(0x12)
    );
    assert_eq!(
        &bytes[ranges[2].start..ranges[2].start + 16],
        &numbered_id(0x13)
    );
    assert_eq!(ranges[13].end, bytes.len());
    // The pure encoder leaves every revision unversioned.
    assert!((0..SECTION_COUNT).all(|index| revision(&bytes, index) == 0));
}

#[test]
fn a_table_that_does_not_cover_the_body_is_malformed() {
    let mut bytes = projection(&[item_record(1, 0x11, b"Milk", 1)]);
    bytes.push(0);
    assert_eq!(
        section_ranges(&bytes).unwrap_err(),
        KinError::MalformedProtocol
    );
    let mut revisions = SectionRevisions::new();
    assert_eq!(
        revisions.stamp(&mut bytes, None).unwrap_err(),
        KinError::MalformedProtocol
    );
}

#[test]
fn header_fields_belong_to_their_section() {
    let before = projection(&[item_record(1, 0x11, b"Milk", 1)]);
    let mut revisions = SectionRevisions::new();
    let mut first = before.clone();
    revisions.stamp(&mut first, None).unwrap();
    // Same section bytes, different summary total: only the summary changes.
    let mut after = before.clone();
    after[28] += 1;
    revisions.stamp(&mut after, Some(&first)).unwrap();
    assert_eq!(revision(&after, 13), 2);
    assert!((0..13).all(|index| revision(&after, index) == 1));
}

#[test]
fn revisions_wrap_past_zero() {
    let mut bytes = projection(&[]);
    SectionRevisions::starting_at(u32::MAX)
        .stamp(&mut bytes, None)
        .unwrap();
    assert!((0..SECTION_COUNT).all(|index| revision(&bytes, index) == 1));
}

#[test]
fn a_one_byte_change_anywhere_in_a_section_is_a_change() {
    let base = projection(&[item_record(1, 0x11, b"Milk and bread for the week", 1)]);
    let items = section_ranges(&base).unwrap()[0].clone();
    for offset in items {
        let mut changed = base.clone();
        changed[offset] ^= 1;
        let mut tracker = SectionRevisions::new();
        let mut first = base.clone();
        tracker.stamp(&mut first, None).unwrap();
        tracker.stamp(&mut changed, Some(&first)).unwrap();
        assert_eq!(revision(&changed, 0), 2, "byte {offset}");
    }
}

#[test]
fn every_count_and_summary_field_of_the_header_belongs_to_a_section() {
    // If a header field moves, `Section::header_fields` must move with it, or
    // equal section bytes with different counts would keep their revision.
    // Not owned: magic and version (0..8), mode and its padding (68..72).
    let mut owned = [false; 96];
    for section in crate::sections::SECTIONS {
        for &(start, end) in section.header_fields() {
            for byte in &mut owned[start..end] {
                assert!(!*byte, "header byte claimed twice");
                *byte = true;
            }
        }
    }
    let expected: Vec<bool> = (0..96)
        .map(|at| !(at < 8 || (68..72).contains(&at)))
        .collect();
    assert_eq!(owned.to_vec(), expected);
}
