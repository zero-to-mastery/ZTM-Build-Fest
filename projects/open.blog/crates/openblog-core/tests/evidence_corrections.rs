//! Evidence submissions and correction decisions (ADRs 0116 and 0117): the
//! shared fixtures for submissions, decisions and stored decisions (accepted,
//! declined, partially applied, duplicate, withdrawn, conflicting and
//! stale-target items), plus the rules that cut across them: nothing is a
//! correction before an author decides, decisions never erase provenance,
//! and no vote or popularity field can ride along.

use std::collections::BTreeMap;

use openblog_core::claims::ClaimSet;
use openblog_core::correction_decision::{
    audit_event, decide, decision_in_force, passage_check_from_id, passage_check_id,
    public_decision, standing, ClaimEvidenceRef, CorrectionDecision, DecisionContent,
    DecisionErrorCode, DecisionFacts, DecisionLog, DecisionOutcome, DecisionRequest, DeclineReason,
    Extent, RevisionLink, Standing,
};
use openblog_core::date::DateTime;
use openblog_core::evidence_submission::{
    is_evidence_kind, EvidenceErrorCode, EvidenceOffer, EvidenceRecord, EvidenceSubmission,
    PublishedReferences, ReferenceStatus, SitePublishedSources, EVIDENCE_KINDS,
};
use openblog_core::feedback_moderation::PassageCheck;
use openblog_core::feedback_provenance::FeedbackChannel;
use openblog_core::knowledge_atlas::Links;
use openblog_core::moderation::{
    Actor, ActorRole, AuditAction, ItemFacts, ModerationState, MODERATION_TOKEN_ACTOR,
};
use openblog_core::participation::ParticipationKind;
use openblog_core::research_notes::Notebook;
use openblog_core::scholarly_feedback::{FeedbackKind, FeedbackSubmission, HostedFeedback};
use openblog_core::source_library::SourceLibrary;
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/evidence-corrections.json"
    ))
    .unwrap()
}

