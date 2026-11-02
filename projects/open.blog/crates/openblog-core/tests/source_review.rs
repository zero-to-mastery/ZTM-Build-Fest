//! Source review (ADR 0148): identifier, version, quotation-location and
//! citation-consistency diagnostics over posts, the source library and the
//! notebook. Every finding is an advisory prompt scoped to one object, the
//! review is offline and deterministic, nothing is normalized in place or
//! filled in, and nothing private reaches a finding.

use std::collections::{BTreeMap, BTreeSet};

use openblog_core::model::LibrarySource;
use openblog_core::research::EvidenceOutcome;
use openblog_core::research_completeness::{
    matrix, Acknowledgement, AcknowledgementState, Check, CompletenessFinding, CompletenessReport,
    Gate, ObjectKind, Validator,
};
use openblog_core::research_notes::Notebook;
use openblog_core::source_interchange::plan_csl_import;
use openblog_core::source_library::SourceLibrary;
use openblog_core::source_review::{
    review_library, review_post, ReviewObject, SourceReviewCode as Code, SourceReviewFinding,
};
use openblog_core::{LoadOptions, Site, SiteConfig, SourceFile, Sources};
use serde_json::{json, Value};

/// Authored text and private identifier values no finding may carry.
const SECRET: &str = "ob-source-review-secret";

fn library_value() -> Value {
    json!({"version": 1, "sources": [
        {"id": "republic", "kind": "work", "title": format!("{SECRET} Πολιτεία"),
         "creators": [{"name": "Plato", "role": "author", "note": format!("{SECRET} note")}]},
        {"id": "burnet", "kind": "edition", "of": "republic", "title": "Platonis Opera",
         "volumes": 5,
         "identifiers": [{"scheme": "doi", "value": "10.1000/burnet"},
                         {"scheme": "isbn", "value": "978-0-19-924849-0"},
                         {"scheme": "my-drive", "value": format!("C:/{SECRET}/scan.pdf")}]},
        {"id": "burnet-vol2", "kind": "reference", "of": "burnet",
         "location": {"scheme": "page", "value": "41", "volume": "2"}},
        {"id": "chapter", "kind": "reference", "of": "burnet",
         "identifiers": [{"scheme": "isbn", "value": "9780199248490"}]},
        {"id": "grube", "kind": "translation", "of": "republic", "language": "en",
         "title": "Republic", "creators": [{"name": "G. M. A. Grube", "role": "translator"}]},
        {"id": "jowett", "kind": "translation", "of": "republic", "language": "en",
         "title": format!("{SECRET} The Republic")},
        {"id": "anon-tr", "kind": "translation", "of": "republic", "language": "la",
         "title": "Respublica", "anonymous": true},
        {"id": "paris", "kind": "witness", "of": "republic", "title": "Paris gr. 1807",
         "repository": "Bibliothèque nationale de France"},
        {"id": "vat", "kind": "witness", "of": "republic", "title": "Vat. gr. 1",
         "repository": "Biblioteca Apostolica Vaticana", "shelfmark": "Vat. gr. 1"},
        {"id": "dup", "kind": "work", "title": "Duplicate",
         "identifiers": [{"scheme": "doi", "value": "https://doi.org/10.1000/BURNET"}]},
        {"id": "isbn10", "kind": "work", "title": "Ten",
         "identifiers": [{"scheme": "isbn", "value": "0-19-924849-4"}]},
        {"id": "twodoi", "kind": "work", "title": "Two",
         "identifiers": [{"scheme": "doi", "value": "10.1000/preprint"},
                         {"scheme": "doi", "value": "10.1000/published"}]},
        {"id": "iliad", "kind": "work", "title": "Iliad",
         "identifiers": [{"scheme": "isbn", "value": "978-0-14-027536-0"}]},
        {"id": "iliad-ed", "kind": "edition", "of": "iliad", "title": "Iliad"},
        {"id": "bare", "kind": "work", "title": "Bare", "csl": {"type": "article-journal"}},
        {"id": "lecture", "kind": "work", "title": "Lecture"},
        {"id": "old", "kind": "work", "title": "Old", "archived": true,
         "identifiers": [{"scheme": "doi", "value": "10.1000/burnet"}]}
    ]})
}

