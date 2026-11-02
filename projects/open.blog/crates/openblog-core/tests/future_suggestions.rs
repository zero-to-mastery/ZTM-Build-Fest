//! Future-question and source-suggestion records (RD13.1, ADRs 0152 to 0157):
//! one more kind in the one participation policy, untrusted by default,
//! private to the editors, never entering the Source Library by itself, with
//! acceptance meaning editorial interest and nothing more.

use openblog_core::date::DateTime;
use openblog_core::feedback_provenance::FeedbackChannel;
use openblog_core::future_suggestion::{
    convert, duplicate_groups, identity_scrub_due, library_candidate, normalize_suggestion_url,
    source_keys, About, Conversion, ConversionError, ConversionKind, ErrorCode, Outcome,
    ReaderAttribution, Standing, Submission, Suggestion, SuggestionType, ACCEPTANCE_NOTICE,
    DECLINE_NOTICE, KIND, LINK_NOTICE, MAX_ACTOR_CHARS, MAX_CONVERSIONS, MAX_STORED_DETAILS_BYTES,
    MAX_SUBMISSION_BYTES, MAX_TEXT_CHARS,
};
use openblog_core::moderation::{
    is_public, may_view, Actor, ItemFacts, ModerationAction, ModerationPolicy, ModerationState,
    PolicyError, ReasonCode, Request, RetentionStep, Submission as NewItem, View,
};
use openblog_core::participation::{ParticipationKind, ParticipationMode};
use serde_json::{json, Value};

const WORK: &str = "/posts/tides/";
const WORKS: [&str; 1] = [WORK];
const ADMIN: Actor<'static> = Actor::SiteAdmin {
    admin_user: "owner",
};
const COORDINATOR: Actor<'static> = Actor::Coordinator {
    admin_user: "coord",
    works: &WORKS,
};
const CONTRIBUTOR: Actor<'static> = Actor::ContributingAuthor {
    admin_user: "writer",
    works: &WORKS,
};

fn time(value: &str) -> DateTime {
    DateTime::parse(value).expect("test time")
}

fn received() -> DateTime {
    time("2026-10-26T10:00:00Z")
}

fn submission(extra: Value) -> Value {
    let mut value = json!({
        "version": 1,
        "kind": "future-suggestion",
        "type": "text",
        "text": "Her letters from the 1850 survey would help with the tide tables.",
    });
    for (key, field) in extra.as_object().expect("object") {
        value[key] = field.clone();
    }
    value
}

fn parse(value: &Value) -> Result<Submission, openblog_core::future_suggestion::SuggestionError> {
    Submission::from_json(&value.to_string())
}

fn code(value: &Value) -> ErrorCode {
    parse(value).expect_err("must be refused").code
}

fn receive(value: &Value) -> Suggestion {
    Suggestion::receive(
        parse(value).expect("valid"),
        WORK,
        received(),
        FeedbackChannel::Hosted,
    )
    .expect("received")
}

fn facts(state: ModerationState) -> ItemFacts<'static> {
    ItemFacts {
        id: "item-1",
        kind: KIND,
        work: Some(WORK),
        parent: None,
        state,
        version: 3,
        revision: 1,
        approved_revision: (state == ModerationState::Approved).then_some(1),
        clarification_asked: None,
        clarification_consent: true,
        content_retained: true,
        state_since: received(),
    }
}

fn decide(
    actor: Actor<'static>,
    action: ModerationAction,
    item: &ItemFacts<'static>,
    reason: Option<ReasonCode>,
) -> Result<openblog_core::moderation::Decision, PolicyError> {
    ModerationPolicy::default().decide(
        item,
        &Request {
            actor,
            action,
            expected_version: item.version,
            reason,
            at: time("2026-10-27T10:00:00Z"),
            reported_item: None,
        },
    )
}

// ---------------------------------------------------------------------------
// The record

#[test]
fn every_type_round_trips_to_the_same_canonical_json() {
    let full = submission(json!({
        "type": "video",
        "url": "https://Example.org/watch?v=1",
        "hints": {
            "title": "The 1850 survey",
            "creators": ["A. Surveyor"],
            "year": "c. 1850",
            "publisher": "Admiralty",
            "identifiers": [{ "scheme": "doi", "value": "10.1234/example" }]
        },
        "about": { "series": "tides" },
        "attribution": { "name": "  Ada   Lovelace ", "publishName": true },
        "contact": { "address": "ada@example.org", "followUp": true }
    }));
    let record = Suggestion::receive(
        parse(&full).unwrap(),
        WORK,
        received(),
        FeedbackChannel::Hosted,
    )
    .unwrap();
    assert_eq!(
        record.submission.url.as_deref(),
        Some("https://example.org/watch?v=1")
    );
    assert_eq!(record.credit(), Some("Ada Lovelace"));
    let text = record.to_json();
    let again = Suggestion::from_json(&text).unwrap();
    assert_eq!(again, record);
    assert_eq!(again.to_json(), text, "canonical output is deterministic");
    // A submission serializes the same way every time, in a fixed order.
    let submission = parse(&full).unwrap();
    assert_eq!(
        submission.to_json(),
        Submission::from_json(&submission.to_json())
            .unwrap()
            .to_json()
    );

    for kind in SuggestionType::ALL {
        let value = if kind == SuggestionType::Question {
            submission_of(kind, json!({}))
        } else {
            submission_of(kind, json!({ "url": "https://example.org/x" }))
        };
        assert_eq!(parse(&value).unwrap().suggestion_type, kind);
        assert_eq!(SuggestionType::from_id(kind.id()), Some(kind));
    }
}

fn submission_of(kind: SuggestionType, extra: Value) -> Value {
    let mut value = submission(extra);
    value["type"] = kind.id().into();
    value
}

#[test]
fn a_record_is_strict_about_version_kind_type_fields_and_size() {
    assert_eq!(
        code(&submission(json!({ "type": "poem" }))),
        ErrorCode::UnknownType
    );
    assert_eq!(
        code(&submission(json!({ "kind": "question" }))),
        ErrorCode::WrongKind
    );
    assert_eq!(
        code(&submission(json!({ "text": "" }))),
        ErrorCode::InvalidText
    );
    assert_eq!(
        code(&submission(json!({ "text": "  " }))),
        ErrorCode::InvalidText
    );
    assert_eq!(
        code(&submission(
            json!({ "text": "x".repeat(MAX_TEXT_CHARS + 1) })
        )),
        ErrorCode::InvalidText
    );
    assert_eq!(
        code(&submission(json!({ "text": "a\u{202e}b" }))),
        ErrorCode::InvalidText
    );
    assert_eq!(
        code(&submission(json!({ "rank": 3 }))),
        ErrorCode::Malformed
    );
    assert_eq!(
        code(&submission(json!({ "votes": 3 }))),
        ErrorCode::Malformed
    );
    assert_eq!(
        code(&submission(json!({ "version": 2 }))),
        ErrorCode::UnsupportedVersion
    );
    assert_eq!(
        code(&submission(json!({ "version": 0 }))),
        ErrorCode::Malformed
    );
    assert_eq!(
        Submission::from_json("not json").unwrap_err().code,
        ErrorCode::Malformed
    );
    assert_eq!(
        Submission::from_json(&" ".repeat(20_000)).unwrap_err().code,
        ErrorCode::TooLarge
    );
    // Hints are strict too.
    assert_eq!(
        code(&submission(
            json!({ "hints": { "title": "t", "rating": 5 } })
        )),
        ErrorCode::Malformed
    );
    assert_eq!(
        code(&submission(
            json!({ "hints": { "creators": vec!["a"; 9] } })
        )),
        ErrorCode::InvalidHint
    );
    assert_eq!(
        code(&submission(
            json!({ "hints": { "identifiers": [{ "scheme": "isbn", "value": "123" }] } })
        )),
        ErrorCode::InvalidHint
    );
    assert_eq!(
        code(&submission(
            json!({ "hints": { "title": "x".repeat(301) } })
        )),
        ErrorCode::InvalidHint
    );
    // A question is words only.
    assert_eq!(
        code(&submission_of(
            SuggestionType::Question,
            json!({ "url": "https://example.org/" })
        )),
        ErrorCode::NotForQuestion
    );
    assert_eq!(
        code(&submission_of(
            SuggestionType::Question,
            json!({ "hints": { "title": "t" } })
        )),
        ErrorCode::NotForQuestion
    );
    // The target is a series slug or a published page, exactly one.
    for about in [
        json!({}),
        json!({ "series": "Tides" }),
        json!({ "series": "a", "article": "/posts/a/" }),
        json!({ "article": "posts/a" }),
        json!({ "article": "/posts/../a/" }),
        json!({ "topic": "x" }),
        json!("tides"),
    ] {
        assert_eq!(
            code(&submission(json!({ "about": about }))),
            ErrorCode::InvalidAbout
        );
    }
    let about = parse(&submission(json!({ "about": { "article": "/posts/a/" } }))).unwrap();
    assert_eq!(about.about, Some(About::Article("/posts/a/".into())));
}

