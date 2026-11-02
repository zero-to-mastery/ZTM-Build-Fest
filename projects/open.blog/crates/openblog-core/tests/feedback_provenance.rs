//! Feedback provenance (ADR 0078): the revision a reader saw and when, the
//! receiver's own timestamp, consent-gated names, a public projection that
//! never republishes removed text, scoped failures, and a hard line between
//! reader feedback and the author's research notes.

use std::collections::BTreeMap;

use openblog_core::date::DateTime;
use openblog_core::feedback_provenance::{
    is_work_path, FeedbackChannel, FeedbackProvenance, ProvenanceErrorCode, ReaderAttribution,
    MAX_PROVENANCE_JSON_BYTES,
};
use openblog_core::passage_target::{PassageDocument, Resolution, TargetErrorCode};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use serde_json::{json, Value};

const SEEN: &str =
    "## Tides\n\nThe moon causes the tides. The sun matters too.\n\n## Notes\n\nField notes.\n";
const EDITED: &str = "## Tides\n\nMost agree: the moon causes the tides. The sun matters too.\n\n## Notes\n\nField notes.\n";
const REMOVED: &str = "## Tides\n\nGravity raises the sea.\n";

fn at(text: &str) -> DateTime {
    DateTime::parse(text).unwrap()
}

/// "The sun matters too." as a reader selected it on the first revision.
fn record(name: Option<&str>, publish_name: bool) -> (PassageDocument, FeedbackProvenance) {
    let doc = PassageDocument::from_markdown(SEEN, false);
    let text = &doc.sections[0].text;
    let start = text.find("The sun").unwrap();
    let target = doc.quote(0, start, text.len()).unwrap();
    let record = FeedbackProvenance::record(
        "/posts/tides/",
        &doc.revision,
        target,
        Some(at("2026-10-26T09:58:00Z")),
        at("2026-10-26T10:00:00Z"),
        FeedbackChannel::Hosted,
        ReaderAttribution {
            name: name.map(str::to_string),
            publish_name,
        },
    )
    .unwrap();
    (doc, record)
}

fn value(record: &FeedbackProvenance) -> Value {
    serde_json::from_str(&record.to_json()).unwrap()
}

fn refused(value: Value) -> ProvenanceErrorCode {
    FeedbackProvenance::from_json(&value.to_string())
        .expect_err("refused")
        .code
}

#[test]
fn the_record_says_what_revision_the_reader_saw_and_when() {
    let (doc, record) = record(Some("  Ada \n Lovelace "), false);
    assert_eq!(
        value(&record),
        json!({
            "version": 1,
            "work": "/posts/tides/",
            "revision": doc.revision,
            "target": {
                "version": 1, "kind": "quote", "section": "tides",
                "exact": "The sun matters too.",
                "prefix": "Tides The moon causes the tides. ", "suffix": "", "start": 33
            },
            "seenAt": "2026-10-26T09:58:00Z",
            "receivedAt": "2026-10-26T10:00:00Z",
            "channel": "hosted",
            "attribution": {"name": "Ada Lovelace", "publishName": false}
        })
    );
    let again = FeedbackProvenance::from_json(&record.to_json()).unwrap();
    assert_eq!(again, record);
    assert_eq!(again.to_json(), record.to_json(), "canonical");
    assert!(matches!(record.resolve(&doc), Resolution::Current(_)));
    assert!(matches!(
        record.resolve(&PassageDocument::from_markdown(EDITED, false)),
        Resolution::Reanchored(_)
    ));
}

#[test]
fn the_receiver_stamps_receipt_and_a_reader_clock_ahead_is_dropped() {
    let (_, base) = record(None, false);
    let ahead = FeedbackProvenance::record(
        &base.work,
        &base.revision,
        base.target.clone(),
        Some(at("2026-10-26T11:00:00Z")),
        base.received_at,
        FeedbackChannel::Manual,
        ReaderAttribution::anonymous(),
    )
    .unwrap();
    assert_eq!(ahead.seen_at, None);
    assert!(!ahead.to_json().contains("seenAt"));
    // A stored record claiming that is refused rather than repaired.
    let mut stored = value(&base);
    stored["seenAt"] = json!("2026-10-26T11:00:00Z");
    assert_eq!(refused(stored), ProvenanceErrorCode::SeenAfterReceived);
}

