//! Typed scholarly feedback (ADRs 0079 to 0081): the shared fixtures that the
//! hosted function's validator (`web/components/passage-feedback.js`) also
//! reads, plus the record round trip, the manual channel, the moderation item
//! the hosted function returns, and privacy of what a record may hold.

use openblog_core::date::DateTime;
use openblog_core::feedback_provenance::{FeedbackChannel, ReaderAttribution};
use openblog_core::passage_target::{PassageDocument, PassageSelector};
use openblog_core::scholarly_feedback::{
    normalize_feedback_source_url, DetailRule, FeedbackErrorCode, FeedbackKind, FeedbackStatus,
    FeedbackSubmission, HostedFeedback, ScholarlyFeedback, MAX_SUBMISSION_JSON_BYTES,
};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/scholarly-feedback.json"
    ))
    .unwrap()
}

fn text_of(case: &Value) -> String {
    match case.get("text") {
        Some(text) => text.as_str().unwrap().to_string(),
        None => case["submission"].to_string(),
    }
}

fn code_name(code: impl serde::Serialize) -> String {
    serde_json::to_value(code)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

fn at(text: &str) -> DateTime {
    DateTime::parse(text).unwrap()
}

#[test]
fn accepted_fixtures_produce_the_shared_records() {
    let fixture = fixture();
    let received = at(fixture["receivedAt"].as_str().unwrap());
    for case in fixture["accepted"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let submission = FeedbackSubmission::from_json(&text_of(case))
            .unwrap_or_else(|error| panic!("{name}: refused with {error:?}"));
        // The canonical submission reads back as itself.
        assert_eq!(
            FeedbackSubmission::from_json(&submission.to_json()).unwrap(),
            submission,
            "{name}"
        );
        let record = submission
            .receive(received, FeedbackChannel::Hosted)
            .unwrap();
        assert_eq!(record.to_value(), case["record"], "{name}");
        // The stored record reads back as the same record.
        assert_eq!(
            ScholarlyFeedback::from_json(&record.to_json()).unwrap(),
            record,
            "{name}"
        );
    }
}

#[test]
fn refused_fixtures_report_the_shared_codes() {
    let fixture = fixture();
    for case in fixture["refused"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let text = text_of(case);
        let error =
            FeedbackSubmission::from_json(&text).expect_err(&format!("{name}: should be refused"));
        assert_eq!(code_name(error.code), case["code"], "{name}");
        match case.get("target") {
            Some(target) => assert_eq!(
                error.target.map(code_name).as_deref(),
                target.as_str(),
                "{name}"
            ),
            None => assert!(error.target.is_none(), "{name}"),
        }
        // A message names the field and never repeats what the reader wrote.
        for secret in ["ada@example.org", "secret", "Ring", "ecalovel", "irony"] {
            assert!(!error.message.contains(secret), "{name}: {}", error.message);
        }
    }
}

#[test]
fn the_moderation_item_the_function_returns_reads_as_the_received_record() {
    let fixture = fixture();
    let item = HostedFeedback::from_value(&fixture["hostedItem"]).unwrap();
    assert_eq!(item.status, FeedbackStatus::Pending);
    assert_eq!(item.moderated_at, None);
    assert_eq!(item.feedback.to_value(), fixture["accepted"][1]["record"]);
    assert_eq!(item.feedback.kind, FeedbackKind::SourceSuggestion);
    assert_eq!(
        item.feedback.provenance.attribution.public_name(),
        Some("Ada Lovelace")
    );

    assert_eq!(item.version, 1);
    assert_eq!(item.reason, None);

    // Every state of the participation policy (RD12) is read, so an item
    // another tool moved is shown as it is; anything else is refused.
    let mut clarification = fixture["hostedItem"].clone();
    clarification["status"] = json!("clarification");
    assert_eq!(
        HostedFeedback::from_value(&clarification).unwrap().status,
        FeedbackStatus::Clarification
    );
    for (field, value) in [
        ("status", json!("bogus")),
        ("status", json!("Approved")),
        ("version", json!(0)),
        ("version", json!(-1)),
        ("version", json!("1")),
        ("reason", json!("incorrect")),
        ("reason", json!("Spam")),
    ] {
        let mut broken = fixture["hostedItem"].clone();
        broken[field] = value.clone();
        assert_eq!(
            HostedFeedback::from_value(&broken).unwrap_err().code,
            FeedbackErrorCode::InvalidRecord,
            "{field}: {value}"
        );
    }
    let mut missing_version = fixture["hostedItem"].clone();
    missing_version.as_object_mut().unwrap().remove("version");
    assert!(HostedFeedback::from_value(&missing_version).is_err());
    let mut rejected = fixture["hostedItem"].clone();
    rejected["status"] = json!("rejected");
    rejected["version"] = json!(2);
    rejected["reason"] = json!("off-topic");
    let rejected = HostedFeedback::from_value(&rejected).unwrap();
    assert_eq!(
        rejected.reason,
        Some(openblog_core::feedback_moderation::ReasonCode::OffTopic)
    );
    assert_eq!(rejected.version, 2);
    let mut bad_id = fixture["hostedItem"].clone();
    bad_id["id"] = json!("1; drop table");
    assert!(HostedFeedback::from_value(&bad_id).is_err());
    let mut moderated = fixture["hostedItem"].clone();
    moderated["status"] = json!("approved");
    moderated["moderatedAt"] = json!("2026-10-27T08:00:00Z");
    let moderated = HostedFeedback::from_value(&moderated).unwrap();
    assert_eq!(moderated.status, FeedbackStatus::Approved);
    assert_eq!(moderated.moderated_at, Some(at("2026-10-27T08:00:00Z")));

    // Stored data is not trusted more than a request: a record whose text is
    // not in its stored form, or whose kind no longer accepts its target,
    // is refused on its own.
    let mut untrimmed = fixture["hostedItem"].clone();
    untrimmed["feedback"]["body"] = json!("  padded  ");
    assert_eq!(
        HostedFeedback::from_value(&untrimmed).unwrap_err().code,
        FeedbackErrorCode::InvalidRecord
    );
    let mut correction = fixture["hostedItem"].clone();
    correction["feedback"]["kind"] = json!("correction-suggestion");
    assert_eq!(
        HostedFeedback::from_value(&correction).unwrap_err().code,
        FeedbackErrorCode::TargetNotAllowed
    );
    let mut ahead = fixture["hostedItem"].clone();
    ahead["feedback"]["provenance"]["seenAt"] = json!("2026-10-26T10:30:00Z");
    assert_eq!(
        HostedFeedback::from_value(&ahead).unwrap_err().code,
        FeedbackErrorCode::InvalidRecord
    );
    let mut extra = fixture["hostedItem"].clone();
    extra["feedback"]["provenance"]["email"] = json!("ada@example.org");
    assert!(HostedFeedback::from_value(&extra).is_err());
}

#[test]
fn oversized_submissions_are_refused_before_parsing() {
    let text = format!("{{\"pad\":\"{}\"}}", "a".repeat(MAX_SUBMISSION_JSON_BYTES));
    assert_eq!(
        FeedbackSubmission::from_json(&text).unwrap_err().code,
        FeedbackErrorCode::TooLarge
    );
}

#[test]
fn a_copied_submission_entered_by_the_author_makes_the_same_record() {
    let fixture = fixture();
    let case = &fixture["accepted"][1];
    let submission = FeedbackSubmission::from_json(&text_of(case)).unwrap();
    let hosted = submission
        .clone()
        .receive(at("2026-10-26T10:00:00Z"), FeedbackChannel::Hosted)
        .unwrap();
    let manual = submission
        .receive(at("2026-10-26T10:00:00Z"), FeedbackChannel::Manual)
        .unwrap();
    assert_eq!(manual.provenance.channel, FeedbackChannel::Manual);
    assert_eq!(manual.kind, hosted.kind);
    assert_eq!(manual.body, hosted.body);
    assert_eq!(manual.details, hosted.details);
    assert_eq!(manual.provenance.target, hosted.provenance.target);
}

#[test]
fn kinds_are_intent_with_their_own_detail_and_target_rules() {
    for kind in FeedbackKind::ALL {
        assert_eq!(FeedbackKind::from_id(kind.id()), Some(kind));
        // Ids fit the storage check, so a kind never needs a migration.
        assert!(kind.id().len() <= 40);
        assert!(kind
            .id()
            .chars()
            .all(|c| c.is_ascii_lowercase() || c == '-'));
        assert!(kind.accepts(&PassageSelector::Section { digest: None }));
    }
    // A suggestion is never labelled a correction before an author decides.
    assert_eq!(
        FeedbackKind::CorrectionSuggestion.label(),
        "Suggested correction"
    );
    assert!(!FeedbackKind::CorrectionSuggestion.accepts(&PassageSelector::Work));
    assert_eq!(
        FeedbackKind::SourceSuggestion.source_url(),
        DetailRule::Required
    );
    assert_eq!(FeedbackKind::Question.suggested_text(), DetailRule::NotUsed);
    assert_eq!(FeedbackKind::from_id("comment"), None);
}

#[test]
fn a_submission_made_from_a_real_page_resolves_against_it() {
    let doc = PassageDocument::from_markdown(
        "## Tides\n\nThe moon causes the tides. The sun matters too.\n",
        false,
    );
    let text = &doc.sections[0].text;
    let start = text.find("The sun").unwrap();
    let target = doc.quote(0, start, text.len()).unwrap();
    let submission = json!({
        "version": 1,
        "kind": "correction-suggestion",
        "work": "/posts/tides/",
        "revision": doc.revision,
        "target": target.to_value(),
        "body": "The sun matters less than this says.",
        "details": { "suggestedText": "The sun matters a little." },
    });
    let record = FeedbackSubmission::from_json(&submission.to_string())
        .unwrap()
        .receive(at("2026-10-26T10:00:00Z"), FeedbackChannel::Hosted)
        .unwrap();
    assert!(!record.provenance.resolve(&doc).is_stale());
    let public = record.provenance.public(&doc);
    assert_eq!(public.quote.as_deref(), Some("The sun matters too."));
    // Anonymous by default: nothing about the reader reaches the public form.
    assert_eq!(public.name, None);
    assert_eq!(
        record.provenance.attribution,
        ReaderAttribution::anonymous()
    );
}

#[test]
fn source_links_follow_the_whatwg_rules_and_stay_ascii() {
    assert_eq!(
        normalize_feedback_source_url("https://EXAMPLE.org").as_deref(),
        Some("https://example.org/")
    );
    assert_eq!(
        normalize_feedback_source_url("https://example.org/ä?q=ü").as_deref(),
        Some("https://example.org/%C3%A4?q=%C3%BC")
    );
    for refused in [
        "https://user:pw@example.org/",
        "mailto:ada@example.org",
        "https://",
        "http://exa\u{200f}mple.org/",
    ] {
        assert_eq!(normalize_feedback_source_url(refused), None, "{refused}");
    }
}