#[test]
fn unsafe_urls_are_refused_and_safe_ones_normalized() {
    for url in [
        "javascript:alert(1)",
        "data:text/html,<script>1</script>",
        "file:///etc/passwd",
        "ftp://example.org/x",
        "//example.org/x",
        "example.org/x",
        "https://user:pw@example.org/x",
        "https://localhost/x",
        "https://intranet/x",
        "https://printer.local/x",
        "https://service.internal/x",
        "http://127.0.0.1/x",
        "http://10.0.0.5/x",
        "http://192.168.1.1/x",
        "http://169.254.169.254/latest",
        "http://100.64.0.1/x",
        "http://[::1]/x",
        "http://[fd00::1]/x",
        "http://[fe80::1]/x",
        "https://exa mple.org/x",
        "https://example.org/\u{202e}x",
        " https://example.org/x",
        "",
    ] {
        assert_eq!(normalize_suggestion_url(url), None, "{url:?}");
        assert_eq!(
            code(&submission(json!({ "url": url }))),
            ErrorCode::InvalidUrl,
            "{url:?}"
        );
    }
    let long = format!("https://example.org/{}", "a".repeat(2_100));
    assert_eq!(
        code(&submission(json!({ "url": long }))),
        ErrorCode::InvalidUrl
    );
    assert_eq!(
        normalize_suggestion_url("HTTPS://Example.ORG:443/a b/../c#top").as_deref(),
        None,
        "whitespace is refused, never repaired"
    );
    assert_eq!(
        normalize_suggestion_url("https://Example.ORG/a/../c").as_deref(),
        Some("https://example.org/c")
    );
    assert_eq!(
        normalize_suggestion_url("https://münchen.example/x").as_deref(),
        Some("https://xn--mnchen-3ya.example/x")
    );
}

#[test]
fn missing_metadata_is_allowed_and_named_for_the_editor() {
    let bare = receive(&submission_of(SuggestionType::Video, json!({})));
    assert_eq!(
        bare.missing_metadata(),
        ["a link or identifier", "a title", "a creator"]
    );
    let partial = receive(&submission_of(
        SuggestionType::Text,
        json!({ "url": "https://example.org/a", "hints": { "title": "T" } }),
    ));
    assert_eq!(partial.missing_metadata(), ["a creator"]);
    let question = receive(&submission_of(SuggestionType::Question, json!({})));
    assert!(question.missing_metadata().is_empty());
}

// ---------------------------------------------------------------------------
// Attribution and contact

#[test]
fn display_is_anonymous_unless_the_reader_agreed_to_show_a_name() {
    let anonymous = receive(&submission(json!({})));
    assert_eq!(anonymous.credit(), None);
    let private = receive(&submission(json!({ "attribution": { "name": "Ada" } })));
    assert_eq!(
        private.credit(),
        None,
        "a name given but not agreed to be shown"
    );
    let shown = receive(&submission(
        json!({ "attribution": { "name": "Ada", "publishName": true } }),
    ));
    assert_eq!(shown.credit(), Some("Ada"));
    assert_eq!(
        code(&submission(
            json!({ "attribution": { "publishName": true } })
        )),
        ErrorCode::ConsentWithoutName
    );
    assert_eq!(
        code(&submission(
            json!({ "attribution": { "name": "x".repeat(81) } })
        )),
        ErrorCode::InvalidName
    );
    assert_eq!(
        code(&submission(
            json!({ "attribution": { "name": "a\u{202e}b" } })
        )),
        ErrorCode::InvalidName
    );
    assert_eq!(
        code(&submission(
            json!({ "attribution": { "name": "Ada", "email": "a@b.c" } })
        )),
        ErrorCode::Malformed
    );
}

#[test]
fn contact_is_optional_consented_and_never_printed() {
    assert!(receive(&submission(json!({}))).submission.contact.is_none());
    let with = receive(&submission(
        json!({ "contact": { "address": "ada@example.org", "followUp": true } }),
    ));
    let debug = format!("{with:?}");
    assert!(!debug.contains("ada@example.org"), "{debug}");
    assert!(debug.contains("<private>"));
    assert_eq!(
        code(&submission(
            json!({ "contact": { "address": "ada@example.org", "followUp": false } })
        )),
        ErrorCode::ContactWithoutConsent
    );
    assert_eq!(
        code(&submission(
            json!({ "contact": { "address": "ada@example.org" } })
        )),
        ErrorCode::Malformed
    );
    for address in [
        "",
        "ada",
        "ada@",
        "@example.org",
        "ada@example",
        "Ada <ada@example.org>",
        "ada@example.org, bob@example.org",
        "ada @example.org",
        "ada@exa mple.org",
        "ada..b@example.org",
        ".ada@example.org",
        "ada@-example.org",
        "ada@example..org",
        "\"ada\"@example.org",
        "ada@example.org\r\nBcc: x@y.z",
        "ada@exämple.org",
    ] {
        assert_eq!(
            code(&submission(
                json!({ "contact": { "address": address, "followUp": true } })
            )),
            ErrorCode::InvalidContact,
            "{address:?}"
        );
    }
}

#[test]
fn contact_and_an_unshown_name_reach_only_the_site_admin_and_the_submitter() {
    let record = receive(&submission(json!({
        "attribution": { "name": "Ada" },
        "contact": { "address": "ada@example.org", "followUp": true }
    })));
    let item = facts(ModerationState::Approved);
    // (actor, may see the content, may see the private identity)
    for (actor, content, sees) in [
        (ADMIN, true, true),
        (Actor::Submitter, true, true),
        (COORDINATOR, true, false),
        (CONTRIBUTOR, true, false),
        (Actor::Public, false, false),
        (Actor::System, false, false),
    ] {
        let view = record.editor_view(&actor, &item, ParticipationMode::Open);
        assert_eq!(view.is_some(), content, "{actor:?}");
        if let Some(view) = view {
            assert_eq!(view.contact.is_some(), sees, "{actor:?}");
            assert_eq!(view.name.is_some(), sees, "{actor:?}");
            assert_eq!(view.text, record.submission.text);
            assert_eq!(view.notice, ACCEPTANCE_NOTICE);
            let debug = format!("{view:?}");
            assert!(
                !debug.contains("ada@example.org") && !debug.contains("Ada"),
                "{debug}"
            );
        }
        assert_eq!(
            may_view(
                &actor,
                &item,
                ParticipationMode::Open,
                View::PrivateIdentity
            ),
            sees
        );
    }
    // A name the reader agreed to show is not private.
    let shown = receive(&submission(
        json!({ "attribution": { "name": "Ada", "publishName": true } }),
    ));
    let view = shown
        .editor_view(&COORDINATOR, &item, ParticipationMode::Open)
        .unwrap();
    assert_eq!(view.name.as_deref(), Some("Ada"));
    // Text that was purged shows nothing to anyone, and an item of another
    // kind is not a suggestion.
    let purged = ItemFacts {
        content_retained: false,
        ..item
    };
    assert!(shown
        .editor_view(&ADMIN, &purged, ParticipationMode::Open)
        .is_none());
    let other = ItemFacts {
        kind: ParticipationKind::Question,
        ..item
    };
    assert!(shown
        .editor_view(&ADMIN, &other, ParticipationMode::Open)
        .is_none());
}

// ---------------------------------------------------------------------------
// The stored row

