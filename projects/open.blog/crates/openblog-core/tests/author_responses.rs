//! Author responses to Third Perspectives about one author's section (#223,
//! ADRs 0131 to 0135): the request Admin sends the hosted function, the row it
//! stores, the answer read back into the one moderation inbox, who sees and
//! decides it, and the checks that it still belongs under its parent. The pure
//! rules are held to `tests/fixtures/author-responses.json`, which
//! `netlify/lib/author-response.mjs` also reads.

use openblog_core::attributed_perspective::{
    admit_response, AttributedSections, ResponseRequest, Standing,
};
use openblog_core::author_response::{
    may_decide_answer, AuthorResponseRequest, HostedAuthorResponse, ParentFacts, ParentRow,
    StoredStanding,
};
use openblog_core::collaboration::{
    AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference,
    Participant, SharedPublication, SourceKind,
};
use openblog_core::config::SiteConfig;
use openblog_core::invitation::Identities;
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::moderation::{
    allowed_reasons, ModerationAction, ModerationPolicy, ModerationState, PolicyError, Principal,
    SharedWorks,
};
use openblog_core::moderation_inbox::{read_page, Inbox, InboxItem, Protocol, Source};
use openblog_core::participation::{ParticipationKind, ParticipationMode};
use openblog_core::passage_target::PassageDocument;
use openblog_core::reflection::{compose_bound, ComposedTurn, Placement, ReflectionLayout};
use openblog_core::third_perspective::{
    ConsentChoices, Intake, LocalReflection, PerspectiveTarget, ReaderAttribution, SubmittedCopy,
};
use openblog_core::DateTime;
use serde_json::{json, Value};

fn time(value: &str) -> DateTime {
    DateTime::parse(value).unwrap()
}

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/author-responses.json"
    ))
    .unwrap()
}

// ---------------------------------------------------------------------------
// The shared fixture

#[test]
fn shared_request_fixtures_read_and_receive_as_the_hosted_function_does() {
    let fixture = fixture();
    let received = time(fixture["receivedAt"].as_str().unwrap());
    let cases = fixture["requests"].as_array().unwrap();
    assert!(cases.len() >= 35);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let text = case["text"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| case["request"].to_string());
        let parent = ParentRow {
            revision: case["parent"]["revision"].as_str().unwrap().to_string(),
            target: PerspectiveTarget::from_value(&case["parent"]["target"]).unwrap(),
        };
        let outcome = AuthorResponseRequest::from_json(&text)
            .and_then(|request| request.row(&parent, received));
        let expect = &case["expect"];
        match (outcome, expect.get("row")) {
            (Ok(row), Some(want)) => assert_eq!(&row, want, "{name}: the stored row"),
            (Err(error), None) => assert_eq!(error.code, expect["code"], "{name}: {error}"),
            (Ok(_), None) => panic!("{name}: accepted, but {} was expected", expect["code"]),
            (Err(error), Some(_)) => panic!("{name}: refused with {error}"),
        }
    }
}

#[test]
fn shared_parent_fixtures_say_when_an_answer_belongs_under_its_parent() {
    let fixture = fixture();
    let cases = fixture["parents"].as_array().unwrap();
    assert!(cases.len() >= 15);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let facts = ParentFacts::from_value(&case["facts"]).unwrap();
        let outcome = facts.check_answer(
            case["work"].as_str().unwrap(),
            case["contributor"].as_str().unwrap(),
        );
        match (outcome, case["expect"].as_str().unwrap()) {
            (Ok(()), "ok") => {}
            (Err(code), want) => assert_eq!(code, want, "{name}"),
            (Ok(()), want) => panic!("{name}: allowed, but {want} was expected"),
        }
    }
}

#[test]
fn shared_decision_fixtures_say_who_may_decide_an_answer() {
    let fixture = fixture();
    for case in fixture["decisions"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let action = ModerationAction::from_id(case["action"].as_str().unwrap()).unwrap();
        let outcome = may_decide_answer(
            case["account"].as_str().unwrap(),
            case["decider"].as_str().unwrap(),
            action,
        );
        match case["expect"].as_str().unwrap() {
            "allowed" => assert_eq!(outcome, Ok(()), "{name}"),
            _ => assert_eq!(outcome, Err(PolicyError::Denied), "{name}"),
        }
    }
}

// ---------------------------------------------------------------------------
// A shared work with an arranged body and credits

