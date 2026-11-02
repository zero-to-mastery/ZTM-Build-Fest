//! Audience-explanation refinements of the comparison contract (ADR 0234 and
//! 0235, #209, #219): authors, prerequisite, reading modes, translations,
//! withdrawal, and compatibility with the #88 (legacy) data.

use openblog_core::scholarly_comparison::{
    Attribution, Comparison, Explanation, ExplanationMode, Interpretation, Level, Origin,
    PublicComparison, PublicProvenance, References, Status, WithheldReason,
};
use serde_json::{json, Value};

const LEGACY: &str = include_str!("fixtures/scholarly-comparison.json");
const FILE: &str = "comparisons/cave.json";

fn parse(value: &Value) -> Result<Comparison, String> {
    Comparison::parse(FILE, &value.to_string()).map_err(|p| {
        p.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    })
}

fn named(name: &str) -> Attribution {
    Attribution::Named {
        name: name.into(),
        certainty: None,
        extra: Default::default(),
    }
}

fn pair() -> Comparison {
    let mut c = Comparison::draft("pair", "A pair", "Two readings.");
    c.status = Status::Published;
    c.interpretations = vec![
        Interpretation::new("a", named("A"), "Reading A."),
        Interpretation::new("b", named("B"), "Reading B."),
    ];
    c
}

fn project(c: &Comparison) -> (PublicComparison, Vec<(String, WithheldReason)>) {
    let (p, w) = PublicComparison::project(c, &References::default());
    (
        p.expect("projects"),
        w.into_iter().map(|w| (w.id, w.reason)).collect(),
    )
}

fn with_explanations(items: Vec<Explanation>) -> Comparison {
    let mut c = pair();
    c.explanations = items;
    c
}

#[test]
fn legacy_explanations_keep_their_bytes_digest_and_approval() {
    let text: Value = serde_json::from_str(LEGACY).unwrap();
    let c = parse(&text).unwrap();
    assert_eq!(c.to_canonical_json(), LEGACY);
    let beginner = &c.explanations[0];
    assert!(beginner.authors.is_empty() && beginner.modes.is_empty());
    assert!(beginner.withdrawn.is_none() && beginner.revision.is_none());
    assert_eq!(
        beginner.approval.as_ref().unwrap().digest,
        beginner.digest(),
        "the pre-#209 approval still matches"
    );
    let (public, _) = project(&c);
    assert_eq!(public.explanations.len(), 2);
    let json: Value = serde_json::from_str(&public.to_json()).unwrap();
    for x in json["explanations"].as_array().unwrap() {
        for key in ["authors", "prerequisite", "modes", "language", "revision"] {
            assert!(x.get(key).is_none(), "{key} is not invented for old data");
        }
    }
}

#[test]
fn multiple_authors_a_prerequisite_and_revision_round_trip_and_publish() {
    let mut x = Explanation::new("e1", Level::Student, "Context for students.");
    x.authors = vec!["Ada Author".into(), "Bo Coauthor".into()];
    x.prerequisite = Some("The first section of the article".into());
    x.revision = Some(3);
    let c = with_explanations(vec![x]);
    let reread = parse(&serde_json::from_str(&c.to_canonical_json()).unwrap()).unwrap();
    assert_eq!(reread.explanations, c.explanations);
    assert_eq!(reread.to_canonical_json(), c.to_canonical_json());
    let (public, withheld) = project(&c);
    assert!(withheld.is_empty());
    let p = &public.explanations[0];
    assert_eq!(p.authors, ["Ada Author", "Bo Coauthor"]);
    assert_eq!(p.revision, Some(3));
    assert!(public.supplemental, "a level never replaces the article");
}

#[test]
fn authors_prerequisite_and_modes_are_bounded_and_deduplicated() {
    for (field, value) in [
        ("authors", json!(["A", "A"])),
        ("authors", json!(["1", "2", "3", "4", "5", "6"])),
        ("authors", json!([7])),
        ("modes", json!(["guided", "guided"])),
        ("modes", json!(["standard"])),
        ("prerequisite", json!(" ")),
        ("revision", json!(0)),
        ("hides", json!(true)),
    ] {
        let mut v: Value = serde_json::from_str(LEGACY).unwrap();
        v["explanations"][1][field] = value;
        let err = parse(&v).unwrap_err();
        assert!(!err.is_empty(), "{field} refused");
    }
}

#[test]
fn one_explanation_serves_several_modes_without_duplication() {
    let mut x = Explanation::new("e1", Level::Beginner, "Plain words.");
    x.modes = vec![ExplanationMode::Guided, ExplanationMode::DeepDive];
    let c = with_explanations(vec![x]);
    let (public, _) = project(&c);
    assert_eq!(public.explanations.len(), 1);
    assert_eq!(
        public.explanations[0].modes,
        [ExplanationMode::Guided, ExplanationMode::DeepDive]
    );
    // A second beginner explanation of the same subject is still refused:
    // serving two modes never needs two copies.
    let mut dup = Explanation::new("e2", Level::Beginner, "Plain words again.");
    dup.modes = vec![ExplanationMode::DeepDive];
    let mut c = c;
    c.explanations.push(dup);
    assert!(!c.validate().is_empty());
}

