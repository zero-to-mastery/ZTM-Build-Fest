//! Third Perspective contracts (ADRs 0109 to 0112): response categories,
//! the four distinct stages, consent records, the lifecycle on the one
//! moderation state machine, and the one public projection.

use openblog_core::participation::{ParticipationKind, ParticipationMode};
use openblog_core::third_perspective::{
    ApprovalRequest, ConsentChange, ConsentChoices, ConsentOutcome, ErrorCode, FeatureChange,
    Intake, LifecycleError, LocalReflection, ModerationFacts, ModerationState, PerspectiveTarget,
    PublishedWork, ReaderAttribution, ResponseCategory, Stage, SubmissionRequest, SubmittedCopy,
    TargetStatus, KIND, MAX_BODY_CHARS, MAX_CONSENT_RECORDS, MAX_DETAILS_BYTES, MAX_JSON_BYTES,
    NARROWING_RESERVE, READER_ROLE,
};
use openblog_core::DateTime;
use serde_json::{json, Value};

const REV_A: &str = "p1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REV_B: &str = "p1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST: &str = "0123456789abcdef0123456789abcdef";

fn receipt() -> String {
    "5e".repeat(32)
}

fn time(value: &str) -> DateTime {
    DateTime::parse(value).expect("test time")
}

fn received() -> DateTime {
    time("2026-10-26T10:00:00Z")
}

fn hosted() -> Intake {
    Intake::Hosted {
        receipt_digest: receipt(),
    }
}

fn local(attribution: ReaderAttribution) -> LocalReflection {
    LocalReflection {
        work: "/posts/tides/".into(),
        revision: REV_A.into(),
        target: PerspectiveTarget::work(),
        category: None,
        body: "Another way to read the ending.".into(),
        attribution,
        seen_at: None,
    }
}

/// Whether a reflection could be featured at `revision`: the one projection
/// shows it, that is its approved revision, and the reader's consent in effect
/// agrees to feature exactly it. The editorial act itself is
/// `community_feature::FeatureRecord::new`, which adds who may choose, the
/// published file and the note.
fn featurable(
    copy: &SubmittedCopy,
    facts: &ModerationFacts,
    mode: ParticipationMode,
    work: &PublishedWork,
    target: &TargetStatus,
    revision: u32,
) -> bool {
    copy.approved_response(facts, mode, work, target).is_some()
        && facts.approved_revision == Some(revision)
        && copy.feature_covers(revision)
}

fn consent(clarification: bool, feature: bool) -> ConsentChoices {
    ConsentChoices {
        publish: true,
        clarification,
        feature,
    }
}

fn submitted(attribution: ReaderAttribution) -> SubmittedCopy {
    local(attribution)
        .submission(consent(true, false))
        .receive(received(), hosted())
        .expect("a valid submission")
}

fn facts(state: ModerationState) -> ModerationFacts {
    let approved = state == ModerationState::Approved;
    ModerationFacts {
        state,
        revision: 1,
        approved_revision: approved.then_some(1),
        approved_consent: approved.then_some(1),
        clarification_asked: None,
        content_retained: true,
    }
}

fn approved_at(revision: u32, consent: u32) -> ModerationFacts {
    ModerationFacts {
        state: ModerationState::Approved,
        revision,
        approved_revision: Some(revision),
        approved_consent: Some(consent),
        clarification_asked: None,
        content_retained: true,
    }
}

fn tides() -> PublishedWork {
    PublishedWork {
        path: "/posts/tides/".into(),
        revision: REV_A.into(),
        credited: vec!["Ada Lovelace".into(), "Grace Hopper".into()],
    }
}

fn whole() -> TargetStatus {
    TargetStatus::Current { section: None }
}

fn change(publish: bool, attribution: ReaderAttribution) -> ConsentChange {
    ConsentChange {
        publish,
        attribution,
        clarification: true,
        feature: FeatureChange::Decline,
    }
}

fn request_json(overrides: Value) -> String {
    let mut request = json!({
        "version": 1,
        "kind": "third-perspective",
        "work": "/posts/tides/",
        "revision": REV_A,
        "target": {"version": 1, "kind": "work"},
        "body": "Another way to read the ending.",
        "consent": {"publish": true}
    });
    for (key, value) in overrides.as_object().expect("overrides object") {
        if value.is_null() {
            request.as_object_mut().unwrap().remove(key);
        } else {
            request[key] = value.clone();
        }
    }
    request.to_string()
}

fn request_error(overrides: Value) -> ErrorCode {
    match SubmissionRequest::from_json(&request_json(overrides)) {
        Ok(request) => {
            request
                .receive(received(), hosted())
                .expect_err("the request is refused")
                .code
        }
        Err(error) => error.code,
    }
}

// ---------------------------------------------------------------------------
// State fixtures

fn fixture_facts(value: &Value) -> ModerationFacts {
    let number = |key: &str| value[key].as_u64().map(|n| n as u32);
    ModerationFacts {
        state: ModerationState::from_id(value["state"].as_str().unwrap()).expect("state id"),
        revision: number("revision").unwrap(),
        approved_revision: number("approvedRevision"),
        approved_consent: number("approvedConsent"),
        clarification_asked: number("clarificationAsked"),
        content_retained: value["contentRetained"].as_bool().unwrap(),
    }
}

fn fixture_work(value: Option<&Value>) -> PublishedWork {
    match value {
        None => tides(),
        Some(value) => PublishedWork {
            path: value["path"].as_str().unwrap().into(),
            revision: value["revision"].as_str().unwrap().into(),
            credited: value["credited"]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap().to_string())
                .collect(),
        },
    }
}

fn fixture_target(value: Option<&Value>, record: &Value) -> TargetStatus {
    match value {
        None => TargetStatus::Current {
            section: record["provenance"]["target"]["section"]
                .as_str()
                .map(str::to_string),
        },
        Some(value) => match value["state"].as_str().unwrap() {
            "current" => TargetStatus::Current {
                section: value["section"].as_str().map(str::to_string),
            },
            "stale" => TargetStatus::Stale {
                section_present: value["sectionPresent"].as_bool().unwrap(),
            },
            other => panic!("unknown target state {other}"),
        },
    }
}