fn library() -> SourceLibrary {
    SourceLibrary::parse(&library_value().to_string(), &BTreeMap::new())
        .unwrap_or_else(|d| panic!("valid library: {d:?}"))
}

fn passage(id: &str, source: &str, locators: Value) -> Value {
    json!({"id": id, "source": source, "excerpt": {"text": format!("{SECRET} excerpt {id}")},
           "locators": locators})
}

fn notebook(library: &SourceLibrary) -> Notebook {
    let mut archived = passage("p-archived", "grube", json!([]));
    archived["archived"] = json!(true);
    Notebook::parse(
        &json!({"version": 1, "passages": [
            passage("p-located", "grube", json!([{"kind": "page", "value": "186"}])),
            passage("p-no-volume", "burnet", json!([{"kind": "page", "value": "12"}])),
            passage("p-volume", "burnet", json!([{"kind": "x-csl-volume", "value": "2"},
                                                 {"kind": "page", "value": "12"}])),
            passage("p-unlocated", "grube", json!([])),
            archived,
            passage("p-bad-volume", "burnet", json!([{"kind": "x-csl-volume", "value": "9"},
                                                     {"kind": "page", "value": "1"}]))
        ], "notes": [{"id": "n", "kind": "question", "text": format!("{SECRET} note"),
                      "passages": ["p-located"]}]})
        .to_string(),
        library,
    )
    .unwrap_or_else(|d| panic!("valid notebook: {d:?}"))
}

fn post(body: &str) -> Vec<SourceReviewFinding> {
    let library = library();
    review_post("posts/p.md", body, 1, || Ok(Some(&library)))
}

fn codes(findings: &[SourceReviewFinding]) -> Vec<Code> {
    findings.iter().map(|f| f.code).collect()
}

fn library_findings() -> Vec<SourceReviewFinding> {
    let library = library();
    review_library(&library, &notebook(&library))
}

fn find(findings: &[SourceReviewFinding], code: Code, id: &str) -> SourceReviewFinding {
    findings
        .iter()
        .find(|f| f.code == code && f.id.as_deref() == Some(id))
        .unwrap_or_else(|| panic!("{code} on {id} in {findings:#?}"))
        .clone()
}

#[test]
fn works_without_dois_or_any_identifier_stay_valid_and_unprompted() {
    let findings = library_findings();
    for id in ["republic", "bare", "lecture", "grube", "vat"] {
        assert!(
            findings.iter().all(|f| f.id.as_deref() != Some(id)),
            "{id}: {findings:#?}"
        );
    }
    // A post citing works without identifiers, with locations, reviews clean.
    assert_eq!(
        post("---\n---\nA claim [@bare] and a place [@lecture, timestamp 1:02:03].\n"),
        []
    );
}