const PUBLICATION: &str = "shared-tides";
const WORK: &str = "/posts/shared-tides/";
const ID_PARENT: &str = "00000000-0000-4000-8000-000000000001";
const ID_ANSWER: &str = "00000000-0000-4000-8000-000000000002";
const USERS: [&str; 5] = [
    "owner-admin",
    "coord-admin",
    "mina-admin",
    "joe-admin",
    "rea-admin",
];
const KEYS: [&str; 5] = ["owner", "coord", "mina", "joe", "rea"];
const TURNS: [(&str, &str); 3] = [
    ("MINA", "The moon pulls the water."),
    ("JOE", "It is also the sun."),
    ("MINA", "Neither explains the harbour."),
];
const CREDITS: &str = r#"{"version":1,"credits":[
  {"contributor":"mina","roles":[{"vocabulary":"crossref","role":"author"}]},
  {"contributor":"joe","roles":[{"vocabulary":"crossref","role":"author"}]}]}"#;

fn identities() -> Identities<'static> {
    Identities {
        active_admin_users: &USERS,
        contributor_ids: &KEYS,
    }
}

fn member(record: &mut SharedPublication, name: &str, role: AuthorizationRole) {
    record.collaboration.participants.push(Participant {
        id: format!("p-{name}"),
        display_name: name.to_uppercase(),
        profile_url: None,
    });
    record.authorization.bindings.push(IdentityBinding {
        admin_user: format!("{name}-admin"),
        contributor_id: name.into(),
        participant_id: format!("p-{name}"),
        roles: vec![role],
    });
}

fn record() -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: PUBLICATION.into(),
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
            display_name: "OWNER".into(),
        },
    })
    .unwrap();
    member(&mut record, "coord", AuthorizationRole::Coordinator);
    member(&mut record, "mina", AuthorizationRole::Contributor);
    member(&mut record, "joe", AuthorizationRole::Contributor);
    member(&mut record, "rea", AuthorizationRole::Reader);
    record
}

fn arranged(turns: &[(&str, &str)]) -> String {
    let composed: Vec<ComposedTurn<'_>> = turns
        .iter()
        .enumerate()
        .map(|(round, (name, text))| ComposedTurn {
            round,
            round_prompt: None,
            display_name: name,
            label: None,
            placement: Placement { lane: 0, lanes: 1 },
            body: (*text).to_string(),
        })
        .collect();
    let keys: Vec<String> = turns.iter().map(|(name, _)| name.to_lowercase()).collect();
    let bound: Vec<Option<&str>> = keys.iter().map(|key| Some(key.as_str())).collect();
    compose_bound(ReflectionLayout::Sequential, &composed, &bound)
}

const SITE_JSON: &str = r#"{"title":"T","url":"https://t.dev","postPath":"/posts/{slug}/",
  "author":{"name":"Site Author"},
  "contributors":{"mina":{"name":"Mina"},"joe":{"name":"Joe"}},
  "engagement":{"enabled":true,"endpoint":"https://t.dev/api"},
  "participation":{"kinds":{"third-perspective":"open","author-response":"open"}}}"#;

fn site_with(json: &str, body: &str, credits: bool) -> Site {
    Site::load(
        SiteConfig::from_json(json).unwrap(),
        Sources {
            posts: vec![SourceFile {
                path: format!("posts/{PUBLICATION}.md"),
                contents: format!("---\ntitle: Tides, together\ndate: 2026-01-01\n---\n{body}"),
            }],
            credits: if credits {
                vec![SourceFile {
                    path: format!("posts/{PUBLICATION}.credits.json"),
                    contents: CREDITS.into(),
                }]
            } else {
                Vec::new()
            },
            ..Sources::default()
        },
        LoadOptions::default(),
    )
    .unwrap()
}

fn site() -> Site {
    site_with(SITE_JSON, &arranged(&TURNS), true)
}

/// The Third Perspective a reader wrote about MINA's first section, as the
/// hosted inbox returns it, `approved` or not.
fn perspective_copy(site: &Site, section: usize) -> (SubmittedCopy, PerspectiveTarget) {
    let post = &site.posts[0];
    let published = AttributedSections::of_post(post);
    assert_eq!(
        published.sections().len(),
        3,
        "the post attributes its turns"
    );
    let target = published.sections()[section].target().perspective_target();
    let document = PassageDocument::of_post(post, &site.config);
    let copy = LocalReflection {
        work: post.url.clone(),
        revision: document.revision,
        target: target.clone(),
        category: None,
        body: "I read the harbour differently.".into(),
        attribution: ReaderAttribution::anonymous(),
        seen_at: None,
    }
    .submission(ConsentChoices {
        publish: true,
        clarification: false,
        feature: false,
    })
    .receive(
        time("2026-10-26T10:00:00Z"),
        Intake::Hosted {
            receipt_digest: "5e".repeat(32),
        },
    )
    .unwrap();
    (copy, target)
}