#[test]
fn a_stored_row_reads_back_to_the_same_suggestion() {
    let record = receive(&submission(json!({
        "type": "source",
        "url": "https://example.org/archive",
        "hints": { "title": "Survey archive" },
        "about": { "series": "tides" },
        "attribution": { "name": "Ada", "publishName": false },
        "contact": { "address": "ada@example.org", "followUp": true }
    })));
    let details = record.stored_details();
    assert_eq!(details["type"], "source");
    assert!(details.get("name").is_none() && details.get("attribution").is_none());
    let receipt = serde_json::from_str::<Value>(&record.to_json()).unwrap()["receipt"].clone();
    let back = Suggestion::from_stored(
        &record.submission.text,
        record.revision,
        &details,
        &receipt,
        &record.submission.attribution,
    )
    .unwrap();
    assert_eq!(back, record);
    // A stored row is as strict as a submission.
    let mut bad = details.clone();
    bad["rank"] = json!(1);
    assert!(
        Suggestion::from_stored("t", 1, &bad, &receipt, &ReaderAttribution::default()).is_err()
    );
    assert!(
        Suggestion::from_stored("t", 0, &details, &receipt, &ReaderAttribution::default()).is_err()
    );
    let mut bad_receipt = receipt.clone();
    bad_receipt["work"] = json!("https://elsewhere.example/");
    assert_eq!(
        Suggestion::from_stored(
            "t",
            1,
            &details,
            &bad_receipt,
            &ReaderAttribution::default()
        )
        .unwrap_err()
        .code,
        ErrorCode::InvalidWork
    );
    // Reading a record newer than this version is refused, not guessed.
    let mut newer: Value = serde_json::from_str(&record.to_json()).unwrap();
    newer["version"] = json!(2);
    assert_eq!(
        Suggestion::from_json(&newer.to_string()).unwrap_err().code,
        ErrorCode::UnsupportedVersion
    );
    // A clarified text is the next revision and changes nothing else.
    let clarified = record.clarified("Here is what I meant.").unwrap();
    assert_eq!(clarified.revision, 2);
    assert_eq!(clarified.submission.url, record.submission.url);
    assert!(record.clarified("").is_err());
}

// ---------------------------------------------------------------------------
// Duplicates

#[test]
fn the_same_source_sent_again_is_grouped_for_the_editor_and_never_counted() {
    let url = |value: &str| {
        receive(&submission_of(
            SuggestionType::Text,
            json!({ "url": value }),
        ))
    };
    let a = url("https://www.example.org/paper/?utm_source=x&b=2&a=1#intro");
    let b = url("http://example.org/paper?a=1&b=2");
    let c = url("https://example.org/other");
    let doi_a = receive(&submission(
        json!({ "hints": { "identifiers": [{ "scheme": "doi", "value": "10.1234/ABC" }] } }),
    ));
    let doi_b = receive(&submission(
        json!({ "hints": { "identifiers": [{ "scheme": "doi", "value": "https://doi.org/10.1234/abc" }] } }),
    ));
    let isbn_a = receive(&submission(
        json!({ "hints": { "identifiers": [{ "scheme": "isbn", "value": "978-0-306-40615-7" }] } }),
    ));
    let isbn_b = receive(&submission(
        json!({ "hints": { "identifiers": [{ "scheme": "isbn", "value": "9780306406157" }] } }),
    ));
    let none = receive(&submission(json!({})));
    assert_eq!(source_keys(&a.submission), source_keys(&b.submission));
    assert_ne!(source_keys(&a.submission), source_keys(&c.submission));
    assert!(source_keys(&none.submission).is_empty());
    let ids = [
        "z-isbn-2", "m-url-1", "n-url-2", "c", "k-doi-1", "a-isbn-1", "l-doi-2", "none",
    ];
    let item = |id: &'static str| ItemFacts {
        id,
        ..facts(ModerationState::Approved)
    };
    let [z, m, n, cc, k, aa, l, nn] = ids.map(item);
    let groups = duplicate_groups(
        &ADMIN,
        ParticipationMode::Open,
        &[
            (&z, &isbn_b),
            (&m, &a),
            (&n, &b),
            (&cc, &c),
            (&k, &doi_a),
            (&aa, &isbn_a),
            (&l, &doi_b),
            (&nn, &none),
        ],
    );
    assert_eq!(
        groups,
        vec![
            vec!["a-isbn-1".to_string(), "z-isbn-2".to_string()],
            vec!["k-doi-1".to_string(), "l-doi-2".to_string()],
            vec!["m-url-1".to_string(), "n-url-2".to_string()],
        ]
    );
    // A suggestion with both a link and an identifier is the same source as
    // another that shares either one, and so are those two with each other.
    let both = receive(&submission(json!({
        "url": "https://example.org/other",
        "hints": { "identifiers": [{ "scheme": "doi", "value": "10.1234/abc" }] }
    })));
    let (b1, b2) = (item("both"), item("same-link"));
    let same_link = receive(&submission_of(
        SuggestionType::Text,
        json!({ "url": "https://example.org/other/" }),
    ));
    let groups = duplicate_groups(
        &ADMIN,
        ParticipationMode::Open,
        &[(&b1, &both), (&k, &doi_a), (&b2, &same_link), (&cc, &c)],
    );
    assert_eq!(
        groups,
        vec![vec![
            "both".to_string(),
            "c".to_string(),
            "k-doi-1".to_string(),
            "same-link".to_string()
        ]],
        "a shared DOI and a shared link join the group through the one that has both"
    );
}

#[test]
fn a_source_is_the_same_source_however_it_was_written() {
    let key = |submission: Value| source_keys(&receive(&submission).submission);
    let id = |scheme: &str, value: &str| {
        key(submission(
            json!({ "hints": { "identifiers": [{ "scheme": scheme, "value": value }] } }),
        ))
    };
    // A DOI by its name: bare, `doi:`, or a resolver link on either host.
    let doi = id("doi", "10.1234/ABC");
    assert_eq!(doi, id("doi", "doi:10.1234/abc"));
    assert_eq!(doi, id("doi", "https://doi.org/10.1234/abc"));
    assert_eq!(doi, id("doi", "http://dx.doi.org/10.1234/abc"));
    assert_eq!(
        doi,
        key(submission(json!({ "url": "https://doi.org/10.1234/abc" })))
    );
    // An ISBN-10 and the ISBN-13 it converts to are one book.
    let ten = id("isbn", "0-306-40615-2");
    assert_eq!(ten, id("isbn", "9780306406157"));
    assert_eq!(ten, id("isbn", "978-0-306-40615-7"));
    assert_ne!(ten, id("isbn", "9780306406164"));
    // An ISSN without its hyphen; a link as an identifier like a link.
    assert_eq!(id("issn", "0378-5955"), id("issn", "03785955"));
    assert_eq!(
        id("url", "https://www.example.org/paper/?utm_source=x"),
        key(submission(json!({ "url": "http://example.org/paper" })))
    );
    // Different sources stay different.
    assert_ne!(doi, id("doi", "10.1234/abd"));
}

#[test]
fn duplicates_are_grouped_only_among_items_the_viewer_may_see() {
    let one = receive(&submission(json!({ "url": "https://example.org/a" })));
    let two = receive(&submission(json!({ "url": "https://example.org/a/" })));
    let (x, y) = (
        ItemFacts {
            id: "x",
            ..facts(ModerationState::Approved)
        },
        ItemFacts {
            id: "y",
            work: Some("/posts/elsewhere/"),
            ..facts(ModerationState::Approved)
        },
    );
    let items = [(&x, &one), (&y, &two)];
    let all = duplicate_groups(&ADMIN, ParticipationMode::Open, &items);
    assert_eq!(all, vec![vec!["x".to_string(), "y".to_string()]]);
    // A coordinator of /posts/tides/ does not see the other post's item, so
    // neither is its existence revealed by a group.
    assert!(duplicate_groups(&COORDINATOR, ParticipationMode::Open, &items).is_empty());
    assert!(duplicate_groups(&Actor::Public, ParticipationMode::Open, &items).is_empty());
    // Another kind's item is not a suggestion and is never grouped.
    let question = ItemFacts {
        kind: ParticipationKind::Question,
        ..y
    };
    assert!(duplicate_groups(
        &ADMIN,
        ParticipationMode::Open,
        &[(&x, &one), (&question, &two)]
    )
    .is_empty());
}

// ---------------------------------------------------------------------------
// The one participation and moderation policy

#[test]
fn the_kind_is_one_more_row_of_the_registry_and_never_public() {
    assert_eq!(ParticipationKind::from_id("future-suggestion"), Some(KIND));
    let rules = KIND.rules();
    assert!(!rules.publishable && rules.editorial && rules.clarification);
    for state in ModerationState::ALL {
        for mode in ParticipationMode::ALL {
            assert!(!is_public(&facts(state), mode), "{state:?} {mode:?}");
        }
    }
}

