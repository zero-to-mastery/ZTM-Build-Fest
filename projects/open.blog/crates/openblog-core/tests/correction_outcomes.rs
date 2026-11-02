//! Published correction outcomes (#218, ADR 0119): the author's decision on a
//! published suggested source or correction, carried through
//! `reader-feedback.json` onto the canonical page and into portable copies.
//! Covers the file's compatibility and refusals, what each outcome says and
//! links to, unresolved suggestions, withdrawn evidence, stale targets and
//! notes, hostile text, portable HTML, Markdown and text, feeds, and a scan
//! of every output for anything private.

use std::collections::BTreeMap;

use openblog_core::claim_publication::{ClaimEvidence, ClaimEvidenceSource};
use openblog_core::claims::ClaimSet;
use openblog_core::correction_decision::DecisionOutcome;
use openblog_core::feedback_provenance::FeedbackChannel;
use openblog_core::feedback_publication::{
    PublishedDecision, PublishedFeedback, ReaderFeedbackFile, READER_FEEDBACK_ANCHOR,
};
use openblog_core::knowledge_atlas::Links;
use openblog_core::passage_target::PassageDocument;
use openblog_core::portability::PortableProjection;
use openblog_core::research_notes::Notebook;
use openblog_core::scholarly_feedback::FeedbackSubmission;
use openblog_core::source_library::SourceLibrary;
use openblog_core::{
    feeds, generate, DateTime, LoadOptions, Post, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};
use serde_json::{json, Value};

const PRIVATE: &str = "PRIVATE-OUTCOME-MARKER";
const HOSTILE: &str = "<img src=x onerror=alert(1)> & \"quotes\"";
const READER_NAME: &str = "Grace Private";
const PUBLIC_NAME: &str = "Ada Public";
const SEEN_TIME: &str = "2026-10-26T09:58:00Z";

const NOTE: &str = "2026-10-27 cave: Moved the sunrise earlier after a reader's note.";

const CAVE: &str = "---
title: The cave
date: 2026-10-20
evidenceRevisions:
  - \"2026-10-27 cave: Moved the sunrise earlier after a reader's note.\"
---
The cave educates. Later the sun appears.

## Light

The sun appears at last.
";

const ID_CORRECTION: &str = "a1111111-1111-4111-8111-11111111111a";
const ID_EVIDENCE: &str = "a2222222-2222-4222-8222-22222222222a";
const ID_DECLINED: &str = "a3333333-3333-4333-8333-33333333333a";
const ID_UNDECIDED: &str = "a4444444-4444-4444-8444-44444444444a";
const ID_QUESTION: &str = "a5555555-5555-4555-8555-55555555555a";
const ID_WITHDRAWN: &str = "a6666666-6666-4666-8666-66666666666a";
const ID_STALE_NOTE: &str = "a7777777-7777-4777-8777-77777777777a";

fn library() -> SourceLibrary {
    let text = json!({"version": 1, "sources": [
        {"id": "plato", "kind": "work", "title": format!("{PRIVATE} Politeia")},
        {"id": "slings", "kind": "work", "title": "PUBLIC Slings", "issued": "2003"},
        {"id": "critic", "kind": "work", "title": "PUBLIC Critic"}]})
    .to_string();
    SourceLibrary::parse(&text, &BTreeMap::new()).unwrap()
}

fn projection() -> ClaimEvidence {
    let library = library();
    let notebook = Notebook::parse(r#"{"version": 1, "passages": []}"#, &library).unwrap();
    let claims = json!({"version": 1,
        "claims": [
            {"id": "cave", "post": "cave", "statement": "PUBLIC The cave educates.", "visibility": "approved",
             "anchor": {"start": 0, "end": 18, "text": "The cave educates."}},
            {"id": "withheld-claim", "post": "cave", "statement": format!("{PRIVATE} private claim"), "visibility": "private"}],
        "links": [
            {"id": "s1", "claim": "cave", "relation": "supports", "visibility": "approved",
             "evidence": {"source": "slings"}, "confidence": "plausible"},
            {"id": "c1", "claim": "cave", "relation": "contradicts", "visibility": "approved",
             "evidence": {"source": "critic"}, "confidence": "strong"},
            {"id": "private-link", "claim": "cave", "relation": "contextualizes", "visibility": "private",
             "evidence": {"source": "plato"}, "rationale": format!("{PRIVATE} private rationale")}]});
    let set = ClaimSet::parse(
        &claims.to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .expect("a valid claims file");
    ClaimEvidence::project(&set, &library).expect("a projection")
}

fn config(evidence: bool) -> SiteConfig {
    let mut config = SiteConfig::from_json(&format!(
        r#"{{"title": "Outcomes", "url": "https://example.test", "postPath": "/{{slug}}/", "author": {{"name": "A"}},
            "feeds": {{"fullContent": true, "llms": true}},
            "engagement": {{"enabled": true, "feedback": true, "endpoint": "https://example.test/api", "evidence": {evidence}}}}}"#
    ))
    .unwrap();
    config.claim_evidence.publish = true;
    config
}