fn hosted_perspective(copy: &SubmittedCopy, status: &str) -> Value {
    let record: Value = serde_json::from_str(&copy.to_json()).unwrap();
    let approved = status == "approved";
    json!({
        "source": "feedback", "id": ID_PARENT, "status": status, "version": 3,
        "moderatedAt": null, "reason": null,
        "feedback": {"version": 1, "kind": "third-perspective", "body": copy.body, "details": copy.stored_details(), "provenance": record["provenance"]},
        "itemRevision": 1, "approvedRevision": if approved { json!(1) } else { Value::Null },
        "clarificationAsked": null, "clarificationConsent": false,
        "approvedConsent": if approved { json!(1) } else { Value::Null },
    })
}

/// The hosted inbox item of an answer, built as engagement.mjs's
/// `hostedFeedback` builds it from the stored row.
fn hosted_answer(row: &Value, status: &str, version: u64) -> Value {
    let approved = status == "approved";
    json!({
        "source": "feedback", "id": ID_ANSWER, "status": status, "version": version,
        "moderatedAt": null, "reason": null,
        "feedback": {
            "version": 1, "kind": "author-response", "body": row["body"], "details": row["details"],
            "provenance": {
                "version": 1, "work": row["work"], "revision": row["revision"], "target": row["target"],
                "receivedAt": row["received_at"], "channel": "hosted", "attribution": {"publishName": false},
            },
        },
        "itemRevision": 1, "approvedRevision": if approved { json!(1) } else { Value::Null },
        "clarificationAsked": null, "clarificationConsent": false,
    })
}

/// MINA's admitted answer to the reader's perspective, as the request Admin
/// would send, and its stored row.
fn answer(
    site: &Site,
    record: &SharedPublication,
    admin_user: &str,
) -> (AuthorResponseRequest, Value) {
    let (copy, target) = perspective_copy(site, 0);
    let parent_item = InboxItem::from_value(&hosted_perspective(&copy, "approved")).unwrap();
    let records = [record.clone()];
    let works = SharedWorks::new(&records, site);
    let identities = identities();
    let facts = parent_item.facts();
    let admitted = admit_response(
        &ModerationPolicy::new(Default::default()),
        &ResponseRequest {
            id: ID_ANSWER,
            record,
            identities: &identities,
            admin_user,
            works: &works,
            work: WORK,
            mode: ParticipationMode::Open,
            parent: &facts,
            parent_mode: ParticipationMode::Open,
            parent_target: &target,
            body: &arranged(&TURNS),
            credits: Some(CREDITS),
            registry: &site.config.contributors,
            at: time("2026-10-27T10:00:00Z"),
        },
    )
    .expect("mina answers her own section");
    let request = AuthorResponseRequest::from_json(
        &json!({
            "version": 1, "kind": "author-response", "work": WORK,
            "parent": {"id": ID_PARENT, "version": 3},
            "body": "I meant the harbour.",
            "responder": {
                "contributor": admitted.responder.contributor, "author": admitted.responder.author,
                "standing": StoredStanding::of(&admitted.responder.standing).to_value(),
            },
            "binding": {"participant": admitted.responder.participant},
            "actor": admin_user,
        })
        .to_string(),
    )
    .unwrap();
    let row = request
        .row(
            &ParentRow {
                revision: copy.provenance.revision.clone(),
                target,
            },
            time("2026-10-27T10:00:00Z"),
        )
        .unwrap();
    (request, row)
}

// ---------------------------------------------------------------------------
// Storing and reading an answer

fn inbox<'a>(
    site: &'a Site,
    works: &'a SharedWorks<'a>,
    identities: &'a Identities<'a>,
    principal: Principal<'a>,
    third_perspectives: bool,
) -> Inbox<'a> {
    Inbox {
        site,
        works,
        principal,
        identities,
        policy: ModerationPolicy::default(),
        protocol: Protocol::Protected,
        third_perspectives,
        now: time("2026-10-28T10:00:00Z"),
    }
}