#[test]
fn state_fixtures_give_each_copy_its_stage_and_only_its_public_form() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/third-perspective-states.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 30);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let record = &case["record"];
        let copy = SubmittedCopy::from_json(&record.to_string())
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let canonical: Value = serde_json::from_str(&copy.to_json()).unwrap();
        assert_eq!(&canonical, record, "{name}: the record is canonical");

        let facts = fixture_facts(&case["moderation"]);
        // `shown` is whether the kind's effective mode shows approved items;
        // `mode` names the mode itself.
        let mode = match (
            case.get("mode").and_then(Value::as_str),
            case.get("shown").and_then(Value::as_bool),
        ) {
            (Some(mode), _) => ParticipationMode::from_id(mode).expect("mode id"),
            (None, Some(false)) => ParticipationMode::Hidden,
            (None, _) => ParticipationMode::Open,
        };
        assert_eq!(
            mode.shows_approved(),
            case.get("shown")
                .and_then(Value::as_bool)
                .unwrap_or(mode.shows_approved()),
            "{name}: `shown` agrees with `mode`"
        );
        let work = fixture_work(case.get("work"));
        let target = fixture_target(case.get("target"), record);
        let expect = &case["expect"];

        assert_eq!(
            Stage::of(&facts).id(),
            expect["stage"].as_str().unwrap(),
            "{name}: stage"
        );
        let public = copy.approved_response(&facts, mode, &work, &target);
        let public_json = public
            .as_ref()
            .map(|response| serde_json::from_str::<Value>(&response.to_json()).unwrap())
            .unwrap_or(Value::Null);
        assert_eq!(public_json, expect["public"], "{name}: public projection");

        if let Some(response) = &public {
            assert_eq!(response.role, READER_ROLE, "{name}: always a reader");
            let text = response.to_json();
            for private in [
                receipt().as_str(),
                "mikey",
                "09:41",
                "seenAt",
                "receivedAt",
                "consents",
                "intake",
                "revision\"",
                "publishName",
                "hosted",
                "manual",
            ] {
                assert!(!text.contains(private), "{name}: `{private}` is private");
            }
            for credit in &work.credited {
                assert!(
                    !text.contains(credit.as_str()),
                    "{name}: never an author's name"
                );
                assert!(!response.heading().contains(credit.as_str()));
            }
            let private_name = copy.consent().attribution.name.clone();
            if response.name.is_none() {
                if let Some(private_name) = private_name {
                    assert!(!text.contains(&private_name), "{name}: unpublished name");
                }
            }
        }

        if let Some(feature) = case.get("feature") {
            let revision = feature["revision"].as_u64().unwrap() as u32;
            let featurable = featurable(&copy, &facts, mode, &work, &target, revision);
            assert_eq!(
                featurable,
                expect["featured"].as_bool().unwrap(),
                "{name}: featured"
            );
        }
        if let Some(matches) = expect.get("nameMatchesCredit") {
            assert_eq!(
                copy.name_matches_credit(&work.credited),
                matches.as_bool().unwrap(),
                "{name}: moderation hint"
            );
        }
    }
}

#[test]
fn state_fixtures_cover_every_required_situation() {
    let fixture = include_str!("fixtures/third-perspective-states.json");
    for situation in [
        "withdrawal",
        "revised consent",
        "deleted",
        "rejected content",
        "stale article",
        "group-authored work",
    ] {
        assert!(fixture.contains(situation), "a fixture covers {situation}");
    }
}

// ---------------------------------------------------------------------------
// Response categories

#[test]
fn categories_are_optional_descriptive_prompts_never_scores_or_sides() {
    let copy = submitted(ReaderAttribution::anonymous());
    assert_eq!(
        copy.category, None,
        "a reflection without a category is complete"
    );
    let public = copy
        .approved_response(
            &facts(ModerationState::Approved),
            ParticipationMode::Open,
            &tides(),
            &whole(),
        )
        .unwrap();
    assert!(!public.to_json().contains("category"));

    let verdicts = [
        "agree", "disagree", "correct", "wrong", "right", "better", "best", "worse", "vote",
        "score", "rating", "rank", "like", "winner", "side", "author", "true", "false", "verdict",
    ];
    for category in ResponseCategory::ALL {
        assert_eq!(ResponseCategory::from_id(category.id()), Some(category));
        for text in [category.id(), category.label(), category.prompt()] {
            let words: Vec<String> = text
                .to_lowercase()
                .split(|c: char| !c.is_alphanumeric())
                .map(str::to_string)
                .collect();
            for verdict in verdicts {
                assert!(
                    !words.iter().any(|word| word == verdict),
                    "`{text}` reads as a verdict or a side ({verdict})"
                );
            }
        }
        let request = request_json(json!({"category": category.id()}));
        let copy = SubmissionRequest::from_json(&request)
            .unwrap()
            .receive(received(), hosted())
            .unwrap();
        assert_eq!(copy.category, Some(category));
    }
    assert_eq!(
        request_error(json!({"category": "agree-with-ada"})),
        ErrorCode::UnknownCategory
    );
    assert_eq!(request_error(json!({"category": 3})), ErrorCode::Malformed);
}

// ---------------------------------------------------------------------------
// Four distinct stages

#[test]
fn local_reflection_submitted_copy_and_approved_response_are_distinct_and_consent_alone_makes_a_reflection_featurable(
) {
    let draft = local(ReaderAttribution::named("Mina Okafor", true));
    assert_eq!(draft.stage(), Stage::Local);

    let mut copy = draft
        .submission(consent(true, false))
        .receive(received(), hosted())
        .unwrap();
    let pending = facts(ModerationState::Pending);
    assert_eq!(Stage::of(&pending), Stage::Submitted);
    assert_eq!(
        copy.approved_response(&pending, ParticipationMode::Open, &tides(), &whole()),
        None,
        "a submitted copy is private"
    );

    let binding = copy
        .check_approval(
            &pending,
            &ApprovalRequest {
                moderator: "mikey",
                seen_revision: 1,
                seen_consent: 1,
                at: time("2026-10-26T12:00:00Z"),
            },
        )
        .unwrap();
    assert_eq!((binding.revision, binding.consent), (1, 1));
    assert_eq!(binding.approved_by, "mikey");

    let approved = approved_at(binding.revision, binding.consent);
    let response = copy
        .approved_response(&approved, ParticipationMode::Open, &tides(), &whole())
        .expect("an approved response");
    assert_eq!(response.name.as_deref(), Some("Mina Okafor"));
    assert_eq!(
        response.heading(),
        "Third Perspective from Mina Okafor, a reader"
    );

    assert!(
        !featurable(
            &copy,
            &approved,
            ParticipationMode::Open,
            &tides(),
            &whole(),
            1
        ),
        "approval alone never features a reflection"
    );
    let outcome = copy
        .revise_consent(
            &approved,
            ConsentChange {
                feature: FeatureChange::Agree { revision_seen: 1 },
                ..change(true, ReaderAttribution::named("Mina Okafor", true))
            },
            time("2026-10-27T08:00:00Z"),
        )
        .unwrap();
    assert_eq!(outcome, ConsentOutcome::Recorded);
    assert_eq!(copy.consent().feature_revision, Some(1));
    assert!(
        featurable(
            &copy,
            &approved,
            ParticipationMode::Open,
            &tides(),
            &whole(),
            1
        ),
        "featurable with consent for the approved revision"
    );
    assert!(!featurable(
        &copy,
        &approved,
        ParticipationMode::Open,
        &tides(),
        &whole(),
        2
    ));
}

// ---------------------------------------------------------------------------
// Anonymous display, never anonymous provenance

#[test]
fn anonymous_display_keeps_full_moderation_provenance() {
    let copy = submitted(ReaderAttribution::anonymous());
    let record: Value = serde_json::from_str(&copy.to_json()).unwrap();
    assert_eq!(record["intake"]["receiptDigest"], json!(receipt()));
    assert_eq!(record["provenance"]["channel"], json!("hosted"));
    assert_eq!(
        record["provenance"]["receivedAt"],
        json!("2026-10-26T10:00:00Z")
    );
    assert_eq!(record["provenance"]["revision"], json!(REV_A));

    let public = copy
        .approved_response(
            &facts(ModerationState::Approved),
            ParticipationMode::Open,
            &tides(),
            &whole(),
        )
        .unwrap();
    assert_eq!(public.name, None);
    assert_eq!(public.heading(), "Third Perspective from a reader");
    assert!(!public.to_json().contains(&receipt()));

    let manual = local(ReaderAttribution::anonymous())
        .submission(consent(false, false))
        .receive(
            received(),
            Intake::Manual {
                entered_by: "mikey".into(),
            },
        )
        .unwrap();
    assert!(manual.to_json().contains("\"enteredBy\":\"mikey\""));
    assert!(manual.to_json().contains("\"channel\":\"manual\""));
}