#[test]
fn identifiers_that_conflict_or_are_shared_report_both_records_and_change_neither() {
    let library = library();
    let before = library.to_json();
    let findings = review_library(&library, &notebook(&library));
    assert_eq!(library.to_json(), before, "the review changes nothing");

    // Two forms of one DOI on two records: the later record is scoped, the
    // earlier one related, and the archived holder is left out.
    let shared = find(&findings, Code::IdentifierShared, "dup");
    assert_eq!(shared.related, ["burnet"]);
    assert_eq!(shared.outcome, EvidenceOutcome::NeedsReview);
    assert_eq!(shared.field.as_deref(), Some("identifiers"));
    assert_eq!(shared.index, Some(9));
    assert!(shared.message.contains("`dup`") && shared.message.contains("`burnet`"));
    assert!(findings.iter().all(|f| f.id.as_deref() != Some("old")));

    // An ISBN-10 meets its ISBN-13, without either being rewritten.
    let ten = find(&findings, Code::IdentifierShared, "isbn10");
    assert_eq!(ten.related, ["burnet", "chapter"]);
    assert!(library.to_json().contains("0-19-924849-4"));

    // A reference into a book shares the book's ISBN by design.
    assert!(findings.iter().all(|f| f.id.as_deref() != Some("chapter")));

    // Two DOIs on one record.
    let conflict = find(&findings, Code::IdentifierConflict, "twodoi");
    assert!(conflict.message.contains("identifiers[0], identifiers[1]"));
    assert_eq!(conflict.outcome, EvidenceOutcome::Potential);

    // An ISBN on a work whose edition is recorded, but not on one without.
    let on_work = find(&findings, Code::IdentifierOnWork, "iliad");
    assert_eq!(on_work.related, ["iliad-ed"]);
    assert!(findings
        .iter()
        .all(|f| !(f.code == Code::IdentifierOnWork && f.id.as_deref() == Some("isbn10"))));

    // No value of any identifier is ever printed or serialized.
    let text = serde_json::to_string(&findings).unwrap();
    for value in ["10.1000", "924849", "BURNET", "027536", SECRET] {
        assert!(!text.contains(value), "{value} in {text}");
    }
}

#[test]
fn version_details_a_kind_needs_are_prompted_and_never_filled_in() {
    let findings = library_findings();
    let translator = find(&findings, Code::TranslatorMissing, "jowett");
    assert_eq!(translator.field.as_deref(), Some("creators"));
    assert_eq!(translator.outcome, EvidenceOutcome::Potential);
    assert!(findings.iter().all(|f| f.id.as_deref() != Some("anon-tr")));
    let witness = find(&findings, Code::WitnessUnidentified, "paris");
    assert_eq!(witness.field.as_deref(), Some("shelfmark"));
    assert!(witness.message.contains("no shelfmark"));
}

#[test]
fn imported_metadata_keeps_its_import_record_and_gains_no_detail() {
    let library = library();
    let csl = json!([{"id": "imported-tr", "type": "book", "title": "Politeia, translated",
                      "language": "de", "custom": {"openblog-kind": "translation",
                                                   "openblog-of": "republic"}}]);
    let plan = plan_csl_import(&library, &csl.to_string(), &BTreeMap::new()).expect("plan");
    let imported = plan.apply(&library, &BTreeMap::new()).expect("applies");
    let record = imported.get("imported-tr").expect("imported record");
    assert!(record.creators.is_empty());
    let before = imported.to_json();
    let findings = review_library(&imported, &Notebook::default());
    let prompt = find(&findings, Code::TranslatorMissing, "imported-tr");
    assert!(prompt.message.contains("Nothing is filled in"));
    // The review never wrote a translator, or anything else, into the record.
    assert_eq!(imported.to_json(), before);
    assert!(imported.get("imported-tr").unwrap().creators.is_empty());
}

#[test]
fn a_quotation_requires_a_location_without_any_claim_that_the_words_are_there() {
    let missing = post("---\n---\n> The unexamined life.\n> [@grube]\n");
    assert_eq!(codes(&missing), [Code::QuotationLocatorMissing]);
    let prompt = &missing[0];
    assert_eq!(prompt.object, ReviewObject::Post);
    assert_eq!(
        (prompt.path.as_deref(), prompt.line),
        (Some("posts/p.md"), Some(4))
    );
    assert!(prompt
        .message
        .contains("never that the quoted words are there"));
    assert_eq!(prompt.outcome, EvidenceOutcome::Potential);

    // A citation after the quotation, on its own line after a dash.
    assert_eq!(
        codes(&post("---\n---\n> The cave.\n\n— [@grube]\n")),
        [Code::QuotationLocatorMissing]
    );
    // Inline quotations in straight, curly and guillemet marks, with Unicode.
    for body in [
        "He said \"τὸ ἀγαθόν\" [@grube].\n",
        "He said “the good” [@grube].\n",
        "Il dit « le bien » [@grube].\n",
        "Er sagt „das Gute“ [@grube].\n",
        "She wrote *“the good”* [@grube].\n",
    ] {
        assert_eq!(
            codes(&post(body)),
            [Code::QuotationLocatorMissing],
            "{body}"
        );
    }
    // A citation that attributes no quotation needs no location.
    assert_eq!(post("The good is discussed [@grube].\n"), []);
    // A GitHub alert is a callout, not a quotation.
    assert_eq!(post("> [!NOTE]\n> See [@grube].\n"), []);
    // A citation inside code is not a citation.
    assert_eq!(post("> `[@grube]`\n"), []);
}

