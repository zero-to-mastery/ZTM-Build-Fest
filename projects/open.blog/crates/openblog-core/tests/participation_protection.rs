//! Engagement protection (#226, ADRs 0107 and 0108): retention due dates as
//! one run sees them, deletion requests by a submitter's receipt or the site
//! Admin, abuse reports read strictly and upheld only with the item they
//! name, purged items that only keep their facts, and the shared fixture the
//! hosted function must agree with case by case.

use openblog_core::config::SiteConfig;
use openblog_core::invitation::Identities;
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::moderation::{
    allowed_reasons, issues_receipts, Actor, AuditAction, ItemFacts, ModerationAction,
    ModerationPolicy, ModerationState, PolicyError, Principal, ReasonCode, Request,
    RetentionPolicy, RetentionStep, SharedWorks,
};
use openblog_core::moderation_inbox::{
    read_page, report_grounds, Content, Inbox, InboxItem, Protocol, Source, ERASE_ACTION,
};
use openblog_core::participation::ParticipationKind;
use openblog_core::DateTime;
use serde_json::{json, Value};

const FIXTURE_PATH: &str = "../../tests/fixtures/participation-protection.json";
const WORK: &str = "/posts/tides/";
const WORKS: [&str; 1] = [WORK];
const ITEM: &str = "00000000-0000-4000-8000-000000000001";
const TARGET: &str = "00000000-0000-4000-8000-000000000002";
const NOW: &str = "2026-10-27T10:00:00Z";
const KINDS: [ParticipationKind; 4] = [
    ParticipationKind::Comment,
    ParticipationKind::Question,
    ParticipationKind::AbuseReport,
    ParticipationKind::FutureSuggestion,
];

fn at(text: &str) -> DateTime {
    DateTime::parse(text).unwrap()
}

fn now() -> DateTime {
    at(NOW)
}

fn facts(kind: ParticipationKind, state: ModerationState) -> ItemFacts<'static> {
    ItemFacts {
        id: ITEM,
        kind,
        work: Some(WORK),
        parent: None,
        state,
        version: 3,
        revision: 1,
        approved_revision: (state == ModerationState::Approved).then_some(1),
        clarification_asked: None,
        clarification_consent: false,
        content_retained: true,
        state_since: at("2026-10-26T10:00:00Z"),
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
        "submitter" => Actor::Submitter,
        "public" => Actor::Public,
        _ => unreachable!(),
    }
}

fn policy(comments: bool) -> ModerationPolicy {
    if comments {
        ModerationPolicy::new(RetentionPolicy::default())
    } else {
        ModerationPolicy::default()
    }
}

// ---- The shared fixture

/// Every retention step one run owes, for comments, a passage kind and abuse
/// reports, with and without comments opted in, in every state, with text
/// kept or purged, at each period's edge and one second before it.
fn retention_cases() -> Vec<Value> {
    let mut cases = Vec::new();
    for comments in [false, true] {
        let policy = policy(comments);
        let cutoffs = policy.cutoffs(now());
        let mut edges = vec![
            cutoffs.pending_until,
            cutoffs.clarification_until,
            cutoffs.closed_until,
        ];
        edges.sort_by_key(|edge| edge.unix());
        edges.dedup();
        for kind in KINDS {
            for state in ModerationState::ALL {
                for retained in [true, false] {
                    for &edge in &edges {
                        for since in [edge, DateTime::from_unix(edge.unix() + 1)] {
                            let item = ItemFacts {
                                content_retained: retained,
                                state_since: since,
                                ..facts(kind, state)
                            };
                            let step = policy.retention_due(&item, now());
                            cases.push(json!({
                                "kind": kind.id(), "state": state.id(), "retained": retained,
                                "comments": comments, "since": since.rfc3339(),
                                "step": step.map(|step| match step {
                                    RetentionStep::Expire => "expire",
                                    RetentionStep::PurgeContent => "purge-content",
                                    RetentionStep::ScrubIdentity => "scrub-identity",
                                }),
                            }));
                        }
                    }
                }
            }
        }
    }
    cases
}