#[test]
fn a_submission_is_pending_only_where_the_mode_is_open_and_anyone_may_send_one() {
    let policy = ModerationPolicy::default();
    let new = |mode, actor| NewItem {
        id: "item-1",
        actor,
        kind: KIND,
        work: Some(WORK),
        mode,
        parent: None,
        parent_target: None,
        author_grant: None,
        clarification_consent: true,
        at: received(),
    };
    let admitted = policy
        .admit(&new(ParticipationMode::Open, Actor::Public))
        .unwrap();
    assert_eq!(admitted.state, ModerationState::Pending);
    assert!(admitted.clarification_consent);
    assert_eq!(
        policy
            .admit(&new(ParticipationMode::Hidden, Actor::Public))
            .unwrap_err(),
        PolicyError::Unavailable
    );
    assert_eq!(
        policy
            .admit(&new(ParticipationMode::Locked, Actor::Public))
            .unwrap_err(),
        PolicyError::Closed
    );
    assert_eq!(
        policy
            .admit(&new(ParticipationMode::Open, ADMIN))
            .unwrap_err(),
        PolicyError::Denied,
        "the author side never submits as a reader"
    );
}

#[test]
fn acceptance_admits_to_the_queue_and_publishes_nothing_and_is_kept() {
    let pending = facts(ModerationState::Pending);
    let accepted = decide(ADMIN, ModerationAction::Approve, &pending, None).unwrap();
    assert_eq!(accepted.item.to, ModerationState::Approved);
    let approved = facts(ModerationState::Approved);
    assert!(!is_public(&approved, ParticipationMode::Open));
    // An accepted idea is not purged on the closed-item clock: it owes the
    // clearing of its private contact and name once the period has passed,
    // and nothing before that.
    let policy = ModerationPolicy::default();
    assert_eq!(policy.retention_due(&approved, received()), None);
    assert_ne!(
        policy.retention_due(&approved, time("2030-01-01T00:00:00Z")),
        Some(RetentionStep::PurgeContent)
    );
    // An editor can close it again, with a decline reason, and then the
    // ordinary closed-item retention applies.
    let removed = decide(
        COORDINATOR,
        ModerationAction::Remove,
        &approved,
        Some(ReasonCode::OffTopic),
    )
    .unwrap();
    assert_eq!(removed.item.to, ModerationState::Removed);
    let closed = ItemFacts {
        state: ModerationState::Removed,
        approved_revision: None,
        ..approved
    };
    assert_eq!(
        policy.retention_due(&closed, time("2030-01-01T00:00:00Z")),
        Some(RetentionStep::PurgeContent)
    );
    // A contributing author and the public never decide.
    for actor in [CONTRIBUTOR, Actor::Public, Actor::Submitter] {
        assert_eq!(
            decide(actor, ModerationAction::Approve, &pending, None).unwrap_err(),
            PolicyError::Denied
        );
    }
    // The text a clarification request asked about is never accepted.
    let asked = ItemFacts {
        clarification_asked: Some(1),
        ..pending
    };
    assert_eq!(
        decide(ADMIN, ModerationAction::Approve, &asked, None).unwrap_err(),
        PolicyError::NotAllowed
    );
    assert!(ACCEPTANCE_NOTICE.contains("does not mean they agree"));
    assert!(ACCEPTANCE_NOTICE.contains("permission"));
}

#[test]
fn the_reader_may_withdraw_and_a_purged_suggestion_cannot_be_acted_on() {
    for state in [
        ModerationState::Pending,
        ModerationState::Clarification,
        ModerationState::Approved,
    ] {
        let item = facts(state);
        let withdrawn = decide(Actor::Submitter, ModerationAction::Withdraw, &item, None).unwrap();
        assert_eq!(withdrawn.item.to, ModerationState::Withdrawn, "{state:?}");
        // The audit event names no text, name or contact.
        let audit = withdrawn.item.audit.to_json().to_string();
        assert!(!audit.contains("@") && !audit.contains("Ada"), "{audit}");
    }
    let policy = ModerationPolicy::default();
    let withdrawn = facts(ModerationState::Withdrawn);
    assert_eq!(
        policy.retention_due(&withdrawn, received()),
        Some(RetentionStep::PurgeContent)
    );
    let purged = ItemFacts {
        content_retained: false,
        ..facts(ModerationState::Approved)
    };
    assert_eq!(
        decide(
            ADMIN,
            ModerationAction::Remove,
            &purged,
            Some(ReasonCode::Other)
        )
        .unwrap_err(),
        PolicyError::ContentPurged
    );
    // Standing says it plainly.
    assert_eq!(
        Standing::of(ModerationState::Withdrawn, &[]),
        Standing::Withdrawn
    );
    assert_eq!(
        Standing::of(ModerationState::Pending, &[]),
        Standing::Received
    );
    assert_eq!(
        Standing::of(ModerationState::Clarification, &[]),
        Standing::NeedsClarification
    );
    assert_eq!(
        Standing::of(ModerationState::Approved, &[]),
        Standing::Interested
    );
    assert_eq!(
        Standing::of(ModerationState::Rejected, &[]),
        Standing::Declined
    );
    assert_eq!(
        Standing::of(ModerationState::Removed, &[]),
        Standing::Declined
    );
    assert!(!Standing::Interested.label().to_lowercase().contains("true"));
}

// ---------------------------------------------------------------------------
// Conversion and the Source Library

#[test]
fn only_an_accepted_suggestion_can_be_linked_and_the_link_carries_nothing_of_the_reader() {
    let at = time("2026-11-01T09:00:00Z");
    let approved = facts(ModerationState::Approved);
    let link = convert(
        &ADMIN,
        &approved,
        &[],
        ConversionKind::Draft,
        "tide-tables",
        at,
    )
    .unwrap();
    assert_eq!(link.by, "owner");
    let text = link.to_value().to_string();
    for private in ["Ada", "ada@example.org", "survey", "letters"] {
        assert!(!text.contains(private), "{text}");
    }
    assert_eq!(Conversion::from_value(&link.to_value()).unwrap(), link);
    assert_eq!(
        Standing::of(ModerationState::Approved, std::slice::from_ref(&link)),
        Standing::Converted
    );

    for state in [
        ModerationState::Pending,
        ModerationState::Clarification,
        ModerationState::Rejected,
        ModerationState::Removed,
        ModerationState::Withdrawn,
    ] {
        assert_eq!(
            convert(
                &ADMIN,
                &facts(state),
                &[],
                ConversionKind::Series,
                "tides",
                at
            )
            .unwrap_err(),
            ConversionError::NotAccepted,
            "{state:?}"
        );
    }
    let purged = ItemFacts {
        content_retained: false,
        ..approved
    };
    assert_eq!(
        convert(&ADMIN, &purged, &[], ConversionKind::Series, "tides", at).unwrap_err(),
        ConversionError::NotAccepted
    );
    for actor in [CONTRIBUTOR, Actor::Public, Actor::Submitter, Actor::System] {
        assert_eq!(
            convert(&actor, &approved, &[], ConversionKind::Series, "tides", at).unwrap_err(),
            ConversionError::Denied
        );
    }
    let other = ItemFacts {
        kind: ParticipationKind::Question,
        ..approved
    };
    assert_eq!(
        convert(&ADMIN, &other, &[], ConversionKind::Series, "tides", at).unwrap_err(),
        ConversionError::WrongKind
    );
    assert_eq!(
        convert(
            &ADMIN,
            &approved,
            &[],
            ConversionKind::Series,
            "Not A Slug",
            at
        )
        .unwrap_err(),
        ConversionError::InvalidTarget
    );
    assert_eq!(
        convert(
            &ADMIN,
            &approved,
            std::slice::from_ref(&link),
            ConversionKind::Draft,
            "tide-tables",
            at
        )
        .unwrap_err(),
        ConversionError::AlreadyLinked
    );
    // The same id under another kind is another target.
    assert!(convert(
        &ADMIN,
        &approved,
        std::slice::from_ref(&link),
        ConversionKind::Series,
        "tide-tables",
        at
    )
    .is_ok());
    let many: Vec<Conversion> = (0..MAX_CONVERSIONS)
        .map(|n| Conversion {
            id: format!("d{n}"),
            ..link.clone()
        })
        .collect();
    assert_eq!(
        convert(
            &ADMIN,
            &approved,
            &many,
            ConversionKind::Draft,
            "one-more",
            at
        )
        .unwrap_err(),
        ConversionError::TooMany
    );
    // A stored link is read as strictly as a submission.
    let mut bad = link.to_value();
    bad["name"] = json!("Ada");
    assert!(Conversion::from_value(&bad).is_err());
    let mut bad = link.to_value();
    bad["kind"] = json!("episode");
    assert!(Conversion::from_value(&bad).is_err());
}