fn code_name(code: impl serde::Serialize) -> String {
    serde_json::to_value(code)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

fn text_of(case: &Value) -> String {
    match case.get("text") {
        Some(text) => text.as_str().unwrap().to_string(),
        None => case["submission"].to_string(),
    }
}

#[test]
fn accepted_submissions_produce_the_shared_records() {
    let fixture = fixture();
    let received = DateTime::parse(fixture["receivedAt"].as_str().unwrap()).unwrap();
    for case in fixture["submissions"]["accepted"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let submission = EvidenceSubmission::from_json(&text_of(case))
            .unwrap_or_else(|error| panic!("{name}: refused with {error:?}"));
        assert_eq!(
            EvidenceSubmission::from_json(&submission.to_json()).unwrap(),
            submission,
            "{name}: the canonical form reads back"
        );
        if submission.evidence.is_none() {
            // Without evidence it is B5's own submission, byte for byte.
            let plain = FeedbackSubmission::from_json(&text_of(case)).unwrap();
            assert_eq!(submission.to_json(), plain.to_json(), "{name}");
        }
        let record = submission
            .receive(received, FeedbackChannel::Hosted)
            .unwrap();
        assert_eq!(record.to_value(), case["record"], "{name}");
        assert_eq!(
            EvidenceRecord::from_value(&case["record"]).unwrap(),
            record,
            "{name}: the stored record reads back"
        );
    }
}

#[test]
fn refused_submissions_report_the_shared_codes() {
    let fixture = fixture();
    for case in fixture["submissions"]["refused"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let error = EvidenceSubmission::from_json(&text_of(case))
            .expect_err(&format!("{name}: should be refused"));
        assert_eq!(code_name(error.code), case["code"], "{name}: {error:?}");
        assert_eq!(
            error.feedback.map(code_name),
            case["feedbackCode"].as_str().map(str::to_string),
            "{name}"
        );
        // Messages name fields, never what the reader wrote.
        assert!(!error.message.contains("The height is wrong"), "{name}");
    }
}

#[test]
fn a_hosted_version_2_item_without_its_block_still_reads_as_its_version_1_record() {
    // What a hosted function with evidence switched off sends for a stored
    // evidence submission: the record, without the column it did not read.
    let fixture = fixture();
    let record = fixture["submissions"]["accepted"][1]["record"].clone();
    let item = |feedback: &Value| {
        HostedFeedback::from_value(&json!({
            "id": "00000000-0000-4000-8000-0000000000a1", "status": "pending", "version": 1,
            "feedback": feedback,
        }))
    };
    let with = item(&record).unwrap();
    assert!(with.evidence.is_some());
    let mut without = record.clone();
    without.as_object_mut().unwrap().remove("evidence");
    let plain =
        item(&without).expect("a version 2 item without evidence is moderated as version 1");
    assert!(plain.evidence.is_none());
    assert_eq!(plain.feedback.body, with.feedback.body);
    // A block in a version 1 record is still refused: nothing is guessed there.
    let mut mixed = record;
    mixed["version"] = json!(1);
    assert!(item(&mixed).is_err());
}

#[test]
fn b5_readers_still_refuse_evidence() {
    let fixture = fixture();
    for case in fixture["submissions"]["accepted"].as_array().unwrap() {
        if case["submission"]["version"] == 2 {
            assert!(FeedbackSubmission::from_json(&text_of(case)).is_err());
        }
    }
}

fn published(fixture: &Value) -> PublishedReferences {
    let published = &fixture["decisions"]["published"];
    let mut references = PublishedReferences::new();
    for (claim, links) in published["claims"].as_object().unwrap() {
        references = references.with_claim(
            claim,
            links
                .as_array()
                .unwrap()
                .iter()
                .map(|l| l.as_str().unwrap()),
        );
    }
    for source in published["sources"].as_array().unwrap() {
        references = references.with_source(source.as_str().unwrap());
    }
    references
}

fn offer(value: &Value) -> Option<EvidenceOffer> {
    if value.is_null() {
        return None;
    }
    let submission = json!({"version": 2, "kind": "correction-suggestion", "work": "/posts/tides/",
        "revision": "p1:4a264dbcfbe9d0a56591ff04cbf12ca4",
        "target": {"version": 1, "kind": "section", "section": "tides"},
        "body": "x", "details": {"sourceUrl": "https://example.org/"}, "evidence": value});
    EvidenceSubmission::from_value(&submission)
        .unwrap()
        .evidence
}

fn kind(id: &str) -> FeedbackKind {
    FeedbackKind::from_id(id).unwrap()
}

/// The work every fixture item is about, and the works of the fixtures'
/// coordinator, whose shared publication holds it.
const WORK: &str = "/posts/tides/";
const COORDINATED: [&str; 1] = [WORK];

/// The actor `SharedWorks::actor` would resolve for a fixture role: the
/// fixtures name RD12's role ids, and an Admin role its account.
fn actor<'a>(role: &str, account: Option<&'a str>) -> Actor<'a> {
    match role {
        "site-admin" => Actor::SiteAdmin {
            admin_user: account.unwrap_or(MODERATION_TOKEN_ACTOR),
        },
        "coordinator" => Actor::Coordinator {
            admin_user: account.expect("a coordinator is an Admin account"),
            works: &COORDINATED,
        },
        "contributing-author" => Actor::ContributingAuthor {
            admin_user: account.unwrap_or("someone"),
            works: &COORDINATED,
        },
        "submitter" => Actor::Submitter,
        "system" => Actor::System,
        "public" => Actor::Public,
        other => panic!("unknown fixture role {other}"),
    }
}

fn item_facts<'a>(id: &'a str, item: &'a Value) -> ItemFacts<'a> {
    ItemFacts {
        id,
        kind: kind(item["kind"].as_str().unwrap()).participation_kind(),
        work: item["work"].as_str().or(Some(WORK)),
        parent: None,
        state: ModerationState::from_id(item["state"].as_str().unwrap()).unwrap(),
        version: item["version"].as_u64().unwrap_or(3),
        revision: item["revision"].as_u64().unwrap() as u32,
        approved_revision: None,
        clarification_asked: item["clarificationAsked"]
            .as_u64()
            .map(|value| value as u32),
        clarification_consent: false,
        content_retained: true,
        state_since: DateTime::parse("2026-10-26T10:00:00Z").unwrap(),
    }
}

fn log_of(item: &str, decisions: Option<&Value>) -> DecisionLog {
    let decisions = decisions.cloned().unwrap_or_else(|| json!([]));
    DecisionLog::from_value(&json!({"version": 1, "item": item, "decisions": decisions}))
        .unwrap_or_else(|error| panic!("a fixture log is valid: {error:?}"))
}

