//! Portable copies of an interpretation comparison (ADR 0236, #220): every
//! approved explanation level as a labelled supplemental section in HTML,
//! Markdown and text, the canonical link, AI provenance and approval, hostile
//! and bidirectional text, and nothing private.

use std::collections::BTreeMap;

use openblog_core::comparison_portable::{check_portable, portable_comparison, PortableComparison};
use openblog_core::interpretation_publication::{
    PublicInterpretations, PublicLink, PublishedComparison,
};
use openblog_core::portability::DiagnosticSeverity;
use openblog_core::scholarly_comparison::{Approval, Comparison, Origin, References};
use serde_json::{json, Value};

const BASE: &str = "https://example.test/blog";
const CANON: &str = "https://example.test/blog/interpretations/cave/";
const HOSTILE: &str = "<img src=x onerror=alert(1)>";
const DRAFT: &str = "UNAPPROVED-DRAFT-MARKER";
const APPROVER: &str = "approver-login-77";
const REASON: &str = "WITHDRAWN-REASON-MARKER";
const LABEL: &str = "Drafted with AI (an AI assistant); the exact text was approved by the author.";

fn comparison(value: Value) -> Comparison {
    Comparison::parse("comparisons/cave.json", &value.to_string())
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
             "statement": "قراءة بالعربية.", "language": "ar",
             "evidence": [{"source": "commentary", "locator": "f. 12r"}]}
        ],
        "relations": [{"from": "political", "to": "epistemic", "kind": "differs-from", "note": "Different scales."}],
        "explanations": [
            {"id": "x-beginner", "level": "beginner", "text": "Imagine people who only see shadows.",
             "authors": ["Ada", "Bo"], "prerequisite": "what a metaphor is", "modes": ["guided"], "revision": 2},
            {"id": "x-student", "level": "student", "about": "political", "text": "A student view.\n\nSecond paragraph."},
            {"id": "x-scholarly", "level": "scholarly", "text": "Both readings are attested."}
        ]
    })
}

fn publish(c: &Comparison) -> (PublicInterpretations, PublishedComparison, Vec<String>) {
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
    let resolution = PublicInterpretations::resolve(std::slice::from_ref(c), &refs, sources, links);
    let published = resolution.public.comparisons[0].clone();
    (resolution.public, published, resolution.diagnostics)
}

fn copy(c: &Comparison) -> PortableComparison {
    let (public, published, _) = publish(c);
    portable_comparison(&public, &published, BASE)
}

fn ai(c: &mut Comparison, index: usize, approved: bool) {
    c.explanations[index].origin = Origin::AiDraft {
        tool: "an AI assistant".into(),
        drafted_at: None,
        extra: Default::default(),
    };
    if approved {
        c.explanations[index].approval = Some(Approval {
            by: APPROVER.into(),
            at: "2026-10-21T09:00:00Z".into(),
            digest: c.explanations[index].digest(),
            extra: Default::default(),
        });
    }
}

#[test]
fn every_approved_level_is_a_labelled_supplement_in_every_format() {
    let out = copy(&comparison(base()));
    assert!(out.is_sound(), "{:?}", out.diagnostics);
    for (name, body) in [
        ("html", &out.html),
        ("md", &out.markdown),
        ("txt", &out.text),
    ] {
        for needle in [
            "Imagine people who only see shadows.",
            "A student view.",
            "Second paragraph.",
            "Both readings are attested.",
            "Helpful to know first: what a metaphor is. You can read the article without it.",
            "Written by Ada, Bo.",
            "Revision 2.",
            CANON,
        ] {
            assert!(body.contains(needle), "{name}: {needle}");
        }
        // Levels follow the interpretations and come in reading order.
        let lower = body.to_lowercase();
        let pos = |s: &str| lower.find(s).unwrap_or_else(|| panic!("{name}: {s}"));
        assert!(pos("picture of a city") < pos("imagine people"));
        assert!(pos("imagine people") < pos("a student view"));
        assert!(pos("a student view") < pos("both readings are attested"));
    }
    // The mode an author named does not hide the explanation in a copy.
    assert!(out.html.contains("id=\"level-beginner\""));
    // The canonical page is reachable for each level.
    assert!(out
        .html
        .contains(&format!("href=\"{CANON}#level-student\"")));
    assert!(out
        .markdown
        .contains(&format!("(<{CANON}#level-scholarly>)")));
    assert!(out
        .text
        .contains(&format!("canonical page: {CANON}#level-beginner")));
    // Headings and sections are labelled.
    assert!(out
        .html
        .contains("aria-labelledby=\"level-student-heading\""));
    assert!(out.markdown.contains("\n### Student\n"));
    assert!(out.text.contains("\nSTUDENT\n"));
    // The evidence the interpretations cite survives.
    assert!(out.text.contains("A Commentary, 1150., f. 12r"));
    assert!(out.text.contains("Cities mistake custom for the world"));
}