#[test]
fn a_copy_without_provenance_of_who_can_act_for_it_is_refused() {
    let record: Value =
        serde_json::from_str(&submitted(ReaderAttribution::anonymous()).to_json()).unwrap();
    let refused = |edit: &dyn Fn(&mut Value)| {
        let mut record = record.clone();
        edit(&mut record);
        SubmittedCopy::from_json(&record.to_string())
            .expect_err("refused")
            .code
    };
    assert_eq!(
        refused(&|r| {
            r.as_object_mut().unwrap().remove("intake");
        }),
        ErrorCode::Malformed
    );
    assert_eq!(
        refused(&|r| r["intake"] = json!({})),
        ErrorCode::InvalidIntake
    );
    assert_eq!(
        refused(&|r| r["intake"] = json!({"receiptDigest": receipt(), "enteredBy": "mikey"})),
        ErrorCode::InvalidIntake
    );
    assert_eq!(
        refused(&|r| r["intake"] = json!({"receiptDigest": "not-a-digest"})),
        ErrorCode::InvalidIntake
    );
    assert_eq!(
        refused(&|r| r["intake"] = json!({"enteredBy": "mikey"})),
        ErrorCode::InvalidIntake,
        "a manual intake on a hosted copy"
    );
    assert_eq!(
        refused(&|r| {
            r["intake"] = json!({"enteredBy": "Not An Admin"});
            r["provenance"]["channel"] = json!("manual");
        }),
        ErrorCode::InvalidIntake
    );
    assert_eq!(
        refused(&|r| r["intake"]["receiptToken"] = json!("secret")),
        ErrorCode::Malformed,
        "no other identity rides along"
    );
    assert_eq!(
        refused(&|r| r["provenance"]["email"] = json!("reader@example.com")),
        ErrorCode::Malformed
    );
}

#[test]
fn every_approval_names_its_moderator() {
    let copy = submitted(ReaderAttribution::anonymous());
    let pending = facts(ModerationState::Pending);
    for moderator in ["", " ", "two words", "tab\there"] {
        assert_eq!(
            copy.check_approval(
                &pending,
                &ApprovalRequest {
                    moderator,
                    seen_revision: 1,
                    seen_consent: 1,
                    at: received(),
                },
            ),
            Err(LifecycleError::AnonymousModerator)
        );
    }
}

// ---------------------------------------------------------------------------
// Submission format and content limits

#[test]
fn submissions_are_bounded_plain_text_with_consent_to_publish() {
    let copy = SubmissionRequest::from_json(&request_json(json!({
        "body": "  First line.\r\n\r\nSecond\rline.\t  ",
        "attribution": {"name": "  Mina   Okafor ", "publishName": true},
        "seenAt": "2026-10-26T11:00:00Z",
        "consent": {"publish": true, "clarification": true}
    })))
    .unwrap()
    .receive(received(), hosted())
    .unwrap();
    assert_eq!(copy.body, "First line.\n\nSecond\nline.");
    assert_eq!(
        copy.consent().attribution.name.as_deref(),
        Some("Mina Okafor")
    );
    assert_eq!(
        copy.provenance.seen_at, None,
        "a reader clock ahead is dropped"
    );
    assert!(copy.consent().clarification);
    assert_eq!(copy.consent().feature_revision, None);

    let long = "a".repeat(MAX_BODY_CHARS + 1);
    let longest = "é".repeat(MAX_BODY_CHARS);
    assert!(
        SubmissionRequest::from_json(&request_json(json!({"body": longest})))
            .unwrap()
            .receive(received(), hosted())
            .is_ok()
    );
    assert_eq!(request_error(json!({"body": long})), ErrorCode::InvalidBody);
    assert_eq!(
        request_error(json!({"body": " \n "})),
        ErrorCode::InvalidBody
    );
    assert_eq!(
        request_error(json!({"body": "bell\u{7}"})),
        ErrorCode::InvalidBody
    );
    assert_eq!(
        request_error(json!({"body": "flip\u{202e}"})),
        ErrorCode::InvalidBody
    );
    assert_eq!(
        request_error(json!({"attribution": {"name": "x".repeat(81), "publishName": true}})),
        ErrorCode::InvalidName
    );
    assert_eq!(
        request_error(json!({"attribution": {"publishName": true}})),
        ErrorCode::ConsentWithoutName
    );
    assert_eq!(
        request_error(json!({"consent": {"publish": false}})),
        ErrorCode::PublicationConsentRequired
    );
    assert_eq!(request_error(json!({"consent": {}})), ErrorCode::Malformed);
    assert_eq!(
        request_error(json!({"consent": null})),
        ErrorCode::Malformed
    );
    assert_eq!(request_error(json!({"vote": "ada"})), ErrorCode::Malformed);
    assert_eq!(request_error(json!({"rating": 5})), ErrorCode::Malformed);
    assert_eq!(
        request_error(json!({"kind": "comment"})),
        ErrorCode::WrongKind
    );
    assert_eq!(
        request_error(json!({"version": 2})),
        ErrorCode::UnsupportedVersion
    );
    assert_eq!(
        request_error(json!({"work": "posts/tides"})),
        ErrorCode::InvalidWork
    );
    assert_eq!(
        request_error(json!({"revision": "r1"})),
        ErrorCode::InvalidRevision
    );
    assert_eq!(
        request_error(json!({"seenAt": "yesterday"})),
        ErrorCode::InvalidTime
    );
    assert_eq!(
        SubmissionRequest::from_json(&"x".repeat(40 * 1024))
            .unwrap_err()
            .code,
        ErrorCode::TooLarge
    );

    let request = SubmissionRequest::from_json(&request_json(json!({
        "category": "question",
        "target": {"version": 1, "kind": "section", "section": "methods", "digest": DIGEST},
        "consent": {"publish": true, "clarification": false, "feature": true}
    })))
    .unwrap();
    assert_eq!(
        SubmissionRequest::from_json(&request.to_json()).unwrap(),
        request
    );
    let copy = request.receive(received(), hosted()).unwrap();
    assert_eq!(copy.consent().feature_revision, Some(1));
}