fn session(admin_user: &str) -> Principal<'_> {
    Principal::AdminSession { admin_user }
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
fn an_admitted_answer_becomes_one_pending_row_with_its_responder() {
    let site = site();
    let record = record();
    let (request, row) = answer(&site, &record, "mina-admin");
    // The request survives its own JSON.
    assert_eq!(
        AuthorResponseRequest::from_json(&request.to_json()).unwrap(),
        request
    );
    // The row copies the parent's revision and target, keeps the public
    // responder and the private binding apart, and holds nothing of a reader.
    assert_eq!(row["kind"], "author-response");
    assert_eq!(row["work"], WORK);
    assert_eq!(row["target"]["section"], "ob-by-mina-0");
    assert_eq!(row["details"]["parent"], ID_PARENT);
    assert_eq!(row["details"]["responder"]["contributor"], "mina");
    assert_eq!(row["details"]["responder"]["author"], "MINA");
    assert_eq!(
        row["details"]["responder"]["standing"],
        json!({"state": "current", "moved": false})
    );
    assert_eq!(row["details"]["binding"]["participant"], "p-mina");
    assert_eq!(row["details"]["binding"]["account"], "mina-admin");
    assert!(
        !row["details"]["responder"].to_string().contains("p-mina"),
        "the public part never names the participant or the account"
    );
    assert_eq!(row["reader_name"], Value::Null);
    assert_eq!(row["clarification_consent"], false);

    // Read back as the inbox reads it.
    let item = InboxItem::from_value(&hosted_answer(&row, "pending", 1)).unwrap();
    assert_eq!(item.kind, ParticipationKind::AuthorResponse);
    assert_eq!(item.state, ModerationState::Pending);
    assert!(Source::Feedback.holds(ParticipationKind::AuthorResponse));
    let hosted = item.author_response().unwrap();
    assert_eq!(hosted.responder.contributor, "mina");
    assert_eq!(hosted.parent, ID_PARENT);
    assert_eq!(item.facts().work, Some(WORK));
}

#[test]
fn a_stored_answer_that_breaks_any_rule_is_refused_on_its_own() {
    let site = site();
    let record = record();
    let (_, row) = answer(&site, &record, "mina-admin");
    let good = hosted_answer(&row, "pending", 1);
    assert!(InboxItem::from_value(&good).is_ok());
    // A function that keeps correction decisions sends every feedback row's
    // empty log; an answer takes no decision, so it is not read.
    let mut with_log = good.clone();
    with_log["decisions"] = json!({"version": 1, "item": ID_ANSWER, "decisions": []});
    assert!(InboxItem::from_value(&with_log).is_ok());
    // A log that holds a decision is still refused: an answer takes none.
    let mut held = good.clone();
    held["decisions"] = json!({"version": 1, "item": ID_ANSWER, "decisions": [{"sequence": 1}]});
    assert!(InboxItem::from_value(&held).is_err());
    let mut bare = good.clone();
    bare.as_object_mut().unwrap().remove("source");
    assert!(HostedAuthorResponse::from_value(&bare).is_ok());
    let refused = |change: &dyn Fn(&mut Value)| {
        let mut value = good.clone();
        change(&mut value);
        InboxItem::from_value(&value).is_err()
    };
    // An answer about another contributor's section than its responder's.
    assert!(refused(
        &|v| v["feedback"]["details"]["responder"]["contributor"] = json!("joe")
    ));
    // No parent, no binding, an unknown standing, an account that is not one.
    assert!(refused(&|v| {
        v["feedback"]["details"]
            .as_object_mut()
            .unwrap()
            .remove("parent");
    }));
    assert!(refused(&|v| {
        v["feedback"]["details"]
            .as_object_mut()
            .unwrap()
            .remove("binding");
    }));
    assert!(refused(
        &|v| v["feedback"]["details"]["responder"]["standing"] = json!({"state": "gone"})
    ));
    assert!(refused(
        &|v| v["feedback"]["details"]["binding"]["account"] = json!("@moderation-token")
    ));
    // A reader's clarification or consent on an answer, a second revision, an
    // unknown field, a body with a control character, a target of the work.
    assert!(refused(&|v| v["clarificationConsent"] = json!(true)));
    assert!(refused(&|v| v["clarificationAsked"] = json!(1)));
    assert!(refused(&|v| v["itemRevision"] = json!(2)));
    assert!(refused(&|v| v["rank"] = json!(1)));
    assert!(refused(&|v| v["feedback"]["body"] = json!("a\u{0}b")));
    assert!(refused(
        &|v| v["feedback"]["provenance"]["target"] = json!({"version": 1, "kind": "work"})
    ));
    // A purged answer keeps only its facts.
    let purged = InboxItem::from_value(&json!({
        "source": "feedback", "id": ID_ANSWER, "kind": "author-response", "status": "withdrawn", "version": 4, "revision": 1,
        "moderatedAt": "2026-10-27T10:00:00Z", "reason": null, "receivedAt": "2026-10-26T10:00:00Z",
        "work": WORK, "purgedAt": "2026-10-27T10:00:00Z",
    }))
    .unwrap();
    assert_eq!(purged.kind, ParticipationKind::AuthorResponse);
    let page = read_page(
        &json!({"protocol": "protected", "thirdPerspectives": true, "items": [good], "next": null}),
    )
    .unwrap();
    assert_eq!(page.items.len(), 1);
}

