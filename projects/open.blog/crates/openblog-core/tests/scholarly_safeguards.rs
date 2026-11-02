//! The scholarly-safeguard regression corpus through the real emitters
//! (#195, ADR 0151): every row of the research-completeness matrix is
//! produced by the validator that owns it, from compact invented fixtures in
//! `tests/fixtures/scholarly-safeguards/`.
//!
//! Hostile inputs change one thing in a valid document and must be refused
//! with the diagnostic the matrix names, scoped to the record they are about,
//! without echoing any authored text. Nothing here is an authoritative
//! dataset, a real excerpt or a judgement about any real scholarship.

use std::collections::{BTreeMap, BTreeSet};

use openblog_core::alignment::AlignmentSet;
use openblog_core::claims::ClaimSet;
use openblog_core::knowledge_atlas::{Atlas, Links};
use openblog_core::research_completeness::{matrix, CompletenessFinding};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use serde_json::Value;

const HOSTILE: &str = include_str!("../../../tests/fixtures/scholarly-safeguards/hostile.json");

fn hostile() -> Value {
    serde_json::from_str(HOSTILE).expect("the hostile fixtures are JSON")
}

/// Apply one case's edits to a copy of the valid document.
fn edited(base: &Value, ops: &Value) -> Value {
    let mut value = base.clone();
    for op in ops.as_array().into_iter().flatten() {
        if let Some(pointer) = op["set"].as_str() {
            if let Some(slot) = value.pointer_mut(pointer) {
                *slot = op["value"].clone();
            } else {
                let (parent, key) = pointer.rsplit_once('/').unwrap();
                value
                    .pointer_mut(parent)
                    .and_then(Value::as_object_mut)
                    .unwrap_or_else(|| panic!("{pointer}"))
                    .insert(key.to_string(), op["value"].clone());
            }
        } else if let Some(pointer) = op["remove"].as_str() {
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            value
                .pointer_mut(parent)
                .and_then(Value::as_object_mut)
                .unwrap_or_else(|| panic!("{pointer}"))
                .remove(key);
        } else if let Some(pointer) = op["append"].as_str() {
            value
                .pointer_mut(pointer)
                .and_then(Value::as_array_mut)
                .unwrap_or_else(|| panic!("{pointer}"))
                .push(op["value"].clone());
        }
    }
    value
}

/// The text a case hands to the parser.
fn text_of(base: &Value, case: &Value) -> String {
    if let Some(text) = case["text"].as_str() {
        return text.to_string();
    }
    let mut text = edited(base, &case["ops"]).to_string();
    if let Some(pad) = case["pad"].as_u64() {
        text.push_str(&" ".repeat(pad as usize));
    }
    text
}

/// The rows (`validator: code`) a hostile case is refused with, by the owning parser.
fn refused_with(corpus: &Value, case: &Value) -> BTreeSet<String> {
    refusal(corpus, case)
        .iter()
        .map(|finding| format!("{}: {}", finding.validator, finding.code))
        .collect()
}

/// The findings a hostile case is refused with.
fn refusal(corpus: &Value, case: &Value) -> Vec<CompletenessFinding> {
    let no_contributors = BTreeMap::new();
    let base = &corpus["base"];
    let library = SourceLibrary::parse(&base["library"].to_string(), &no_contributors)
        .unwrap_or_else(|d| panic!("the valid library: {d:?}"));
    let notebook = Notebook::parse(&base["notebook"].to_string(), &library)
        .unwrap_or_else(|d| panic!("the valid notebook: {d:?}"));
    let links = Links {
        library: &library,
        notebook: &notebook,
    };
    let file = case["file"].as_str().unwrap();
    let text = text_of(&base[file], case);
    let findings: Vec<CompletenessFinding> = match file {
        "library" => match SourceLibrary::parse(&text, &no_contributors) {
            Ok(_) => vec![],
            Err(d) => d
                .iter()
                .map(CompletenessFinding::from_source_diagnostic)
                .collect(),
        },
        "notebook" => match Notebook::parse(&text, &library) {
            Ok(_) => vec![],
            Err(d) => d
                .iter()
                .map(CompletenessFinding::from_note_diagnostic)
                .collect(),
        },
        "atlas" => match Atlas::parse(&text, links) {
            Ok(_) => vec![],
            Err(d) => d
                .iter()
                .map(CompletenessFinding::from_atlas_diagnostic)
                .collect(),
        },
        "claims" => match ClaimSet::parse(&text, links) {
            Ok(_) => vec![],
            Err(d) => d
                .iter()
                .map(CompletenessFinding::from_atlas_diagnostic)
                .collect(),
        },
        "alignments" => match AlignmentSet::parse(&text, links) {
            Ok(_) => vec![],
            Err(d) => d
                .iter()
                .map(CompletenessFinding::from_atlas_diagnostic)
                .collect(),
        },
        other => panic!("unknown file {other}"),
    };
    findings
}

