//! Curated public-research selection (#192, ADR 0185-0190): nothing is public
//! because it exists, selection is revision-aware and item-scoped, a
//! relationship brings its approved endpoint context and provenance, and
//! private research never reaches the curated projection.

use std::collections::{BTreeMap, BTreeSet};

use openblog_core::alignment::AlignmentSet;
use openblog_core::atlas_publication::PublicAtlas;
use openblog_core::comparison_publication::{ComparisonInputs, PublicComparisons};
use openblog_core::curated_selection::{
    resolve, Basis, Code, ContextKind, Existing, NewSelection, NoticeCode, Provenance, Selection,
    SelectionKind, SelectionSet, Why,
};
use openblog_core::knowledge_atlas::{Atlas, Links};
use openblog_core::publication_boundary::{
    BoundaryInputs, BoundaryManifest, CurationInput, ItemKind, Projection, Reason, Switches,
};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use serde_json::{json, Value};

const PRIVATE: &str = "PRIVATE-CURATION-MARKER";

fn library_value() -> Value {
    json!({"version": 1, "sources": [
        {"id": "republic", "kind": "work", "title": "Politeia",
         "creators": [{"name": "Plato", "role": "author"}],
         "identifiers": [{"scheme": "url", "value": "http://localhost:8080/scan"},
                         {"scheme": "doi", "value": "10.1000/republic"},
                         {"scheme": "my-drive", "value": format!("C:/{PRIVATE}/scan.pdf")}],
         "note": format!("{PRIVATE} source note")},
        {"id": "burnet", "kind": "edition", "of": "republic", "title": "Platonis Opera",
         "rights": {"status": "publicDomain"}},
        {"id": "grube", "kind": "translation", "of": "republic", "title": "Republic", "language": "en",
         "rights": {"status": "rightsReserved", "note": format!("{PRIVATE} rights note")}},
        {"id": "scholar", "kind": "work", "title": "A study of the dialogues"},
        {"id": "undated", "kind": "work", "title": "Undated"},
        {"id": "diary", "kind": "work", "title": format!("{PRIVATE} diary")}
    ]})
}

fn library_with(value: &Value) -> SourceLibrary {
    SourceLibrary::parse(&value.to_string(), &BTreeMap::new()).expect("library")
}

fn notebook(library: &SourceLibrary) -> Notebook {
    Notebook::parse(
        &json!({"version": 1, "passages": [
            {"id": "p-burnet", "source": "burnet", "excerpt": {"text": "Compare our nature to this."},
             "locators": [{"kind": "canonical", "value": "514a"}]},
            {"id": "p-grube", "source": "grube", "excerpt": {"text": format!("{PRIVATE} reserved wording")},
             "locators": [{"kind": "page", "value": "186"}]}
        ], "notes": [{"id": "n-1", "kind": "question", "text": format!("{PRIVATE} a private note"),
            "passages": ["p-burnet"]}]})
        .to_string(),
        library,
    )
    .expect("notebook")
}

fn dating(id: &str, aspect: &str, year: i32, source: &str) -> Value {
    json!({"id": id, "aspect": aspect, "date": {"at": {"year": year}},
        "assertedBy": {"kind": "source", "source": source}, "confidence": "plausible",
        "evidence": [{"source": source, "locators": [{"kind": "chapter", "value": "3"}]}],
        "visibility": "approved"})
}

fn atlas_value() -> Value {
    json!({"version": 2,
    "entries": [
        {"id": "plato", "kind": "person", "label": "Plato",
         "summary": "An Athenian philosopher.", "visibility": "approved",
         "dates": [dating("plato-birth-a", "birth", -428, "scholar"),
                   dating("plato-birth-b", "birth", -424, "burnet")]},
        {"id": "republic", "kind": "work", "label": "Republic", "source": "republic",
         "visibility": "approved"},
        {"id": "academy", "kind": "movement", "label": "The Academy <b>x</b>",
         "visibility": "approved"},
        {"id": "secret", "kind": "concept", "label": format!("{PRIVATE} private label"),
         "summary": format!("{PRIVATE} private summary"), "visibility": "private"}
    ],
    "relationships": [
        {"id": "r-authored", "kind": "authored", "from": "plato", "to": "republic",
         "assertedBy": {"kind": "source", "source": "scholar"}, "confidence": "plausible",
         "evidence": [{"source": "burnet", "locators": [{"kind": "page", "value": "514"}]}],
         "uncertainty": "The dating is unsettled.",
         "contestedBy": [{"by": {"kind": "named", "name": "A later editor"},
             "note": "Dates it later.", "evidence": [{"source": "republic"}]}],
         "visibility": "approved"},
        {"id": "r-member", "kind": "member-of", "from": "plato", "to": "academy",
         "assertedBy": {"kind": "author"}, "evidence": [{"source": "scholar"}],
         "visibility": "approved"},
        {"id": "r-private", "kind": "related-to", "from": "plato", "to": "academy",
         "assertedBy": {"kind": "author"}, "evidence": [{"source": "scholar"}],
         "uncertainty": format!("{PRIVATE} private relationship"), "visibility": "private"}
    ]})
}

struct World {
    library: SourceLibrary,
    atlas: Atlas,
    public_atlas: PublicAtlas,
    comparisons: PublicComparisons,
    existing: Existing,
    /// Cited by a published post, atlas-published or comparison-published.
    public_sources: BTreeSet<String>,
    posts: BTreeSet<String>,
}

fn alignments_value() -> Value {
    json!({"version": 1, "alignments": [
        {"id": "cave", "label": "The cave", "correspondence": "partial", "visibility": "approved",
         "members": [{"source": "burnet", "passage": "p-burnet"},
                     {"source": "grube", "passage": "p-grube"}],
         "rationale": "Both render 514a.", "confidence": "plausible",
         "recordedBy": {"kind": "named", "name": "A concordance"},
         "evidence": [{"source": "burnet"}]},
        {"id": "hidden", "label": format!("{PRIVATE} hidden"), "members": [
            {"source": "burnet", "passage": "p-burnet"},
            {"source": "grube", "locators": [{"kind": "page", "value": "1"}]}]}
    ]})
}

