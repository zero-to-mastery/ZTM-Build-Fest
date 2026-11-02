//! The one participation moderation inbox (#225, ADRs 0105 and 0106): the
//! transitions every store shares with the hosted function, hosted items read
//! strictly, each viewer's actor and view per item, the clarification rule,
//! what an older hosted schema can store, and missing or hostile items.

use openblog_core::collaboration::{
    AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference,
    Participant, SharedPublication, SourceKind,
};
use openblog_core::config::SiteConfig;
use openblog_core::feedback_provenance::FeedbackChannel;
use openblog_core::invitation::Identities;
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::moderation::{
    allowed_reasons, Actor, ItemFacts, ModerationAction, ModerationPolicy, ModerationState,
    PolicyError, Principal, ReasonCode, Request, SharedWorks,
};
use openblog_core::moderation_inbox::{
    read_page, Inbox, InboxItem, Protocol, Source, INBOX_ACTIONS,
};
use openblog_core::participation::ParticipationKind;
use openblog_core::passage_target::PassageDocument;
use openblog_core::scholarly_feedback::FeedbackSubmission;
use openblog_core::DateTime;
use serde_json::{json, Value};

// ---- The shared transitions fixture

const FIXTURE_PATH: &str = "../../tests/fixtures/participation-transitions.json";
const ROLES: [&str; 3] = ["site-admin", "coordinator", "contributing-author"];
const MATRIX_KINDS: [ParticipationKind; 5] = [
    ParticipationKind::Comment,
    ParticipationKind::Question,
    ParticipationKind::AuthorResponse,
    ParticipationKind::AbuseReport,
    ParticipationKind::FutureSuggestion,
];
const WORK: &str = "/posts/tides/";
const WORKS: [&str; 1] = [WORK];

/// The facts a case starts from: a first revision nobody asked about, the
/// same with the submitter's consent, a revision a clarification request
/// asked about, and the submitter's answer to it.
fn variants(kind: ParticipationKind) -> &'static [&'static str] {
    if kind.rules().clarification {
        &["plain", "consented", "asked", "answered"]
    } else {
        &["plain"]
    }
}

fn facts(kind: ParticipationKind, state: ModerationState, variant: &str) -> ItemFacts<'static> {
    let (revision, asked, consent) = match variant {
        "plain" => (1, None, false),
        "consented" => (1, None, true),
        "asked" => (1, Some(1), true),
        "answered" => (2, Some(1), true),
        _ => unreachable!(),
    };
    ItemFacts {
        id: "00000000-0000-4000-8000-000000000001",
        kind,
        work: Some(WORK),
        parent: None,
        state,
        version: 3,
        revision,
        approved_revision: (state == ModerationState::Approved).then_some(revision),
        clarification_asked: asked,
        clarification_consent: consent,
        content_retained: true,
        state_since: DateTime::parse("2026-10-26T10:00:00Z").unwrap(),
    }
}

fn actor(role: &str) -> Actor<'static> {
    match role {
        "site-admin" => Actor::SiteAdmin { admin_user: "ada" },
        "coordinator" => Actor::Coordinator {
            admin_user: "cy",
            works: &WORKS,
        },
        "contributing-author" => Actor::ContributingAuthor {
            admin_user: "cal",
            works: &WORKS,
        },
        _ => unreachable!(),
    }
}

/// One case decided by the policy, in the fixture's form.
fn decide(
    kind: ParticipationKind,
    role: &str,
    state: ModerationState,
    variant: &str,
    action: ModerationAction,
    reason: Option<ReasonCode>,
    expected_version: u64,
) -> Value {
    let item = facts(kind, state, variant);
    let mut case = json!({
        "kind": kind.id(), "role": role, "state": state.id(), "facts": variant,
        "action": action.id(), "reason": reason.map(ReasonCode::id),
    });
    if expected_version != item.version {
        case["expectedVersion"] = json!(expected_version);
    }
    let outcome = ModerationPolicy::default().decide(
        &item,
        &Request {
            actor: actor(role),
            action,
            expected_version,
            reason,
            at: DateTime::parse("2026-10-27T10:00:00Z").unwrap(),
            reported_item: None,
        },
    );
    match outcome {
        Ok(decision) => {
            let change = decision.item;
            case["to"] = json!(change.to.id());
            case["version"] = json!(change.version);
            case["revision"] = json!(change.revision);
            case["approvedRevision"] = json!(change.approved_revision);
            case["clarificationAsked"] = json!(change.clarification_asked);
        }
        Err(error) => case["refused"] = json!(error.code()),
    }
    case
}

