//! Roundtables at the documented bounds (#188): groups of 3, 10 and the participant cap author,
//! arrange, synthesise, approve and publish through the one pipeline; the reading order is
//! deterministic; every contribution and credit survives every portable sequential form; and
//! over-limit groups, removal, restore, stale writes and hostile values fail safely without
//! exposing another participant's words.

use openblog_core::approval::{ApprovalError, ApprovalSet};
use openblog_core::assembly::{assemble, with_subject, Assembly, AssemblyError};
use openblog_core::collaboration::{
    AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference,
    Participant, SharedPublication, SourceKind, MAX_ADMIN_USERNAME_BYTES, MAX_DISPLAY_NAME_BYTES,
    MAX_GUIDING_QUESTION_BYTES, MAX_IDENTIFIER_BYTES, MAX_PARTICIPANTS,
    MAX_PUBLICATION_TITLE_BYTES, MAX_SHARED_PUBLICATION_BYTES, MAX_SOURCES,
    MAX_SOURCE_DETAIL_BYTES, MAX_SOURCE_TITLE_BYTES,
};
use openblog_core::config::SiteConfig;
use openblog_core::contributor::Contributor;
use openblog_core::draft::{DraftError, DraftSet};
use openblog_core::feeds;
use openblog_core::invitation::{Identities, NewInvitation};
use openblog_core::media_moment::MomentSet;
use openblog_core::members::MAX_AUDIT_ENTRIES;
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::portability::PortableProjection;
use openblog_core::reflection::{ReflectionStructure, PART_MARKER};
use openblog_core::render;
use openblog_core::synthesis::{NewSynthesisItem, SynthesisKind, SynthesisSet};
use openblog_core::theme::ThemeSet;

const T: i64 = 1_800_000_000;
const DATE: &str = "2030-01-31T09:00:00Z";
const PUBLICATION: &str = "shared-0a1b2c3d4e5f";

#[test]
fn a_full_group_with_the_longest_values_and_a_full_audit_trail_still_loads() {
    let long_id = |prefix: &str, n: usize| {
        let head = format!("{prefix}{n:03}-");
        format!("{head}{}", "k".repeat(MAX_IDENTIFIER_BYTES - head.len()))
    };
    let long_user = |n: usize| {
        let head = format!("u{n:03}");
        format!(
            "{head}{}",
            "a".repeat(MAX_ADMIN_USERNAME_BYTES - head.len())
        )
    };
    // Quotes and backslashes are each written as two bytes in JSON: the longest stored text.
    let escaped = |bytes: usize| "\"\\".repeat(bytes / 2);
    let source = |n: usize| NewSourceReference {
        kind: SourceKind::Book,
        title: format!("{n:02}{}", escaped(MAX_SOURCE_TITLE_BYTES - 2)),
        url: format!("https://example.org/{n:02}/{}", "u".repeat(2_000)),
        creator: escaped(MAX_SOURCE_DETAIL_BYTES),
        publisher: escaped(MAX_SOURCE_DETAIL_BYTES),
        published: "2020-01-01".into(),
        isbn: String::new(),
    };
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: PUBLICATION.into(),
        title: escaped(MAX_PUBLICATION_TITLE_BYTES),
        guiding_question: escaped(MAX_GUIDING_QUESTION_BYTES),
        sources: (0..MAX_SOURCES).map(source).collect(),
        creator: NewParticipant {
            admin_user: long_user(0),
            contributor_id: long_id("c", 0),
            display_name: escaped(MAX_DISPLAY_NAME_BYTES),
        },
    })
    .unwrap();
    record.collaboration.participants[0].id = long_id("p", 0);
    record.authorization.bindings[0].participant_id = long_id("p", 0);
    for n in 1..MAX_PARTICIPANTS {
        record.collaboration.participants.push(Participant {
            id: long_id("p", n),
            display_name: format!("{n:03}{}", escaped(MAX_DISPLAY_NAME_BYTES - 3)),
            profile_url: None,
        });
        record.authorization.bindings.push(IdentityBinding {
            admin_user: long_user(n),
            contributor_id: long_id("c", n),
            participant_id: long_id("p", n),
            roles: vec![
                AuthorizationRole::SiteOwner,
                AuthorizationRole::Coordinator,
                AuthorizationRole::Contributor,
                AuthorizationRole::Editor,
                AuthorizationRole::Reader,
            ],
        });
    }
    let all_roles = record.authorization.bindings[1].roles.clone();
    let mut json: serde_json::Value = serde_json::to_value(&record).unwrap();
    json["audit"] = serde_json::Value::Array(
        (0..MAX_AUDIT_ENTRIES)
            .map(|n| {
                serde_json::json!({
                    "seq": n + 1,
                    "at": T,
                    "actor": long_id("p", n % MAX_PARTICIPANTS),
                    "event": "rolesChanged",
                    "subject": long_id("p", (n + 1) % MAX_PARTICIPANTS),
                    "from": all_roles,
                    "to": all_roles,
                })
            })
            .collect(),
    );
    json["invitations"] = serde_json::Value::Array(
        (0..openblog_core::invitation::MAX_INVITATIONS)
            .map(|n| {
                serde_json::json!({
                    "id": long_id("i", n),
                    "adminUser": long_user(n),
                    "contributorId": long_id("c", n),
                    "roles": all_roles,
                    "invitedBy": long_id("p", 0),
                    "createdAt": T,
                    "expiresAt": T + 86_400,
                    "state": "accepted",
                    "resolvedAt": T + 1,
                    "participantId": long_id("p", n),
                })
            })
            .collect(),
    );
    // The store writes records pretty-printed: that is the text that must load again.
    let text = format!("{}\n", serde_json::to_string_pretty(&json).unwrap());
    assert!(
        text.len() < MAX_SHARED_PUBLICATION_BYTES,
        "{} of {MAX_SHARED_PUBLICATION_BYTES} bytes",
        text.len()
    );
    let loaded = SharedPublication::from_json(&text).unwrap();
    assert_eq!(loaded.collaboration.participants.len(), MAX_PARTICIPANTS);
    assert_eq!(loaded.audit.len(), MAX_AUDIT_ENTRIES);
}