#[test]
fn a_name_is_public_only_with_the_readers_agreement() {
    let edited = PassageDocument::from_markdown(EDITED, false);
    let (_, hidden) = record(Some("Ada Lovelace"), false);
    let public = hidden.public(&edited).to_json();
    assert!(!public.contains("Ada"), "{public}");
    let (_, anonymous) = record(None, false);
    assert!(anonymous.public(&edited).name.is_none());
    let (_, shown) = record(Some("Ada Lovelace"), true);
    assert_eq!(shown.public(&edited).name.as_deref(), Some("Ada Lovelace"));
    // Agreement without a name is refused, not treated as anonymous.
    let mut stored = value(&anonymous);
    stored["attribution"] = json!({"publishName": true});
    assert_eq!(refused(stored), ProvenanceErrorCode::ConsentWithoutName);
}

#[test]
fn the_public_projection_holds_no_reader_clock_channel_or_time_of_day() {
    let (_, record) = record(Some("Ada"), true);
    let edited = PassageDocument::from_markdown(EDITED, false);
    let public: Value = serde_json::from_str(&record.public(&edited).to_json()).unwrap();
    assert_eq!(
        public,
        json!({
            "work": "/posts/tides/",
            "revision": record.revision,
            "received": "2026-10-26",
            "stale": false,
            "section": "tides",
            "quote": "The sun matters too.",
            "name": "Ada"
        })
    );
}

#[test]
fn the_public_projection_never_republishes_removed_text() {
    let (_, record) = record(None, false);
    let removed = PassageDocument::from_markdown(REMOVED, false);
    let public = record.public(&removed);
    assert!(public.stale);
    assert_eq!(public.quote, None);
    assert_eq!(
        public.section.as_deref(),
        Some("tides"),
        "the section still exists"
    );
    assert!(!public.to_json().contains("sun"));

    let gone = PassageDocument::from_markdown("## Elsewhere\n\nOther text.\n", false);
    let public = record.public(&gone);
    assert_eq!(
        (public.stale, public.section, public.quote),
        (true, None, None)
    );

    // A whole-section target never quotes.
    let doc = PassageDocument::from_markdown(SEEN, false);
    let section = FeedbackProvenance::record(
        "/posts/tides/",
        &doc.revision,
        doc.section_target(1).unwrap(),
        None,
        at("2026-10-26T10:00:00Z"),
        FeedbackChannel::Manual,
        ReaderAttribution::anonymous(),
    )
    .unwrap();
    let public = section.public(&doc);
    assert_eq!(
        (public.stale, public.section.as_deref(), public.quote),
        (false, Some("notes"), None)
    );
}