/// Every inbox action for every role, kind, state and starting facts, each
/// with the first reason the action accepts, plus the refusals a request can
/// earn on its own: no reason, a reason the action does not take, and a
/// version someone else has moved past.
fn matrix() -> Vec<Value> {
    let mut cases = Vec::new();
    for kind in MATRIX_KINDS {
        for role in ROLES {
            for state in ModerationState::ALL {
                for variant in variants(kind) {
                    for action in INBOX_ACTIONS {
                        let reason = allowed_reasons(action, kind).first().copied();
                        cases.push(decide(kind, role, state, variant, action, reason, 3));
                    }
                }
            }
        }
    }
    let question = ParticipationKind::Question;
    let pending = ModerationState::Pending;
    for (action, reason) in [
        (ModerationAction::Reject, None),
        (ModerationAction::Approve, Some(ReasonCode::Spam)),
        (ModerationAction::Reject, Some(ReasonCode::Unclear)),
        (ModerationAction::Reject, Some(ReasonCode::UpheldReport)),
        (
            ModerationAction::RequestClarification,
            Some(ReasonCode::Spam),
        ),
    ] {
        cases.push(decide(
            question,
            "site-admin",
            pending,
            "consented",
            action,
            reason,
            3,
        ));
    }
    cases.push(decide(
        ParticipationKind::AbuseReport,
        "site-admin",
        pending,
        "plain",
        ModerationAction::Reject,
        Some(ReasonCode::OffTopic),
        3,
    ));
    for expected in [2, 4] {
        cases.push(decide(
            question,
            "site-admin",
            pending,
            "plain",
            ModerationAction::Approve,
            None,
            expected,
        ));
    }
    cases
}

fn fixture_text() -> String {
    let cases: Vec<String> = matrix()
        .iter()
        .map(|case| serde_json::to_string(case).unwrap())
        .collect();
    format!(
        "{{\n  \"about\": \"Every moderation decision the inbox can ask for (ADRs 0102, 0103 and 0105), generated from openblog_core::moderation and checked by crates/openblog-core/tests/moderation_inbox.rs; netlify/lib/participation-moderation.mjs must agree with every case. Each case starts at version 3; facts: plain (revision 1, nobody asked, no consent), consented (revision 1, consent), asked (revision 1 asked about), answered (revision 2, revision 1 asked about). Regenerate with OPENBLOG_BLESS=1.\",\n  \"cases\": [\n    {}\n  ]\n}}\n",
        cases.join(",\n    ")
    )
}

