//! Interpretation-comparison contracts (ADR 0226 to 0230, #88): disagreement
//! without a ruling, supplemental audience levels, AI provenance and
//! approval, anonymous and translated sources, evidence references,
//! round trips and privacy.

use std::collections::BTreeMap;

use openblog_core::scholarly_comparison::{
    load_comparisons, Approval, Attribution, Comparison, Explanation, Interpretation, Level,
    Origin, PublicComparison, PublicProvenance, References, Status, WithheldReason, MAX_FILE_BYTES,
    MAX_INTERPRETATIONS,
};
use openblog_core::source_library::SourceLibrary;
use serde_json::{json, Value};

const GOLDEN: &str = include_str!("fixtures/scholarly-comparison.json");
const FILE: &str = "comparisons/cave.json";
const PRIVATE: &str = "PRIVATE-COMPARISON-MARKER";

fn parse(text: &str) -> Result<Comparison, Vec<String>> {
    Comparison::parse(FILE, text).map_err(|p| p.iter().map(ToString::to_string).collect())
}

fn golden() -> Value {
    serde_json::from_str(GOLDEN).unwrap()
}

fn refused(value: &Value) -> String {
    parse(&value.to_string()).unwrap_err().join("\n")
}

fn named(name: &str) -> Attribution {
    Attribution::Named {
        name: name.into(),
        certainty: None,
        extra: Default::default(),
    }
}

fn published_pair() -> Comparison {
    let mut c = Comparison::draft("pair", "A pair", "Two readings.");
    c.status = Status::Published;
    c.interpretations = vec![
        Interpretation::new("a", named("A"), "Reading A."),
        Interpretation::new("b", named("B"), "Reading B."),
    ];
    c
}

fn public_refs() -> References {
    References {
        sources: ["commentary".to_string()].into(),
        evidence_links: ["link-political".to_string()].into(),
    }
}

#[test]
fn the_golden_file_round_trips_byte_for_byte() {
    let c = parse(GOLDEN).unwrap();
    assert_eq!(c.slug, "cave");
    assert_eq!(c.to_canonical_json(), GOLDEN);
    assert_eq!(parse(&c.to_canonical_json()).unwrap(), c);
    assert!(!GOLDEN.contains('\r'));
    // A field this release does not define survives.
    assert_eq!(c.extra.get("x-note"), Some(&json!("kept as written")));
}

#[test]
fn interpretations_may_disagree_and_none_is_marked_correct() {
    let c = parse(GOLDEN).unwrap();
    assert_eq!(c.interpretations.len(), 3);
    assert_eq!(c.relations[0].kind.value(), "differs-from");
    // No judgement vocabulary exists anywhere in a file, at any level.
    for field in [
        "correct",
        "winner",
        "verdict",
        "consensus",
        "score",
        "rank",
        "preferred",
        "authority",
    ] {
        let mut top = golden();
        top[field] = json!(true);
        assert!(refused(&top).contains(&format!("`{field}`")), "{field}");
        let mut inner = golden();
        inner["interpretations"][0][field] = json!(1);
        assert!(refused(&inner).contains(&format!("`{field}`")), "{field}");
        let mut relation = golden();
        relation["relations"][0][field] = json!("x");
        assert!(
            refused(&relation).contains(&format!("`{field}`")),
            "{field}"
        );
    }
    // Disagreement has no direction: the same pair twice is a repeat.
    let mut twice = golden();
    twice["relations"] = json!([
        {"from": "political", "to": "epistemic", "kind": "differs-from"},
        {"from": "epistemic", "to": "political", "kind": "differs-from"}
    ]);
    assert!(refused(&twice).contains("repeats an earlier relation"));
    // Differing and agreeing on one pair are two statements, both allowed.
    let mut both = golden();
    both["relations"] = json!([
        {"from": "political", "to": "epistemic", "kind": "differs-from"},
        {"from": "political", "to": "epistemic", "kind": "agrees-with"}
    ]);
    parse(&both.to_string()).unwrap();
}

#[test]
fn attribution_is_required_and_anonymous_sources_are_representable() {
    let mut none = golden();
    none["interpretations"][0]
        .as_object_mut()
        .unwrap()
        .remove("attribution");
    assert!(refused(&none).contains("`attribution` is required"));
    let c = parse(GOLDEN).unwrap();
    assert!(matches!(
        c.interpretations[1].attribution,
        Attribution::Anonymous { .. }
    ));
    let mut bad = golden();
    bad["interpretations"][0]["attribution"]["kind"] = json!("somebody");
    assert!(refused(&bad).contains("`attribution.kind`"));
    let mut cert = golden();
    cert["interpretations"][0]["attribution"]["certainty"] = json!("certain");
    assert!(refused(&cert).contains("`attribution.certainty`"));
}