fn strings(value: &Value) -> BTreeSet<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| item.as_str().unwrap().to_string())
        .collect()
}

/// The rows an edit made through a document's own change operation is
/// refused with. The operation leaves the document exactly as it was.
fn operation_refused_with(corpus: &Value, name: &str) -> BTreeSet<String> {
    use openblog_core::claims::{check_claim_anchor, Drafts};
    use openblog_core::source_library::ResearchSourceKind;
    let none = BTreeMap::new();
    let base = &corpus["base"];
    let mut library = SourceLibrary::parse(&base["library"].to_string(), &none).unwrap();
    let mut notebook = Notebook::parse(&base["notebook"].to_string(), &library).unwrap();
    let mut atlas = Atlas::parse(
        &base["atlas"].to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .unwrap();
    let before = (library.to_json(), notebook.to_json());
    let rows = |findings: Vec<CompletenessFinding>| -> BTreeSet<String> {
        findings
            .iter()
            .map(|finding| format!("{}: {}", finding.validator, finding.code))
            .collect()
    };
    let source = |diagnostics: Vec<openblog_core::source_library::SourceDiagnostic>| {
        rows(
            diagnostics
                .iter()
                .map(CompletenessFinding::from_source_diagnostic)
                .collect(),
        )
    };
    let note = |diagnostics: Vec<openblog_core::research_notes::NoteDiagnostic>| {
        rows(
            diagnostics
                .iter()
                .map(CompletenessFinding::from_note_diagnostic)
                .collect(),
        )
    };
    let atlas_rows = |diagnostics: Vec<openblog_core::knowledge_atlas::AtlasDiagnostic>| {
        rows(
            diagnostics
                .iter()
                .map(CompletenessFinding::from_atlas_diagnostic)
                .collect(),
        )
    };
    let found = match name {
        "library-kind-changed" => {
            let mut record = library.get("lanterns-first").unwrap().clone();
            record.kind = ResearchSourceKind::Work;
            source(library.upsert(record, &none).unwrap_err())
        }
        "library-unknown-source" => source(library.remove("nowhere", &none).unwrap_err()),
        "library-still-used" => source(library.remove("lanterns-first", &none).unwrap_err()),
        "notebook-source-changed" => {
            let mut passage = notebook.passage("p-first").unwrap().clone();
            passage.source = "lanterns-en".into();
            note(notebook.upsert_passage(passage, &library).unwrap_err())
        }
        "notebook-still-linked" => note(notebook.remove_passage("p-first", &library).unwrap_err()),
        "notebook-unknown-entry" => note(notebook.remove_note("nowhere", &library).unwrap_err()),
        "atlas-still-linked" => {
            let links = Links {
                library: &library,
                notebook: &notebook,
            };
            atlas_rows(atlas.remove_entry("ida", links).unwrap_err())
        }
        "atlas-shadowed-field" => {
            let links = Links {
                library: &library,
                notebook: &notebook,
            };
            let mut entry = atlas.entries[0].clone();
            entry
                .extra
                .insert("label".into(), serde_json::json!("Other"));
            atlas_rows(atlas.upsert_entry(entry, links).unwrap_err())
        }
        name if name.starts_with("claims-") => {
            let links = Links {
                library: &library,
                notebook: &notebook,
            };
            let mut set = ClaimSet::parse(&base["claims"].to_string(), links).unwrap();
            match name {
                "claims-still-linked" => atlas_rows(set.remove_claim("c1", links).unwrap_err()),
                "claims-unknown-link" => atlas_rows(set.remove_link("nowhere", links).unwrap_err()),
                "claims-shadowed-field" => {
                    let mut claim = set.claims[0].clone();
                    claim
                        .extra
                        .insert("statement".into(), serde_json::json!("Other"));
                    atlas_rows(set.upsert_claim(claim, links).unwrap_err())
                }
                _ => {
                    let claim = set.claims[0].clone();
                    let drafts: Drafts = match name {
                        "claims-stale-anchor" => {
                            BTreeMap::from([("lanterns".into(), "No such words".into())])
                        }
                        "claims-ambiguous-anchor" => {
                            BTreeMap::from([("lanterns".into(), "see Seen and Seen".into())])
                        }
                        _ => BTreeMap::new(),
                    };
                    let mut moved = claim.clone();
                    // A new anchor is checked against the saved draft; an unchanged one is not.
                    moved.anchor.as_mut().unwrap().start += 1;
                    moved.anchor.as_mut().unwrap().end += 1;
                    let diagnostic = check_claim_anchor(None, &moved, &drafts).unwrap_err();
                    atlas_rows(vec![diagnostic])
                }
            }
        }
        name if name.starts_with("alignments-") => {
            let links = Links {
                library: &library,
                notebook: &notebook,
            };
            let mut set = AlignmentSet::parse(&base["alignments"].to_string(), links).unwrap();
            match name {
                "alignments-unknown-alignment" => {
                    atlas_rows(set.remove_alignment("nowhere", links).unwrap_err())
                }
                _ => {
                    let mut alignment = set.alignments[0].clone();
                    alignment
                        .extra
                        .insert("label".into(), serde_json::json!("Other"));
                    atlas_rows(set.upsert_alignment(alignment, links, false).unwrap_err())
                }
            }
        }
        other => panic!("unknown operation {other}"),
    };
    // A refused operation changes nothing.
    assert_eq!((library.to_json(), notebook.to_json()), before, "{name}");
    found
}

const CORPUS: &str = include_str!("../../../tests/fixtures/scholarly-safeguards/corpus.json");
const IMPORT: &str = include_str!("../../../tests/fixtures/scholarly-safeguards/import.json");
const HOSTILE_IMPORT: &str =
    include_str!("../../../tests/fixtures/source-interchange/hostile.json");

fn corpus() -> Value {
    serde_json::from_str(CORPUS).expect("the corpus is JSON")
}

/// Every word the valid documents keep private.
const PRIVATE_WORDS: [&str; 6] = [
    "Synthetic passage one.",
    "Synthetic passage two.",
    "Synthetic question.",
    "Synthetic reading.",
    "Synthetic claim.",
    "The author",
];

#[test]
fn every_hostile_input_is_refused_with_the_row_it_names_and_echoes_nothing() {
    let corpus = hostile();
    let cases = corpus["cases"].as_array().unwrap();
    assert!(cases.len() >= 90, "the corpus keeps its breadth");
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let found = refused_with(&corpus, case);
        let expected = strings(&case["emits"]);
        assert!(
            expected.is_subset(&found),
            "{id}: wanted {expected:?}, refused with {found:?}"
        );
        // A refusal is a diagnostic scoped to the record, never a copy of what the record says.
        for finding in refusal(&corpus, case) {
            let shown = format!("{} {}", finding.message, finding.repair);
            for words in PRIVATE_WORDS {
                assert!(!shown.contains(words), "{id} repeats {words}");
            }
        }
    }
}