#[test]
fn targets_use_the_passage_target_json_restricted_to_the_work_or_a_section() {
    let read = |value: Value| PerspectiveTarget::from_value(&value);
    let work = read(json!({"version": 1, "kind": "work"})).unwrap();
    assert_eq!(work, PerspectiveTarget::work());
    assert!(work.is_work());
    assert_eq!(work.to_json(), r#"{"version":1,"kind":"work"}"#);
    let section =
        read(json!({"version": 1, "kind": "section", "section": "methods", "digest": DIGEST}))
            .unwrap();
    assert_eq!(
        section.to_json(),
        format!(r#"{{"version":1,"kind":"section","section":"methods","digest":"{DIGEST}"}}"#)
    );
    let opening = read(json!({"version": 1, "kind": "section"})).unwrap();
    assert_eq!(
        opening,
        PerspectiveTarget::section(None, None),
        "the text before the first heading"
    );

    let code = |value: Value| read(value).unwrap_err().code;
    assert_eq!(
        code(
            json!({"version": 1, "kind": "quote", "section": "methods", "exact": "tides", "prefix": "", "suffix": "", "start": 0})
        ),
        ErrorCode::TargetNotAllowed
    );
    assert_eq!(
        code(json!({"version": 1, "kind": "work", "section": "methods"})),
        ErrorCode::InvalidTarget
    );
    assert_eq!(
        code(json!({"version": 1, "kind": "section", "exact": "tides"})),
        ErrorCode::InvalidTarget
    );
    assert_eq!(
        code(json!({"version": 1, "kind": "section", "digest": "ABC"})),
        ErrorCode::InvalidTarget
    );
    assert_eq!(
        code(json!({"version": 1, "kind": "section", "section": "two words"})),
        ErrorCode::InvalidTarget
    );
    assert_eq!(
        code(json!({"version": 1, "kind": "section", "section": "x".repeat(201)})),
        ErrorCode::InvalidTarget
    );
    assert_eq!(
        code(json!({"version": 1, "kind": "work", "note": "x"})),
        ErrorCode::InvalidTarget
    );
    assert_eq!(
        code(json!({"version": 2, "kind": "work"})),
        ErrorCode::UnsupportedVersion
    );
    assert_eq!(code(json!({"kind": "work"})), ErrorCode::InvalidTarget);
    assert_eq!(code(json!("work")), ErrorCode::InvalidTarget);
}

// ---------------------------------------------------------------------------
// Consent records and the lifecycle

#[test]
fn narrowing_consent_takes_effect_at_once_and_widening_waits_for_a_decision() {
    let mut copy = submitted(ReaderAttribution::named("Mina Okafor", true));
    let approved = facts(ModerationState::Approved);
    let later = time("2026-10-27T08:00:00Z");

    let outcome = copy
        .revise_consent(
            &approved,
            change(true, ReaderAttribution::named("Mina Okafor", false)),
            later,
        )
        .unwrap();
    assert_eq!(outcome, ConsentOutcome::Recorded);
    assert_eq!(copy.consent().number, 2);
    let public = copy
        .approved_response(&approved, ParticipationMode::Open, &tides(), &whole())
        .unwrap();
    assert_eq!(public.name, None, "hiding a name applies at once");

    assert_eq!(
        copy.revise_consent(
            &approved,
            change(true, ReaderAttribution::named("Mina Okafor", true)),
            later
        ),
        Err(LifecycleError::WideningAfterDecision)
    );
    assert_eq!(
        copy.revise_consent(
            &approved,
            change(true, ReaderAttribution::named("Mina Okafor", false)),
            later
        ),
        Err(LifecycleError::Unchanged)
    );
    assert_eq!(
        copy.revise_consent(
            &approved,
            change(true, ReaderAttribution::named("Mina Okafor", false)),
            received()
        ),
        Err(LifecycleError::InvalidTime)
    );
    for state in [ModerationState::Rejected, ModerationState::Removed] {
        assert_eq!(
            copy.clone().revise_consent(
                &facts(state),
                change(true, ReaderAttribution::named("Mina Okafor", true)),
                later
            ),
            Err(LifecycleError::WideningAfterDecision)
        );
    }
    assert!(SubmittedCopy::from_json(&copy.to_json()).is_ok());
}

#[test]
fn consent_revised_before_a_decision_binds_into_the_approval() {
    let mut copy = submitted(ReaderAttribution::named("Mina Okafor", false));
    let pending = facts(ModerationState::Pending);
    copy.revise_consent(
        &pending,
        change(true, ReaderAttribution::named("Mina Okafor", true)),
        time("2026-10-26T11:00:00Z"),
    )
    .unwrap();
    let request = |seen_revision, seen_consent| ApprovalRequest {
        moderator: "mikey",
        seen_revision,
        seen_consent,
        at: time("2026-10-26T12:00:00Z"),
    };
    assert_eq!(
        copy.check_approval(&pending, &request(1, 1)),
        Err(LifecycleError::StaleConsent),
        "a moderator who saw the earlier consent must look again"
    );
    let binding = copy.check_approval(&pending, &request(1, 2)).unwrap();
    assert_eq!(binding.consent, 2);
    let public = copy
        .approved_response(
            &approved_at(1, 2),
            ParticipationMode::Open,
            &tides(),
            &whole(),
        )
        .unwrap();
    assert_eq!(public.name.as_deref(), Some("Mina Okafor"));
    let public = copy
        .approved_response(
            &approved_at(1, 1),
            ParticipationMode::Open,
            &tides(),
            &whole(),
        )
        .unwrap();
    assert_eq!(
        public.name, None,
        "the name was not part of what was approved"
    );
}

#[test]
fn revoking_publication_is_a_final_withdrawal() {
    let later = time("2026-10-27T08:00:00Z");
    for state in [
        ModerationState::Pending,
        ModerationState::Clarification,
        ModerationState::Approved,
    ] {
        let mut copy = submitted(ReaderAttribution::named("Mina Okafor", true));
        assert_eq!(
            copy.revise_consent(
                &facts(state),
                change(false, ReaderAttribution::anonymous()),
                later
            ),
            Ok(ConsentOutcome::Withdraw)
        );
        let revoked = copy.consent();
        assert!(!revoked.publish && !revoked.attribution.publish_name);
        assert_eq!(revoked.attribution.name.as_deref(), Some("Mina Okafor"));
        assert_eq!(
            copy.approved_response(&facts(state), ParticipationMode::Open, &tides(), &whole()),
            None
        );
        assert_eq!(
            copy.revise_consent(
                &facts(state),
                change(true, ReaderAttribution::anonymous()),
                later
            ),
            Err(LifecycleError::Closed),
            "never un-revoked"
        );
        assert!(SubmittedCopy::from_json(&copy.to_json()).is_ok());
    }

    let mut rejected = submitted(ReaderAttribution::anonymous());
    assert_eq!(
        rejected.revise_consent(
            &facts(ModerationState::Rejected),
            change(false, ReaderAttribution::anonymous()),
            later
        ),
        Ok(ConsentOutcome::Recorded),
        "no withdrawal applies to rejected content, but it can never be approved again"
    );
    assert_eq!(
        rejected.check_approval(
            &facts(ModerationState::Pending),
            &ApprovalRequest {
                moderator: "mikey",
                seen_revision: 1,
                seen_consent: 2,
                at: later,
            },
        ),
        Err(LifecycleError::PublicationNotConsented),
        "reopened after revocation"
    );

    let mut withdrawn = submitted(ReaderAttribution::anonymous());
    assert_eq!(
        withdrawn.revise_consent(
            &facts(ModerationState::Withdrawn),
            change(true, ReaderAttribution::anonymous()),
            later
        ),
        Err(LifecycleError::Closed)
    );
    let purged = ModerationFacts {
        content_retained: false,
        ..facts(ModerationState::Removed)
    };
    assert_eq!(
        withdrawn.revise_consent(
            &purged,
            change(false, ReaderAttribution::anonymous()),
            later
        ),
        Err(LifecycleError::ContentPurged),
        "deleted text has no consent left to change"
    );
}

fn manual_copy() -> SubmittedCopy {
    local(ReaderAttribution::named("Mina Okafor", true))
        .submission(consent(true, false))
        .receive(
            received(),
            Intake::Manual {
                entered_by: "mikey".into(),
            },
        )
        .unwrap()
}

#[test]
fn a_manual_copy_is_revoked_by_an_admin_removal_and_purge_and_cannot_be_clarified() {
    let later = time("2026-10-27T08:00:00Z");
    for state in [
        ModerationState::Pending,
        ModerationState::Clarification,
        ModerationState::Approved,
    ] {
        let mut copy = manual_copy();
        assert!(!copy.can_clarify());
        assert_eq!(
            copy.revise_consent(
                &facts(state),
                change(false, ReaderAttribution::anonymous()),
                later
            ),
            Ok(ConsentOutcome::RemoveAndPurge),
            "{state:?}: no submitter exists for RD12's withdraw"
        );
        assert!(!copy.consent().publish, "the consent change is recorded");
        assert_eq!(copy.consent().number, 2);
        assert_eq!(
            copy.approved_response(&facts(state), ParticipationMode::Open, &tides(), &whole()),
            None
        );
        assert!(SubmittedCopy::from_json(&copy.to_json()).is_ok());
    }
    for state in [ModerationState::Rejected, ModerationState::Removed] {
        assert_eq!(
            manual_copy().revise_consent(
                &facts(state),
                change(false, ReaderAttribution::anonymous()),
                later
            ),
            Ok(ConsentOutcome::Recorded)
        );
    }

    let mut copy = manual_copy();
    assert_eq!(
        copy.clarify(
            &facts(ModerationState::Clarification),
            "A clearer reading of the ending.",
            later
        ),
        Err(LifecycleError::ClarificationUnavailable)
    );
    assert_eq!(copy.revision, 1, "nothing changed");
    assert_eq!(
        LifecycleError::ClarificationUnavailable.code(),
        "clarificationUnavailable"
    );

    // Narrowing a manual copy is still an ordinary recorded change.
    assert_eq!(
        manual_copy().revise_consent(
            &facts(ModerationState::Approved),
            change(true, ReaderAttribution::named("Mina Okafor", false)),
            later
        ),
        Ok(ConsentOutcome::Recorded)
    );
}

#[test]
fn a_name_that_only_looks_like_a_credit_is_never_shown() {
    let work = |credited: &str| PublishedWork {
        credited: vec![credited.into()],
        ..tides()
    };
    let shown = |name: &str, credited: &str| {
        submitted(ReaderAttribution::named(name, true))
            .approved_response(
                &facts(ModerationState::Approved),
                ParticipationMode::Open,
                &work(credited),
                &whole(),
            )
            .unwrap()
            .name
    };
    for name in [
        "Ada Lovelace",
        "ada   lovelace",
        "Ada\u{200B} Lovelace",
        "\u{2060}Ada Lovelace",
        "Ada Love\u{00AD}lace",
        "Ada Lovelace\u{FE0F}",
        "A\u{0301}da Lovelace",
    ] {
        assert_eq!(
            shown(name, "Ada Lovelace"),
            None,
            "{name:?} imitates a credit"
        );
    }
    // Precomposed and decomposed spellings of one name meet, either way round.
    for (name, credited) in [
        ("Jose\u{0301} Marti\u{0301}", "José Martí"),
        ("José Martí", "Jose\u{0301} Marti\u{0301}"),
        ("José\u{200B} Martí", "José Martí"),
    ] {
        assert_eq!(
            shown(name, credited),
            None,
            "{name:?} imitates {credited:?}"
        );
        assert!(submitted(ReaderAttribution::named(name, true))
            .name_matches_credit(&[credited.to_string()]));
    }
    // A different person keeps their name.
    assert_eq!(
        shown("Ada Lovelace-Smith", "Ada Lovelace").as_deref(),
        Some("Ada Lovelace-Smith")
    );
    assert_eq!(
        shown("José Marte", "José Martí").as_deref(),
        Some("José Marte")
    );
}

#[test]
fn feature_consent_binds_to_one_approved_revision() {
    let later = time("2026-10-27T08:00:00Z");
    let agree = |revision_seen| ConsentChange {
        feature: FeatureChange::Agree { revision_seen },
        ..change(true, ReaderAttribution::anonymous())
    };
    let feature = agree(1);
    let mut copy = submitted(ReaderAttribution::anonymous());
    assert_eq!(
        copy.revise_consent(&facts(ModerationState::Rejected), feature.clone(), later),
        Err(LifecycleError::FeatureNotAvailable)
    );
    copy.revise_consent(&facts(ModerationState::Pending), feature.clone(), later)
        .unwrap();
    assert_eq!(copy.consent().feature_revision, Some(1));

    // A clarification replaces the text: the old feature consent does not
    // cover the new revision until the reader renews it.
    let clarification = facts(ModerationState::Clarification);
    let revision = copy
        .clarify(&clarification, "A clearer reading of the ending.", later)
        .unwrap();
    assert_eq!(revision, 2);
    let approved = approved_at(2, 2);
    let can = |mode, copy: &SubmittedCopy| featurable(copy, &approved, mode, &tides(), &whole(), 2);
    assert!(!can(ParticipationMode::Open, &copy));
    copy.revise_consent(&approved, agree(2), time("2026-10-28T08:00:00Z"))
        .unwrap();
    assert_eq!(copy.consent().feature_revision, Some(2));
    assert!(can(ParticipationMode::Open, &copy));
    assert!(
        !can(ParticipationMode::Hidden, &copy),
        "never featured while the kind is hidden"
    );
}

#[test]
fn a_clarification_replaces_the_text_and_only_the_answer_can_be_approved() {
    let mut copy = submitted(ReaderAttribution::anonymous());
    let later = time("2026-10-27T08:00:00Z");
    for state in [
        ModerationState::Pending,
        ModerationState::Approved,
        ModerationState::Rejected,
    ] {
        assert_eq!(
            copy.clone().clarify(&facts(state), "New text.", later),
            Err(LifecycleError::NotInClarification)
        );
    }
    let clarification = facts(ModerationState::Clarification);
    assert_eq!(
        copy.clone().clarify(&clarification, "  ", later),
        Err(LifecycleError::InvalidBody)
    );
    assert_eq!(
        copy.clone()
            .clarify(&clarification, "New text.", time("2026-10-25T08:00:00Z")),
        Err(LifecycleError::InvalidTime)
    );
    copy.clarify(&clarification, "A clearer reading of the ending.", later)
        .unwrap();
    assert_eq!(copy.revision, 2);
    assert_eq!(copy.revised_at, Some(later));
    assert_eq!(
        copy.clone().clarify(&clarification, "Again.", later),
        Err(LifecycleError::OutOfStep),
        "facts from before the answer are out of step"
    );

    let pending = ModerationFacts {
        revision: 2,
        ..facts(ModerationState::Pending)
    };
    let request = |seen_revision| ApprovalRequest {
        moderator: "mikey",
        seen_revision,
        seen_consent: 1,
        at: later,
    };
    assert_eq!(
        copy.check_approval(&pending, &request(1)),
        Err(LifecycleError::StaleRevision)
    );
    assert_eq!(
        copy.check_approval(&pending, &request(2)).unwrap().revision,
        2
    );
    assert_eq!(
        copy.check_approval(&facts(ModerationState::Clarification), &request(1)),
        Err(LifecycleError::OutOfStep)
    );
    assert_eq!(
        copy.check_approval(
            &ModerationFacts {
                revision: 2,
                ..facts(ModerationState::Clarification)
            },
            &request(2)
        ),
        Err(LifecycleError::NotPending)
    );
    let stored = SubmittedCopy::from_json(&copy.to_json()).unwrap();
    assert_eq!(stored, copy);
}

#[test]
fn consent_history_is_append_only_numbered_and_bounded() {
    let record: Value =
        serde_json::from_str(&submitted(ReaderAttribution::named("Mina Okafor", true)).to_json())
            .unwrap();
    let refused = |edit: &dyn Fn(&mut Value)| {
        let mut record = record.clone();
        edit(&mut record);
        SubmittedCopy::from_json(&record.to_string())
            .expect_err("refused")
            .code
    };
    let second = |extra: Value| {
        let mut consent = json!({
            "number": 2, "givenAt": "2026-10-27T08:00:00Z", "publish": true,
            "attribution": {"publishName": false}, "clarification": false
        });
        for (key, value) in extra.as_object().unwrap() {
            consent[key] = value.clone();
        }
        consent
    };
    assert_eq!(
        refused(&|r| r["consents"] = json!([])),
        ErrorCode::InvalidConsentHistory
    );
    assert_eq!(
        refused(&|r| r["consents"][0]["attribution"]["publishName"] = json!(false)),
        ErrorCode::InvalidConsentHistory,
        "the first record is what was received"
    );
    assert_eq!(
        refused(&|r| r["consents"][0]["givenAt"] = json!("2026-10-26T09:00:00Z")),
        ErrorCode::InvalidConsentHistory
    );
    assert_eq!(
        refused(&|r| r["consents"][0]["publish"] = json!(false)),
        ErrorCode::InvalidConsentHistory
    );
    assert_eq!(
        refused(&|r| r["consents"]
            .as_array_mut()
            .unwrap()
            .push(second(json!({"number": 3})))),
        ErrorCode::InvalidConsentHistory
    );
    assert_eq!(
        refused(&|r| r["consents"]
            .as_array_mut()
            .unwrap()
            .push(second(json!({"givenAt": "2026-10-25T08:00:00Z"})))),
        ErrorCode::InvalidConsentHistory
    );
    assert_eq!(
        refused(&|r| {
            let consents = r["consents"].as_array_mut().unwrap();
            consents.push(second(json!({"publish": false})));
            consents.push(second(json!({"number": 3})));
        }),
        ErrorCode::InvalidConsentHistory,
        "nothing follows a revocation"
    );
    assert_eq!(
        refused(&|r| r["consents"]
            .as_array_mut()
            .unwrap()
            .push(second(json!({"featureRevision": 2})))),
        ErrorCode::InvalidConsentHistory
    );
    assert_eq!(
        refused(&|r| r["consents"].as_array_mut().unwrap().push(second(
            json!({"attribution": {"name": "", "publishName": true}})
        ))),
        ErrorCode::ConsentWithoutName
    );
    assert_eq!(
        refused(&|r| r["revision"] = json!(2)),
        ErrorCode::InvalidTime
    );
    assert_eq!(refused(&|r| r["revision"] = json!(0)), ErrorCode::Malformed);
    assert_eq!(
        refused(&|r| r["body"] = json!(" padded ")),
        ErrorCode::InvalidBody
    );
    assert_eq!(
        refused(&|r| r["version"] = json!(2)),
        ErrorCode::UnsupportedVersion
    );
    assert_eq!(
        refused(&|r| r["provenance"]["version"] = json!(2)),
        ErrorCode::UnsupportedVersion
    );

    // Widening stops early enough to leave a slot to narrow and one to revoke.
    let mina = || ReaderAttribution::named("Mina Okafor", true);
    let mut copy = submitted(mina());
    let pending = facts(ModerationState::Pending);
    let widening_slots = MAX_CONSENT_RECORDS - 1 - NARROWING_RESERVE;
    for step in 0..widening_slots - 1 {
        copy.revise_consent(
            &pending,
            ConsentChange {
                clarification: step % 2 == 1,
                ..change(true, mina())
            },
            received(),
        )
        .unwrap();
    }
    assert_eq!(copy.consents.len(), widening_slots);
    assert_eq!(
        copy.revise_consent(
            &pending,
            ConsentChange {
                clarification: copy.consent().clarification,
                feature: FeatureChange::Agree { revision_seen: 1 },
                ..change(true, mina())
            },
            received()
        ),
        Err(LifecycleError::ConsentLimit),
        "a change that adds something is refused once only narrowing and revocation are left"
    );
    assert_eq!(
        copy.revise_consent(
            &pending,
            change(true, ReaderAttribution::named("M", false)),
            received()
        ),
        Err(LifecycleError::ConsentLimit),
        "so is a rename"
    );
    assert!(SubmittedCopy::from_json(&copy.to_json()).is_ok());
}

#[test]
fn narrowing_and_revoking_stay_possible_when_the_history_is_full() {
    let mina = || ReaderAttribution::named("Mina Okafor", true);
    let mut copy = submitted(mina());
    let pending = facts(ModerationState::Pending);
    let mut step = 0;
    while copy
        .revise_consent(
            &pending,
            ConsentChange {
                clarification: step % 2 == 1,
                ..change(true, mina())
            },
            received(),
        )
        .is_ok()
    {
        step += 1;
    }
    assert_eq!(
        copy.consents.len(),
        MAX_CONSENT_RECORDS - 1 - NARROWING_RESERVE
    );
    // Hiding the name and declining clarification still take effect at once.
    let hide = ReaderAttribution::named("Mina Okafor", false);
    assert_eq!(
        copy.revise_consent(
            &pending,
            ConsentChange {
                clarification: copy.consent().clarification,
                ..change(true, hide.clone())
            },
            received()
        ),
        Ok(ConsentOutcome::Recorded)
    );
    assert!(!copy.consent().attribution.publish_name);
    if copy.consent().clarification {
        assert_eq!(
            copy.revise_consent(
                &pending,
                ConsentChange {
                    clarification: false,
                    ..change(true, hide.clone())
                },
                received()
            ),
            Ok(ConsentOutcome::Recorded)
        );
    }
    assert!(!copy.consent().clarification);
    assert_eq!(
        copy.revise_consent(
            &pending,
            ConsentChange {
                clarification: false,
                feature: FeatureChange::Agree { revision_seen: 1 },
                ..change(true, hide)
            },
            received()
        ),
        Err(LifecycleError::ConsentLimit),
        "agreeing to more is not narrowing"
    );
    assert_eq!(
        copy.revise_consent(
            &pending,
            change(false, ReaderAttribution::named(&"x".repeat(200), true)),
            received()
        ),
        Ok(ConsentOutcome::Withdraw),
        "revocation is always possible, whatever else the change says"
    );
    assert!(copy.consents.len() < MAX_CONSENT_RECORDS);
    assert!(SubmittedCopy::from_json(&copy.to_json()).is_ok());

    // A hand-made history with every slot used is read, but never one that
    // leaves no slot for revocation.
    let mut full: Value = serde_json::from_str(&copy.to_json()).unwrap();
    let consents = full["consents"].as_array_mut().unwrap();
    let template = consents[0].clone();
    consents.clear();
    for number in 1..=MAX_CONSENT_RECORDS {
        let mut record = template.clone();
        record["number"] = json!(number);
        record["clarification"] = json!(number % 2 == 0);
        consents.push(record);
    }
    consents[MAX_CONSENT_RECORDS - 1]["publish"] = json!(false);
    assert!(SubmittedCopy::from_json(&full.to_string()).is_ok());
    full["consents"][MAX_CONSENT_RECORDS - 1]["publish"] = json!(true);
    assert_eq!(
        SubmittedCopy::from_json(&full.to_string())
            .unwrap_err()
            .code,
        ErrorCode::InvalidConsentHistory,
        "a history that leaves no slot for revocation is refused"
    );
}

#[test]
fn a_name_is_stored_once_and_the_worst_case_history_fits_every_bound() {
    let emoji_name = |index: usize| {
        format!(
            "{}{}",
            "\u{1F600}".repeat(79),
            char::from(97 + (index % 26) as u8)
        )
    };
    let mut local = local(ReaderAttribution::named(&emoji_name(0), false));
    local.body = "\u{1F600}".repeat(MAX_BODY_CHARS);
    let mut copy = local
        .submission(consent(true, false))
        .receive(received(), hosted())
        .unwrap();
    let pending = facts(ModerationState::Pending);

    // A name is written in a record only when it changes.
    copy.revise_consent(
        &pending,
        ConsentChange {
            clarification: false,
            ..change(true, ReaderAttribution::named(&emoji_name(0), false))
        },
        received(),
    )
    .unwrap();
    let stored: Value = serde_json::from_str(&copy.to_json()).unwrap();
    assert!(stored["consents"][0]["attribution"].get("name").is_none());
    assert!(stored["consents"][1]["attribution"].get("name").is_none());
    assert_eq!(SubmittedCopy::from_json(&copy.to_json()).unwrap(), copy);

    // Every later record renames the reader, the worst case for size.
    let mut index = 1;
    loop {
        let rename = ConsentChange {
            clarification: index % 2 == 0,
            ..change(
                true,
                ReaderAttribution::named(&emoji_name(index), index % 2 == 0),
            )
        };
        match copy.revise_consent(&pending, rename, received()) {
            Ok(_) => index += 1,
            Err(error) => {
                assert_eq!(error, LifecycleError::ConsentLimit);
                break;
            }
        }
        assert!(copy.to_json().len() <= MAX_JSON_BYTES);
        assert!(copy.details_bytes() <= MAX_DETAILS_BYTES);
    }
    assert!(copy.consents.len() > 10, "{} records", copy.consents.len());
    let stored = copy.to_json();
    assert!(stored.len() <= MAX_JSON_BYTES);
    assert!(copy.details_bytes() <= MAX_DETAILS_BYTES);
    assert_eq!(SubmittedCopy::from_json(&stored).unwrap(), copy);

    // The reserve still lets the reader narrow and then revoke, and every
    // result loads again.
    let narrowed = ConsentChange {
        clarification: false,
        ..change(true, copy.consent().attribution.clone())
    };
    let outcome = copy.revise_consent(&pending, narrowed, received());
    assert!(matches!(
        outcome,
        Ok(ConsentOutcome::Recorded) | Err(LifecycleError::Unchanged)
    ));
    assert_eq!(SubmittedCopy::from_json(&copy.to_json()).unwrap(), copy);
    assert_eq!(
        copy.revise_consent(
            &pending,
            change(false, ReaderAttribution::anonymous()),
            received()
        ),
        Ok(ConsentOutcome::Withdraw)
    );
    assert!(copy.to_json().len() <= MAX_JSON_BYTES);
    assert!(copy.details_bytes() <= MAX_DETAILS_BYTES);
    assert_eq!(SubmittedCopy::from_json(&copy.to_json()).unwrap(), copy);
}

#[test]
fn a_cleared_name_is_stored_and_read_back_as_cleared() {
    let mut copy = submitted(ReaderAttribution::named("Mina Okafor", false));
    let pending = facts(ModerationState::Pending);
    copy.revise_consent(
        &pending,
        change(true, ReaderAttribution::anonymous()),
        received(),
    )
    .unwrap();
    assert_eq!(copy.consent().attribution.name, None);
    let stored = SubmittedCopy::from_json(&copy.to_json()).unwrap();
    assert_eq!(stored, copy);
    assert_eq!(
        stored.consents[0].attribution.name.as_deref(),
        Some("Mina Okafor")
    );
}

// ---------------------------------------------------------------------------
// Merge seams

#[test]
fn ids_and_json_match_the_participation_and_passage_seams() {
    assert_eq!(KIND, ParticipationKind::ThirdPerspective);
    assert_eq!(KIND.id(), "third-perspective");
    assert_eq!(KIND.label(), "Third Perspective");
    assert_eq!(
        ModerationState::ALL.map(ModerationState::id),
        [
            "pending",
            "clarification",
            "approved",
            "rejected",
            "removed",
            "withdrawn"
        ]
    );
    for state in ModerationState::ALL {
        assert_eq!(ModerationState::from_id(state.id()), Some(state));
    }
    assert_eq!(ModerationState::from_id("published"), None);

    let record: Value =
        serde_json::from_str(&submitted(ReaderAttribution::named("Mina Okafor", false)).to_json())
            .unwrap();
    let keys =
        |value: &Value| -> Vec<String> { value.as_object().unwrap().keys().cloned().collect() };
    let mut provenance = keys(&record["provenance"]);
    provenance.sort();
    assert_eq!(
        provenance,
        [
            "attribution",
            "channel",
            "receivedAt",
            "revision",
            "target",
            "version",
            "work"
        ],
        "the provenance object is B5's feedback provenance record"
    );
    // B5 embeds the target as a serde_json value with alphabetical keys, so
    // only the parsed value is the same, not the key order.
    let anonymous: Value =
        serde_json::from_str(&submitted(ReaderAttribution::anonymous()).to_json()).unwrap();
    assert_eq!(
        anonymous["provenance"],
        json!({
            "version": 1,
            "work": "/posts/tides/",
            "revision": REV_A,
            "target": {"version": 1, "kind": "work"},
            "receivedAt": "2026-10-26T10:00:00Z",
            "channel": "hosted",
            "attribution": {"publishName": false}
        })
    );
    assert_eq!(
        record["provenance"]["attribution"],
        json!({"name": "Mina Okafor", "publishName": false})
    );
}

#[test]
fn stage_ids_follow_the_lifecycle() {
    assert_eq!(
        Stage::of(&facts(ModerationState::Pending)),
        Stage::Submitted
    );
    assert_eq!(
        Stage::of(&facts(ModerationState::Clarification)),
        Stage::Clarification
    );
    assert_eq!(
        Stage::of(&facts(ModerationState::Approved)),
        Stage::Approved
    );
    assert_eq!(
        Stage::of(&facts(ModerationState::Withdrawn)),
        Stage::Withdrawn
    );
    assert_eq!(
        Stage::of(&ModerationFacts {
            content_retained: false,
            ..facts(ModerationState::Pending)
        }),
        Stage::Deleted
    );
    assert_eq!(Stage::Local.id(), "local");
    let updated = PublishedWork {
        revision: REV_B.into(),
        ..tides()
    };
    let response = submitted(ReaderAttribution::anonymous())
        .approved_response(
            &facts(ModerationState::Approved),
            ParticipationMode::Open,
            &updated,
            &whole(),
        )
        .unwrap();
    assert!(
        response.earlier_revision,
        "read on an earlier revision of the work"
    );
}

// ---------------------------------------------------------------------------
// B5 and RD12, as ADR 0112 maps them

#[test]
fn a_perspective_target_is_a_b5_passage_target_that_refuses_quotations() {
    use openblog_core::passage_target::{PassageDocument, PassageTarget};
    let document = PassageDocument::from_sections(vec![
        (None, "The opening.".into()),
        (Some("methods".into()), "How the tides were read.".into()),
    ]);
    let work = PerspectiveTarget::try_from(document.work_target()).unwrap();
    assert!(work.is_work());
    let section = PerspectiveTarget::try_from(document.section_target(1).unwrap()).unwrap();
    assert_eq!(section.section_id(), Some("methods"));
    assert_eq!(
        PassageTarget::from(section.clone()),
        document.section_target(1).unwrap()
    );
    let quote = document.quote(1, 4, 9).unwrap();
    assert_eq!(
        PerspectiveTarget::try_from(quote).unwrap_err().code,
        ErrorCode::TargetNotAllowed
    );
    // The same JSON as B5's, field for field.
    assert_eq!(
        section.to_json(),
        document.section_target(1).unwrap().to_json()
    );
}

#[test]
fn target_status_comes_from_b5_resolution() {
    use openblog_core::passage_target::PassageDocument;
    let before = PassageDocument::from_sections(vec![
        (None, "The opening.".into()),
        (Some("methods".into()), "How the tides were read.".into()),
    ]);
    let target = before.section_target(1).unwrap();
    let current = before.resolve(&target, Some(&before.revision));
    assert_eq!(
        TargetStatus::from(&current),
        TargetStatus::Current {
            section: Some("methods".into())
        }
    );
    let moved = PassageDocument::from_sections(vec![
        (None, "The opening.".into()),
        (Some("method".into()), "How the tides were read.".into()),
    ]);
    assert_eq!(
        TargetStatus::from(&moved.resolve(&target, Some(&before.revision))),
        TargetStatus::Current {
            section: Some("method".into())
        },
        "re-anchored text is current at its new heading"
    );
    let changed = PassageDocument::from_sections(vec![
        (None, "The opening.".into()),
        (Some("methods".into()), "Entirely new text.".into()),
    ]);
    assert_eq!(
        TargetStatus::from(&changed.resolve(&target, Some(&before.revision))),
        TargetStatus::Stale {
            section_present: true
        }
    );
}

#[test]
fn moderation_facts_come_from_rd12_item_facts() {
    use openblog_core::moderation::ItemFacts;
    let item = ItemFacts {
        id: "11111111-1111-4111-8111-111111111111",
        kind: ParticipationKind::ThirdPerspective,
        work: Some("/posts/tides/"),
        parent: None,
        state: ModerationState::Approved,
        version: 3,
        revision: 1,
        approved_revision: Some(1),
        clarification_asked: None,
        clarification_consent: true,
        content_retained: true,
        state_since: received(),
    };
    assert_eq!(
        ModerationFacts::from_item(&item, Some(1)),
        facts(ModerationState::Approved)
    );
    let pending = ItemFacts {
        state: ModerationState::Pending,
        approved_revision: None,
        ..item
    };
    assert_eq!(
        ModerationFacts::from_item(&pending, Some(1)).approved_consent,
        None,
        "an approval's consent is read only while approved"
    );
}

#[test]
fn only_a_mode_that_shows_approved_items_shows_a_response_and_never_text_asked_about() {
    let copy = submitted(ReaderAttribution::anonymous());
    let approved = facts(ModerationState::Approved);
    for (mode, shown) in [
        (ParticipationMode::Open, true),
        (ParticipationMode::Locked, true),
        (ParticipationMode::Hidden, false),
    ] {
        assert_eq!(
            copy.approved_response(&approved, mode, &tides(), &whole())
                .is_some(),
            shown,
            "{}",
            mode.id()
        );
    }
    let asked = ModerationFacts {
        clarification_asked: Some(1),
        ..approved
    };
    assert!(copy
        .approved_response(&asked, ParticipationMode::Open, &tides(), &whole())
        .is_none());
}

#[test]
fn a_public_response_names_its_kind_by_the_registry_id() {
    let response = submitted(ReaderAttribution::anonymous())
        .approved_response(
            &facts(ModerationState::Approved),
            ParticipationMode::Open,
            &tides(),
            &whole(),
        )
        .unwrap();
    assert_eq!(response.kind, ParticipationKind::ThirdPerspective);
    let value: Value = serde_json::from_str(&response.to_json()).unwrap();
    assert_eq!(value["kind"], "third-perspective");
}

// ---------------------------------------------------------------------------
// The shared submission fixture (#221): the build, the browser and the hosted
// function read and receive every submission the same way.

#[test]
fn shared_submission_fixtures_read_and_receive_as_the_browser_and_function_do() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/third-perspective-submissions.json"
    ))
    .unwrap();
    let received = time(fixture["receivedAt"].as_str().unwrap());
    let digest = fixture["receiptDigest"].as_str().unwrap().to_string();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 40);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let text = case["text"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| case["request"].to_string());
        let outcome = SubmissionRequest::from_json(&text).and_then(|request| {
            request.receive(
                received,
                Intake::Hosted {
                    receipt_digest: digest.clone(),
                },
            )
        });
        let expect = &case["expect"];
        match (outcome, expect.get("record")) {
            (Ok(copy), Some(record)) => {
                let canonical: Value = serde_json::from_str(&copy.to_json()).unwrap();
                assert_eq!(&canonical, record, "{name}: the received record");
                // The row keeps the copy in its columns and `details`.
                let stored = SubmittedCopy::from_stored(
                    &copy.body,
                    copy.revision,
                    &copy.stored_details(),
                    &record["provenance"],
                )
                .unwrap_or_else(|error| panic!("{name}: {error}"));
                assert_eq!(stored, copy, "{name}: the stored row reads back");
                assert!(copy.stored_details().get("body").is_none());
            }
            (Err(error), None) => assert_eq!(
                serde_json::to_value(error.code).unwrap(),
                expect["code"],
                "{name}: {}",
                error.message
            ),
            (Ok(_), None) => panic!("{name}: accepted, but {} was expected", expect["code"]),
            (Err(error), Some(_)) => panic!("{name}: refused with {error}"),
        }
    }
    let too_large = request_json(json!({"body": "a".repeat(MAX_JSON_BYTES)}));
    assert_eq!(
        SubmissionRequest::from_json(&too_large).unwrap_err().code,
        ErrorCode::TooLarge
    );

    for case in fixture["consentChanges"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut copy = SubmittedCopy::from_json(&case["record"].to_string())
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let moderation = &case["moderation"];
        let facts = ModerationFacts {
            state: ModerationState::from_id(moderation["state"].as_str().unwrap()).unwrap(),
            revision: moderation["revision"].as_u64().unwrap() as u32,
            approved_revision: moderation["approvedRevision"].as_u64().map(|n| n as u32),
            approved_consent: None,
            clarification_asked: None,
            content_retained: moderation["contentRetained"].as_bool().unwrap(),
        };
        let current = copy.consent().clone();
        let outcome = copy.revise_consent(
            &facts,
            ConsentChange {
                publish: true,
                attribution: current.attribution.clone(),
                clarification: case["clarification"].as_bool().unwrap(),
                feature: match &case["feature"] {
                    Value::Null => FeatureChange::Keep,
                    Value::String(word) if word == "decline" => FeatureChange::Decline,
                    seen => FeatureChange::Agree {
                        revision_seen: seen.as_u64().unwrap() as u32,
                    },
                },
            },
            time(case["at"].as_str().unwrap()),
        );
        let expect = &case["expect"];
        match outcome {
            Ok(outcome) => {
                assert_eq!(outcome, ConsentOutcome::Recorded, "{name}");
                assert_eq!(
                    copy.stored_details()["consents"],
                    expect["consents"],
                    "{name}: the consent records"
                );
            }
            Err(error) => assert_eq!(expect["code"], error.code(), "{name}"),
        }
    }
}