/// Every deletion request: each role, kind and state, text kept or purged,
/// and a view someone else has moved past.
fn erasure_cases() -> Vec<Value> {
    let mut cases = Vec::new();
    let mut case = |role: &str, kind, state, retained, expected_version| {
        let item = ItemFacts {
            content_retained: retained,
            ..facts(kind, state)
        };
        let mut value = json!({
            "role": role, "kind": kind.id(), "state": state.id(), "retained": retained,
        });
        if expected_version != item.version {
            value["expectedVersion"] = json!(expected_version);
        }
        match ModerationPolicy::default().erase(&item, &actor(role), expected_version, now()) {
            Ok(erasure) => {
                value["withdraw"] = json!(erasure.withdrawal.is_some());
                value["to"] = json!(erasure.state.id());
                value["version"] = json!(erasure.version);
            }
            Err(error) => value["refused"] = json!(error.code()),
        }
        cases.push(value);
    };
    for role in [
        "site-admin",
        "coordinator",
        "contributing-author",
        "submitter",
        "public",
    ] {
        for kind in KINDS {
            for state in ModerationState::ALL {
                for retained in [true, false] {
                    case(role, kind, state, retained, 3);
                }
            }
        }
    }
    case(
        "submitter",
        ParticipationKind::Question,
        ModerationState::Pending,
        true,
        2,
    );
    cases
}

/// Every upholding: each moderator role on a report in each state, with the
/// named item approved, already out of view, missing or another item, plus a
/// missing reason.
fn uphold_cases() -> Vec<Value> {
    let mut cases = Vec::new();
    let mut case =
        |role: &str, report_state: ModerationState, target: &str, reason: Option<ReasonCode>| {
            let target_state = ModerationState::from_id(target);
            let target_facts = target_state.map(|state| ItemFacts {
                id: if target == "other" { ITEM } else { TARGET },
                version: 5,
                ..facts(ParticipationKind::Comment, state)
            });
            let other = ItemFacts {
                id: "00000000-0000-4000-8000-000000000009",
                version: 5,
                ..facts(ParticipationKind::Comment, ModerationState::Approved)
            };
            let reported = match target {
                "other" => Some(&other),
                _ => target_facts.as_ref(),
            };
            let report = ItemFacts {
                parent: Some(TARGET),
                ..facts(ParticipationKind::AbuseReport, report_state)
            };
            let outcome = ModerationPolicy::default().decide(
                &report,
                &Request {
                    actor: actor(role),
                    action: ModerationAction::UpholdReport,
                    expected_version: 3,
                    reason,
                    at: now(),
                    reported_item: reported,
                },
            );
            let mut value = json!({
                "role": role, "state": report_state.id(), "target": target,
                "reason": reason.map(ReasonCode::id),
            });
            match outcome {
                Ok(decision) => {
                    value["to"] = json!(decision.item.to.id());
                    value["targetTo"] = json!(decision.reported_item.map(|change| change.to.id()));
                }
                Err(error) => value["refused"] = json!(error.code()),
            }
            cases.push(value);
        };
    let first = allowed_reasons(
        ModerationAction::UpholdReport,
        ParticipationKind::AbuseReport,
    )
    .first()
    .copied();
    for role in ["site-admin", "coordinator", "contributing-author"] {
        for state in [
            ModerationState::Pending,
            ModerationState::Approved,
            ModerationState::Rejected,
        ] {
            for target in [
                "approved", "removed", "rejected", "pending", "missing", "other",
            ] {
                case(role, state, target, first);
            }
        }
    }
    case("site-admin", ModerationState::Pending, "approved", None);
    case(
        "site-admin",
        ModerationState::Pending,
        "approved",
        Some(ReasonCode::NoAction),
    );
    cases
}