// ---------------------------------------------------------------- a group of any size

/// A display name that tries to become markup, a link and an entity everywhere it is shown.
const HOSTILE_NAME: &str = "Bo <img src=x onerror=alert(1)> [x](javascript:alert(1)) &amp;";

/// Values that must never appear in any public output.
const PRIVATE: &[&str] = &[
    "-admin",
    PUBLICATION,
    "openblog:part",
    "invitation",
    "approval",
    "revision",
    "participant",
    "adminUser",
    "contributorId",
    "digest",
    ".openblog",
    "not shared with you",
];

fn id(n: usize) -> String {
    format!("p{n:03}")
}

fn name(n: usize) -> String {
    if n == 1 {
        HOSTILE_NAME.to_string()
    } else {
        format!("Person {n:03}")
    }
}

fn words(n: usize) -> String {
    format!("OPEN-{n:03} noticed *this*.\n{PART_MARKER}\nCLOSE-{n:03} noticed that.")
}

/// Everyone who takes part, who still writes, and what they have written and approved.
struct Group {
    record: SharedPublication,
    members: Vec<String>,
    drafts: DraftSet,
    synthesis: SynthesisSet,
    structure: ReflectionStructure,
    approvals: ApprovalSet,
}

impl Group {
    /// `n` participants. `reverse` builds the very same piece with every store filled in the
    /// opposite order, which must not change a byte of what publishes.
    fn new(n: usize, reverse: bool) -> Self {
        let mut record = SharedPublication::create(&NewSharedPublication {
            publication_id: PUBLICATION.into(),
            title: "Around the table".into(),
            guiding_question: "What did you notice?".into(),
            sources: vec![NewSourceReference {
                kind: SourceKind::Video,
                title: "The Art of Noticing".into(),
                url: "https://www.youtube.com/watch?v=abc123".into(),
                ..NewSourceReference::default()
            }],
            creator: NewParticipant {
                admin_user: format!("{}-admin", id(0)),
                contributor_id: id(0),
                display_name: name(0),
            },
        })
        .unwrap();
        record.collaboration.participants[0].id = id(0);
        record.authorization.bindings[0].participant_id = id(0);
        for n in 1..n {
            record.collaboration.participants.push(Participant {
                id: id(n),
                display_name: name(n),
                profile_url: None,
            });
            record.authorization.bindings.push(IdentityBinding {
                admin_user: format!("{}-admin", id(n)),
                contributor_id: id(n),
                participant_id: id(n),
                roles: vec![AuthorizationRole::Contributor],
            });
        }
        let members: Vec<String> = (0..n).map(id).collect();
        let mut order = members.clone();
        if reverse {
            order.reverse();
        }
        let refs = order.iter().map(String::as_str).collect::<Vec<_>>();
        let mut drafts = DraftSet::new(&refs).unwrap();
        for who in &order {
            let n: usize = who[1..].parse().unwrap();
            drafts.save(who, who, 0, &words(n), T).unwrap();
        }
        let mut group = Self {
            record,
            structure: roundtable(&members, 1),
            members,
            drafts,
            synthesis: SynthesisSet::new(),
            approvals: ApprovalSet::new(),
        };
        // One agreement, written by the first three together; nobody speaks for anyone else.
        let active = group.members.clone();
        let active = active.iter().map(String::as_str).collect::<Vec<_>>();
        let item = group
            .synthesis
            .add(
                &id(0),
                &active,
                0,
                NewSynthesisItem {
                    kind: SynthesisKind::Agreement,
                    markdown: "SYNTH-AGREEMENT: we all slowed down.",
                    others: &[&id(1), &id(2)],
                },
            )
            .unwrap();
        let mut approvers = vec![id(0), id(1), id(2)];
        if reverse {
            approvers.reverse();
        }
        for who in approvers {
            let revision = group.synthesis.revision();
            group
                .synthesis
                .approve_item(&who, &active, revision, &item)
                .unwrap();
        }
        group.approve_all(reverse);
        group
    }