#[test]
fn records_are_validated_field_by_field_without_repair() {
    let (_, record) = record(Some("Ada"), false);
    let base = value(&record);
    let with = |field: &str, replacement: Value| {
        let mut changed = base.clone();
        changed[field] = replacement;
        changed
    };
    let without = |field: &str| {
        let mut changed = base.clone();
        changed.as_object_mut().unwrap().remove(field);
        changed
    };
    assert_eq!(
        refused(with("version", json!(2))),
        ProvenanceErrorCode::UnsupportedVersion
    );
    assert_eq!(refused(without("version")), ProvenanceErrorCode::Malformed);
    assert_eq!(
        refused(without("receivedAt")),
        ProvenanceErrorCode::Malformed
    );
    assert_eq!(
        refused(with("channel", json!("carrier-pigeon"))),
        ProvenanceErrorCode::Malformed
    );
    // Identity cannot ride along in an undefined field.
    assert_eq!(
        refused(with("email", json!("ada@example.org"))),
        ProvenanceErrorCode::Malformed
    );
    assert_eq!(
        refused(with(
            "attribution",
            json!({"name": "Ada", "email": "ada@example.org"})
        )),
        ProvenanceErrorCode::Malformed
    );
    for work in [
        "/posts/../admin/",
        "https://example.org/x/",
        "/posts/x",
        "/a?b/",
        "/a#b/",
        "//evil/",
        "/a b/",
        "/a\\b/",
    ] {
        assert_eq!(
            refused(with("work", json!(work))),
            ProvenanceErrorCode::InvalidWork,
            "{work}"
        );
    }
    assert!(!is_work_path("/") && is_work_path("/posts/caf\u{e9}/"));
    for revision in ["", "p1:short", "sha256:0123456789abcdef0123456789abcdef"] {
        assert_eq!(
            refused(with("revision", json!(revision))),
            ProvenanceErrorCode::InvalidRevision
        );
    }
    for time in [
        "2026-10-26T10:00:00+02:00",
        "2026-10-26",
        "yesterday",
        "2026-10-26T10:00:00.5Z",
    ] {
        assert_eq!(
            refused(with("receivedAt", json!(time))),
            ProvenanceErrorCode::InvalidTime,
            "{time}"
        );
    }
    for name in ["", "x\u{202E}y", "line\nbreak", &"n".repeat(81)] {
        assert_eq!(
            refused(with("attribution", json!({"name": name}))),
            ProvenanceErrorCode::InvalidName,
            "{name:?}"
        );
    }
    let error = FeedbackProvenance::from_json(
        &with("target", json!({"version": 1, "kind": "quote", "exact": "", "prefix": "", "suffix": "", "start": 0})).to_string(),
    )
    .unwrap_err();
    assert_eq!(
        (error.code, error.target),
        (
            ProvenanceErrorCode::InvalidTarget,
            Some(TargetErrorCode::EmptyQuote)
        )
    );
    let error =
        FeedbackProvenance::from_json(&" ".repeat(MAX_PROVENANCE_JSON_BYTES + 1)).unwrap_err();
    assert_eq!(error.code, ProvenanceErrorCode::TooLarge);
    // Messages never repeat what the reader sent.
    let error = FeedbackProvenance::from_json(
        &with("attribution", json!({"name": "<script>\u{202E}"})).to_string(),
    )
    .unwrap_err();
    assert!(!error.message.contains("script"));
}

#[test]
fn one_bad_record_fails_alone() {
    let (doc, record) = record(None, false);
    let good = record.to_json();
    let inputs = [good.clone(), "{\"version\":1}".to_string(), good.clone()];
    let results: Vec<_> = inputs
        .iter()
        .map(|input| FeedbackProvenance::from_json(input).map(|record| record.resolve(&doc)))
        .collect();
    assert!(matches!(results[0], Ok(Resolution::Current(_))));
    assert_eq!(
        results[1].as_ref().unwrap_err().code,
        ProvenanceErrorCode::Malformed
    );
    assert_eq!(results[0], results[2]);
}

#[test]
fn feedback_provenance_and_research_notes_never_read_as_each_other() {
    let library = SourceLibrary::parse(
        &json!({"version": 1, "sources": [{"id": "plato-republic", "kind": "work", "title": "Politeia"}]})
            .to_string(),
        &BTreeMap::new(),
    )
    .unwrap();
    let notebook = json!({"version": 1, "passages": [], "notes": [
        {"id": "n-1", "kind": "question", "text": "Why a cave?", "sources": ["plato-republic"]}
    ]})
    .to_string();
    if let Err(problems) = Notebook::parse(&notebook, &library) {
        panic!("{problems:?}");
    }
    assert_eq!(
        FeedbackProvenance::from_json(&notebook).unwrap_err().code,
        ProvenanceErrorCode::Malformed
    );
    let (_, record) = record(Some("Ada"), true);
    assert!(Notebook::parse(&record.to_json(), &library).is_err());
}