#[test]
fn the_transitions_fixture_is_the_policy() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE_PATH);
    let expected = fixture_text();
    if std::env::var_os("OPENBLOG_BLESS").is_some() {
        std::fs::write(&path, &expected).unwrap();
    }
    let stored = std::fs::read_to_string(&path)
        .unwrap()
        .replace("\r\n", "\n");
    assert!(
        stored == expected,
        "tests/fixtures/participation-transitions.json is not what the policy decides; review the change and regenerate it with OPENBLOG_BLESS=1"
    );
    // Spot checks a reviewer can read.
    let fixture: Value = serde_json::from_str(&stored).unwrap();
    let find = |kind: &str, role: &str, state: &str, facts: &str, action: &str| {
        fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| {
                case["kind"] == kind
                    && case["role"] == role
                    && case["state"] == state
                    && case["facts"] == facts
                    && case["action"] == action
                    && case.get("expectedVersion").is_none()
            })
            .unwrap()
            .clone()
    };
    // The text a clarification asked about is never approved, and reopening
    // it after a rejection returns it to clarification.
    assert_eq!(
        find("question", "site-admin", "pending", "asked", "approve")["refused"],
        "notAllowed"
    );
    assert_eq!(
        find("question", "site-admin", "rejected", "asked", "reopen")["to"],
        "clarification"
    );
    assert_eq!(
        find("question", "site-admin", "rejected", "answered", "reopen")["to"],
        "pending"
    );
    assert_eq!(
        find("question", "site-admin", "pending", "answered", "approve")["approvedRevision"],
        2
    );
    // Clarification needs consent and is distinct from rejection.
    assert_eq!(
        find(
            "question",
            "site-admin",
            "pending",
            "plain",
            "request-clarification"
        )["refused"],
        "consentRequired"
    );
    assert_eq!(
        find(
            "question",
            "site-admin",
            "pending",
            "consented",
            "request-clarification"
        )["to"],
        "clarification"
    );
    assert_eq!(
        find(
            "comment",
            "site-admin",
            "pending",
            "plain",
            "request-clarification"
        )["refused"],
        "notAllowed"
    );
    // Removal is its own state; only the site Admin reopens; authors never moderate.
    assert_eq!(
        find("comment", "coordinator", "approved", "plain", "remove")["to"],
        "removed"
    );
    assert_eq!(
        find("comment", "coordinator", "removed", "plain", "reopen")["refused"],
        "denied"
    );
    assert_eq!(
        find(
            "comment",
            "contributing-author",
            "pending",
            "plain",
            "approve"
        )["refused"],
        "denied"
    );
    assert_eq!(
        find("comment", "site-admin", "rejected", "plain", "approve")["refused"],
        "notAllowed"
    );
}

// ---- Hosted items

const ID_1: &str = "00000000-0000-4000-8000-000000000001";
const ID_2: &str = "00000000-0000-4000-8000-000000000002";
const HOSTILE: &str = "<img src=x onerror=alert(1)> &amp; \u{202e}evil";
/// Passage feedback refuses bidirectional controls at submission (ADR 0079).
const HOSTILE_NOTE: &str = "<img src=x onerror=alert(1)> &amp; <script>";

fn comment(id: &str, path: &str, status: &str) -> Value {
    json!({
        "source": "comment", "id": id, "status": status, "version": 2,
        "moderatedAt": null, "reason": null,
        "comment": {"path": path, "authorName": "Grace", "body": "Line one.\nLine two.", "createdAt": "2026-10-26T10:00:00Z"},
    })
}

#[test]
fn hosted_comments_are_read_strictly_and_one_bad_item_never_hides_the_rest() {
    let item = InboxItem::from_value(&comment(ID_1, "/posts/tides/", "removed")).unwrap();
    assert_eq!(item.source, Source::Comment);
    assert_eq!(item.kind, ParticipationKind::Comment);
    assert_eq!(item.state, ModerationState::Removed);
    assert_eq!(item.revision, 1);
    let approved = InboxItem::from_value(&comment(ID_1, "/posts/tides/", "approved")).unwrap();
    assert_eq!(approved.approved_revision, Some(1));

    let mut bad = Vec::new();
    for (key, value) in [
        ("id", json!("../etc")),
        ("status", json!("clarification")),
        ("status", json!("withdrawn")),
        ("status", json!("published")),
        ("version", json!(0)),
        ("reason", json!("incorrect")),
        ("moderatedAt", json!("yesterday")),
        ("extra", json!(true)),
        ("source", json!("abuse")),
    ] {
        let mut row = comment(ID_1, "/posts/tides/", "pending");
        row[key] = value;
        bad.push(row);
    }
    for (key, value) in [
        ("path", json!("https://evil.example/")),
        ("path", json!("/posts/../admin/")),
        ("authorName", json!("")),
        ("authorName", json!("a\nb")),
        ("authorName", json!("x".repeat(81))),
        ("body", json!("x".repeat(4_001))),
        ("body", json!("bell \u{0007}")),
        ("createdAt", json!("2026-10-26T10:00:00.123456+00:00")),
    ] {
        let mut row = comment(ID_1, "/posts/tides/", "pending");
        row["comment"][key] = value;
        bad.push(row);
    }
    for row in &bad {
        let error = InboxItem::from_value(row).unwrap_err();
        assert!(
            !error.contains("evil") && !error.contains("bell"),
            "{error}"
        );
    }
    let mut hostile = comment(ID_2, "/posts/tides/", "pending");
    hostile["comment"]["body"] = json!(HOSTILE);
    let mut rows = bad.clone();
    rows.push(hostile);
    let page = read_page(&json!({"protocol": "full", "items": rows, "next": "2026-10-26T10:00:00.123456+00:00~00000000-0000-4000-8000-000000000002"})).unwrap();
    assert_eq!(page.invalid, bad.len());
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.protocol, Protocol::Full);
    assert!(page.next.is_some());
    for broken in [
        json!({"items": []}),
        json!({"protocol": "rd99", "items": []}),
        json!({"protocol": "full", "items": [], "next": "a b"}),
        json!({"protocol": "full", "items": {}}),
    ] {
        assert!(read_page(&broken).is_err(), "{broken}");
    }
}