    fn active(&self) -> Vec<&str> {
        self.members.iter().map(String::as_str).collect()
    }

    fn seen(&self, who: &str) -> String {
        with_subject(
            &self.record,
            Some(&self.structure),
            &self.drafts,
            &self.synthesis,
            &MomentSet::new(),
            &self.active(),
            |s| self.approvals.binding_for(s, who).unwrap(),
        )
    }

    fn approve_seen(&mut self, who: &str, seen: &str) -> Result<(), ApprovalError> {
        let active = self.members.clone();
        let active = active.iter().map(String::as_str).collect::<Vec<_>>();
        with_subject(
            &self.record,
            Some(&self.structure),
            &self.drafts,
            &self.synthesis,
            &MomentSet::new(),
            &active,
            |s| self.approvals.approve(who, who, s, seen, true, T),
        )
    }

    fn approve(&mut self, who: &str) {
        let seen = self.seen(who);
        self.approve_seen(who, &seen).unwrap();
    }

    fn approve_all(&mut self, reverse: bool) {
        let mut everyone = self.members.clone();
        if reverse {
            everyone.reverse();
        }
        for who in everyone {
            self.approve(&who);
        }
    }

    /// Drop approvals that no longer match, as every route does in the same write as a change.
    fn reconcile(&mut self) -> usize {
        let active = self.members.clone();
        let active = active.iter().map(String::as_str).collect::<Vec<_>>();
        with_subject(
            &self.record,
            Some(&self.structure),
            &self.drafts,
            &self.synthesis,
            &MomentSet::new(),
            &active,
            |s| self.approvals.reconcile(s),
        )
        .unwrap()
    }

    fn assemble(&self) -> Result<Assembly, AssemblyError> {
        assemble(
            &self.record,
            Some(&self.structure),
            &self.drafts,
            &self.synthesis,
            &MomentSet::new(),
            &self.approvals,
            &self.active(),
            DATE,
        )
    }
}

/// A roundtable of two rounds: the first goes round the table starting halfway, the second
/// comes back the other way, so the reading order is neither participant nor storage order.
fn roundtable(ids: &[String], revision: u64) -> ReflectionStructure {
    ReflectionStructure::from_json(&roundtable_json(ids, revision)).unwrap()
}

