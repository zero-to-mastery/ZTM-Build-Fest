//! Passage alignments across editions, translations, witnesses, and
//! interpretations (ADR 0088): many-to-many and missing passages, original
//! wording kept apart from normalization, no implied equivalence, and failures
//! scoped to the alignment and field.

use std::collections::BTreeMap;

use openblog_core::alignment::{
    looks_like_alignments, Alignment, AlignmentSet, Correspondence, MemberVersion, ALIGNMENT_NOTICE,
};
use openblog_core::knowledge_atlas::{AtlasDiagnosticCode as Code, Links};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use serde_json::{json, Value};

/// A diagnostic's code, alignment id, and field.
type Problem = (Code, Option<String>, Option<String>);

fn library() -> SourceLibrary {
    SourceLibrary::parse(
        &json!({"version": 1, "sources": [
            {"id": "plato-republic", "kind": "work", "title": "Πολιτεία"},
            {"id": "burnet", "kind": "edition", "of": "plato-republic", "title": "Platonis Opera"},
            {"id": "slings", "kind": "edition", "of": "plato-republic", "title": "Platonis Rempublicam"},
            {"id": "grube", "kind": "translation", "of": "plato-republic", "language": "en", "title": "Republic"},
            {"id": "hebrew", "kind": "translation", "of": "plato-republic", "language": "he", "title": "המדינה"},
            {"id": "paris", "kind": "witness", "of": "plato-republic", "title": "Paris gr. 1807"},
            {"id": "old", "kind": "edition", "of": "plato-republic", "title": "Old", "archived": true},
            {"id": "cave-ref", "kind": "reference", "of": "burnet",
             "location": {"scheme": "canonical", "value": "514a"}}
        ], "interpretations": [
            {"id": "cave-mine", "kind": "rendering", "source": "burnet", "language": "en",
             "locators": [{"kind": "canonical", "value": "514a"}],
             "text": "Compare our nature to this.", "interpreters": [{"name": "Ada"}]}
        ]})
        .to_string(),
        &BTreeMap::new(),
    )
    .unwrap()
}

/// Greek with combining marks written decomposed (NFD), so any normalization
/// on the way through would be visible.
const GREEK_NFD: &str =
    "\u{3bc}\u{3b5}\u{3c4}\u{3b1}\u{300} \u{3c4}\u{3b1}\u{3c5}\u{3c4}\u{3b1}\u{301}";
const HEBREW: &str = "אַחַר כָּךְ, הַמְשֵׁל";

fn notebook(library: &SourceLibrary) -> Notebook {
    Notebook::parse(
        &json!({"version": 1, "passages": [
            {"id": "p-burnet", "source": "burnet", "visibility": "private",
             "excerpt": {"text": GREEK_NFD, "language": "grc"},
             "locators": [{"kind": "canonical", "value": "514a"}]},
            {"id": "p-grube-1", "source": "grube", "visibility": "private",
             "excerpt": {"text": "Next, then,", "language": "en"},
             "locators": [{"kind": "page", "value": "186"}]},
            {"id": "p-grube-2", "source": "grube", "visibility": "private",
             "excerpt": {"text": "compare the effect of education", "language": "en"},
             "locators": [{"kind": "page", "value": "187"}]},
            {"id": "p-hebrew", "source": "hebrew", "visibility": "private",
             "excerpt": {"text": HEBREW, "language": "he"},
             "locators": [{"kind": "page", "value": "212"}]},
            {"id": "p-paris", "source": "paris", "visibility": "private", "archived": true,
             "excerpt": {"text": "μετὰ ταῦτα"},
             "locators": [{"kind": "folio", "value": "12r"}]}
        ]})
        .to_string(),
        library,
    )
    .unwrap()
}

