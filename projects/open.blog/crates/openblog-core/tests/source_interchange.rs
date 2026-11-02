use std::collections::{BTreeMap, BTreeSet};

use openblog_core::source_interchange::{
    export_bibtex, export_csl_json, plan_csl_import, ImportAction, ImportPlan, MAX_IMPORT_BYTES,
    MAX_IMPORT_ITEMS,
};
use openblog_core::source_library::{SourceDiagnosticCode, SourceLibrary};
use serde_json::{json, Value};

const ZOTERO: &str = include_str!("../../../tests/fixtures/source-interchange/zotero-export.json");
const NAMES: &str = include_str!("../../../tests/fixtures/source-interchange/names-and-dates.json");
const HOSTILE: &str = include_str!("../../../tests/fixtures/source-interchange/hostile.json");

const RICH: &str = r#"{
  "version": 1,
  "exportedBy": {"tool": "future-open.blog"},
  "sources": [
    {"id": "plato-republic", "kind": "work", "title": "Πολιτεία", "language": "grc",
     "issued": "c. 375 BCE", "subjects": ["justice"],
     "creators": [{"name": "Plato", "role": "author", "sortName": "Plato"}]},
    {"id": "republic-slings-2003", "kind": "edition", "of": "plato-republic",
     "title": "Platonis Rempublicam", "issued": "2003",
     "creators": [{"name": "S. R. Slings", "role": "editor"}, {"name": "Anon"}],
     "identifiers": [{"scheme": "isbn", "value": "978-0-19-924849-0", "note": "OCT"},
                     {"scheme": "isbn", "value": "0-8044-2957-X"},
                     {"scheme": "oclc", "value": "52614331"},
                     {"scheme": "doi", "value": "10.1093/actrade/9780199248490.book.1"}],
     "publisher": {"name": "Oxford University Press"},
     "csl": {"type": "book", "publisher": "OUP", "edition": "1", "legacy": "kept"}},
    {"id": "republic-bloom", "kind": "translation", "of": "plato-republic",
     "basedOn": "republic-slings-2003", "title": "The Republic of Plato", "language": "en",
     "issued": "1968-05/1969",
     "creators": [{"name": "Allan Bloom", "role": "translator", "family": "Bloom", "given": "Allan"},
                  {"name": "Scribe Hand", "role": "scribe"}]},
    {"id": "paris-gr-1807", "kind": "witness", "of": "plato-republic", "archived": true,
     "title": "Paris, Bibliothèque nationale de France, gr. 1807",
     "identifiers": [{"scheme": "url", "value": "https://gallica.bnf.fr/ark:/12148/btv1b10721251j"}]},
    {"id": "cave-allegory", "kind": "reference", "of": "republic-slings-2003",
     "location": {"scheme": "canonical", "value": "514a–520a", "system": "Stephanus"},
     "readerFacing": false}
  ]
}"#;

fn none() -> BTreeMap<String, openblog_core::contributor::Contributor> {
    BTreeMap::new()
}

fn library(text: &str) -> SourceLibrary {
    SourceLibrary::parse(text, &none()).expect("fixture library is valid")
}

fn preview(library: &SourceLibrary, text: &str) -> ImportPlan {
    plan_csl_import(library, text, &none()).expect("readable import")
}

fn applied(library: &SourceLibrary, plan: &ImportPlan) -> SourceLibrary {
    plan.apply(library, &none()).expect("plan applies")
}

fn actions(plan: &ImportPlan) -> Vec<ImportAction> {
    plan.entries.iter().map(|entry| entry.action).collect()
}

#[test]
fn dry_run_previews_creates_and_unsupported_fields_without_changing_the_library() {
    let empty = SourceLibrary::default();
    let before = empty.to_json();
    let plan = preview(&empty, ZOTERO);
    assert_eq!(plan.counts.create, 1);
    assert_eq!(empty.to_json(), before);
    let entry = &plan.entries[0];
    assert_eq!(
        entry.csl_id.as_deref(),
        Some("http://zotero.org/users/1/items/ABCD2345")
    );
    assert_eq!(
        entry.source_id.as_deref(),
        Some("http-zotero-org-users-1-items-abcd2345")
    );
    let lost: Vec<&str> = entry
        .unsupported
        .iter()
        .map(|loss| loss.field.as_str())
        .collect();
    assert_eq!(lost, ["abstract", "accessed", "keyword", "note"]);
    assert!(entry.unsupported[0].reason.contains("never imported"));
}