// ---- Views per viewer

const SHARED: &str = "shared-tides";
const USERS: [&str; 5] = [
    "owner-admin",
    "coord-admin",
    "writer-admin",
    "editor-admin",
    "solo-admin",
];
const KEYS: [&str; 5] = ["owner", "coord", "writer", "editor", "solo"];

fn identities() -> Identities<'static> {
    Identities {
        active_admin_users: &USERS,
        contributor_ids: &KEYS,
    }
}

fn record() -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: SHARED.into(),
        title: "Tides, together".into(),
        guiding_question: String::new(),
        sources: vec![NewSourceReference {
            kind: SourceKind::Article,
            title: "Tide tables".into(),
            ..NewSourceReference::default()
        }],
        creator: NewParticipant {
            admin_user: "owner-admin".into(),
            contributor_id: "owner".into(),
            display_name: "Owner".into(),
        },
    })
    .unwrap();
    for (name, role) in [
        ("coord", AuthorizationRole::Coordinator),
        ("writer", AuthorizationRole::Contributor),
        ("editor", AuthorizationRole::Editor),
    ] {
        record.collaboration.participants.push(Participant {
            id: name.into(),
            display_name: name.into(),
            profile_url: None,
        });
        record.authorization.bindings.push(IdentityBinding {
            admin_user: format!("{name}-admin"),
            contributor_id: name.into(),
            participant_id: name.into(),
            roles: vec![role],
        });
    }
    record
}

const SITE: &str = r#"{"title":"T","url":"https://t.dev","postPath":"/posts/{slug}/","engagement":{"enabled":true,"feedback":true,"endpoint":"https://t.dev/api"}}"#;
const BODY: &str =
    "The moon causes the tides.\n\n## Methods\n\nWe measured the tides twice a day.\n";

fn site() -> Site {
    Site::load(
        SiteConfig::from_json(SITE).unwrap(),
        Sources {
            posts: [format!("posts/{SHARED}.md"), "posts/solo.md".to_string()]
                .into_iter()
                .map(|path| SourceFile {
                    path,
                    contents: format!("---\ntitle: Tides\ndate: 2026-01-01\n---\n{BODY}"),
                })
                .collect(),
            ..Sources::default()
        },
        LoadOptions::default(),
    )
    .unwrap()
}

/// A hosted feedback item about the whole of the post at `work`, from a
/// reader whose name is private.
fn feedback(site: &Site, id: &str, work: &str, status: &str, extra: Value) -> Value {
    let post = site.posts.iter().find(|post| post.url == work).unwrap();
    let document = PassageDocument::of_post(post, &site.config);
    let record = FeedbackSubmission::from_value(&json!({
        "version": 1, "kind": "question", "work": work, "revision": document.revision,
        "target": document.work_target().to_value(), "body": HOSTILE_NOTE,
        "attribution": {"name": "Private Reader", "publishName": false},
    }))
    .unwrap()
    .receive(
        DateTime::parse("2026-10-26T10:00:00Z").unwrap(),
        FeedbackChannel::Hosted,
    )
    .unwrap();
    let mut value = json!({
        "source": "feedback", "id": id, "status": status, "version": 1,
        "moderatedAt": null, "reason": null, "feedback": record.to_value(),
    });
    for (key, field) in extra.as_object().unwrap() {
        value[key] = field.clone();
    }
    value
}