#[test]
fn a_library_candidate_is_unverified_hints_and_only_for_an_author_of_an_accepted_suggestion() {
    let record = receive(&submission(json!({
        "type": "text",
        "url": "https://example.org/survey",
        "hints": { "title": "The 1850 survey", "creators": ["A. Surveyor"], "year": "1850" },
        "attribution": { "name": "Ada", "publishName": true },
        "contact": { "address": "ada@example.org", "followUp": true }
    })));
    let approved = facts(ModerationState::Approved);
    let candidate = library_candidate(&record, &COORDINATOR, &approved).unwrap();
    assert!(candidate.unverified);
    assert_eq!(candidate.hints.title.as_deref(), Some("The 1850 survey"));
    let text = format!("{candidate:?}");
    for private in ["Ada", "ada@example.org", "letters"] {
        assert!(!text.contains(private), "{text}");
    }
    assert_eq!(
        library_candidate(&record, &COORDINATOR, &facts(ModerationState::Pending)).unwrap_err(),
        ConversionError::NotAccepted
    );
    assert_eq!(
        library_candidate(&record, &CONTRIBUTOR, &approved).unwrap_err(),
        ConversionError::Denied
    );
    let question = receive(&submission_of(SuggestionType::Question, json!({})));
    assert_eq!(
        library_candidate(&question, &ADMIN, &approved).unwrap_err(),
        ConversionError::WrongKind
    );
}

#[test]
fn nothing_in_the_record_reaches_the_source_library_or_any_public_output() {
    // The module neither reads nor writes the library or any publication
    // projection: it may only borrow the library's identifier check.
    let source = include_str!("../src/future_suggestion.rs");
    for forbidden in [
        "SourceLibrary",
        "SourceRecord",
        "SourceIndex",
        "std::fs",
        "publication_boundary",
        "OutputFile",
        "feeds",
        "render::",
    ] {
        assert!(
            !source.contains(forbidden),
            "future_suggestion.rs mentions {forbidden}"
        );
    }
    assert!(source.contains("use crate::source_library::check_identifier;"));
}

// ---------------------------------------------------------------------------
// Review fixes (#213): the one URL rule, identifier hints, bounds, stored
// details, redaction, retention of private identity, standing and slugs

#[test]
fn a_link_is_held_to_the_one_public_address_rule() {
    for url in [
        "http://[::127.0.0.1]/",
        "http://[2002:7f00:1::]/",
        "http://[64:ff9b::7f00:1]/",
        "http://[fec0::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://localhost.localdomain/x",
        "http://printer.home/x",
        "http://app.test/x",
        "http://wiki.corp/x",
        "http://198.18.0.1/x",
        "http://198.19.255.254/x",
        "http://2130706433/x",
        "http://0x7f.1/x",
        "http://017700000001/x",
        "https://example.org/x?access_token=abc",
        "https://example.org/x?X-Amz-Signature=abc",
        "https://example.org/x#api_key=abc",
    ] {
        assert_eq!(normalize_suggestion_url(url), None, "{url}");
        assert_eq!(
            code(&submission(json!({ "url": url }))),
            ErrorCode::InvalidUrl,
            "{url}"
        );
    }
    // A public link that only looks private stays allowed.
    for url in [
        "https://example.org/x?author=ada&keyword=tides",
        "https://example.org/x#Authorship",
        "https://doi.org/10.1234/abc",
    ] {
        assert!(normalize_suggestion_url(url).is_some(), "{url}");
    }
    // And the module keeps no private-address rule of its own.
    let source = include_str!("../src/future_suggestion.rs");
    for fragment in ["is_private()", "is_loopback()", "is_link_local()", "IpAddr"] {
        assert!(
            !source.contains(fragment),
            "the URL rule belongs to citations::public_url_problem, found {fragment}"
        );
    }
}

#[test]
fn an_identifier_hint_meets_the_text_link_and_scheme_rules() {
    let hint = |scheme: &str, value: &str| {
        code(&submission(
            json!({ "hints": { "identifiers": [{ "scheme": scheme, "value": value }] } }),
        ))
    };
    // Plain text: control and text-direction characters are refused.
    for value in [
        "10.1234/a\u{202e}b",
        "10.1234/a\nb",
        "10.1234/a\u{0}b",
        "",
        "   ",
    ] {
        assert_eq!(hint("doi", value), ErrorCode::InvalidHint, "{value:?}");
    }
    // A link goes through the public-address rule, not just the shape check.
    for value in [
        "http://127.0.0.1/x",
        "https://localhost/x",
        "https://example.org/x?token=1",
        "javascript:alert(1)",
        "https://user:pw@example.org/",
    ] {
        assert_eq!(hint("url", value), ErrorCode::InvalidHint, "{value}");
    }
    // The schemes are a closed set, and the message says so.
    for scheme in ["oclc", "", "DOI", "mailto", "javascript"] {
        assert_eq!(
            hint(scheme, "10.1234/abc"),
            ErrorCode::InvalidHint,
            "{scheme}"
        );
    }
    let message = parse(&submission(
        json!({ "hints": { "identifiers": [{ "scheme": "oclc", "value": "1" }] } }),
    ))
    .unwrap_err()
    .message;
    assert!(
        message.contains("doi, isbn, issn, url, pmid or pmcid"),
        "{message}"
    );
    assert_eq!(hint("pmid", "12ab"), ErrorCode::InvalidHint);
    assert_eq!(hint("pmcid", "123"), ErrorCode::InvalidHint);
    // What is accepted is stored trimmed and a link is stored normalized.
    let ok = parse(&submission(json!({ "hints": { "identifiers": [
        { "scheme": "url", "value": "https://Example.ORG/a/../b" },
        { "scheme": "doi", "value": "10.1234/abc" },
        { "scheme": "pmid", "value": "123456" },
        { "scheme": "pmcid", "value": "PMC123" },
    ] } })))
    .unwrap();
    assert_eq!(ok.hints.identifiers[0].value, "https://example.org/b");
    assert_eq!(ok.hints.identifiers.len(), 4);
}

/// Fill every field to its limit with the widest characters the rules take.
fn widest(character: &str) -> Value {
    let words = |count: usize| character.repeat(count);
    submission(json!({
        "type": "text",
        "text": words(MAX_TEXT_CHARS),
        "url": format!("https://example.org/{}", "a".repeat(2_000)),
        "hints": {
            "title": words(300),
            "creators": vec![words(200); 8],
            "year": words(32),
            "publisher": words(300),
            "identifiers": [
                { "scheme": "doi", "value": format!("10.1234/{}", words(100)) },
                { "scheme": "isbn", "value": "9780306406157" },
                { "scheme": "issn", "value": "0378-5955" },
                { "scheme": "pmid", "value": "123456" }
            ]
        },
        "about": { "article": format!("/posts/{}/", words(480)) },
        "attribution": { "name": words(80), "publishName": false },
        "contact": { "address": "ada@example.org", "followUp": true }
    }))
}

#[test]
fn a_largest_submission_round_trips_through_storage_or_is_refused_up_front() {
    // Whatever a submission is made of, one that is accepted must read back
    // from the stored record; one that cannot is refused when it is sent,
    // never accepted and then unreadable.
    for character in ["a", "é", "水", "\u{1F4DA}"] {
        let wide = widest(character);
        let text = wide.to_string();
        match Submission::from_json(&text) {
            Ok(submission) => {
                assert!(text.len() <= MAX_SUBMISSION_BYTES);
                let record =
                    Suggestion::receive(submission, WORK, received(), FeedbackChannel::Hosted)
                        .unwrap();
                let stored = record.to_json();
                assert!(
                    stored.len() <= openblog_core::future_suggestion::MAX_JSON_BYTES,
                    "{character}: {}",
                    stored.len()
                );
                assert_eq!(Suggestion::from_json(&stored).unwrap(), record);
                let receipt: Value = serde_json::from_str(&stored).unwrap();
                let details = record.stored_details();
                assert!(details.to_string().len() <= 16 * 1024);
                let back = Suggestion::from_stored(
                    &record.submission.text,
                    record.revision,
                    &details,
                    &receipt["receipt"],
                    &record.submission.attribution,
                )
                .unwrap();
                assert_eq!(back, record);
            }
            Err(error) => assert_eq!(error.code, ErrorCode::TooLarge, "{character}"),
        }
    }
    // The plain ASCII largest is accepted and round-trips, so the bound does
    // not turn away an ordinary full form.
    assert!(Submission::from_json(&widest("a").to_string()).is_ok());
    // A record is stored with a longest page path and still reads back.
    let long_work = format!("/posts/{}/", "w".repeat(480));
    let record = Suggestion::receive(
        parse(&widest("a")).unwrap(),
        &long_work,
        received(),
        FeedbackChannel::Hosted,
    )
    .unwrap();
    assert_eq!(Suggestion::from_json(&record.to_json()).unwrap(), record);
    // One byte over the submission bound is refused as too large.
    let over = format!("{}{}", widest("a"), " ".repeat(MAX_SUBMISSION_BYTES));
    assert_eq!(
        Submission::from_json(&over).unwrap_err().code,
        ErrorCode::TooLarge
    );
}