#[test]
fn private_notes_never_reach_the_library_or_an_export() {
    let empty = SourceLibrary::default();
    let library = applied(&empty, &preview(&empty, ZOTERO));
    let stored = library.to_json();
    for private in ["private reading note", "my own annotation", "justice; city"] {
        assert!(!stored.contains(private), "{private}");
        assert!(!export_csl_json(&library).content.contains(private));
        assert!(!export_bibtex(&library).content.contains(private));
    }
    let record = library
        .get("http-zotero-org-users-1-items-abcd2345")
        .unwrap();
    assert_eq!(record.extra["csl"]["type"], "book");
    assert_eq!(record.extra["csl"]["number-of-pages"], 487);
    assert_eq!(record.issued.as_deref(), Some("1968-05"));
    assert_eq!(record.language.as_deref(), Some("en-US"));
    assert_eq!(record.creators.len(), 2);
    assert_eq!(record.creators[1].role.as_deref(), Some("translator"));
}

#[test]
fn names_dates_unicode_and_identifiers_map_with_stable_ids() {
    let empty = SourceLibrary::default();
    let plan = preview(&empty, NAMES);
    assert_eq!(plan.counts.conflict, 0, "{:?}", plan.entries);
    let library = applied(&empty, &plan);

    let letters = library.get("van-beethoven-letters").unwrap();
    let names: Vec<&str> = letters.creators.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "Ludwig van Beethoven",
            "Martin Luther King, Jr.",
            "World Health Organization",
            "Jürgen Müller"
        ]
    );
    assert_eq!(letters.creators[1].extra["suffix"], "Jr.");
    assert_eq!(letters.creators[3].role.as_deref(), Some("editor"));
    assert_eq!(letters.issued.as_deref(), Some("1810-03-07"));
    let schemes: Vec<&str> = letters
        .identifiers
        .iter()
        .map(|i| i.scheme.as_str())
        .collect();
    assert_eq!(schemes, ["doi", "issn", "url"]);
    let unsupported: Vec<&str> = plan.entries[0]
        .unsupported
        .iter()
        .map(|loss| loss.field.as_str())
        .collect();
    assert_eq!(unsupported, ["author[2].comma-suffix"]);

    // A non-ASCII id has no slug; it gets a short stable digest instead.
    let greek = plan.entries[1].source_id.clone().unwrap();
    assert!(greek.starts_with("csl-") && greek.len() == 20, "{greek}");
    assert_eq!(
        preview(&empty, NAMES).entries[1].source_id.as_deref(),
        Some(greek.as_str())
    );
    assert_eq!(
        library.get(&greek).unwrap().title.as_deref(),
        Some("Πολιτεία")
    );
    assert_eq!(
        library.get(&greek).unwrap().issued.as_deref(),
        Some("c. 375 BCE")
    );

    let span = library.get("span").unwrap();
    assert_eq!(span.issued.as_deref(), Some("2003/2005-06"));
    assert_eq!(span.extra["csl"]["issue"], 3);
    assert_eq!(span.extra["csl"]["container-title"], "Journal of Tests");
    assert_eq!(plan.entries[2].unsupported[0].field, "issued.season");
    assert_eq!(
        library.get("raw-date").unwrap().issued.as_deref(),
        Some("Spring 1999")
    );
}

#[test]
fn reimport_is_idempotent_and_leaves_the_stored_bytes_identical() {
    let empty = SourceLibrary::default();
    let first = applied(&empty, &preview(&empty, NAMES));
    let second_plan = preview(&first, NAMES);
    assert_eq!(second_plan.counts.unchanged, 4);
    assert_eq!(second_plan.counts.create + second_plan.counts.update, 0);
    assert!(!second_plan.has_changes());
    assert_eq!(applied(&first, &second_plan).to_json(), first.to_json());
}

#[test]
fn export_then_import_restores_every_record_and_is_a_no_op_on_the_source() {
    let source = library(RICH);
    let export = export_csl_json(&source);
    assert!(export.losses.is_empty());
    assert_eq!(export.count, 5);

    let back = preview(&source, &export.content);
    assert_eq!(
        actions(&back),
        vec![ImportAction::Unchanged; 5],
        "{:?}",
        back.entries
    );

    // Into an empty library every record, including archived state, unknown
    // fields, annotated identifiers, a scribe, and a bare creator, returns.
    let empty = SourceLibrary::default();
    let restored = applied(&empty, &preview(&empty, &export.content));
    for record in &source.sources {
        assert_eq!(restored.get(&record.id), Some(record), "{}", record.id);
    }
}