fn world_with(library_value: &Value, atlas_value: &Value) -> World {
    let library = library_with(library_value);
    let notebook = notebook(&library);
    let atlas = Atlas::parse(
        &atlas_value.to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .expect("atlas");
    let set = AlignmentSet::parse(
        &alignments_value().to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .expect("alignments");
    let public_atlas = PublicAtlas::project(&atlas, &library).expect("projection");
    let comparisons = PublicComparisons::project(
        &set,
        ComparisonInputs {
            library: &library,
            notebook: &notebook,
            contributors: &BTreeMap::new(),
        },
    )
    .expect("comparisons");
    let existing = Existing::of(Some(&atlas), Some(&set));
    // `undated` is public only because a published post cites it.
    let public_sources = public_atlas
        .sources
        .iter()
        .chain(&comparisons.sources)
        .map(|source| source.reference.key.clone())
        .chain(["undated".to_string()])
        .collect();
    World {
        library,
        atlas,
        public_atlas,
        comparisons,
        existing,
        public_sources,
        posts: ["cave".to_string(), "other".to_string()].into(),
    }
}

fn world() -> World {
    world_with(&library_value(), &atlas_value())
}

impl World {
    fn basis(&self) -> Basis<'_> {
        Basis {
            atlas: Some(&self.public_atlas),
            comparisons: Some(&self.comparisons),
            library: Some(&self.library),
            existing: Some(&self.existing),
            public_sources: Some(&self.public_sources),
            posts: Some(&self.posts),
        }
    }
}

fn pick(kind: SelectionKind, target: &str) -> NewSelection {
    NewSelection {
        kind: Some(kind),
        target: target.into(),
        ..NewSelection::default()
    }
}

fn select(set: &mut SelectionSet, world: &World, new: NewSelection) -> String {
    set.select(new, &world.basis()).expect("selected")
}

#[test]
fn nothing_is_public_merely_because_it_exists() {
    let w = world();
    let resolution = resolve(&SelectionSet::default(), &w.basis());
    assert!(resolution.curation.items.is_empty() && resolution.curation.context.is_empty());
    assert!(resolution.withheld.is_empty());

    // Selecting never approves: private and unapproved research is refused.
    let mut set = SelectionSet::default();
    for (kind, target) in [
        (SelectionKind::ContextualEntry, "secret"),
        (SelectionKind::Relationship, "r-private"),
        (SelectionKind::Comparison, "hidden"),
        (SelectionKind::Reference, "missing-source"),
    ] {
        let problems = set.select(pick(kind, target), &w.basis()).unwrap_err();
        assert_eq!(problems[0].code, Code::TargetNotPublished, "{target}");
        assert!(!problems[0].message.contains(PRIVATE));
    }
    assert!(set.selections.is_empty());
}

#[test]
fn only_the_listed_fields_of_a_selected_item_publish() {
    let w = world();
    let mut set = SelectionSet::default();
    let bare = select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
    let resolution = resolve(&set, &w.basis());
    let item = &resolution.curation.items[0];
    assert_eq!(item.id, bare);
    assert!(item.content.contains_key("label") && item.content.contains_key("url"));
    assert!(!item.content.contains_key("summary"), "{:?}", item.content);

    let mut set = SelectionSet::default();
    select(
        &mut set,
        &w,
        NewSelection {
            optional_fields: vec!["summary".into()],
            ..pick(SelectionKind::ContextualEntry, "plato")
        },
    );
    let resolution = resolve(&set, &w.basis());
    assert_eq!(
        resolution.curation.items[0].content["summary"],
        json!("An Athenian philosopher.")
    );
}

#[test]
fn a_relationship_brings_its_endpoints_provenance_and_disputes() {
    let w = world();
    let mut set = SelectionSet::default();
    select(
        &mut set,
        &w,
        pick(SelectionKind::Relationship, "r-authored"),
    );
    let resolution = resolve(&set, &w.basis());
    let item = &resolution.curation.items[0];
    for field in [
        "assertedBy",
        "confidence",
        "evidence",
        "standing",
        "uncertainty",
        "contestedBy",
    ] {
        assert!(item.content.contains_key(field), "{field}");
    }
    assert_eq!(item.content["standing"], json!("contested"));
    let context: Vec<(ContextKind, &str)> = resolution
        .curation
        .context
        .iter()
        .map(|c| (c.kind, c.id.as_str()))
        .collect();
    assert_eq!(
        context,
        vec![
            (ContextKind::Entry, "plato"),
            (ContextKind::Entry, "republic"),
            (ContextKind::Source, "burnet"),
            (ContextKind::Source, "republic"),
            (ContextKind::Source, "scholar"),
        ]
    );
    assert!(resolution
        .curation
        .context
        .iter()
        .all(|c| c.via == vec![item.id.clone()]));
    // Nothing from the unrelated entries.
    assert!(!resolution
        .curation
        .context
        .iter()
        .any(|c| c.id == "academy" || c.id == "grube"));

    // A disputed relationship cannot be curated into an undisputed one.
    let mut stored = set.selections[0].clone();
    stored.fields.retain(|f| f != "contestedBy");
    let problems = openblog_core::curated_selection::validate(&stored);
    assert_eq!(problems[0].code, Code::RequiredFieldMissing);
}

#[test]
fn a_changed_source_makes_a_selection_stale_until_it_is_selected_again() {
    let w = world();
    let mut set = SelectionSet::default();
    let relationship = select(
        &mut set,
        &w,
        pick(SelectionKind::Relationship, "r-authored"),
    );
    let reference = select(&mut set, &w, pick(SelectionKind::Reference, "scholar"));
    let other = select(
        &mut set,
        &w,
        pick(SelectionKind::ContextualEntry, "academy"),
    );

    let mut changed = library_value();
    changed["sources"][3]["title"] = json!("A revised study");
    let w2 = world_with(&changed, &atlas_value());
    let resolution = resolve(&set, &w2.basis());
    let stale: Vec<&str> = resolution
        .withheld
        .iter()
        .filter(|w| w.why == Why::Stale)
        .map(|w| w.id.as_str())
        .collect();
    // The relationship depends on the source; the other entry does not.
    let mut expected = vec![reference.as_str(), relationship.as_str()];
    expected.sort_unstable();
    assert_eq!(stale, expected);
    assert_eq!(resolution.curation.items.len(), 1);
    assert_eq!(resolution.curation.items[0].id, other);

    // The author checks and selects again: published as it now stands.
    set.reselect(&reference, &w2.basis()).unwrap();
    set.reselect(&relationship, &w2.basis()).unwrap();
    let resolution = resolve(&set, &w2.basis());
    assert!(resolution.withheld.is_empty());
    assert_eq!(resolution.curation.items.len(), 3);
}

#[test]
fn deleted_and_unapproved_targets_are_told_apart() {
    let w = world();
    let mut set = SelectionSet::default();
    let entry = select(
        &mut set,
        &w,
        pick(SelectionKind::ContextualEntry, "academy"),
    );
    let member = select(&mut set, &w, pick(SelectionKind::Relationship, "r-member"));

    // Deleted: the entry and its relationship are gone from the atlas.
    let mut atlas = atlas_value();
    atlas["entries"]
        .as_array_mut()
        .unwrap()
        .retain(|e| e["id"] != "academy");
    atlas["relationships"]
        .as_array_mut()
        .unwrap()
        .retain(|r| r["to"] != "academy");
    let gone = world_with(&library_value(), &atlas);
    let resolution = resolve(&set, &gone.basis());
    assert!(resolution
        .withheld
        .iter()
        .all(|w| w.why == Why::TargetMissing));
    assert_eq!(resolution.withheld.len(), 2);

    // Withdrawn from the atlas (made private): exists, not approved.
    let mut atlas = atlas_value();
    atlas["relationships"][1]["visibility"] = json!("private");
    let hidden = world_with(&library_value(), &atlas);
    let resolution = resolve(&set, &hidden.basis());
    let why = |id: &str| resolution.withheld.iter().find(|w| w.id == id).unwrap().why;
    assert_eq!(why(&member), Why::NotApproved);
    assert_eq!(resolution.curation.items[0].id, entry);
}

#[test]
fn cycles_and_withheld_requirements_are_scoped_to_their_selections() {
    let w = world();
    let mut set = SelectionSet::default();
    let a = select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
    let b = select(
        &mut set,
        &w,
        pick(SelectionKind::ContextualEntry, "republic"),
    );
    let c = select(
        &mut set,
        &w,
        pick(SelectionKind::ContextualEntry, "academy"),
    );
    let d = select(&mut set, &w, pick(SelectionKind::Reference, "scholar"));
    for (id, requires) in [(&a, &b), (&b, &a), (&c, &a)] {
        set.selections
            .iter_mut()
            .find(|s| &s.id == id)
            .unwrap()
            .requires = vec![requires.clone()];
        // Requirements are part of what was selected: check, then select again.
        set.reselect(id, &w.basis()).unwrap();
    }
    let resolution = resolve(&set, &w.basis());
    let why = |id: &str| resolution.withheld.iter().find(|w| w.id == id).unwrap().why;
    assert_eq!(why(&a), Why::Cycle);
    assert_eq!(why(&b), Why::Cycle);
    assert_eq!(why(&c), Why::DependencyWithheld);
    assert_eq!(resolution.curation.items.len(), 1);
    assert_eq!(resolution.curation.items[0].id, d);

    // A requirement that is not a selection is a missing dependency.
    set.selections
        .iter_mut()
        .find(|s| s.id == d)
        .unwrap()
        .requires = vec!["nope".into()];
    set.reselect(&d, &w.basis()).unwrap();
    let resolution = resolve(&set, &w.basis());
    assert!(resolution
        .withheld
        .iter()
        .any(|w| w.id == d && w.why == Why::DependencyMissing));
}

#[test]
fn restricted_wording_is_never_shown_and_a_selection_can_opt_out_of_wording() {
    let w = world();
    let mut with = SelectionSet::default();
    select(
        &mut with,
        &w,
        NewSelection {
            optional_fields: vec!["wording".into()],
            ..pick(SelectionKind::Comparison, "cave")
        },
    );
    let resolution = resolve(&with, &w.basis());
    let text = serde_json::to_string(&resolution.curation).unwrap();
    assert!(
        text.contains("Compare our nature to this."),
        "the permitted version shows"
    );
    assert!(!text.contains(PRIVATE), "the reserved version never shows");
    assert!(resolution
        .notices
        .iter()
        .any(|n| n.code == NoticeCode::RightsRestricted
            && n.field.as_deref().is_some_and(|f| f.contains("places"))));

    let mut without = SelectionSet::default();
    select(&mut without, &w, pick(SelectionKind::Comparison, "cave"));
    let text = serde_json::to_string(&resolve(&without, &w.basis()).curation).unwrap();
    assert!(
        !text.contains("Compare our nature"),
        "no wording unless selected"
    );
    assert!(text.contains("correspondence") && text.contains("recordedBy"));
}

#[test]
fn provenance_is_recorded_when_stated_and_never_invented() {
    let w = world();
    let mut set = SelectionSet::default();
    select(&mut set, &w, pick(SelectionKind::Reference, "scholar"));
    select(
        &mut set,
        &w,
        NewSelection {
            provenance: Provenance::Imported {
                from: "CSL JSON import".into(),
            },
            ..pick(SelectionKind::Reference, "burnet")
        },
    );
    // A source with no title: the selected field is listed missing, not filled.
    select(
        &mut set,
        &w,
        NewSelection {
            optional_fields: vec!["issued".into()],
            ..pick(SelectionKind::Reference, "undated")
        },
    );
    let resolution = resolve(&set, &w.basis());
    let item = |target: &str| {
        resolution
            .curation
            .items
            .iter()
            .find(|i| i.target == target)
            .unwrap()
    };
    assert_eq!(item("scholar").provenance, Provenance::Unrecorded);
    assert_eq!(
        item("burnet").provenance,
        Provenance::Imported {
            from: "CSL JSON import".into()
        }
    );
    let bare = item("undated");
    assert!(!bare.content.contains_key("creators") && !bare.content.contains_key("issued"));
    assert_eq!(bare.missing, vec!["creators", "issued"]);
    assert!(resolution
        .notices
        .iter()
        .any(|n| n.id == item("scholar").id && n.code == NoticeCode::ProvenanceUnrecorded));
    assert!(!resolution
        .notices
        .iter()
        .any(|n| n.id == item("burnet").id && n.code == NoticeCode::ProvenanceUnrecorded));
}

#[test]
fn unsafe_addresses_and_private_identifiers_stay_out_of_a_reference() {
    let w = world();
    let mut set = SelectionSet::default();
    select(
        &mut set,
        &w,
        NewSelection {
            optional_fields: vec!["identifiers".into()],
            ..pick(SelectionKind::Reference, "republic")
        },
    );
    let resolution = resolve(&set, &w.basis());
    let text = serde_json::to_string(&resolution.curation).unwrap();
    assert!(text.contains("10.1000/republic"));
    assert!(!text.contains("localhost") && !text.contains(PRIVATE));
    let codes: Vec<NoticeCode> = resolution.notices.iter().map(|n| n.code).collect();
    assert!(
        codes.contains(&NoticeCode::UnsafeUrl) && codes.contains(&NoticeCode::PrivateIdentifier)
    );
    assert!(resolution
        .notices
        .iter()
        .all(|n| !n.message.contains(PRIVATE)));
}

#[test]
fn annotations_and_explanations_are_attributed_approved_text_only() {
    let w = world();
    let mut set = SelectionSet::default();
    let hostile = "<script>alert(1)</script> & </blockquote>";
    let annotation = select(
        &mut set,
        &w,
        NewSelection {
            text: Some(hostile.into()),
            by: Some("Site Author".into()),
            locator: Some("514a".into()),
            ..pick(SelectionKind::SourceAnnotation, "burnet")
        },
    );
    select(
        &mut set,
        &w,
        NewSelection {
            text: Some("Plato founded the Academy.".into()),
            by: Some("Site Author".into()),
            ..pick(SelectionKind::Explanation, "plato")
        },
    );
    let resolution = resolve(&set, &w.basis());
    let item = resolution
        .curation
        .items
        .iter()
        .find(|i| i.id == annotation)
        .unwrap();
    // The text is data, kept verbatim for the renderers to escape; nothing
    // of the private notebook came with it.
    assert_eq!(item.content["text"], json!(hostile));
    assert_eq!(item.content["by"], json!("Site Author"));
    let text = serde_json::to_string(&resolution.curation).unwrap();
    assert!(!text.contains(PRIVATE) && !text.contains("p-burnet"));
    // The annotated source and entry travel as context.
    assert!(resolution.curation.context.iter().any(|c| c.id == "burnet"));
    assert!(resolution.curation.context.iter().any(|c| c.id == "plato"));

    // Unattributed, empty, overlong and direction-override text is refused.
    for (text, by, code) in [
        (Some("ok"), None, Code::AttributionRequired),
        (None, Some("me"), Code::TextRequired),
        (Some("x\u{202e}y"), Some("me"), Code::UnsafeText),
        (Some("a\u{0007}b"), Some("me"), Code::UnsafeText),
    ] {
        let problems = set
            .select(
                NewSelection {
                    id: Some("bad".into()),
                    text: text.map(Into::into),
                    by: by.map(Into::into),
                    ..pick(SelectionKind::SourceAnnotation, "scholar")
                },
                &w.basis(),
            )
            .unwrap_err();
        assert!(
            problems.iter().any(|p| p.code == code),
            "{code:?}: {problems:?}"
        );
    }
    let long = "w".repeat(openblog_core::curated_selection::MAX_TEXT_CHARS + 1);
    let problems = set
        .select(
            NewSelection {
                id: Some("long".into()),
                text: Some(long),
                by: Some("me".into()),
                ..pick(SelectionKind::Explanation, "plato")
            },
            &w.basis(),
        )
        .unwrap_err();
    assert!(problems
        .iter()
        .any(|p| p.code == Code::TextTooLong || p.code == Code::UnsafeText));
}

#[test]
fn a_selected_dating_names_competing_datings_it_leaves_out() {
    let w = world();
    let mut set = SelectionSet::default();
    let a = select(&mut set, &w, pick(SelectionKind::Timeline, "plato-birth-a"));
    let resolution = resolve(&set, &w.basis());
    let notice = resolution
        .notices
        .iter()
        .find(|n| n.code == NoticeCode::CompetingUnselected)
        .expect("a competing dating is named");
    assert_eq!(
        (notice.id.as_str(), notice.message.contains("plato-birth-b")),
        (a.as_str(), true)
    );
    let item = &resolution.curation.items[0];
    assert!(item.content.contains_key("assertedBy") && item.content.contains_key("evidence"));
    select(&mut set, &w, pick(SelectionKind::Timeline, "plato-birth-b"));
    let resolution = resolve(&set, &w.basis());
    assert!(!resolution
        .notices
        .iter()
        .any(|n| n.code == NoticeCode::CompetingUnselected));
}

#[test]
fn withdrawing_keeps_the_record_and_unselecting_changes_no_research() {
    let w = world();
    let mut set = SelectionSet::default();
    let id = select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
    assert!(set.withdraw(&id, Some("rethinking".into())));
    let resolution = resolve(&set, &w.basis());
    assert!(resolution.curation.items.is_empty());
    assert_eq!(resolution.withheld[0].why, Why::Withdrawn);
    set.reselect(&id, &w.basis()).unwrap();
    assert_eq!(resolve(&set, &w.basis()).curation.items.len(), 1);
    assert!(set.unselect(&id) && !set.unselect(&id));
    // The private canonical objects are untouched.
    assert!(w.atlas.entry("plato").is_some());
    assert!(set
        .select(pick(SelectionKind::ContextualEntry, "plato"), &w.basis())
        .is_ok());
    let again = set.select(pick(SelectionKind::ContextualEntry, "plato"), &w.basis());
    assert_eq!(again.unwrap_err()[0].code, Code::DuplicateId);
}

#[test]
fn the_file_round_trips_deterministically_and_rejects_hostile_records() {
    let w = world();
    let mut set = SelectionSet::default();
    select(&mut set, &w, pick(SelectionKind::Relationship, "r-member"));
    select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
    let text = set.to_json();
    assert!(!text.contains('\r') && text.ends_with('\n'));
    let parsed = SelectionSet::parse(&text).unwrap();
    assert_eq!(parsed, set);
    assert_eq!(parsed.to_json(), text);
    let one = serde_json::to_string(&resolve(&parsed, &w.basis()).curation).unwrap();
    let two = serde_json::to_string(&resolve(&set, &w.basis()).curation).unwrap();
    assert_eq!(one, two);

    // Unknown fields are kept in the file and never published.
    let mut value: Value = serde_json::from_str(&text).unwrap();
    value["selections"][0]["workspace"] = json!(format!("{PRIVATE} extra"));
    value["futureKey"] = json!(1);
    let kept = SelectionSet::parse(&value.to_string()).unwrap();
    assert!(kept.to_json().contains("futureKey"));
    assert!(!serde_json::to_string(&resolve(&kept, &w.basis()).curation)
        .unwrap()
        .contains(PRIVATE));

    // Migration: a later version is refused, naming the version only.
    let mut later = value.clone();
    later["version"] = json!(2);
    assert_eq!(
        SelectionSet::parse(&later.to_string()).unwrap_err()[0].code,
        Code::UnsupportedVersion
    );
    assert_eq!(
        SelectionSet::parse("{ not json").unwrap_err()[0].code,
        Code::InvalidJson
    );

    // Hostile records.
    let mut bad: Value = serde_json::from_str(&text).unwrap();
    bad["selections"][0]["id"] = json!("../etc/passwd");
    bad["selections"][1]["target"] = json!("a b<script>");
    bad["selections"][1]["revision"] = json!("nope");
    bad["selections"][1]["fields"] = json!(["label", "visibility"]);
    let problems = SelectionSet::parse(&bad.to_string()).unwrap_err();
    let codes: Vec<Code> = problems.iter().map(|p| p.code).collect();
    for code in [
        Code::BadId,
        Code::BadTarget,
        Code::BadRevision,
        Code::FieldNotAllowed,
    ] {
        assert!(codes.contains(&code), "{code:?}");
    }
    let mut duplicate: Value = serde_json::from_str(&text).unwrap();
    let first = duplicate["selections"][0].clone();
    duplicate["selections"].as_array_mut().unwrap().push(first);
    assert!(SelectionSet::parse(&duplicate.to_string())
        .unwrap_err()
        .iter()
        .any(|p| p.code == Code::DuplicateId));
}

#[test]
fn the_boundary_manifest_gains_one_projection_only_when_curating() {
    let w = world();
    let mut set = SelectionSet::default();
    let live = select(
        &mut set,
        &w,
        pick(SelectionKind::Relationship, "r-authored"),
    );
    let stale = select(
        &mut set,
        &w,
        pick(SelectionKind::ContextualEntry, "academy"),
    );
    let withdrawn = select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
    set.withdraw(&withdrawn, None);
    set.selections
        .iter_mut()
        .find(|s| s.id == stale)
        .unwrap()
        .revision = "0".repeat(16);
    let resolution = resolve(&set, &w.basis());
    let curation = CurationInput {
        set: &set,
        resolution: &resolution,
    };
    let inputs = |on: bool| BoundaryInputs {
        switches: Switches {
            curated: on,
            ..Switches::default()
        },
        posts: &[],
        public_atlas: Some(&w.public_atlas),
        atlas_blocked: None,
        public_comparisons: Some(&w.comparisons),
        comparisons_blocked: None,
        public_paths: None,
        public_interpretations: None,
        claims_blocked: None,
        library: Some(&w.library),
        notebook: None,
        atlas: Some(&w.atlas),
        claims: None,
        alignments: None,
        stale_comparisons: None,
        acknowledgements: None,
        curation: None,
        unavailable: &[],
        author: "",
        base_path: "",
    };
    // Off, nothing selected: the manifest is what it always was.
    let legacy = BoundaryManifest::site(&inputs(false));
    assert!(legacy
        .projections
        .iter()
        .all(|p| p.projection != Projection::Curated));
    assert!(legacy
        .never
        .iter()
        .all(|n| n.file != openblog_core::curated_selection::SELECTIONS_FILE));

    let mut on = inputs(true);
    on.curation = Some(&curation);
    let manifest = BoundaryManifest::site(&on);
    let report = manifest
        .projections
        .iter()
        .find(|p| p.projection == Projection::Curated)
        .expect("the curated projection");
    assert!(report.enabled);
    let published: Vec<&str> = report
        .published
        .iter()
        .filter(|i| i.kind == ItemKind::Selection)
        .map(|i| i.id.as_str())
        .collect();
    assert_eq!(published, vec![live.as_str()]);
    let reasons: BTreeMap<&str, Reason> = report
        .withheld
        .iter()
        .map(|i| (i.id.as_str(), i.reason))
        .collect();
    assert_eq!(reasons[stale.as_str()], Reason::StaleSelection);
    assert_eq!(reasons[withdrawn.as_str()], Reason::Withdrawn);
    assert!(manifest.build_warnings().iter().any(|w| w.contains(&stale)));
    // The curated report names ids; never private labels or text.
    assert!(!serde_json::to_string(report).unwrap().contains(PRIVATE));

    // The switch off: whatever the file holds, the manifest does not mention it.
    let mut off = inputs(false);
    off.curation = Some(&curation);
    let manifest = BoundaryManifest::site(&off);
    assert!(manifest
        .projections
        .iter()
        .all(|p| p.projection != Projection::Curated));
    assert!(manifest
        .never
        .iter()
        .all(|n| n.file != openblog_core::curated_selection::SELECTIONS_FILE));
}

#[test]
fn selection_ids_in_diagnostics_never_carry_private_text() {
    let w = world();
    let mut set = SelectionSet::default();
    let sel: Selection = {
        select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
        set.selections[0].clone()
    };
    let mut atlas = atlas_value();
    atlas["entries"][0]["summary"] = json!(format!("{PRIVATE} edited"));
    let changed = world_with(&library_value(), &atlas);
    let resolution = resolve(&set, &changed.basis());
    assert_eq!(resolution.withheld[0].why, Why::Stale);
    assert!(!resolution.withheld[0].message.contains(PRIVATE));
    assert!(resolution.withheld[0].message.contains(&sel.id));
}

// ---------------------------------------------------------------- review fixes (#192)

fn mutate<'a>(set: &'a mut SelectionSet, id: &str) -> &'a mut Selection {
    set.selections.iter_mut().find(|s| s.id == id).unwrap()
}