#[test]
fn the_selector_becomes_static_sections_and_the_copy_says_so() {
    let out = copy(&comparison(base()));
    let lower = out.html.to_lowercase();
    for banned in [
        "<script", "<ob-", "<style", " style=", "<iframe", "<img", "<button", "<form",
    ] {
        assert!(!lower.contains(banned), "{banned}");
    }
    let info = out
        .diagnostics
        .iter()
        .find(|d| d.code == "explanation-levels-static")
        .expect("the loss of the selector is reported");
    assert_eq!(info.severity, DiagnosticSeverity::Info);
    assert!(info.recommended_action.contains("canonical page"));
}

#[test]
fn ai_provenance_and_the_authors_approval_survive_and_the_approver_does_not() {
    let mut c = comparison(base());
    ai(&mut c, 0, true);
    ai(&mut c, 2, false);
    c.explanations[2].text = DRAFT.into();
    let (public, published, diagnostics) = publish(&c);
    let out = portable_comparison(&public, &published, BASE);
    for body in [&out.html, &out.markdown, &out.text] {
        // Markdown escapes the parentheses; the words are what must survive.
        assert!(body.contains("Drafted with AI"), "{body}");
        assert!(body.contains("the exact text was approved by the author"));
        assert!(!body.contains(DRAFT));
        assert!(!body.contains(APPROVER));
        assert!(
            !body.to_lowercase().contains("scholarly"),
            "an unapproved level is not exported"
        );
    }
    assert!(out.html.contains(LABEL));
    assert!(out.text.contains(LABEL));
    assert!(out.is_sound(), "{:?}", out.diagnostics);
    assert!(diagnostics.iter().any(|d| d.contains("x-scholarly")));
    let json = serde_json::to_string(&out.diagnostics).unwrap();
    assert!(!json.contains(DRAFT) && !json.contains(APPROVER));
}

#[test]
fn a_withdrawn_explanation_and_its_reason_never_leave() {
    let mut value = base();
    value["explanations"][1]["withdrawn"] = json!({"at": "2026-10-22T00:00:00Z", "reason": REASON});
    let out = copy(&comparison(value));
    for body in [&out.html, &out.markdown, &out.text] {
        assert!(!body.contains(REASON));
        assert!(!body.contains("A student view."));
    }
    assert!(out.is_sound());
}

#[test]
fn hostile_and_bidirectional_text_cannot_become_markup_or_reorder_a_line() {
    let out = copy(&comparison(base()));
    assert!(!out.html.contains(HOSTILE));
    assert!(out.html.contains("&lt;img src=x onerror=alert(1)&gt;"));
    // Markdown: no raw tag.
    assert!(!out.markdown.contains(" <img"));
    assert!(out.markdown.contains(r"\<img src=x onerror=alert(1)\>"));
    for body in [&out.html, &out.markdown, &out.text] {
        assert!(!body.contains('\u{202E}'));
    }
    // Right-to-left text keeps its language and direction in HTML.
    assert!(out.html.contains("lang=\"ar\" dir=\"auto\""));
    assert!(out.html.contains("قراءة بالعربية."));
    assert!(out.markdown.contains("Language: ar."));
    assert!(out.html.contains("<h1 dir=\"auto\">The cave &lt;img"));
}