#[test]
fn a_coordinator_decides_an_answer_and_the_author_never_does() {
    let site = site();
    let record = record();
    let (_, row) = answer(&site, &record, "mina-admin");
    let item = InboxItem::from_value(&hosted_answer(&row, "pending", 1)).unwrap();
    let records = [record.clone()];
    let works = SharedWorks::new(&records, &site);
    let identities = identities();

    let coordinator = inbox(&site, &works, &identities, session("coord-admin"), true);
    let view = coordinator.view(&item).unwrap();
    assert_eq!(view["kind"], "author-response");
    assert_eq!(view["kindLabel"], "Author response");
    assert_eq!(view["body"], "I meant the harbour.");
    assert_eq!(view["response"]["contributor"], "mina");
    assert_eq!(view["response"]["author"], "MINA");
    assert_eq!(view["response"]["parent"], ID_PARENT);
    assert!(view["response"].get("participant").is_none());
    assert!(
        !view.to_string().contains("p-mina"),
        "the participant binding is never shown"
    );
    // Clarification never applies to an author, so only these are offered.
    assert_eq!(action_ids(&view), ["approve", "reject"]);
    assert!(coordinator
        .decide(&item, ModerationAction::Approve, 1, None)
        .is_ok());
    assert_eq!(
        coordinator
            .decide(&item, ModerationAction::RequestClarification, 1, None)
            .unwrap_err(),
        PolicyError::NotAllowed
    );
    // Approving needs the hosted function to record answers (the same opt-in).
    let without = inbox(&site, &works, &identities, session("coord-admin"), false);
    assert_eq!(
        without
            .decide(&item, ModerationAction::Approve, 1, None)
            .unwrap_err(),
        PolicyError::NotAllowed
    );
    let reason = allowed_reasons(ModerationAction::Reject, ParticipationKind::AuthorResponse)
        .first()
        .copied();
    assert!(without
        .decide(&item, ModerationAction::Reject, 1, reason)
        .is_ok());

    // The author is a contributing author: moderation is not theirs.
    let author = inbox(&site, &works, &identities, session("mina-admin"), true);
    assert!(author
        .decide(&item, ModerationAction::Approve, 1, None)
        .is_err());
    // Another contributor and a reader see nothing at all.
    for admin_user in ["joe-admin", "rea-admin"] {
        let other = inbox(&site, &works, &identities, session(admin_user), true);
        assert!(other
            .decide(&item, ModerationAction::Approve, 1, None)
            .is_err());
    }
}

#[test]
fn a_coordinator_who_is_also_the_author_cannot_approve_their_own_answer() {
    let site = site();
    let mut record = record();
    // MINA is a coordinator as well as a contributor.
    for binding in &mut record.authorization.bindings {
        if binding.participant_id == "p-mina" {
            binding.roles = vec![
                AuthorizationRole::Coordinator,
                AuthorizationRole::Contributor,
            ];
        }
    }
    let (_, row) = answer(&site, &record, "mina-admin");
    let item = InboxItem::from_value(&hosted_answer(&row, "pending", 1)).unwrap();
    let records = [record.clone()];
    let works = SharedWorks::new(&records, &site);
    let identities = identities();
    let mina = inbox(&site, &works, &identities, session("mina-admin"), true);
    assert_eq!(
        mina.decide(&item, ModerationAction::Approve, 1, None)
            .unwrap_err(),
        PolicyError::Denied,
        "nobody approves their own answer"
    );
    // The view does not offer what the decision refuses.
    let view = mina.view(&item).unwrap();
    assert!(!action_ids(&view).contains(&"approve"), "{view}");
    // Another coordinator can.
    let coord = inbox(&site, &works, &identities, session("coord-admin"), true);
    assert!(coord
        .decide(&item, ModerationAction::Approve, 1, None)
        .is_ok());
}