fn fixture_text() -> String {
    let join = |cases: Vec<Value>| {
        cases
            .iter()
            .map(|case| serde_json::to_string(case).unwrap())
            .collect::<Vec<_>>()
            .join(",\n    ")
    };
    let cutoffs = |comments| policy(comments).cutoffs(now()).to_json();
    format!(
        "{{\n  \"about\": \"Retention steps, deletion requests and upheld abuse reports (ADRs 0104, 0107 and 0108), generated from openblog_core::moderation and checked by crates/openblog-core/tests/participation_protection.rs; netlify/lib/participation-moderation.mjs must agree with every case. One run at {NOW} with the default periods; `cutoffs` are what Admin sends for it, without and with comments opted in. Items start at version 3; reported items at version 5. Regenerate with OPENBLOG_BLESS=1.\",\n  \"now\": \"{NOW}\",\n  \"cutoffs\": {{\"withoutComments\": {}, \"withComments\": {}}},\n  \"retention\": [\n    {}\n  ],\n  \"erasure\": [\n    {}\n  ],\n  \"uphold\": [\n    {}\n  ]\n}}\n",
        cutoffs(false),
        cutoffs(true),
        join(retention_cases()),
        join(erasure_cases()),
        join(uphold_cases()),
    )
}

#[test]
fn the_protection_fixture_is_the_policy() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE_PATH);
    let expected = fixture_text();
    if std::env::var_os("OPENBLOG_BLESS").is_some() {
        std::fs::write(&path, &expected).unwrap();
    }
    let stored = std::fs::read_to_string(&path)
        .unwrap_or_default()
        .replace("\r\n", "\n");
    assert!(
        stored == expected,
        "tests/fixtures/participation-protection.json is not what the policy decides; review the change and regenerate it with OPENBLOG_BLESS=1"
    );
    let fixture: Value = serde_json::from_str(&stored).unwrap();
    let find = |list: &str, pairs: &[(&str, Value)]| {
        fixture[list]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| pairs.iter().all(|(key, value)| &case[*key] == value))
            .cloned()
            .unwrap()
    };
    // Spot checks a reviewer can read. A rejected comment is never purged
    // unless the site set retention itself.
    let closed = fixture["cutoffs"]["withoutComments"]["closedUntil"].clone();
    let rejected_comment = |comments: bool| {
        find(
            "retention",
            &[
                ("kind", json!("comment")),
                ("state", json!("rejected")),
                ("retained", json!(true)),
                ("comments", json!(comments)),
                ("since", closed.clone()),
            ],
        )["step"]
            .clone()
    };
    assert_eq!(rejected_comment(false), Value::Null);
    assert_eq!(rejected_comment(true), json!("purge-content"));
    // A reader's receipt withdraws an approved note before deleting it.
    let erase = find(
        "erasure",
        &[
            ("role", json!("submitter")),
            ("kind", json!("question")),
            ("state", json!("approved")),
            ("retained", json!(true)),
        ],
    );
    assert_eq!(
        (&erase["withdraw"], &erase["to"], &erase["version"]),
        (&json!(true), &json!("withdrawn"), &json!(5))
    );
    // An upheld report takes an approved item down in the same decision.
    let uphold = find(
        "uphold",
        &[
            ("role", json!("coordinator")),
            ("state", json!("pending")),
            ("target", json!("approved")),
        ],
    );
    assert_eq!(
        (&uphold["to"], &uphold["targetTo"]),
        (&json!("approved"), &json!("removed"))
    );
}

// ---- The policy