fn content(value: &Value) -> DecisionContent {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    DecisionContent {
        outcome: DecisionOutcome::from_id(value["outcome"].as_str().unwrap()).unwrap(),
        extent: text("extent").map(|id| Extent::from_id(&id).unwrap()),
        decline_reason: text("declineReason").map(|id| DeclineReason::from_id(&id).unwrap()),
        rationale: text("rationale"),
        revision_note: value
            .get("revisionNote")
            .map(|note| serde_json::from_value::<RevisionLink>(note.clone()).unwrap()),
        claim_evidence: value
            .get("claimEvidence")
            .map(|link| serde_json::from_value::<ClaimEvidenceRef>(link.clone()).unwrap()),
        addressed_by: text("addressedBy"),
    }
}

#[test]
fn decision_cases_record_or_refuse_as_the_fixtures_say() {
    let fixture = fixture();
    let references = published(&fixture);
    let items = &fixture["decisions"]["items"];
    for case in fixture["decisions"]["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut item = items[case["item"].as_str().unwrap()].clone();
        if let Some(overrides) = case.get("itemOverrides") {
            for (key, value) in overrides.as_object().unwrap() {
                item[key] = value.clone();
            }
        }
        let id = item["id"].as_str().unwrap();
        let check = passage_check_from_id(item["check"].as_str().unwrap()).unwrap();
        let facts = DecisionFacts {
            item: item_facts(id, &item),
            received: item["received"].as_str().unwrap(),
            post: item["post"].as_str(),
            check,
            passage_revision: item["passageRevision"].as_str(),
        };
        let evidence = offer(&item["evidence"]);
        let mut log = log_of(id, case.get("log"));
        let addressed = case.get("addressed").map(|addressed| {
            (
                log_of(
                    addressed["item"].as_str().unwrap(),
                    Some(&addressed["decisions"]),
                ),
                addressed["revision"].as_u64().unwrap_or(1) as u32,
            )
        });
        let request_value = &case["request"];
        let request = DecisionRequest {
            actor: actor(
                request_value["role"].as_str().unwrap(),
                request_value["account"].as_str(),
            ),
            expected_decisions: request_value["expectedDecisions"].as_u64().unwrap() as u32,
            content: content(&request_value["content"]),
            confirmed_check: request_value["confirmedCheck"]
                .as_str()
                .map(|id| passage_check_from_id(id).unwrap()),
            decided: request_value["decided"].as_str().unwrap(),
        };
        if let Some(before) = case.get("standing").and_then(|s| s.get("before")) {
            assert_eq!(
                standing(
                    kind(item["kind"].as_str().unwrap()),
                    evidence.as_ref(),
                    &log,
                    facts.item.revision
                )
                .id(),
                before,
                "{name}: standing before"
            );
        }
        let snapshot = log.clone();
        let result = decide(
            &facts,
            &log,
            addressed.as_ref().map(|(log, revision)| (log, *revision)),
            &request,
        );
        match (&case["expect"].get("decision"), result) {
            (Some(expected), Ok(decision)) => {
                assert_eq!(&decision.to_value(), *expected, "{name}");
                let at = DateTime::parse("2026-10-27T12:00:00Z").unwrap();
                let event = audit_event(&facts.item, &decision, at);
                assert_eq!(event.action, AuditAction::Decide, "{name}");
                assert_eq!(event.action.id(), "decide", "{name}");
                assert_eq!(
                    (event.from, event.to, event.version, event.reason),
                    (
                        Some(facts.item.state),
                        facts.item.state,
                        facts.item.version,
                        None
                    ),
                    "{name}: a decision leaves the item's state and version as they are"
                );
                assert_eq!(event.actor, decision.decided_by.role, "{name}");
                assert_eq!(
                    CorrectionDecision::from_value(expected).unwrap(),
                    decision,
                    "{name}: the stored decision reads back"
                );
                log.append(decision).unwrap();
                assert_eq!(
                    &log.history()[..snapshot.history().len()],
                    snapshot.history(),
                    "{name}: earlier decisions are kept, unchanged"
                );
                assert_eq!(
                    DecisionLog::from_value(&log.to_value()).unwrap(),
                    log,
                    "{name}: the log reads back"
                );
            }
            (None, Err(error)) => {
                assert_eq!(
                    code_name(error.code),
                    case["expect"]["error"],
                    "{name}: {error:?}"
                );
                assert_eq!(log, snapshot, "{name}: a refusal changes nothing");
            }
            (_, other) => panic!("{name}: unexpected {other:?}"),
        }
        if let Some(after) = case.get("standing").and_then(|s| s.get("after")) {
            assert_eq!(
                standing(
                    kind(item["kind"].as_str().unwrap()),
                    evidence.as_ref(),
                    &log,
                    facts.item.revision
                )
                .id(),
                after,
                "{name}: standing after"
            );
        }
        if let Some(public) = case.get("public") {
            let projected = public_decision(
                &log,
                public["itemPublic"].as_bool().unwrap(),
                facts.item.revision,
                &references,
            )
            .map(|decision| serde_json::to_value(decision).unwrap())
            .unwrap_or(Value::Null);
            assert_eq!(projected, public["decision"], "{name}: public decision");
        }
    }
}