fn why_of(resolution: &openblog_core::curated_selection::Resolution, id: &str) -> Why {
    resolution
        .withheld
        .iter()
        .find(|w| w.id == id)
        .unwrap_or_else(|| panic!("{id} is not withheld"))
        .why
}

#[test]
fn a_reference_or_annotation_may_select_only_a_source_that_is_already_public() {
    let w = world();
    assert!(!w.public_sources.contains("diary"));
    let mut set = SelectionSet::default();
    for (kind, text) in [
        (SelectionKind::Reference, None),
        (SelectionKind::SourceAnnotation, Some("A comment.")),
    ] {
        let problems = set
            .select(
                NewSelection {
                    text: text.map(Into::into),
                    by: text.map(|_| "The author".into()),
                    ..pick(kind, "diary")
                },
                &w.basis(),
            )
            .unwrap_err();
        assert_eq!(problems[0].code, Code::TargetNotPublished, "{kind:?}");
        assert!(problems[0].message.contains("stays private"));
        assert!(!problems[0].message.contains(PRIVATE));
    }
    assert!(set.selections.is_empty());
    // Public through any of the three routes it is selectable.
    for target in ["scholar", "grube", "undated"] {
        assert!(w.public_sources.contains(target), "{target}");
        set.select(pick(SelectionKind::Reference, target), &w.basis())
            .unwrap();
    }

    // A source that stops being public withholds the selection, naming the
    // rule, and nothing is published of it.
    let mut stored = set.clone();
    let mut later = w.public_sources.clone();
    later.remove("undated");
    let basis = openblog_core::curated_selection::Basis {
        public_sources: Some(&later),
        ..w.basis()
    };
    let resolution = resolve(&stored, &basis);
    let id = stored
        .selections
        .iter()
        .find(|s| s.target == "undated")
        .unwrap()
        .id
        .clone();
    assert_eq!(why_of(&resolution, &id), Why::SourcePrivate);
    assert!(resolution
        .curation
        .items
        .iter()
        .all(|i| i.target != "undated"));
    // With no known public sources nothing of a library is selectable.
    let nothing = openblog_core::curated_selection::Basis {
        public_sources: None,
        ..w.basis()
    };
    assert!(stored
        .select(pick(SelectionKind::Reference, "burnet"), &nothing)
        .is_err());
}

#[test]
fn caveats_that_are_not_withheld_fields_travel_with_the_published_item() {
    let w = world();
    let mut set = SelectionSet::default();
    let dating = select(&mut set, &w, pick(SelectionKind::Timeline, "plato-birth-a"));
    let reference = select(
        &mut set,
        &w,
        NewSelection {
            optional_fields: vec!["issued".into()],
            ..pick(SelectionKind::Reference, "undated")
        },
    );
    let resolution = resolve(&set, &w.basis());
    let item = |id: &str| {
        resolution
            .curation
            .items
            .iter()
            .find(|i| i.id == id)
            .unwrap()
    };
    let codes = |id: &str| -> Vec<NoticeCode> { item(id).notices.iter().map(|n| n.code).collect() };
    assert_eq!(codes(&dating), vec![NoticeCode::CompetingUnselected]);
    assert!(item(&dating).notices[0].message.contains("plato-birth-b"));
    assert!(codes(&reference).contains(&NoticeCode::MissingDetail));
    assert!(codes(&reference).contains(&NoticeCode::ProvenanceUnrecorded));
    // The withheld-field notices are not repeated on the item.
    let mut with_identifiers = SelectionSet::default();
    select(
        &mut with_identifiers,
        &w,
        NewSelection {
            optional_fields: vec!["identifiers".into()],
            ..pick(SelectionKind::Reference, "republic")
        },
    );
    let resolution = resolve(&with_identifiers, &w.basis());
    assert!(resolution.curation.items[0]
        .notices
        .iter()
        .all(|n| n.code.travels_with_item()));
    assert!(!serde_json::to_string(&resolution.curation.items)
        .unwrap()
        .contains("localhost"));
}

#[test]
fn the_manifest_lists_the_caveats_and_a_competing_dating_is_a_boundary_warning() {
    let w = world();
    let mut set = SelectionSet::default();
    select(&mut set, &w, pick(SelectionKind::Timeline, "plato-birth-a"));
    let resolution = resolve(&set, &w.basis());
    let curation = CurationInput {
        set: &set,
        resolution: &resolution,
    };
    let inputs = BoundaryInputs {
        switches: Switches {
            curated: true,
            ..Switches::default()
        },
        posts: &[],
        public_atlas: Some(&w.public_atlas),
        atlas_blocked: None,
        public_comparisons: Some(&w.comparisons),
        comparisons_blocked: None,
        public_paths: None,
        public_interpretations: None,
        claims_blocked: None,
        library: Some(&w.library),
        notebook: None,
        atlas: Some(&w.atlas),
        claims: None,
        alignments: None,
        stale_comparisons: None,
        acknowledgements: None,
        curation: Some(&curation),
        unavailable: &[],
        author: "",
        base_path: "",
    };
    let manifest = BoundaryManifest::site(&inputs);
    let report = manifest
        .projections
        .iter()
        .find(|p| p.projection == Projection::Curated)
        .unwrap();
    let item = report
        .published
        .iter()
        .find(|i| i.kind == ItemKind::Selection)
        .unwrap();
    assert_eq!(item.notices.len(), 1);
    let json = serde_json::to_value(item).unwrap();
    assert_eq!(json["notices"][0]["code"], json!("competing-unselected"));
    assert!(manifest
        .build_warnings()
        .iter()
        .any(|w| w.starts_with("boundary: ") && w.contains("plato-birth-b")));
    // The switch off: no curated projection and no mention of the file.
    let off = BoundaryManifest::site(&BoundaryInputs {
        switches: Switches::default(),
        ..inputs
    });
    assert!(off
        .projections
        .iter()
        .all(|p| p.projection != Projection::Curated));
    assert!(off
        .never
        .iter()
        .all(|n| n.file != openblog_core::curated_selection::SELECTIONS_FILE));
}

#[test]
fn a_selection_is_for_the_site_or_for_named_published_posts_in_the_author_s_order() {
    let at = |pairs: &[(&str, u32)]| -> BTreeMap<String, u32> {
        pairs.iter().map(|(p, n)| (p.to_string(), *n)).collect()
    };
    let w = world();
    let mut set = SelectionSet::default();
    let site_wide = select(
        &mut set,
        &w,
        pick(SelectionKind::ContextualEntry, "academy"),
    );
    let third = select(
        &mut set,
        &w,
        NewSelection {
            posts: Some(vec!["cave".into()]),
            positions: at(&[("cave", 3)]),
            ..pick(SelectionKind::ContextualEntry, "plato")
        },
    );
    let first = select(
        &mut set,
        &w,
        NewSelection {
            posts: Some(vec!["cave".into(), "other".into()]),
            positions: at(&[("cave", 1), ("other", 2)]),
            ..pick(SelectionKind::Reference, "scholar")
        },
    );
    let unplaced = select(
        &mut set,
        &w,
        NewSelection {
            posts: Some(vec!["cave".into()]),
            ..pick(SelectionKind::ContextualEntry, "republic")
        },
    );
    let elsewhere = select(
        &mut set,
        &w,
        NewSelection {
            posts: Some(vec!["other".into()]),
            positions: at(&[("other", 1)]),
            ..pick(SelectionKind::Reference, "undated")
        },
    );
    let resolution = resolve(&set, &w.basis());
    // Whole-site items first, then by (first post, position, id).
    let order: Vec<&str> = resolution
        .curation
        .items
        .iter()
        .map(|i| i.id.as_str())
        .collect();
    assert_eq!(
        order,
        vec![
            site_wide.as_str(),
            first.as_str(),
            third.as_str(),
            unplaced.as_str(),
            elsewhere.as_str()
        ]
    );
    let ids = |post: &str| -> Vec<&str> {
        resolution
            .curation
            .for_post(post)
            .iter()
            .map(|i| i.id.as_str())
            .collect()
    };
    // A post gets the whole-site items and its own, by position then id; an
    // unpositioned item is last.
    assert_eq!(
        ids("cave"),
        vec![
            first.as_str(),
            third.as_str(),
            site_wide.as_str(),
            unplaced.as_str()
        ]
    );
    // A shared item has a place per post: it is second for "other".
    assert_eq!(
        ids("other"),
        vec![elsewhere.as_str(), first.as_str(), site_wide.as_str()]
    );
    assert_eq!(ids("none").len(), 1, "only the whole-site item");
    // Deterministic whatever the order of the file.
    let mut shuffled = set.clone();
    shuffled.selections.reverse();
    assert_eq!(
        serde_json::to_string(&resolve(&shuffled, &w.basis()).curation).unwrap(),
        serde_json::to_string(&resolution.curation).unwrap()
    );
}

#[test]
fn a_record_without_posts_or_positions_is_site_wide_and_written_unchanged() {
    let w = world();
    let mut set = SelectionSet::default();
    select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
    let text = set.to_json();
    assert!(
        !text.contains("posts") && !text.contains("position"),
        "{text}"
    );
    let parsed = SelectionSet::parse(&text).unwrap();
    assert_eq!(parsed.selections[0].posts, None);
    assert_eq!(parsed.to_json(), text, "byte for byte");
    let resolution = resolve(&parsed, &w.basis());
    let item = &resolution.curation.items[0];
    assert!(item.posts.is_empty() && item.positions.is_empty());
    let json = serde_json::to_value(item).unwrap();
    assert!(json.get("posts").is_none() && json.get("positions").is_none());
    assert_eq!(resolution.curation.for_post("any-post").len(), 1);
}

#[test]
fn a_selection_never_names_a_post_the_build_does_not_publish() {
    let w = world();
    let mut set = SelectionSet::default();
    let id = select(
        &mut set,
        &w,
        NewSelection {
            posts: Some(vec!["cave".into(), "secret-draft".into()]),
            ..pick(SelectionKind::ContextualEntry, "plato")
        },
    );
    let resolution = resolve(&set, &w.basis());
    assert_eq!(resolution.curation.items[0].posts, vec!["cave"]);
    assert!(!serde_json::to_string(&resolution.curation)
        .unwrap()
        .contains("secret-draft"));
    // When none of its posts is published it publishes nothing at all.
    let mut drafts = BTreeSet::new();
    drafts.insert("another".to_string());
    let basis = openblog_core::curated_selection::Basis {
        posts: Some(&drafts),
        ..w.basis()
    };
    let resolution = resolve(&set, &basis);
    assert!(resolution.curation.items.is_empty());
    assert_eq!(why_of(&resolution, &id), Why::PostNotPublished);
    assert!(!resolution.withheld[0].message.contains("secret-draft"));
    // And with no known published post, a scoped selection waits.
    let none = openblog_core::curated_selection::Basis {
        posts: None,
        ..w.basis()
    };
    assert!(resolve(&set, &none).curation.items.is_empty());

    for bad in [
        vec![],
        vec!["a".to_string(), "a".to_string()],
        vec!["../x".to_string()],
    ] {
        let problems = SelectionSet::default()
            .select(
                NewSelection {
                    posts: Some(bad),
                    ..pick(SelectionKind::ContextualEntry, "plato")
                },
                &w.basis(),
            )
            .unwrap_err();
        assert_eq!(problems[0].code, Code::BadPosts);
    }
}

#[test]
fn the_revision_covers_every_choice_the_author_made() {
    let w = world();
    let mut set = SelectionSet::default();
    let id = select(
        &mut set,
        &w,
        NewSelection {
            optional_fields: vec!["summary".into()],
            ..pick(SelectionKind::ContextualEntry, "plato")
        },
    );
    let other = select(
        &mut set,
        &w,
        pick(SelectionKind::ContextualEntry, "academy"),
    );
    assert!(resolve(&set, &w.basis()).withheld.is_empty());
    type Edit = Box<dyn Fn(&mut Selection)>;
    let edits: Vec<(&str, Edit)> = vec![
        ("fields", Box::new(|s| s.fields.retain(|f| f != "summary"))),
        (
            "provenance",
            Box::new(|s| s.provenance = Provenance::Authored),
        ),
        ("requires", Box::new(|s| s.requires = vec!["other".into()])),
        ("posts", Box::new(|s| s.posts = Some(vec!["cave".into()]))),
    ];
    for (name, edit) in edits {
        let mut changed = set.clone();
        edit(mutate(&mut changed, &id));
        let resolution = resolve(&changed, &w.basis());
        assert_eq!(why_of(&resolution, &id), Why::Stale, "{name}");
    }
    // The pairs are explicit and length-prefixed: moving a character between
    // two chosen values changes the revision.
    let mut a = set.clone();
    mutate(&mut a, &other).requires = vec![id.clone()];
    a.reselect(&other, &w.basis()).unwrap();
    let mut b = set.clone();
    mutate(&mut b, &other).posts = Some(vec![id.clone()]);
    b.reselect(&other, &w.basis()).unwrap();
    assert_ne!(
        a.get(&other).unwrap().revision,
        b.get(&other).unwrap().revision
    );
}