fn inbox<'a>(
    site: &'a Site,
    works: &'a SharedWorks<'a>,
    identities: &'a Identities<'a>,
    principal: Principal<'a>,
    protocol: Protocol,
) -> Inbox<'a> {
    Inbox {
        site,
        works,
        principal,
        identities,
        policy: ModerationPolicy::default(),
        protocol,
        third_perspectives: true,
        now: DateTime::parse("2026-10-27T10:00:00Z").unwrap(),
    }
}

fn action_ids(view: &Value) -> Vec<&str> {
    view["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|action| action["action"].as_str().unwrap())
        .collect()
}

#[test]
fn each_viewer_gets_their_role_on_the_items_work_and_private_names_stay_with_the_site_admin() {
    let site = site();
    let records = [record()];
    let works = SharedWorks::new(&records, &site);
    let ids = identities();
    let shared = format!("/posts/{SHARED}/");
    let on_shared =
        InboxItem::from_value(&feedback(&site, ID_1, &shared, "pending", json!({}))).unwrap();
    let on_solo =
        InboxItem::from_value(&feedback(&site, ID_2, "/posts/solo/", "pending", json!({})))
            .unwrap();
    let session = |user| Principal::AdminSession { admin_user: user };

    // The token, and a session on a work outside every shared publication,
    // are the site Admin: the private name, every action that applies.
    for (principal, item) in [
        (Principal::ModerationToken, &on_shared),
        (session("solo-admin"), &on_solo),
        (session("coord-admin"), &on_solo),
    ] {
        let view = inbox(&site, &works, &ids, principal, Protocol::Full)
            .view(item)
            .unwrap();
        assert_eq!(view["role"], "site-admin");
        assert_eq!(view["reader"]["name"], "Private Reader");
        assert_eq!(action_ids(&view), ["approve", "reject"]);
        assert_eq!(view["public"], false, "pending is never public");
    }
    // A coordinator moderates the shared work but never sees the name; the
    // site owner of a publication is its coordinator.
    for user in ["coord-admin", "owner-admin"] {
        let view = inbox(&site, &works, &ids, session(user), Protocol::Full)
            .view(&on_shared)
            .unwrap();
        assert_eq!(view["role"], "coordinator", "{user}");
        assert!(view["reader"].get("name").is_none());
        assert_eq!(view["reader"]["private"], true);
        assert!(!view.to_string().contains("Private Reader"));
        assert_eq!(action_ids(&view), ["approve", "reject"]);
    }
    // A contributing author reads it and decides nothing.
    let view = inbox(&site, &works, &ids, session("writer-admin"), Protocol::Full)
        .view(&on_shared)
        .unwrap();
    assert_eq!(view["role"], "contributing-author");
    assert!(action_ids(&view).is_empty());
    assert!(!view.to_string().contains("Private Reader"));
    // An editor-only binding holds no moderation role: the item is not listed.
    assert!(
        inbox(&site, &works, &ids, session("editor-admin"), Protocol::Full)
            .view(&on_shared)
            .is_none()
    );

    // Reopening is the site Admin's alone.
    let removed =
        InboxItem::from_value(&feedback(&site, ID_1, &shared, "removed", json!({}))).unwrap();
    let as_admin = inbox(
        &site,
        &works,
        &ids,
        Principal::ModerationToken,
        Protocol::Full,
    );
    assert_eq!(action_ids(&as_admin.view(&removed).unwrap()), ["reopen"]);
    let as_coordinator = inbox(&site, &works, &ids, session("coord-admin"), Protocol::Full);
    assert!(action_ids(&as_coordinator.view(&removed).unwrap()).is_empty());
    assert_eq!(
        as_coordinator.decide(&removed, ModerationAction::Reopen, 1, None),
        Err(PolicyError::Denied)
    );
}

#[test]
fn the_text_a_clarification_asked_about_is_never_approved_and_reopens_to_clarification() {
    let site = site();
    let works = SharedWorks::new(&[], &site);
    let ids = identities();
    let asked = json!({"itemRevision": 1, "clarificationAsked": 1, "clarificationConsent": true});
    let inbox = inbox(
        &site,
        &works,
        &ids,
        Principal::ModerationToken,
        Protocol::Full,
    );
    let waiting = InboxItem::from_value(&feedback(
        &site,
        ID_1,
        "/posts/solo/",
        "clarification",
        asked.clone(),
    ))
    .unwrap();
    let view = inbox.view(&waiting).unwrap();
    assert_eq!(action_ids(&view), ["reject"]);
    assert_eq!(view["clarification"]["askedAboutThisText"], true);
    let rejected =
        InboxItem::from_value(&feedback(&site, ID_1, "/posts/solo/", "rejected", asked)).unwrap();
    assert_eq!(action_ids(&inbox.view(&rejected).unwrap()), ["reopen"]);
    let reopened = inbox
        .decide(&rejected, ModerationAction::Reopen, 1, None)
        .unwrap();
    assert_eq!(reopened.item.to, ModerationState::Clarification);
    // With consent, a pending item can be asked about; without, it cannot.
    let consented = InboxItem::from_value(&feedback(
        &site,
        ID_1,
        "/posts/solo/",
        "pending",
        json!({"clarificationConsent": true}),
    ))
    .unwrap();
    let view = inbox.view(&consented).unwrap();
    assert_eq!(
        action_ids(&view),
        ["approve", "request-clarification", "reject"]
    );
    let ask = &view["actions"][1];
    let reasons: Vec<&str> = ask["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        reasons,
        ["unclear", "needs-source", "personal-data", "other"]
    );
    assert!(ask["guidance"]
        .as_str()
        .unwrap()
        .contains("nothing is e-mailed"));
    // A stale version is refused whatever the action.
    assert_eq!(
        inbox.decide(&consented, ModerationAction::Approve, 2, None),
        Err(PolicyError::Stale)
    );
}

#[test]
fn an_older_hosted_schema_is_offered_only_what_it_can_store() {
    let site = site();
    let works = SharedWorks::new(&[], &site);
    let ids = identities();
    let legacy = inbox(
        &site,
        &works,
        &ids,
        Principal::ModerationToken,
        Protocol::Legacy,
    );
    let rejected_comment =
        InboxItem::from_value(&comment(ID_1, "/posts/solo/", "rejected")).unwrap();
    assert_eq!(
        action_ids(&legacy.view(&rejected_comment).unwrap()),
        ["reopen"]
    );
    let removed_feedback =
        InboxItem::from_value(&feedback(&site, ID_2, "/posts/solo/", "removed", json!({})))
            .unwrap();
    assert!(action_ids(&legacy.view(&removed_feedback).unwrap()).is_empty());
    assert_eq!(
        legacy.decide(&removed_feedback, ModerationAction::Reopen, 1, None),
        Err(PolicyError::NotAllowed)
    );
    let consented = InboxItem::from_value(&feedback(
        &site,
        ID_2,
        "/posts/solo/",
        "pending",
        json!({"clarificationConsent": true}),
    ))
    .unwrap();
    assert_eq!(
        action_ids(&legacy.view(&consented).unwrap()),
        ["approve", "reject"]
    );
}

#[test]
fn a_missing_post_is_shown_to_the_site_admin_with_nothing_public_and_hostile_text_stays_text() {
    let site = site();
    let records = [record()];
    let works = SharedWorks::new(&records, &site);
    let ids = identities();
    let mut row = comment(ID_1, "/posts/gone/", "approved");
    row["comment"]["body"] = json!(HOSTILE);
    let gone = InboxItem::from_value(&row).unwrap();
    let as_admin = inbox(
        &site,
        &works,
        &ids,
        Principal::AdminSession {
            admin_user: "solo-admin",
        },
        Protocol::Full,
    );
    let view = as_admin.view(&gone).unwrap();
    assert_eq!(view["post"], Value::Null);
    assert_eq!(view["mode"], "hidden");
    assert_eq!(view["public"], false);
    assert_eq!(view["body"], HOSTILE);
    assert_eq!(action_ids(&view), ["remove"]);
    // A co-writer bound in a shared publication cannot tell whether a path no
    // post has was a shared work, so it is not listed for them.
    let as_coordinator = inbox(
        &site,
        &works,
        &ids,
        Principal::AdminSession {
            admin_user: "coord-admin",
        },
        Protocol::Full,
    );
    assert!(as_coordinator.view(&gone).is_none());
}

/// A hosted suggested correction of the post's first section at `work`,
/// with `extra` fields (such as its stored decision log).
fn suggestion(site: &Site, id: &str, work: &str, status: &str, extra: Value) -> Value {
    let post = site.posts.iter().find(|post| post.url == work).unwrap();
    let document = PassageDocument::of_post(post, &site.config);
    let record = FeedbackSubmission::from_value(&json!({
        "version": 1, "kind": "correction-suggestion", "work": work, "revision": document.revision,
        "target": document.section_target(1).unwrap().to_value(), "body": "Twice a day is wrong.",
    }))
    .unwrap()
    .receive(
        DateTime::parse("2026-10-26T10:00:00Z").unwrap(),
        FeedbackChannel::Hosted,
    )
    .unwrap();
    let mut value = json!({
        "source": "feedback", "id": id, "status": status, "version": 1,
        "moderatedAt": null, "reason": null, "feedback": record.to_value(),
    });
    for (key, field) in extra.as_object().unwrap() {
        value[key] = field.clone();
    }
    value
}

#[test]
fn record_decision_is_offered_only_where_the_author_may_decide() {
    let site = site();
    let records = [record()];
    let works = SharedWorks::new(&records, &site);
    let ids = identities();
    let shared = format!("/posts/{SHARED}/");
    let session = |user| Principal::AdminSession { admin_user: user };
    let empty_log = |id: &str| json!({"decisions": {"version": 1, "item": id, "decisions": []}});
    let offered = |principal, value: &Value| {
        let item = InboxItem::from_value(value).unwrap();
        inbox(&site, &works, &ids, principal, Protocol::Full)
            .view(&item)
            .is_some_and(|view| view.get("recordDecision").is_some())
    };
    let pending = suggestion(&site, ID_1, &shared, "pending", empty_log(ID_1));
    let approved = suggestion(&site, ID_1, &shared, "approved", empty_log(ID_1));
    // The site Admin and the work's coordinator decide, on a pending or an
    // approved suggestion; a decision never waits on moderation.
    for value in [&pending, &approved] {
        assert!(offered(Principal::ModerationToken, value));
        assert!(offered(session("coord-admin"), value));
        assert!(offered(session("owner-admin"), value));
        // A contributing author reads it and responds, never decides.
        assert!(!offered(session("writer-admin"), value));
    }
    // Not where the hosted service keeps no decisions.
    let unstored = suggestion(&site, ID_1, &shared, "pending", json!({}));
    assert!(!offered(Principal::ModerationToken, &unstored));
    // Not on a closed item, nor on text a clarification asked about.
    for status in ["rejected", "removed"] {
        let closed = suggestion(&site, ID_1, &shared, status, empty_log(ID_1));
        assert!(!offered(Principal::ModerationToken, &closed), "{status}");
    }
    let mut asked = suggestion(&site, ID_1, &shared, "pending", empty_log(ID_1));
    asked["itemRevision"] = json!(1);
    asked["clarificationAsked"] = json!(1);
    assert!(!offered(Principal::ModerationToken, &asked));
    // A question is answered, never decided.
    let mut question = feedback(&site, ID_2, &shared, "pending", json!({}));
    question["decisions"] = json!({"version": 1, "item": ID_2, "decisions": []});
    assert!(!offered(Principal::ModerationToken, &question));
    // A log that is not the item's own is refused with the item.
    let foreign = suggestion(&site, ID_1, &shared, "pending", empty_log(ID_2));
    assert!(InboxItem::from_value(&foreign).is_err());
}