fn roundtable_json(ids: &[String], revision: u64) -> String {
    let n = ids.len();
    let first = (0..n)
        .map(|k| {
            let label = if k == 0 { r#","label":"Opens""# } else { "" };
            format!(r#"{{"draft":"{}","part":0{label}}}"#, ids[(k + n / 2) % n])
        })
        .collect::<Vec<_>>()
        .join(",");
    let second = ids
        .iter()
        .rev()
        .map(|who| format!(r#"{{"draft":"{who}","part":1}}"#))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"{{"version":1,"revision":{revision},"layout":"roundtable","rounds":[
            {{"id":"r1","roundPrompt":"Opening round","turns":[{first}]}},
            {{"id":"r2","roundPrompt":"Closing round","turns":[{second}]}}]}}"#
    )
}

/// What the reader meets, in order: the first round, the second, then the agreement.
fn reading(ids: &[usize]) -> Vec<String> {
    let n = ids.len();
    let mut needles = vec!["Opening round".to_string()];
    needles.extend((0..n).map(|k| format!("OPEN-{:03}", ids[(k + n / 2) % n])));
    needles.push("Closing round".to_string());
    needles.extend(ids.iter().rev().map(|n| format!("CLOSE-{n:03}")));
    needles.push("SYNTH-AGREEMENT".to_string());
    needles
}

/// The author names in the order a reader first meets them.
fn credit_order(ids: &[usize]) -> Vec<String> {
    let n = ids.len();
    (0..n).map(|k| name(ids[(k + n / 2) % n])).collect()
}

fn config(ids: &[usize]) -> SiteConfig {
    let mut config = SiteConfig::from_json(
        r#"{"title":"T","url":"https://example.test","postPath":"/{slug}/","author":{"name":"Site Owner"},"feeds":{"fullContent":true}}"#,
    )
    .unwrap();
    for n in ids {
        config.contributors.insert(
            id(*n),
            Contributor {
                name: name(*n),
                url: format!("https://example.org/{}", id(*n)),
                ..Contributor::default()
            },
        );
    }
    config
}