#[test]
fn every_kind_of_location_is_read_by_its_precision() {
    for precise in [
        "page 186",
        "line 3",
        "canonical 514a",
        "page 186 to 187",
        "x-stephanus 514a",
    ] {
        assert_eq!(
            post(&format!("> Words.\n> [@grube, {precise}]\n")),
            [],
            "{precise}"
        );
    }
    assert_eq!(post("> Words.\n> [@vat, folio 12r]\n"), []);
    assert_eq!(post("> Words.\n> [@lecture, timestamp 0:41]\n"), []);
    for broad in ["chapter 7", "section 2", "chapter 7; section 2"] {
        let findings = post(&format!("> Words.\n> [@grube, {broad}]\n"));
        assert_eq!(codes(&findings), [Code::QuotationLocationBroad], "{broad}");
        assert_eq!(findings[0].outcome, EvidenceOutcome::NeedsReview);
    }
    // A volume alone is not a location in the volume.
    assert_eq!(
        codes(&post("> Words.\n> [@burnet, x-csl-volume 2]\n")),
        [Code::QuotationLocatorMissing]
    );
    // A reference record that gives its own location locates the quotation.
    assert_eq!(post("> Words.\n> [@burnet-vol2]\n"), []);
}

#[test]
fn a_quotation_of_a_work_whose_versions_are_recorded_asks_which_version() {
    let findings = post("> Words.\n> [@republic, canonical 514a]\n");
    assert_eq!(codes(&findings), [Code::VersionUnspecified]);
    let related: BTreeSet<&str> = findings[0].related.iter().map(String::as_str).collect();
    assert_eq!(
        related,
        BTreeSet::from(["burnet", "grube", "jowett", "anon-tr", "paris", "vat"])
    );
    // A work recorded with no versions is its own text.
    assert_eq!(post("> Words.\n> [@lecture, timestamp 12]\n"), []);
}

#[test]
fn a_page_in_a_version_in_several_volumes_needs_its_volume() {
    let missing = post("See [@burnet, page 41].\n");
    assert_eq!(codes(&missing), [Code::VolumeMissing]);
    assert_eq!(missing[0].outcome, EvidenceOutcome::Detected);
    assert_eq!(missing[0].related, ["burnet"]);
    assert!(missing[0].message.contains("5 volumes"));
    assert_eq!(post("See [@burnet, x-csl-volume 2; page 41].\n"), []);
    assert_eq!(post("See [@burnet, canonical 514a].\n"), []);
    assert_eq!(post("See [@burnet-vol2, page 42].\n"), []);
    assert_eq!(
        codes(&post("See [@burnet, x-csl-volume 6; page 41].\n")),
        [Code::VolumeUnknown]
    );
    // The chapter reference carries no volume, so its page needs one.
    assert_eq!(
        codes(&post("See [@chapter, page 3].\n")),
        [Code::VolumeMissing]
    );

    // Passages are checked the same way, scoped to the passage.
    let findings = library_findings();
    let passage = find(&findings, Code::VolumeMissing, "p-no-volume");
    assert_eq!(passage.object, ReviewObject::Passage);
    assert_eq!(passage.index, Some(1));
    assert_eq!(passage.related, ["burnet"]);
    find(&findings, Code::VolumeUnknown, "p-bad-volume");
    assert!(findings
        .iter()
        .all(|f| f.id.as_deref() != Some("p-volume") && f.id.as_deref() != Some("p-located")));
    let unlocated = find(&findings, Code::PassageLocatorMissing, "p-unlocated");
    assert_eq!(unlocated.related, ["grube"]);
    assert!(findings
        .iter()
        .all(|f| f.id.as_deref() != Some("p-archived")));
}

