//! Third Perspectives in the one moderation inbox (#221, ADRs 0111 and 0113):
//! a hosted row read back into a checked copy, shown to moderators with its
//! category, the consent in effect and the credit-name hint, never with the
//! reader's private name for anyone but the site Admin, and approved only
//! where the hosted service records the consent an approval covers, at the
//! text revision and consent record the moderator saw.

use openblog_core::collaboration::{
    AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference,
    Participant, SharedPublication, SourceKind,
};
use openblog_core::config::SiteConfig;
use openblog_core::invitation::Identities;
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::moderation::{ModerationPolicy, ModerationState, Principal, SharedWorks};
use openblog_core::moderation_inbox::{read_page, Inbox, InboxItem, Protocol, Source};
use openblog_core::participation::ParticipationKind;
use openblog_core::passage_target::PassageDocument;
use openblog_core::third_perspective::{
    HostedPerspective, Intake, LifecycleError, LocalReflection, PerspectiveTarget,
    ReaderAttribution, ResponseCategory, SubmittedCopy,
};
use openblog_core::DateTime;
use serde_json::{json, Value};

const ID: &str = "00000000-0000-4000-8000-000000000001";
const SITE: &str = r#"{"title":"T","url":"https://t.dev","postPath":"/posts/{slug}/","author":{"name":"Ada Lovelace"},
  "engagement":{"enabled":true,"endpoint":"https://t.dev/api"},
  "participation":{"kinds":{"third-perspective":"open"}}}"#;
const BODY: &str =
    "The moon causes the tides.\n\n## Methods\n\nWe measured the tides twice a day.\n";

fn time(value: &str) -> DateTime {
    DateTime::parse(value).unwrap()
}

fn site() -> Site {
    Site::load(
        SiteConfig::from_json(SITE).unwrap(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/tides.md".into(),
                contents: format!("---\ntitle: Tides\ndate: 2026-01-01\n---\n{BODY}"),
            }],
            ..Sources::default()
        },
        LoadOptions::default(),
    )
    .unwrap()
}

/// A received copy about the post's Methods section from `name`.
fn copy(site: &Site, name: &str, publish_name: bool) -> SubmittedCopy {
    let post = &site.posts[0];
    let document = PassageDocument::of_post(post, &site.config);
    LocalReflection {
        work: post.url.clone(),
        revision: document.revision.clone(),
        target: PerspectiveTarget::try_from(document.section_target(1).unwrap()).unwrap(),
        category: Some(ResponseCategory::Connection),
        body: "<script>alert(1)</script> Tides as a conversation.".into(),
        attribution: ReaderAttribution::named(name, publish_name),
        seen_at: None,
    }
    .submission(openblog_core::third_perspective::ConsentChoices {
        publish: true,
        clarification: true,
        feature: false,
    })
    .receive(
        time("2026-10-26T10:00:00Z"),
        Intake::Hosted {
            receipt_digest: "5e".repeat(32),
        },
    )
    .unwrap()
}

