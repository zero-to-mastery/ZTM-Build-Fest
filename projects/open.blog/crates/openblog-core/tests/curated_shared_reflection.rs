//! A published shared reflection carries the public research context its post is offered, in
//! every portable form, feed and llms-full.txt, without changing the approved assembly (ADR
//! 0202): the arrangement keeps its reading order, the approved words are exactly what the
//! authors approved, and nothing private or unselected comes with the context.

use openblog_core::approval::ApprovalSet;
use openblog_core::assembly::{assemble, with_subject, Assembly};
use openblog_core::collaboration::{
    AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference,
    Participant, SharedPublication, SourceKind,
};
use openblog_core::config::SiteConfig;
use openblog_core::contributor::Contributor;
use openblog_core::draft::DraftSet;
use openblog_core::feeds;
use openblog_core::media_moment::MomentSet;
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::portability::PortableProjection;
use openblog_core::reflection::{ReflectionStructure, PART_MARKER};
use openblog_core::synthesis::SynthesisSet;

const T: i64 = 1_800_000_000;
const DATE: &str = "2030-01-31T09:00:00Z";
const ALL: [&str; 3] = ["ann", "bo", "cy"];
const NAMES: [&str; 3] = ["Ann Ames", "Bo Bee", "Cy Cole"];

/// Values that must never appear in any public output.
const PRIVATE: &[&str] = &[
    "ann-admin",
    "bo-admin",
    "shared-0a1b2c3d4e5f",
    "invitation",
    "adminUser",
    "contributorId",
    ".openblog",
    "not shared with you",
];

fn record(names: [&str; 3]) -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: "shared-0a1b2c3d4e5f".into(),
        title: "Noticing, together".into(),
        guiding_question: "What did you notice?".into(),
        sources: vec![NewSourceReference {
            kind: SourceKind::Video,
            title: "The Art of Noticing".into(),
            url: "https://www.youtube.com/watch?v=abc123".into(),
            ..NewSourceReference::default()
        }],
        creator: NewParticipant {
            admin_user: "ann-admin".into(),
            contributor_id: "ann".into(),
            display_name: names[0].into(),
        },
    })
    .unwrap();
    record.collaboration.participants[0].id = "ann".into();
    record.authorization.bindings[0].participant_id = "ann".into();
    for (id, name) in [("bo", names[1]), ("cy", names[2])] {
        record.collaboration.participants.push(Participant {
            id: id.into(),
            display_name: name.into(),
            profile_url: None,
        });
        record.authorization.bindings.push(IdentityBinding {
            admin_user: format!("{id}-admin"),
            contributor_id: id.into(),
            participant_id: id.into(),
            roles: vec![AuthorizationRole::Contributor],
        });
    }
    record
}

fn config(names: [&str; 3]) -> SiteConfig {
    let mut config = SiteConfig::from_json(
        r#"{"title":"T","url":"https://example.test","postPath":"/{slug}/","author":{"name":"Site Owner"},"feeds":{"fullContent":true}}"#,
    )
    .unwrap();
    for (id, name) in ALL.iter().zip(names) {
        config.contributors.insert(
            (*id).into(),
            Contributor {
                name: name.into(),
                ..Contributor::default()
            },
        );
    }
    config
}

fn two(first: &str, second: &str) -> String {
    format!("{first}\n{PART_MARKER}\n{second}")
}

fn structure(layout: &str, labels: [&str; 2], prompts: [&str; 2]) -> ReflectionStructure {
    let json = |text: &str| serde_json::to_string(text).unwrap();
    ReflectionStructure::from_json(&format!(
        r#"{{"version":1,"revision":1,"layout":"{layout}","rounds":[
            {{"id":"r1","roundPrompt":{},"turns":[
                {{"draft":"ann","part":0,"label":{}}},
                {{"draft":"bo","part":0,"label":{}}},
                {{"draft":"cy","part":0}}]}},
            {{"id":"r2","roundPrompt":{},"turns":[{{"draft":"ann","part":1}},{{"draft":"bo","part":1}}]}}]}}"#,
        json(prompts[0]),
        json(labels[0]),
        json(labels[1]),
        json(prompts[1]),
    ))
    .unwrap()
}

