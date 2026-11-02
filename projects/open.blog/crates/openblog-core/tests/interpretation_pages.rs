//! Interpretation comparison pages (ADR 0232, #90): who advances each
//! interpretation, every explanation level reachable without JavaScript,
//! evidence that no level can change, escaping of hostile text, and nothing
//! private reaching a page.

use std::collections::BTreeMap;

use openblog_core::interpretation_publication::{PublicInterpretations, PublicLink};
use openblog_core::scholarly_comparison::{Approval, Comparison, Origin, References};
use openblog_core::{generate, LoadOptions, Site, SiteConfig, Sources, ThemeSet};
use serde_json::{json, Value};

const HOSTILE: &str = "<img src=x onerror=alert(1)>";
const DRAFT_TEXT: &str = "UNAPPROVED-AI-DRAFT-MARKER";
const ON: &str = r#", "interpretations": {"publish": true}"#;

fn config(extra: &str) -> SiteConfig {
    SiteConfig::from_json(&format!(
        r#"{{"title": "Interpretations", "url": "https://example.com", "author": {{"name": "Site Author"}}{extra}}}"#
    ))
    .unwrap()
}

fn site(extra: &str) -> Site {
    Site::load(config(extra), Sources::default(), LoadOptions::default()).expect("site")
}

fn comparison(slug: &str, value: Value) -> Comparison {
    Comparison::parse(&format!("comparisons/{slug}.json"), &value.to_string())
        .unwrap_or_else(|p| panic!("{p:?}"))
}

fn base() -> Value {
    json!({
        "format": "openblog-interpretation-comparison", "version": 1,
        "title": format!("The cave {HOSTILE}"),
        "subject": "Readings of the cave image.",
        "status": "published",
        "interpretations": [
            {"id": "political",
             "attribution": {"kind": "named", "name": format!("A political reading {HOSTILE}"), "certainty": "attributed"},
             "statement": "The cave is a picture of a city.",
             "evidence": [{"link": "link-1"}],
             "uncertainty": "The text never says so."},
            {"id": "epistemic",
             "attribution": {"kind": "source", "source": "commentary"},
             "statement": "A reading in Arabic.", "language": "ar",
             "evidence": [{"source": "commentary", "locator": "f. 12r"}]},
            {"id": "anon",
             "attribution": {"kind": "anonymous", "description": "An anonymous commentator"},
             "statement": "A third reading."}
        ],
        "relations": [{"from": "political", "to": "epistemic", "kind": "differs-from", "note": "Different scales."}],
        "explanations": [
            {"id": "x-beginner", "level": "beginner", "text": "Imagine people who only see shadows."},
            {"id": "x-student", "level": "student", "about": "political", "text": "A student's view."},
            {"id": "x-scholarly", "level": "scholarly", "text": "Both readings are attested."}
        ]
    })
}

type Refs = (
    References,
    BTreeMap<String, String>,
    BTreeMap<String, PublicLink>,
);

fn public_refs() -> Refs {
    let refs = References {
        sources: ["commentary".to_string()].into(),
        evidence_links: ["link-1".to_string()].into(),
    };
    let sources = BTreeMap::from([("commentary".to_string(), "A Commentary, 1150.".to_string())]);
    let links = BTreeMap::from([(
        "link-1".to_string(),
        PublicLink {
            claim: "Cities mistake custom for the world".to_string(),
            relation: "supports",
            source: "commentary".to_string(),
            locators: Vec::new(),
        },
    )]);
    (refs, sources, links)
}

fn build(extra: &str, comparisons: &[Comparison]) -> (BTreeMap<String, String>, Vec<String>) {
    let mut site = site(extra);
    let (refs, sources, links) = public_refs();
    let resolution = PublicInterpretations::resolve(comparisons, &refs, sources, links);
    site.interpretations = Some(resolution.public);
    let files = generate(&site, &ThemeSet::new())
        .expect("a build")
        .into_iter()
        .map(|f| (f.path, f.contents))
        .collect();
    (files, resolution.diagnostics)
}

#[test]
fn a_site_without_comparisons_writes_nothing_about_them() {
    let files: BTreeMap<_, _> = generate(&site(""), &ThemeSet::new())
        .unwrap()
        .into_iter()
        .map(|f| (f.path, f.contents))
        .collect();
    assert!(files.keys().all(|p| !p.starts_with("interpretations/")));
    assert!(files.values().all(|t| !t.contains("ob-explanation-levels")));
}

#[test]
fn the_page_names_who_advances_each_interpretation_in_reading_order() {
    let (files, _) = build(ON, &[comparison("cave", base())]);
    let page = &files["interpretations/cave/index.html"];
    assert!(page.contains("Advanced by <bdi>A political reading"));
    assert!(page.contains("Advanced in <bdi>A Commentary, 1150.</bdi>"));
    assert!(page.contains("Advanced by an unknown author: <bdi>An anonymous commentator"));
    assert!(page.contains("traditionally attributed to them"));
    let interpretations = page.find("id=\"interpretations\"").unwrap();
    let relations = page.find("id=\"relations\"").unwrap();
    let explanations = page.find("id=\"explanations\"").unwrap();
    assert!(interpretations < relations && relations < explanations);
    // The relation says nothing about which is right.
    assert!(page.contains("<strong>differs from</strong>"));
    // Text in another script keeps its language and direction.
    assert!(page.contains("lang=\"ar\" dir=\"auto\""));
    // The index lists the comparison, and the sitemap does.
    assert!(files["interpretations/index.html"].contains("href=\"/interpretations/cave/\""));
    assert!(files["sitemap.xml"].contains("/interpretations/cave/"));
}