#[test]
fn an_answer_is_approved_only_under_a_shown_parent_about_its_own_contributor() {
    let site = site();
    let record = record();
    let (_, row) = answer(&site, &record, "mina-admin");
    let item = InboxItem::from_value(&hosted_answer(&row, "pending", 1)).unwrap();
    let records = [record.clone()];
    let works = SharedWorks::new(&records, &site);
    let identities = identities();
    let coordinator = inbox(&site, &works, &identities, session("coord-admin"), true);
    let (copy, _) = perspective_copy(&site, 0);
    let parent = |status: &str| InboxItem::from_value(&hosted_perspective(&copy, status)).unwrap();

    assert_eq!(
        coordinator.check_answer_approval(&item, &parent("approved")),
        Ok(())
    );
    for status in ["pending", "rejected", "removed", "withdrawn"] {
        assert_eq!(
            coordinator.check_answer_approval(&item, &parent(status)),
            Err("parentUnavailable"),
            "{status}"
        );
    }
    // A perspective about JOE's section is not one MINA answers.
    let (joe_copy, _) = perspective_copy(&site, 1);
    let about_joe = InboxItem::from_value(&hosted_perspective(&joe_copy, "approved")).unwrap();
    assert_eq!(
        coordinator.check_answer_approval(&item, &about_joe),
        Err("responderMismatch")
    );
    // An answer under another parent id is not under this one.
    let mut other = hosted_perspective(&copy, "approved");
    other["id"] = json!("00000000-0000-4000-8000-0000000000ff");
    assert_eq!(
        coordinator.check_answer_approval(&item, &InboxItem::from_value(&other).unwrap()),
        Err("parentUnavailable")
    );
    // A post that no longer shows Third Perspectives takes the answer's parent
    // out of view with it.
    let hidden_site = site_with(
        &SITE_JSON.replace(
            r#""third-perspective":"open""#,
            r#""third-perspective":"off""#,
        ),
        &arranged(&TURNS),
        true,
    );
    let hidden_works = SharedWorks::new(&records, &hidden_site);
    let hidden = inbox(
        &hidden_site,
        &hidden_works,
        &identities,
        session("coord-admin"),
        true,
    );
    assert_eq!(
        hidden.check_answer_approval(&item, &parent("approved")),
        Err("parentUnavailable")
    );
}

#[test]
fn only_the_sections_own_contributor_is_offered_to_answer_it() {
    let site = site();
    let record = record();
    let (copy, _) = perspective_copy(&site, 0);
    let parent = InboxItem::from_value(&hosted_perspective(&copy, "approved")).unwrap();
    let records = [record.clone()];
    let works = SharedWorks::new(&records, &site);
    let identities = identities();
    // MINA wrote the section; the contributor hears who she answers as.
    let mina = inbox(&site, &works, &identities, session("mina-admin"), true);
    let offer = mina.answer_as(&parent).unwrap();
    assert_eq!(offer["contributor"], "mina");
    assert_eq!(offer["author"], "MINA");
    assert_eq!(
        offer["standing"],
        json!({"state": "current", "moved": false})
    );
    // Nobody else is offered anything, and nothing says they could be.
    for principal in [
        session("joe-admin"),
        session("coord-admin"),
        session("owner-admin"),
        session("rea-admin"),
        session("nobody"),
        Principal::ModerationToken,
    ] {
        let other = inbox(&site, &works, &identities, principal, true);
        assert_eq!(other.answer_as(&parent), None, "{principal:?}");
        if let Some(view) = other.view(&parent) {
            assert!(view.get("answerAs").is_none(), "{principal:?}");
        }
    }
    // A pending perspective is not answered, and neither is one the post no
    // longer opens answers on.
    let pending = InboxItem::from_value(&hosted_perspective(&copy, "pending")).unwrap();
    assert_eq!(mina.answer_as(&pending), None);
    let locked_site = site_with(
        &SITE_JSON.replace(
            r#""author-response":"open""#,
            r#""author-response":"locked""#,
        ),
        &arranged(&TURNS),
        true,
    );
    let locked_works = SharedWorks::new(&records, &locked_site);
    let locked = inbox(
        &locked_site,
        &locked_works,
        &identities,
        session("mina-admin"),
        true,
    );
    assert_eq!(locked.answer_as(&parent), None);
}

