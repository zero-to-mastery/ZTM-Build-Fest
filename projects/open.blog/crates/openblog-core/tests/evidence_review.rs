//! Evidence submissions and correction decisions in the reader form and the
//! Moderation inbox (#217, ADRs 0116 and 0117): the form lists only what the
//! site publishes, an editor sees each reference a reader named as published
//! or not and never as private, the inbox tells items apart without calling a
//! suggestion a correction, records a decision with the viewer's role, and
//! cues possible duplicates without counting them.

use std::collections::BTreeMap;

use openblog_core::claim_publication::{ClaimEvidence, ClaimEvidenceSource};
use openblog_core::claims::{ClaimSet, Relation};
use openblog_core::correction_decision::{
    DecisionContent, DecisionErrorCode, DecisionOutcome, Extent, RevisionLink,
};
use openblog_core::evidence_submission::{
    evidence_review, published_source_label, reference_choices, EvidenceOffer, EvidenceSubmission,
    SitePublishedSources, SiteReferenceIndex,
};
use openblog_core::feedback_provenance::FeedbackChannel;
use openblog_core::invitation::Identities;
use openblog_core::knowledge_atlas::Links;
use openblog_core::moderation::{ModerationPolicy, Principal, SharedWorks};
use openblog_core::moderation_inbox::{similar_items, DecisionDraft, Inbox, InboxItem, Protocol};
use openblog_core::passage_target::PassageDocument;
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use openblog_core::{
    generate, DateTime, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};
use serde_json::{json, Value};

/// Every value that must stay private carries this marker.
const PRIVATE: &str = "PRIVATE-EVIDENCE-MARKER";

const CAVE: &str = "---
title: The cave
date: 2026-10-20
evidenceRevisions:
  - \"2026-10-21 cave: Added the critic's contrary reading.\"
---
The cave educates. Later the sun appears.

## Light

The sun appears at last.
";

fn library() -> SourceLibrary {
    let text = json!({"version": 1, "sources": [
        {"id": "plato", "kind": "work", "title": format!("{PRIVATE} Politeia")},
        {"id": "slings", "kind": "work", "title": "PUBLIC Slings", "issued": "2003"},
        {"id": "critic", "kind": "work", "title": "PUBLIC Critic"},
        {"id": "unused", "kind": "work", "title": format!("{PRIVATE} unused source")}]})
    .to_string();
    SourceLibrary::parse(&text, &BTreeMap::new()).unwrap()
}

fn claims() -> Value {
    json!({"version": 1,
        "claims": [
            {"id": "cave", "post": "cave", "statement": "PUBLIC The cave educates.", "visibility": "approved",
             "anchor": {"start": 0, "end": 18, "text": "The cave educates."}},
            {"id": "sun", "post": "cave", "statement": "PUBLIC The sun appears.", "visibility": "approved"},
            {"id": "withheld-claim", "post": "cave", "statement": format!("{PRIVATE} private claim"), "visibility": "private"}],
        "links": [
            {"id": "s1", "claim": "cave", "relation": "supports", "visibility": "approved",
             "evidence": {"source": "slings"}, "confidence": "plausible"},
            {"id": "c1", "claim": "cave", "relation": "contradicts", "visibility": "approved",
             "evidence": {"source": "critic"}, "confidence": "strong"},
            {"id": "ctx-private-link", "claim": "cave", "relation": "contextualizes", "visibility": "private",
             "evidence": {"source": "slings"}, "rationale": format!("{PRIVATE} private rationale")},
            {"id": "h1", "claim": "withheld-claim", "relation": "supports", "visibility": "approved",
             "evidence": {"source": "plato"}}]})
}

fn projection() -> ClaimEvidence {
    let library = library();
    let notebook = Notebook::parse(r#"{"version": 1, "passages": []}"#, &library).unwrap();
    let set = ClaimSet::parse(
        &claims().to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .expect("a valid claims file");
    ClaimEvidence::project(&set, &library).expect("a projection")
}

fn site(evidence: bool) -> Site {
    let mut config = SiteConfig::from_json(&format!(
        r#"{{"title": "Evidence", "url": "https://example.test", "author": {{"name": "A"}},
            "engagement": {{"enabled": true, "feedback": true, "endpoint": "https://example.test/api", "evidence": {evidence}}}}}"#
    ))
    .unwrap();
    config.claim_evidence.publish = true;
    Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: "posts/cave.md".into(),
                contents: CAVE.into(),
            }],
            claim_evidence: Some(ClaimEvidenceSource::Stored(projection())),
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"))
}

fn cave(site: &Site) -> &openblog_core::Post {
    site.posts.iter().find(|post| post.slug == "cave").unwrap()
}