#[test]
fn one_runs_cutoffs_are_the_periods_counted_back_from_its_time() {
    let cutoffs = policy(false).cutoffs(now());
    assert_eq!(cutoffs.pending_until, at("2026-07-29T10:00:00Z"));
    assert_eq!(cutoffs.clarification_until, at("2026-09-27T10:00:00Z"));
    assert_eq!(cutoffs.closed_until, at("2026-09-27T10:00:00Z"));
    assert_eq!(cutoffs.audit_until, at("2025-10-27T10:00:00Z"));
    assert!(!cutoffs.comments);
    assert!(policy(true).cutoffs(now()).comments);
    // Due exactly at the edge, never a second before it.
    let pending = |since| ItemFacts {
        state_since: since,
        ..facts(ParticipationKind::Question, ModerationState::Pending)
    };
    let policy = policy(false);
    assert_eq!(
        policy.retention_due(&pending(cutoffs.pending_until), now()),
        Some(RetentionStep::Expire)
    );
    assert_eq!(
        policy.retention_due(
            &pending(DateTime::from_unix(cutoffs.pending_until.unix() + 1)),
            now()
        ),
        None
    );
    assert_eq!(
        cutoffs.to_json(),
        json!({"pendingUntil": "2026-07-29T10:00:00Z", "clarificationUntil": "2026-09-27T10:00:00Z",
               "closedUntil": "2026-09-27T10:00:00Z", "auditUntil": "2025-10-27T10:00:00Z", "comments": false})
    );
}

#[test]
fn a_purge_raises_the_version_so_no_earlier_view_can_act() {
    let policy = ModerationPolicy::default();
    let rejected = ItemFacts {
        state_since: at("2026-01-01T00:00:00Z"),
        ..facts(ParticipationKind::Question, ModerationState::Rejected)
    };
    let event = policy.purge_event(&rejected, now()).unwrap();
    assert_eq!(event.version, rejected.version + 1);
    assert_eq!(event.action, AuditAction::PurgeContent);
    // Once purged, nothing decides on it again.
    let purged = ItemFacts {
        content_retained: false,
        version: event.version,
        ..rejected
    };
    let reopen = policy.decide(
        &purged,
        &Request {
            actor: actor("site-admin"),
            action: ModerationAction::Reopen,
            expected_version: purged.version,
            reason: None,
            at: now(),
            reported_item: None,
        },
    );
    assert_eq!(reopen.unwrap_err(), PolicyError::ContentPurged);
}

#[test]
fn a_deletion_request_withdraws_what_is_still_open_and_keeps_only_the_record() {
    let policy = ModerationPolicy::default();
    // The submitter's receipt: an approved note is withdrawn and purged in
    // one write, the purge event naming the withdrawn state.
    let approved = facts(ParticipationKind::Question, ModerationState::Approved);
    let erasure = policy
        .erase(&approved, &Actor::Submitter, 3, now())
        .unwrap();
    let withdrawal = erasure.withdrawal.as_ref().unwrap();
    assert_eq!(
        (withdrawal.from, withdrawal.to, withdrawal.version),
        (ModerationState::Approved, ModerationState::Withdrawn, 4)
    );
    assert_eq!(erasure.state, ModerationState::Withdrawn);
    assert_eq!(erasure.version, 5);
    let purge = erasure.purge.to_json();
    assert_eq!(purge["action"], "purge-content");
    assert_eq!(purge["actor"], "submitter");
    assert_eq!(purge["actorId"], Value::Null);
    assert_eq!(purge["from"], "withdrawn");
    // No text, name or contact in either event.
    for event in [purge, withdrawal.audit.to_json()] {
        let keys: Vec<&String> = event.as_object().unwrap().keys().collect();
        assert!(keys
            .iter()
            .all(|key| !["body", "name", "text", "details", "contact"].contains(&key.as_str())));
    }
    // A rejected note is purged as it is.
    let rejected = facts(ParticipationKind::Question, ModerationState::Rejected);
    let erasure = policy
        .erase(&rejected, &Actor::Submitter, 3, now())
        .unwrap();
    assert!(erasure.withdrawal.is_none());
    assert_eq!(
        (erasure.state, erasure.version),
        (ModerationState::Rejected, 4)
    );
    // Comments and reports carry no receipt.
    assert!(!issues_receipts(ParticipationKind::Comment));
    assert!(!issues_receipts(ParticipationKind::AbuseReport));
    assert!(!issues_receipts(ParticipationKind::AuthorResponse));
    assert!(issues_receipts(ParticipationKind::ThirdPerspective));
    for kind in [ParticipationKind::Comment, ParticipationKind::AbuseReport] {
        assert_eq!(
            policy
                .erase(
                    &facts(kind, ModerationState::Pending),
                    &Actor::Submitter,
                    3,
                    now()
                )
                .unwrap_err(),
            PolicyError::Denied
        );
    }
    // The site Admin deletes only what is already decided, and a purged item
    // or a stale view changes nothing.
    let admin = actor("site-admin");
    for state in [
        ModerationState::Pending,
        ModerationState::Clarification,
        ModerationState::Approved,
    ] {
        assert_eq!(
            policy
                .erase(&facts(ParticipationKind::Comment, state), &admin, 3, now())
                .unwrap_err(),
            PolicyError::NotAllowed
        );
    }
    let removed = facts(ParticipationKind::Comment, ModerationState::Removed);
    let erasure = policy.erase(&removed, &admin, 3, now()).unwrap();
    assert_eq!(erasure.purge.actor_id.as_deref(), Some("ada"));
    let upheld = facts(ParticipationKind::AbuseReport, ModerationState::Approved);
    assert!(policy.erase(&upheld, &admin, 3, now()).is_ok());
    assert_eq!(
        policy.erase(&removed, &admin, 2, now()).unwrap_err(),
        PolicyError::Stale
    );
    let purged = ItemFacts {
        content_retained: false,
        ..removed
    };
    assert_eq!(
        policy.erase(&purged, &admin, 3, now()).unwrap_err(),
        PolicyError::ContentPurged
    );
    for role in ["coordinator", "contributing-author", "public"] {
        assert_eq!(
            policy.erase(&removed, &actor(role), 3, now()).unwrap_err(),
            PolicyError::Denied
        );
    }
}