#[test]
fn edition_and_translation_records_import_in_any_order_and_check_relationships() {
    let items = json!([
        {"id": "republic-bloom", "type": "book", "title": "The Republic of Plato", "language": "en",
         "custom": {"openblog-kind": "translation", "openblog-of": "plato-republic",
                    "openblog-basedOn": "republic-slings-2003"}},
        {"id": "republic-slings-2003", "type": "book", "title": "Platonis Rempublicam",
         "edition": "OCT", "custom": {"openblog-kind": "edition", "openblog-of": "plato-republic"}},
        {"id": "plato-republic", "type": "book", "title": "Πολιτεία"}
    ]);
    let empty = SourceLibrary::default();
    let plan = preview(&empty, &items.to_string());
    assert_eq!(plan.counts.create, 3, "{:?}", plan.entries);
    let library = applied(&empty, &plan);
    assert_eq!(
        library.get("republic-bloom").unwrap().based_on.as_deref(),
        Some("republic-slings-2003")
    );

    let dangling = json!([{"id": "e", "title": "Edition",
        "custom": {"openblog-kind": "edition", "openblog-of": "nowhere"}}]);
    let plan = preview(&empty, &dangling.to_string());
    assert_eq!(plan.entries[0].action, ImportAction::Conflict);
    assert_eq!(
        plan.entries[0].diagnostics[0].code,
        SourceDiagnosticCode::UnresolvedRelationship
    );
    assert!(plan.apply(&empty, &none()).is_err());
}

#[test]
fn a_plain_reimport_never_discards_richer_open_blog_metadata() {
    let rich = library(RICH);
    let incoming = json!([{
        "id": "republic-slings-2003", "type": "book", "title": "Platonis Rempublicam (corrected)",
        "editor": [{"literal": "S. R. Slings"}],
        "DOI": "https://doi.org/10.1093/ACTRADE/9780199248490.book.1"
    }]);
    let plan = preview(&rich, &incoming.to_string());
    let entry = &plan.entries[0];
    assert_eq!(entry.action, ImportAction::Update);
    let changed: Vec<&str> = entry.changes.iter().map(|c| c.field.as_str()).collect();
    assert_eq!(changed, ["title"], "{:?}", entry.changes);
    assert_eq!(entry.changes[0].before, Some(json!("Platonis Rempublicam")));
    for kept in ["of", "issued", "publisher"] {
        assert!(
            entry.kept.iter().any(|field| field == kept),
            "{kept} in {:?}",
            entry.kept
        );
    }

    let after = applied(&rich, &plan);
    let record = after.get("republic-slings-2003").unwrap();
    let before = rich.get("republic-slings-2003").unwrap();
    assert_eq!(
        record.title.as_deref(),
        Some("Platonis Rempublicam (corrected)")
    );
    assert_eq!(record.of, before.of);
    assert_eq!(record.creators, before.creators);
    assert_eq!(record.identifiers, before.identifiers);
    assert_eq!(record.extra, before.extra);
    // Records the file never mentioned, and their order, are untouched.
    assert_eq!(after.sources.len(), rich.sources.len());
    assert_eq!(after.get("cave-allegory"), rich.get("cave-allegory"));
    assert_eq!(after.extra, rich.extra);
    // Importing the same file again changes nothing.
    assert_eq!(preview(&after, &incoming.to_string()).counts.unchanged, 1);
}

#[test]
fn an_import_cannot_change_a_records_kind() {
    let rich = library(RICH);
    let incoming = json!([{"id": "plato-republic", "title": "x",
        "custom": {"openblog-kind": "reference", "openblog-of": "republic-slings-2003"}}]);
    let plan = preview(&rich, &incoming.to_string());
    assert_eq!(plan.entries[0].action, ImportAction::Conflict);
    assert_eq!(
        plan.entries[0].diagnostics[0].code,
        SourceDiagnosticCode::KindChanged
    );
    assert!(plan.apply(&rich, &none()).is_err());
}