#[test]
fn an_unlisted_locator_is_dropped_and_a_listed_one_is_published_and_revision_checked() {
    let w = world();
    let mut set = SelectionSet::default();
    let plain = select(
        &mut set,
        &w,
        NewSelection {
            text: Some("A comment.".into()),
            by: Some("The author".into()),
            locator: Some("514a".into()),
            ..pick(SelectionKind::SourceAnnotation, "burnet")
        },
    );
    let with = select(
        &mut set,
        &w,
        NewSelection {
            id: Some("annotation-located".into()),
            optional_fields: vec!["locator".into()],
            text: Some("A comment.".into()),
            by: Some("The author".into()),
            locator: Some("514a".into()),
            ..pick(SelectionKind::SourceAnnotation, "burnet")
        },
    );
    let resolution = resolve(&set, &w.basis());
    let content = |id: &str| {
        &resolution
            .curation
            .items
            .iter()
            .find(|i| i.id == id)
            .unwrap()
            .content
    };
    assert!(!content(&plain).contains_key("locator"));
    assert_eq!(content(&with)["locator"], json!("514a"));
    // An unlisted locator is not part of the revision; a listed one is.
    mutate(&mut set, &plain).locator = Some("515b".into());
    mutate(&mut set, &with).locator = Some("515b".into());
    let resolution = resolve(&set, &w.basis());
    assert!(resolution.withheld.iter().all(|h| h.id != plain));
    assert_eq!(why_of(&resolution, &with), Why::Stale);
}

#[test]
fn a_relationship_owned_dating_names_a_relationship_not_an_entry() {
    let mut atlas = atlas_value();
    atlas["relationships"][1]["dates"] = json!([dating("member-span", "span", -387, "scholar")]);
    let w = world_with(&library_value(), &atlas);
    let mut set = SelectionSet::default();
    let id = select(&mut set, &w, pick(SelectionKind::Timeline, "member-span"));
    let resolution = resolve(&set, &w.basis());
    let kinds: Vec<(ContextKind, &str)> = resolution
        .curation
        .context
        .iter()
        .map(|c| (c.kind, c.id.as_str()))
        .collect();
    assert!(
        kinds.contains(&(ContextKind::Relationship, "r-member")),
        "{kinds:?}"
    );
    assert!(kinds.contains(&(ContextKind::Entry, "plato")));
    // Taking the relationship away says "relationship", not "entry".
    let mut hidden = atlas.clone();
    hidden["relationships"][1]["visibility"] = json!("private");
    let h = world_with(&library_value(), &hidden);
    let resolution = resolve(&set, &h.basis());
    assert!(resolution.curation.items.is_empty());
    let message = &resolution
        .withheld
        .iter()
        .find(|w| w.id == id)
        .unwrap()
        .message;
    assert!(!message.contains("entry `r-member`"), "{message}");
}

#[test]
fn a_store_that_was_not_read_is_not_published_never_missing() {
    let w = world();
    let mut set = SelectionSet::default();
    for (kind, target) in [
        (SelectionKind::ContextualEntry, "plato"),
        (SelectionKind::Relationship, "r-authored"),
        (SelectionKind::Timeline, "plato-birth-a"),
        (SelectionKind::Comparison, "cave"),
        (SelectionKind::Reference, "scholar"),
    ] {
        select(&mut set, &w, pick(kind, target));
    }
    // Nothing was read: not the atlas, not the alignments, not the library.
    let none = Existing::of(None, None);
    let basis = openblog_core::curated_selection::Basis {
        existing: Some(&none),
        ..Basis::default()
    };
    let resolution = resolve(&set, &basis);
    assert_eq!(resolution.withheld.len(), 5);
    assert!(
        resolution
            .withheld
            .iter()
            .all(|h| h.why == Why::NotPublished),
        "{:?}",
        resolution.withheld
    );
    // One store read and another not: each is told on its own.
    let atlas_only = Existing::of(Some(&w.atlas), None);
    let basis = openblog_core::curated_selection::Basis {
        existing: Some(&atlas_only),
        library: Some(&w.library),
        ..Basis::default()
    };
    let resolution = resolve(&set, &basis);
    let why = |target: &str| {
        resolution
            .withheld
            .iter()
            .find(|h| h.target == target)
            .unwrap()
            .why
    };
    assert_eq!(why("plato"), Why::NotApproved, "read, and exists");
    assert_eq!(why("cave"), Why::NotPublished, "alignments not read");
    // Deleted from a store that was read is missing.
    let mut gone = atlas_value();
    gone["entries"].as_array_mut().unwrap().remove(0);
    gone["relationships"] = json!([]);
    let g = world_with(&library_value(), &gone);
    let existing = Existing::of(Some(&g.atlas), None);
    let basis = openblog_core::curated_selection::Basis {
        existing: Some(&existing),
        ..Basis::default()
    };
    let resolution = resolve(&set, &basis);
    assert_eq!(
        resolution
            .withheld
            .iter()
            .find(|h| h.target == "plato")
            .unwrap()
            .why,
        Why::TargetMissing
    );
}

#[test]
fn derived_ids_never_collide_and_stay_slugs() {
    // Two long source ids that differ only at the end: the readable form is
    // cut at the id limit, so only the appended hash tells them apart.
    let (long_a, long_b) = (
        format!("{}a", "q".repeat(63)),
        format!("{}b", "q".repeat(63)),
    );
    let mut library = library_value();
    library["sources"].as_array_mut().unwrap().extend([
        json!({"id": long_a, "kind": "work", "title": "One"}),
        json!({"id": long_b, "kind": "work", "title": "Two"}),
    ]);
    let w = world_with(&library, &atlas_value());
    let mut public = w.public_sources.clone();
    public.extend([long_a.clone(), long_b.clone()]);
    let basis = openblog_core::curated_selection::Basis {
        public_sources: Some(&public),
        ..w.basis()
    };
    let mut set = SelectionSet::default();
    let one = set
        .select(pick(SelectionKind::Reference, &long_a), &basis)
        .unwrap();
    let two = set
        .select(pick(SelectionKind::Reference, &long_b), &basis)
        .unwrap();
    assert_ne!(one, two, "the same readable form, different ids");
    // Deterministic, and the same kind of id for a short target.
    let again = SelectionSet::default()
        .select(pick(SelectionKind::Reference, &long_a), &basis)
        .unwrap();
    assert_eq!(one, again);
    let short = set
        .select(pick(SelectionKind::Reference, "scholar"), &basis)
        .unwrap();
    assert!(short.starts_with("reference-scholar-"), "{short}");
    for id in [&one, &two, &short] {
        assert!(
            id.len() <= 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !id.starts_with('-')
                && !id.contains("--"),
            "{id}"
        );
    }
    SelectionSet::parse(&set.to_json()).unwrap();
}

#[test]
fn contributor_credits_stay_in_sidecars_in_every_store_including_this_one() {
    let w = world();
    let mut set = SelectionSet::default();
    select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
    for key in ["credit", "credits", "contributor", "contributors"] {
        let mut record: Value = serde_json::from_str(&set.to_json()).unwrap();
        record["selections"][0][key] = json!([{"name": format!("{PRIVATE} person")}]);
        let problems = SelectionSet::parse(&record.to_string()).unwrap_err();
        assert!(
            problems
                .iter()
                .any(|p| p.code == Code::ContributorCredit && p.field.as_deref() == Some(key)),
            "{key}: {problems:?}"
        );
        assert!(problems.iter().all(|p| !p.message.contains(PRIVATE)));
        let mut root: Value = serde_json::from_str(&set.to_json()).unwrap();
        root[key] = json!("someone");
        assert!(SelectionSet::parse(&root.to_string())
            .unwrap_err()
            .iter()
            .any(|p| p.code == Code::ContributorCredit));
    }
}

#[test]
fn requires_is_capped_and_a_hostile_file_resolves_in_linear_time() {
    use openblog_core::curated_selection::MAX_REQUIRES;
    let w = world();
    let mut record = SelectionSet::default();
    let id = select(
        &mut record,
        &w,
        pick(SelectionKind::ContextualEntry, "plato"),
    );
    mutate(&mut record, &id).requires = (0..=MAX_REQUIRES).map(|n| format!("r{n}")).collect();
    let problems = SelectionSet::parse(&record.to_json()).unwrap_err();
    assert!(problems.iter().any(|p| p.code == Code::BadRequires));

    // 5,000 current selections, each requiring the next 32 (the most the cap
    // allows).
    let count = openblog_core::curated_selection::MAX_SELECTIONS;
    let chain = |closed: bool| {
        let mut set = SelectionSet::default();
        let mut template = {
            let mut one = SelectionSet::default();
            select(&mut one, &w, pick(SelectionKind::ContextualEntry, "plato"));
            one.selections.remove(0)
        };
        for i in 0..count {
            template.id = format!("s{i}");
            template.requires = (1..=MAX_REQUIRES)
                .filter_map(|d| {
                    let next = i + d;
                    if next < count {
                        Some(next)
                    } else {
                        closed.then_some(next % count)
                    }
                })
                .filter(|next| *next != i)
                .map(|n| format!("s{n}"))
                .collect();
            // Requirements are part of what was selected: record the revision.
            let mut probe = SelectionSet::default();
            probe.selections.push(template.clone());
            probe.reselect(&template.id, &w.basis()).unwrap();
            template.revision = probe.selections[0].revision.clone();
            set.selections.push(template.clone());
        }
        set.selections.sort_by(|a, b| a.id.cmp(&b.id));
        SelectionSet::parse(&set.to_json()).unwrap()
    };
    let within = std::time::Duration::from_secs(5);

    // An open chain whose last selection is withdrawn: each of the others is
    // withheld in turn, however far back the chain goes.
    let mut open = chain(false);
    mutate(&mut open, &format!("s{}", count - 1)).state =
        openblog_core::curated_selection::SelectionState::Withdrawn;
    let started = std::time::Instant::now();
    let resolution = resolve(&open, &w.basis());
    assert!(started.elapsed() < within, "{:?}", started.elapsed());
    assert_eq!(resolution.withheld.len(), count);
    assert!(resolution.curation.items.is_empty());
    assert_eq!(
        resolution
            .withheld
            .iter()
            .filter(|h| h.why == Why::DependencyWithheld)
            .count(),
        count - 1
    );

    // The same chain closed into one component of 5,000 selections.
    let closed = chain(true);
    let started = std::time::Instant::now();
    let resolution = resolve(&closed, &w.basis());
    assert!(started.elapsed() < within, "{:?}", started.elapsed());
    assert_eq!(resolution.withheld.len(), count);
    assert!(resolution.withheld.iter().all(|h| h.why == Why::Cycle));
}

#[test]
fn cycles_are_exactly_the_components_of_more_than_one_selection_and_self_loops() {
    // Real revisions, so that nothing is withheld as stale first.
    let w = world();
    let mut set = SelectionSet::default();
    let ids: Vec<String> = ["plato", "republic", "academy"]
        .iter()
        .map(|t| select(&mut set, &w, pick(SelectionKind::ContextualEntry, t)))
        .collect();
    let (a, b, c) = (&ids[0], &ids[1], &ids[2]);
    // a -> b -> a is a cycle; c -> a only depends on it; a self-loop is
    // refused in the file but still a cycle if one were ever present.
    mutate(&mut set, a).requires = vec![b.clone()];
    mutate(&mut set, b).requires = vec![a.clone()];
    mutate(&mut set, c).requires = vec![a.clone()];
    for id in &ids {
        set.reselect(id, &w.basis()).unwrap();
    }
    let resolution = resolve(&set, &w.basis());
    assert_eq!(why_of(&resolution, a), Why::Cycle);
    assert_eq!(why_of(&resolution, b), Why::Cycle);
    assert_eq!(why_of(&resolution, c), Why::DependencyWithheld);

    let mut looped = SelectionSet::default();
    let s = select(
        &mut looped,
        &w,
        pick(SelectionKind::ContextualEntry, "plato"),
    );
    mutate(&mut looped, &s).requires = vec![s.clone()];
    looped.reselect(&s, &w.basis()).unwrap();
    assert_eq!(why_of(&resolve(&looped, &w.basis()), &s), Why::Cycle);
}

#[test]
fn an_ordering_is_not_refused_for_a_bound_reached_only_through_stale_posts() {
    use openblog_core::curated_selection::MAX_POSITIONS;
    let w = world();
    let mut set = SelectionSet::default();
    // A whole-site selection that once had a place among the items of the bound's worth of posts,
    // all of which have since been deleted.
    let stale: BTreeMap<String, u32> = (0..MAX_POSITIONS)
        .map(|n| (format!("deleted-{n:03}"), 1))
        .collect();
    let id = set
        .select(
            NewSelection {
                positions: stale,
                ..pick(SelectionKind::ContextualEntry, "plato")
            },
            &w.basis(),
        )
        .expect("selected");
    assert_eq!(set.get(&id).unwrap().positions.len(), MAX_POSITIONS);
    // Ordering it for a post that exists is not refused, and drops the places of posts that are gone.
    set.order_for_post("cave", std::slice::from_ref(&id), &w.basis())
        .expect("a stale entry never refuses an ordering");
    let kept = &set.get(&id).unwrap().positions;
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(kept.get("cave"), Some(&1));
}