#[test]
fn repeated_citations_are_compared_for_identifiers_and_versions() {
    // The same version cited again and again, at different places, agrees.
    assert_eq!(
        post("A [@grube, page 1]. B [@grube, page 2]. C [@grube, line 9].\n"),
        []
    );
    // Two references into one edition read the same version.
    assert_eq!(
        post("A [@burnet-vol2]. B [@burnet, x-csl-volume 1; page 1].\n"),
        []
    );

    // Two versions of one work, named once, at the second version's line.
    let mixed = post("A [@grube, page 1].\nB [@jowett, page 2].\nC [@grube, page 3].\n");
    assert_eq!(codes(&mixed), [Code::CitationVersionsMixed]);
    assert_eq!(mixed[0].line, Some(2));
    assert_eq!(mixed[0].related, ["grube", "jowett"]);
    // The work and one of its versions are mixed too.
    assert_eq!(
        codes(&post(
            "A [@republic, canonical 514a]. B [@grube, page 1].\n"
        )),
        [Code::CitationVersionsMixed]
    );

    // Two records with the same DOI.
    let same = post("A [@burnet, canonical 1].\nB [@dup].\n");
    assert_eq!(codes(&same), [Code::CitationSameIdentifier]);
    assert_eq!(same[0].related, ["dup", "burnet"]);
    assert!(same[0].message.contains("doi"));
    // A reference and its book sharing an ISBN are one source by design.
    assert_eq!(
        post("A [@burnet, canonical 1]. B [@chapter, canonical 2].\n"),
        []
    );
}

#[test]
fn malformed_unknown_or_offline_input_reviews_nothing_and_never_panics() {
    // Malformed citations and unknown keys are citation review's.
    assert_eq!(post("> Words [@Not A Key] and [@nobody].\n"), []);
    // Without a library, or with one that cannot be read, nothing is reviewed.
    assert_eq!(
        review_post("posts/p.md", "> W.\n> [@grube]\n", 1, || Ok(None)),
        []
    );
    assert_eq!(
        review_post("posts/p.md", "> W.\n> [@grube]\n", 1, || Err(
            "broken".into()
        )),
        []
    );
    // A post that cites nothing never asks for the library.
    assert_eq!(
        review_post(
            "posts/p.md",
            "> Just a quotation.\n",
            1,
            || -> Result<Option<&SourceLibrary>, String> { panic!("the library was read") }
        ),
        []
    );
}

/// A small deterministic generator, so the property tests need no crate.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[(self.next() % items.len() as u64) as usize]
    }
}

fn random_body(rng: &mut Rng) -> String {
    let keys = [
        "grube",
        "jowett",
        "burnet",
        "burnet-vol2",
        "chapter",
        "republic",
        "dup",
        "vat",
        "bare",
        "lecture",
        "nobody",
        "Bad Key",
    ];
    let locators = [
        "",
        ", page 4",
        ", chapter 2",
        ", section 1",
        ", line 3",
        ", folio 2v",
        ", timestamp 1:05",
        ", x-csl-volume 2; page 9",
        ", x-csl-volume 0",
        ", canonical 514a",
        ", page",
    ];
    let shapes = [
        "> «ἀρετή» quoted\n> [@{k}{l}]\n",
        "Said “{k}” [@{k}{l}].\n",
        "Plain [@{k}{l}] text.\n",
        "> A quote.\n\n— [@{k}{l}]\n",
        "`[@{k}{l}]` in code\n",
        "> [!TIP]\n> [@{k}{l}]\n",
        "\n",
    ];
    let mut body = String::new();
    for _ in 0..(rng.next() % 8) {
        let shape = rng.pick(&shapes);
        let key = rng.pick(&keys);
        let locator = rng.pick(&locators);
        body.push_str(&shape.replace("{k}", key).replace("{l}", locator));
    }
    body
}