#[test]
fn stored_details_hold_exactly_what_the_row_keeps() {
    let record = receive(&submission(json!({
        "url": "https://example.org/a",
        "attribution": { "name": "Ada", "publishName": false },
    })));
    let details = record.stored_details();
    let receipt = serde_json::from_str::<Value>(&record.to_json()).unwrap()["receipt"].clone();
    let read = |details: &Value| {
        Suggestion::from_stored(
            "Her letters would help.",
            1,
            details,
            &receipt,
            &ReaderAttribution::default(),
        )
    };
    assert!(read(&details).is_ok());
    // A stored row cannot smuggle in the text or the name the columns hold,
    // or a second copy of anything else.
    for (key, value) in [
        ("text", json!("injected words")),
        (
            "attribution",
            json!({ "name": "Mallory", "publishName": true }),
        ),
        ("kind", json!("question")),
        ("version", json!(1)),
        ("receipt", json!({})),
        ("revision", json!(9)),
        ("name", json!("Mallory")),
    ] {
        let mut bad = details.clone();
        bad[key] = value;
        assert_eq!(
            read(&bad).unwrap_err().code,
            ErrorCode::InvalidDetails,
            "{key}"
        );
    }
    // The type is required and `details` is an object.
    let mut no_type = details.clone();
    no_type.as_object_mut().unwrap().remove("type");
    assert_eq!(read(&no_type).unwrap_err().code, ErrorCode::InvalidDetails);
    assert_eq!(
        read(&json!([])).unwrap_err().code,
        ErrorCode::InvalidDetails
    );
    // A wrongly typed field is refused whole.
    let mut bad = details.clone();
    bad["url"] = json!(5);
    assert!(read(&bad).is_err());
}

#[test]
fn a_debug_print_never_shows_a_name_the_reader_did_not_agree_to_show() {
    let private = receive(&submission(json!({
        "attribution": { "name": "Privateperson", "publishName": false },
        "contact": { "address": "p@example.org", "followUp": true }
    })));
    for debug in [
        format!("{:?}", private.submission),
        format!("{private:?}"),
        format!("{:#?}", private),
    ] {
        assert!(!debug.contains("Privateperson"), "{debug}");
        assert!(!debug.contains("p@example.org"), "{debug}");
        assert!(debug.contains("<private>"), "{debug}");
    }
    let item = facts(ModerationState::Approved);
    let view = private
        .editor_view(&ADMIN, &item, ParticipationMode::Open)
        .unwrap();
    assert_eq!(view.name.as_deref(), Some("Privateperson"));
    let debug = format!("{view:?}");
    assert!(!debug.contains("Privateperson") && !debug.contains("p@example.org"));
    // A name the reader agreed to show may be printed.
    let shown = receive(&submission(
        json!({ "attribution": { "name": "Publicperson", "publishName": true } }),
    ));
    assert!(format!("{shown:?}").contains("Publicperson"));
}

#[test]
fn private_identity_is_cleared_after_the_period_and_when_converted() {
    let policy = ModerationPolicy::default();
    let held = receive(&submission(json!({
        "attribution": { "name": "Ada", "publishName": false },
        "contact": { "address": "ada@example.org", "followUp": true }
    })));
    let shown_name = receive(&submission(
        json!({ "attribution": { "name": "Ada", "publishName": true } }),
    ));
    let bare = receive(&submission(json!({})));
    assert!(held.holds_identity());
    assert!(!shown_name.holds_identity() && !bare.holds_identity());
    // After the closed-item period an approved suggestion is kept, but owes
    // the clearing of its identity and nothing else.
    let approved = ItemFacts {
        state_since: time("2026-10-26T10:00:00Z"),
        ..facts(ModerationState::Approved)
    };
    let edge = time("2026-11-25T10:00:00Z");
    assert_eq!(
        policy.retention_due(&approved, time("2026-11-25T09:59:59Z")),
        None
    );
    assert_eq!(
        policy.retention_due(&approved, edge),
        Some(RetentionStep::ScrubIdentity)
    );
    assert_eq!(
        policy.retention_due(&approved, time("2030-01-01T00:00:00Z")),
        Some(RetentionStep::ScrubIdentity),
        "an accepted idea is never purged on this clock"
    );
    assert!(identity_scrub_due(&policy, &approved, &held, &[], edge));
    assert!(!identity_scrub_due(
        &policy,
        &approved,
        &held,
        &[],
        time("2026-11-25T09:59:59Z")
    ));
    // Nothing is due for a suggestion that holds nothing private.
    assert!(!identity_scrub_due(
        &policy,
        &approved,
        &shown_name,
        &[],
        edge
    ));
    assert!(!identity_scrub_due(&policy, &approved, &bare, &[], edge));
    // Converting it clears the identity at once, before the period.
    let link = Conversion {
        kind: ConversionKind::Draft,
        id: "tide-tables".into(),
        at: time("2026-10-27T10:00:00Z"),
        by: "owner".into(),
    };
    let soon = time("2026-10-28T10:00:00Z");
    assert!(identity_scrub_due(
        &policy,
        &approved,
        &held,
        std::slice::from_ref(&link),
        soon
    ));
    // But never for an item that is not approved, or whose text is gone.
    for state in [ModerationState::Pending, ModerationState::Rejected] {
        let item = facts(state);
        assert!(!identity_scrub_due(
            &policy,
            &item,
            &held,
            std::slice::from_ref(&link),
            soon
        ));
    }
    let purged = ItemFacts {
        content_retained: false,
        ..approved
    };
    assert!(!identity_scrub_due(&policy, &purged, &held, &[link], soon));
    // Scrubbing keeps the text, the link, the hints and a shown name only.
    let kept = receive(&submission(json!({
        "url": "https://example.org/a",
        "attribution": { "name": "Ada", "publishName": true },
        "contact": { "address": "ada@example.org", "followUp": true }
    })));
    let scrubbed = kept.scrubbed();
    assert_eq!(scrubbed.submission.text, kept.submission.text);
    assert_eq!(scrubbed.submission.url, kept.submission.url);
    assert!(scrubbed.submission.contact.is_none());
    assert_eq!(scrubbed.credit(), Some("Ada"));
    let cleared = held.scrubbed();
    assert_eq!(cleared.submission.attribution, ReaderAttribution::default());
    assert!(!cleared.holds_identity());
    // An audit event records it and holds nothing of the reader.
    let event = policy.scrub_event(&approved, edge).unwrap();
    assert_eq!(event.action.id(), "scrub-identity");
    assert_eq!(event.version, approved.version + 1);
    assert!(!format!("{:?}", event.to_json()).contains("ada"));
    // Other kinds keep their existing steps: an approved comment, an upheld
    // abuse report and a published reflection are unchanged by this.
    for kind in ParticipationKind::ALL {
        let item = ItemFacts { kind, ..approved };
        let step = ModerationPolicy::new(Default::default())
            .retention_due(&item, time("2030-01-01T00:00:00Z"));
        match kind {
            ParticipationKind::AbuseReport => assert_eq!(step, Some(RetentionStep::PurgeContent)),
            ParticipationKind::FutureSuggestion => {
                assert_eq!(step, Some(RetentionStep::ScrubIdentity))
            }
            _ => assert_eq!(step, None, "{kind}"),
        }
    }
}

#[test]
fn closing_a_converted_suggestion_does_not_read_as_declined() {
    let link = Conversion {
        kind: ConversionKind::Series,
        id: "tides".into(),
        at: time("2026-10-27T10:00:00Z"),
        by: "owner".into(),
    };
    let links = std::slice::from_ref(&link);
    assert_eq!(
        Standing::of(ModerationState::Removed, links),
        Standing::ClosedConverted
    );
    assert_eq!(Standing::ClosedConverted.id(), "closed-converted");
    let label = Standing::ClosedConverted.label().to_lowercase();
    assert!(
        label.contains("linked") && !label.contains("declined") && !label.contains("not taken")
    );
    // Without a link, or when rejected, a closed one is still not taken forward.
    assert_eq!(
        Standing::of(ModerationState::Removed, &[]),
        Standing::Declined
    );
    assert_eq!(
        Standing::of(ModerationState::Rejected, links),
        Standing::Declined
    );
    assert_eq!(
        Standing::of(ModerationState::Approved, links),
        Standing::Converted
    );
}