#[test]
fn stored_decisions_that_break_a_rule_are_refused() {
    let fixture = fixture();
    for case in fixture["decisions"]["storedRefused"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let error = CorrectionDecision::from_value(&case["decision"])
            .expect_err(&format!("{name}: should be refused"));
        assert_eq!(code_name(error.code), case["code"], "{name}: {error:?}");
    }
}

#[test]
fn only_the_authors_acceptance_as_a_correction_labels_a_correction() {
    let empty = DecisionLog::new("11111111-1111-4111-8111-111111111111");
    let offers = [
        None,
        Some(EvidenceOffer {
            citation: Some("noaa-2020".into()),
            ..EvidenceOffer::default()
        }),
        Some(EvidenceOffer {
            source: Some("admiralty-1990".into()),
            ..EvidenceOffer::default()
        }),
    ];
    for kind in FeedbackKind::ALL {
        for offer in &offers {
            let undecided = standing(kind, offer.as_ref(), &empty, 1);
            assert!(!undecided.is_decided(), "{kind:?}");
            assert!(!undecided.is_correction(), "{kind:?}");
            assert_ne!(undecided.label(), "Correction", "{kind:?}");
        }
    }
    for outcome in DecisionOutcome::ALL {
        assert_eq!(
            outcome.is_correction(),
            outcome == DecisionOutcome::AcceptedAsCorrection
        );
        assert_eq!(
            Standing::Decided(outcome).is_correction(),
            outcome == DecisionOutcome::AcceptedAsCorrection
        );
        assert_eq!(DecisionOutcome::from_id(outcome.id()), Some(outcome));
    }
    // B5's label for a suggestion is unchanged and never "Correction".
    assert_eq!(
        standing(FeedbackKind::CorrectionSuggestion, None, &empty, 1).label(),
        FeedbackKind::CorrectionSuggestion.label()
    );
}

#[test]
fn no_id_or_label_judges_truth() {
    let verdicts = [
        "incorrect",
        "false",
        "wrong",
        "misinformation",
        "debunk",
        "verified",
        "true",
        "accurate",
        "fact",
        "refuted",
        "unreliable",
    ];
    let mut words: Vec<String> = Vec::new();
    for outcome in DecisionOutcome::ALL {
        words.extend([outcome.id().into(), outcome.label().into()]);
    }
    for reason in DeclineReason::ALL {
        words.extend([reason.id().into(), reason.label().into()]);
    }
    for word in words {
        let lower = word.to_lowercase();
        for verdict in verdicts {
            assert!(!lower.contains(verdict), "`{word}` reads as a verdict");
        }
    }
}

fn accepted_log() -> (DecisionLog, CorrectionDecision) {
    let fixture = fixture();
    let case = fixture["decisions"]["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| {
            case["name"]
                .as_str()
                .unwrap()
                .starts_with("accepted: a suggested correction accepted")
        })
        .unwrap()
        .clone();
    let decision = CorrectionDecision::from_value(&case["expect"]["decision"]).unwrap();
    let mut log = DecisionLog::new(&decision.item);
    log.append(decision.clone()).unwrap();
    (log, decision)
}