/// One alignment of each shape the issue names.
fn fixture() -> Value {
    json!({"version": 1, "alignments": [
        {"id": "cave-split", "label": "Opening of the cave image", "correspondence": "partial",
         "members": [
            {"source": "burnet", "passage": "p-burnet",
             "normalized": {"text": "μετὰ ταῦτα", "note": "Accents composed (NFC)"}},
            {"source": "grube", "passage": "p-grube-1"},
            {"source": "grube", "passage": "p-grube-2", "note": "The translator splits one sentence in two"},
            {"interpretation": "cave-mine"}
         ],
         "rationale": "Both translations render 514a.", "confidence": "plausible",
         "recordedBy": {"kind": "named", "name": "Ada"},
         "evidence": [{"source": "slings", "locators": [{"kind": "canonical", "value": "514a"}]}],
         "shelf": {"kept": true}},
        {"id": "cave-merged", "members": [
            {"source": "slings", "locators": [{"kind": "canonical", "value": "514a"}]},
            {"source": "slings", "locators": [{"kind": "canonical", "value": "514b"}]},
            {"source": "grube", "passage": "p-grube-1"}
        ]},
        {"id": "cave-reordered", "correspondence": "divergent", "members": [
            {"source": "hebrew", "passage": "p-hebrew", "locators": [{"kind": "page", "value": "212"}],
             "normalized": {"text": "אחר כך, המשל", "note": "Vowel points removed"}},
            {"source": "burnet", "locators": [{"kind": "canonical", "value": "515c"}]},
            {"source": "burnet", "locators": [{"kind": "canonical", "value": "514a"}]}
         ]},
        {"id": "cave-omitted", "members": [
            {"source": "burnet", "locators": [{"kind": "canonical", "value": "514a", "to": "514b"}]},
            {"source": "paris", "absent": true, "note": "Folio 12 is lost"}
        ]}
    ]})
}