#[test]
fn every_change_operation_refuses_what_it_names_and_leaves_the_document_alone() {
    let corpus = hostile();
    for case in corpus["operations"].as_array().unwrap() {
        let found = operation_refused_with(&corpus, case["op"].as_str().unwrap());
        let expected = strings(&case["emits"]);
        assert!(
            expected.is_subset(&found),
            "{}: wanted {expected:?}, refused with {found:?}",
            case["id"]
        );
    }
}

#[test]
fn every_row_of_the_matrix_is_exercised_by_the_validator_that_owns_it() {
    let corpus = corpus();
    let hostile = hostile();
    let mut declared = BTreeSet::new();
    for case in corpus["cases"].as_array().unwrap() {
        declared.extend(strings(&case["emits"]));
    }
    for group in ["cases", "operations"] {
        for case in hostile[group].as_array().unwrap() {
            declared.extend(strings(&case["emits"]));
        }
    }
    let rows: BTreeSet<String> = matrix()
        .iter()
        .map(|row| format!("{}: {}", row.validator, row.code))
        .collect();
    let missing: Vec<&String> = rows.difference(&declared).collect();
    assert!(missing.is_empty(), "no corpus case exercises {missing:?}");
    let unknown: Vec<&String> = declared.difference(&rows).collect();
    assert!(
        unknown.is_empty(),
        "the corpus names rows the matrix lacks: {unknown:?}"
    );
}