fn load(evidence: bool, post: &str, file: Option<String>) -> Site {
    Site::load(
        config(evidence),
        Sources {
            posts: vec![SourceFile {
                path: "posts/cave.md".into(),
                contents: post.into(),
            }],
            claim_evidence: Some(ClaimEvidenceSource::Stored(projection())),
            reader_feedback: file.map(|text| SourceFile {
                path: "content/reader-feedback.json".into(),
                contents: text,
            }),
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"))
}

fn cave(site: &Site) -> &Post {
    site.posts.iter().find(|post| post.slug == "cave").unwrap()
}

fn at(text: &str) -> DateTime {
    DateTime::parse(text).unwrap()
}

/// A received note about the post's "Light" section as the hosted service
/// stores it, from a reader whose name stays private unless `publish_name`.
fn note(site: &Site, kind: &str, body: &str, publish_name: bool) -> PublishedFeedback {
    let post = cave(site);
    let document = PassageDocument::of_post(post, &site.config);
    let mut submission = json!({
        "version": 1, "kind": kind, "work": post.url, "revision": document.revision,
        "target": document.section_target(1).unwrap().to_value(), "body": body,
        "seenAt": SEEN_TIME,
        "attribution": {"name": if publish_name { PUBLIC_NAME } else { READER_NAME }, "publishName": publish_name},
    });
    match kind {
        "correction-suggestion" => {
            submission["details"] = json!({"suggestedText": "The sun appears earlier."});
        }
        "source-suggestion" => {
            submission["details"] = json!({"sourceUrl": "https://example.org/critic"});
        }
        _ => {}
    }
    let record = FeedbackSubmission::from_value(&submission)
        .unwrap()
        .receive(at("2026-10-26T10:00:00Z"), FeedbackChannel::Hosted)
        .unwrap();
    PublishedFeedback::from_record(
        "a0000000-0000-4000-8000-000000000000",
        "posts/cave.md",
        &record,
        at("2026-10-27T09:00:00Z"),
    )
    .map(|mut item| {
        item.body = body.to_string();
        item
    })
    .unwrap()
}

fn with_id(mut item: PublishedFeedback, id: &str) -> PublishedFeedback {
    item.id = id.to_string();
    item
}

fn decision(outcome: &str) -> PublishedDecision {
    PublishedDecision {
        outcome: outcome.into(),
        extent: None,
        decline_reason: None,
        rationale: None,
        revision_note: None,
        claim_evidence: None,
        decided: "2026-10-27".into(),
        superseded: 0,
    }
}

/// Every kind of outcome on one post, as the file would hold them.
fn file(site: &Site) -> ReaderFeedbackFile {
    let item = |kind: &str,
                id: &str,
                body: &str,
                publish_name: bool,
                decision: Option<PublishedDecision>| {
        with_id(note(site, kind, body, publish_name), id)
            .with_decision(decision)
            .unwrap_or_else(|error| panic!("{id}: {error}"))
    };
    let mut correction = decision("accepted-as-correction");
    correction.extent = Some("full".into());
    correction.revision_note = Some(NOTE.into());
    correction.rationale = Some(format!(
        "The sunrise was early. {HOSTILE}\n\nThe note says when."
    ));
    let mut evidence = decision("accepted-as-evidence");
    evidence.extent = Some("partial".into());
    evidence.revision_note = Some(NOTE.into());
    evidence.claim_evidence =
        serde_json::from_value(json!({"claim": "cave", "link": "c1"})).unwrap();
    evidence.rationale = Some("Only the critic's reading was added.".into());
    let mut declined = decision("declined");
    declined.decline_reason = Some("maintains-reading".into());
    declined.rationale = Some("The survey measured neap tides.".into());
    // Evidence the post no longer publishes, and a note the post no longer holds.
    let mut withdrawn = decision("accepted-as-evidence");
    withdrawn.extent = Some("full".into());
    withdrawn.revision_note = Some(NOTE.into());
    withdrawn.claim_evidence =
        serde_json::from_value(json!({"claim": "cave", "link": "gone-link"})).unwrap();
    let mut stale_note = decision("accepted-as-clarification");
    stale_note.extent = Some("full".into());
    stale_note.revision_note = Some("2026-10-28 cave: A note the author has since removed.".into());
    let mut file = ReaderFeedbackFile::default();
    for published in [
        item(
            "correction-suggestion",
            ID_CORRECTION,
            "The sun appears earlier. Really.",
            true,
            Some(correction),
        ),
        item(
            "source-suggestion",
            ID_EVIDENCE,
            "Read the critic.",
            false,
            Some(evidence),
        ),
        item(
            "correction-suggestion",
            ID_DECLINED,
            "It was three times.",
            false,
            Some(declined),
        ),
        item(
            "source-suggestion",
            ID_UNDECIDED,
            "Also this source.",
            false,
            None,
        ),
        item("question", ID_QUESTION, "Why the cave?", false, None),
        item(
            "source-suggestion",
            ID_WITHDRAWN,
            "A withdrawn link.",
            false,
            Some(withdrawn),
        ),
        item(
            "correction-suggestion",
            ID_STALE_NOTE,
            "A stale note.",
            false,
            Some(stale_note),
        ),
    ] {
        file.publish(published).unwrap();
    }
    file
}

fn build(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

fn section(page: &str) -> &str {
    let start = page
        .find(&format!("<section id=\"{READER_FEEDBACK_ANCHOR}\""))
        .expect("reader feedback section");
    let end = start + page[start..].find("</section>\n").unwrap() + "</section>\n".len();
    &page[start..end]
}

/// The article of one note in the section.
fn article<'a>(notes: &'a str, id: &str) -> &'a str {
    let start = notes
        .find(&format!(
            "<article class=\"ob-reader-note\" id=\"ob-reader-note-{id}\""
        ))
        .unwrap_or_else(|| panic!("note {id} is on the page"));
    let end = start + notes[start..].find("</article>").unwrap();
    &notes[start..end]
}

fn setup() -> (Site, String) {
    let bare = load(true, CAVE, None);
    let text = file(&bare).to_json();
    (load(true, CAVE, Some(text.clone())), text)
}

#[test]
fn the_file_is_version_one_without_a_decision_and_version_two_with_one() {
    let bare = load(true, CAVE, None);
    let full = file(&bare);
    let text = full.to_json();
    assert!(text.ends_with("\n  \"version\": 2\n}\n"), "{text}");
    assert_eq!(ReaderFeedbackFile::from_json(&text).unwrap(), full);
    assert_eq!(
        ReaderFeedbackFile::from_json(&text).unwrap().to_json(),
        text,
        "canonical and stable"
    );
    // Without a decision the file is exactly what it was, byte for byte.
    let mut plain = ReaderFeedbackFile::default();
    for item in &full.items {
        plain
            .publish(item.clone().with_decision(None).unwrap())
            .unwrap();
    }
    let plain_text = plain.to_json();
    assert!(
        plain_text.ends_with("\n  \"version\": 1\n}\n"),
        "{plain_text}"
    );
    assert!(!plain_text.contains("decision"));
    // A decision in a version 1 file is refused, as is anything a decision could carry that the
    // file never holds: who decided, and the item another decision pointed to.
    let value: Value = serde_json::from_str(&text).unwrap();
    let mut old = value.clone();
    old["version"] = json!(1);
    let error = ReaderFeedbackFile::from_json(&old.to_string()).unwrap_err();
    assert!(error.contains("needs the file's `version` 2"), "{error}");
    for (name, key, extra) in [
        (
            "who decided",
            "decidedBy",
            json!({"role": "site-admin", "account": "mikey"}),
        ),
        (
            "the item it was addressed by",
            "addressedBy",
            json!(ID_QUESTION),
        ),
        ("the decider's account", "account", json!("mikey")),
        ("a vote", "votes", json!(3)),
    ] {
        let mut hostile = value.clone();
        hostile["items"][0]["decision"][key] = extra;
        assert!(
            ReaderFeedbackFile::from_json(&hostile.to_string()).is_err(),
            "{name}"
        );
    }
    // The rules the policy applied are the rules the file is read with.
    let broken = |change: &dyn Fn(&mut Value)| {
        let mut broken = value.clone();
        for item in broken["items"].as_array_mut().unwrap() {
            if item["id"] == ID_DECLINED {
                change(&mut item["decision"]);
            }
        }
        ReaderFeedbackFile::from_json(&broken.to_string()).unwrap_err()
    };
    assert!(broken(&|decision| {
        decision.as_object_mut().unwrap().remove("declineReason");
    })
    .starts_with("item "));
    assert!(broken(&|decision| decision["outcome"] = json!("verified")).contains("outcome"));
    assert!(broken(&|decision| decision["extent"] = json!("full")).contains("extent"));
    assert!(broken(&|decision| decision["decided"] = json!("2026-02-30")).contains("decided"));
    assert!(
        broken(&|decision| decision["revisionNote"] = json!("not a note")).contains("revisionNote")
    );
    assert!(broken(&|decision| decision["rationale"] = json!("  padded  ")).contains("decision"));
    // Only a suggested source or correction takes a decision.
    let mut question = value.clone();
    for item in question["items"].as_array_mut().unwrap() {
        if item["id"] == ID_QUESTION {
            item["decision"] = serde_json::to_value(decision("declined")).unwrap();
            item["decision"]["declineReason"] = json!("other");
            item["decision"]["rationale"] = json!("No.");
        }
    }
    assert!(ReaderFeedbackFile::from_json(&question.to_string())
        .unwrap_err()
        .contains("only for a suggested source or a suggested correction"));
    // A newer file is refused rather than guessed at.
    let mut newer = value;
    newer["version"] = json!(3);
    assert!(ReaderFeedbackFile::from_json(&newer.to_string())
        .unwrap_err()
        .contains("newer than the version 2"));
}

#[test]
fn only_what_a_decision_makes_public_is_in_the_file() {
    use openblog_core::correction_decision::{
        decide, ClaimEvidenceRef, DecisionContent, DecisionFacts, DecisionLog, DecisionRequest,
        Extent, RevisionLink,
    };
    use openblog_core::feedback_moderation::PassageCheck;
    use openblog_core::moderation::{Actor, ItemFacts, ModerationState};

    let item = ItemFacts {
        id: ID_CORRECTION,
        kind: openblog_core::participation::ParticipationKind::CorrectionSuggestion,
        state: ModerationState::Approved,
        work: Some("/cave/"),
        parent: None,
        version: 3,
        revision: 1,
        approved_revision: None,
        clarification_asked: None,
        clarification_consent: false,
        content_retained: true,
        state_since: at("2026-10-26T10:00:00Z"),
    };
    let facts = DecisionFacts {
        item,
        received: "2026-10-26",
        post: Some("posts/cave.md"),
        check: PassageCheck::Current,
        passage_revision: Some("p1:4a264dbcfbe9d0a56591ff04cbf12ca4"),
    };
    let log = DecisionLog::new(ID_CORRECTION);
    let content = DecisionContent {
        extent: Some(Extent::Full),
        revision_note: Some(RevisionLink {
            post: "posts/cave.md".into(),
            note: NOTE.into(),
        }),
        claim_evidence: Some(ClaimEvidenceRef {
            claim: "cave".into(),
            link: "c1".into(),
        }),
        rationale: Some("The note says when.".into()),
        ..DecisionContent::new(DecisionOutcome::AcceptedAsCorrection)
    };
    let request = DecisionRequest {
        actor: Actor::SiteAdmin {
            admin_user: "mikey-the-admin",
        },
        expected_decisions: 0,
        content,
        confirmed_check: None,
        decided: "2026-10-27",
    };
    let decided = decide(&facts, &log, None, &request).expect("the decision is recorded");
    let published = PublishedDecision::from_decision(&decided);
    let written = serde_json::to_string(&published).unwrap();
    for private in [
        "mikey-the-admin",
        "site-admin",
        "decidedBy",
        "account",
        "p1:4a264dbcfbe9d0a56591ff04cbf12ca4",
        "passageCheck",
    ] {
        assert!(!written.contains(private), "{private}: {written}");
    }
    assert_eq!(published.outcome, "accepted-as-correction");
    assert_eq!(published.superseded, 0);
    assert_eq!(published.revision_note.as_deref(), Some(NOTE));
    // A decision about an earlier text of the item is not in force, so it is not published.
    let mut recorded = DecisionLog::new(ID_CORRECTION);
    recorded.append(decided).unwrap();
    assert!(PublishedDecision::in_force(&recorded, 1).is_some());
    assert!(PublishedDecision::in_force(&recorded, 2).is_none());
}

#[test]
fn each_outcome_says_what_the_author_decided_and_links_what_changed() {
    let (site, _) = setup();
    assert!(
        site.reader_feedback_error.is_none(),
        "{:?}",
        site.reader_feedback_error
    );
    let post = cave(&site);
    let evidence = post
        .claim_evidence()
        .expect("the post publishes its claims");
    let revisions = evidence
        .revisions_fragment
        .clone()
        .expect("the notes have a heading");
    let claim = evidence.claims[0]
        .url
        .split_once('#')
        .unwrap()
        .1
        .to_string();
    let page = build(&site)["cave/index.html"].clone();
    let notes = section(&page);

    // A correction names the revision it is about and the change it made, linked to the post's
    // own revision notes.
    let correction = article(notes, ID_CORRECTION);
    assert!(
        correction.contains(
            "<div class=\"ob-reader-note-outcome\" data-outcome=\"accepted-as-correction\">"
        ),
        "{correction}"
    );
    assert!(correction.contains(
        "<h4>Author’s decision: Correction <time datetime=\"2026-10-27\">2026-10-27</time></h4>"
    ));
    assert!(correction
        .contains("The author accepted this as a correction in full and changed the post."));
    assert!(correction.contains("Affected revision: <code>p1:"));
    assert!(correction.contains(&format!(
        "What changed: <a href=\"#{revisions}\">2026-10-27 (Claim 1): Moved the sunrise earlier after a reader&#39;s note.</a>"
    )) || correction.contains(&format!("What changed: <a href=\"#{revisions}\">2026-10-27 (Claim 1): Moved the sunrise earlier after a reader’s note.</a>"))
        || correction.contains(&format!("<a href=\"#{revisions}\">2026-10-27 (Claim 1): Moved the sunrise earlier after a reader")), "{correction}");
    assert!(correction.contains("<p>The author’s rationale:</p>"));
    // The author's words are escaped, paragraph by paragraph.
    assert!(correction.contains("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;"));
    assert!(correction.contains("<p>The note says when.</p>"));
    assert!(!correction.contains("<img"));
    // The reader stays a reader unless they agreed to a name.
    assert!(correction.contains(&format!("From {PUBLIC_NAME} · received")));

    // Added as evidence: the published evidence link, linked to its claim, in part.
    let added = article(notes, ID_EVIDENCE);
    assert!(added.contains("data-outcome=\"accepted-as-evidence\""));
    assert!(added.contains("recorded the suggested source as evidence on a claim in part"));
    assert!(added.contains(&format!("Evidence the author recorded: <a href=\"#{claim}\">Claim 1</a>: Contradicted by PUBLIC Critic.")), "{added}");
    assert!(added.contains("From a reader ·"));

    // Declined: the author's ground in words, and no change to point to.
    let declined = article(notes, ID_DECLINED);
    assert!(declined.contains("<h4>Author’s decision: Declined by the author "));
    assert!(declined.contains("declined it. Reason: The author keeps the passage as written."));
    assert!(declined.contains("<p>The survey measured neap tides.</p>"));
    assert!(!declined.contains("What changed"));
    assert!(!declined.contains("Correction"));

    // A suggestion nobody decided is unresolved, never a settled fact; a question has no outcome.
    let undecided = article(notes, ID_UNDECIDED);
    assert!(undecided.contains("data-outcome=\"unresolved\""));
    assert!(undecided.contains("<h4>Unresolved: not yet decided by the author</h4>"));
    assert!(undecided.contains("It is a reader’s suggestion, not a settled correction."));
    assert!(!undecided.contains("<time datetime=\"2026-10-27\">2026-10-27</time></h4>"));
    assert!(!article(notes, ID_QUESTION).contains("ob-reader-note-outcome"));
    // Only the author's own acceptance ever labels anything a correction.
    for id in [ID_EVIDENCE, ID_DECLINED, ID_UNDECIDED, ID_QUESTION] {
        assert!(!article(notes, id).contains(">Correction<"), "{id}");
    }
    assert_eq!(DecisionOutcome::AcceptedAsCorrection.label(), "Correction");
}

#[test]
fn withdrawn_evidence_stale_notes_and_stale_targets_are_said_not_linked() {
    let (site, text) = setup();
    let notes_page = build(&site)["cave/index.html"].clone();
    let notes = section(&notes_page);
    // The evidence link the author recorded is not published on the post: no link, and a sentence.
    let withdrawn = article(notes, ID_WITHDRAWN);
    assert!(
        withdrawn.contains("The evidence the author recorded is not published on this page."),
        "{withdrawn}"
    );
    assert!(!withdrawn.contains("Evidence the author recorded:"));
    // A revision note the post no longer holds is still the author's recorded change, unlinked.
    let stale_note = article(notes, ID_STALE_NOTE);
    assert!(
        stale_note.contains(
            "What changed: 2026-10-28 (Claim 1): A note the author has since removed.</p>"
        ) || stale_note
            .contains("What changed: 2026-10-28: A note the author has since removed.</p>")
            || stale_note.contains(
                "What changed: 2026-10-28 (Claim 1): A note the author has since removed."
            ),
        "{stale_note}"
    );
    assert!(!stale_note.contains("What changed: <a"));

    // The passage the note was about is revised: the outcome still names the revision it was
    // about, says it moved on, and never quotes the words that are gone.
    let edited = CAVE.replace("The sun appears at last.", "Dawn arrives.");
    let moved = load(true, &edited, Some(text));
    let page = build(&moved)["cave/index.html"].clone();
    let notes = section(&page);
    let correction = article(notes, ID_CORRECTION);
    assert!(
        correction.contains(". The passage has been revised since.</p>"),
        "{correction}"
    );
    assert!(correction.contains("Affected revision: <code>p1:"));
    assert!(!notes.contains("The sun appears at last."));
}

#[test]
fn an_undecided_suggestion_is_unresolved_only_where_the_site_takes_evidence() {
    let bare = load(true, CAVE, None);
    let text = file(&bare).to_json();
    let off = load(false, CAVE, Some(text.clone()));
    let page = build(&off)["cave/index.html"].clone();
    let notes = section(&page);
    // Every decision the file holds is shown; nothing says unresolved without the opt-in.
    assert!(article(notes, ID_CORRECTION).contains("data-outcome=\"accepted-as-correction\""));
    assert!(!notes.contains("Unresolved"));
    assert!(!article(notes, ID_UNDECIDED).contains("ob-reader-note-outcome"));
    // A site that decided nothing and takes no evidence is as it was: the same file, with every
    // decision removed, builds to the very same bytes with the opt-in off.
    let mut plain = ReaderFeedbackFile::default();
    for item in &file(&bare).items {
        plain
            .publish(item.clone().with_decision(None).unwrap())
            .unwrap();
    }
    let plain_text = plain.to_json();
    let legacy = build(&load(false, CAVE, Some(plain_text.clone())));
    assert!(!legacy["cave/index.html"].contains("ob-reader-note-outcome"));
    assert!(!legacy["cave/index.html"].contains("Reader suggestions and the author"));
    for (path, contents) in &legacy {
        assert!(!contents.contains("ob-reader-outcome"), "{path}");
    }
    // The opt-in adds only the unresolved marks, for suggestions: questions are untouched.
    let on = build(&load(true, CAVE, Some(plain_text)));
    let on_notes = section(&on["cave/index.html"]).to_string();
    assert_eq!(on_notes.matches("data-outcome=\"unresolved\"").count(), 6);
    assert!(!article(&on_notes, ID_QUESTION).contains("ob-reader-note-outcome"));
}

#[test]
fn nothing_pending_rejected_or_private_renders_and_nothing_private_is_in_any_output() {
    let (site, _) = setup();
    let files = build(&site);
    let llms = feeds::llms_full(&site).unwrap();
    let mut private = vec![
        SEEN_TIME,
        "T10:00:00",
        "mikey-the-admin",
        "@moderation-token",
        "decidedBy",
        "passageCheck",
        "expectedDecisions",
        "itemRevision",
        "addressedBy",
        "site-admin",
        PRIVATE,
    ];
    // The name of a reader who did not agree to one is nowhere at all.
    private.push(READER_NAME);
    for (path, contents) in files.iter().chain([(&"llms-full.txt".to_string(), &llms)]) {
        for marker in &private {
            assert!(!contents.contains(marker), "{path} leaks {marker}");
        }
        // The reader's words stay on the canonical page.
        if path != "cave/index.html" {
            for body in [
                "Really.",
                "Read the critic.",
                "It was three times.",
                "Also this source.",
                "Why the cave?",
                "A withdrawn link.",
                "A stale note.",
            ] {
                assert!(
                    !contents.contains(body),
                    "{path} carries the reader's words: {body}"
                );
            }
        }
        if path.ends_with(".html") || path.ends_with(".xml") {
            assert!(!contents.contains("<img src=x"), "{path}");
        }
    }
    // Items the file never published (pending, rejected, removed, withdrawn or private ones) have
    // nothing the build could render: a decision log lives only in the hosted service.
    let other = "a9999999-9999-4999-8999-99999999999a";
    for (path, contents) in &files {
        assert!(!contents.contains(other), "{path}");
    }
    // Search never carries a note or an outcome.
    for (path, contents) in &files {
        if path.contains("search") {
            assert!(!contents.contains("Author’s decision"), "{path}");
            assert!(!contents.contains("Unresolved"), "{path}");
        }
    }
}

#[test]
fn portable_copies_keep_each_outcome_its_evidence_link_and_the_canonical_discussion() {
    let (site, _) = setup();
    let post = cave(&site);
    let projection = PortableProjection::from_post(post, &site.config).unwrap();
    let html = projection.portable_html().unwrap().html;
    let markdown = projection.portable_markdown().unwrap();
    let text = projection.portable_text().unwrap();
    let claim = post.claim_evidence().unwrap().claims[0]
        .url
        .split_once('#')
        .unwrap()
        .1
        .to_string();
    let revisions = post
        .claim_evidence()
        .unwrap()
        .revisions_fragment
        .clone()
        .unwrap();
    for (name, output) in [("html", &html), ("markdown", &markdown), ("text", &text)] {
        assert!(
            output.contains("Reader suggestions and the author"),
            "{name}"
        );
        for id in [
            ID_CORRECTION,
            ID_EVIDENCE,
            ID_DECLINED,
            ID_UNDECIDED,
            ID_WITHDRAWN,
            ID_STALE_NOTE,
        ] {
            assert!(
                output.contains(&format!("https://example.test/cave/#ob-reader-note-{id}")),
                "{name} keeps the canonical discussion of {id}"
            );
        }
        assert!(
            !output.contains(ID_QUESTION),
            "{name}: a question has no outcome"
        );
        assert!(output.contains("Author’s decision: Correction"), "{name}");
        assert!(
            output.contains("Author’s decision: Declined by the author"),
            "{name}"
        );
        assert!(
            output.contains("Unresolved: not yet decided by the author"),
            "{name}"
        );
        assert!(
            output.contains(&format!("https://example.test/cave/#{claim}")),
            "{name} keeps the evidence link"
        );
        assert!(
            output.contains(&format!("https://example.test/cave/#{revisions}")),
            "{name} links the revision note"
        );
        assert!(output.contains("Contradicted by PUBLIC Critic"), "{name}");
        // Attributed: a reader, or the name they agreed to; the reader's own words stay put.
        assert!(output.contains("From a reader"), "{name}");
        assert!(
            output.contains(PUBLIC_NAME),
            "{name}: this reader agreed to their name"
        );
        for body in [
            "Really.",
            "Read the critic.",
            "It was three times.",
            "Why the cave?",
        ] {
            assert!(!output.contains(body), "{name}: {body}");
        }
        assert!(!output.contains(READER_NAME), "{name}");
        assert!(
            !output.contains(SEEN_TIME) && !output.contains(PRIVATE),
            "{name}"
        );
    }
    // Markdown and text carry the author's words as text, never as markup.
    assert!(
        markdown.contains("\\<img src=x onerror=alert(1)\\> \\& \"quotes\""),
        "{markdown}"
    );
    assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;"));
    // The projection is deterministic.
    assert_eq!(
        PortableProjection::from_post(cave(&site), &site.config)
            .unwrap()
            .portable_markdown()
            .unwrap(),
        markdown
    );
    // A post whose notes carry no outcome is exactly what it was.
    let plain = load(false, CAVE, None);
    let plain_markdown = PortableProjection::from_post(cave(&plain), &plain.config)
        .unwrap()
        .portable_markdown()
        .unwrap();
    assert!(!plain_markdown.contains("Reader suggestions and the author"));
}

#[test]
fn feeds_carry_outcomes_but_never_a_note_and_llms_carry_neither() {
    let (site, _) = setup();
    let files = build(&site);
    for feed in ["feed.json", "rss.xml"] {
        let feed_text = &files[feed];
        assert!(
            feed_text.contains("Reader suggestions and the author"),
            "{feed}"
        );
        assert!(
            feed_text.contains("Author’s decision: Correction")
                || feed_text.contains("Author\\u2019s decision: Correction"),
            "{feed}"
        );
        assert!(!feed_text.contains("It was three times."), "{feed}");
        assert!(!feed_text.contains(READER_NAME), "{feed}");
        if feed == "rss.xml" {
            assert!(!feed_text.contains("<img src=x"), "{feed}");
        }
    }
    let llms = feeds::llms_full(&site).unwrap();
    // llms-full.txt is the post's own text: it carries neither the notes nor their outcomes.
    assert!(!llms.contains("Author’s decision") && !llms.contains("Unresolved"));
    assert!(!llms.contains("It was three times."));
}

#[test]
fn a_page_address_is_escaped_in_the_links_an_outcome_carries() {
    let (site, text) = setup();
    let post = cave(&site);
    let file = ReaderFeedbackFile::from_json(&text).unwrap();
    let document = PassageDocument::of_post(post, &site.config);
    let items: Vec<&PublishedFeedback> = file.items.iter().collect();
    let hostile = "https://example.test/a\"onmouseover=\"x&y";
    let mut linked = 0;
    for public in openblog_core::feedback_publication::project(&items, post, &document, true) {
        let Some(outcome) = &public.outcome else {
            continue;
        };
        let html = openblog_core::feedback_publication::outcome_html(&public, outcome, hostile);
        assert!(!html.contains("\"onmouseover=\""), "{html}");
        linked += html
            .matches("href=\"https://example.test/a&quot;onmouseover=&quot;x&amp;y#")
            .count();
    }
    assert!(
        linked >= 2,
        "the change and the evidence links were checked"
    );
}

#[test]
fn an_evidence_outcome_whose_link_is_withheld_is_still_published_without_naming_it() {
    let bare = load(true, CAVE, None);
    let mut withheld = decision("accepted-as-evidence");
    withheld.extent = Some("full".into());
    withheld.revision_note = Some(NOTE.into());
    let mut file = ReaderFeedbackFile::default();
    file.publish(
        with_id(
            note(&bare, "source-suggestion", "A source.", false),
            ID_EVIDENCE,
        )
        .with_decision(Some(withheld))
        .expect("a decision whose link is withheld is a valid published decision"),
    )
    .unwrap();
    let text = file.to_json();
    assert!(!text.contains("claimEvidence"), "{text}");
    let page = build(&load(true, CAVE, Some(text)))["cave/index.html"].clone();
    let article = article(section(&page), ID_EVIDENCE).to_string();
    assert!(
        article.contains("data-outcome=\"accepted-as-evidence\""),
        "{article}"
    );
    assert!(article.contains("The evidence the author recorded is not published on this page."));
    assert!(!article.contains("Evidence the author recorded:"));
}