#[test]
fn duplicates_are_conflicts_scoped_to_the_items() {
    let rich = library(RICH);
    let incoming = json!([
        {"id": "Twin", "title": "One"},
        {"id": "twin", "title": "Two"},
        {"id": "other-edition", "title": "Same ISBN, new id", "ISBN": "9780199248490"},
        {"id": "a", "title": "A", "DOI": "10.5555/shared"},
        {"id": "b", "title": "B", "DOI": "https://doi.org/10.5555/SHARED"},
        {"id": "fine", "title": "Fine"}
    ]);
    let plan = preview(&rich, &incoming.to_string());
    assert_eq!(
        actions(&plan),
        [
            ImportAction::Conflict,
            ImportAction::Conflict,
            ImportAction::Conflict,
            ImportAction::Create,
            ImportAction::Conflict,
            ImportAction::Create
        ]
    );
    assert_eq!(
        plan.entries[2].duplicate_of.as_deref(),
        Some("republic-slings-2003")
    );
    assert_eq!(plan.entries[4].duplicate_of.as_deref(), Some("a"));
    assert_eq!(
        plan.entries[0].diagnostics[0].code,
        SourceDiagnosticCode::DuplicateId
    );
    // One conflict blocks the whole apply, and the library stays as it was.
    let before = rich.to_json();
    assert!(plan.apply(&rich, &none()).is_err());
    assert_eq!(rich.to_json(), before);
}

#[test]
fn hostile_items_are_refused_individually_with_scoped_diagnostics() {
    let empty = SourceLibrary::default();
    let plan = preview(&empty, HOSTILE);
    let by_id = |id: &str| {
        plan.entries
            .iter()
            .find(|e| e.source_id.as_deref() == Some(id))
            .unwrap_or_else(|| panic!("no entry for {id}"))
    };

    // A traversal-shaped id is only ever a slug, and markup stays inert text.
    assert_eq!(by_id("etc-passwd").action, ImportAction::Create);
    let library = applied(
        &empty,
        &preview(
            &empty,
            r#"[{"id":"../../etc/passwd","title":"<script>alert(1)</script>"}]"#,
        ),
    );
    assert_eq!(
        library.get("etc-passwd").unwrap().title.as_deref(),
        Some("<script>alert(1)</script>")
    );

    for (id, field) in [
        ("js-link", "identifiers[0]"),
        ("creds", "identifiers[0]"),
        ("ctrl", "title"),
        ("smuggled", "credits"),
        ("shadow", "custom.openblog-extra.title"),
        ("date", "issued"),
        ("isbn", "identifiers[0]"),
        ("kind", "kind"),
    ] {
        let entry = by_id(id);
        assert_eq!(entry.action, ImportAction::Conflict, "{id}");
        assert!(
            entry
                .diagnostics
                .iter()
                .any(|d| d.field.as_deref().is_some_and(|f| f.contains(field))),
            "{id}: {:?}",
            entry.diagnostics
        );
        assert!(entry
            .diagnostics
            .iter()
            .all(|d| d.source_id.as_deref() == Some(id)));
    }
    assert!(by_id("smuggled")
        .diagnostics
        .iter()
        .any(|d| d.code == SourceDiagnosticCode::ContributorCredit));
    // Unknown keys are reported and never stored.
    assert!(by_id("proto")
        .unsupported
        .iter()
        .any(|l| l.field == "__proto__"));
    assert!(by_id("proto")
        .unsupported
        .iter()
        .any(|l| l.field == "constructor"));

    assert_eq!(
        plan.entries[10].diagnostics[0].code,
        SourceDiagnosticCode::MissingField
    );
    assert_eq!(plan.entries[11].action, ImportAction::Conflict);

    assert!(!plan.is_applicable());
    assert!(plan.apply(&empty, &none()).is_err());
    assert_eq!(empty.to_json(), SourceLibrary::default().to_json());
}