#[test]
fn property_reviews_are_deterministic_ordered_advisory_and_move_with_their_lines() {
    let library = library();
    let mut rng = Rng(0x5eed_1234_abcd_ef01);
    for _ in 0..300 {
        let body = random_body(&mut rng);
        let first = review_post("posts/p.md", &body, 1, || Ok(Some(&library)));
        let again = review_post("posts/p.md", &body, 1, || Ok(Some(&library)));
        assert_eq!(first, again, "{body}");
        let lines: Vec<usize> = first.iter().filter_map(|f| f.line).collect();
        assert!(lines.windows(2).all(|w| w[0] <= w[1]), "{body}");
        for finding in &first {
            let mapped = CompletenessFinding::from_source_review(finding);
            assert_eq!(mapped.gate, Gate::Advisory);
            assert_eq!(mapped.validator, Validator::SourceReview);
            assert!(!finding.message.contains(SECRET));
        }
        // Two paragraphs added above move every finding two lines down and
        // change no fingerprint, so no acknowledgement goes stale.
        let shifted = review_post("posts/p.md", &format!("Intro.\n\n{body}"), 1, || {
            Ok(Some(&library))
        });
        assert_eq!(shifted.len(), first.len(), "{body}");
        for (a, b) in first.iter().zip(&shifted) {
            assert_eq!(a.line.map(|l| l + 2), b.line, "{body}");
            assert_eq!(
                CompletenessFinding::from_source_review(a).fingerprint(),
                CompletenessFinding::from_source_review(b).fingerprint(),
                "{body}"
            );
        }
    }
}

#[test]
fn findings_map_into_the_contract_scoped_to_one_object_and_carry_nothing_private() {
    let mut all = library_findings();
    all.extend(post(
        "> Words.\n> [@grube]\nSee [@burnet, page 4] and [@jowett, chapter 2] and [@dup].\n> W.\n> [@republic]\n",
    ));
    let rows = matrix();
    let found: BTreeSet<Code> = all.iter().map(|f| f.code).collect();
    assert_eq!(
        found.len(),
        Code::ALL.len(),
        "every code is exercised: {found:?}"
    );
    for finding in &all {
        let mapped = CompletenessFinding::from_source_review(finding);
        let row = rows
            .iter()
            .find(|row| row.validator == Validator::SourceReview && row.code == mapped.code)
            .unwrap_or_else(|| panic!("no row for {}", mapped.code));
        assert_eq!(
            (row.check, row.category, row.outcome, row.gate),
            (
                mapped.check,
                mapped.category,
                finding.outcome,
                Gate::Advisory
            )
        );
        assert_eq!(finding.code.outcome(), row.outcome);
        assert_eq!(mapped.check.owner(), Validator::SourceReview);
        let kind = match finding.object {
            ReviewObject::Post => ObjectKind::Post,
            ReviewObject::Source => ObjectKind::Source,
            ReviewObject::Passage => ObjectKind::Passage,
        };
        assert_eq!(mapped.scope.object, kind);
        match finding.object {
            ReviewObject::Post => assert!(finding.path.is_some() && finding.line.is_some()),
            _ => assert!(finding.id.is_some() && finding.index.is_some()),
        }
        assert!(mapped.related.iter().all(|r| r.kind == ObjectKind::Source));
        assert!(!finding.repair.is_empty());
    }
    let checks: BTreeSet<Check> = all
        .iter()
        .map(|f| CompletenessFinding::from_source_review(f).check)
        .collect();
    assert_eq!(
        checks,
        BTreeSet::from([
            Check::IdentifierCompatibility,
            Check::VersionIdentity,
            Check::QuotationLocation,
            Check::CitationConsistency
        ])
    );
    let report =
        CompletenessReport::new(all.iter().map(CompletenessFinding::from_source_review), &[])
            .to_json();
    for private in [SECRET, "10.1000", "924849", "Πολιτεία", "excerpt"] {
        assert!(!report.contains(private), "{private} in {report}");
    }
}