#[test]
fn reordering_never_refreshes_a_stale_selection() {
    let w = world();
    let mut set = SelectionSet::default();
    let id = select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
    set.rescope(&id, Some(vec!["cave".into()]), &w.basis())
        .unwrap();
    set.order_for_post("cave", std::slice::from_ref(&id), &w.basis())
        .unwrap();
    let kept = set.get(&id).unwrap().clone();
    assert_eq!(
        (kept.posts.clone(), kept.positions.get("cave").copied()),
        (Some(vec!["cave".into()]), Some(1))
    );
    assert!(
        resolve(&set, &w.basis()).withheld.is_empty(),
        "revision followed the scope"
    );
    // The research changes: the selection is stale, and moving it is refused.
    let mut atlas = atlas_value();
    atlas["entries"][0]["summary"] = json!("A different summary.");
    let changed = world_with(&library_value(), &atlas);
    let before = set.clone();
    let problems = set
        .order_for_post("cave", std::slice::from_ref(&id), &changed.basis())
        .unwrap_err();
    assert_eq!(problems[0].code, Code::StaleSelection);
    assert_eq!(set, before, "nothing changed");
    assert_eq!(
        why_of(&resolve(&set, &changed.basis()), &id),
        Why::Stale,
        "still withheld"
    );
    // Selecting it again is the author's act of checking.
    set.reselect(&id, &changed.basis()).unwrap();
    set.rescope(&id, None, &changed.basis()).unwrap();
    assert_eq!(
        set.get(&id).unwrap().positions.get("cave").copied(),
        Some(1),
        "a whole-site selection keeps the place it had in a post"
    );
    assert!(
        set.rescope("nope", None, &changed.basis()).unwrap_err()[0].code == Code::UnknownSelection
    );
}

#[test]
fn a_selections_copy_is_recognised_as_private_research_by_structure() {
    let w = world();
    let mut set = SelectionSet::default();
    select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
    let root = |text: &str| -> serde_json::Map<String, Value> {
        serde_json::from_str::<Value>(text)
            .unwrap()
            .as_object()
            .unwrap()
            .clone()
    };
    assert!(openblog_core::curated_selection::looks_like_selections(
        &root(&set.to_json())
    ));
    assert!(openblog_core::research_bundle::looks_like_private_research(
        set.to_json().as_bytes()
    ));
    for harmless in [
        r#"{"version":1,"selections":[]}"#,
        r#"{"version":1,"selections":[{"id":"x","title":"a layout"}]}"#,
        r#"{"selections":[{"id":"a","kind":"b","target":"c","revision":"d"}]}"#,
        r#"{"version":1,"selections":"none"}"#,
    ] {
        assert!(
            !openblog_core::research_bundle::looks_like_private_research(harmless.as_bytes()),
            "{harmless}"
        );
    }
}

// ---------------------------------------------------------------- the author's view, shared with the Admin tests

fn fixture_path(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/curated-selections")
        .join(name)
}

fn check_fixture(name: &str, actual: &str) {
    let path = fixture_path(name);
    if std::env::var_os("OPENBLOG_UPDATE_FIXTURES").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, actual).unwrap();
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_default()
        .replace("\r\n", "\n");
    assert_eq!(
        expected, actual,
        "{name} is out of date; rerun with OPENBLOG_UPDATE_FIXTURES=1"
    );
}

/// One set that shows every state the author's view has to tell apart: a
/// published relationship with its context, an entry with a chosen field, a
/// dating whose rival is not selected, a reference with a missing detail and
/// no recorded origin, an annotation for another post, a stale selection, a
/// withdrawn one, and an unpositioned whole-site entry.
fn view_set(w: &World) -> SelectionSet {
    let mut set = SelectionSet::default();
    let place = |set: &mut SelectionSet, new: NewSelection, id: &str| {
        let id = id.to_string();
        set.select(
            NewSelection {
                id: Some(id.clone()),
                ..new
            },
            &w.basis(),
        )
        .unwrap();
        id
    };
    place(
        &mut set,
        NewSelection {
            posts: Some(vec!["cave".into()]),
            positions: BTreeMap::from([("cave".to_string(), 1)]),
            ..pick(SelectionKind::Relationship, "r-authored")
        },
        "relationship-authored",
    );
    place(
        &mut set,
        NewSelection {
            optional_fields: vec!["summary".into()],
            posts: Some(vec!["cave".into()]),
            positions: BTreeMap::from([("cave".to_string(), 2)]),
            ..pick(SelectionKind::ContextualEntry, "plato")
        },
        "entry-plato",
    );
    place(
        &mut set,
        NewSelection {
            posts: Some(vec!["cave".into()]),
            positions: BTreeMap::from([("cave".to_string(), 3)]),
            ..pick(SelectionKind::Timeline, "plato-birth-a")
        },
        "dating-birth-a",
    );
    place(
        &mut set,
        NewSelection {
            optional_fields: vec!["issued".into()],
            posts: Some(vec!["cave".into()]),
            ..pick(SelectionKind::Reference, "undated")
        },
        "reference-undated",
    );
    place(
        &mut set,
        NewSelection {
            text: Some("A comment for another post.".into()),
            by: Some("The author".into()),
            posts: Some(vec!["other".into()]),
            ..pick(SelectionKind::SourceAnnotation, "burnet")
        },
        "annotation-other",
    );
    place(
        &mut set,
        pick(SelectionKind::ContextualEntry, "academy"),
        "entry-academy",
    );
    let stale = place(
        &mut set,
        NewSelection {
            posts: Some(vec!["cave".into()]),
            ..pick(SelectionKind::ContextualEntry, "republic")
        },
        "entry-republic",
    );
    mutate(&mut set, &stale).revision = "0123456789abcdef".into();
    let withdrawn = place(
        &mut set,
        NewSelection {
            posts: Some(vec!["cave".into()]),
            ..pick(SelectionKind::Comparison, "cave")
        },
        "comparison-cave",
    );
    set.withdraw(&withdrawn, Some("rethinking the wording".into()));
    set
}

#[test]
fn the_authors_view_matches_the_shared_fixture_and_shows_only_public_items() {
    let w = world();
    let set = view_set(&w);
    let resolution = resolve(&set, &w.basis());
    let revision = "f".repeat(64);
    let view = openblog_core::curated_selection::curation_view(
        &set,
        &resolution,
        &w.basis(),
        Some("cave"),
        &revision,
        true,
        false,
    );
    let mut text = serde_json::to_string_pretty(&view).unwrap();
    text.push('\n');
    check_fixture("view.json", &text);
    assert!(!text.contains(PRIVATE), "nothing private reaches the view");
    // Readers of the post get the whole-site entry last (unpositioned) after
    // this post's positioned items, in the author's order.
    let order: Vec<&str> = view.preview.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(
        order,
        [
            "relationship-authored",
            "entry-plato",
            "dating-birth-a",
            "entry-academy",
            "reference-undated"
        ]
    );
    // The annotation for another post is listed, not previewed.
    let other = view
        .selections
        .iter()
        .find(|s| s.id == "annotation-other")
        .unwrap();
    assert!(!other.applies_to_post);
    assert!(!serde_json::to_string(&view.preview)
        .unwrap()
        .contains("another post"));
    // The preview is the public value, not a second rendering of it.
    let public = serde_json::to_value(resolution.curation.view_for(Some("cave"))).unwrap();
    assert_eq!(serde_json::to_value(&view.preview).unwrap(), public);
}

#[test]
fn ordering_one_post_never_reorders_another_even_for_a_shared_whole_site_item() {
    let w = world();
    let mut set = SelectionSet::default();
    let shared = select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
    let a = select(
        &mut set,
        &w,
        NewSelection {
            posts: Some(vec!["cave".into()]),
            ..pick(SelectionKind::ContextualEntry, "republic")
        },
    );
    let b = select(
        &mut set,
        &w,
        NewSelection {
            posts: Some(vec!["other".into()]),
            ..pick(SelectionKind::ContextualEntry, "academy")
        },
    );
    let ids = |set: &SelectionSet, post: &str| -> Vec<String> {
        resolve(set, &w.basis())
            .curation
            .for_post(post)
            .iter()
            .map(|i| i.id.clone())
            .collect()
    };
    // The author puts the shared item first for "cave".
    set.order_for_post("cave", &[shared.clone(), a.clone()], &w.basis())
        .unwrap();
    assert_eq!(ids(&set, "cave"), [shared.clone(), a.clone()]);
    // Then puts it last for "other".
    set.order_for_post("other", &[b.clone(), shared.clone()], &w.basis())
        .unwrap();
    assert_eq!(ids(&set, "other"), [b.clone(), shared.clone()]);
    assert_eq!(
        ids(&set, "cave"),
        [shared.clone(), a.clone()],
        "ordering `other` left `cave` as the author set it"
    );
    // Reversing `cave` does not move anything in `other`.
    set.order_for_post("cave", &[a.clone(), shared.clone()], &w.basis())
        .unwrap();
    assert_eq!(ids(&set, "cave"), [a.clone(), shared.clone()]);
    assert_eq!(ids(&set, "other"), [b.clone(), shared.clone()]);
    let item = set.get(&shared).unwrap();
    assert_eq!(item.positions.get("cave"), Some(&2));
    assert_eq!(item.positions.get("other"), Some(&2));
    // Order is not content: no selection became stale.
    assert!(resolve(&set, &w.basis()).withheld.is_empty());
}

#[test]
fn ordering_keeps_places_of_items_left_out_unique_and_refuses_what_is_not_offered() {
    let w = world();
    let mut set = SelectionSet::default();
    let one = select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
    let two = select(
        &mut set,
        &w,
        pick(SelectionKind::ContextualEntry, "republic"),
    );
    let three = select(
        &mut set,
        &w,
        pick(SelectionKind::ContextualEntry, "academy"),
    );
    let elsewhere = select(
        &mut set,
        &w,
        NewSelection {
            posts: Some(vec!["other".into()]),
            ..pick(SelectionKind::Reference, "scholar")
        },
    );
    set.order_for_post(
        "cave",
        &[one.clone(), two.clone(), three.clone()],
        &w.basis(),
    )
    .unwrap();
    // `two` is withheld, so a later ordering lists the other two only.
    set.withdraw(&two, None);
    set.order_for_post("cave", &[three.clone(), one.clone()], &w.basis())
        .unwrap();
    let places: Vec<(&str, u32)> = [&three, &one, &two]
        .iter()
        .map(|id| (id.as_str(), set.get(id).unwrap().positions["cave"]))
        .collect();
    assert_eq!(
        places.iter().map(|(_, n)| *n).collect::<Vec<_>>(),
        [1, 2, 3],
        "the withheld item keeps a unique place after the listed ones: {places:?}"
    );
    // A selection for another post has no place among this post's items.
    let before = set.clone();
    let problems = set
        .order_for_post("cave", std::slice::from_ref(&elsewhere), &w.basis())
        .unwrap_err();
    assert_eq!(problems[0].code, Code::BadPosts);
    assert_eq!(set, before, "all or nothing");
    assert!(set
        .order_for_post("cave", &["nope".to_string()], &w.basis())
        .is_err());
    // Narrowing a selection's scope drops the places it no longer needs.
    set.rescope(&one, Some(vec!["other".into()]), &w.basis())
        .unwrap();
    assert!(set.get(&one).unwrap().positions.is_empty());
    // A record that places a scoped selection in a post it is not for, or
    // names a path, is refused when read.
    for bad in [r#"{"cave":1,"other":2}"#, r#"{"../x":1}"#] {
        let text = set.to_json().replace(
            &format!("\"id\": \"{one}\""),
            &format!("\"id\": \"{one}\", \"positions\": {bad}"),
        );
        let parsed = SelectionSet::parse(&text);
        assert!(parsed.is_err(), "{bad}");
    }
}

#[test]
fn a_public_item_names_only_published_posts_in_its_positions() {
    let w = world();
    let mut set = SelectionSet::default();
    let shared = select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
    mutate(&mut set, &shared)
        .positions
        .extend([("cave".to_string(), 1), ("secret-draft".to_string(), 2)]);
    let resolution = resolve(&set, &w.basis());
    let item = &resolution.curation.items[0];
    assert_eq!(item.positions.keys().collect::<Vec<_>>(), ["cave"]);
    let text = serde_json::to_string(&resolution.curation).unwrap();
    assert!(
        !text.contains("secret-draft"),
        "a draft slug is not disclosed"
    );
}

// ---------------------------------------------------------------- the research-context projection (#197)

mod context {
    use super::*;
    use openblog_core::curated_context::{
        ContextRefusal, CuratedContext, PostRef, ANCHOR_PREFIX, CURATED_CONTEXT_JSON_FILE,
        MAX_BYTES, MAX_LISTED_POSTS,
    };
    use openblog_core::curated_selection::{
        ContextItem, CuratedItem, PublicCuration, CURATED_FORMAT, CURATED_FORMAT_VERSION,
    };
    use openblog_core::publication_boundary::BoundaryInputs;

    pub const POSTS: [PostRef<'static>; 2] = [
        PostRef {
            slug: "cave",
            url: "/posts/cave/",
        },
        PostRef {
            slug: "other",
            url: "/posts/other/",
        },
    ];

    fn at(pairs: &[(&str, u32)]) -> BTreeMap<String, u32> {
        pairs.iter().map(|(p, n)| (p.to_string(), *n)).collect()
    }