#[test]
fn unreadable_files_are_refused_whole() {
    let empty = SourceLibrary::default();
    let code = |text: &str| plan_csl_import(&empty, text, &none()).unwrap_err()[0].code;
    assert_eq!(code("not json"), SourceDiagnosticCode::InvalidJson);
    assert_eq!(code("{\"id\": \"x\"}"), SourceDiagnosticCode::InvalidField);
    assert_eq!(
        code(&" ".repeat(MAX_IMPORT_BYTES + 1)),
        SourceDiagnosticCode::TooLarge
    );
    let many = format!("[{}]", vec!["{}"; MAX_IMPORT_ITEMS + 1].join(","));
    assert_eq!(code(&many), SourceDiagnosticCode::TooLarge);
    let deep = format!("{}{}", "[".repeat(5_000), "]".repeat(5_000));
    assert_eq!(code(&deep), SourceDiagnosticCode::InvalidJson);
    // A byte-order mark from an editor is ignored.
    assert!(plan_csl_import(&empty, "\u{feff}[]", &none()).is_ok());
}

#[test]
fn oversized_text_is_a_conflict_not_a_stored_value() {
    let empty = SourceLibrary::default();
    let long = "x".repeat(1_001);
    let items =
        json!([{"id": "long", "title": long}, {"id": "pub", "title": "T", "publisher": long}]);
    let plan = preview(&empty, &items.to_string());
    assert_eq!(plan.counts.conflict, 2);
}

// --- export -----------------------------------------------------------------

/// The CSL JSON 1.0.2 contract the export promises: an array of items with a
/// string `id` and `type`, name variables as arrays of name objects, dates as
/// `date-parts` or `literal`, and scalar text variables.
fn assert_csl_contract(content: &str) {
    let items: Vec<Value> = serde_json::from_str(content).expect("valid JSON");
    let mut ids = BTreeSet::new();
    for item in &items {
        let item = item.as_object().expect("item object");
        assert!(item["id"].is_string() && item["type"].is_string());
        assert!(
            ids.insert(item["id"].as_str().unwrap().to_string()),
            "unique ids"
        );
        for (key, value) in item {
            match key.as_str() {
                "author" | "editor" | "translator" => {
                    for name in value.as_array().expect("names are arrays") {
                        let name = name.as_object().expect("name object");
                        assert!(
                            name.contains_key("literal")
                                || name.contains_key("family")
                                || name.contains_key("given")
                        );
                        assert!(name.values().all(Value::is_string));
                    }
                }
                "issued" => {
                    let date = value.as_object().expect("date object");
                    match (date.get("date-parts"), date.get("literal")) {
                        (Some(parts), None) => {
                            for half in parts.as_array().unwrap() {
                                let half = half.as_array().unwrap();
                                assert!(
                                    (1..=3).contains(&half.len()) && half.iter().all(Value::is_u64)
                                );
                            }
                        }
                        (None, Some(literal)) => assert!(literal.is_string()),
                        other => panic!("bad date {other:?}"),
                    }
                }
                "custom" => assert!(value.is_object()),
                "id" | "type" | "title" | "language" | "DOI" | "ISBN" | "ISSN" | "URL" | "PMID"
                | "PMCID" => assert!(value.is_string(), "{key}"),
                _ => assert!(value.is_string() || value.is_number(), "{key}"),
            }
        }
    }
}

#[test]
fn csl_export_is_deterministic_and_satisfies_the_csl_contract() {
    let source = library(RICH);
    let first = export_csl_json(&source);
    assert_eq!(first, export_csl_json(&source));
    assert!(first.content.ends_with("}\n]\n"));
    assert_csl_contract(&first.content);
    let items: Vec<Value> = serde_json::from_str(&first.content).unwrap();
    let ids: Vec<&str> = items.iter().map(|i| i["id"].as_str().unwrap()).collect();
    assert_eq!(
        ids,
        [
            "plato-republic",
            "republic-slings-2003",
            "republic-bloom",
            "paris-gr-1807",
            "cave-allegory"
        ]
    );
    assert_eq!(items[1]["ISBN"], "0-8044-2957-X");
    assert_eq!(items[1]["type"], "book");
    assert_eq!(items[0]["type"], "document");
    assert_eq!(
        items[2]["issued"],
        json!({"date-parts": [[1968, 5], [1969]]})
    );
    assert_eq!(items[0]["issued"], json!({"literal": "c. 375 BCE"}));
    assert_eq!(
        items[2]["translator"],
        json!([{"family": "Bloom", "given": "Allan"}])
    );
    assert_eq!(items[0]["author"], json!([{"literal": "Plato"}]));
    assert_eq!(items[1]["custom"]["openblog-kind"], "edition");
    assert_eq!(
        items[4]["custom"]["openblog-location"]["system"],
        "Stephanus"
    );
    // The same library reached by a different parse path exports identically.
    assert_eq!(
        export_csl_json(&library(&source.to_json())).content,
        first.content
    );
    let empty = SourceLibrary::default();
    assert_csl_contract(&export_csl_json(&applied(&empty, &preview(&empty, NAMES))).content);
}