#[test]
fn series_and_conversion_ids_accept_the_sites_own_slugs() {
    // The site's slugs keep non-ASCII letters.
    for slug in ["marées", "水のいろ", "tides-2026", "a"] {
        assert_eq!(openblog_core::slug::slugify(slug), slug);
        let parsed = parse(&submission(json!({ "about": { "series": slug } }))).unwrap();
        assert_eq!(parsed.about, Some(About::Series(slug.into())));
    }
    for slug in [
        "Tides", "tides--x", "-tides", "tides-", "a b", "a/b", "", "tides!",
    ] {
        assert_eq!(
            code(&submission(json!({ "about": { "series": slug } }))),
            ErrorCode::InvalidAbout,
            "{slug:?}"
        );
    }
    assert_eq!(
        code(&submission(
            json!({ "about": { "series": "a".repeat(65) } })
        )),
        ErrorCode::InvalidAbout
    );
    // A draft or series conversion takes the same slugs; a library source its
    // own lowercase ASCII source id.
    let approved = facts(ModerationState::Approved);
    let at = time("2026-10-27T10:00:00Z");
    for id in ["marées", "水のいろ"] {
        let made = convert(&ADMIN, &approved, &[], ConversionKind::Draft, id, at).unwrap();
        assert_eq!(made.id, id);
        assert_eq!(Conversion::from_value(&made.to_value()).unwrap(), made);
        assert!(convert(&ADMIN, &approved, &[], ConversionKind::Series, id, at).is_ok());
        assert_eq!(
            convert(
                &ADMIN,
                &approved,
                &[],
                ConversionKind::LibrarySource,
                id,
                at
            )
            .unwrap_err(),
            ConversionError::InvalidTarget
        );
    }
    assert!(convert(
        &ADMIN,
        &approved,
        &[],
        ConversionKind::LibrarySource,
        "plato-republic",
        at
    )
    .is_ok());
    for id in ["Tides", "a b", "", "tides--x"] {
        assert_eq!(
            convert(&ADMIN, &approved, &[], ConversionKind::Draft, id, at).unwrap_err(),
            ConversionError::InvalidTarget,
            "{id:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// Outcomes and persisted links (RD13.3, ADRs 0162 to 0164)

fn link(kind: ConversionKind, id: &str) -> Conversion {
    Conversion {
        kind,
        id: id.into(),
        at: time("2026-10-27T10:00:00Z"),
        by: "owner".into(),
    }
}

#[test]
fn an_outcome_is_derived_from_the_state_and_the_links_and_never_stored() {
    let none: [Conversion; 0] = [];
    let one = [link(ConversionKind::Draft, "tide-tables")];
    let expect = |state, links: &[Conversion], outcome: Option<Outcome>| {
        assert_eq!(
            Outcome::of(state, links),
            outcome,
            "{state:?} {}",
            links.len()
        );
    };
    expect(ModerationState::Pending, &none, None);
    expect(ModerationState::Clarification, &none, None);
    expect(ModerationState::Withdrawn, &none, None);
    expect(ModerationState::Withdrawn, &one, None);
    expect(ModerationState::Approved, &none, Some(Outcome::Held));
    expect(ModerationState::Approved, &one, Some(Outcome::Converted));
    expect(ModerationState::Removed, &one, Some(Outcome::Converted));
    expect(ModerationState::Removed, &none, Some(Outcome::Closed));
    expect(ModerationState::Rejected, &none, Some(Outcome::Declined));
    // The four are all there is, with plain ids and labels that name a stage.
    let ids: Vec<_> = Outcome::ALL.iter().map(|o| (o.id(), o.label())).collect();
    assert_eq!(
        ids,
        [
            ("held", "Held"),
            ("converted", "Converted"),
            ("declined", "Declined"),
            ("closed", "Closed")
        ]
    );
    // Closing a linked suggestion keeps its outcome and is not a decline; it still stands as linked.
    assert_eq!(
        Standing::of(ModerationState::Removed, &one),
        Standing::ClosedConverted
    );
}

#[test]
fn a_reader_is_told_the_honest_standing_in_the_words_of_the_acceptance_notice() {
    for standing in [
        Standing::Received,
        Standing::NeedsClarification,
        Standing::Interested,
        Standing::Converted,
        Standing::ClosedConverted,
        Standing::Declined,
        Standing::Withdrawn,
    ] {
        let words = format!(
            "{} {}",
            standing.label(),
            standing.reader_note().unwrap_or("")
        );
        let lower = words.to_lowercase();
        for forbidden in [
            "rank",
            "score",
            "vote",
            "popular",
            "most requested",
            "trending",
            "verified",
            "endorse",
        ] {
            assert!(!lower.contains(forbidden), "{standing:?}: {forbidden}");
        }
        assert!(
            !words.chars().any(|c| c.is_ascii_digit()),
            "no counts: {words}"
        );
        // The reader is never promised publication.
        assert!(!lower.contains("will be published"), "{words}");
    }
    assert_eq!(Standing::Interested.reader_note(), Some(ACCEPTANCE_NOTICE));
    assert!(Standing::Interested.shows_acceptance_notice());
    assert!(Standing::Converted.shows_acceptance_notice());
    assert!(!Standing::Declined.shows_acceptance_notice());
    assert_eq!(Standing::Converted.reader_note(), Some(LINK_NOTICE));
    assert_eq!(Standing::Declined.reader_note(), Some(DECLINE_NOTICE));
    assert_eq!(Standing::Withdrawn.reader_note(), None);
    assert!(LINK_NOTICE.contains("not a promise"));
    assert!(DECLINE_NOTICE.contains("not a judgement of the idea"));
}

#[test]
fn links_are_kept_in_the_stored_details_and_the_record_and_read_back_strictly() {
    let plain = receive(&submission(json!({
        "type": "video",
        "url": "https://example.org/watch",
        "contact": { "address": "ada@example.org", "followUp": true },
    })));
    let linked = plain
        .linked(
            &ADMIN,
            &facts(ModerationState::Approved),
            ConversionKind::Draft,
            "tide-tables",
            time("2026-11-01T09:00:00Z"),
        )
        .unwrap();
    // A suggestion with no link has no `conversions` field at all, so what a site stored before this
    // reads and writes byte for byte as it did.
    assert!(plain.stored_details().get("conversions").is_none());
    assert!(!plain.to_json().contains("conversions"));
    let details = linked.stored_details();
    assert_eq!(details["conversions"][0]["id"], "tide-tables");
    assert_eq!(details["conversions"][0]["by"], "owner");
    // The link is the only difference.
    let mut without = details.clone();
    without.as_object_mut().unwrap().remove("conversions");
    assert_eq!(without, plain.stored_details());
    // It reads back from a stored row and from the record.
    let back = Suggestion::from_stored(
        &linked.submission.text,
        1,
        &details,
        &json!({ "work": WORK, "receivedAt": "2026-10-26T10:00:00Z", "channel": "hosted" }),
        &ReaderAttribution::default(),
    )
    .unwrap();
    assert_eq!(back, linked);
    assert_eq!(Suggestion::from_json(&linked.to_json()).unwrap(), linked);
    // Deterministic: the same suggestion and the same link always write the same bytes.
    assert_eq!(linked.to_json(), linked.clone().to_json());
    assert_eq!(linked.stored_details().to_string(), details.to_string());
    // Linking changes neither the reader's words nor their contact; clearing the identity keeps the link.
    assert_eq!(linked.submission, plain.submission);
    let scrubbed = linked.scrubbed();
    assert!(scrubbed.submission.contact.is_none());
    assert_eq!(scrubbed.conversions, linked.conversions);
    // A suggestion cannot be linked to the same target twice, in the stored form either.
    let twice = json!([
        link(ConversionKind::Draft, "a").to_value(),
        link(ConversionKind::Draft, "a").to_value()
    ]);
    let mut bad = plain.stored_details();
    bad["conversions"] = twice;
    assert!(Suggestion::from_stored(
        "x",
        1,
        &bad,
        &json!({ "work": WORK, "receivedAt": "2026-10-26T10:00:00Z", "channel": "hosted" }),
        &ReaderAttribution::default(),
    )
    .is_err());
    assert_eq!(
        openblog_core::moderation::AuditAction::Convert.id(),
        "convert"
    );
}

/// How many bytes Postgres writes a jsonb value as text: compact, with one more byte after every `:` and `,`.
fn postgres_text_bytes(value: &Value) -> usize {
    let compact = value.to_string();
    let mut extra = 0;
    let mut in_string = false;
    let mut escaped = false;
    for byte in compact.bytes() {
        if in_string {
            match (escaped, byte) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
        } else if byte == b'"' {
            in_string = true;
        } else if byte == b':' || byte == b',' {
            extra += 1;
        }
    }
    compact.len() + extra
}

#[test]
fn the_largest_suggestion_and_eight_largest_links_fit_the_hosted_column() {
    // Links at their widest: non-ASCII slugs and the longest account name, each character four bytes.
    let widest: Vec<Conversion> = (0..MAX_CONVERSIONS)
        .map(|n| Conversion {
            kind: ConversionKind::Draft,
            id: format!("{}-{n}", "\u{6F22}".repeat(62))
                .chars()
                .take(64)
                .collect(),
            at: time("2026-10-27T10:00:00Z"),
            by: "\u{1F600}".repeat(MAX_ACTOR_CHARS),
        })
        .collect();
    let links = Value::Array(widest.iter().map(Conversion::to_value).collect());
    let room = postgres_text_bytes(&json!({ "conversions": links, "creditRevision": i32::MAX }));
    assert!(
        MAX_STORED_DETAILS_BYTES + room < 16 * 1024,
        "{MAX_STORED_DETAILS_BYTES} + {room} must stay under the column's 16 KiB"
    );
    for link in &widest {
        assert_eq!(Conversion::from_value(&link.to_value()).unwrap(), *link);
    }
}

#[test]
fn an_accepted_record_over_16_kib_reads_back_with_eight_links_and_a_clarification() {
    // Text of four-byte characters beside links the details bound lets
    // through: the whole record is over 16 KiB, and was once unreadable.
    let wide = |tag: &str| format!("https://example.org/{tag}{}", "\u{6C34}".repeat(225));
    let wide_submission = submission(json!({
        "type": "source",
        "text": "\u{1F4DA}".repeat(2_000),
        "url": wide(""),
        "hints": { "identifiers": (0..4).map(|i| json!({ "scheme": "url", "value": wide(&i.to_string()) })).collect::<Vec<_>>() },
        "attribution": { "name": "\u{1F600}".repeat(80), "publishName": true },
    }));
    let mut record = receive(&wide_submission);
    assert!(record.to_json().len() > 16 * 1024);
    let links: Vec<Conversion> = (0..MAX_CONVERSIONS)
        .map(|n| Conversion {
            kind: ConversionKind::Draft,
            id: format!("{}-{n}", "\u{6F22}".repeat(62))
                .chars()
                .take(64)
                .collect(),
            at: time("2026-10-27T10:00:00Z"),
            by: "\u{1F600}".repeat(MAX_ACTOR_CHARS),
        })
        .collect();
    record.conversions = links;
    let record = record.clarified(&"\u{1F4DA}".repeat(2_000)).unwrap();
    let receipt: Value = serde_json::from_str(&record.to_json()).unwrap();
    let back = Suggestion::from_stored(
        &record.submission.text,
        record.revision,
        &record.stored_details(),
        &receipt["receipt"],
        &record.submission.attribution,
    )
    .unwrap();
    assert_eq!(back, record);
    assert_eq!(Suggestion::from_json(&record.to_json()).unwrap(), record);
}

// ---------------------------------------------------------------------------
// Credit is opt-in and bound to the revision it was agreed for (ADR 0167)

fn stored(
    record: &Suggestion,
) -> Result<Suggestion, openblog_core::future_suggestion::SuggestionError> {
    let receipt: Value = serde_json::from_str(&record.to_json()).unwrap();
    Suggestion::from_stored(
        &record.submission.text,
        record.revision,
        &record.stored_details(),
        &receipt["receipt"],
        &record.submission.attribution,
    )
}

#[test]
fn credit_is_offered_only_for_the_text_the_reader_agreed_to_be_credited_for() {
    let sent = receive(&submission(
        json!({ "attribution": { "name": "Ada", "publishName": true } }),
    ));
    assert_eq!(sent.credit(), Some("Ada"));
    assert_eq!(sent.credit_revision, Some(1));
    assert_eq!(stored(&sent).unwrap(), sent);

    // A clarification that changes the text needs fresh consent: the old
    // agreement stays recorded, for the old text, and is not offered.
    let clarified = sent.clarified("The tide tables of 1851 instead.").unwrap();
    assert_eq!(clarified.revision, 2);
    assert_eq!(clarified.credit(), None);
    assert_eq!(clarified.credit_revision, Some(1));
    assert_eq!(stored(&clarified).unwrap(), clarified);
    // Fresh consent binds it to the new text, and a second clarification
    // leaves it behind again.
    let agreed = clarified.credited(true).unwrap();
    assert_eq!(agreed.credit(), Some("Ada"));
    assert_eq!(agreed.credit_revision, Some(2));
    assert_eq!(stored(&agreed).unwrap(), agreed);
    assert_eq!(agreed.clarified("Once more.").unwrap().credit(), None);

    // A changed consent: withdrawn, it is gone and its binding with it; agreed
    // again, it is fresh for the text as it stands.
    let withdrawn = agreed.credited(false).unwrap();
    assert_eq!(withdrawn.credit(), None);
    assert_eq!(withdrawn.credit_revision, None);
    assert!(!withdrawn.submission.attribution.publish_name);
    assert_eq!(stored(&withdrawn).unwrap(), withdrawn);
    assert_eq!(withdrawn.credited(true).unwrap().credit(), Some("Ada"));

    // Never credited without having been agreed to, and never without a name.
    let private = receive(&submission(json!({ "attribution": { "name": "Ada" } })));
    assert_eq!(private.credit(), None);
    assert_eq!(private.credit_revision, None);
    let anonymous = receive(&submission(json!({})));
    assert_eq!(
        anonymous.credited(true).unwrap_err().code,
        ErrorCode::ConsentWithoutName
    );
}

#[test]
fn a_stored_credit_binding_is_refused_unless_it_names_a_revision_the_reader_agreed_for() {
    let sent = receive(&submission(
        json!({ "attribution": { "name": "Ada", "publishName": true } }),
    ));
    let receipt: Value = serde_json::from_str(&sent.to_json()).unwrap();
    let read = |details: Value, attribution: &ReaderAttribution| {
        Suggestion::from_stored(
            &sent.submission.text,
            1,
            &details,
            &receipt["receipt"],
            attribution,
        )
    };
    let agreed = sent.submission.attribution.clone();
    for credit in [json!(0), json!(2), json!("1"), json!(1.5)] {
        let mut details = sent.stored_details();
        details["creditRevision"] = credit.clone();
        assert_eq!(
            read(details, &agreed).unwrap_err().code,
            ErrorCode::InvalidDetails,
            "{credit}"
        );
    }
    // Without agreement to be credited there is nothing to bind.
    let mut details = sent.stored_details();
    details["creditRevision"] = json!(1);
    let private = ReaderAttribution {
        name: Some("Ada".into()),
        publish_name: false,
    };
    assert_eq!(
        read(details, &private).unwrap_err().code,
        ErrorCode::InvalidDetails
    );
    // An agreement with no binding (a row that never recorded one) offers no credit.
    let mut unbound = sent.stored_details();
    unbound.as_object_mut().unwrap().remove("creditRevision");
    assert_eq!(read(unbound, &agreed).unwrap().credit(), None);
}

#[test]
fn an_editor_who_may_not_see_identity_sees_a_name_only_while_its_credit_is_current() {
    let item = facts(ModerationState::Approved);
    let sent = receive(&submission(
        json!({ "attribution": { "name": "Ada", "publishName": true } }),
    ));
    let name = |record: &Suggestion, actor: &Actor<'_>, item: &ItemFacts<'_>| {
        record
            .editor_view(actor, item, ParticipationMode::Open)
            .and_then(|view| view.name)
    };
    assert_eq!(name(&sent, &COORDINATOR, &item).as_deref(), Some("Ada"));
    let clarified = sent.clarified("Different words now.").unwrap();
    assert_eq!(name(&clarified, &COORDINATOR, &item), None);
    // The site Admin still sees the name the reader gave, as private identity.
    assert_eq!(name(&clarified, &ADMIN, &item).as_deref(), Some("Ada"));
    assert_eq!(
        name(&clarified.credited(true).unwrap(), &COORDINATOR, &item).as_deref(),
        Some("Ada")
    );
    // Retention and withdrawal remove the text and with it the view, so no
    // credit survives either.
    let purged = ItemFacts {
        content_retained: false,
        ..facts(ModerationState::Approved)
    };
    assert!(sent
        .editor_view(&ADMIN, &purged, ParticipationMode::Open)
        .is_none());
}