#[test]
fn imported_metadata_records_where_it_came_from_and_never_invents_what_it_lacks() {
    use openblog_core::source_interchange::{plan_csl_import, ImportAction};
    let none = BTreeMap::new();
    let empty = SourceLibrary::default();
    let plan = plan_csl_import(&empty, IMPORT, &none).expect("a readable file");
    assert!(plan.is_applicable(), "{plan:?}");
    // Each record says which item it came from, by a stable id.
    let by_csl = |id: &str| {
        plan.entries
            .iter()
            .find(|entry| entry.csl_id.as_deref() == Some(id))
            .unwrap_or_else(|| panic!("{id}"))
    };
    assert_eq!(
        by_csl("vale-lanterns-1801").source_id.as_deref(),
        Some("vale-lanterns-1801")
    );
    assert_eq!(by_csl("notes-on-lamps").action, ImportAction::Create);
    // What the library has no field for is listed as not imported, and private notes never are.
    let lost: Vec<&str> = by_csl("vale-lanterns-1801")
        .unsupported
        .iter()
        .map(|loss| loss.field.as_str())
        .collect();
    assert!(
        lost.contains(&"abstract") && lost.contains(&"note"),
        "{lost:?}"
    );

    let library = plan.apply(&empty, &none).expect("applies");
    let stored = library.to_json();
    assert!(
        !stored.contains("Synthetic private"),
        "private notes were imported"
    );
    // A bare item stays bare: no DOI, date, creator or language is made up for it.
    let bare = library.get("notes-on-lamps").unwrap();
    assert!(bare.identifiers.is_empty() && bare.creators.is_empty());
    assert!(bare.issued.is_none() && bare.language.is_none());
    // Importing the same file again changes nothing.
    let again = plan_csl_import(&library, IMPORT, &none).unwrap();
    assert!(again
        .entries
        .iter()
        .all(|entry| entry.action == ImportAction::Unchanged));
    assert_eq!(again.apply(&library, &none).unwrap().to_json(), stored);
    // The translation's translator is the one the item named, and it keeps its own kind.
    let translation = library.get("quill-lanterns-1902").unwrap();
    assert_eq!(translation.creators[0].name, "Mara Quill");
    // What is missing is then prompted by the review, never filled in by it.
    let prompts = openblog_core::source_review::review_library(&library, &Notebook::default());
    assert!(
        prompts
            .iter()
            .all(|prompt| prompt.id.as_deref() != Some("notes-on-lamps")),
        "a bare work is valid and unprompted"
    );
    assert_eq!(library.to_json(), stored);
}

#[test]
fn a_hostile_import_changes_nothing_in_a_corpus_library() {
    use openblog_core::source_interchange::plan_csl_import;
    let none = BTreeMap::new();
    let corpus = hostile();
    let library =
        SourceLibrary::parse(&corpus["base"]["library"].to_string(), &none).expect("library");
    let before = library.to_json();
    let plan = plan_csl_import(&library, HOSTILE_IMPORT, &none).expect("a readable file");
    assert!(!plan.is_applicable(), "hostile items conflict");
    assert!(plan.apply(&library, &none).is_err());
    assert_eq!(library.to_json(), before);
    for entry in &plan.entries {
        for diagnostic in &entry.diagnostics {
            assert!(!diagnostic.message.contains("<script>"), "{diagnostic:?}");
        }
    }
}

#[test]
fn the_author_documentation_explains_every_finding_in_every_row() {
    let docs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/research-checks.md"),
    )
    .expect("docs/research-checks.md");
    for row in matrix() {
        let code = format!("`{}`", row.code);
        assert!(
            docs.contains(&code),
            "docs/research-checks.md never explains {code} ({})",
            row.validator
        );
    }
    for needed in [
        "Acknowledging",
        "never resolved",
        "private",
        "Nothing is filled in",
    ] {
        assert!(
            docs.contains(needed),
            "the documentation lacks \"{needed}\""
        );
    }
}