#[test]
fn every_level_is_a_static_section_with_a_link_and_the_selector_is_only_an_enhancement() {
    let (files, _) = build(ON, &[comparison("cave", base())]);
    let page = &files["interpretations/cave/index.html"];
    for level in ["beginner", "student", "scholarly"] {
        assert!(
            page.contains(&format!("href=\"#level-{level}\"")),
            "{level}"
        );
        assert!(
            page.contains(&format!("<section id=\"level-{level}\"")),
            "{level}"
        );
    }
    assert!(!page.contains("class=\"ob-level\" hidden"));
    assert!(page.contains("<ob-explanation-levels>"));
    assert!(page.contains("/assets/components/ob-explanation-levels.js"));
    // An explanation about one interpretation links back to it.
    assert!(page.contains("<a href=\"#i-political\"><bdi>About interpretation 1"));
    assert!(page.contains("do not replace them") || page.contains("never replaces them"));
}

#[test]
fn the_evidence_is_outside_every_level_so_switching_levels_cannot_change_it() {
    let (files, _) = build(ON, &[comparison("cave", base())]);
    let page = &files["interpretations/cave/index.html"];
    let start = page.find("<ob-explanation-levels>").unwrap();
    let end = page.find("</ob-explanation-levels>").unwrap();
    let levels = &page[start..end];
    let before = &page[..start];
    assert!(before.contains("Cities mistake custom for the world"));
    assert!(before.contains("f. 12r"));
    assert!(!levels.contains("Cities mistake custom"));
    assert!(!levels.contains("f. 12r"));
}

#[test]
fn hostile_text_is_escaped_and_never_becomes_markup() {
    let (files, _) = build(ON, &[comparison("cave", base())]);
    for (path, text) in &files {
        // A plain-text portable copy is not markup, so it keeps the text as
        // written (ADR 0236); every markup file must escape it.
        if path.starts_with("interpretations/") && !path.ends_with(".txt") {
            assert!(!text.contains(HOSTILE), "{path}");
        }
    }
    assert!(files["interpretations/cave/index.html"].contains("&lt;img src=x onerror=alert(1)&gt;"));
}

#[test]
fn an_ai_draft_is_labelled_and_an_unapproved_one_is_absent() {
    let mut c = comparison("cave", base());
    let ai = || Origin::AiDraft {
        tool: "an AI assistant".into(),
        drafted_at: None,
        extra: Default::default(),
    };
    c.explanations[0].origin = ai();
    c.explanations[0].approval = Some(Approval {
        by: "The author".into(),
        at: "2026-10-21T09:00:00Z".into(),
        digest: c.explanations[0].digest(),
        extra: Default::default(),
    });
    c.explanations[2].origin = ai();
    c.explanations[2].text = DRAFT_TEXT.into();
    let (files, diagnostics) = build(ON, &[c]);
    let page = &files["interpretations/cave/index.html"];
    assert!(page
        .contains("Drafted with AI (an AI assistant); the exact text was approved by the author."));
    assert!(page.contains("Imagine people who only see shadows."));
    assert!(!page.contains(DRAFT_TEXT));
    assert!(!page.contains("id=\"level-scholarly\""));
    assert!(diagnostics.iter().any(|d| d.contains("x-scholarly")));
    assert!(diagnostics.iter().all(|d| !d.contains(DRAFT_TEXT)));
}

#[test]
fn a_private_source_never_reaches_a_page() {
    let mut value = base();
    value["interpretations"][2]["attribution"] =
        json!({"kind": "source", "source": "private-source"});
    value["interpretations"][0]["evidence"] = json!([{"link": "link-1"}, {"link": "private-link"}]);
    value["interpretations"][1]["evidence"] =
        json!([{"source": "commentary"}, {"source": "private-source"}]);
    let (files, diagnostics) = build(ON, &[comparison("cave", value)]);
    let page = &files["interpretations/cave/index.html"];
    assert!(!page.contains("id=\"i-anon\""));
    assert!(page.contains("Cities mistake custom for the world"));
    assert!(diagnostics.iter().any(|d| d.contains("anon")));
    for (path, text) in &files {
        assert!(!text.contains("private-source"), "{path}");
        assert!(!text.contains("private-link"), "{path}");
    }
}

#[test]
fn a_draft_comparison_has_no_page() {
    let mut value = base();
    value["status"] = json!("draft");
    let (files, diagnostics) = build(ON, &[comparison("cave", value)]);
    assert!(files.keys().all(|p| !p.starts_with("interpretations/")));
    assert!(diagnostics.is_empty());
}

#[test]
fn a_page_at_the_reserved_address_is_refused_only_while_published() {
    let page = openblog_core::SourceFile {
        path: "pages/interpretations.md".into(),
        contents: "---\ntitle: Mine\n---\nBody.".into(),
    };
    let load = |extra: &str| {
        Site::load(
            config(extra),
            Sources {
                pages: vec![page.clone()],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap()
    };
    assert!(generate(&load(""), &ThemeSet::new()).is_ok());
    let error = generate(&load(ON), &ThemeSet::new()).unwrap_err();
    assert!(error.contains("interpretations"), "{error}");
}