const SHARED: &str =
    "## Intro\n\nThe tide is a long wave.\n\n## Other {#intro}\n\nMoonlight was the sailors' clock.\n";

fn shared_record(seen: &PassageDocument) -> FeedbackProvenance {
    let text = &seen.sections[1].text;
    let start = text.find("sailors").unwrap();
    let target = seen.quote(1, start, text.len() - 1).unwrap();
    FeedbackProvenance::record(
        "/posts/tides/",
        &seen.revision,
        target,
        None,
        at("2026-10-26T10:00:00Z"),
        FeedbackChannel::Manual,
        ReaderAttribution::anonymous(),
    )
    .unwrap()
}

#[test]
fn two_sections_sharing_an_anchor_publish_the_verified_quotation_not_the_first_sections_text() {
    let doc = PassageDocument::from_markdown(SHARED, false);
    assert_eq!(doc.sections[0].anchor.as_deref(), Some("intro"));
    assert_eq!(doc.sections[1].anchor.as_deref(), Some("intro"));
    let record = shared_record(&doc);
    // Current: the location names the second section by index.
    let Resolution::Current(location) = record.resolve(&doc) else {
        panic!("current");
    };
    assert_eq!(location.index, Some(1));
    assert_eq!(doc.text_at(&location).as_deref(), Some("sailors' clock"));
    assert_eq!(record.public(&doc).quote.as_deref(), Some("sailors' clock"));

    // Re-anchored: a later edit lengthens the first section, so the same
    // offsets would cut it mid-word. The published quotation is still
    // exactly what the reader quoted.
    let edited = PassageDocument::from_markdown(
        &SHARED.replace(
            "The tide is a long wave.",
            "The tide is a long wave that crosses an ocean.",
        ),
        false,
    );
    assert_ne!(edited.revision, doc.revision);
    let Resolution::Reanchored(location) = record.resolve(&edited) else {
        panic!("reanchored");
    };
    assert_eq!(location.index, Some(1));
    let public = record.public(&edited);
    assert_eq!(public.quote.as_deref(), Some("sailors' clock"));
    assert!(!public.stale);
}

#[test]
fn a_location_is_read_by_its_section_index_and_refused_when_the_anchor_disagrees() {
    let doc = PassageDocument::from_markdown(SHARED, false);
    let record = shared_record(&doc);
    let Resolution::Current(location) = record.resolve(&doc) else {
        panic!("current");
    };
    let mut first = location.clone();
    first.index = Some(0);
    assert_ne!(doc.text_at(&first).as_deref(), Some("sailors' clock"));
    let mut elsewhere = location.clone();
    elsewhere.section = Some("other".into());
    assert_eq!(doc.text_at(&elsewhere), None, "anchor and index disagree");
    let mut beyond = location;
    beyond.index = Some(9);
    assert_eq!(doc.text_at(&beyond), None);
}

#[test]
fn feedback_on_the_whole_post_has_valid_provenance_and_stays_current() {
    let doc = PassageDocument::from_markdown(SEEN, false);
    let record = FeedbackProvenance::record(
        "/posts/tides/",
        &doc.revision,
        doc.work_target(),
        None,
        at("2026-10-26T10:00:00Z"),
        FeedbackChannel::Hosted,
        ReaderAttribution::anonymous(),
    )
    .unwrap();
    assert_eq!(
        value(&record)["target"],
        json!({"version": 1, "kind": "work"})
    );
    assert_eq!(
        FeedbackProvenance::from_json(&record.to_json()).unwrap(),
        record
    );
    for text in [SEEN, EDITED, REMOVED] {
        let now = PassageDocument::from_markdown(text, false);
        assert!(matches!(record.resolve(&now), Resolution::Current(_)));
        let public = record.public(&now);
        assert!(!public.stale);
        assert_eq!((public.section, public.quote), (None, None));
    }
}