// ---- Reports and purged items in the inbox

const SITE: &str = r#"{"title":"T","url":"https://t.dev","postPath":"/posts/{slug}/","engagement":{"enabled":true,"endpoint":"https://t.dev/api"},"participation":{"kinds":{"abuse-report":"open"}}}"#;

fn site() -> Site {
    Site::load(
        SiteConfig::from_json(SITE).unwrap(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/tides.md".into(),
                contents: "---\ntitle: Tides\ndate: 2026-01-01\n---\nThe moon.\n".into(),
            }],
            ..Sources::default()
        },
        LoadOptions::default(),
    )
    .unwrap()
}

fn report(status: &str, target: Value) -> Value {
    json!({
        "source": "report", "id": ITEM, "status": status, "version": 3,
        "moderatedAt": null, "reason": null, "receivedAt": "2026-10-26T10:00:00Z", "work": WORK,
        "report": {"ground": "abusive", "body": "<b>this</b> is abuse"},
        "target": target,
    })
}

fn reported_comment(status: &str) -> Value {
    json!({"source": "comment", "id": TARGET, "kind": "comment", "status": status, "version": 5,
           "authorName": "Grace", "body": "<img src=x onerror=alert(1)>"})
}

const NO_USERS: [&str; 1] = ["solo-admin"];
const NO_KEYS: [&str; 0] = [];