    /// Every kind the context file carries, over two posts, with a
    /// withdrawn and a stale selection whose words are private.
    fn selected(w: &World) -> SelectionSet {
        let mut set = SelectionSet::default();
        let place = |set: &mut SelectionSet, new: NewSelection, id: &str| {
            set.select(
                NewSelection {
                    id: Some(id.to_string()),
                    ..new
                },
                &w.basis(),
            )
            .expect("selected");
        };
        place(
            &mut set,
            NewSelection {
                posts: Some(vec!["cave".into()]),
                positions: at(&[("cave", 2)]),
                ..pick(SelectionKind::Relationship, "r-authored")
            },
            "relationship-authored",
        );
        place(
            &mut set,
            NewSelection {
                optional_fields: vec!["summary".into()],
                posts: Some(vec!["cave".into(), "other".into()]),
                positions: at(&[("cave", 1), ("other", 5)]),
                ..pick(SelectionKind::ContextualEntry, "plato")
            },
            "entry-plato",
        );
        place(
            &mut set,
            pick(SelectionKind::Timeline, "plato-birth-a"),
            "dating-birth-a",
        );
        place(
            &mut set,
            NewSelection {
                optional_fields: vec!["issued".into()],
                posts: Some(vec!["other".into()]),
                provenance: Provenance::Imported {
                    from: "a library catalogue".into(),
                },
                ..pick(SelectionKind::Reference, "undated")
            },
            "reference-undated",
        );
        place(
            &mut set,
            NewSelection {
                text: Some("A comment of mine, to be shown as written.".into()),
                by: Some("The author".into()),
                locator: Some("514a".into()),
                optional_fields: vec!["locator".into()],
                posts: Some(vec!["cave".into()]),
                ..pick(SelectionKind::SourceAnnotation, "burnet")
            },
            "annotation-burnet",
        );
        place(
            &mut set,
            NewSelection {
                text: Some("The author explains the Academy.".into()),
                by: Some("The author".into()),
                ..pick(SelectionKind::Explanation, "academy")
            },
            "explanation-academy",
        );
        place(
            &mut set,
            pick(SelectionKind::Comparison, "cave"),
            "comparison-cave",
        );
        // Private words that must never reach the file or a page: a withdrawn
        // comment and a stale one.
        place(
            &mut set,
            NewSelection {
                text: Some(format!("{PRIVATE} withdrawn comment words")),
                by: Some("The author".into()),
                ..pick(SelectionKind::SourceAnnotation, "scholar")
            },
            "annotation-withdrawn",
        );
        set.withdraw("annotation-withdrawn", Some(format!("{PRIVATE} reason")));
        place(
            &mut set,
            NewSelection {
                text: Some(format!("{PRIVATE} stale comment words")),
                by: Some("The author".into()),
                ..pick(SelectionKind::SourceAnnotation, "grube")
            },
            "annotation-stale",
        );
        mutate(&mut set, "annotation-stale").revision = "0123456789abcdef".into();
        set
    }

    fn project(
        w: &World,
        set: &SelectionSet,
    ) -> (openblog_core::curated_selection::Resolution, CuratedContext) {
        let resolution = resolve(set, &w.basis());
        let context = CuratedContext::project(&resolution.curation, &POSTS, "/blog")
            .expect("the context projects");
        (resolution, context)
    }

    #[test]
    fn the_file_is_the_one_public_value_with_each_posts_order_and_canonical_anchors() {
        let w = world();
        let set = selected(&w);
        let (resolution, context) = project(&w, &set);
        let json = context.to_json();
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["format"], openblog_core::curated_context::FILE_FORMAT);
        assert_eq!(value["formatVersion"], CURATED_FORMAT_VERSION);
        assert_eq!(value["anchorPrefix"], ANCHOR_PREFIX);
        // Every published selection, exactly as the selection projection publishes it.
        assert_eq!(
            value["items"],
            serde_json::to_value(&resolution.curation.items).unwrap()
        );
        assert_eq!(
            value["context"],
            serde_json::to_value(&resolution.curation.context).unwrap()
        );
        // The withdrawn and the stale selection are in neither the file nor the order.
        for gone in ["annotation-withdrawn", "annotation-stale"] {
            assert!(!json.contains(gone), "{gone}");
        }
        assert!(!json.contains(PRIVATE) && !json.contains("p-burnet"));
        // Each post's order is that post's own order, and only posts that offer something are listed.
        let posts = value["posts"].as_array().unwrap();
        assert_eq!(
            posts
                .iter()
                .map(|p| p["post"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["cave", "other"]
        );
        let order = |post: &str| -> Vec<String> {
            context
                .for_post(post)
                .unwrap()
                .items
                .iter()
                .map(|item| item.id.clone())
                .collect()
        };
        assert_eq!(
            order("cave"),
            [
                "entry-plato",
                "relationship-authored",
                "annotation-burnet",
                "comparison-cave",
                "dating-birth-a",
                "explanation-academy"
            ]
        );
        // The whole-site items sit last for a post that has not placed them, and `other`
        // places the entry fifth.
        assert_eq!(
            order("other"),
            [
                "entry-plato",
                "comparison-cave",
                "dating-birth-a",
                "explanation-academy",
                "reference-undated"
            ]
        );
        // A canonical anchor is the post's address and the item's fragment, and the page has it.
        for post in posts {
            for item in post["items"].as_array().unwrap() {
                let id = item["id"].as_str().unwrap();
                assert_eq!(
                    item["url"],
                    format!("{}#{ANCHOR_PREFIX}{id}", post["url"].as_str().unwrap())
                );
                let slug = post["post"].as_str().unwrap();
                let html = context.post_section_html(slug, None).unwrap();
                assert!(
                    html.contains(&format!("id=\"{ANCHOR_PREFIX}{id}\"")),
                    "{id}"
                );
            }
        }
        // The selected revision is the published one.
        for item in value["items"].as_array().unwrap() {
            let stored = set.get(item["id"].as_str().unwrap()).unwrap();
            assert_eq!(item["revision"], stored.revision.as_str());
        }
        // Deterministic whatever the order of the file.
        let mut shuffled = set.clone();
        shuffled.selections.reverse();
        assert_eq!(project(&w, &shuffled).1.to_json(), json);
        // Nothing here is a query: a post that offers nothing has no entry and no section.
        assert!(context.for_post("nowhere").is_none());
        assert!(context.post_section_html("nowhere", None).is_none());
        // Escaped for embedding in a script element.
        assert!(!json.contains('<') && !json.contains('>') && !json.contains('&'));
        // The same file name the build writes and the manifest lists.
        assert_eq!(CURATED_CONTEXT_JSON_FILE, "curated-context.json");
    }

    #[test]
    fn the_page_section_keeps_attribution_uncertainty_evidence_and_origin_as_text() {
        let w = world();
        let set = selected(&w);
        let (_, context) = project(&w, &set);
        let cave = context
            .post_section_html("cave", Some("/curated-context.json"))
            .unwrap();
        // Complete without JavaScript: semantic headings, lists and definitions only.
        assert!(
            !cave.contains("<script") && !cave.contains(" onclick") && !cave.contains("<table")
        );
        assert!(cave.contains(
            "<h2 class=\"ob-curated-title\" id=\"ob-research-context-title\">Research context</h2>"
        ));
        assert!(
            cave.contains("<ol class=\"ob-curated-items\" role=\"list\">")
                && cave.contains("<dl class=\"ob-curated-fields\">")
        );
        assert!(cave.contains("href=\"/curated-context.json\""));
        // A relationship: who asserts it, how firmly, what is doubtful, who disputes it, on what evidence.
        for expected in [
            "Relationship: Plato authored Republic",
            "Who asserts it",
            "the source <a class=\"ob-curated-source\" href=\"#ob-curated-ref_source_scholar\"><cite>A study of the dialogues</cite></a>",
            "How firmly",
            "plausible",
            "What is doubtful",
            "The dating is unsettled.",
            "Who disputes it",
            "A later editor: Dates it later.",
            "The evidence",
            "page 514",
            "Platonis Opera",
        ] {
            assert!(cave.contains(expected), "{expected}\n{cave}");
        }
        // The author's own comment is attributed and plain.
        assert!(cave.contains("A comment of mine, to be shown as written."));
        assert!(cave.contains("Who wrote it") && cave.contains("The author"));
        assert!(cave.contains("Where in the source it applies") && cave.contains("514a"));
        // The sources and entries these refer to are listed, with anchors the items link to.
        assert!(cave.contains("id=\"ob-curated-ref_source_burnet\""));
        assert!(cave.contains("id=\"ob-curated-ref_entry_republic\""));
        assert!(!cave.contains(PRIVATE) && !cave.contains("p-burnet"));
        // The reference of `other` says where its metadata came from and what is missing.
        let other = context.post_section_html("other", None).unwrap();
        assert!(other.contains("Where this metadata came from: imported from a library catalogue."));
        assert!(
            other.contains("Not recorded, so left out and never invented: Creators, Date issued.")
        );
        assert!(
            !other.contains("href=\"/curated-context.json\""),
            "no link when none is given"
        );
        // A competing dating that is not selected is said beside the dating.
        assert!(cave.contains(
            "Other datings of the same aspect exist on this site and were not chosen here."
        ));
        assert!(
            !cave.contains("plato-birth-b"),
            "a reader is not shown the ids"
        );
        // Reading order is the document order: the title, then each item in turn, then what they refer to.
        let at = |needle: &str| cave.find(needle).unwrap_or_else(|| panic!("{needle}"));
        assert!(
            at("research-context-title")
                < at("id=\"ob-curated-entry-plato\"")
                    .min(at("id=\"ob-curated-relationship-authored\""))
        );
        assert!(at("id=\"ob-curated-relationship-authored\"") < at("id=\"ob-curated-ref_list\""));
        // Each kind keeps its own name.
        for noun in [
            "Atlas entry: Plato",
            "Dating: birth: 428 BCE",
            "Comparison: The cave",
            "The author&#39;s comment on a source: Platonis Opera",
            "The author&#39;s explanation of an entry: The Academy &lt;b&gt;x&lt;/b&gt;",
        ] {
            assert!(cave.contains(noun), "{noun}");
        }
    }

    #[test]
    fn the_file_and_a_page_section_match_the_fixtures_the_node_tests_read() {
        let w = world();
        let set = selected(&w);
        let (_, context) = project(&w, &set);
        check_fixture(
            "../curated-context/curated-context.json",
            &format!(
                "{}
",
                context.to_json()
            ),
        );
        check_fixture(
            "../curated-context/cave-section.html",
            &context
                .post_section_html("cave", Some("/curated-context.json"))
                .unwrap(),
        );
    }

    #[test]
    fn hostile_text_is_escaped_in_the_page_and_the_data_and_only_safe_addresses_link() {
        let w = world();
        let hostile = "</script><script>alert(1)</script><img src=x onerror=alert(2)> & \"quoted\" 'single' javascript:alert(3)";
        let mut set = SelectionSet::default();
        select(
            &mut set,
            &w,
            NewSelection {
                text: Some(hostile.into()),
                by: Some("<b>The</b> author".into()),
                ..pick(SelectionKind::Explanation, "academy")
            },
        );
        let (resolution, context) = project(&w, &set);
        let html = context.post_section_html("cave", None).unwrap();
        for raw in ["<script", "<img", "<b>", "onerror=alert(2)>"] {
            assert!(!html.contains(raw), "{raw} was not escaped:\n{html}");
        }
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(html.contains("&lt;b&gt;The&lt;/b&gt; author"));
        let json = context.to_json();
        assert!(!json.contains('<') && !json.contains('>') && !json.contains('&'));
        // The words are data, kept verbatim for the renderers to escape.
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["items"][0]["content"]["text"], json!(hostile));
        // A link is only ever to this site or to an https address; anything else is text.
        let mut curation = resolution.curation.clone();
        for (url, linked) in [
            ("javascript:alert(1)", false),
            ("//evil.example/x", false),
            ("/\\evil.example/x", false),
            ("/ok\u{7}bell", false),
            ("/ok\nnewline", false),
            ("http://example.org/plain", false),
            ("data:text/html,<b>", false),
            ("/atlas/plato/", true),
            ("https://example.org/a", true),
        ] {
            curation.items[0].content.insert("url".into(), json!(url));
            let page = CuratedContext::project(&curation, &POSTS, "")
                .unwrap()
                .post_section_html("cave", None)
                .unwrap();
            let has_link = page.contains(&format!("href=\"{}\"", url.replace('&', "&amp;")));
            assert_eq!(has_link, linked, "{url}");
            // An address that is not a link is still shown, as plain text (never dropped).
            if !linked && url.starts_with("http://") {
                assert!(page.contains("Address (not a link)"), "{url}");
                assert!(page.contains(&format!("<dd>{url}</dd>")), "{url}");
            }
        }
    }

    #[test]
    fn a_notice_reads_as_a_sentence_from_its_code_and_field_with_no_ids_or_backticks() {
        use openblog_core::curated_selection::ItemNotice;
        let mut noted = item("noted", &["cave"]);
        noted.notices = vec![
            ItemNotice {
                code: NoticeCode::MissingDetail,
                field: Some("issued".into()),
                message: "Selection `noted`: `issued` is selected but the source has none.".into(),
            },
            ItemNotice {
                code: NoticeCode::CompetingUnselected,
                field: None,
                message: "Selection `noted`: competing datings are published but not selected: rival-dating-1.".into(),
            },
            ItemNotice {
                code: NoticeCode::ProvenanceUnrecorded,
                field: Some("provenance".into()),
                message: "Selection `noted`: where this came from is not recorded.".into(),
            },
        ];
        let context =
            CuratedContext::project(&curation_of(vec![noted], Vec::new()), &POSTS, "").unwrap();
        let html = context.post_section_html("cave", None).unwrap();
        let notices = html.split("ob-curated-notices").nth(1).unwrap();
        let notices = notices.split("</ul>").next().unwrap();
        assert!(
            notices.contains("does not record the date issued"),
            "{notices}"
        );
        assert!(
            notices.contains("Other datings of the same aspect"),
            "{notices}"
        );
        for private in ["`", "Selection", "noted", "rival-dating-1", "issued`"] {
            assert!(!notices.contains(private), "{private}: {notices}");
        }
        // The data file keeps the author's own message, for the tools that read it.
        assert!(context.to_json().contains("rival-dating-1"));
    }

    #[test]
    fn a_post_with_a_large_selection_renders_a_bounded_page_by_index() {
        use openblog_core::curated_context::MAX_PAGE_ITEMS;
        let total = MAX_PAGE_ITEMS + 120;
        let items: Vec<CuratedItem> = (0..total)
            .map(|n| item(&format!("entry-{n:04}"), &["cave"]))
            .collect();
        let context = (0..total)
            .map(|n| ContextItem {
                kind: ContextKind::Entry,
                id: format!("entry-{n:04}"),
                label: Some(format!("Entry {n}")),
                url: None,
                source: None,
                via: vec![format!("entry-{n:04}")],
            })
            .collect();
        let context = CuratedContext::project(&curation_of(items, context), &POSTS, "").unwrap();
        let started = std::time::Instant::now();
        let html = context.post_section_html("cave", None).unwrap();
        assert!(
            started.elapsed().as_secs() < 5,
            "rendering must not be quadratic"
        );
        assert_eq!(
            html.matches("<li class=\"ob-curated-item\"").count(),
            MAX_PAGE_ITEMS
        );
        assert!(
            html.contains("This page shows the first 1000 items. 120 more are in the data file")
        );
        // The data file still holds every item.
        let value: Value = serde_json::from_str(&context.to_json()).unwrap();
        assert_eq!(value["items"].as_array().unwrap().len(), total);
        // A post of few items has no such note.
        let small = CuratedContext::project(
            &curation_of(vec![item("only", &["cave"])], Vec::new()),
            &POSTS,
            "",
        )
        .unwrap();
        assert!(!small
            .post_section_html("cave", None)
            .unwrap()
            .contains("ob-curated-more"));
    }