#[test]
fn editing_the_standard_fields_elsewhere_wins_over_the_envelope() {
    let source = library(RICH);
    let mut items: Vec<Value> = serde_json::from_str(&export_csl_json(&source).content).unwrap();
    items[1]["author"] = json!([{"literal": "New Editor"}]);
    let plan = preview(&source, &Value::Array(items).to_string());
    let entry = &plan.entries[1];
    assert!(entry
        .unsupported
        .iter()
        .any(|l| l.field == "custom.openblog-creators"));
    let after = applied(&source, &plan);
    let creators = &after.get("republic-slings-2003").unwrap().creators;
    assert_eq!(creators.len(), 3, "added, never removed: {creators:?}");
    assert_eq!(creators[2].name, "New Editor");
}

#[test]
fn bibtex_export_is_deterministic_escaped_and_reports_what_it_omits() {
    let source = library(RICH);
    let export = export_bibtex(&source);
    assert_eq!(export, export_bibtex(&source));
    // Roles are written author, editor, translator.
    assert!(
        export.content.contains(
            "@book{republic-slings-2003,\n  author = {{Anon}},\n  editor = {{S. R. Slings}},\n  title = {Platonis Rempublicam},\n  publisher = {OUP},\n  edition = {1},\n  year = {2003},\n  isbn = {978-0-19-924849-0, 0-8044-2957-X},\n  doi = {10.1093/actrade/9780199248490.book.1},\n}\n"
        ),
        "{}",
        export.content
    );
    assert!(export.content.contains("translator = {Bloom, Allan}"));
    assert!(export.content.contains("year = {1968-05/1969}"));
    assert!(export.content.contains(
        "@misc{plato-republic,\n  author = {{Plato}},\n  title = {Πολιτεία},\n  year = {c. 375 BCE},\n  language = {grc},\n}"
    ));

    let loss = |id: &str, field: &str| {
        export
            .losses
            .iter()
            .any(|l| l.source_id == id && l.field == field)
    };
    assert!(loss("republic-slings-2003", "kind") && loss("republic-slings-2003", "of"));
    assert!(loss("republic-slings-2003", "identifiers"));
    assert!(loss("republic-slings-2003", "extra"));
    assert!(
        loss("republic-bloom", "basedOn")
            && loss("republic-bloom", "creators[1]")
            && loss("republic-bloom", "issued")
    );
    assert!(loss("cave-allegory", "location"));
    assert!(loss("paris-gr-1807", "archived"));

    // Every entry is balanced and well formed.
    for entry in export.content.split("\n\n") {
        let opens = entry.matches('{').count() - entry.matches("\\{").count();
        let closes = entry.matches('}').count() - entry.matches("\\}").count();
        assert_eq!(opens, closes, "{entry}");
        assert!(entry.starts_with('@') && entry.trim_end().ends_with('}'));
    }
}

#[test]
fn bibtex_special_characters_cannot_break_an_entry() {
    let items = json!([{
        "id": "tricky", "type": "chapter",
        "title": "R&D 100% {braced} \\ $5_a #1 ^ ~ line",
        "author": [{"literal": "Smith and Jones, Inc."}, {"family": "O'Brien, Jr", "given": "Pat"}],
        "container-title": "Book {of} Things",
        "URL": "https://example.org/a_b?x={y}&z=%20",
        "issued": {"date-parts": [[2020, 2, 29]]}
    }]);
    let empty = SourceLibrary::default();
    let plan = preview(&empty, &items.to_string());
    assert_eq!(plan.counts.conflict, 0, "{:?}", plan.entries);
    let library = applied(&empty, &plan);
    let export = export_bibtex(&library);
    let content = &export.content;
    assert!(content.starts_with("@incollection{tricky,\n"));
    assert!(
        content.contains("author = {{Smith and Jones, Inc.} and {O'Brien, Jr}, Pat},"),
        "{content}"
    );
    assert!(
        content.contains(
            "title = {R\\&D 100\\% \\textbraceleft{}braced\\textbraceright{} \\textbackslash{} \\$5\\_a \\#1 \\^{} \\~{} line},"
        ),
        "{content}"
    );
    assert!(content.contains("booktitle = {Book \\textbraceleft{}of\\textbraceright{} Things},"));
    assert!(content.contains("url = {https://example.org/a_b?x=%7By%7D&z=%20},"));
    assert!(content.contains("year = {2020},\n  month = feb,"));
    assert!(export
        .losses
        .iter()
        .any(|l| l.field == "issued" && l.reason.contains("day")));
}