/// The hosted inbox item of a copy, as engagement.mjs returns it.
fn hosted(copy: &SubmittedCopy, status: &str, extra: Value) -> Value {
    let record: Value = serde_json::from_str(&copy.to_json()).unwrap();
    let mut value = json!({
        "source": "feedback", "id": ID, "status": status, "version": 2,
        "moderatedAt": null, "reason": null,
        "feedback": {"version": 1, "kind": "third-perspective", "body": copy.body, "details": copy.stored_details(), "provenance": record["provenance"]},
        "itemRevision": copy.revision, "approvedRevision": null, "clarificationAsked": null,
        "clarificationConsent": true, "approvedConsent": null,
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
    third_perspectives: bool,
) -> Inbox<'a> {
    Inbox {
        site,
        works,
        principal: Principal::ModerationToken,
        identities,
        policy: ModerationPolicy::default(),
        protocol: Protocol::Protected,
        third_perspectives,
        now: time("2026-10-27T10:00:00Z"),
    }
}

const NO_USERS: [&str; 0] = [];

fn action_ids(view: &Value) -> Vec<&str> {
    view["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|action| action["action"].as_str().unwrap())
        .collect()
}

#[test]
fn a_hosted_row_reads_back_into_the_checked_copy_it_stores() {
    let site = site();
    let copy = copy(&site, "Grace", true);
    let item = InboxItem::from_value(&hosted(&copy, "pending", json!({}))).unwrap();
    assert_eq!(item.source, Source::Feedback);
    assert_eq!(item.kind, ParticipationKind::ThirdPerspective);
    assert!(Source::Feedback.holds(ParticipationKind::ThirdPerspective));
    let perspective = item.perspective().unwrap();
    assert_eq!(perspective.copy, copy);
    assert!(item.feedback().is_none(), "never read as passage feedback");

    // A row that breaks any rule is refused on its own and counted.
    let mut bad = hosted(&copy, "pending", json!({}));
    bad["feedback"]["details"]["consents"][0]["number"] = json!(2);
    let mut unknown = hosted(&copy, "pending", json!({}));
    unknown["rank"] = json!(1);
    let mut quoted = hosted(&copy, "pending", json!({}));
    quoted["feedback"]["provenance"]["target"] = json!({"version": 1, "kind": "quote", "section": "methods", "exact": "tides", "prefix": "", "suffix": "", "start": 0});
    let mut foreign = hosted(
        &copy,
        "approved",
        json!({"approvedRevision": 1, "approvedConsent": 9}),
    );
    foreign["version"] = json!(3);
    let page = read_page(&json!({"protocol": "protected", "thirdPerspectives": true, "items": [hosted(&copy, "pending", json!({})), bad, unknown, quoted, foreign], "next": null})).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.invalid, 4);
    assert!(page.third_perspectives);
    assert!(
        !read_page(&json!({"protocol": "protected", "items": [], "next": null}))
            .unwrap()
            .third_perspectives
    );

    // A purged Third Perspective keeps only its facts.
    let purged = InboxItem::from_value(&json!({
        "source": "feedback", "id": ID, "kind": "third-perspective", "status": "withdrawn", "version": 4, "revision": 1,
        "moderatedAt": "2026-10-27T10:00:00Z", "reason": null, "receivedAt": "2026-10-26T10:00:00Z",
        "work": "/posts/tides/", "purgedAt": "2026-10-27T10:00:00Z",
    }))
    .unwrap();
    assert_eq!(purged.kind, ParticipationKind::ThirdPerspective);
}

/// The hosted service sends every feedback item's decision log where its schema keeps one, empty
/// for an item nobody decided. A Third Perspective takes no decisions, so an empty log must not
/// fail the item, while a log that holds a decision is still refused.
#[test]
fn an_empty_decision_log_is_tolerated_on_a_third_perspective_and_a_decision_is_not() {
    let site = site();
    let copy = copy(&site, "Grace", true);
    let empty = json!({"version": 1, "item": ID, "decisions": []});
    let item =
        InboxItem::from_value(&hosted(&copy, "pending", json!({"decisions": empty}))).unwrap();
    assert_eq!(item.perspective().unwrap().copy, copy);
    InboxItem::from_value(&hosted(&copy, "pending", json!({"decisions": null}))).unwrap();

    let held =
        json!({"version": 1, "item": ID, "decisions": [{"sequence": 1, "outcome": "declined"}]});
    let refused = hosted(&copy, "pending", json!({"decisions": held}));
    assert!(InboxItem::from_value(&refused).is_err());
    let page = read_page(
        &json!({"protocol": "protected", "thirdPerspectives": true, "items": [
        hosted(&copy, "pending", json!({"decisions": empty})), refused], "next": null}),
    )
    .unwrap();
    assert_eq!((page.items.len(), page.invalid), (1, 1));
}

#[test]
fn a_hosted_row_with_the_correction_decision_log_still_reads_as_a_third_perspective() {
    // A hosted function that keeps correction decisions sends every feedback
    // row's (empty) log under `decisions`. Only an evidence kind takes a
    // decision, so a Third Perspective's key is dropped before it is read
    // strictly: the row is neither refused nor read as a correction.
    let site = site();
    let copy = copy(&site, "Grace", true);
    let log = json!({"version": 1, "decisions": []});
    let sent = hosted(&copy, "pending", json!({"decisions": log}));
    let item = InboxItem::from_value(&sent).expect("the stripped key is not an unknown field");
    assert_eq!(item.kind, ParticipationKind::ThirdPerspective);
    assert_eq!(item.perspective().unwrap().copy, copy);
    let page = read_page(
        &json!({"protocol": "protected", "thirdPerspectives": true, "items": [sent], "next": null}),
    )
    .unwrap();
    assert_eq!((page.items.len(), page.invalid), (1, 0));
}

#[test]
fn moderators_see_the_category_consent_and_credit_hint_and_never_another_role() {
    let site = site();
    let works = SharedWorks::new(&[], &site);
    let identities = Identities {
        active_admin_users: &NO_USERS,
        contributor_ids: &NO_USERS,
    };
    let inbox = inbox(&site, &works, &identities, true);
    let named = InboxItem::from_value(&hosted(
        &copy(&site, "Ada Lovelace", true),
        "pending",
        json!({}),
    ))
    .unwrap();
    let view = inbox.view(&named).unwrap();
    assert_eq!(view["kind"], "third-perspective");
    assert_eq!(view["kindLabel"], "Third Perspective");
    assert_eq!(
        view["body"], "<script>alert(1)</script> Tides as a conversation.",
        "text stays text"
    );
    assert_eq!(view["details"]["category"], "connection");
    assert_eq!(view["details"]["categoryLabel"], "A connection");
    let perspective = &view["perspective"];
    assert_eq!(perspective["about"], "section");
    assert_eq!(perspective["section"], "methods");
    assert_eq!(perspective["check"], "current");
    assert_eq!(
        perspective["consent"],
        json!({"number": 1, "publish": true, "showName": true, "clarification": true, "feature": false})
    );
    assert_eq!(
        perspective["nameMatchesCredit"], true,
        "the reader's name is the site author's"
    );
    assert_eq!(
        view["published"],
        Value::Null,
        "never in the published feedback file"
    );
    // The preview never shows a name that matches a credit, and is always a reader's.
    assert_eq!(
        view["perspectivePreview"]["heading"],
        "Third Perspective from a reader"
    );
    assert_eq!(view["perspectivePreview"]["name"], Value::Null);
    assert_eq!(
        action_ids(&view),
        ["approve", "request-clarification", "reject"]
    );
    let guidance = view["actions"][0]["guidance"].as_str().unwrap();
    assert!(
        guidance.contains("reader’s reflection, never as yours"),
        "{guidance}"
    );
    assert!(
        !view.to_string().contains(&"5e".repeat(32)),
        "the receipt's digest is never shown"
    );
}

/// A shared publication over the fixture's one post, with a coordinator and
/// a contributing author.
fn shared_record() -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: "tides".into(),
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

#[test]
fn the_credit_hint_goes_only_to_a_viewer_who_may_see_the_name() {
    let site = site();
    let records = [shared_record()];
    let works = SharedWorks::new(&records, &site);
    let users = ["owner-admin", "coord-admin", "writer-admin"];
    let keys = ["owner", "coord", "writer"];
    let identities = Identities {
        active_admin_users: &users,
        contributor_ids: &keys,
    };
    let as_viewer = |principal| Inbox {
        principal,
        ..inbox(&site, &works, &identities, true)
    };
    // The private name matches the site author's credit.
    let private = InboxItem::from_value(&hosted(
        &copy(&site, "Ada Lovelace", false),
        "pending",
        json!({}),
    ))
    .unwrap();
    let admin = as_viewer(Principal::ModerationToken)
        .view(&private)
        .unwrap();
    assert_eq!(admin["role"], "site-admin");
    assert_eq!(admin["perspective"]["nameMatchesCredit"], true);
    for (user, role) in [
        ("coord-admin", "coordinator"),
        ("writer-admin", "contributing-author"),
    ] {
        let view = as_viewer(Principal::AdminSession { admin_user: user })
            .view(&private)
            .unwrap();
        assert_eq!(view["role"], role, "{user}");
        assert_eq!(view["reader"]["private"], true, "{user}");
        assert!(
            view["perspective"].get("nameMatchesCredit").is_none(),
            "a {role} never learns whether the hidden name matches a credit"
        );
        assert!(!view.to_string().contains("Ada Lovelace"), "{user}");
    }
    // A name the reader chose to show carries the hint for anyone who sees it.
    let shown = InboxItem::from_value(&hosted(
        &copy(&site, "Ada Lovelace", true),
        "pending",
        json!({}),
    ))
    .unwrap();
    let view = as_viewer(Principal::AdminSession {
        admin_user: "coord-admin",
    })
    .view(&shown)
    .unwrap();
    assert_eq!(view["perspective"]["nameMatchesCredit"], true);
}

#[test]
fn an_approval_is_offered_only_where_its_consent_is_recorded_and_binds_what_was_seen() {
    let site = site();
    let works = SharedWorks::new(&[], &site);
    let identities = Identities {
        active_admin_users: &NO_USERS,
        contributor_ids: &NO_USERS,
    };
    let item =
        InboxItem::from_value(&hosted(&copy(&site, "Grace", true), "pending", json!({}))).unwrap();
    let without = inbox(&site, &works, &identities, false);
    assert!(!action_ids(&without.view(&item).unwrap()).contains(&"approve"));
    let with = inbox(&site, &works, &identities, true);
    let binding = with
        .check_perspective_approval(&item, "mikey", 1, 1)
        .unwrap();
    assert_eq!(
        (
            binding.revision,
            binding.consent,
            binding.approved_by.as_str()
        ),
        (1, 1, "mikey")
    );
    assert_eq!(
        with.check_perspective_approval(&item, "mikey", 1, 2),
        Err(LifecycleError::StaleConsent)
    );
    assert_eq!(
        with.check_perspective_approval(&item, "mikey", 2, 1),
        Err(LifecycleError::StaleRevision)
    );
    assert_eq!(
        with.check_perspective_approval(&item, "", 1, 1),
        Err(LifecycleError::AnonymousModerator)
    );
    let approved = InboxItem::from_value(&hosted(
        &copy(&site, "Grace", true),
        "approved",
        json!({"approvedRevision": 1, "approvedConsent": 1}),
    ))
    .unwrap();
    assert_eq!(
        with.check_perspective_approval(&approved, "mikey", 1, 1),
        Err(LifecycleError::NotPending)
    );
    let hosted_approval = approved.perspective().unwrap();
    assert_eq!(hosted_approval.approved_consent, Some(1));
    assert_eq!(with.view(&approved).unwrap()["public"], true);
}

#[test]
fn clarification_consent_follows_the_consent_in_effect() {
    let site = site();
    let mut declined = copy(&site, "Grace", false);
    let facts = openblog_core::third_perspective::ModerationFacts {
        state: ModerationState::Pending,
        revision: 1,
        approved_revision: None,
        approved_consent: None,
        clarification_asked: None,
        content_retained: true,
    };
    declined
        .revise_consent(
            &facts,
            openblog_core::third_perspective::ConsentChange {
                publish: true,
                attribution: ReaderAttribution::named("Grace", false),
                clarification: false,
                feature: openblog_core::third_perspective::FeatureChange::Decline,
            },
            time("2026-10-26T11:00:00Z"),
        )
        .unwrap();
    // The column says yes, but the reader's last record said no.
    let hosted_row = HostedPerspective::from_value(&{
        let mut value = hosted(&declined, "pending", json!({}));
        value.as_object_mut().unwrap().remove("source");
        value
    })
    .unwrap();
    assert!(!hosted_row.clarification_consent);
}