    fn item(id: &str, posts: &[&str]) -> CuratedItem {
        CuratedItem {
            id: id.to_string(),
            kind: SelectionKind::ContextualEntry,
            target: id.to_string(),
            revision: "0123456789abcdef".into(),
            content: BTreeMap::from([
                ("id".to_string(), json!(id)),
                ("label".to_string(), json!(format!("Label of {id}"))),
            ]),
            provenance: Provenance::Unrecorded,
            missing: Vec::new(),
            requires: Vec::new(),
            posts: posts.iter().map(|p| p.to_string()).collect(),
            positions: BTreeMap::new(),
            notices: Vec::new(),
        }
    }

    fn curation_of(items: Vec<CuratedItem>, context: Vec<ContextItem>) -> PublicCuration {
        PublicCuration {
            format: CURATED_FORMAT,
            format_version: CURATED_FORMAT_VERSION,
            items,
            context,
        }
    }

    fn refusal(curation: &PublicCuration) -> ContextRefusal {
        CuratedContext::project(curation, &POSTS, "").unwrap_err()
    }

    #[test]
    fn a_projection_that_disagrees_with_itself_is_refused_whole_naming_ids_only() {
        use openblog_core::atlas_query::RefusalKind;
        // A missing endpoint: an item requires one that is not published.
        let mut needs = item("needs", &[]);
        needs.requires = vec!["missing".into()];
        let refused = refusal(&curation_of(vec![needs], Vec::new()));
        assert_eq!(refused.kind, RefusalKind::Inconsistent);
        assert!(refused.message.contains("`needs`") && refused.message.contains("`missing`"));
        // The same item twice.
        let refused = refusal(&curation_of(
            vec![item("twice", &[]), item("twice", &[])],
            Vec::new(),
        ));
        assert_eq!(refused.kind, RefusalKind::Inconsistent);
        // A post the build does not publish.
        let refused = refusal(&curation_of(vec![item("far", &["draft-post"])], Vec::new()));
        assert_eq!(refused.kind, RefusalKind::Inconsistent);
        assert!(refused.message.contains("draft-post"));
        // Context for an item that is not published.
        let context = ContextItem {
            kind: ContextKind::Entry,
            id: "plato".into(),
            label: Some("Plato".into()),
            url: None,
            source: None,
            via: vec!["ghost".into()],
        };
        let refused = refusal(&curation_of(vec![item("real", &[])], vec![context]));
        assert_eq!(refused.kind, RefusalKind::Inconsistent);
        assert!(refused.message.contains("`ghost`"));
    }

    #[test]
    fn a_projection_over_a_bound_is_refused_whole_and_names_the_limit() {
        use openblog_core::atlas_query::RefusalKind;
        // Over the size bound: a few very large items.
        let items = (0..40)
            .map(|n| {
                let mut big = item(&format!("big-{n}"), &[]);
                big.content
                    .insert("summary".into(), json!("x".repeat(MAX_BYTES / 20)));
                big
            })
            .collect();
        let refused = refusal(&curation_of(items, Vec::new()));
        assert_eq!(refused.kind, RefusalKind::OverLimit);
        assert!(refused.message.contains(&MAX_BYTES.to_string()));
        assert!(!refused.message.contains("xxxx"), "never an item's text");
        // Over the post bound: one whole-site item offered by too many posts.
        let slugs: Vec<String> = (0..=MAX_LISTED_POSTS).map(|n| format!("p{n}")).collect();
        let urls: Vec<String> = slugs.iter().map(|s| format!("/posts/{s}/")).collect();
        let many: Vec<PostRef<'_>> = slugs
            .iter()
            .zip(&urls)
            .map(|(slug, url)| PostRef { slug, url })
            .collect();
        let refused = CuratedContext::project(
            &curation_of(vec![item("everywhere", &[])], Vec::new()),
            &many,
            "",
        )
        .unwrap_err();
        assert_eq!(refused.kind, RefusalKind::OverLimit);
        assert!(refused.message.contains(&MAX_LISTED_POSTS.to_string()));
        // The base path counts toward the size bound: just under it without one, over with one.
        let one = |len: usize| {
            let mut big = item("edge", &[]);
            big.content.insert("summary".into(), json!("y".repeat(len)));
            big.content.insert("url".into(), json!("/atlas/x/"));
            curation_of(vec![big], Vec::new())
        };
        let probe = CuratedContext::project(&one(0), &POSTS, "")
            .unwrap()
            .to_json()
            .len();
        let fits = one(MAX_BYTES - probe);
        assert!(CuratedContext::project(&fits, &POSTS, "").is_ok());
        assert!(CuratedContext::project(&fits, &POSTS, "/a-long-base-path").is_err());
    }

    #[test]
    fn a_large_graph_projects_the_same_bytes_every_time_inside_the_bounds() {
        let items: Vec<CuratedItem> = (0..2_000)
            .map(|n| {
                let mut it = item(&format!("item-{n:05}"), &["cave"]);
                it.positions = BTreeMap::from([("cave".to_string(), (n % 97) as u32)]);
                it
            })
            .collect();
        let curation = curation_of(items, Vec::new());
        let started = std::time::Instant::now();
        let first = CuratedContext::project(&curation, &POSTS, "/blog").unwrap();
        let again = CuratedContext::project(&curation, &POSTS, "/blog").unwrap();
        assert!(
            started.elapsed().as_secs() < 20,
            "linear enough to build in seconds"
        );
        assert_eq!(first.to_json(), again.to_json());
        assert!(first.to_json().len() <= MAX_BYTES);
        assert_eq!(first.for_post("cave").unwrap().items.len(), 2_000);
        // The page section renders them in that order, once each, up to its own bound.
        let html = first.post_section_html("cave", None).unwrap();
        assert_eq!(
            html.matches("class=\"ob-curated-item\"").count(),
            openblog_core::curated_context::MAX_PAGE_ITEMS
        );
    }