fn publish(
    record: &SharedPublication,
    s: &ReflectionStructure,
    drafts: &[(&str, String)],
) -> Assembly {
    let mut set = DraftSet::new(&ALL).unwrap();
    for (who, text) in drafts {
        set.save(who, who, 0, text, T).unwrap();
    }
    let mut approvals = ApprovalSet::new();
    for who in ALL {
        let seen = with_subject(
            record,
            Some(s),
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &ALL,
            |subject| approvals.binding_for(subject, who).unwrap(),
        );
        with_subject(
            record,
            Some(s),
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &ALL,
            |subject| approvals.approve(who, who, subject, &seen, true, T),
        )
        .unwrap();
    }
    assemble(
        record,
        Some(s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap()
}

fn site(made: &Assembly, names: [&str; 3]) -> Site {
    Site::load(
        config(names),
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

fn default_drafts() -> Vec<(&'static str, String)> {
    vec![
        ("ann", two("ANN-ONE", "ANN-TWO")),
        (
            "bo",
            two("BO-ONE with **bold** and\n\n```\n</section>\n```", "BO-TWO"),
        ),
        ("cy", "CY-ONE".to_string()),
    ]
}

/// Every needle appears, each after the one before it.
fn in_order(label: &str, haystack: &str, needles: &[&str]) {
    let mut from = 0;
    for needle in needles {
        let at = haystack[from..]
            .find(needle)
            .unwrap_or_else(|| panic!("{label}: `{needle}` missing or out of order\n{haystack}"));
        from += at + needle.len();
    }
}

const PROMPTS: [&str; 2] = ["What stood out?", "What now?"];
const LABELS: [&str; 2] = ["Opening", "Reply"];

/// The reading order every representation must keep.
fn reading() -> Vec<&'static str> {
    vec![
        PROMPTS[0], NAMES[0], LABELS[0], "ANN-ONE", NAMES[1], LABELS[1], "BO-ONE", "bold",
        NAMES[2], "CY-ONE", PROMPTS[1], NAMES[0], "ANN-TWO", NAMES[1], "BO-TWO",
    ]
}

use std::collections::BTreeMap;

use openblog_core::curated_selection::{
    CuratedItem, Provenance, PublicCuration, SelectionKind, CURATED_FORMAT, CURATED_FORMAT_VERSION,
};
use serde_json::json;

/// Nothing private comes with the context.
fn clean(label: &str, output: &str) {
    let lower = output.to_ascii_lowercase();
    for needle in PRIVATE {
        assert!(
            !lower.contains(&needle.to_ascii_lowercase()),
            "{label} leaked `{needle}`"
        );
    }
}

const DOUBT: &str = "The dating is unsettled among scholars.";

fn item(id: &str, slug: &str) -> CuratedItem {
    CuratedItem {
        id: id.to_string(),
        kind: SelectionKind::SourceAnnotation,
        target: "noticing".into(),
        revision: "0123456789abcdef".into(),
        content: BTreeMap::from([
            ("by".to_string(), json!("The site author")),
            ("text".to_string(), json!(DOUBT)),
            ("subject".to_string(), json!("noticing")),
        ]),
        provenance: Provenance::Authored,
        missing: Vec::new(),
        requires: Vec::new(),
        posts: vec![slug.to_string()],
        positions: BTreeMap::new(),
        notices: Vec::new(),
    }
}

fn curated_site(made: &Assembly) -> (Site, String) {
    let mut site = site(made, NAMES);
    let slug = site.posts[0].slug.clone();
    site.set_curation(Some(PublicCuration {
        format: CURATED_FORMAT,
        format_version: CURATED_FORMAT_VERSION,
        items: vec![item("annotation-noticing", &slug)],
        context: Vec::new(),
    }));
    (site, slug)
}

#[test]
fn a_shared_reflection_carries_its_research_context_after_the_approved_arrangement() {
    let made = publish(
        &record(NAMES),
        &structure("sequential", LABELS, PROMPTS),
        &default_drafts(),
    );
    let plain = site(&made, NAMES);
    let (site, slug) = curated_site(&made);
    let post = &site.posts[0];
    let base = format!("https://example.test/{slug}/");
    let with = PortableProjection::for_site(&site, post).unwrap();
    let without = PortableProjection::for_site(&plain, &plain.posts[0]).unwrap();
    for (label, copy, original) in [
        (
            "html",
            with.portable_html().unwrap().html,
            without.portable_html().unwrap().html,
        ),
        (
            "markdown",
            with.portable_markdown().unwrap(),
            without.portable_markdown().unwrap(),
        ),
        (
            "text",
            with.portable_text().unwrap(),
            without.portable_text().unwrap(),
        ),
    ] {
        // The approved arrangement is exactly what it was, in the same reading order, and the
        // context follows it: nothing is inserted into the authors' approved words.
        assert!(copy.starts_with(original.lines().next().unwrap()));
        in_order(label, &copy, &reading());
        assert!(copy.contains(DOUBT), "{label}");
        assert!(
            copy.contains(&format!("{base}#ob-research-context")),
            "{label}"
        );
        assert!(
            copy.contains(&format!("{base}#ob-curated-annotation-noticing")),
            "{label}"
        );
        let at_context = copy.find("Research context").unwrap();
        let at_last_turn = copy.find("BO-TWO").unwrap();
        assert!(
            at_last_turn < at_context,
            "{label}: the context follows the arrangement"
        );
        clean(label, &copy);
    }
    // The approved assembly itself is untouched: the context is a rendering of the public value,
    // never part of what the authors approved.
    assert!(!made.source.contains(DOUBT));
    // Feeds and llms-full.txt carry it too, and the reflection's own body is unchanged.
    let json = feeds::json_feed(&site).unwrap();
    assert!(json.contains("researchContext") && json.contains(DOUBT));
    let full = feeds::llms_full(&site).unwrap();
    in_order("llms-full", &full, &reading());
    assert!(full.contains(DOUBT) && full.contains(&format!("{base}#ob-research-context")));
    assert_eq!(
        with.reflection_text().unwrap(),
        without.reflection_text().unwrap(),
        "the reflection's own text does not take the context"
    );
    clean("llms-full", &full);
    // Off, or offered nothing: byte for byte what it was.
    {
        let slug_other = "not-this-post";
        let mut other = self::site(&made, NAMES);
        other.set_curation(Some(PublicCuration {
            format: CURATED_FORMAT,
            format_version: CURATED_FORMAT_VERSION,
            items: vec![item("annotation-elsewhere", slug_other)],
            context: Vec::new(),
        }));
        assert_eq!(
            feeds::llms_full(&other).unwrap(),
            feeds::llms_full(&plain).unwrap()
        );
        assert_eq!(
            feeds::json_feed(&other).unwrap(),
            feeds::json_feed(&plain).unwrap()
        );
    }
}
