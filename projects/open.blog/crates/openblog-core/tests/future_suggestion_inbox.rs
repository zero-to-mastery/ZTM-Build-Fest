//! Suggestions in the one moderation inbox (#227, ADRs 0152 to 0157): a hosted row read back into
//! a checked suggestion, shown to editors only as far as the one view rule allows (a viewer with no
//! role on its work sees nothing, a coordinator never sees the reader's contact or unpublished name),
//! decided by the one state machine with acceptance meaning editorial interest only, never public,
//! grouped with other suggestions of the same source without a number, and owing retention only the
//! clearing of its private identity.

use openblog_core::collaboration::{
    AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference,
    Participant, SharedPublication, SourceKind,
};
use openblog_core::config::SiteConfig;
use openblog_core::invitation::Identities;
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::moderation::{
    ModerationAction, ModerationPolicy, ModerationState, Principal, RetentionStep, SharedWorks,
};
use openblog_core::moderation_inbox::{
    read_page, similar_items, Content, Inbox, InboxItem, Protocol, Source,
};
use openblog_core::participation::ParticipationKind;
use openblog_core::DateTime;
use serde_json::{json, Value};

const ID: &str = "00000000-0000-4000-8000-000000000001";
const SITE: &str = r#"{"title":"T","url":"https://t.dev","postPath":"/posts/{slug}/","author":{"name":"Ada Lovelace"},
  "engagement":{"enabled":true,"endpoint":"https://t.dev/api"},
  "participation":{"kinds":{"future-suggestion":"open"}}}"#;

fn time(value: &str) -> DateTime {
    DateTime::parse(value).unwrap()
}

fn site() -> Site {
    Site::load(
        SiteConfig::from_json(SITE).unwrap(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/tides.md".into(),
                contents: "---\ntitle: Tides\ndate: 2026-01-01\n---\nThe moon causes the tides.\n"
                    .into(),
            }],
            ..Sources::default()
        },
        LoadOptions::default(),
    )
    .unwrap()
}

/// The hosted inbox item of a suggestion row, as engagement.mjs returns it.
fn hosted(status: &str, id: &str, extra: Value) -> Value {
    let mut value = json!({
        "source": "feedback", "id": id, "status": status, "version": 2,
        "moderatedAt": null, "reason": null,
        "feedback": {
            "version": 1, "kind": "future-suggestion",
            "body": "<script>alert(1)</script> Her letters would help.",
            "details": {
                "type": "text",
                "url": "https://example.org/letters",
                "hints": { "title": "The survey letters", "identifiers": [{ "scheme": "doi", "value": "10.1234/abc" }] },
                "about": { "series": "tides" },
                "contact": { "address": "ada@example.org", "followUp": true }
            },
            "provenance": {
                "version": 1, "work": "/posts/tides/", "revision": null, "target": null,
                "receivedAt": "2026-10-26T10:00:00Z", "channel": "hosted",
                "attribution": { "name": "Private Person", "publishName": false }
            }
        },
        "itemRevision": 1, "approvedRevision": null, "clarificationAsked": null, "clarificationConsent": true,
    });
    if status == "approved" {
        value["approvedRevision"] = json!(1);
        value["moderatedAt"] = json!("2026-10-27T10:00:00Z");
    }
    for (key, field) in extra.as_object().unwrap() {
        value[key] = field.clone();
    }
    value
}

const NO_USERS: [&str; 0] = [];