#[test]
fn an_acknowledged_prompt_goes_stale_only_when_what_it_states_changes() {
    let quoted = |body: &str| {
        post(body)
            .iter()
            .map(CompletenessFinding::from_source_review)
            .collect::<Vec<_>>()
    };
    let before = quoted("> The cave.\n> [@grube, chapter 7]\n");
    let ack = Acknowledgement::of(&before[0]).expect("advisory");
    let moved = quoted("Intro.\n\n> The cave.\n> [@grube, chapter 7]\n");
    let report = CompletenessReport::new(moved, std::slice::from_ref(&ack));
    assert_eq!(
        report.findings[0].acknowledgement,
        Some(AcknowledgementState::Current)
    );
    let other = quoted("> The cave.\n> [@grube, chapter 8]\n");
    let report = CompletenessReport::new(other, std::slice::from_ref(&ack));
    assert_eq!(
        report.findings[0].acknowledgement,
        Some(AcknowledgementState::Stale)
    );
}

fn own_library(sources: Value) -> SourceLibrary {
    SourceLibrary::parse(
        &json!({"version": 1, "sources": sources}).to_string(),
        &BTreeMap::new(),
    )
    .unwrap_or_else(|d| panic!("valid library: {d:?}"))
}

fn siblings() -> SourceLibrary {
    own_library(json!([
        {"id": "text", "kind": "work", "title": "Text"},
        {"id": "book", "kind": "edition", "of": "text", "title": "Book", "volumes": 3,
         "identifiers": [{"scheme": "isbn", "value": "9780199248490"}]},
        {"id": "chap-a", "kind": "reference", "of": "book",
         "identifiers": [{"scheme": "isbn", "value": "9780199248490"}]},
        {"id": "chap-b", "kind": "reference", "of": "book",
         "identifiers": [{"scheme": "isbn", "value": "978-0-19-924849-0"}]},
        {"id": "other", "kind": "work", "title": "Other",
         "identifiers": [{"scheme": "isbn", "value": "9780199248490"}]}
    ]))
}

#[test]
fn sibling_chapters_of_one_edition_share_its_isbn_by_design() {
    let library = siblings();
    let cited = review_post(
        "posts/p.md",
        "A [@chap-a, canonical 1]. B [@chap-b, canonical 2].\n",
        1,
        || Ok(Some(&library)),
    );
    assert_eq!(cited, []);
    let findings = review_library(&library, &Notebook::default());
    let shared: Vec<&str> = findings
        .iter()
        .filter(|f| f.code == Code::IdentifierShared)
        .filter_map(|f| f.id.as_deref())
        .collect();
    // Only the unrelated work is told it shares the ISBN, never a chapter.
    assert_eq!(shared, ["other"]);
    let other = find(&findings, Code::IdentifierShared, "other");
    assert_eq!(other.related, ["book", "chap-a", "chap-b"]);
    // An unrelated record with the same ISBN is still reported in a post.
    let mixed = review_post(
        "posts/p.md",
        "A [@chap-a, canonical 1]. B [@other, canonical 2].\n",
        1,
        || Ok(Some(&library)),
    );
    assert_eq!(codes(&mixed), [Code::CitationSameIdentifier]);
}