#[test]
fn decisions_never_erase_or_carry_the_readers_provenance() {
    let fixture = fixture();
    let received = DateTime::parse(fixture["receivedAt"].as_str().unwrap()).unwrap();
    let case = &fixture["submissions"]["accepted"][1];
    let record = EvidenceSubmission::from_json(&case["submission"].to_string())
        .unwrap()
        .receive(received, FeedbackChannel::Hosted)
        .unwrap();
    let before = record.to_json();
    let (log, decision) = accepted_log();
    // The decision is about the record by id; the record is not an input
    // that could change, and it reads back exactly as stored.
    assert_eq!(record.to_json(), before);
    let stored = decision.to_json();
    for private in [
        "Ada",
        "attribution",
        "seenAt",
        "receivedAt",
        "channel",
        "publishName",
        "body",
    ] {
        assert!(
            !stored.contains(private),
            "a decision never holds `{private}`"
        );
    }
    // The reader's revision stays in their provenance; the author's is the
    // decision's own field.
    assert_eq!(
        record.feedback.provenance.revision,
        "p1:4a264dbcfbe9d0a56591ff04cbf12ca4"
    );
    assert!(decision.passage_revision.is_some());
    // Superseding appends; the first decision is still there.
    let mut later = decision.clone();
    later.sequence = 2;
    later.decided = "2026-10-29".into();
    later.content = DecisionContent {
        decline_reason: Some(DeclineReason::MaintainsReading),
        rationale: Some("Back to the tables.".into()),
        ..DecisionContent::new(DecisionOutcome::Declined)
    };
    let mut log = log;
    log.append(later.clone()).unwrap();
    assert_eq!(log.history(), [decision.clone(), later.clone()]);
    assert_eq!(log.current(), Some(&later));
    // An out-of-order or foreign decision is refused and changes nothing.
    let snapshot = log.clone();
    assert!(log.append(decision.clone()).is_err());
    let mut foreign = later.clone();
    foreign.item = "22222222-2222-4222-8222-222222222222".into();
    foreign.sequence = 3;
    assert!(log.append(foreign).is_err());
    assert_eq!(log, snapshot);
}

#[test]
fn a_decision_on_an_earlier_revision_of_the_text_is_not_in_force() {
    let (log, _) = accepted_log();
    assert!(decision_in_force(&log, 1).is_some());
    // A clarification replaced the text since (RD12): the decision stays
    // recorded but the item stands undecided until the author decides again.
    assert!(decision_in_force(&log, 2).is_none());
    assert_eq!(
        standing(FeedbackKind::CorrectionSuggestion, None, &log, 2),
        Standing::PossibleError
    );
    assert_eq!(log.history().len(), 1);
    assert!(public_decision(&log, true, 2, &PublishedReferences::new()).is_none());
}

#[test]
fn a_public_decision_names_no_one_and_only_published_references() {
    let (log, _) = accepted_log();
    let public = public_decision(&log, true, 1, &PublishedReferences::new()).unwrap();
    let text = serde_json::to_string(&public).unwrap();
    for private in [
        "mikey",
        "site-admin",
        "decidedBy",
        "account",
        "passageCheck",
        "Ada",
    ] {
        assert!(
            !text.contains(private),
            "a public decision never holds `{private}`"
        );
    }
    // The revision note's claim is dropped while the claim is not published.
    assert_eq!(public.revision_note.as_ref().unwrap().claim, None);
    let published = PublishedReferences::new().with_claim("tide-height", []);
    let public = public_decision(&log, true, 1, &published).unwrap();
    assert_eq!(
        public.revision_note.unwrap().claim.as_deref(),
        Some("tide-height")
    );
}

#[test]
fn duplicates_are_independent_items_and_never_a_count() {
    // Any number of identical submissions stand exactly as one does: the
    // standing reads no count, and each is decided on its own.
    let offer = EvidenceOffer {
        claim: Some("tide-height".into()),
        ..EvidenceOffer::default()
    };
    let standings: Vec<Standing> = (0..5)
        .map(|n| {
            let log = DecisionLog::new(&format!("1111111{n}-1111-4111-8111-111111111111"));
            standing(FeedbackKind::CorrectionSuggestion, Some(&offer), &log, 1)
        })
        .collect();
    assert!(standings.iter().all(|s| *s == Standing::PossibleError));
    // A public decision has no count, score or rank of any kind.
    let (log, _) = accepted_log();
    let public =
        serde_json::to_value(public_decision(&log, true, 1, &PublishedReferences::new()).unwrap())
            .unwrap();
    for key in public.as_object().unwrap().keys() {
        for popularity in [
            "vote", "score", "count", "rank", "like", "popular", "weight",
        ] {
            assert!(!key.to_lowercase().contains(popularity), "`{key}`");
        }
    }
}