#[test]
fn translations_name_their_original_and_their_language() {
    let c = parse(GOLDEN).unwrap();
    let fr = &c.interpretations[2];
    assert_eq!(fr.translation_of.as_deref(), Some("epistemic"));
    assert_eq!(fr.language.as_deref(), Some("fr"));
    let mut missing = golden();
    missing["interpretations"][2]["translationOf"] = json!("nowhere");
    assert!(refused(&missing).contains("names no interpretation"));
    let mut itself = golden();
    itself["interpretations"][2]["translationOf"] = json!("epistemic-fr");
    assert!(refused(&itself).contains("itself"));
    let mut no_lang = golden();
    no_lang["interpretations"][2]
        .as_object_mut()
        .unwrap()
        .remove("language");
    assert!(refused(&no_lang).contains("says its `language`"));
    let mut cycle = golden();
    cycle["interpretations"][1]["translationOf"] = json!("epistemic-fr");
    cycle["interpretations"][1]["language"] = json!("en");
    assert!(refused(&cycle).contains("leads back"));
    let mut tag = golden();
    tag["interpretations"][2]["language"] = json!("not a tag");
    assert!(refused(&tag).contains("`language`"));
}

#[test]
fn audience_levels_supplement_and_never_replace_canonical_prose() {
    let c = parse(GOLDEN).unwrap();
    assert_eq!(c.explanations[0].level, Level::Beginner);
    for field in ["replaces", "replacement", "canonical", "body", "overrides"] {
        let mut v = golden();
        v["explanations"][1][field] = json!("the post");
        assert!(refused(&v).contains(&format!("`{field}`")), "{field}");
    }
    let mut level = golden();
    level["explanations"][0]["level"] = json!("expert");
    assert!(refused(&level).contains("`level`"));
    // One explanation per level per subject.
    let mut dup = golden();
    dup["explanations"][1]["level"] = json!("beginner");
    assert!(refused(&dup).contains("one per level"));
    // About names an interpretation of this comparison.
    let mut about = golden();
    about["explanations"][1]["about"] = json!("ghost");
    assert!(refused(&about).contains("`about`"));
    // The same level may explain different subjects.
    let mut ok = golden();
    ok["explanations"][1]["level"] = json!("beginner");
    ok["explanations"][1]["about"] = json!("political");
    parse(&ok.to_string()).unwrap();
}

#[test]
fn an_ai_draft_is_labelled_and_published_only_with_an_approval_of_this_text() {
    let mut c = published_pair();
    let mut x = Explanation::new("x", Level::Student, "Drafted by a tool.");
    x.origin = Origin::AiDraft {
        tool: "a tool".into(),
        drafted_at: None,
        extra: Default::default(),
    };
    assert!(!x.standing().publishable());
    c.explanations.push(x.clone());
    // Published without approval is refused.
    assert!(c.validate()[0].message.contains("approves it"));
    // Approval of exactly this text passes.
    c.explanations[0].approval = Some(Approval {
        by: "The author".into(),
        at: "2026-10-21T09:00:00Z".into(),
        digest: x.digest(),
        extra: Default::default(),
    });
    assert!(c.validate().is_empty());
    // Editing the text after approval makes it stale again.
    c.explanations[0].text = "Edited afterwards.".into();
    assert!(c.validate()[0]
        .message
        .contains("changed after it was approved"));
    // The same file is fine as a draft: the author is mid-work.
    c.status = Status::Draft;
    assert!(c.validate().is_empty());
    // An approval cannot be spoofed for another item's text.
    let other = Explanation::new("y", Level::Student, "Drafted by a tool.");
    assert_ne!(other.digest(), x.digest());
    // Unknown origin kinds are refused rather than read as the author.
    let mut v = golden();
    v["explanations"][0]["origin"]["kind"] = json!("oracle");
    assert!(refused(&v).contains("`origin.kind`"));
}