#[test]
fn a_cited_volume_is_checked_against_the_reference_and_the_edition() {
    // The reference gives volume 2: the same volume agrees, another differs.
    assert_eq!(post("See [@burnet-vol2, x-csl-volume 2; page 42].\n"), []);
    let differs = post("See [@burnet-vol2, x-csl-volume 3; page 42].\n");
    assert_eq!(codes(&differs), [Code::VolumeUnknown]);
    assert!(differs[0].message.contains("volume 3") && differs[0].message.contains("volume 2"));
    assert_eq!(differs[0].related, ["burnet"]);
    // The library refuses a reference volume the edition lacks, so a cited
    // volume past the count is checked against the count alone.
    let library = own_library(json!([
        {"id": "w", "kind": "work", "title": "W"},
        {"id": "ed", "kind": "edition", "of": "w", "title": "Ed", "volumes": 2},
        {"id": "ref2", "kind": "reference", "of": "ed",
         "location": {"scheme": "page", "value": "1", "volume": "2"}}
    ]));
    let unknown = review_post(
        "posts/p.md",
        "See [@ref2, x-csl-volume 9; page 1].\n",
        1,
        || Ok(Some(&library)),
    );
    assert_eq!(codes(&unknown), [Code::VolumeUnknown]);
    let agrees = review_post("posts/p.md", "See [@ref2, page 1].\n", 1, || {
        Ok(Some(&library))
    });
    assert_eq!(agrees, []);
}

#[test]
fn an_inline_quotations_fingerprint_is_its_quoted_span_only() {
    let quoted = |body: &str| {
        post(body)
            .iter()
            .map(CompletenessFinding::from_source_review)
            .collect::<Vec<_>>()
    };
    let before = quoted("As he put it, \u{201c}the cave.\u{201d} [@grube, chapter 7]\n");
    assert_eq!(before.len(), 1);
    let ack = Acknowledgement::of(&before[0]).expect("advisory");
    for body in [
        "Other words entirely, and then \u{201c}the cave.\u{201d} [@grube, chapter 7]\n",
        "Intro.\n\nAs he\nput it, \u{201c}the cave.\u{201d}\n[@grube, chapter 7]\n",
    ] {
        let found = quoted(body);
        let report = CompletenessReport::new(found, std::slice::from_ref(&ack));
        assert_eq!(
            report.findings[0].acknowledgement,
            Some(AcknowledgementState::Current),
            "{body}"
        );
    }
    let changed = quoted("As he put it, \u{201c}the sun.\u{201d} [@grube, chapter 7]\n");
    let report = CompletenessReport::new(changed, std::slice::from_ref(&ack));
    assert_eq!(
        report.findings[0].acknowledgement,
        Some(AcknowledgementState::Stale)
    );
}

fn site(body: &str) -> Site {
    let config = SiteConfig::from_json(
        r#"{"title": "T", "url": "https://example.test", "language": "en",
            "author": {"name": "A"}}"#,
    )
    .unwrap();
    Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: "posts/p.md".into(),
                contents: body.into(),
            }],
            source_library: Some(LibrarySource::Text(SourceFile {
                path: ".openblog/private/research/sources.json".into(),
                contents: library_value().to_string(),
            })),
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"))
}

#[test]
fn legacy_posts_are_unchanged_and_opted_in_posts_are_reviewed_with_the_site() {
    let body = "\n> Words.\n> [@grube]\n";
    // A legacy research post that never opted in to citations.
    let legacy = site(&format!(
        "---\ntitle: Old\ndate: 2026-01-01\nprofile: research\n---{body}"
    ));
    assert!(legacy.source_review.is_empty());
    let cited = site(&format!(
        "---\ntitle: New\ndate: 2026-01-01\ncitations: notes\n---{body}"
    ));
    assert_eq!(codes(&cited.source_review), [Code::QuotationLocatorMissing]);
    // Placed in the post's file, after its front matter.
    assert_eq!(cited.source_review[0].line, Some(7));
    // Nothing of it reaches the generated site.
    let files = openblog_core::generate(&cited, &openblog_core::ThemeSet::new()).unwrap();
    for file in files {
        assert!(
            !file.contents.contains("quotation-locator-missing"),
            "{}",
            file.path
        );
    }
}