fn two_sources() -> SourceLibrary {
    library(
        r#"{"version": 1, "sources": [
        {"id": "a", "kind": "work", "title": "A"},
        {"id": "b", "kind": "work", "title": "B", "identifiers": [{"scheme": "doi", "value": "10.1000/xyz"}]}
    ]}"#,
    )
}

#[test]
fn an_update_cannot_copy_an_identifier_another_record_holds() {
    let base = two_sources();
    let plan = preview(&base, r#"[{"id":"a","title":"A","DOI":"10.1000/xyz"}]"#);
    assert_eq!(plan.counts.conflict, 1, "{:?}", plan.entries);
    assert_eq!(plan.entries[0].duplicate_of.as_deref(), Some("b"));
    assert!(plan.apply(&base, &none()).is_err());
}

#[test]
fn an_update_and_a_create_cannot_share_a_new_identifier() {
    let base = two_sources();
    let plan = preview(
        &base,
        r#"[{"id":"a","title":"A","DOI":"10.2000/new"},{"id":"c","title":"C","DOI":"10.2000/new"}]"#,
    );
    assert_eq!(plan.counts.update, 1, "{:?}", plan.entries);
    assert_eq!(plan.counts.conflict, 1, "{:?}", plan.entries);
    assert_eq!(plan.entries[1].duplicate_of.as_deref(), Some("a"));
}

#[test]
fn a_partial_item_updates_a_stored_record_without_standalone_validation() {
    let base = two_sources();
    let plan = preview(&base, r#"[{"id":"a","DOI":"10.2000/new"}]"#);
    assert_eq!(plan.counts.conflict, 0, "{:?}", plan.entries);
    assert_eq!(plan.counts.update, 1);
    let next = applied(&base, &plan);
    assert_eq!(next.get("a").unwrap().title.as_deref(), Some("A"));
    assert_eq!(next.get("a").unwrap().identifiers.len(), 1);
}

#[test]
fn openblog_extra_cannot_smuggle_private_notes_or_control_text() {
    let empty = SourceLibrary::default();
    let hostile = json!([{"id": "d", "title": "D", "custom": {"openblog-extra": {
        "csl": {"note": "PRIVATE-NOTE", "abstract": "PRIVATE-ABS", "publisher": "x\u{7}y", "volume": "3"},
        "annote": "PRIVATE2"
    }}}])
    .to_string();
    let plan = preview(&empty, &hostile);
    assert_eq!(plan.counts.conflict, 1, "{:?}", plan.entries);
    let clean = hostile.replace("x\\u0007y", "xy");
    let plan = preview(&empty, &clean);
    assert_eq!(plan.counts.create, 1, "{:?}", plan.entries);
    let library = applied(&empty, &plan);
    for out in [
        library.to_json(),
        export_csl_json(&library).content,
        export_bibtex(&library).content,
    ] {
        for private in ["PRIVATE-NOTE", "PRIVATE-ABS", "PRIVATE2"] {
            assert!(!out.contains(private), "{private}");
        }
    }
    assert_eq!(library.get("d").unwrap().extra["csl"]["volume"], "3");
}

#[test]
fn lone_braces_keep_bibtex_fields_balanced() {
    let empty = SourceLibrary::default();
    let items = json!([{"id": "t", "type": "chapter", "title": "Open { brace and } close",
        "container-title": "Lone }{ pair {"}]);
    let library = applied(&empty, &preview(&empty, &items.to_string()));
    let content = export_bibtex(&library).content;
    let (mut depth, mut min) = (0i32, 0i32);
    for c in content.chars() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            _ => {}
        }
        min = min.min(depth);
    }
    assert_eq!((depth, min), (0, 0), "{content}");
    assert!(
        content.contains(r"Open \textbraceleft{} brace"),
        "{content}"
    );
}