#[test]
fn the_public_value_carries_only_approved_text_and_labels_ai_origin() {
    let c = parse(GOLDEN).unwrap();
    let (public, withheld) = PublicComparison::project(&c, &public_refs());
    let public = public.unwrap();
    assert!(withheld.is_empty());
    assert!(public.supplemental);
    let ai = public
        .explanations
        .iter()
        .find(|x| x.id == "cave-beginner")
        .unwrap();
    assert_eq!(
        ai.provenance,
        PublicProvenance::AiDraft {
            tool: "an AI writing assistant".into(),
        }
    );
    let json = public.to_json();
    assert!(json.contains("\"origin\": \"ai-draft\""));
    assert!(!json.contains("x-note"));
    assert!(!json.contains("digest"));
    assert_eq!(public.to_json(), json, "deterministic");

    // Unapproved and stale drafts are left out, and said so to the author only.
    let mut c = parse(GOLDEN).unwrap();
    c.explanations[0].approval = None;
    c.interpretations[0].origin = Origin::AiDraft {
        tool: "t".into(),
        drafted_at: None,
        extra: Default::default(),
    };
    c.interpretations[0].statement = format!("{PRIVATE} statement");
    c.interpretations[0].approval = Some(Approval {
        by: "x".into(),
        at: "now".into(),
        digest: "stale".into(),
        extra: Default::default(),
    });
    c.explanations.push({
        let mut x = Explanation::new("about-political", Level::Student, PRIVATE);
        x.about = Some("political".into());
        x
    });
    let (public, withheld) = PublicComparison::project(&c, &public_refs());
    let json = public.unwrap().to_json();
    assert!(!json.contains(PRIVATE));
    assert!(!json.contains("Imagine people"));
    let reasons: BTreeMap<_, _> = withheld.iter().map(|w| (w.id.as_str(), w.reason)).collect();
    assert_eq!(reasons["political"], WithheldReason::StaleApproval);
    assert_eq!(reasons["cave-beginner"], WithheldReason::AwaitingApproval);
    assert_eq!(reasons["about-political"], WithheldReason::SubjectWithheld);
    // The relation that touched the withheld interpretation is gone.
    assert!(!json.contains("differs-from"));
}

#[test]
fn a_draft_or_a_lone_reading_is_not_a_comparison() {
    let mut c = published_pair();
    c.status = Status::Draft;
    let (none, why) = PublicComparison::project(&c, &References::default());
    assert!(none.is_none());
    assert_eq!(why[0].reason, WithheldReason::Draft);

    let mut one = published_pair();
    one.interpretations.truncate(1);
    assert!(one.validate()[0].message.contains("at least two"));

    let mut c = published_pair();
    c.interpretations[1].origin = Origin::AiDraft {
        tool: "t".into(),
        drafted_at: None,
        extra: Default::default(),
    };
    let (none, why) = PublicComparison::project(&c, &References::default());
    assert!(none.is_none());
    assert!(why
        .iter()
        .any(|w| w.reason == WithheldReason::TooFewInterpretations));
}

#[test]
fn evidence_is_a_reference_and_only_public_evidence_is_projected() {
    let c = parse(GOLDEN).unwrap();
    let (public, withheld) = PublicComparison::project(&c, &References::default());
    let public = public.unwrap();
    assert!(public.interpretations.iter().all(|i| i.evidence.is_empty()));
    // The translation is attributed to a source that is not public, so it is
    // withheld whole (ADR 0232); the other two keep their text and lose evidence.
    assert!(withheld
        .iter()
        .filter(|w| w.id != "epistemic-fr")
        .all(|w| w.reason == WithheldReason::EvidenceNotPublic));
    assert_eq!(withheld.len(), 3);
    assert_eq!(public.interpretations.len(), 2);

    // Authoring checks against everything the author holds.
    let library = SourceLibrary::parse(
        &json!({"version": 1, "sources": [{"id": "commentary", "kind": "work", "title": "T"}]})
            .to_string(),
        &BTreeMap::new(),
    )
    .unwrap();
    let claims = Default::default();
    let all = References::of(&library, &claims);
    let problems = c.check_references(&all);
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert_eq!(problems[0].item.as_deref(), Some("political"));
    assert!(problems[0].message.contains("not in the research library"));

    let mut bad = golden();
    bad["interpretations"][0]["evidence"] = json!([{"link": "a", "source": "b"}]);
    assert!(refused(&bad).contains("exactly one of"));
    bad["interpretations"][0]["evidence"] = json!([{"source": "../etc/passwd"}]);
    assert!(refused(&bad).contains("not a source id"));
    bad["interpretations"][0]["evidence"] = json!([{"link": "a", "locator": "p. 1"}]);
    assert!(refused(&bad).contains("belongs to a `source`"));
}