fn data_element(html: &str, id: &str) -> Option<Value> {
    let start = html.find(&format!("id=\"{id}\">"))? + id.len() + 6;
    let end = start + html[start..].find("</script>")?;
    Some(serde_json::from_str(&html[start..end]).unwrap())
}

#[test]
fn the_reader_form_lists_only_what_the_site_publishes() {
    let site = site(true);
    let files = generate(&site, &ThemeSet::new()).unwrap();
    let page = files
        .iter()
        .find(|file| file.path.ends_with("cave/index.html"))
        .unwrap();
    let html = &page.contents;
    assert!(
        html.contains(" evidence>"),
        "the form is told to offer evidence"
    );
    let choices =
        data_element(html, "ob-evidence-references").expect("the choices are on the page");
    let ids = |list: &Value| -> Vec<String> {
        list.as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(ids(&choices["claims"]), ["cave", "sun"]);
    assert_eq!(ids(&choices["claims"][0]["links"]), ["s1", "c1"]);
    assert_eq!(
        choices["claims"][0]["label"],
        "Claim 1: PUBLIC The cave educates."
    );
    let mut sources = ids(&choices["sources"]);
    sources.sort();
    assert_eq!(sources, ["critic", "slings"]);
    assert!(!html.contains(PRIVATE), "nothing private reaches the page");
    for private in [
        "withheld-claim",
        "ctx-private-link",
        "\"h1\"",
        "\"plato\"",
        "\"unused\"",
    ] {
        assert!(!html.contains(private), "{private}");
    }
    // A site that has not switched evidence on builds the form as before.
    let off = generate(&self::site(false), &ThemeSet::new()).unwrap();
    let html = &off
        .iter()
        .find(|file| file.path.ends_with("cave/index.html"))
        .unwrap()
        .contents;
    assert!(!html.contains(" evidence>"));
    assert!(!html.contains("ob-evidence-references"));
    assert_eq!(
        reference_choices(cave(&site), &SiteReferenceIndex::of_site(&site))["version"],
        1
    );
}

#[test]
fn the_site_index_labels_and_lists_exactly_what_the_one_by_one_lookups_do() {
    let site = site(true);
    let index = SiteReferenceIndex::of_site(&site);
    let direct = SitePublishedSources::of_site(&site);
    for id in [
        "critic",
        "slings",
        "plato",
        "unused",
        "withheld-claim",
        "nothing",
    ] {
        assert_eq!(
            index.label(id).map(str::to_string),
            published_source_label(&site, id),
            "{id}"
        );
        assert_eq!(
            index.sources().has_source(id),
            direct.has_source(id),
            "{id}"
        );
    }
    assert!(index.label("critic").is_some());
}

#[test]
fn an_editor_sees_each_named_reference_as_published_or_not_never_as_private() {
    let site = site(true);
    let post = cave(&site);
    let private = EvidenceOffer {
        claim: Some("withheld-claim".into()),
        evidence_link: Some("h1".into()),
        citation: Some("plato".into()),
        source: Some("unused".into()),
        ..EvidenceOffer::default()
    };
    let review = evidence_review(&private, Some(post), &site);
    for key in ["claim", "evidenceLink", "citation", "source"] {
        assert_eq!(review[key]["published"], false, "{key}");
        assert!(
            review[key].get("label").is_none(),
            "{key}: nothing about it is said"
        );
    }
    assert_eq!(review["stale"], true);
    assert!(!review.to_string().contains(PRIVATE));
    // The same shapes as a mistyped id: "not published" says nothing more.
    let mistyped = EvidenceOffer {
        claim: Some("no-such-claim".into()),
        evidence_link: Some("no-such-link".into()),
        citation: Some("no-such-source".into()),
        source: Some("no-such-source".into()),
        ..EvidenceOffer::default()
    };
    let strip = |mut value: Value| {
        for key in ["claim", "evidenceLink", "citation", "source"] {
            value[key]["id"] = Value::Null;
        }
        value
    };
    assert_eq!(
        strip(review.clone()),
        strip(evidence_review(&mistyped, Some(post), &site))
    );
    // A published claim is shown with its words and its published evidence,
    // so the editor can compare the reader's offer with it.
    let public = EvidenceOffer {
        claim: Some("cave".into()),
        evidence_link: Some("c1".into()),
        source: Some("slings".into()),
        stance: Some(Relation::Contradicts),
        ..EvidenceOffer::default()
    };
    let review = evidence_review(&public, Some(post), &site);
    assert_eq!(review["stale"], false);
    assert_eq!(review["claim"]["published"], true);
    assert_eq!(review["claim"]["statement"], "PUBLIC The cave educates.");
    assert_eq!(review["claim"]["quote"], "The cave educates.");
    let relations: Vec<&str> = review["claim"]["links"]
        .as_array()
        .unwrap()
        .iter()
        .map(|link| link["relation"].as_str().unwrap())
        .collect();
    assert_eq!(relations, ["supports", "contradicts"]);
    assert_eq!(review["evidenceLink"]["published"], true);
    assert!(review["evidenceLink"]["label"]
        .as_str()
        .unwrap()
        .starts_with("Contradicted by"));
    assert_eq!(review["source"]["published"], true);
    assert_eq!(
        review["stanceLabel"],
        "The reader says it contradicts the passage"
    );
    // With no post at the item's address, nothing is published on it.
    let review = evidence_review(&public, None, &site);
    assert_eq!(review["claim"]["published"], false);
    assert_eq!(
        review["source"]["published"], true,
        "the site still publishes it"
    );
}

const ID: &str = "a1111111-1111-4111-8111-11111111111a";
const OTHER: &str = "b2222222-2222-4222-8222-22222222222b";

/// A hosted suggested correction of the post's "Light" section, with the
/// reader's evidence block and `decisions` as the hosted service stores them.
fn hosted(site: &Site, id: &str, evidence: Value, decisions: Value) -> Value {
    let post = cave(site);
    let document = PassageDocument::of_post(post, &site.config);
    let mut submission = json!({
        "version": 2, "kind": "correction-suggestion", "work": post.url, "revision": document.revision,
        "target": document.section_target(1).unwrap().to_value(), "body": "The sun appears earlier.",
        "evidence": evidence,
    });
    if evidence.is_null() {
        submission["version"] = json!(1);
        submission.as_object_mut().unwrap().remove("evidence");
    }
    let record = EvidenceSubmission::from_value(&submission)
        .unwrap()
        .receive(
            DateTime::parse("2026-10-26T10:00:00Z").unwrap(),
            FeedbackChannel::Hosted,
        )
        .unwrap();
    let mut value = json!({
        "source": "feedback", "id": id, "status": "pending", "version": 2,
        "moderatedAt": null, "reason": null, "feedback": record.to_value(),
        "itemRevision": 1, "approvedRevision": null, "clarificationAsked": null, "clarificationConsent": false,
    });
    if !decisions.is_null() {
        value["decisions"] = decisions;
    }
    value
}

fn empty_log(id: &str) -> Value {
    json!({"version": 1, "item": id, "decisions": []})
}

#[test]
fn hosted_items_carry_their_evidence_and_log_and_version_2_needs_its_block() {
    let site = site(true);
    let value = hosted(
        &site,
        ID,
        json!({"claim": "cave", "evidenceLink": "c1"}),
        empty_log(ID),
    );
    let item = InboxItem::from_value(&value).unwrap();
    let hosted = item.feedback().unwrap();
    assert_eq!(
        hosted.evidence.as_ref().unwrap().claim.as_deref(),
        Some("cave")
    );
    assert!(hosted.decisions.as_ref().unwrap().is_empty());
    // A version 2 record without its block is what the hosted function sends
    // with evidence switched off: the version 1 record it also is, still
    // moderated and erased. One with a vote in its block is refused on its own.
    let mut broken = value.clone();
    broken["feedback"]
        .as_object_mut()
        .unwrap()
        .remove("evidence");
    let tolerated = InboxItem::from_value(&broken).unwrap();
    assert!(tolerated.feedback().unwrap().evidence.is_none());
    let mut voted = value.clone();
    voted["feedback"]["evidence"]["upvotes"] = json!(3);
    assert!(InboxItem::from_value(&voted).is_err());
    let plain = InboxItem::from_value(&hosted_plain(&site)).unwrap();
    assert!(plain.feedback().unwrap().evidence.is_none());
    assert!(plain.feedback().unwrap().decisions.is_none());
}

fn hosted_plain(site: &Site) -> Value {
    hosted(site, OTHER, Value::Null, Value::Null)
}

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
        third_perspectives: false,
        protocol: Protocol::Full,
        now: DateTime::parse("2026-10-27T10:00:00Z").unwrap(),
    }
}