fn with_inbox<T>(protocol: Protocol, run: impl FnOnce(&Inbox<'_>) -> T) -> T {
    let site = site();
    let records = [];
    let works = SharedWorks::new(&records, &site);
    let identities = Identities {
        active_admin_users: &NO_USERS,
        contributor_ids: &NO_KEYS,
    };
    let inbox = Inbox {
        site: &site,
        works: &works,
        principal: Principal::AdminSession {
            admin_user: "solo-admin",
        },
        identities: &identities,
        policy: ModerationPolicy::default(),
        protocol,
        third_perspectives: false,
        now: now(),
    };
    run(&inbox)
}

fn action_ids(view: &Value) -> Vec<String> {
    view["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|action| action["action"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn abuse_reports_are_read_strictly_and_never_name_the_reporter() {
    let item = InboxItem::from_value(&report("pending", reported_comment("approved"))).unwrap();
    assert_eq!(item.source, Source::Report);
    assert_eq!(item.kind, ParticipationKind::AbuseReport);
    assert_eq!(item.facts().parent, Some(TARGET));
    let target = item.target_facts().unwrap();
    assert_eq!(
        (target.id, target.state, target.version),
        (TARGET, ModerationState::Approved, 5)
    );
    assert!(matches!(
        item.content,
        Content::Report {
            ground: ReasonCode::Abusive,
            ..
        }
    ));
    assert_eq!(report_grounds().len(), 6);
    assert!(!report_grounds().contains(&ReasonCode::NoAction));

    for (path, value) in [
        (vec!["report", "ground"], json!("no-action")),
        (vec!["report", "ground"], json!("incorrect")),
        (vec!["report", "body"], json!("x".repeat(1_001))),
        (vec!["report", "name"], json!("Reporter")),
        (vec!["status"], json!("withdrawn")),
        (vec!["status"], json!("clarification")),
        (vec!["work"], json!("https://evil.example/")),
        (vec!["target", "source"], json!("report")),
        (vec!["target", "kind"], json!("question")),
        (vec!["target", "readerName"], json!("Private Reader")),
        (vec!["contact"], json!("me@example.com")),
    ] {
        let mut row = report("pending", reported_comment("approved"));
        let (last, parents) = path.split_last().unwrap();
        let mut slot = &mut row;
        for key in parents {
            slot = &mut slot[*key];
        }
        slot[*last] = value;
        let error = InboxItem::from_value(&row).unwrap_err();
        assert!(
            !error.contains("evil") && !error.contains("Reporter"),
            "{error}"
        );
    }
    // A report whose item is gone still reads, with nothing to uphold against.
    let orphan = InboxItem::from_value(&report("pending", Value::Null)).unwrap();
    assert!(orphan.target.is_none());
}

#[test]
fn a_report_is_upheld_only_with_the_item_it_names_and_only_where_reports_are_stored() {
    let approved = InboxItem::from_value(&report("pending", reported_comment("approved"))).unwrap();
    let view = with_inbox(Protocol::Protected, |inbox| inbox.view(&approved).unwrap());
    assert_eq!(action_ids(&view), ["reject", "uphold-report"]);
    assert_eq!(view["report"]["ground"], "abusive");
    assert_eq!(view["target"]["body"], "<img src=x onerror=alert(1)>");
    assert_eq!(view["target"]["status"], "approved");
    assert_eq!(view["public"], false);
    let uphold = &view["actions"][1];
    assert!(uphold["guidance"]
        .as_str()
        .unwrap()
        .contains("off its post in the same decision"));
    let reasons: Vec<&str> = uphold["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|reason| reason["id"].as_str().unwrap())
        .collect();
    assert!(!reasons.contains(&"no-action"));
    let decision = with_inbox(Protocol::Protected, |inbox| {
        inbox.decide(
            &approved,
            ModerationAction::UpholdReport,
            3,
            Some(ReasonCode::Abusive),
        )
    })
    .unwrap();
    let removal = decision.reported_item.unwrap();
    assert_eq!(
        (removal.item.as_str(), removal.to, removal.version),
        (TARGET, ModerationState::Removed, 6)
    );
    assert_eq!(removal.audit.reason, Some(ReasonCode::UpheldReport));

    // Already out of view: only the report changes.
    let removed = InboxItem::from_value(&report("pending", reported_comment("removed"))).unwrap();
    let decision = with_inbox(Protocol::Protected, |inbox| {
        inbox.decide(
            &removed,
            ModerationAction::UpholdReport,
            3,
            Some(ReasonCode::Abusive),
        )
    })
    .unwrap();
    assert!(decision.reported_item.is_none());
    // Gone: nothing to uphold against.
    let orphan = InboxItem::from_value(&report("pending", Value::Null)).unwrap();
    let view = with_inbox(Protocol::Protected, |inbox| inbox.view(&orphan).unwrap());
    assert_eq!(action_ids(&view), ["reject"]);
    // Without the protection schema reports are not stored, so not decided.
    let refused = with_inbox(Protocol::Full, |inbox| {
        inbox.decide(
            &approved,
            ModerationAction::UpholdReport,
            3,
            Some(ReasonCode::Abusive),
        )
    });
    assert_eq!(refused.unwrap_err(), PolicyError::NotAllowed);
}

#[test]
fn a_purged_item_keeps_only_its_facts_and_takes_no_decision() {
    let purged = json!({
        "source": "feedback", "id": ITEM, "kind": "question", "status": "rejected", "version": 4,
        "revision": 2, "moderatedAt": "2026-10-26T11:00:00Z", "reason": "spam",
        "receivedAt": "2026-10-26T10:00:00Z", "work": WORK, "purgedAt": "2026-10-27T09:00:00Z",
    });
    let item = InboxItem::from_value(&purged).unwrap();
    assert_eq!(item.content, Content::Purged);
    assert!(!item.facts().content_retained);
    // Its facts stay explainable to the site Admin: no text, no name, no
    // decision, and nothing public.
    let view = with_inbox(Protocol::Protected, |inbox| inbox.view(&item)).unwrap();
    assert_eq!(view["purged"], true);
    assert_eq!(view["body"], Value::Null);
    assert_eq!(view["reader"], json!({"publishName": false}));
    assert_eq!(view["public"], false);
    assert_eq!(view["reasonLabel"], "Spam");
    assert!(action_ids(&view).is_empty());
    // A purged item that claims to be public, or carries text, is refused.
    for (key, value) in [
        ("status", json!("approved")),
        ("body", json!("still here")),
        ("readerName", json!("Private Reader")),
        ("purgedAt", json!("yesterday")),
    ] {
        let mut row = purged.clone();
        row[key] = value;
        assert!(InboxItem::from_value(&row).is_err(), "{key}");
    }
    let page =
        read_page(&json!({"protocol": "protected", "items": [purged], "next": null})).unwrap();
    assert_eq!(page.protocol, Protocol::Protected);
    assert_eq!(page.items.len(), 1);
}

#[test]
fn the_site_admin_is_offered_deletion_of_a_closed_item_only_with_the_protection_schema() {
    let mut row = report("rejected", reported_comment("approved"));
    row["reason"] = json!("no-action");
    let rejected = InboxItem::from_value(&row).unwrap();
    let view = with_inbox(Protocol::Protected, |inbox| inbox.view(&rejected).unwrap());
    let ids = action_ids(&view);
    assert!(ids.contains(&ERASE_ACTION.to_string()), "{ids:?}");
    let erase = view["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|action| action["action"] == ERASE_ACTION)
        .unwrap();
    assert!(erase["confirm"].as_str().unwrap().contains("for good"));
    let erasure = with_inbox(Protocol::Protected, |inbox| inbox.erase(&rejected, 3)).unwrap();
    assert!(erasure.withdrawal.is_none());
    assert_eq!(
        with_inbox(Protocol::Full, |inbox| inbox.erase(&rejected, 3)).unwrap_err(),
        PolicyError::NotAllowed
    );
    let view = with_inbox(Protocol::Full, |inbox| inbox.view(&rejected).unwrap());
    assert!(!action_ids(&view).contains(&ERASE_ACTION.to_string()));
    // A pending item is decided first.
    let pending = InboxItem::from_value(&report("pending", reported_comment("approved"))).unwrap();
    assert_eq!(
        with_inbox(Protocol::Protected, |inbox| inbox.erase(&pending, 3)).unwrap_err(),
        PolicyError::NotAllowed
    );
    // Retention sees what the inbox sees.
    let old = {
        let mut row = row.clone();
        row["moderatedAt"] = json!("2026-01-01T00:00:00Z");
        InboxItem::from_value(&row).unwrap()
    };
    assert_eq!(
        with_inbox(Protocol::Protected, |inbox| inbox.retention_due(&old)),
        Some(RetentionStep::PurgeContent)
    );
    assert_eq!(
        with_inbox(Protocol::Protected, |inbox| inbox.retention_due(&rejected)),
        None
    );
}