fn parse(value: &Value) -> Result<AlignmentSet, Vec<Problem>> {
    let library = library();
    let notebook = notebook(&library);
    AlignmentSet::parse(
        &value.to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .map_err(|diagnostics| {
        diagnostics
            .into_iter()
            .map(|d| (d.code, d.id, d.field))
            .collect()
    })
}

fn refused(edit: impl FnOnce(&mut Value)) -> Vec<Problem> {
    let mut value = fixture();
    edit(&mut value);
    parse(&value).expect_err("the alignments should be refused")
}

#[test]
fn many_to_many_split_merged_reordered_and_missing_passages_are_representable() {
    let set = parse(&fixture()).unwrap();
    let split = set.alignment("cave-split").unwrap();
    assert_eq!(
        split.versions(),
        [
            MemberVersion::Source("burnet"),
            MemberVersion::Source("grube"),
            MemberVersion::Interpretation("cave-mine"),
        ],
        "one place in Burnet aligns with two in the translation and an interpretation"
    );
    let merged = set.alignment("cave-merged").unwrap();
    assert_eq!(merged.members.len(), 3);
    assert_eq!(merged.versions().len(), 2, "two places merge into one");
    assert_eq!(
        set.uses_of_passage("p-grube-1"),
        ["cave-split", "cave-merged"],
        "one passage may belong to several alignments"
    );
    let reordered = set.alignment("cave-reordered").unwrap();
    let order: Vec<&str> = reordered
        .members
        .iter()
        .flat_map(|m| m.locators.iter().map(|l| l.value.as_str()))
        .collect();
    assert_eq!(
        order,
        ["212", "515c", "514a"],
        "member order and locators are the author's, never sorted"
    );
    let omitted = set.alignment("cave-omitted").unwrap();
    assert!(omitted.members[1].absent && omitted.members[1].locators.is_empty());
    assert_eq!(
        omitted.correspondence,
        Correspondence::Corresponding,
        "the default"
    );
}

#[test]
fn the_file_round_trips_losslessly_deterministically_and_without_normalizing_text() {
    let set = parse(&fixture()).unwrap();
    let text = set.to_json();
    assert_eq!(parse(&serde_json::from_str(&text).unwrap()).unwrap(), set);
    assert_eq!(
        parse(&serde_json::from_str(&text).unwrap())
            .unwrap()
            .to_json(),
        text
    );
    let split = set.alignment("cave-split").unwrap();
    assert_eq!(
        split.extra["shelf"],
        json!({"kept": true}),
        "unknown fields are kept"
    );
    assert!(
        text.contains("\"visibility\": \"private\""),
        "private is written explicitly"
    );
    assert!(
        text.contains("\"confidence\": \"tentative\""),
        "an unstated confidence reads as tentative"
    );
    let reordered = set.alignment("cave-reordered").unwrap();
    assert_eq!(
        reordered.members[0].normalized.as_ref().unwrap().text,
        "אחר כך, המשל",
        "right-to-left text is stored exactly as written"
    );
    let library = library();
    let notebook = notebook(&library);
    assert_eq!(
        notebook.passage("p-burnet").unwrap().excerpt.text,
        GREEK_NFD,
        "the original wording is still decomposed"
    );
    assert_ne!(
        split.members[0].normalized.as_ref().unwrap().text,
        GREEK_NFD,
        "the normalization is a separate text, not a rewrite of the original"
    );
}

#[test]
fn original_wording_and_normalization_stay_distinguishable() {
    // A normalization needs the original it normalizes.
    assert_eq!(
        refused(|v| v["alignments"][2]["members"][1]["normalized"] = json!({"text": "x"})),
        [(
            Code::MissingOriginal,
            Some("cave-reordered".into()),
            Some("members[1].normalized".into())
        )]
    );
    // An absent member has no wording to normalize.
    let problems = refused(|v| {
        v["alignments"][3]["members"][1]["normalized"] = json!({"text": "x"});
    });
    assert_eq!(problems[0].0, Code::ConflictingMember);
    assert_eq!(problems[0].2.as_deref(), Some("members[1].normalized"));
    // Control and bidirectional override characters are refused in normalized text.
    let problems = refused(|v| {
        v["alignments"][2]["members"][0]["normalized"]["text"] = json!("\u{202e}evil");
    });
    assert_eq!(
        problems,
        [(
            Code::InvalidField,
            Some("cave-reordered".into()),
            Some("members[0].normalized.text".into())
        )]
    );
}

#[test]
fn an_alignment_never_implies_semantic_equivalence_or_authority() {
    let problems = refused(|v| v["alignments"][0]["correspondence"] = json!("equivalent"));
    assert_eq!(problems[0].0, Code::InvalidField);
    assert_eq!(problems[0].2.as_deref(), Some("correspondence"));
    // Approval is consent for the comparison projection (ADR 0092); nothing
    // else may mark an alignment public.
    let problems = refused(|v| v["alignments"][0]["visibility"] = json!("public"));
    assert_eq!(problems[0].0, Code::InvalidVisibility);
    let mut approved = fixture();
    approved["alignments"][0]["visibility"] = json!("approved");
    approved["alignments"][0]["publishNormalized"] = json!(true);
    let set = parse(&approved).unwrap();
    assert!(set.alignments[0].is_approved() && set.alignments[0].publish_normalized);
    assert!(!set.alignments[1].is_approved() && !set.alignments[1].publish_normalized);
    let text = set.to_json();
    assert!(text.contains("\"visibility\": \"approved\""));
    assert_eq!(
        text.matches("publishNormalized").count(),
        1,
        "written only when true"
    );
    let problems = refused(|v| v["alignments"][0]["publishNormalized"] = json!("yes"));
    assert_eq!(problems[0].2.as_deref(), Some("publishNormalized"));
    for correspondence in [
        Correspondence::Corresponding,
        Correspondence::Partial,
        Correspondence::Divergent,
    ] {
        assert!(correspondence.label().starts_with("The author reads"));
        assert!(!correspondence.label().contains("same"));
    }
    assert!(ALIGNMENT_NOTICE.contains("does not say they mean the same"));
    let set = parse(&fixture()).unwrap();
    let text = set.to_json();
    assert!(!text.contains("equivalen") && !text.contains("authoritative"));
}

#[test]
fn members_name_exact_versions_and_places() {
    let at = |field: &str| Some(field.to_string());
    for (edit, code, field) in [
        (
            json!({"source": "plato-republic", "locators": [{"kind": "canonical", "value": "514a"}]}),
            Code::WrongSourceKind,
            at("members[0].source"),
        ),
        (
            json!({"source": "cave-ref", "locators": [{"kind": "canonical", "value": "514a"}]}),
            Code::WrongSourceKind,
            at("members[0].source"),
        ),
        (
            json!({"source": "missing", "locators": [{"kind": "page", "value": "1"}]}),
            Code::UnknownSource,
            at("members[0].source"),
        ),
        (
            json!({"source": "burnet", "locators": [{"kind": "folio", "value": "1r"}]}),
            Code::AmbiguousLocator,
            at("members[0].locators[0].kind"),
        ),
        (
            json!({"source": "burnet", "passage": "p-grube-1"}),
            Code::UnknownPassage,
            at("members[0].passage"),
        ),
        (
            json!({"source": "burnet", "passage": "gone"}),
            Code::UnknownPassage,
            at("members[0].passage"),
        ),
        (
            json!({"interpretation": "nobody"}),
            Code::UnknownInterpretation,
            at("members[0].interpretation"),
        ),
        (
            json!({"source": "burnet"}),
            Code::MissingLocator,
            at("members[0].locators"),
        ),
        (
            json!({"interpretation": "cave-mine", "locators": [{"kind": "page", "value": "1"}]}),
            Code::InvalidField,
            at("members[0].locators"),
        ),
        (
            json!({"source": "burnet", "interpretation": "cave-mine"}),
            Code::InvalidField,
            at("members[0].interpretation"),
        ),
        (
            json!({"locators": [{"kind": "page", "value": "1"}]}),
            Code::MissingField,
            at("members[0].source"),
        ),
        (
            json!({"source": "paris", "absent": true, "locators": [{"kind": "folio", "value": "1r"}]}),
            Code::ConflictingMember,
            at("members[0].locators"),
        ),
        (
            json!({"source": "burnet", "locators": [{"kind": "canonical", "value": "514a"}], "credit": "x"}),
            Code::ContributorCredit,
            at("members[0].credit"),
        ),
    ] {
        let problems = refused(|v| v["alignments"][1]["members"][0] = edit.clone());
        assert_eq!(
            problems,
            [(code, Some("cave-merged".into()), field.clone())],
            "{edit}"
        );
    }
}

#[test]
fn an_alignment_relates_two_versions_and_records_each_once() {
    let missing = |problems: Vec<Problem>| {
        assert_eq!(
            problems,
            [(
                Code::MissingCounterpart,
                Some("cave-omitted".into()),
                Some("members".into())
            )]
        );
    };
    missing(refused(|v| {
        v["alignments"][3]["members"] =
            json!([{"source": "burnet", "locators": [{"kind": "page", "value": "1"}]}]);
    }));
    missing(refused(|v| {
        v["alignments"][3]["members"][0] = json!({"source": "slings", "absent": true});
    }));
    // Two places in one version are a split, not an alignment across versions.
    missing(refused(|v| {
        v["alignments"][3]["members"][1] =
            json!({"source": "burnet", "locators": [{"kind": "page", "value": "2"}]});
    }));
    assert_eq!(
        refused(|v| {
            let first = v["alignments"][1]["members"][0].clone();
            v["alignments"][1]["members"]
                .as_array_mut()
                .unwrap()
                .push(first);
        }),
        [(
            Code::DuplicateMember,
            Some("cave-merged".into()),
            Some("members[3]".into())
        )]
    );
    assert_eq!(
        refused(|v| {
            v["alignments"][3]["members"]
                .as_array_mut()
                .unwrap()
                .push(json!({"source": "burnet", "absent": true}));
        }),
        [(
            Code::ConflictingMember,
            Some("cave-omitted".into()),
            Some("members[2].absent".into())
        )]
    );
    assert_eq!(
        refused(|v| v["alignments"][1]["id"] = json!("cave-split")),
        [(
            Code::DuplicateId,
            Some("cave-split".into()),
            Some("id".into())
        )]
    );
}

#[test]
fn failures_are_scoped_and_leave_the_set_unchanged() {
    let library = library();
    let notebook = notebook(&library);
    let links = Links {
        library: &library,
        notebook: &notebook,
    };
    let mut set = parse(&fixture()).unwrap();
    let before = set.clone();
    let mut broken = set.alignment("cave-merged").unwrap().clone();
    broken.members[0].source = Some("missing".into());
    let problems = set.upsert_alignment(broken, links, false).unwrap_err();
    assert_eq!(problems.len(), 1);
    assert_eq!(problems[0].id.as_deref(), Some("cave-merged"));
    assert!(problems[0]
        .to_string()
        .starts_with("alignments[1] `cave-merged` members[0].source"));
    assert_eq!(set, before, "nothing changed");
    assert_eq!(
        set.remove_alignment("nope", links).unwrap_err()[0].code,
        Code::UnknownAlignment
    );
    assert_eq!(set, before);
    // A request body is checked with the stored rules, scoped to its field.
    let shape =
        Alignment::from_json(json!({"id": "x", "members": [{"source": "burnet"}]})).unwrap_err();
    assert!(shape.iter().all(|d| d.index.is_none()));
    assert!(shape.iter().any(|d| d.code == Code::MissingLocator));
    assert!(
        !shape.iter().any(|d| d.message.contains("514")),
        "messages never repeat authored text"
    );
    // Upserts and removals that are valid change only what they name.
    let mut added = Alignment::from_json(json!({"id": "new", "members": [
        {"source": "slings", "locators": [{"kind": "canonical", "value": "516"}]},
        {"source": "hebrew", "absent": true}
    ]}))
    .unwrap();
    set.upsert_alignment(added.clone(), links, false).unwrap();
    added.label = Some("Later".into());
    set.upsert_alignment(added, links, false).unwrap();
    assert_eq!(set.alignments.len(), 5);
    assert_eq!(set.alignments[4].label.as_deref(), Some("Later"));
    set.remove_alignment("new", links).unwrap();
    assert_eq!(set, before);
}

#[test]
fn stale_locators_and_archived_members_are_reported_as_notices() {
    let library = library();
    let notebook = notebook(&library);
    let links = Links {
        library: &library,
        notebook: &notebook,
    };
    let mut value = fixture();
    // The Hebrew passage was re-located after it was aligned.
    value["alignments"][2]["members"][0]["locators"] = json!([{"kind": "page", "value": "211"}]);
    value["alignments"][3]["members"][1] = json!({"source": "paris", "passage": "p-paris"});
    value["alignments"][1]["members"][1]["source"] = json!("old");
    let set = parse(&value).unwrap();
    let notices: Vec<Problem> = set
        .notices(links)
        .into_iter()
        .map(|d| (d.code, d.id, d.field))
        .collect();
    assert_eq!(
        notices,
        [
            (
                Code::ArchivedMember,
                Some("cave-merged".into()),
                Some("members[1].source".into())
            ),
            (
                Code::StaleLocator,
                Some("cave-reordered".into()),
                Some("members[0].locators".into())
            ),
            (
                Code::ArchivedMember,
                Some("cave-omitted".into()),
                Some("members[1].passage".into())
            ),
        ]
    );
    assert!(parse(&fixture()).unwrap().notices(links).is_empty());
}

#[test]
fn uses_name_alignment_ids_for_cross_store_guards() {
    let set = parse(&fixture()).unwrap();
    assert_eq!(
        set.uses_of_source("slings"),
        ["cave-split", "cave-merged"],
        "evidence counts as a use"
    );
    assert_eq!(
        set.uses_of_source("paris"),
        ["cave-omitted"],
        "so does recording an absence"
    );
    assert!(set.uses_of_source("plato-republic").is_empty());
    assert_eq!(set.uses_of_interpretation("cave-mine"), ["cave-split"]);
    assert_eq!(set.uses_of_passage("p-hebrew"), ["cave-reordered"]);
}

#[test]
fn hostile_and_oversized_input_is_refused() {
    assert_eq!(
        refused(|v| v["version"] = json!(2))[0].0,
        Code::UnsupportedVersion
    );
    assert_eq!(
        refused(|v| v["credits"] = json!([]))[0].0,
        Code::ContributorCredit
    );
    let problems = refused(|v| v["alignments"][0]["label"] = json!("a\u{0}b"));
    assert_eq!(problems[0].2.as_deref(), Some("label"));
    let problems = refused(|v| {
        v["alignments"][0]["members"] = Value::Array(vec![
            json!({"source": "burnet", "locators": [{"kind": "page", "value": "1"}]});
            33
        ]);
    });
    assert_eq!(problems[0].0, Code::TooLarge);
    let library = library();
    let notebook = notebook(&library);
    let links = Links {
        library: &library,
        notebook: &notebook,
    };
    assert_eq!(
        AlignmentSet::parse(&" ".repeat(5 * 1024 * 1024), links).unwrap_err()[0].code,
        Code::TooLarge
    );
    assert!(AlignmentSet::parse("[]", links).is_err());
    assert_eq!(
        AlignmentSet::parse("\u{feff}{\"version\": 1}", links).unwrap(),
        AlignmentSet::default(),
        "a byte-order mark is ignored and a file with no alignments is empty"
    );
}

#[test]
fn the_shape_is_recognized_for_public_folder_guards() {
    let root = |value: Value| value.as_object().unwrap().clone();
    assert!(looks_like_alignments(&root(fixture())));
    assert!(openblog_core::research_bundle::looks_like_private_research(
        fixture().to_string().as_bytes()
    ));
    assert!(!looks_like_alignments(&root(
        json!({"version": 1, "alignments": []})
    )));
    assert!(!looks_like_alignments(&root(
        json!({"version": 1, "alignments": [{"id": "a", "title": "Public page"}]})
    )));
}