#[test]
fn hostile_and_oversized_input_is_refused_without_echoing_it() {
    assert!(parse("{").unwrap_err()[0].contains("ends too early"));
    let mut v = golden();
    v["interpretations"][0]["statement"] = json!(format!("a\u{202e}{PRIVATE}"));
    let message = refused(&v);
    assert!(message.contains("control or direction"));
    assert!(!message.contains(PRIVATE));
    let mut v = golden();
    v["title"] = json!("x".repeat(500));
    assert!(refused(&v).contains("`title` is over"));
    let big = " ".repeat(MAX_FILE_BYTES + 1);
    assert!(parse(&big).unwrap_err()[0].contains("bytes"));
    let mut many = golden();
    many["interpretations"] = json!((0..=MAX_INTERPRETATIONS)
        .map(
            |n| json!({"id": format!("i{n}"), "attribution": {"kind": "named", "name": "n"},
            "statement": "s"})
        )
        .collect::<Vec<_>>());
    assert!(refused(&many).contains("at most"));
    // Another version, another format, a repeated key, a bad file name.
    let mut other = golden();
    other["version"] = json!(2);
    assert!(refused(&other).contains("version 2"));
    let mut fmt = golden();
    fmt["format"] = json!("openblog-reading-path");
    assert!(refused(&fmt).contains("`format`"));
    let dup = GOLDEN.replacen("\"title\"", "\"title\": \"a\",\n  \"title\"", 1);
    assert!(parse(&dup).unwrap_err()[0].contains("repeats the field `title`"));
    for name in [
        "comparisons/../x.json",
        "comparisons/Con.json",
        "comparisons/con.json",
    ] {
        assert!(Comparison::parse(name, GOLDEN).is_err(), "{name}");
    }
    // Duplicate ids across interpretations and explanations.
    let mut ids = golden();
    ids["explanations"][1]["id"] = json!("political");
    assert!(refused(&ids).contains("used by an earlier item"));
}

#[test]
fn a_bad_file_fails_alone_and_a_draft_edit_is_validated_in_memory() {
    let mut files = BTreeMap::new();
    files.insert("comparisons/cave.json".to_string(), GOLDEN.to_string());
    files.insert("comparisons/broken.json".to_string(), "{}".to_string());
    files.insert("notes.json".to_string(), "ignored".to_string());
    let (ok, problems) = load_comparisons(&files);
    assert_eq!(ok.len(), 1);
    assert_eq!(ok[0].slug, "cave");
    assert!(problems.iter().all(|p| p.file == "comparisons/broken.json"));

    let mut draft = Comparison::draft("new", "New", "A subject.");
    assert!(draft.validate().is_empty());
    draft
        .interpretations
        .push(Interpretation::new("", named("A"), "x"));
    assert!(!draft.validate().is_empty());
}

#[test]
fn an_attribution_to_a_source_the_build_does_not_publish_is_withheld_not_named() {
    let c = parse(GOLDEN).unwrap();
    let refs = References {
        sources: Default::default(),
        evidence_links: ["link-political".to_string()].into(),
    };
    let (public, withheld) = PublicComparison::project(&c, &refs);
    let public = public.unwrap();
    let json = public.to_json();
    // The private source id appears nowhere in the public value.
    assert!(!json.contains("commentary"), "{json}");
    assert!(public
        .interpretations
        .iter()
        .all(|i| i.id != "epistemic-fr"));
    assert!(withheld
        .iter()
        .any(|w| w.id == "epistemic-fr" && w.reason == WithheldReason::AttributionNotPublic));
}

#[test]
fn the_approval_digest_covers_every_reader_visible_field_of_an_interpretation() {
    let base = Interpretation::new("a", named("A"), "Reading A.");
    let mut note = base.clone();
    note.uncertainty = Some("Doubtful.".into());
    let mut who = base.clone();
    who.attribution = named("B");
    let mut lang = base.clone();
    lang.language = Some("fr".into());
    let mut origin = base.clone();
    origin.origin = Origin::AiDraft {
        tool: "a tool".into(),
        drafted_at: Some("2026-10-20".into()),
        extra: Default::default(),
    };
    for changed in [&note, &who, &lang] {
        assert_ne!(changed.digest(), base.digest());
    }
    assert_eq!(origin.digest(), base.digest(), "origin never moves it");
}

#[test]
fn an_explanation_adds_no_evidence_of_its_own() {
    let mut c = published_pair();
    c.interpretations[0].evidence = vec![openblog_core::scholarly_comparison::EvidenceRef::Link {
        link: "link-political".into(),
        extra: Default::default(),
    }];
    let mut x = Explanation::new("x", Level::Student, "Plain words.");
    x.about = Some("b".into());
    x.evidence = c.interpretations[0].evidence.clone();
    c.explanations.push(x);
    assert!(c.validate()[0].message.contains("adds no evidence"));
    c.explanations[0].about = Some("a".into());
    assert!(c.validate().is_empty());
    c.explanations[0].about = None;
    assert!(c.validate().is_empty());
}