fn site(made: &Assembly, ids: &[usize]) -> Site {
    Site::load(
        config(ids),
        Sources {
            posts: vec![SourceFile {
                path: made.path.clone(),
                contents: made.source.clone(),
            }],
            credits: vec![SourceFile {
                path: made.credits_path.clone(),
                contents: made.credits.clone(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"))
}

fn clean(label: &str, output: &str) {
    let lower = output.to_ascii_lowercase();
    for needle in PRIVATE {
        assert!(
            !lower.contains(&needle.to_ascii_lowercase()),
            "{label} leaked `{needle}`"
        );
    }
}

fn in_order(label: &str, output: &str, needles: &[String]) {
    let mut from = 0;
    for needle in needles {
        let at = output[from..]
            .find(needle.as_str())
            .unwrap_or_else(|| panic!("{label} lost or reordered `{needle}`"));
        from += at + needle.len();
    }
}

/// Publish the piece and check every representation: the page, portable HTML, Markdown and
/// text, RSS, JSON Feed and llms-full.txt, plus every other generated file for leaks.
fn check_every_representation(made: &Assembly, ids: &[usize], label: &str) {
    let site = site(made, ids);
    let needles = reading(ids);
    // The generated arrangement frame is not reported as custom markup to review.
    assert!(
        site.accessibility.is_empty(),
        "{label}: {:?}",
        site.accessibility
    );
    let files = render::generate(&site, &ThemeSet::new()).unwrap();
    let page = &files
        .iter()
        .find(|file| file.path.ends_with("around-the-table/index.html"))
        .expect("native page")
        .contents;
    in_order(&format!("{label} page"), page, &needles);
    assert!(page.contains("ob-reflection-roundtable"), "{label}");
    assert_eq!(
        page.matches("<section class=\"ob-turn").count(),
        2 * ids.len(),
        "{label}: one section per turn, none blank"
    );
    for file in &files {
        clean(&format!("{label} {}", file.path), &file.contents);
        // Markup formats show the hostile name as text; JSON carries it as a plain string.
        if file.path.ends_with(".html") || file.path.ends_with(".xml") {
            assert!(
                !file.contents.contains("<img src=x"),
                "{label} {}",
                file.path
            );
        }
    }

    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let html = projection.portable_html().unwrap().html;
    let markdown = projection.portable_markdown().unwrap();
    let text = projection.portable_text().unwrap();
    let llms = feeds::llms_full(&site).unwrap();
    for (form, output) in [
        ("html", &html),
        ("markdown", &markdown),
        ("text", &text),
        ("llms-full", &llms),
    ] {
        in_order(&format!("{label} {form}"), output, &needles);
        clean(&format!("{label} {form}"), output);
    }
    assert!(!html.contains("<img src=x"), "{label}: the name stays text");
    // The sequential equivalent heads every turn with its author, so each name is there twice.
    for n in ids.iter().filter(|n| **n != 1) {
        assert!(
            text.matches(&format!("Person {n:03}")).count() >= 2,
            "{label} text lost the credit of Person {n:03}"
        );
    }

    let rss = feeds::rss(&site).unwrap();
    in_order(&format!("{label} rss"), &rss, &needles);
    assert_eq!(rss.matches("<dc:creator>").count(), ids.len(), "{label}");
    clean(&format!("{label} rss"), &rss);
    let json = feeds::json_feed(&site).unwrap();
    let feed: serde_json::Value = serde_json::from_str(&json).unwrap();
    let authors = feed["items"][0]["authors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|author| author["name"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        authors,
        credit_order(ids),
        "{label}: credits in reading order"
    );
    in_order(
        &format!("{label} json text"),
        feed["items"][0]["content_text"].as_str().unwrap(),
        &needles,
    );
    clean(&format!("{label} json feed"), &json);
}

#[test]
fn roundtables_of_three_ten_and_the_cap_publish_every_contribution_in_reading_order() {
    for n in [3, 10, MAX_PARTICIPANTS] {
        let group = Group::new(n, false);
        let made = group.assemble().unwrap();
        let ids = (0..n).collect::<Vec<_>>();
        check_every_representation(&made, &ids, &format!("{n} people"));
        // The same piece, with every store filled in the opposite order, publishes identically,
        // and publishing it again changes nothing.
        let reversed = Group::new(n, true).assemble().unwrap();
        assert_eq!(made.source, reversed.source, "{n} people");
        assert_eq!(made.credits, reversed.credits, "{n} people");
        assert_eq!(made.source, group.assemble().unwrap().source);
    }
}

// ---------------------------------------------------------------- over the limit

fn identities_for(n: usize) -> (Vec<String>, Vec<String>) {
    (
        (0..n).map(|n| format!("{}-admin", id(n))).collect(),
        (0..n).map(id).collect(),
    )
}

#[test]
fn a_group_over_the_cap_is_refused_at_every_boundary_and_nothing_changes() {
    let full = Group::new(MAX_PARTICIPANTS, false);
    let over = MAX_PARTICIPANTS + 1;
    let ids = (0..over).map(id).collect::<Vec<_>>();
    let refs = ids.iter().map(String::as_str).collect::<Vec<_>>();

    // The record: a 101st participant does not load.
    let mut json = serde_json::to_value(&full.record).unwrap();
    json["collaboration"]["participants"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({ "id": id(MAX_PARTICIPANTS), "displayName": "One too many" }));
    assert!(SharedPublication::from_json(&json.to_string()).is_err());

    // An invitation into a full group is refused and the record is unchanged.
    let (users, keys) = identities_for(over);
    let users = users.iter().map(String::as_str).collect::<Vec<_>>();
    let keys = keys.iter().map(String::as_str).collect::<Vec<_>>();
    let identities = Identities {
        active_admin_users: &users,
        contributor_ids: &keys,
    };
    let invited = full.record.invite(
        &format!("{}-admin", id(0)),
        &identities,
        &NewInvitation {
            id: "invitation-0101".into(),
            secret: format!("{:064x}", 101),
            admin_user: format!("{}-admin", id(MAX_PARTICIPANTS)),
            contributor_id: id(MAX_PARTICIPANTS),
            roles: vec![AuthorizationRole::Contributor],
            lifetime_days: 0,
        },
        T,
    );
    assert!(invited.is_err());

    // Drafts: a set for 101 people cannot exist, and a full set admits nobody else.
    assert!(DraftSet::new(&refs).is_err());
    let mut drafts = full.drafts.clone();
    assert_eq!(
        drafts.admit(&id(MAX_PARTICIPANTS)),
        Err(DraftError::Invalid)
    );
    assert_eq!(drafts, full.drafts);

    // The arrangement: a round of 101 turns is refused, so is one naming an unknown draft.
    assert!(ReflectionStructure::from_json(&roundtable_json(&ids, 1)).is_err());

    // Approval: an approver outside the group is denied; a rule naming 101 people is refused.
    let mut approvals = full.approvals.clone();
    let outsider = id(MAX_PARTICIPANTS);
    let refused = with_subject(
        &full.record,
        Some(&full.structure),
        &full.drafts,
        &full.synthesis,
        &MomentSet::new(),
        &full.active(),
        |s| approvals.approve(&outsider, &outsider, s, "x", true, T),
    );
    assert_eq!(refused, Err(ApprovalError::Denied));
    let too_many = openblog_core::approval::ApprovalPolicy {
        requirement: openblog_core::approval::ApprovalRequirement::NamedAuthors(ids.clone()),
        ..Default::default()
    };
    assert!(!approvals.set_policy(too_many));
    assert_eq!(approvals, full.approvals);

    // Assembling with an outsider in the active list publishes nobody who is not in the group.
    let mut active = full.active();
    active.push(&outsider);
    let made = assemble(
        &full.record,
        Some(&full.structure),
        &full.drafts,
        &full.synthesis,
        &MomentSet::new(),
        &full.approvals,
        &active,
        DATE,
    );
    if let Ok(made) = made {
        assert!(!made.source.contains(&outsider));
    }
}

// ---------------------------------------------------------------- recovery mid-flow

#[test]
fn an_edit_in_a_group_of_ten_asks_only_its_author_to_approve_again() {
    let mut group = Group::new(10, false);
    let stale_seen = group.seen(&id(7));
    let stamp = group.drafts.current_stamp(&id(7)).unwrap();
    group
        .drafts
        .save(
            &id(7),
            &id(7),
            stamp.number,
            "OPEN-007 rewrote it.\n<!-- openblog:part -->\nCLOSE-007 too.",
            T + 5,
        )
        .unwrap();
    // A save built on the revision before is refused and changes nothing.
    let before = group.drafts.clone();
    assert_eq!(
        group
            .drafts
            .save(&id(7), &id(7), stamp.number, "LOST-UPDATE", T + 6),
        Err(DraftError::Stale)
    );
    assert_eq!(group.drafts, before);
    // Under the default scope only the editor's approval is stale, and the gate names them.
    assert_eq!(group.reconcile(), 1);
    match group.assemble() {
        Err(AssemblyError::Blocked { missing }) => assert_eq!(missing, vec![name(7)]),
        other => panic!("{other:?}"),
    }
    // An approval of what they read before the edit does not land.
    assert_eq!(
        group.approve_seen(&id(7), &stale_seen),
        Err(ApprovalError::Stale)
    );
    group.approve(&id(7));
    let made = group.assemble().unwrap();
    assert!(made.source.contains("OPEN-007 rewrote it.") && !made.source.contains("LOST-UPDATE"));
}

#[test]
fn removing_and_restoring_a_member_mid_flow_never_publishes_unapproved_words() {
    let mut group = Group::new(10, false);
    let (users, keys) = identities_for(11);
    let users = users.iter().map(String::as_str).collect::<Vec<_>>();
    let keys = keys.iter().map(String::as_str).collect::<Vec<_>>();
    let identities = Identities {
        active_admin_users: &users,
        contributor_ids: &keys,
    };
    let owner = format!("{}-admin", id(0));

    // Person 005 is removed after everyone approved: the author set changed, so every approval
    // is stale and nothing publishes until the nine who remain approve again.
    let revision = group.record.authorization.revision;
    group.record = group
        .record
        .remove_member(&owner, &identities, &id(5), revision, T + 10)
        .unwrap();
    group.members.retain(|who| *who != id(5));
    assert_eq!(group.reconcile(), 10);
    assert!(matches!(
        group.assemble(),
        Err(AssemblyError::Blocked { .. })
    ));
    group.approve_all(false);
    let made = group.assemble().unwrap();
    let nine = (0..10).filter(|n| *n != 5).collect::<Vec<_>>();
    assert!(!made.source.contains("OPEN-005") && !made.source.contains("CLOSE-005"));
    assert!(!made.source.contains(&name(5)) && !made.credits.contains(&id(5)));
    // Their turns are dropped, not left as a gap or a placeholder.
    let site = site(&made, &nine);
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let text = projection.portable_text().unwrap();
    for n in &nine {
        assert!(text.contains(&format!("OPEN-{n:03}")) && text.contains(&format!("CLOSE-{n:03}")));
    }
    clean("after removal", &text);
    assert!(!text.contains("Person 005"));
    // Their participant, words and audit entry stay in the private record for credit.
    assert!(group
        .record
        .collaboration
        .participants
        .iter()
        .any(|p| p.id == id(5)));
    assert!(group.drafts.current_stamp(&id(5)).is_some());

    // They come back through a new invitation as a new participant, who cannot see or publish
    // the earlier words, and who must approve what is published under their name.
    group.record.collaboration.participants.push(Participant {
        id: "p010".into(),
        display_name: "Person 010".into(),
        profile_url: None,
    });
    group.record.authorization.bindings.push(IdentityBinding {
        admin_user: format!("{}-admin", id(5)),
        contributor_id: id(5),
        participant_id: "p010".into(),
        roles: vec![AuthorizationRole::Contributor],
    });
    group.drafts.admit("p010").unwrap();
    group.members.push("p010".into());
    let returning = group.members.iter().map(String::as_str).collect::<Vec<_>>();
    assert!(group.drafts.view("p010", &id(5), &returning).is_err());
    group
        .drafts
        .save("p010", "p010", 0, &words(10), T + 20)
        .unwrap();
    let stale = group.structure.revision;
    let replacement = roundtable_json(&group.members, stale + 1);
    let arranged = group
        .structure
        .replace_from_json(&replacement, stale)
        .unwrap();
    assert!(group
        .structure
        .replace_from_json(&replacement, stale + 7)
        .is_err());
    group.structure = arranged;
    group.reconcile();
    match group.assemble() {
        Err(AssemblyError::Blocked { missing }) => assert_eq!(missing.len(), 10),
        other => panic!("{other:?}"),
    }
    group.approve_all(false);
    let made = group.assemble().unwrap();
    assert!(made.source.contains("OPEN-010") && made.source.contains("CLOSE-010"));
    assert!(!made.source.contains("OPEN-005") && !made.source.contains(&name(5)));
}

#[test]
fn hostile_prose_from_one_of_ten_refuses_the_whole_piece_and_names_nobody_elses_words() {
    let mut group = Group::new(10, false);
    let stamp = group.drafts.current_stamp(&id(4)).unwrap();
    group
        .drafts
        .save(
            &id(4),
            &id(4),
            stamp.number,
            &format!(
                "OPEN-004 [click](javascript:alert(1)) <script>steal()</script>
{PART_MARKER}
CLOSE-004"
            ),
            T + 5,
        )
        .unwrap();
    group.reconcile();
    group.approve(&id(4));
    // Everyone approved, but the piece refuses as a whole: no partial post is ever produced.
    assert_eq!(group.assemble(), Err(AssemblyError::UnsafeMarkup));

    // A part an author deleted after the arrangement was made is a mismatch, never a gap: even
    // approved by everyone, the piece does not publish until the arrangement is fixed.
    let stamp = group.drafts.current_stamp(&id(6)).unwrap();
    group
        .drafts
        .save(&id(6), &id(6), stamp.number, "OPEN-006 only.", T + 6)
        .unwrap();
    group.reconcile();
    group.approve(&id(6));
    assert_eq!(group.assemble(), Err(AssemblyError::ArrangementMismatch));
}