    #[test]
    fn cycles_and_withheld_requirements_never_reach_the_file() {
        let w = world();
        let mut set = SelectionSet::default();
        let a = select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
        let b = select(
            &mut set,
            &w,
            pick(SelectionKind::ContextualEntry, "republic"),
        );
        let ok = select(
            &mut set,
            &w,
            pick(SelectionKind::ContextualEntry, "academy"),
        );
        mutate(&mut set, &a).requires = vec![b.clone()];
        mutate(&mut set, &b).requires = vec![a.clone()];
        set.reselect(&a, &w.basis()).unwrap();
        set.reselect(&b, &w.basis()).unwrap();
        let (resolution, context) = project(&w, &set);
        assert_eq!(resolution.withheld.len(), 2);
        let ids: Vec<&str> = context.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, [ok.as_str()]);
        assert!(!context.to_json().contains(&a) && !context.to_json().contains(&b));
        // An item that requires a withheld one is withheld with it.
        let mut set = SelectionSet::default();
        let base = select(&mut set, &w, pick(SelectionKind::ContextualEntry, "plato"));
        let dependent = select(
            &mut set,
            &w,
            pick(SelectionKind::ContextualEntry, "academy"),
        );
        mutate(&mut set, &dependent).requires = vec![base.clone()];
        set.reselect(&dependent, &w.basis()).unwrap();
        set.withdraw(&base, None);
        let (_, context) = project(&w, &set);
        assert!(context.items.is_empty() && context.posts.is_empty());
    }

    #[test]
    fn the_manifest_lists_the_file_only_while_the_site_curates_and_withholds_it_whole_when_refused()
    {
        let w = world();
        // Whole-site selections only: this manifest is built over no posts.
        let mut set = SelectionSet::default();
        select(&mut set, &w, pick(SelectionKind::Timeline, "plato-birth-a"));
        select(&mut set, &w, pick(SelectionKind::Comparison, "cave"));
        let resolution = resolve(&set, &w.basis());
        let curation = CurationInput {
            set: &set,
            resolution: &resolution,
        };
        let inputs = |on: bool, curation: Option<&CurationInput<'_>>| {
            let mut inputs = BoundaryInputs {
                switches: Switches {
                    curated: on,
                    ..Switches::default()
                },
                posts: &[],
                public_atlas: Some(&w.public_atlas),
                atlas_blocked: None,
                public_comparisons: Some(&w.comparisons),
                comparisons_blocked: None,
                public_paths: None,
                public_interpretations: None,
                claims_blocked: None,
                library: Some(&w.library),
                notebook: None,
                atlas: Some(&w.atlas),
                claims: None,
                alignments: None,
                stale_comparisons: None,
                acknowledgements: None,
                curation: None,
                unavailable: &[],
                author: "",
                base_path: "",
            };
            inputs.curation = curation;
            BoundaryManifest::site(&inputs)
        };
        // Off, the manifest is exactly what it was.
        let off = inputs(false, Some(&curation));
        assert!(off
            .projections
            .iter()
            .all(|p| p.projection != Projection::CuratedContext));
        // On, the file is listed once, with the posts it lists.
        let on = inputs(true, Some(&curation));
        let report = on
            .projections
            .iter()
            .find(|p| p.projection == Projection::CuratedContext)
            .expect("the curated context projection");
        assert!(report.enabled && report.withheld.is_empty());
        assert_eq!(report.published.len(), 1);
        assert_eq!(report.published[0].kind, ItemKind::CuratedContext);
        assert_eq!(
            report.published[0].url.as_deref(),
            Some("/curated-context.json")
        );
        assert_eq!(
            on.published_ids(Projection::CuratedContext, ItemKind::CuratedContext)
                .into_iter()
                .collect::<Vec<_>>(),
            ["curated-context"]
        );
        // The build summary does not count it twice.
        assert!(on.summary().is_none_or(|s| !s.contains("curated context")));
        // A projection that cannot be written is withheld whole, naming the limit, never text.
        let big = (0..40)
            .map(|n| {
                let mut it = item(&format!("big-{n}"), &[]);
                it.content
                    .insert("summary".into(), json!("z".repeat(MAX_BYTES / 20)));
                it
            })
            .collect();
        let refused = openblog_core::curated_selection::Resolution {
            curation: curation_of(big, Vec::new()),
            withheld: Vec::new(),
            notices: Vec::new(),
        };
        let held = CurationInput {
            set: &set,
            resolution: &refused,
        };
        let manifest = inputs(true, Some(&held));
        let report = manifest
            .projections
            .iter()
            .find(|p| p.projection == Projection::CuratedContext)
            .unwrap();
        assert!(report.published.is_empty());
        assert_eq!(report.withheld[0].reason, Reason::OverLimit);
        assert!(report.withheld[0].message.contains(&MAX_BYTES.to_string()));
        assert!(!report.withheld[0].message.contains("zzzz"));
        assert!(manifest
            .build_warnings()
            .iter()
            .any(|w| w.starts_with("boundary: ") && w.contains(CURATED_CONTEXT_JSON_FILE)));
        // The selections themselves are unaffected by the file being refused.
        assert!(manifest
            .projections
            .iter()
            .any(|p| p.projection == Projection::Curated));
    }

    // ---- portable copies, feeds and the bibliography (#198, ADR 0202 to ADR 0206) -----------

    mod portable {
        use super::*;
        use openblog_core::curated_selection::{ItemNotice, PublicCuration};
        use openblog_core::portability::{PortableProjection, RepresentationFormat};
        use openblog_core::{feeds, DateTime, LoadOptions, Site, SiteConfig, SourceFile, Sources};

        const CANONICAL: &str = "https://example.test/posts/cave/";

        fn config(full_content: bool) -> SiteConfig {
            SiteConfig::from_json(&format!(
                r#"{{"title":"T","url":"https://example.test","postPath":"/posts/{{slug}}/","feeds":{{"fullContent":{full_content}}}}}"#
            ))
            .unwrap()
        }

        fn site(curation: Option<PublicCuration>, full_content: bool) -> Site {
            let post = |slug: &str| {
                SourceFile {
                path: format!("posts/{slug}.md"),
                contents: format!(
                    "---\ntitle: Post {slug}\ndate: 2026-01-01\ndescription: About {slug}.\n---\nBody of {slug}.\n"
                ),
            }
            };
            let mut site = Site::load(
                config(full_content),
                Sources {
                    posts: vec![post("cave"), post("other"), post("lonely")],
                    ..Default::default()
                },
                LoadOptions {
                    now: DateTime::parse("2030-01-01T00:00:00Z"),
                    ..LoadOptions::default()
                },
            )
            .unwrap_or_else(|errors| panic!("{errors:?}"));
            site.set_curation(curation);
            site
        }

        fn curated() -> PublicCuration {
            let w = world();
            resolve(&selected(&w), &w.basis()).curation
        }

        /// A curation that offers one item to `cave` and nothing to any other post.
        fn cave_only() -> PublicCuration {
            curation_of(vec![item("only", &["cave"])], Vec::new())
        }

        fn copies(site: &Site, slug: &str) -> (String, String, String) {
            let post = site.posts.iter().find(|post| post.slug == slug).unwrap();
            let projection = PortableProjection::for_site(site, post).unwrap();
            (
                projection.portable_html().unwrap().html,
                projection.portable_markdown().unwrap(),
                projection.portable_text().unwrap(),
            )
        }

        /// The words of the selected facts in the fixture, which every copy must carry.
        const FACTS: &[&str] = &[
            "An Athenian philosopher.",
            "The dating is unsettled.",
            "A later editor",
            "Dates it later.",
            "A comment of mine, to be shown as written.",
            "The author explains the Academy.",
            "Both render 514a.",
            "The author reads these places as corresponding in part",
            "428 BCE",
            "plausible",
            "contested",
            "Platonis Opera",
            "Politeia",
            "A study of the dialogues",
            "page 514",
        ];

        fn folded(value: &str) -> String {
            value
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .chars()
                .filter(|c| c.is_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect()
        }

        #[test]
        fn every_selected_fact_survives_in_html_markdown_and_text_with_a_link_back() {
            let site = site(Some(curated()), true);
            let (html, markdown, text) = copies(&site, "cave");
            for (format, copy) in [("html", &html), ("markdown", &markdown), ("text", &text)] {
                for fact in FACTS {
                    assert!(
                        folded(copy).contains(&folded(fact)),
                        "{format} lost `{fact}`:\n{copy}"
                    );
                }
                // The canonical link back to the section and to each item's own anchor.
                assert!(
                    copy.contains(&format!("{CANONICAL}#ob-research-context")),
                    "{format}"
                );
                for id in [
                    "entry-plato",
                    "relationship-authored",
                    "annotation-burnet",
                    "comparison-cave",
                    "dating-birth-a",
                    "explanation-academy",
                ] {
                    assert!(
                        copy.contains(&format!("{CANONICAL}#ob-curated-{id}")),
                        "{format} {id}"
                    );
                }
                // A different post's item is not on this one's copy.
                assert!(!folded(copy).contains(&folded("Undated")), "{format}");
            }
            // The items sit in the author's order in every copy.
            for copy in [&html, &markdown, &text] {
                let at = |needle: &str| copy.find(needle).unwrap_or_else(|| panic!("{needle}"));
                assert!(
                    at("#ob-curated-entry-plato") < at("#ob-curated-relationship-authored")
                        && at("#ob-curated-relationship-authored")
                            < at("#ob-curated-annotation-burnet")
                        && at("#ob-curated-annotation-burnet") < at("#ob-curated-comparison-cave")
                        && at("#ob-curated-comparison-cave") < at("#ob-curated-dating-birth-a")
                );
            }
            // The attribution, doubt and dissent stay words, never colour or position alone.
            for words in [
                "Who asserts it",
                "How firmly",
                "What is doubtful",
                "Who disputes it",
                "The evidence",
            ] {
                assert!(
                    html.contains(words) && markdown.contains(words) && text.contains(words),
                    "{words}"
                );
            }
            // No proprietary component and no page machinery: no ids, scripts or data attributes.
            for raw in ["<script", " id=\"", "data-curated", "onerror"] {
                assert!(!html.contains(raw), "{raw}");
            }
            // A caveat reads as a sentence, never the Admin's message.
            assert!(!html.contains('`') && !markdown.contains("Selection `"));
            // A copy says what a missing detail is, and never invents one.
            let other = copies(&site, "other");
            assert!(other
                .1
                .contains("Not recorded, so left out and never invented: Creators, Date issued."));
            assert!(other
                .0
                .contains("Where this metadata came from: imported from a library catalogue."));
        }

        #[test]
        fn with_curation_off_or_empty_every_copy_is_byte_for_byte_what_it_was() {
            let plain = site(None, true);
            let empty = site(
                Some(PublicCuration {
                    format: openblog_core::curated_selection::CURATED_FORMAT,
                    format_version: openblog_core::curated_selection::CURATED_FORMAT_VERSION,
                    items: Vec::new(),
                    context: Vec::new(),
                }),
                true,
            );
            let curating = site(Some(curated()), true);
            for slug in ["cave", "other", "lonely"] {
                assert_eq!(copies(&plain, slug), copies(&empty, slug), "{slug}");
            }
            // A post that is offered nothing is untouched even while another is offered something.
            let scoped = site(Some(cave_only()), true);
            for slug in ["other", "lonely"] {
                assert_eq!(copies(&plain, slug), copies(&scoped, slug), "{slug}");
            }
            assert_ne!(copies(&plain, "cave").1, copies(&scoped, "cave").1);
            assert_ne!(copies(&plain, "cave").1, copies(&curating, "cave").1);
            // The feeds and llms-full.txt are the same while nothing is offered.
            for (a, b) in [
                (feeds::rss(&plain).unwrap(), feeds::rss(&empty).unwrap()),
                (
                    feeds::json_feed(&plain).unwrap(),
                    feeds::json_feed(&empty).unwrap(),
                ),
                (
                    feeds::llms_full(&plain).unwrap(),
                    feeds::llms_full(&empty).unwrap(),
                ),
            ] {
                assert_eq!(a, b);
            }
        }

        #[test]
        fn the_feeds_and_llms_full_carry_the_context_and_summary_feeds_link_to_it() {
            let site = site(Some(curated()), true);
            let json: Value = serde_json::from_str(&feeds::json_feed(&site).unwrap()).unwrap();
            let cave = json["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["url"] == CANONICAL)
                .unwrap();
            for field in ["content_html", "content_text"] {
                let copy = cave[field].as_str().unwrap();
                for fact in FACTS {
                    assert!(
                        folded(copy).contains(&folded(fact)),
                        "{field} lost `{fact}`"
                    );
                }
            }
            assert_eq!(
                cave["_openblog"]["researchContext"]["url"],
                json!(format!("{CANONICAL}#ob-research-context"))
            );
            let rss = feeds::rss(&site).unwrap();
            assert!(rss.contains("Research context"));
            assert!(rss.contains(&format!(
                "<atom:link rel=\"related\" type=\"text/html\" title=\"Research context\" href=\"{CANONICAL}#ob-research-context\"/>"
            )));
            let full = feeds::llms_full(&site).unwrap();
            assert!(full.contains("## Research context"));
            assert!(full.contains(&format!("{CANONICAL}#ob-curated-entry-plato")));
            for fact in FACTS {
                assert!(
                    folded(&full).contains(&folded(fact)),
                    "llms-full lost `{fact}`"
                );
            }
            // A summary-only feed carries no item's words, only where the context is.
            let summary = self::site(Some(curated()), false);
            let json: Value = serde_json::from_str(&feeds::json_feed(&summary).unwrap()).unwrap();
            let cave = json["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["url"] == CANONICAL)
                .unwrap();
            let text = cave.to_string();
            assert!(!text.contains("The dating is unsettled."));
            let ids: Vec<&str> = cave["_openblog"]["researchContext"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["id"].as_str().unwrap())
                .collect();
            assert_eq!(ids[0], "entry-plato");
            assert_eq!(ids.len(), 6);
            // A post with no context has no such member.
            let scoped = self::site(Some(cave_only()), true);
            let json: Value = serde_json::from_str(&feeds::json_feed(&scoped).unwrap()).unwrap();
            let lonely = json["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["url"] == "https://example.test/posts/lonely/")
                .unwrap();
            assert!(lonely.get("_openblog").is_none());
        }

        #[test]
        fn a_copy_says_what_it_could_not_carry_and_an_address_that_is_not_a_link_stays_text() {
            let mut curation = curated();
            let reference = curation
                .items
                .iter_mut()
                .find(|item| item.id == "reference-undated")
                .unwrap();
            reference
                .content
                .insert("url".into(), json!("http://example.org/plain"));
            let site = site(Some(curation), true);
            let post = site.posts.iter().find(|post| post.slug == "other").unwrap();
            let output = PortableProjection::for_site(&site, post)
                .unwrap()
                .portable_html()
                .unwrap();
            let codes: Vec<&str> = output
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect();
            assert!(codes.contains(&"curated-context-sequenced"), "{codes:?}");
            assert!(codes.contains(&"curated-context-address-text"), "{codes:?}");
            assert!(output.html.contains("http://example.org/plain"));
            assert!(!output.html.contains("href=\"http://example.org/plain\""));
            // A post with nothing selected has none of these.
            let scoped = self::site(Some(cave_only()), true);
            let lonely = scoped
                .posts
                .iter()
                .find(|post| post.slug == "lonely")
                .unwrap();
            let output = PortableProjection::for_site(&scoped, lonely)
                .unwrap()
                .portable_html()
                .unwrap();
            assert!(output
                .diagnostics
                .iter()
                .all(|diagnostic| !diagnostic.code.starts_with("curated-context")));
        }

        #[test]
        fn hostile_words_and_addresses_are_inert_in_every_copy() {
            let hostile = "</script><script>alert(1)</script> [x](javascript:alert(2)) <img src=x onerror=alert(3)> **bold** & \"q\"";
            let mut curation = curated();
            let annotation = curation
                .items
                .iter_mut()
                .find(|item| item.id == "annotation-burnet")
                .unwrap();
            annotation.content.insert("text".into(), json!(hostile));
            annotation.content.insert("by".into(), json!("<b>Eve</b>"));
            let entry = curation
                .items
                .iter_mut()
                .find(|item| item.id == "entry-plato")
                .unwrap();
            entry
                .content
                .insert("url".into(), json!("javascript:alert(4)"));
            let site = site(Some(curation), true);
            let (html, markdown, text) = copies(&site, "cave");
            for raw in ["<script", "<img", "<b>", "onerror=alert(3)>"] {
                assert!(!html.contains(raw), "html: {raw}");
            }
            assert!(!html.contains("href=\"javascript:"));
            assert!(
                markdown.contains("\\[x\\]\\(javascript:alert\\(2\\)\\)")
                    || markdown.contains("\\[x\\]")
            );
            // The brackets are escaped, so it is words and not a link.
            for (at, _) in markdown.match_indices("](javascript:") {
                assert_eq!(
                    &markdown[at - 1..at],
                    "\\",
                    "an unescaped link to javascript:"
                );
            }
            for copy in [&html, &markdown, &text] {
                assert!(folded(copy).contains(&folded(hostile)));
            }
            // Every link in the Markdown goes to this site or to https.
            for (at, _) in markdown.match_indices("](") {
                if markdown[..at].ends_with('\\') {
                    continue; // an escaped bracket is words, not a link
                }
                let destination = &markdown[at + 2..];
                assert!(
                    destination.starts_with("https://") || destination.starts_with('<'),
                    "{destination:.60}"
                );
            }
        }

        #[test]
        fn a_copy_that_dropped_an_item_or_its_words_is_refused_whole_not_published_in_part() {
            let site = site(Some(curated()), true);
            let post = site.posts.iter().find(|post| post.slug == "cave").unwrap();
            let projection = PortableProjection::for_site(&site, post).unwrap();
            let markdown = projection.portable_markdown().unwrap();
            let context = site.curated_context_for(post).unwrap();
            let links = openblog_core::curated_context::CopyLinks {
                canonical: CANONICAL,
                absolute: &|href: &str| Ok(format!("https://example.test{href}")),
            };
            let section = context.copy_markdown("cave", &links).unwrap();
            assert!(section.carried_by(&markdown));
            // The words of a doubt cut out, an anchor cut out, or an item reordered: none is carried.
            assert!(!section.carried_by(&markdown.replace("The dating is unsettled.", "")));
            assert!(!section.carried_by(&markdown.replace("#ob-curated-dating-birth-a", "#x")));
            assert!(!section.carried_by(
                &markdown.replace("#ob-curated-entry-plato", "#ob-curated-explanation-academy")
            ));
            // A projection holding a non-public detail fails by name, not by text.
            assert!(!projection.portable_text().unwrap().is_empty());
        }

        #[test]
        fn a_large_context_is_bounded_in_a_copy_and_says_how_many_items_are_held_back() {
            let items: Vec<CuratedItem> = (0..openblog_core::curated_context::MAX_PAGE_ITEMS + 5)
                .map(|n| item(&format!("entry-{n:04}"), &["cave"]))
                .collect();
            let site = site(Some(curation_of(items, Vec::new())), true);
            let post = site.posts.iter().find(|post| post.slug == "cave").unwrap();
            let projection = PortableProjection::for_site(&site, post).unwrap();
            let output = projection.portable_html().unwrap();
            assert!(output.html.contains("5 more are on the original article"));
            assert!(output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "curated-context-held-back"));
            assert!(projection
                .portable_markdown()
                .unwrap()
                .contains("5 more are on the original article"));
        }

        #[test]
        fn a_bibliography_carries_the_selected_references_and_lists_what_it_cannot() {
            let site = site(Some(curated()), true);
            let post = site.posts.iter().find(|post| post.slug == "other").unwrap();
            let carried = PortableProjection::for_site(&site, post)
                .unwrap()
                .curated_bibliography()
                .unwrap();
            assert_eq!(carried.references.len(), 1);
            assert_eq!(carried.references[0].key, "undated");
            assert_eq!(carried.references[0].title.as_deref(), Some("Undated"));
            assert!(carried.references[0].creators.is_empty(), "never invented");
            assert!(carried.references[0].issued.is_none());
            assert!(carried
                .not_carried
                .contains(&("comparison-cave".to_string(), "comparison")));
            // A post that is offered nothing has none.
            let scoped = self::site(Some(cave_only()), true);
            let lonely = scoped
                .posts
                .iter()
                .find(|post| post.slug == "lonely")
                .unwrap();
            assert!(PortableProjection::for_site(&scoped, lonely)
                .unwrap()
                .curated_bibliography()
                .is_none());
        }

        #[test]
        fn the_portable_copies_match_the_fixtures_the_node_tests_read() {
            let site = site(Some(curated()), true);
            let (html, markdown, text) = copies(&site, "cave");
            check_fixture("../curated-context/portable-cave.html", &html);
            check_fixture("../curated-context/portable-cave.md", &markdown);
            check_fixture(
                "../curated-context/portable-cave.txt",
                &format!(
                    "{text}
"
                ),
            );
            let feed: Value = serde_json::from_str(&feeds::json_feed(&site).unwrap()).unwrap();
            let cave = feed["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["url"] == CANONICAL)
                .unwrap()
                .clone();
            check_fixture(
                "../curated-context/feed-item-cave.json",
                &format!(
                    "{}
",
                    serde_json::to_string_pretty(&cave).unwrap()
                ),
            );
        }

        #[test]
        fn a_projection_built_without_the_site_carries_nothing() {
            let site = site(Some(curated()), true);
            let post = site.posts.iter().find(|post| post.slug == "cave").unwrap();
            let bare = PortableProjection::from_post(post, &site.config).unwrap();
            assert!(bare.curated_context_markdown().is_none());
            assert!(!bare
                .representation(RepresentationFormat::Text)
                .contains("Research context"));
        }

        #[test]
        fn a_notice_in_a_copy_is_a_sentence_from_its_code() {
            let mut curation = curated();
            curation.items[0].notices.push(ItemNotice {
                code: NoticeCode::MissingDetail,
                field: Some("issued".into()),
                message: "Selection `x`: `issued` has none.".into(),
            });
            let site = site(Some(curation), true);
            let (html, markdown, _) = copies(&site, "cave");
            assert!(!html.contains("Selection `x`") && !markdown.contains("Selection `x`"));
        }
    }
}