#[test]
fn popularity_fields_are_refused_everywhere() {
    let (log, decision) = accepted_log();
    for field in [
        "votes",
        "upvotes",
        "likes",
        "score",
        "rank",
        "verified",
        "accuracy",
        "agreeCount",
    ] {
        let mut stored = decision.to_value();
        stored[field] = json!(1);
        assert_eq!(
            CorrectionDecision::from_value(&stored).unwrap_err().code,
            DecisionErrorCode::Malformed,
            "{field} in a decision"
        );
        let mut stored = log.to_value();
        stored[field] = json!(1);
        assert_eq!(
            DecisionLog::from_value(&stored).unwrap_err().code,
            DecisionErrorCode::Malformed,
            "{field} in a log"
        );
        let submission = json!({"version": 2, "kind": "correction-suggestion", "work": "/posts/tides/",
            "revision": "p1:4a264dbcfbe9d0a56591ff04cbf12ca4",
            "target": {"version": 1, "kind": "section", "section": "tides"},
            "body": "x", "evidence": {"claim": "tide-height"}});
        let mut submission = submission;
        submission["evidence"][field] = json!(1);
        assert_eq!(
            EvidenceSubmission::from_value(&submission)
                .unwrap_err()
                .code,
            EvidenceErrorCode::Malformed,
            "{field} in an evidence block"
        );
    }
}

#[test]
fn reader_references_are_checked_only_against_what_is_published() {
    let published = PublishedReferences::new()
        .with_claim("tide-height", ["tide-height-noaa"])
        .with_source("noaa-2020");
    let offer = EvidenceOffer {
        claim: Some("tide-height".into()),
        evidence_link: Some("tide-height-noaa".into()),
        citation: Some("noaa-2020".into()),
        source: Some("private-diary".into()),
        ..EvidenceOffer::default()
    };
    let site = SitePublishedSources::new().with_source("noaa-2020");
    let report = published.check(&offer, &site);
    assert_eq!(report.claim, Some(ReferenceStatus::Published));
    assert_eq!(report.evidence_link, Some(ReferenceStatus::Published));
    assert_eq!(report.citation, Some(ReferenceStatus::Published));
    // A private or mistyped id reads only as not published here.
    assert_eq!(report.source, Some(ReferenceStatus::NotPublished));
    // The offered source is not the post's own target, so it alone never
    // makes the item stale.
    assert!(!report.any_unpublished());
    // A link named under another claim is not that claim's published link:
    // a stale claim target.
    let moved = EvidenceOffer {
        claim: Some("moon-phase".into()),
        evidence_link: Some("tide-height-noaa".into()),
        ..EvidenceOffer::default()
    };
    let report = published.check(&moved, &site);
    assert_eq!(report.claim, Some(ReferenceStatus::NotPublished));
    assert_eq!(report.evidence_link, Some(ReferenceStatus::NotPublished));
    assert_eq!(report.citation, None);
}

#[test]
fn an_offered_source_is_checked_against_the_sites_published_sources() {
    // Another post publishes the source; this post does not cite it yet.
    let this_post = PublishedReferences::new().with_claim("tide-height", []);
    let other_post = PublishedReferences::new().with_source("noaa-2020");
    let site = SitePublishedSources::from_posts([&this_post, &other_post]);
    let offer = EvidenceOffer {
        claim: Some("tide-height".into()),
        citation: Some("noaa-2020".into()),
        source: Some("noaa-2020".into()),
        ..EvidenceOffer::default()
    };
    let report = this_post.check(&offer, &site);
    assert_eq!(report.source, Some(ReferenceStatus::Published));
    // A citation is still the post's own: this post does not make it.
    assert_eq!(report.citation, Some(ReferenceStatus::NotPublished));
    assert!(report.any_unpublished());
    let new_source = EvidenceOffer {
        claim: Some("tide-height".into()),
        source: Some("noaa-2020".into()),
        ..EvidenceOffer::default()
    };
    let report = this_post.check(&new_source, &site);
    assert_eq!(report.source, Some(ReferenceStatus::Published));
    assert!(!report.any_unpublished());
    // A source no post publishes reads as not published, and is not stale.
    let report = this_post.check(&new_source, &SitePublishedSources::new());
    assert_eq!(report.source, Some(ReferenceStatus::NotPublished));
    assert!(!report.any_unpublished());
}