fn inbox<'a>(
    site: &'a Site,
    works: &'a SharedWorks<'a>,
    identities: &'a Identities<'a>,
) -> Inbox<'a> {
    Inbox {
        site,
        works,
        principal: Principal::ModerationToken,
        identities,
        policy: ModerationPolicy::default(),
        protocol: Protocol::Protected,
        third_perspectives: false,
        now: time("2026-10-27T10:00:00Z"),
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
fn a_hosted_row_reads_back_into_the_checked_suggestion_it_stores() {
    let item = InboxItem::from_value(&hosted("pending", ID, json!({}))).unwrap();
    assert_eq!(item.source, Source::Feedback);
    assert_eq!(item.kind, ParticipationKind::FutureSuggestion);
    assert!(Source::Feedback.holds(ParticipationKind::FutureSuggestion));
    assert!(!Source::Comment.holds(ParticipationKind::FutureSuggestion));
    assert!(!Source::Report.holds(ParticipationKind::FutureSuggestion));
    let suggestion = item.suggestion().unwrap();
    assert_eq!(suggestion.revision, 1);
    assert_eq!(suggestion.receipt.work, "/posts/tides/");
    assert!(item.feedback().is_none(), "never read as passage feedback");
    assert_eq!(item.work, "/posts/tides/");
    // A suggestion is not public, whatever its state.
    assert!(!item.facts().kind.rules().publishable);

    // A row that breaks any rule is refused on its own and counted; none is repaired.
    let broken = |edit: &dyn Fn(&mut Value)| {
        let mut value = hosted("pending", ID, json!({}));
        edit(&mut value);
        value
    };
    let rows = [
        hosted("pending", ID, json!({})),
        broken(&|v| v["feedback"]["details"]["url"] = json!("http://127.0.0.1/x")),
        broken(&|v| v["feedback"]["details"]["text"] = json!("smuggled")),
        broken(&|v| v["feedback"]["details"]["attribution"] = json!({"name": "x"})),
        broken(&|v| {
            v["feedback"]["provenance"]["revision"] = json!("p1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        }),
        broken(&|v| v["feedback"]["provenance"]["target"] = json!({"version": 1, "kind": "work"})),
        broken(&|v| v["feedback"]["provenance"]["work"] = json!("https://elsewhere.example/")),
        broken(&|v| v["feedback"]["kind"] = json!("question")),
        broken(&|v| v["rank"] = json!(1)),
        broken(&|v| v["id"] = json!("not-a-uuid")),
    ];
    let page = read_page(&json!({"protocol": "protected", "items": rows, "next": null})).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.invalid, 9);

    // An empty decision log is tolerated (a suggestion takes no decision); a decision is not.
    InboxItem::from_value(&hosted(
        "pending",
        ID,
        json!({"decisions": {"version": 1, "item": ID, "decisions": []}}),
    ))
    .unwrap();
    assert!(InboxItem::from_value(&hosted(
        "pending",
        ID,
        json!({"decisions": {"version": 1, "item": ID, "decisions": [{"sequence": 1}]}})
    ))
    .is_err());

    // A purged suggestion keeps only its facts.
    let purged = InboxItem::from_value(&json!({
        "source": "feedback", "id": ID, "kind": "future-suggestion", "status": "withdrawn", "version": 4, "revision": 1,
        "moderatedAt": "2026-10-27T10:00:00Z", "reason": null, "receivedAt": "2026-10-26T10:00:00Z",
        "work": "/posts/tides/", "purgedAt": "2026-10-27T10:00:00Z",
    }))
    .unwrap();
    assert_eq!(purged.kind, ParticipationKind::FutureSuggestion);
    assert_eq!(purged.content, Content::Purged);
    assert!(purged.suggestion().is_none());
}

#[test]
fn editors_see_the_suggestion_as_text_and_contact_only_where_the_view_rule_allows() {
    let site = site();
    let works = SharedWorks::new(&[], &site);
    let identities = Identities {
        active_admin_users: &NO_USERS,
        contributor_ids: &NO_USERS,
    };
    let inbox = inbox(&site, &works, &identities);
    let item = InboxItem::from_value(&hosted("pending", ID, json!({}))).unwrap();
    let view = inbox.view(&item).unwrap();
    assert_eq!(view["kind"], "future-suggestion");
    assert_eq!(view["kindLabel"], "Suggestion for future work");
    assert_eq!(view["role"], "site-admin");
    assert_eq!(view["public"], false);
    assert_eq!(
        view["body"], "<script>alert(1)</script> Her letters would help.",
        "text stays text"
    );
    let suggestion = &view["suggestion"];
    assert_eq!(suggestion["type"], "text");
    assert_eq!(suggestion["typeLabel"], "Text to read");
    assert_eq!(suggestion["url"], "https://example.org/letters");
    assert_eq!(suggestion["hints"]["title"], "The survey letters");
    assert_eq!(suggestion["hints"]["identifiers"][0]["scheme"], "doi");
    assert_eq!(suggestion["about"], json!({"series": "tides"}));
    assert_eq!(suggestion["standing"]["id"], "received");
    assert_eq!(suggestion["contact"], "ada@example.org");
    assert_eq!(view["reader"]["name"], "Private Person");
    assert_eq!(
        suggestion["missing"],
        json!(["a creator"]),
        "what an editor still has to find"
    );
    assert!(suggestion["notice"]
        .as_str()
        .unwrap()
        .contains("does not mean they agree"));
    assert_eq!(
        action_ids(&view),
        ["approve", "request-clarification", "reject"]
    );
    let approve = view["actions"][0]["guidance"].as_str().unwrap();
    assert!(
        !approve.contains("Publishes"),
        "approval publishes nothing: {approve}"
    );
    let text = view.to_string();
    for forbidden in ["votes", "rank", "popular", "count"] {
        assert!(!text.contains(forbidden), "{forbidden}");
    }
}

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
        ("reader", AuthorizationRole::Reader),
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
fn a_coordinator_never_sees_the_contact_and_a_viewer_with_no_role_sees_nothing() {
    let site = site();
    let records = [shared_record()];
    let works = SharedWorks::new(&records, &site);
    let users = ["owner-admin", "coord-admin", "writer-admin", "reader-admin"];
    let keys = ["owner", "coord", "writer", "reader"];
    let identities = Identities {
        active_admin_users: &users,
        contributor_ids: &keys,
    };
    let as_viewer = |principal| Inbox {
        principal,
        ..inbox(&site, &works, &identities)
    };
    let item = InboxItem::from_value(&hosted("pending", ID, json!({}))).unwrap();
    let admin = as_viewer(Principal::ModerationToken).view(&item).unwrap();
    assert_eq!(admin["role"], "site-admin");
    assert_eq!(admin["suggestion"]["contact"], "ada@example.org");
    for (user, role) in [
        ("coord-admin", "coordinator"),
        ("writer-admin", "contributing-author"),
    ] {
        let view = as_viewer(Principal::AdminSession { admin_user: user })
            .view(&item)
            .unwrap();
        assert_eq!(view["role"], role, "{user}");
        assert_eq!(view["suggestion"]["contact"], Value::Null, "{user}");
        assert_eq!(view["reader"]["private"], true, "{user}");
        let text = view.to_string();
        assert!(
            !text.contains("ada@example.org") && !text.contains("Private Person"),
            "{user}"
        );
    }
    // A reader of the publication holds no moderation role and sees nothing at all.
    assert!(as_viewer(Principal::AdminSession {
        admin_user: "reader-admin"
    })
    .view(&item)
    .is_none());
    // The name a reader chose to show is shown to a coordinator; the contact never is.
    let shown = InboxItem::from_value(&hosted(
        "pending",
        ID,
        json!({"feedback": {
            "version": 1, "kind": "future-suggestion", "body": "Her letters would help.",
            "details": {"type": "text", "contact": {"address": "ada@example.org", "followUp": true}, "creditRevision": 1},
            "provenance": {"version": 1, "work": "/posts/tides/", "revision": null, "target": null,
                "receivedAt": "2026-10-26T10:00:00Z", "channel": "hosted",
                "attribution": {"name": "Public Person", "publishName": true}}
        }}),
    ))
    .unwrap();
    let view = as_viewer(Principal::AdminSession {
        admin_user: "coord-admin",
    })
    .view(&shown)
    .unwrap();
    assert_eq!(view["reader"]["name"], "Public Person");
    assert_eq!(view["suggestion"]["contact"], Value::Null);
    // The agreement was for revision 1: once the text has a later revision (a
    // clarification), a coordinator is shown no name until the reader agrees again.
    let clarified = InboxItem::from_value(&hosted(
        "pending",
        ID,
        json!({"itemRevision": 2, "feedback": {
            "version": 1, "kind": "future-suggestion", "body": "Her letters, as I meant.",
            "details": {"type": "text", "creditRevision": 1},
            "provenance": {"version": 1, "work": "/posts/tides/", "revision": null, "target": null,
                "receivedAt": "2026-10-26T10:00:00Z", "channel": "hosted",
                "attribution": {"name": "Public Person", "publishName": true}}
        }}),
    ))
    .unwrap();
    let view = as_viewer(Principal::AdminSession {
        admin_user: "coord-admin",
    })
    .view(&clarified)
    .unwrap();
    assert_eq!(view["reader"].get("name"), None);
    assert_eq!(view["reader"]["publishName"], false);
}

#[test]
fn acceptance_is_interest_only_and_the_one_machine_decides() {
    let site = site();
    let works = SharedWorks::new(&[], &site);
    let identities = Identities {
        active_admin_users: &NO_USERS,
        contributor_ids: &NO_USERS,
    };
    let inbox = inbox(&site, &works, &identities);
    let pending = InboxItem::from_value(&hosted("pending", ID, json!({}))).unwrap();
    let decision = inbox
        .decide(&pending, ModerationAction::Approve, 2, None)
        .unwrap();
    assert_eq!(decision.item.to, ModerationState::Approved);
    let approved = InboxItem::from_value(&hosted("approved", ID, json!({}))).unwrap();
    let view = inbox.view(&approved).unwrap();
    assert_eq!(
        view["public"], false,
        "an accepted suggestion is not public"
    );
    assert_eq!(view["suggestion"]["standing"]["id"], "interested");
    assert_eq!(
        action_ids(&view),
        ["remove"],
        "an editor can close it again, with a decline reason"
    );
    // Only the full protocol that stores receipts can hold a suggestion's decisions.
    assert!(Protocol::Protected.supports(
        ParticipationKind::FutureSuggestion,
        ModerationAction::Approve
    ));
    assert!(!Protocol::Full.supports(
        ParticipationKind::FutureSuggestion,
        ModerationAction::Approve
    ));
    assert!(!Protocol::Legacy.supports(
        ParticipationKind::FutureSuggestion,
        ModerationAction::Reject
    ));
}

#[test]
fn the_same_source_sent_twice_is_pointed_out_across_pages_and_never_counted() {
    let one = InboxItem::from_value(&hosted("pending", ID, json!({}))).unwrap();
    let mut other_value = hosted("pending", "00000000-0000-4000-8000-000000000002", json!({}));
    other_value["feedback"]["details"] =
        json!({"type": "text", "url": "https://www.example.org/letters/?utm_source=x"});
    other_value["feedback"]["provenance"]["work"] = json!("/posts/elsewhere/");
    let two = InboxItem::from_value(&other_value).unwrap();
    let mut different = hosted("pending", "00000000-0000-4000-8000-000000000003", json!({}));
    different["feedback"]["details"] = json!({"type": "text", "url": "https://example.org/other"});
    let three = InboxItem::from_value(&different).unwrap();
    let cues = similar_items(&[&one, &two, &three]);
    assert_eq!(cues[&one.id].len(), 1);
    assert_eq!(cues[&one.id][0]["id"], two.id);
    assert_eq!(cues[&one.id][0]["reason"], "the same source");
    assert_eq!(cues[&two.id][0]["id"], one.id);
    assert!(!cues.contains_key(&three.id));
    assert!(!serde_json::to_string(&cues).unwrap().contains("count"));
}

#[test]
fn retention_owes_a_kept_suggestion_only_the_clearing_of_what_is_private() {
    let policy = ModerationPolicy::default();
    let now = time("2026-12-27T10:00:00Z");
    let held = InboxItem::from_value(&hosted("approved", ID, json!({}))).unwrap();
    assert_eq!(
        held.retention_step(&policy, now),
        Some(RetentionStep::ScrubIdentity)
    );
    // Before the period, nothing; with nothing private, nothing.
    assert_eq!(
        held.retention_step(&policy, time("2026-10-28T10:00:00Z")),
        None
    );
    let mut clear = hosted("approved", ID, json!({}));
    clear["feedback"]["details"] = json!({"type": "text"});
    clear["feedback"]["provenance"]["attribution"] = json!({"publishName": false});
    let clear = InboxItem::from_value(&clear).unwrap();
    assert!(!clear.suggestion().unwrap().holds_identity());
    assert_eq!(clear.retention_step(&policy, now), None);
    // A closed one is purged as any closed item; a pending one expires.
    let removed = InboxItem::from_value(&hosted(
        "removed",
        ID,
        json!({"moderatedAt": "2026-10-27T10:00:00Z"}),
    ))
    .unwrap();
    assert_eq!(
        removed.retention_step(&policy, now),
        Some(RetentionStep::PurgeContent)
    );
    let pending = InboxItem::from_value(&hosted("pending", ID, json!({}))).unwrap();
    assert_eq!(
        pending.retention_step(&policy, time("2027-02-01T10:00:00Z")),
        Some(RetentionStep::Expire)
    );
}