#[test]
fn markdown_block_syntax_in_author_text_is_neutralised() {
    let mut value = base();
    value["explanations"][2]["text"] =
        json!("# heading\n\n1. item\n\n- bullet\n\n[link](javascript:alert(1)) **bold** `code`");
    let out = copy(&comparison(value));
    assert!(out.markdown.contains("\n\\# heading\n"));
    assert!(out.markdown.contains("\n1\\. item\n"));
    assert!(out.markdown.contains("\n\\- bullet\n"));
    assert!(out.markdown.contains(r"\[link\](javascript:alert(1))"));
    assert!(out.markdown.contains("\\*\\*bold\\*\\*"));
    // A person reading the text copy sees what the author wrote.
    assert!(out
        .text
        .contains("[link](javascript:alert(1)) **bold** `code`"));
    assert!(out.is_sound(), "{:?}", out.diagnostics);
}

#[test]
fn no_private_or_ranking_field_is_exported() {
    let mut value = base();
    value["explanations"][0]["rank"] = json!(1);
    // A ranking is refused by the contract before it can be exported.
    assert!(Comparison::parse("comparisons/cave.json", &value.to_string()).is_err());
    let out = copy(&comparison(base()));
    let all = format!("{}{}{}", out.html, out.markdown, out.text).to_lowercase();
    for word in ["rank", "popular", "most agreed", "draft"] {
        assert!(!all.contains(word), "{word}");
    }
}

#[test]
fn a_faulty_copy_is_an_error_and_names_ids_not_text() {
    let mut c = comparison(base());
    ai(&mut c, 1, true);
    let (public, published, _) = publish(&c);
    let good = portable_comparison(&public, &published, BASE);
    assert!(good.is_sound(), "{:?}", good.diagnostics);

    let mut lost = good.clone();
    lost.text = lost.text.replace("Drafted with AI", "Written");
    lost.html = lost.html.replace("A student view.", "");
    lost.markdown = lost
        .markdown
        .replace("https://example.test", "https://elsewhere.test");
    lost.html.push_str("<script>alert(1)</script>");
    let found = check_portable(&public, &published, BASE, &lost);
    let codes: Vec<_> = found
        .iter()
        .map(|d| (d.code.as_str(), d.context.representation.clone().unwrap()))
        .collect();
    assert!(
        codes.contains(&("explanation-provenance-lost", "text".into())),
        "{codes:?}"
    );
    assert!(
        codes.contains(&("explanation-missing", "html".into())),
        "{codes:?}"
    );
    assert!(
        codes.contains(&("canonical-link-missing", "markdown".into())),
        "{codes:?}"
    );
    assert!(codes.iter().any(|(c, _)| *c == "scripted-markup"));
    assert!(found
        .iter()
        .filter(|d| d.severity == DiagnosticSeverity::Error)
        .all(|d| !d.message.contains("student view")));
}

#[test]
fn a_comparison_without_explanations_exports_no_level_section() {
    let mut value = base();
    value["explanations"] = json!([]);
    let out = copy(&comparison(value));
    assert!(!out.html.contains("level-"));
    assert!(!out.text.contains("EXPLANATIONS"));
    assert!(out.diagnostics.is_empty());
}

#[test]
fn translations_are_plain_sentences_with_their_language() {
    let mut value = base();
    value["explanations"] = json!([
        {"id": "x-en", "level": "beginner", "text": "English."},
        {"id": "x-fr", "level": "beginner", "text": "Français.", "language": "fr", "translationOf": "x-en"}
    ]);
    let out = copy(&comparison(value));
    assert!(out
        .text
        .contains("A translation of another explanation in this comparison."));
    assert!(out.html.contains("id=\"x-x-fr\" lang=\"fr\""));
    assert!(out.is_sound());
}

#[test]
fn a_direction_override_is_refused_by_the_contract_before_any_copy() {
    let mut value = base();
    value["interpretations"][0]["attribution"]["name"] = json!("Name \u{202E}evil");
    assert!(Comparison::parse("comparisons/cave.json", &value.to_string()).is_err());
}