#[test]
fn translations_name_an_original_of_the_same_level_and_subject() {
    let original = Explanation::new("e1", Level::Student, "Context.");
    let mut fr = Explanation::new("e1-fr", Level::Student, "Contexte.");
    fr.language = Some("fr".into());
    fr.translation_of = Some("e1".into());
    let c = with_explanations(vec![original.clone(), fr.clone()]);
    assert!(c.validate().is_empty(), "{:?}", c.validate());
    let (public, _) = project(&c);
    assert_eq!(public.explanations.len(), 2);
    assert_eq!(public.explanations[1].translation_of.as_deref(), Some("e1"));

    let mut bad_level = fr.clone();
    bad_level.level = Level::Scholarly;
    assert!(!with_explanations(vec![original.clone(), bad_level])
        .validate()
        .is_empty());
    let mut no_language = fr.clone();
    no_language.language = None;
    assert!(!with_explanations(vec![original.clone(), no_language])
        .validate()
        .is_empty());
    let mut missing = fr.clone();
    missing.translation_of = Some("nope".into());
    assert!(!with_explanations(vec![original.clone(), missing])
        .validate()
        .is_empty());
    let mut itself = fr.clone();
    itself.translation_of = Some("e1-fr".into());
    assert!(!with_explanations(vec![original.clone(), itself])
        .validate()
        .is_empty());
    let mut same_language = fr;
    same_language.language = None;
    same_language.translation_of = None;
    assert!(!with_explanations(vec![original, same_language])
        .validate()
        .is_empty());
}

#[test]
fn a_translation_loses_its_pointer_when_the_original_is_not_public() {
    let mut original = Explanation::new("e1", Level::Student, "Context.");
    original.origin = Origin::AiDraft {
        tool: "a tool".into(),
        drafted_at: None,
        extra: Default::default(),
    };
    let mut fr = Explanation::new("e1-fr", Level::Student, "Contexte.");
    fr.language = Some("fr".into());
    fr.translation_of = Some("e1".into());
    let c = with_explanations(vec![original, fr]);
    let (public, withheld) = PublicComparison::project(&c, &References::default());
    let public = public.unwrap();
    assert_eq!(public.explanations.len(), 1);
    assert_eq!(public.explanations[0].translation_of, None);
    assert_eq!(withheld[0].reason, WithheldReason::AwaitingApproval);
}

#[test]
fn a_generated_draft_never_goes_public_without_a_current_approval() {
    let mut x = Explanation::new("e1", Level::Beginner, "Drafted text.");
    x.origin = Origin::AiDraft {
        tool: "a tool".into(),
        drafted_at: None,
        extra: Default::default(),
    };
    x.authors = vec!["Ada Author".into()];
    let mut c = with_explanations(vec![x]);
    let (public, withheld) = project(&c);
    assert!(public.explanations.is_empty());
    assert_eq!(
        withheld,
        [("e1".to_string(), WithheldReason::AwaitingApproval)]
    );
    assert!(!c.validate().is_empty(), "a published file refuses it");

    // Approve exactly this text and byline.
    let digest = c.explanations[0].digest();
    c.explanations[0].approval = Some(approval(&digest));
    let (public, _) = project(&c);
    assert_eq!(public.explanations.len(), 1);
    assert!(matches!(
        public.explanations[0].provenance,
        PublicProvenance::AiDraft { .. }
    ));

    // Changing anything the reader sees (here the byline) makes it stale.
    c.explanations[0].authors.push("Someone Else".into());
    let (public, withheld) = project(&c);
    assert!(public.explanations.is_empty());
    assert_eq!(withheld[0].1, WithheldReason::StaleApproval);

    // A revoked approval withdraws it again.
    c.explanations[0].authors.pop();
    c.explanations[0].approval = None;
    let (public, withheld) = project(&c);
    assert!(public.explanations.is_empty());
    assert_eq!(withheld[0].1, WithheldReason::AwaitingApproval);
}

fn approval(digest: &str) -> openblog_core::scholarly_comparison::Approval {
    openblog_core::scholarly_comparison::Approval {
        by: "admin".into(),
        at: "2026-10-27T10:00:00Z".into(),
        digest: digest.into(),
        extra: Default::default(),
    }
}

#[test]
fn a_withdrawn_explanation_is_never_public_and_frees_its_place() {
    let mut old = Explanation::new("old", Level::Student, "Old words.");
    old.withdrawn = Some(withdrawal("PRIVATE-REASON"));
    let new = Explanation::new("new", Level::Student, "New words.");
    let c = with_explanations(vec![old, new]);
    assert!(c.validate().is_empty(), "{:?}", c.validate());
    let (public, withheld) = project(&c);
    assert_eq!(public.explanations.len(), 1);
    assert_eq!(public.explanations[0].id, "new");
    assert_eq!(withheld, [("old".to_string(), WithheldReason::Withdrawn)]);
    assert!(!public.to_json().contains("PRIVATE-REASON"));
    let canonical = c.to_canonical_json();
    assert!(canonical.contains("PRIVATE-REASON"), "kept in the file");
    assert_eq!(
        parse(&serde_json::from_str(&canonical).unwrap())
            .unwrap()
            .explanations,
        c.explanations
    );
}

fn withdrawal(reason: &str) -> openblog_core::scholarly_comparison::Withdrawal {
    openblog_core::scholarly_comparison::Withdrawal {
        at: "2026-10-27T10:00:00Z".into(),
        reason: Some(reason.into()),
        extra: Default::default(),
    }
}

#[test]
fn every_level_stays_listed_in_order_and_no_field_ranks_or_hides() {
    let c = with_explanations(vec![
        Explanation::new("s", Level::Scholarly, "S."),
        Explanation::new("b", Level::Beginner, "B."),
    ]);
    let (public, _) = project(&c);
    let levels: Vec<Level> = public.explanations.iter().map(|x| x.level).collect();
    assert_eq!(levels, [Level::Beginner, Level::Scholarly]);
    for field in ["hides", "gated", "locked", "rank", "replaces"] {
        let mut v: Value = serde_json::from_str(LEGACY).unwrap();
        v["explanations"][0][field] = json!(true);
        assert!(parse(&v).is_err(), "{field} refused");
    }
}