#[test]
fn the_moderators_check_of_a_section_uses_the_authors_published_sections() {
    let record = record();
    let records = [record.clone()];
    let identities = identities();
    let original = site();
    let (copy, _) = perspective_copy(&original, 0);
    let parent = InboxItem::from_value(&hosted_perspective(&copy, "pending")).unwrap();
    let works = SharedWorks::new(&records, &original);
    let current = inbox(&original, &works, &identities, session("coord-admin"), true)
        .view(&parent)
        .unwrap();
    assert_eq!(current["perspective"]["check"], "current");
    assert_eq!(current["perspective"]["attributed"]["contributor"], "mina");
    assert_eq!(current["perspective"]["attributed"]["author"], "MINA");

    // MINA's first section is later rewritten: stale, never other words.
    let edited_turns = [("MINA", "Rewritten."), TURNS[1], TURNS[2]];
    let edited = site_with(SITE_JSON, &arranged(&edited_turns), true);
    let edited_works = SharedWorks::new(&records, &edited);
    let stale = inbox(
        &edited,
        &edited_works,
        &identities,
        session("coord-admin"),
        true,
    )
    .view(&parent)
    .unwrap();
    assert_eq!(stale["perspective"]["check"], "stale");
    assert_eq!(
        stale["perspective"]["attributed"]["standing"],
        json!({"state": "stale", "reason": "section-changed-or-removed"})
    );
    // Without a credits sidecar nothing is attributed: the check is stale and
    // names no author, rather than guessing one.
    let uncredited = site_with(SITE_JSON, &arranged(&TURNS), false);
    let uncredited_works = SharedWorks::new(&records, &uncredited);
    let view = inbox(
        &uncredited,
        &uncredited_works,
        &identities,
        session("coord-admin"),
        true,
    )
    .view(&parent)
    .unwrap();
    assert_eq!(view["perspective"]["check"], "stale");
    assert_eq!(
        view["perspective"]["attributed"]["standing"],
        json!({"state": "stale", "reason": "author-absent"})
    );
    let _ = Standing::Stale {
        reason: openblog_core::attributed_perspective::StaleReason::Ambiguous,
        author: None,
    };
}

#[test]
fn only_the_author_who_wrote_an_answer_takes_it_back_and_only_while_still_bound() {
    let site = site();
    let record = record();
    let (_, row) = answer(&site, &record, "mina-admin");
    let pending = InboxItem::from_value(&hosted_answer(&row, "pending", 1)).unwrap();
    let approved = InboxItem::from_value(&hosted_answer(&row, "approved", 2)).unwrap();
    let rejected = InboxItem::from_value(&hosted_answer(&row, "rejected", 2)).unwrap();
    let records = [record.clone()];
    let works = SharedWorks::new(&records, &site);
    let identities = identities();

    let mina = inbox(&site, &works, &identities, session("mina-admin"), true);
    assert!(mina.may_withdraw(&pending));
    let decision = mina.withdraw_answer(&approved, 2).unwrap();
    assert_eq!(decision.item.to, ModerationState::Withdrawn);
    assert_eq!(
        decision.item.audit.actor,
        openblog_core::moderation::ActorRole::Submitter
    );
    // A rejected answer is closed already; a stale version is stale.
    assert_eq!(
        mina.withdraw_answer(&rejected, 2).unwrap_err(),
        PolicyError::NotAllowed
    );
    assert_eq!(
        mina.withdraw_answer(&pending, 9).unwrap_err(),
        PolicyError::Stale
    );
    // The view tells only the author that it is theirs and may be taken back.
    let view = mina.view(&pending).unwrap();
    assert_eq!(view["response"]["mine"], true);
    assert_eq!(view["response"]["withdrawable"], true);
    assert!(
        !action_ids(&view).contains(&"approve"),
        "a contributing author moderates nothing"
    );

    // Nobody else: not another contributor, not a coordinator, not the owner,
    // not the moderation token. A coordinator removes instead.
    for principal in [
        session("joe-admin"),
        session("coord-admin"),
        session("owner-admin"),
        session("rea-admin"),
        Principal::ModerationToken,
    ] {
        let other = inbox(&site, &works, &identities, principal, true);
        assert!(!other.may_withdraw(&pending), "{principal:?}");
        assert_eq!(
            other.withdraw_answer(&pending, 1).unwrap_err(),
            PolicyError::Denied,
            "{principal:?}"
        );
        if let Some(view) = other.view(&pending) {
            assert_eq!(view["response"]["mine"], false, "{principal:?}");
            assert_eq!(view["response"]["withdrawable"], false, "{principal:?}");
        }
    }

    // Revoked membership: the account is no longer bound, no longer a
    // contributor, or its participant is gone. It may still take its own
    // words back (taking words down is never the risk); approving is where
    // the binding is checked again.
    let revoked = |change: &dyn Fn(&mut SharedPublication)| {
        let mut changed = record.clone();
        change(&mut changed);
        let records = [changed];
        let works = SharedWorks::new(&records, &site);
        let mina = inbox(&site, &works, &identities, session("mina-admin"), true);
        (
            mina.may_withdraw(&pending),
            mina.withdraw_answer(&pending, 1).is_ok(),
        )
    };
    let unbound: &dyn Fn(&mut SharedPublication) = &|r| {
        r.authorization
            .bindings
            .retain(|binding| binding.participant_id != "p-mina")
    };
    let demoted: &dyn Fn(&mut SharedPublication) = &|r| {
        for binding in &mut r.authorization.bindings {
            if binding.participant_id == "p-mina" {
                binding.roles = vec![AuthorizationRole::Editor];
            }
        }
    };
    let gone: &dyn Fn(&mut SharedPublication) = &|r| {
        r.collaboration
            .participants
            .retain(|participant| participant.id != "p-mina")
    };
    for change in [unbound, demoted, gone] {
        assert_eq!(revoked(change), (true, true));
    }
}