#[test]
fn the_inbox_tells_items_apart_and_records_a_decision_with_the_viewers_role() {
    let site = site(true);
    let works = SharedWorks::new(&[], &site);
    let identities = Identities {
        active_admin_users: &[],
        contributor_ids: &[],
    };
    let inbox = inbox(&site, &works, &identities);
    let item = InboxItem::from_value(&hosted(
        &site,
        ID,
        json!({"claim": "cave", "evidenceLink": "c1", "source": "slings", "stance": "contradicts"}),
        empty_log(ID),
    ))
    .unwrap();
    let view = inbox.view(&item).unwrap();
    // Before the author decides it questions a citation; never a correction.
    assert_eq!(view["standing"]["id"], "challenged-citation");
    assert_eq!(view["standing"]["label"], "Questioned citation");
    assert_eq!(view["standing"]["correction"], false);
    assert_eq!(view["evidence"]["claim"]["published"], true);
    assert_eq!(view["decisions"], json!([]));
    let offer = &view["recordDecision"];
    assert_eq!(offer["label"], "Record decision");
    assert_eq!(offer["expectedDecisions"], 0);
    assert_eq!(offer["post"], "posts/cave.md");
    assert!(
        offer.get("confirmCheck").is_none(),
        "the passage is current"
    );
    let outcomes: Vec<&str> = offer["outcomes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|outcome| outcome["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        outcomes,
        [
            "accepted-as-correction",
            "accepted-as-clarification",
            "accepted-as-evidence",
            "declined",
            "already-addressed"
        ]
    );
    // A decision is never offered as a moderation action.
    assert!(view["actions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|action| action["action"] != "decide"));

    let note = |note: &str| RevisionLink {
        post: "posts/cave.md".into(),
        note: note.into(),
    };
    let draft = |content: DecisionContent, expected: u32| DecisionDraft {
        expected_decisions: expected,
        content,
        confirmed_check: None,
        decided: "2026-10-27",
    };
    let correction = DecisionContent {
        extent: Some(Extent::Full),
        revision_note: Some(note(
            "2026-10-27 sun: Moved the sunrise earlier after a reader's note.",
        )),
        ..DecisionContent::new(DecisionOutcome::AcceptedAsCorrection)
    };
    let decision = inbox
        .record_decision(&item, draft(correction.clone(), 0), None)
        .unwrap();
    assert_eq!(decision.sequence, 1);
    assert_eq!(decision.decided_by.role.id(), "site-admin");
    assert_eq!(
        decision.decided_by.account.as_deref(),
        Some("@moderation-token")
    );
    assert_eq!(decision.passage_check.id(), "current");
    // Someone else decided since this view: stale, nothing recorded.
    let stale = inbox
        .record_decision(&item, draft(correction, 1), None)
        .unwrap_err();
    assert_eq!(stale.code, DecisionErrorCode::Stale);
    // The note that predates the submission makes it already addressed.
    let early = DecisionContent {
        extent: Some(Extent::Full),
        revision_note: Some(note(
            "2026-10-21 cave: Added the critic's contrary reading.",
        )),
        ..DecisionContent::new(DecisionOutcome::AcceptedAsCorrection)
    };
    assert_eq!(
        inbox
            .record_decision(&item, draft(early, 0), None)
            .unwrap_err()
            .code,
        DecisionErrorCode::RevisionNoteBeforeSubmission
    );

    // Once recorded, the item stands as the author decided, and its log shows
    // the decision in force.
    let mut log = empty_log(ID);
    log["decisions"] = json!([decision.to_value()]);
    let decided = InboxItem::from_value(&hosted(
        &site,
        ID,
        json!({"claim": "cave", "evidenceLink": "c1"}),
        log,
    ))
    .unwrap();
    let view = inbox.view(&decided).unwrap();
    assert_eq!(view["standing"]["id"], "accepted-as-correction");
    assert_eq!(view["standing"]["correction"], true);
    assert_eq!(view["decisions"][0]["label"], "Correction");
    assert_eq!(view["decisions"][0]["inForce"], true);
    assert_eq!(view["recordDecision"]["expectedDecisions"], 1);
    // An item whose hosted service keeps no decisions offers none.
    let unstored = InboxItem::from_value(&hosted_plain(&site)).unwrap();
    let view = inbox.view(&unstored).unwrap();
    assert!(view.get("recordDecision").is_none());
    assert!(view.get("decisions").is_none());
    assert_eq!(view["standing"]["id"], "possible-error");
    assert_eq!(view["standing"]["label"], "Suggested correction");
}

#[test]
fn possible_duplicates_are_cues_between_items_never_a_count() {
    let site = site(true);
    let first =
        InboxItem::from_value(&hosted(&site, ID, json!({"claim": "sun"}), empty_log(ID))).unwrap();
    let second = InboxItem::from_value(&hosted_plain(&site)).unwrap();
    let cues = similar_items(&[&first, &second]);
    assert_eq!(cues[ID][0]["id"], OTHER);
    assert_eq!(cues[ID][0]["reason"], "the same passage");
    assert_eq!(cues[OTHER][0]["id"], ID);
    for similar in cues.values().flatten() {
        let keys: Vec<&String> = similar.as_object().unwrap().keys().collect();
        assert!(keys.iter().all(
            |key| ["id", "source", "kindLabel", "receivedAt", "reason"].contains(&key.as_str())
        ));
    }
    assert!(similar_items(&[&first]).is_empty());
}