fn claims() -> ClaimSet {
    let library = SourceLibrary::parse(
        &json!({"version": 1, "sources": [{"id": "noaa-2020", "kind": "work", "title": "Tables"}]})
            .to_string(),
        &BTreeMap::new(),
    )
    .unwrap();
    let notebook = Notebook::parse(&json!({"version": 1}).to_string(), &library).unwrap();
    ClaimSet::parse(
        &json!({"version": 1,
            "claims": [{"id": "tide-height", "post": "tides", "statement": "The tide rises 3 m.", "visibility": "approved"},
                       {"id": "moon-phase", "post": "tides", "statement": "The moon pulls.", "visibility": "approved"},
                       {"id": "tide-secret", "post": "tides", "statement": "A private claim."}],
            "links": [{"id": "tide-height-ada", "claim": "tide-height", "relation": "supports",
                       "visibility": "approved", "evidence": {"source": "noaa-2020"}},
                      {"id": "tide-private-link", "claim": "tide-height", "relation": "contextualizes",
                       "evidence": {"source": "noaa-2020"}},
                      {"id": "secret-link", "claim": "tide-secret", "relation": "supports",
                       "visibility": "approved", "evidence": {"source": "noaa-2020"}}]})
        .to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .unwrap()
}

#[test]
fn claim_evidence_is_checked_in_the_authors_claims_file() {
    let set = claims();
    let link = |claim: &str, link: &str| ClaimEvidenceRef {
        claim: claim.into(),
        link: link.into(),
    };
    assert!(link("tide-height", "tide-height-ada").check(&set).is_ok());
    for wrong in [
        link("moon-phase", "tide-height-ada"),
        link("tide-height", "missing"),
        link("missing", "tide-height-ada"),
    ] {
        assert_eq!(
            wrong.check(&set).unwrap_err().code,
            DecisionErrorCode::UnknownClaimEvidence
        );
    }
}

#[test]
fn a_decision_never_names_a_private_claim_or_link() {
    let set = claims();
    let link = |claim: &str, link: &str| ClaimEvidenceRef {
        claim: claim.into(),
        link: link.into(),
    };
    // A private link on a published claim, and an approved link on a private claim.
    for private in [
        link("tide-height", "tide-private-link"),
        link("tide-secret", "secret-link"),
    ] {
        let error = private.check(&set).unwrap_err();
        assert_eq!(error.code, DecisionErrorCode::ClaimEvidenceNotPublished);
        assert!(!error.message.contains("secret"), "{}", error.message);
        assert!(!private.is_published_on(&set, "tides"));
    }
    let public = link("tide-height", "tide-height-ada");
    assert!(public.is_published_on(&set, "tides"));
    // The claim of another post is not published on this one.
    assert!(!public.is_published_on(&set, "other"));
}

#[test]
fn copying_a_decision_publicly_drops_an_evidence_link_that_is_not_published() {
    use openblog_core::feedback_publication::PublishedDecision;
    let set = claims();
    let decision = |claim: &str, link: &str| PublishedDecision {
        outcome: "accepted-as-evidence".into(),
        extent: Some("full".into()),
        decline_reason: None,
        rationale: None,
        revision_note: None,
        claim_evidence: Some(ClaimEvidenceRef {
            claim: claim.into(),
            link: link.into(),
        }),
        decided: "2026-10-27".into(),
        superseded: 0,
    };
    let kept =
        decision("tide-height", "tide-height-ada").with_published_evidence(Some(&set), "tides");
    assert!(kept.claim_evidence.is_some());
    for dropped in [
        decision("tide-height", "tide-private-link").with_published_evidence(Some(&set), "tides"),
        decision("tide-secret", "secret-link").with_published_evidence(Some(&set), "tides"),
        decision("tide-height", "tide-height-ada").with_published_evidence(Some(&set), "other"),
        decision("tide-height", "tide-height-ada").with_published_evidence(None, "tides"),
    ] {
        assert!(dropped.claim_evidence.is_none());
        let written = serde_json::to_string(&dropped).unwrap();
        for id in ["secret", "private-link", "tide-height-ada"] {
            assert!(!written.contains(id), "{written}");
        }
    }
}

#[test]
fn revision_links_find_their_note_in_the_post() {
    let link = RevisionLink {
        post: "posts/tides.md".into(),
        note: "2026-10-27 tide-height: Corrected the height.".into(),
    };
    let note = link.parsed().unwrap();
    assert_eq!(note.date, "2026-10-27");
    assert_eq!(note.claim.as_deref(), Some("tide-height"));
    assert!(link.found_in(&["  2026-10-27 tide-height: Corrected the height. ".into()]));
    assert!(!link.found_in(&["2026-10-27: Something else.".into()]));
    let elsewhere = RevisionLink {
        post: "../tides.md".into(),
        ..link
    };
    assert!(elsewhere.parsed().is_err());
}

#[test]
fn passage_checks_round_trip_through_their_ids() {
    use openblog_core::passage_target::StaleReason;
    for check in [
        PassageCheck::Current,
        PassageCheck::Reanchored,
        PassageCheck::UnknownWork,
        PassageCheck::Stale(StaleReason::QuoteNotFound),
        PassageCheck::Stale(StaleReason::ContextChanged),
        PassageCheck::Stale(StaleReason::Ambiguous),
        PassageCheck::Stale(StaleReason::SectionRemoved),
        PassageCheck::Stale(StaleReason::SectionChanged),
        PassageCheck::Stale(StaleReason::Unverified),
    ] {
        assert_eq!(passage_check_from_id(&passage_check_id(check)), Some(check));
    }
    assert_eq!(passage_check_from_id("stale"), None);
    assert_eq!(passage_check_from_id("stale:moved"), None);
}

#[test]
fn kinds_and_roles_are_the_participation_policys() {
    // The evidence kinds are RD12's registry rows and the deciders RD12's
    // roles, resolved by its one resolver and granted by its approve row.
    assert_eq!(
        EVIDENCE_KINDS.map(ParticipationKind::id),
        ["source-suggestion", "correction-suggestion"]
    );
    for kind in ParticipationKind::ALL {
        assert_eq!(
            is_evidence_kind(kind),
            EVIDENCE_KINDS.contains(&kind),
            "{}",
            kind.id()
        );
    }
    assert!(!is_evidence_kind(ParticipationKind::Question));
    assert!(!is_evidence_kind(ParticipationKind::AuthorResponse));
    let stored = json!({"kind": "correction-suggestion", "state": "pending", "revision": 1});
    let item = item_facts("11111111-1111-4111-8111-111111111111", &stored);
    let deciders: Vec<&str> = ActorRole::ALL
        .into_iter()
        .filter(|role| {
            openblog_core::moderation::may_decide(&actor(role.id(), Some("grace")), &item)
        })
        .map(ActorRole::id)
        .collect();
    assert_eq!(deciders, ["site-admin", "coordinator"]);
    // A coordinator decides only on its own publication's works.
    let elsewhere = ItemFacts {
        work: Some("/posts/other/"),
        ..item
    };
    assert!(!openblog_core::moderation::may_decide(
        &actor("coordinator", Some("grace")),
        &elsewhere
    ));
    assert!(openblog_core::moderation::may_decide(
        &actor("site-admin", Some("grace")),
        &elsewhere
    ));
    // A decision reason never reuses a moderation reason's meaning: there is
    // no spam, abuse, personal-data or duplicate ground among them.
    for reason in DeclineReason::ALL {
        assert!(![
            "spam",
            "abusive",
            "personal-data",
            "off-topic",
            "duplicate",
            "rights"
        ]
        .contains(&reason.id()));
    }
}

/// `jsonb::text`, written here and not borrowed from the reader: a space
/// after every `:` and `,`.
fn jsonb_text(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(jsonb_text).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(object) => format!(
            "{{{}}}",
            object
                .iter()
                .map(|(key, item)| format!("{}: {}", Value::String(key.clone()), jsonb_text(item)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        other => other.to_string(),
    }
}

#[test]
fn every_accepted_block_fits_the_hosted_stores_check() {
    // supabase/feedback.sql checks octet_length(evidence::text) <= 4096.
    let id = "a".repeat(64);
    let (mut largest, mut refused) = (0, 0);
    for width in [1, 16, 32, 48, 64] {
        for count in [1, 4, 8] {
            for text in ["é".repeat(width), "\u{1D49C}".repeat(width)] {
                let locators: Vec<Value> = (0..count)
                    .map(|_| json!({"kind": format!("x-{}", "b".repeat(62)), "value": text, "to": text}))
                    .collect();
                let submission = json!({
                    "version": 2, "kind": "source-suggestion", "work": "/posts/x/",
                    "revision": format!("p1:{}", "0".repeat(32)),
                    "target": {"version": 1, "kind": "work"}, "body": "hi",
                    "details": {"sourceUrl": "https://example.org/"},
                    "evidence": {"claim": id, "evidenceLink": id, "citation": id, "source": id, "locators": locators, "stance": "supports"},
                });
                match EvidenceSubmission::from_value(&submission) {
                    Ok(read) => {
                        largest = largest.max(jsonb_text(&read.evidence.unwrap().to_value()).len());
                    }
                    Err(error) => {
                        assert_eq!(code_name(error.code), "evidenceTooLarge", "{width}x{count}");
                        refused += 1;
                    }
                }
            }
        }
    }
    assert!(refused > 0);
    assert!(
        largest > 2000 && largest <= 4096,
        "largest accepted block is {largest} octets"
    );
}