#[test]
fn approval_checks_the_responder_against_the_record_again() {
    let site = site();
    let record = record();
    let (_, row) = answer(&site, &record, "mina-admin");
    let item = InboxItem::from_value(&hosted_answer(&row, "pending", 1)).unwrap();
    let (copy, _) = perspective_copy(&site, 0);
    let parent = InboxItem::from_value(&hosted_perspective(&copy, "approved")).unwrap();
    let identities = identities();
    let check = |record: &SharedPublication, item: &InboxItem| {
        let records = [record.clone()];
        let works = SharedWorks::new(&records, &site);
        inbox(&site, &works, &identities, session("coord-admin"), true)
            .check_answer_approval(item, &parent)
    };
    assert_eq!(check(&record, &item), Ok(()));

    // Membership revoked after the answer was written: unbound, demoted to a
    // reader, or the participant removed. None is approved.
    let mut unbound = record.clone();
    unbound
        .authorization
        .bindings
        .retain(|binding| binding.participant_id != "p-mina");
    assert_eq!(check(&unbound, &item), Err("denied"));
    let mut demoted = record.clone();
    for binding in &mut demoted.authorization.bindings {
        if binding.participant_id == "p-mina" {
            binding.roles = vec![AuthorizationRole::Reader];
        }
    }
    assert_eq!(check(&demoted, &item), Err("denied"));
    let mut rebound = record.clone();
    for binding in &mut rebound.authorization.bindings {
        if binding.participant_id == "p-mina" {
            binding.contributor_id = "joe".into();
        }
    }
    assert_eq!(check(&rebound, &item), Err("denied"));

    // Rows forged with the moderation token: the stored responder names an
    // account that is not bound to that participant, a participant that is
    // not that contributor, or a contributor nobody is bound to.
    for (account, participant, contributor) in [
        ("joe-admin", "p-mina", "mina"),
        ("mina-admin", "p-joe", "mina"),
        ("coord-admin", "p-coord", "mina"),
        ("ghost-admin", "p-ghost", "mina"),
        ("mina-admin", "p-nobody", "mina"),
    ] {
        let mut forged = hosted_answer(&row, "pending", 1);
        forged["feedback"]["details"]["binding"]["account"] = json!(account);
        forged["feedback"]["details"]["binding"]["participant"] = json!(participant);
        forged["feedback"]["details"]["responder"]["contributor"] = json!(contributor);
        let forged = InboxItem::from_value(&forged).unwrap();
        assert_eq!(
            check(&record, &forged),
            Err("denied"),
            "{account} {participant} {contributor}"
        );
    }
}

#[test]
fn a_same_name_invite_after_publication_never_lets_a_namesake_answer() {
    // After publication someone is invited whose display name is MINA's. The
    // committed credits still name the registry key `mina`, so the namesake's
    // binding (contributor `mina2`) is not the section's author.
    let site = site();
    let mut record = record();
    member(&mut record, "mina2", AuthorizationRole::Contributor);
    record
        .collaboration
        .participants
        .last_mut()
        .unwrap()
        .display_name = "MINA".into();
    let users = [
        "owner-admin",
        "coord-admin",
        "mina-admin",
        "joe-admin",
        "rea-admin",
        "mina2-admin",
    ];
    let keys = ["owner", "coord", "mina", "joe", "rea", "mina2"];
    let identities = Identities {
        active_admin_users: &users,
        contributor_ids: &keys,
    };
    let (copy, _) = perspective_copy(&site, 0);
    let parent = InboxItem::from_value(&hosted_perspective(&copy, "approved")).unwrap();
    let records = [record.clone()];
    let works = SharedWorks::new(&records, &site);
    let mina = inbox(&site, &works, &identities, session("mina-admin"), true);
    assert_eq!(mina.answer_as(&parent).unwrap()["contributor"], "mina");
    let namesake = inbox(&site, &works, &identities, session("mina2-admin"), true);
    assert_eq!(namesake.answer_as(&parent), None);
}
