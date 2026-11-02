//! The research-completeness contract (ADR 0146, ADR 0147): every existing
//! research check maps into one finding shape and one matrix; each check has
//! exactly one owning validator; detected, potential and needs-review stay
//! apart and nothing is scored; findings are object-scoped, ordered the same
//! whatever order they arrive in, deduplicated, and safe to print; and an
//! acknowledgement never makes a finding resolved and goes stale when what
//! the finding says changes.

use std::collections::{BTreeMap, BTreeSet};

use openblog_core::alignment::AlignmentSet;
use openblog_core::chronology_index::ChronologyIndex;
use openblog_core::citation_review::review_citations;
use openblog_core::claim_review::{review_claims, ReviewContext};
use openblog_core::claims::ClaimSet;
use openblog_core::comparison_publication::{ComparisonInputs, PublicComparisons};
use openblog_core::context_links::{find_context_links, review_context_links, ContextGap};
use openblog_core::frontmatter;
use openblog_core::knowledge_atlas::{Atlas, Links};
use openblog_core::publication_review::PublicationReview;
use openblog_core::research::{
    audit_document, EvidenceCode, EvidenceFinding, EvidenceOutcome, EvidenceSource,
};
use openblog_core::research_completeness::{
    acknowledgeable, matrix, Acknowledgement, AcknowledgementSet, AcknowledgementState, Category,
    Check, CompletenessFinding, CompletenessReport, Gate, MatrixRow, ObjectKind, ObjectRef,
    Validator, COMPLETENESS_FORMAT_VERSION, CONTEXT_LINK_UNPUBLISHED, FILE_UNREADABLE,
};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use openblog_core::source_review::{review_library, review_post};
use serde_json::{json, Value};

/// Authored text no finding may carry.
const SECRET: &str = "ob-completeness-secret";

fn library() -> SourceLibrary {
    SourceLibrary::parse(
        &json!({"version": 1, "sources": [
            {"id": "republic", "kind": "work", "title": "Politeia",
             "creators": [{"name": "Plato", "role": "author"}]},
            {"id": "burnet", "kind": "edition", "of": "republic", "title": "Platonis Opera",
             "rights": {"status": "publicDomain", "note": format!("{SECRET} rights note")}},
            {"id": "grube", "kind": "translation", "of": "republic", "title": "Republic", "language": "en",
             "rights": {"status": "rightsReserved"}},
            {"id": "bare", "kind": "work", "title": "Bare", "csl": {"type": "article-journal"}},
            {"id": "old", "kind": "work", "title": format!("{SECRET} old title"), "archived": true}
        ]})
        .to_string(),
        &BTreeMap::new(),
    )
    .expect("library")
}

fn notebook(library: &SourceLibrary) -> Notebook {
    Notebook::parse(
        &json!({"version": 1, "passages": [
            {"id": "p-burnet", "source": "burnet", "excerpt": {"text": format!("{SECRET} greek")},
             "locators": [{"kind": "canonical", "value": "514a"}]},
            {"id": "p-grube", "source": "grube", "excerpt": {"text": format!("{SECRET} reserved")},
             "locators": [{"kind": "page", "value": "186"}]}
        ], "notes": [{"id": "n", "kind": "question", "text": format!("{SECRET} note"),
                      "passages": ["p-burnet"]}]})
        .to_string(),
        library,
    )
    .expect("notebook")
}

fn research_findings() -> Vec<EvidenceFinding> {
    let source = "---\ntitle: T\nprofile: research\ndoi: nope\n---\nBody[^1] text.\n";
    let doc = frontmatter::parse(source).expect("front matter");
    audit_document("posts/r.md", &doc.front_matter, &doc.body, doc.body_line)
}

fn citation_findings(body: &str) -> Vec<EvidenceFinding> {
    let library = library();
    review_citations("posts/c.md", body, 1, || Ok(Some(&library)))
}

const CITED: &str = "\
A [@burnet, canonical 514a] place.\nBad [@Not A Key] syntax.\nUnknown [@nobody] and [@nobody-else] keys.\nA bare article [@bare].\n";

const DRAFT: &str = "The cave and the line.";

fn claims_value() -> Value {
    json!({"version": 1,
    "claims": [
        {"id": "c1", "post": "cave", "statement": format!("{SECRET} statement"),
         "anchor": {"start": 4, "end": 8, "text": "cave"}},
        {"id": "c2", "post": "cave", "statement": "S",
         "anchor": {"start": 0, "end": 4, "text": "gone"}}
    ],
    "links": [
        {"id": "l1", "claim": "c1", "relation": "supports", "evidence": {"source": "old"},
         "visibility": "approved", "rationale": format!("{SECRET} rationale")}
    ]})
}

fn claims(library: &SourceLibrary, notebook: &Notebook) -> ClaimSet {
    ClaimSet::parse(&claims_value().to_string(), Links { library, notebook }).expect("claims")
}

fn claim_findings() -> Vec<EvidenceFinding> {
    let library = library();
    let notebook = notebook(&library);
    let set = claims(&library, &notebook);
    let drafts = BTreeMap::from([("cave".to_string(), DRAFT.to_string())]);
    let paths = BTreeMap::from([("cave".to_string(), "posts/cave.md".to_string())]);
    review_claims(
        &set,
        &ReviewContext {
            drafts: &drafts,
            paths: &paths,
            claims_file: ".openblog/private/research/claims.json",
            library: &library,
            notebook: &notebook,
        },
    )
}

fn atlas(value: Value) -> Atlas {
    let library = library();
    Atlas::parse(
        &value.to_string(),
        Links {
            library: &library,
            notebook: &Notebook::default(),
        },
    )
    .unwrap_or_else(|d| panic!("valid atlas: {d:?}"))
}

fn notice_atlas() -> Atlas {
    atlas(json!({"version": 2, "entries": [
        {"id": "plato", "kind": "person", "label": format!("{SECRET} label")},
        {"id": "politeia", "kind": "work", "label": "Politeia", "source": "republic",
         "visibility": "approved"}
    ], "relationships": [
        {"id": "wrote", "kind": "authored", "from": "plato", "to": "politeia",
         "assertedBy": {"kind": "author"}, "evidence": [{"source": "republic"}],
         "visibility": "approved"}
    ]}))
}

fn dating(id: &str, aspect: &str, date: Value) -> Value {
    json!({"id": id, "aspect": aspect, "date": date,
        "assertedBy": {"kind": "source", "source": "republic"},
        "evidence": [{"source": "republic"}], "note": format!("{SECRET} dating note")})
}

fn chronology_atlas(death_year: i32) -> Atlas {
    atlas(json!({"version": 2, "entries": [
        {"id": "plato", "kind": "person", "label": format!("{SECRET} label"), "dates": [
            dating("born", "birth", json!({"notBefore": {"year": -400}})),
            dating("died", "death", json!({"notAfter": {"year": death_year}}))
        ]}
    ], "relationships": []}))
}

fn alignments_value() -> Value {
    json!({"version": 1, "alignments": [
        {"id": "cave", "label": "The cave", "correspondence": "partial", "visibility": "approved",
         "members": [
            {"source": "burnet", "passage": "p-burnet",
             "locators": [{"kind": "canonical", "value": "514b"}],
             "note": format!("{SECRET} member note")},
            {"source": "grube", "passage": "p-grube"}
         ],
         "rationale": "Both render 514a.", "confidence": "plausible",
         "recordedBy": {"kind": "named", "name": "A concordance"}}
    ]})
}

struct Alignments {
    notices: Vec<CompletenessFinding>,
    withheld: Vec<CompletenessFinding>,
}

fn alignments() -> Alignments {
    let library = library();
    let notebook = notebook(&library);
    let links = Links {
        library: &library,
        notebook: &notebook,
    };
    let set = AlignmentSet::parse(&alignments_value().to_string(), links).expect("alignments");
    let published = PublicComparisons::project(
        &set,
        ComparisonInputs {
            library: &library,
            notebook: &notebook,
            contributors: &BTreeMap::new(),
        },
    )
    .expect("projection");
    Alignments {
        notices: set
            .notices(links)
            .iter()
            .map(CompletenessFinding::from_atlas_diagnostic)
            .collect(),
        withheld: CompletenessFinding::from_comparisons(&published),
    }
}

fn private_file_errors() -> Vec<CompletenessFinding> {
    let library = library();
    let mut findings = Vec::new();
    let notebook_errors = Notebook::parse(
        &json!({"version": 1, "passages": [
            {"id": "p", "source": "nowhere", "excerpt": {"text": format!("{SECRET} excerpt")}}
        ], "notes": []})
        .to_string(),
        &library,
    )
    .expect_err("unknown source");
    findings.extend(
        notebook_errors
            .iter()
            .map(CompletenessFinding::from_note_diagnostic),
    );
    let library_errors = SourceLibrary::parse(
        &json!({"version": 1, "sources": [
            {"id": "lost", "kind": "edition", "of": "missing", "title": format!("{SECRET} title")}
        ]})
        .to_string(),
        &BTreeMap::new(),
    )
    .expect_err("unresolved relationship");
    findings.extend(
        library_errors
            .iter()
            .map(CompletenessFinding::from_source_diagnostic),
    );
    let unreadable = SourceLibrary::parse("{", &BTreeMap::new()).expect_err("invalid json");
    findings.extend(
        unreadable
            .iter()
            .map(CompletenessFinding::from_source_diagnostic),
    );
    let atlas_errors = Atlas::parse(
        "[",
        Links {
            library: &library,
            notebook: &Notebook::default(),
        },
    )
    .expect_err("invalid json");
    findings.extend(
        atlas_errors
            .iter()
            .map(CompletenessFinding::from_atlas_diagnostic),
    );
    findings
}

/// Every finding every fixture produces, through the contract.
fn everything() -> Vec<CompletenessFinding> {
    let mut findings: Vec<CompletenessFinding> = research_findings()
        .iter()
        .chain(&citation_findings(CITED))
        .chain(&claim_findings())
        .map(CompletenessFinding::from_evidence)
        .collect();
    findings.extend(
        notice_atlas()
            .notices()
            .iter()
            .map(CompletenessFinding::from_atlas_diagnostic),
    );
    let library = library();
    let notebook = notebook(&library);
    findings.extend(
        claims(&library, &notebook)
            .notices()
            .iter()
            .map(CompletenessFinding::from_atlas_diagnostic),
    );
    findings.extend(
        ChronologyIndex::of(&chronology_atlas(-410))
            .prompts
            .iter()
            .map(CompletenessFinding::from_chronology_prompt),
    );
    let alignments = alignments();
    findings.extend(alignments.notices);
    findings.extend(alignments.withheld);
    findings.extend(private_file_errors());
    findings.extend(
        review_post(
            "posts/q.md",
            "> Quoted.\n> [@grube, chapter 7]\nAnd [@burnet, page 4].\n",
            1,
            || Ok(Some(&library)),
        )
        .iter()
        .chain(&review_library(&library, &notebook))
        .map(CompletenessFinding::from_source_review),
    );
    findings
}

fn row_of<'a>(rows: &'a [MatrixRow], finding: &CompletenessFinding) -> &'a MatrixRow {
    rows.iter()
        .find(|row| row.validator == finding.validator && row.code == finding.code)
        .unwrap_or_else(|| panic!("no matrix row for {} {}", finding.validator, finding.code))
}

#[test]
fn every_check_has_exactly_one_owner_and_every_row_belongs_to_it() {
    let rows = matrix();
    let mut seen = BTreeSet::new();
    for row in &rows {
        assert_eq!(row.validator, row.check.owner(), "{row:?}");
        assert!(
            seen.insert((row.validator, row.code.clone())),
            "{} {} is mapped twice",
            row.validator,
            row.code
        );
    }
    assert_eq!(
        Check::ALL.iter().collect::<BTreeSet<_>>().len(),
        Check::ALL.len()
    );
    for check in Check::ALL {
        let codes = rows.iter().filter(|row| row.check == check).count();
        match check.owner().planned_in() {
            Some(issue) => assert_eq!(codes, 0, "{check} is planned in #{issue}"),
            None => assert!(codes > 0, "{check} owns no code"),
        }
    }
    for validator in Validator::ALL {
        assert!(
            Check::ALL.iter().any(|check| check.owner() == validator),
            "{validator} owns no check"
        );
        assert!(!validator.entry_point().is_empty());
    }
    // A code is one check's, whichever row reports it: the same code under
    // two validators (`private-endpoint`) is two checks, never one shared.
    let mut owners: BTreeMap<(Validator, &str), BTreeSet<Check>> = BTreeMap::new();
    for row in &rows {
        owners
            .entry((row.validator, row.code.as_str()))
            .or_default()
            .insert(row.check);
    }
    assert!(owners.values().all(|checks| checks.len() == 1));
}

#[test]
fn atlas_family_rows_are_listed_only_under_the_files_that_report_them() {
    let rows = matrix();
    let codes = |validator: Validator| -> BTreeSet<&str> {
        rows.iter()
            .filter(|row| row.validator == validator)
            .map(|row| row.code.as_str())
            .collect()
    };
    let (atlas, claims, alignments) = (
        codes(Validator::Atlas),
        codes(Validator::Claims),
        codes(Validator::Alignments),
    );
    // Shared parsing and file codes are each file's own.
    for shared in [
        "invalid-json",
        "too-large",
        "unknown-source",
        "invalid-locator",
    ] {
        assert!(atlas.contains(shared) && claims.contains(shared) && alignments.contains(shared));
    }
    // A code only one file reports is never listed under another.
    for (only, owner) in [
        ("cycle", &atlas),
        ("endpoint-kind", &atlas),
        ("aspect-kind", &atlas),
        ("unpublished-datings", &atlas),
        ("anchor-mismatch", &claims),
        ("unknown-claim", &claims),
        ("undisclosed-contradiction", &claims),
        ("missing-original", &alignments),
        ("stale-locator", &alignments),
        ("archived-member", &alignments),
    ] {
        let listed = [&atlas, &claims, &alignments]
            .into_iter()
            .filter(|codes| codes.contains(only))
            .count();
        assert_eq!(listed, 1, "{only}");
        assert!(owner.contains(only), "{only}");
    }
    assert!(!alignments.contains("private-reference") && !alignments.contains("missing-evidence"));
    assert!(!claims.contains("wrong-source-kind") && !claims.contains("invalid-date"));
}

#[test]
fn the_rw9_hand_off_checks_each_name_one_check_and_one_owner() {
    let hand_off = [
        ("missing reference", Check::CitationResolution),
        ("reference completeness", Check::ReferenceCompleteness),
        ("identifier", Check::IdentifierCompatibility),
        ("locator", Check::LocationReview),
        ("imprecise quotation", Check::QuotationLocation),
        ("version or translation", Check::VersionIdentity),
        ("citation consistency", Check::CitationConsistency),
        ("evidence relation", Check::EvidenceRelation),
        ("rights", Check::ComparisonRights),
        ("unresolved claim", Check::ClaimAnchoring),
    ];
    let checks: BTreeSet<Check> = hand_off.iter().map(|(_, check)| *check).collect();
    assert_eq!(
        checks.len(),
        hand_off.len(),
        "each hand-off is its own check"
    );
    for (name, check) in hand_off {
        assert!(Check::ALL.contains(&check), "{name}");
        let owners: BTreeSet<Validator> = matrix()
            .iter()
            .filter(|row| row.check == check)
            .map(|row| row.validator)
            .chain([check.owner()])
            .collect();
        assert_eq!(owners.len(), 1, "{name} has one owner");
    }
    // #193 added its checks to one new validator, never to a presentation.
    assert_eq!(Check::VersionIdentity.owner(), Validator::SourceReview);
    assert!(Validator::ALL.iter().all(|v| v.planned_in().is_none()));
}

#[test]
fn outcomes_stay_distinct_and_only_detected_integrity_or_privacy_failures_refuse() {
    for row in matrix() {
        // A withheld item (a stale approval) leaves only itself out of the
        // build and is a prompt to re-check, so it keeps its needs-review
        // outcome; every refusal is a deterministic detection.
        if !matches!(row.gate, Gate::Advisory | Gate::Withholds) {
            assert_eq!(row.outcome, EvidenceOutcome::Detected, "{row:?}");
        }
        if row.outcome != EvidenceOutcome::Detected {
            assert!(
                matches!(row.gate, Gate::Advisory | Gate::Withholds),
                "{row:?}"
            );
        }
        if row.gate == Gate::Withholds {
            assert_eq!(row.code, "stale-approval", "{row:?}");
        }
        if row.gate == Gate::RefusesWhenPublished {
            assert_eq!(row.validator, Validator::CitationReview, "{row:?}");
        }
        if row.gate == Gate::Refuses {
            assert!(
                matches!(
                    row.check,
                    Check::LibraryIntegrity
                        | Check::NotebookIntegrity
                        | Check::AtlasIntegrity
                        | Check::ClaimsIntegrity
                        | Check::AlignmentsIntegrity
                        | Check::SelectionsIntegrity
                ),
                "{row:?}"
            );
        }
    }
    let outcomes: BTreeSet<String> = matrix().iter().map(|r| r.outcome.to_string()).collect();
    assert_eq!(
        outcomes,
        BTreeSet::from(["detected".into(), "needs-review".into(), "potential".into()])
    );
    let report = CompletenessReport::new(everything(), &[]);
    let counted = report.counts.detected.found
        + report.counts.potential.found
        + report.counts.needs_review.found;
    assert_eq!(counted, report.findings.len());
    for (outcome, count) in [
        (EvidenceOutcome::Detected, report.counts.detected.found),
        (EvidenceOutcome::Potential, report.counts.potential.found),
        (
            EvidenceOutcome::NeedsReview,
            report.counts.needs_review.found,
        ),
    ] {
        assert!(count > 0, "{outcome}");
        let listed = report
            .findings
            .iter()
            .filter(|e| e.finding.outcome == outcome)
            .count();
        assert_eq!(listed, count, "{outcome}");
    }
}

#[test]
fn every_existing_finding_maps_into_its_matrix_row_with_its_own_words() {
    let rows = matrix();
    let findings = everything();
    for finding in &findings {
        let row = row_of(&rows, finding);
        assert_eq!(
            (row.check, row.category, row.outcome, row.gate),
            (
                finding.check,
                finding.category,
                finding.outcome,
                finding.gate
            ),
            "{finding:#?}"
        );
        assert!(!finding.message.is_empty() && !finding.repair.is_empty());
    }
    let seen: BTreeSet<(Validator, &str)> = findings
        .iter()
        .map(|f| (f.validator, f.code.as_str()))
        .collect();
    for expected in [
        (Validator::ResearchProfile, "doi-invalid"),
        (Validator::ResearchProfile, "abstract-missing"),
        (Validator::ResearchProfile, "footnote-unresolved"),
        (Validator::CitationReview, "citation-syntax"),
        (Validator::CitationReview, "citation-unresolved"),
        (Validator::CitationReview, "citation-reference-incomplete"),
        (Validator::CitationReview, "citation-location-review"),
        (Validator::ClaimReview, "claim-anchor-stale"),
        (Validator::ClaimReview, "claim-source-archived"),
        (Validator::ClaimReview, "claim-evidence-missing"),
        (Validator::Atlas, "private-endpoint"),
        (Validator::Claims, "private-endpoint"),
        (Validator::ChronologyIndex, "death-before-birth"),
        (Validator::Alignments, "stale-locator"),
        (Validator::ComparisonProjection, "withheld-rights"),
        (Validator::Notebook, "unknown-source"),
        (Validator::SourceLibrary, "unresolved-relationship"),
        (Validator::SourceLibrary, "invalid-json"),
        (Validator::Atlas, "invalid-json"),
        (Validator::SourceReview, "quotation-location-broad"),
        (Validator::SourceReview, "citation-versions-mixed"),
        (Validator::SourceReview, "translator-missing"),
    ] {
        assert!(seen.contains(&expected), "{expected:?} in {seen:#?}");
    }

    // Codes, outcomes, messages and repairs are the validator's own.
    let original = &claim_findings()[0];
    let mapped = CompletenessFinding::from_evidence(original);
    assert_eq!(mapped.code, original.code.to_string());
    assert_eq!(mapped.outcome, original.outcome);
    assert_eq!(mapped.message, original.message);
    assert_eq!(mapped.repair, original.repair);
}

#[test]
fn findings_are_scoped_to_one_object_and_name_related_ones() {
    let findings = everything();
    let find = |validator: Validator, code: &str| {
        findings
            .iter()
            .find(|f| f.validator == validator && f.code == code)
            .unwrap_or_else(|| panic!("{validator} {code}"))
    };

    let doi = find(Validator::ResearchProfile, "doi-invalid");
    assert_eq!(doi.scope.object, ObjectKind::Post);
    assert_eq!(doi.scope.path.as_deref(), Some("posts/r.md"));
    assert_eq!(doi.scope.field.as_deref(), Some("doi"));

    let archived = find(Validator::ClaimReview, "claim-source-archived");
    assert_eq!(archived.scope.object, ObjectKind::EvidenceLink);
    assert_eq!(archived.scope.id.as_deref(), Some("l1"));
    assert_eq!(archived.scope.path.as_deref(), Some("posts/cave.md"));
    assert_eq!(
        archived.related,
        [ObjectRef {
            kind: ObjectKind::Claim,
            id: "c1".into()
        }]
    );

    let stale = find(Validator::ClaimReview, "claim-anchor-stale");
    assert_eq!(
        (stale.scope.object, stale.scope.id.as_deref()),
        (ObjectKind::Claim, Some("c2"))
    );

    let endpoint = find(Validator::Atlas, "private-endpoint");
    assert_eq!(
        (
            endpoint.scope.object,
            endpoint.scope.id.as_deref(),
            endpoint.scope.index,
            endpoint.scope.field.as_deref()
        ),
        (
            ObjectKind::Relationship,
            Some("wrote"),
            Some(0),
            Some("from")
        )
    );
    let link = find(Validator::Claims, "private-endpoint");
    assert_eq!(
        (link.scope.object, link.scope.id.as_deref()),
        (ObjectKind::EvidenceLink, Some("l1"))
    );
    assert_eq!(link.category, Category::PublicBoundary);

    let prompt = find(Validator::ChronologyIndex, "death-before-birth");
    assert_eq!(
        (prompt.scope.object, prompt.scope.id.as_deref()),
        (ObjectKind::Entry, Some("plato"))
    );
    let datings: Vec<&str> = prompt.related.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(datings, ["died", "born"]);
    assert!(prompt.related.iter().all(|r| r.kind == ObjectKind::Dating));

    let place = find(Validator::Alignments, "stale-locator");
    assert_eq!(
        (place.scope.object, place.scope.id.as_deref()),
        (ObjectKind::Alignment, Some("cave"))
    );
    assert_eq!(place.scope.field.as_deref(), Some("members[0].locators"));

    let withheld = find(Validator::ComparisonProjection, "withheld-rights");
    assert_eq!(
        (withheld.scope.object, withheld.scope.id.as_deref()),
        (ObjectKind::Alignment, Some("cave"))
    );
    assert_eq!(withheld.scope.field.as_deref(), Some("members[1]"));
    assert_eq!(
        withheld.related,
        [ObjectRef {
            kind: ObjectKind::Source,
            id: "grube".into()
        }]
    );
}

#[test]
fn missing_details_stay_missing_and_the_check_supplies_the_next_action() {
    let findings = private_file_errors();
    let library_file = findings
        .iter()
        .find(|f| f.validator == Validator::SourceLibrary && f.code == "invalid-json")
        .expect("library-level diagnostic");
    assert_eq!(library_file.scope.object, ObjectKind::SourceLibrary);
    assert_eq!(
        (
            &library_file.scope.id,
            library_file.scope.index,
            &library_file.scope.path,
            library_file.scope.line
        ),
        (&None, None, &None, None)
    );
    assert_eq!(library_file.repair, Check::LibraryIntegrity.action());
    assert_eq!(library_file.gate, Gate::Refuses);

    let atlas_file = findings
        .iter()
        .find(|f| f.validator == Validator::Atlas)
        .expect("atlas-level diagnostic");
    assert_eq!(atlas_file.scope.object, ObjectKind::Atlas);
    assert!(atlas_file.scope.id.is_none() && atlas_file.scope.index.is_none());

    let record = findings
        .iter()
        .find(|f| f.code == "unresolved-relationship")
        .expect("record diagnostic");
    assert_eq!(
        (record.scope.object, record.scope.id.as_deref()),
        (ObjectKind::Source, Some("lost"))
    );
    assert_eq!(record.category, Category::Version);

    // A cited reference without a detail is reported by field, and its repair
    // says the detail is never filled in.
    let incomplete = everything()
        .into_iter()
        .find(|f| f.code == "citation-reference-incomplete")
        .expect("incomplete reference");
    assert!(incomplete.scope.field.is_some());
    assert!(incomplete.repair.contains("never fills in"));
}

#[test]
fn no_word_or_field_of_the_contract_claims_truth_credibility_consensus_or_fitness() {
    const VERDICTS: &[&str] = &[
        "true",
        "truth",
        "false",
        "correct",
        "incorrect",
        "verified",
        "verify",
        "credible",
        "credibility",
        "authoritative",
        "consensus",
        "fit",
        "ready",
        "readiness",
        "score",
        "accurate",
        "accuracy",
        "proven",
        "strong",
        "weak",
        "pass",
        "passed",
        "fail",
    ];
    let mut texts: Vec<&str> = Vec::new();
    texts.extend(Check::ALL.iter().map(|c| c.property()));
    texts.extend(Check::ALL.iter().map(|c| c.action()));
    texts.extend(Category::ALL.iter().map(|c| c.meaning()));
    for text in texts {
        for word in text
            .split(|c: char| !c.is_ascii_alphanumeric())
            .map(str::to_ascii_lowercase)
        {
            assert!(!VERDICTS.contains(&word.as_str()), "{word:?} in {text:?}");
        }
    }
    let report: Value = serde_json::from_str(&CompletenessReport::new(everything(), &[]).to_json())
        .expect("report json");
    let mut keys = BTreeSet::new();
    collect_keys(&report, &mut keys);
    for key in &keys {
        let key = key.to_ascii_lowercase();
        for verdict in VERDICTS
            .iter()
            .chain(&["total", "resolved", "rank", "grade"])
        {
            assert!(!key.contains(verdict), "field {key:?}");
        }
    }
    assert_eq!(
        report["counts"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        ["detected", "needsReview", "potential"]
    );
}

fn collect_keys(value: &Value, keys: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                keys.insert(key.clone());
                collect_keys(value, keys);
            }
        }
        Value::Array(items) => items.iter().for_each(|v| collect_keys(v, keys)),
        _ => {}
    }
}

#[test]
fn findings_carry_no_private_research_text() {
    let report = CompletenessReport::new(everything(), &[]).to_json();
    assert!(!report.contains(SECRET), "{report}");
}

#[test]
fn the_order_is_total_and_independent_of_arrival_and_duplicates_collapse() {
    let findings = everything();
    let forward = CompletenessReport::new(findings.clone(), &[]);
    let mut reversed = findings.clone();
    reversed.reverse();
    let mut rotated = findings.clone();
    rotated.rotate_left(findings.len() / 3);
    for other in [reversed, rotated] {
        assert_eq!(
            CompletenessReport::new(other, &[]).to_json(),
            forward.to_json()
        );
    }

    // The same validator run twice (a check and a rebuild) is one finding.
    let mut twice = findings.clone();
    twice.extend(findings.iter().cloned());
    assert_eq!(CompletenessReport::new(twice, &[]), forward);

    // Overlap is not duplication: two validators reporting the same code on
    // their own objects, or two checks on one post, are all kept.
    let endpoints: BTreeSet<_> = forward
        .findings
        .iter()
        .filter(|e| e.finding.code == "private-endpoint")
        .map(|e| e.finding.validator)
        .collect();
    assert_eq!(
        endpoints,
        BTreeSet::from([Validator::Atlas, Validator::Claims])
    );
    let on_post: BTreeSet<Check> = forward
        .findings
        .iter()
        .filter(|e| e.finding.scope.path.as_deref() == Some("posts/c.md"))
        .map(|e| e.finding.check)
        .collect();
    assert!(on_post.len() >= 3, "{on_post:?}");

    // Findings about one file stay together, in place order.
    let paths: Vec<Option<&str>> = forward
        .findings
        .iter()
        .map(|e| e.finding.scope.path.as_deref())
        .collect();
    let mut sorted = paths.clone();
    sorted.sort();
    assert_eq!(paths, sorted);
    let lines: Vec<usize> = forward
        .findings
        .iter()
        .filter(|e| {
            e.finding.scope.path.as_deref() == Some("posts/c.md")
                && e.finding.scope.object == ObjectKind::Post
        })
        .filter_map(|e| e.finding.scope.line)
        .collect();
    assert!(lines.windows(2).all(|w| w[0] <= w[1]), "{lines:?}");
}

#[test]
fn an_acknowledgement_never_resolves_a_finding_and_counts_apart() {
    let findings = everything();
    let report = CompletenessReport::new(findings.clone(), &[]);
    let review = report
        .findings
        .iter()
        .find(|e| e.finding.code == "citation-location-review")
        .expect("location review")
        .finding
        .clone();
    let ack = Acknowledgement::of(&review).expect("advisory");
    let acknowledged = CompletenessReport::new(findings.clone(), &[ack]);
    let entry = acknowledged
        .findings
        .iter()
        .find(|e| e.finding == review)
        .expect("still listed");
    assert_eq!(entry.acknowledgement, Some(AcknowledgementState::Current));
    assert_eq!(acknowledged.findings.len(), report.findings.len());
    assert_eq!(
        acknowledged.counts.needs_review.found,
        report.counts.needs_review.found
    );
    assert_eq!(acknowledged.counts.needs_review.acknowledged, 1);
    assert_eq!(acknowledged.counts.detected.acknowledged, 0);
    assert_eq!(acknowledged.unmatched_acknowledgements, 0);

    // Integrity and privacy failures are corrected, never acknowledged.
    let refused = findings
        .iter()
        .find(|f| f.gate == Gate::Refuses)
        .expect("refusing finding");
    assert_eq!(Acknowledgement::of(refused), None);
    let forged = Acknowledgement {
        validator: refused.validator,
        code: refused.code.clone(),
        object: refused.scope.object,
        path: refused.scope.path.clone(),
        id: refused.scope.id.clone(),
        field: refused.scope.field.clone(),
        fingerprint: refused.fingerprint(),
    };
    let report = CompletenessReport::new(findings.clone(), &[forged]);
    assert!(report.findings.iter().all(|e| e.acknowledgement.is_none()));
    // A record the contract does not allow is never applied and never
    // counted: the stored file holding one is refused whole (ADR 0149).
    assert_eq!(report.unmatched_acknowledgements, 0);
    let published = findings
        .iter()
        .find(|f| f.gate == Gate::RefusesWhenPublished)
        .expect("citation syntax");
    assert_eq!(Acknowledgement::of(published), None);
}

#[test]
fn acknowledgements_go_stale_when_the_source_changes_and_drop_when_resolved() {
    // A new located citation changes what the location prompt says.
    let one = CompletenessFinding::from_evidence(
        citation_findings("A [@burnet, canonical 514a] place.\n")
            .iter()
            .find(|f| f.code == EvidenceCode::CitationLocationReview)
            .expect("one located citation"),
    );
    let ack = Acknowledgement::of(&one).expect("advisory");
    let two: Vec<CompletenessFinding> =
        citation_findings("A [@burnet, canonical 514a] place.\nAnd [@burnet, canonical 515b].\n")
            .iter()
            .map(CompletenessFinding::from_evidence)
            .collect();
    let report = CompletenessReport::new(two, std::slice::from_ref(&ack));
    let entry = report
        .findings
        .iter()
        .find(|e| e.finding.code == "citation-location-review")
        .expect("location review");
    assert_eq!(entry.acknowledgement, Some(AcknowledgementState::Stale));
    assert_eq!(report.counts.needs_review.acknowledged, 0);

    // A dating's stated value changes: the prompt's acknowledgement is stale.
    let prompt = |year| {
        ChronologyIndex::of(&chronology_atlas(year))
            .prompts
            .iter()
            .map(CompletenessFinding::from_chronology_prompt)
            .collect::<Vec<_>>()
    };
    let before = prompt(-410);
    let ack = Acknowledgement::of(&before[0]).expect("advisory");
    let same = CompletenessReport::new(prompt(-410), std::slice::from_ref(&ack));
    assert_eq!(
        same.findings[0].acknowledgement,
        Some(AcknowledgementState::Current)
    );
    let after = CompletenessReport::new(prompt(-420), std::slice::from_ref(&ack));
    assert_eq!(
        after.findings[0].acknowledgement,
        Some(AcknowledgementState::Stale)
    );

    // The author records what was missing: the finding disappears, and the
    // acknowledgement matches nothing; it is never shown as "resolved".
    let resolved = CompletenessReport::new(prompt(-300), std::slice::from_ref(&ack));
    assert!(resolved.findings.is_empty());
    assert_eq!(resolved.unmatched_acknowledgements, 1);

    // Two advisory findings under one key: an acknowledgement of one leaves
    // the other unacknowledged rather than stale.
    let doc = frontmatter::parse("---\ntitle: T\nprofile: research\n---\nA[^1] and B[^2].\n")
        .expect("front matter");
    let footnotes: Vec<CompletenessFinding> =
        audit_document("posts/r.md", &doc.front_matter, &doc.body, doc.body_line)
            .iter()
            .map(CompletenessFinding::from_evidence)
            .filter(|f| f.code == "footnote-unresolved")
            .collect();
    assert_eq!(footnotes.len(), 2);
    let first = Acknowledgement::of(&footnotes[0]).expect("advisory");
    let report = CompletenessReport::new(footnotes.clone(), &[first]);
    let states: Vec<Option<AcknowledgementState>> =
        report.findings.iter().map(|e| e.acknowledgement).collect();
    assert_eq!(
        states.iter().filter(|s| s.is_some()).count(),
        1,
        "{states:?}"
    );
    assert!(states.contains(&Some(AcknowledgementState::Current)));
}

fn location_review(body: &str) -> CompletenessFinding {
    CompletenessFinding::from_evidence(
        citation_findings(body)
            .iter()
            .find(|f| f.code == EvidenceCode::CitationLocationReview)
            .expect("located citation"),
    )
}

#[test]
fn moving_a_finding_keeps_its_acknowledgement_and_changing_what_it_states_does_not() {
    // The location prompt names lines; inserting a paragraph above the
    // located citation moves them, but the cited keys and locators are the
    // same, so the acknowledgement stays current.
    let before = location_review("A [@burnet, canonical 514a] place.\n");
    let ack = Acknowledgement::of(&before).expect("advisory");
    let moved = location_review("A new paragraph.\n\nA [@burnet, canonical 514a] place.\n");
    assert_ne!(
        moved.message, before.message,
        "the message names the new line"
    );
    assert_eq!(moved.fingerprint(), before.fingerprint());
    let report = CompletenessReport::new([moved], std::slice::from_ref(&ack));
    assert_eq!(
        report.findings[0].acknowledgement,
        Some(AcknowledgementState::Current)
    );

    // A real change to the cited locators is a change to what the prompt is
    // about: the acknowledgement goes stale.
    let relocated = location_review("A new paragraph.\n\nA [@burnet, canonical 515b] place.\n");
    let report = CompletenessReport::new([relocated], std::slice::from_ref(&ack));
    assert_eq!(
        report.findings[0].acknowledgement,
        Some(AcknowledgementState::Stale)
    );

    // A claim's words moving in the draft (`claim-anchor-moved` names a byte
    // offset) keeps the acknowledgement too.
    let moved_anchor = |draft: &str| {
        let library = library();
        let notebook = notebook(&library);
        let set = claims(&library, &notebook);
        let drafts = BTreeMap::from([("cave".to_string(), draft.to_string())]);
        let paths = BTreeMap::from([("cave".to_string(), "posts/cave.md".to_string())]);
        review_claims(
            &set,
            &ReviewContext {
                drafts: &drafts,
                paths: &paths,
                claims_file: ".openblog/private/research/claims.json",
                library: &library,
                notebook: &notebook,
            },
        )
        .iter()
        .find(|f| f.code == EvidenceCode::ClaimAnchorMoved)
        .map(CompletenessFinding::from_evidence)
        .expect("moved anchor")
    };
    let first = moved_anchor("Intro. The cave and the line.");
    let later = moved_anchor("A longer introduction. The cave and the line.");
    assert_ne!(first.message, later.message);
    assert_eq!(first.fingerprint(), later.fingerprint());
}

#[test]
fn an_acknowledgement_of_a_post_finding_applies_to_that_post_only() {
    // Two posts with the same post-scoped finding and no id: acknowledging
    // one leaves the other unacknowledged, never acknowledged or stale.
    let audit = |path: &str| {
        let doc = frontmatter::parse("---\ntitle: T\nprofile: research\n---\nBody.\n")
            .expect("front matter");
        audit_document(path, &doc.front_matter, &doc.body, doc.body_line)
            .iter()
            .map(CompletenessFinding::from_evidence)
            .filter(|f| f.code == "abstract-missing")
            .collect::<Vec<_>>()
    };
    let a = audit("posts/a.md");
    let b = audit("posts/b.md");
    assert_eq!((a.len(), b.len()), (1, 1));
    assert_eq!(a[0].scope.id, None);
    assert_ne!(a[0].fingerprint(), b[0].fingerprint());
    let ack = Acknowledgement::of(&a[0]).expect("advisory");
    assert_eq!(ack.path.as_deref(), Some("posts/a.md"));
    let report = CompletenessReport::new(a.iter().chain(&b).cloned(), std::slice::from_ref(&ack));
    let state = |path: &str| {
        report
            .findings
            .iter()
            .find(|e| e.finding.scope.path.as_deref() == Some(path))
            .expect("listed")
            .acknowledgement
    };
    assert_eq!(state("posts/a.md"), Some(AcknowledgementState::Current));
    assert_eq!(state("posts/b.md"), None);
    assert_eq!(report.counts.detected.acknowledged, 1);

    // Only b.md's finding remains: a.md's acknowledgement names nothing in
    // the report and leaves b.md alone.
    let report = CompletenessReport::new(b.clone(), &[ack]);
    assert_eq!(report.findings[0].acknowledgement, None);
    assert_eq!(report.unmatched_acknowledgements, 1);
}

#[test]
fn serialization_is_compatible_and_versioned() {
    // Existing finding JSON is unchanged by the contract.
    let finding = EvidenceFinding {
        code: EvidenceCode::ClaimLocationUnreviewed,
        outcome: EvidenceOutcome::NeedsReview,
        source: EvidenceSource {
            path: "posts/cave.md".into(),
            line: None,
            column: None,
            field: Some("links[l1].reviewState".into()),
        },
        message: "m".into(),
        repair: "r".into(),
        object: Some(openblog_core::research::EvidenceObject {
            claim: "c1".into(),
            link: Some("l1".into()),
        }),
        facts: Vec::new(),
    };
    assert_eq!(
        serde_json::to_string(&finding).unwrap(),
        r#"{"code":"claim-location-unreviewed","outcome":"needs-review","source":{"path":"posts/cave.md","line":null,"column":null,"field":"links[l1].reviewState"},"message":"m","repair":"r","object":{"claim":"c1","link":"l1"}}"#
    );

    let mapped = CompletenessFinding::from_evidence(&finding);
    let report = CompletenessReport::new([mapped.clone()], &[]);
    let fingerprint = mapped.fingerprint();
    assert_eq!(fingerprint.len(), 32);
    assert_eq!(
        report.to_json(),
        format!(
            r#"{{
  "version": {COMPLETENESS_FORMAT_VERSION},
  "findings": [
    {{
      "validator": "claim-review",
      "check": "evidence-location",
      "code": "claim-location-unreviewed",
      "category": "locator",
      "outcome": "needs-review",
      "gate": "advisory",
      "scope": {{
        "object": "evidence-link",
        "id": "l1",
        "path": "posts/cave.md",
        "field": "links[l1].reviewState"
      }},
      "related": [
        {{
          "kind": "claim",
          "id": "c1"
        }}
      ],
      "message": "m",
      "repair": "r",
      "fingerprint": "{fingerprint}",
      "place": "evidence link l1 in posts/cave.md"
    }}
  ],
  "counts": {{
    "detected": {{
      "found": 0,
      "acknowledged": 0
    }},
    "potential": {{
      "found": 0,
      "acknowledged": 0
    }},
    "needsReview": {{
      "found": 1,
      "acknowledged": 0
    }}
  }},
  "unmatchedAcknowledgements": 0
}}
"#
        )
    );

    // The fingerprint is stable across runs and builds.
    assert_eq!(
        CompletenessFinding::from_evidence(&finding).fingerprint(),
        fingerprint
    );

    // Acknowledgements round-trip and refuse unknown fields.
    let ack = Acknowledgement::of(&mapped).expect("advisory");
    let text = serde_json::to_string(&ack).unwrap();
    assert_eq!(
        text,
        format!(
            r#"{{"validator":"claim-review","code":"claim-location-unreviewed","object":"evidence-link","path":"posts/cave.md","id":"l1","field":"links[l1].reviewState","fingerprint":"{fingerprint}"}}"#
        )
    );
    assert_eq!(serde_json::from_str::<Acknowledgement>(&text).unwrap(), ack);
    let mut extra: Value = serde_json::from_str(&text).unwrap();
    extra["resolved"] = json!(true);
    assert!(serde_json::from_str::<Acknowledgement>(&extra.to_string()).is_err());
}

/// The fixture library, with `burnet` archived when asked.
fn revised_library(burnet_archived: bool) -> SourceLibrary {
    let mut value: Value = serde_json::from_str(&library().to_json()).expect("library json");
    if burnet_archived {
        value["sources"][1]["archived"] = json!(true);
    }
    SourceLibrary::parse(&value.to_string(), &BTreeMap::new()).expect("library")
}

/// The fixture notebook with `p-burnet` captured at `place`, and an extra
/// passage when asked (an unrelated notebook edit).
fn revised_notebook(library: &SourceLibrary, place: &str, extra: bool) -> Notebook {
    let mut passages = vec![
        json!({"id": "p-burnet", "source": "burnet", "excerpt": {"text": "greek"},
               "locators": [{"kind": "canonical", "value": place}]}),
        json!({"id": "p-grube", "source": "grube", "excerpt": {"text": "reserved"},
               "locators": [{"kind": "page", "value": "186"}]}),
    ];
    if extra {
        passages.push(
            json!({"id": "p-more", "source": "grube", "excerpt": {"text": "more"},
                             "locators": [{"kind": "page", "value": "190"}]}),
        );
    }
    Notebook::parse(
        &json!({"version": 1, "passages": passages, "notes": []}).to_string(),
        library,
    )
    .expect("notebook")
}

fn alignment_notices(library: &SourceLibrary, notebook: &Notebook) -> Vec<CompletenessFinding> {
    let links = Links { library, notebook };
    AlignmentSet::parse(&alignments_value().to_string(), links)
        .expect("alignments")
        .notices(links)
        .iter()
        .map(CompletenessFinding::from_atlas_diagnostic)
        .collect()
}

fn located_claim_findings(
    library: &SourceLibrary,
    notebook: &Notebook,
) -> Vec<CompletenessFinding> {
    let value = json!({"version": 1,
        "claims": [{"id": "c1", "post": "cave", "statement": "S",
                    "anchor": {"start": 4, "end": 8, "text": "cave"}}],
        "links": [{"id": "l1", "claim": "c1", "relation": "supports",
                   "evidence": {"source": "burnet", "passage": "p-burnet"},
                   "rationale": "R"}]});
    let set = ClaimSet::parse(&value.to_string(), Links { library, notebook }).expect("claims");
    let drafts = BTreeMap::from([("cave".to_string(), DRAFT.to_string())]);
    let paths = BTreeMap::from([("cave".to_string(), "posts/cave.md".to_string())]);
    review_claims(
        &set,
        &ReviewContext {
            drafts: &drafts,
            paths: &paths,
            claims_file: ".openblog/private/research/claims.json",
            library,
            notebook,
        },
    )
    .iter()
    .map(CompletenessFinding::from_evidence)
    .collect()
}

fn state_of(report: &CompletenessReport, code: &str) -> Option<AcknowledgementState> {
    report
        .findings
        .iter()
        .find(|e| e.finding.code == code)
        .unwrap_or_else(|| panic!("{code} listed"))
        .acknowledgement
}

#[test]
fn revising_the_source_or_notebook_record_stales_exactly_the_acknowledgements_it_changes() {
    let library = revised_library(false);

    // An alignment member's place no longer matches its passage, and the
    // author acknowledges it.
    let notebook = revised_notebook(&library, "514a", false);
    let notices = alignment_notices(&library, &notebook);
    let stale = notices
        .iter()
        .find(|f| f.code == "stale-locator")
        .expect("stale locator");
    let ack = Acknowledgement::of(stale).expect("advisory");

    // An unrelated notebook edit leaves it current.
    let report = CompletenessReport::new(
        alignment_notices(&library, &revised_notebook(&library, "514a", true)),
        std::slice::from_ref(&ack),
    );
    assert_eq!(
        state_of(&report, "stale-locator"),
        Some(AcknowledgementState::Current)
    );

    // Re-locating the passage changes what the notice is about: stale, and
    // still listed and counted.
    let report = CompletenessReport::new(
        alignment_notices(&library, &revised_notebook(&library, "514c", false)),
        std::slice::from_ref(&ack),
    );
    assert_eq!(
        state_of(&report, "stale-locator"),
        Some(AcknowledgementState::Stale)
    );
    assert_eq!(report.counts.needs_review.acknowledged, 0);

    // Re-locating it to the member's place: the notice is gone and the
    // acknowledgement matches nothing.
    let report = CompletenessReport::new(
        alignment_notices(&library, &revised_notebook(&library, "514b", false)),
        std::slice::from_ref(&ack),
    );
    assert!(report
        .findings
        .iter()
        .all(|e| e.finding.code != "stale-locator"));
    assert_eq!(report.unmatched_acknowledgements, 1);

    // A claim-review prompt: nobody has checked the link's location.
    let unreviewed = located_claim_findings(&library, &notebook)
        .into_iter()
        .find(|f| f.code == "claim-location-unreviewed")
        .expect("unreviewed location");
    let ack = Acknowledgement::of(&unreviewed).expect("advisory");

    // Archiving the source adds its own prompt, unacknowledged, and leaves
    // the location acknowledgement current: the location did not change.
    let archived = revised_library(true);
    let notebook_after = revised_notebook(&archived, "514a", false);
    let report = CompletenessReport::new(
        located_claim_findings(&archived, &notebook_after),
        std::slice::from_ref(&ack),
    );
    assert_eq!(
        state_of(&report, "claim-location-unreviewed"),
        Some(AcknowledgementState::Current)
    );
    assert_eq!(state_of(&report, "claim-source-archived"), None);

    // Re-locating the passage the link points to is a new location to check.
    let report = CompletenessReport::new(
        located_claim_findings(&library, &revised_notebook(&library, "515a", false)),
        std::slice::from_ref(&ack),
    );
    assert_eq!(
        state_of(&report, "claim-location-unreviewed"),
        Some(AcknowledgementState::Stale)
    );

    // An acknowledged archived-member prompt about the passage: archiving
    // the source too leaves that acknowledgement current and adds the
    // source's own prompt, unacknowledged.
    let mut archived_passage: Value =
        serde_json::from_str(&notebook.to_json()).expect("notebook json");
    archived_passage["passages"][0]["archived"] = json!(true);
    let notebook_archived =
        Notebook::parse(&archived_passage.to_string(), &library).expect("notebook");
    let passage_notice = alignment_notices(&library, &notebook_archived)
        .into_iter()
        .find(|f| f.code == "archived-member")
        .expect("archived passage");
    let ack = Acknowledgement::of(&passage_notice).expect("advisory");
    let both = alignment_notices(
        &archived,
        &Notebook::parse(&archived_passage.to_string(), &archived).expect("notebook"),
    );
    let report = CompletenessReport::new(both, std::slice::from_ref(&ack));
    let states: Vec<(Option<&str>, Option<AcknowledgementState>)> = report
        .findings
        .iter()
        .filter(|e| e.finding.code == "archived-member")
        .map(|e| (e.finding.scope.field.as_deref(), e.acknowledgement))
        .collect();
    assert_eq!(
        states,
        [
            (
                Some("members[0].passage"),
                Some(AcknowledgementState::Current)
            ),
            (Some("members[0].source"), None),
        ]
    );
}

// ---------------------------------------------------------------------------
// The rows the publication review added (ADR 0123, ADR 0149): one contract,
// one source of truth for validator, code, fingerprint and gate.
// ---------------------------------------------------------------------------

fn context_finding(markdown: &str) -> CompletenessFinding {
    let links = find_context_links(markdown, 3);
    let gap = |_, _: &str| Some(ContextGap::NotApproved);
    CompletenessFinding::from_context_link("posts/cave.md", &review_context_links(&links, gap)[0])
}

fn rows_of(code: &str) -> Vec<MatrixRow> {
    matrix()
        .into_iter()
        .filter(|row| row.code == code)
        .collect()
}

#[test]
fn the_rows_the_publication_review_added_have_one_owner_and_a_gate_each() {
    assert_eq!(Check::ContextLink.owner(), Validator::PublicationContext);
    assert_eq!(
        Validator::PublicationContext.entry_point(),
        "context_links::review_context_links"
    );
    assert!(Validator::ALL.contains(&Validator::PublicationContext));
    assert!(Check::ALL.contains(&Check::ContextLink));

    let link = rows_of(CONTEXT_LINK_UNPUBLISHED);
    assert_eq!(link.len(), 1);
    assert_eq!(link[0].validator, Validator::PublicationContext);
    assert_eq!(link[0].check, Check::ContextLink);
    assert_eq!(link[0].category, Category::PublicBoundary);
    assert_eq!(link[0].outcome, EvidenceOutcome::Detected);
    assert_eq!(link[0].gate, Gate::Advisory);

    // `file-unreadable` is under each private file's integrity check, owned
    // by that file's validator, and refuses the build that reads the file.
    let unreadable = rows_of(FILE_UNREADABLE);
    let owners: BTreeSet<(String, String)> = unreadable
        .iter()
        .map(|row| (row.validator.to_string(), row.check.to_string()))
        .collect();
    assert_eq!(
        owners,
        BTreeSet::from([
            ("source-library".into(), "library-integrity".into()),
            ("notebook".into(), "notebook-integrity".into()),
            ("atlas".into(), "atlas-integrity".into()),
            ("claims".into(), "claims-integrity".into()),
            ("alignments".into(), "alignments-integrity".into()),
            ("selections".into(), "selections-integrity".into()),
        ])
    );
    for row in &unreadable {
        assert_eq!(row.category, Category::Integrity);
        assert_eq!(row.gate, Gate::Refuses);
        assert!(!acknowledgeable(row.validator, &row.code));
    }

    // No (validator, check, code) is mapped twice, so a code has one meaning.
    let mut seen = BTreeSet::new();
    for row in matrix() {
        assert!(
            seen.insert((row.validator, row.check, row.code.clone())),
            "{row:?} twice"
        );
    }
}

#[test]
fn each_added_row_is_emitted_by_its_real_emitter_and_maps_to_its_own_row() {
    // `context-link-unpublished`: the real context-link check.
    let link = context_finding("[a](/atlas/a/)");
    let rows = rows_of(CONTEXT_LINK_UNPUBLISHED);
    let row = row_of(&rows, &link);
    assert_eq!((row.validator, row.check), (link.validator, link.check));
    assert_eq!(
        (row.category, row.outcome, row.gate),
        (link.category, link.outcome, link.gate)
    );
    assert_eq!(link.facts, vec!["/atlas/a/".to_string()]);
    assert_eq!(link.scope.object, ObjectKind::Post);

    // `file-unreadable`: each file kind lands on that file's own row.
    for (file, check) in [
        (ObjectKind::SourceLibrary, Check::LibraryIntegrity),
        (ObjectKind::Notebook, Check::NotebookIntegrity),
        (ObjectKind::Atlas, Check::AtlasIntegrity),
        (ObjectKind::ClaimsFile, Check::ClaimsIntegrity),
        (ObjectKind::AlignmentsFile, Check::AlignmentsIntegrity),
    ] {
        let finding = CompletenessFinding::unreadable(file, "cannot be read");
        assert_eq!(finding.check, check);
        assert_eq!(finding.code, FILE_UNREADABLE);
        assert_eq!(finding.gate, Gate::Refuses);
        assert_eq!(finding.scope.object, file);
        assert!(finding.blocks_publication());
        let rows = rows_of(FILE_UNREADABLE);
        assert_eq!(row_of(&rows, &finding).check, check);
    }

    // The unsafe-address finding reuses `citation-identifier-unpublished` with
    // [key, scheme, value] facts.
    let library = SourceLibrary::parse(
        &json!({"version": 1, "sources": [
            {"id": "leaky", "kind": "work", "title": "Leaky",
             "identifiers": [{"scheme": "url", "value": "https://example.org/a?token=abc"}]}
        ]})
        .to_string(),
        &BTreeMap::new(),
    )
    .expect("library");
    let found = review_citations("posts/u.md", "A [@leaky] note.\n", 1, || Ok(Some(&library)));
    let unsafe_url: Vec<CompletenessFinding> = found
        .iter()
        .filter(|f| f.code == EvidenceCode::CitationIdentifierUnpublished)
        .map(CompletenessFinding::from_evidence)
        .collect();
    assert_eq!(unsafe_url.len(), 1, "{found:?}");
    assert_eq!(
        unsafe_url[0].facts,
        vec![
            "leaky".to_string(),
            "url".to_string(),
            "https://example.org/a?token=abc".to_string()
        ]
    );
    assert_eq!(unsafe_url[0].check, Check::CitationResolution);
    assert_eq!(unsafe_url[0].gate, Gate::Advisory);
    let rows = rows_of("citation-identifier-unpublished");
    assert_eq!(
        row_of(&rows, &unsafe_url[0]).check,
        Check::CitationResolution
    );
    assert!(
        !unsafe_url[0].message.contains("token=abc"),
        "the message never repeats the unsafe address"
    );
    assert!(
        !serde_json::to_string(&unsafe_url[0])
            .unwrap()
            .contains("token=abc"),
        "the facts are never serialized"
    );
}

#[test]
fn a_stale_approval_withholds_and_is_never_acknowledgeable() {
    use openblog_core::knowledge_atlas::{AtlasDiagnostic, AtlasDiagnosticCode, DiagnosticSubject};
    let diagnostic = AtlasDiagnostic {
        code: AtlasDiagnosticCode::StaleApproval,
        subject: DiagnosticSubject::Alignments,
        collection: Some("alignments"),
        index: Some(0),
        id: Some("cave".into()),
        field: None,
        message: "The approval is stale.".into(),
        facts: Vec::new(),
    };
    let finding = CompletenessFinding::from_atlas_diagnostic(&diagnostic);
    assert_eq!(finding.gate, Gate::Withholds);
    assert!(!finding.blocks_publication());
    assert_eq!(Acknowledgement::of(&finding), None);
    assert!(!acknowledgeable(Validator::Alignments, "stale-approval"));
}

/// A damaged curated selections file refuses a full build while the site
/// publishes curated context (ADR 0191). It is the only thing the selections
/// validator owns: a withdrawn, stale, missing or cyclic selection is the
/// author's own state, listed by the boundary manifest with its reason, so it
/// has no advisory row to acknowledge and the acknowledgeable set is unchanged.
#[test]
fn the_selections_validator_owns_one_refusing_row_and_nothing_acknowledgeable() {
    assert_eq!(Check::SelectionsIntegrity.owner(), Validator::Selections);
    assert_eq!(
        Validator::Selections.entry_point(),
        "curated_selection::SelectionSet::parse"
    );
    assert!(Validator::ALL.contains(&Validator::Selections));
    assert!(Check::ALL.contains(&Check::SelectionsIntegrity));
    let rows: Vec<MatrixRow> = matrix()
        .into_iter()
        .filter(|row| row.validator == Validator::Selections)
        .collect();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].code, FILE_UNREADABLE);
    assert_eq!(rows[0].gate, Gate::Refuses);
    assert_eq!(rows[0].category, Category::Integrity);
    assert!(!acknowledgeable(Validator::Selections, FILE_UNREADABLE));

    let finding = CompletenessFinding::unreadable(
        ObjectKind::SelectionsFile,
        "The selections file is not valid.",
    );
    assert_eq!(finding.validator, Validator::Selections);
    assert_eq!(finding.check, Check::SelectionsIntegrity);
    assert_eq!(finding.scope.object, ObjectKind::SelectionsFile);
    assert!(finding.blocks_publication());
    assert_eq!(Acknowledgement::of(&finding), None);
    assert_eq!(finding.scope.object.to_string(), "selections-file");
}

/// The acknowledgements file exactly as the Admin flow of #62 writes it
/// (ADR 0124), with a record for an added row.
fn stored_by_the_admin_flow(context: &CompletenessFinding) -> String {
    let context_print = context.fingerprint();
    format!(
        r#"{{
  "version": 1,
  "acknowledgements": [
    {{
      "validator": "publication-context",
      "code": "context-link-unpublished",
      "object": "post",
      "path": "posts/cave.md",
      "fingerprint": "{context_print}"
    }},
    {{
      "validator": "research-profile",
      "code": "abstract-missing",
      "object": "post",
      "path": "posts/cave.md",
      "fingerprint": "00112233445566778899aabbccddeeff"
    }}
  ]
}}
"#
    )
}

#[test]
fn acknowledgements_stored_by_the_admin_flow_stay_valid_under_the_contract() {
    let context = context_finding("[a](/atlas/a/)");
    // The fingerprint is the same function it was before the two models were
    // unified, pinned from an independent digest of the key, related object
    // and fact.
    assert_eq!(context.fingerprint(), "725890777d1b5b11244dea097f07216f");

    let stored = stored_by_the_admin_flow(&context);
    let set = AcknowledgementSet::parse(&stored).expect("the stored file parses");
    assert_eq!(set.acknowledgements.len(), 2);
    // The contract's report and the review's report treat it identically.
    let report = CompletenessReport::new(vec![context.clone()], &set.acknowledgements);
    assert_eq!(
        report.findings[0].acknowledgement,
        Some(AcknowledgementState::Current)
    );
    assert_eq!(report.counts.detected.found, 1);
    assert_eq!(report.counts.detected.acknowledged, 1);
    let review = PublicationReview::new(vec![context.clone()], &set.acknowledgements);
    assert_eq!(review.findings, report.findings);
    assert_eq!(review.counts, report.counts);
    assert_eq!(
        review.unmatched_acknowledgements, 1,
        "abstract-missing has no finding now"
    );

    // Round trips are stable and keep the record shape.
    assert_eq!(AcknowledgementSet::parse(&set.to_json()).unwrap(), set);
    let mut again = AcknowledgementSet::empty();
    again.add(Acknowledgement::of(&context).unwrap()).unwrap();
    assert!(again.to_json().contains("\"publication-context\""));

    // Refused whole: a refusing code, an unknown field, a bad fingerprint,
    // an unsupported version.
    for bad in [
        stored.replace("context-link-unpublished", "file-unreadable"),
        stored.replace(
            "\"object\": \"post\",",
            "\"object\": \"post\", \"note\": \"x\",",
        ),
        stored.replace("00112233445566778899aabbccddeeff", "NOT-HEX"),
        stored.replace("\"version\": 1", "\"version\": 2"),
    ] {
        assert!(AcknowledgementSet::parse(&bad).is_err(), "{bad}");
    }

    // Changing the address stales it, and a stale record counts for nothing.
    let moved = context_finding("[a](/atlas/a/#dates)");
    let stale = CompletenessReport::new(vec![moved], &set.acknowledgements);
    assert_eq!(
        stale.findings[0].acknowledgement,
        Some(AcknowledgementState::Stale)
    );
    assert_eq!(stale.counts.detected.acknowledged, 0);
}

/// Every (validator, code) pair v0.39.0 let an author acknowledge, pinned: a
/// stored acknowledgement an author made then must still name an advisory
/// finding now, however the matrix is reorganized (ADR 0146).
const ACKNOWLEDGEABLE_IN_V0_39_0: [&str; 40] = [
    "alignments: archived-member",
    "alignments: stale-locator",
    "atlas: private-endpoint",
    "atlas: unpublished-datings",
    "chronology-index: composition-after-death",
    "chronology-index: composition-before-birth",
    "chronology-index: death-before-birth",
    "chronology-index: opposed-relative",
    "chronology-index: outside-lifetime",
    "chronology-index: publication-before-composition",
    "chronology-index: relative-against-dates",
    "chronology-index: relative-cycle",
    "citation-review: citation-identifier-unpublished",
    "citation-review: citation-location-review",
    "citation-review: citation-reference-incomplete",
    "claim-review: claim-anchor-ambiguous",
    "claim-review: claim-anchor-moved",
    "claim-review: claim-anchor-stale",
    "claim-review: claim-contradiction-undiscussed",
    "claim-review: claim-evidence-missing",
    "claim-review: claim-location-unreviewed",
    "claim-review: claim-locator-missing",
    "claim-review: claim-passage-archived",
    "claim-review: claim-post-missing",
    "claim-review: claim-rationale-missing",
    "claim-review: claim-source-archived",
    "claim-review: claim-suggestion-unreviewed",
    "claim-review: claim-support-only",
    "claims: private-endpoint",
    "claims: undisclosed-contradiction",
    "comparison-projection: withheld-length",
    "comparison-projection: withheld-rights",
    "publication-context: context-link-unpublished",
    "research-profile: abstract-missing",
    "research-profile: doi-invalid",
    "research-profile: doi-link-non-preferred",
    "research-profile: footnote-unresolved",
    "research-profile: license-url-invalid",
    "research-profile: reference-link-review",
    "research-profile: references-missing",
];

#[test]
fn every_pair_v0_39_0_let_an_author_acknowledge_is_still_acknowledgeable() {
    let now: BTreeSet<String> = matrix()
        .iter()
        .filter(|row| acknowledgeable(row.validator, &row.code))
        .map(|row| format!("{}: {}", row.validator, row.code))
        .collect();
    for pair in ACKNOWLEDGEABLE_IN_V0_39_0 {
        let (validator, code) = pair.split_once(": ").unwrap();
        let known = Validator::ALL
            .iter()
            .find(|validator_| validator_.to_string() == validator)
            .unwrap_or_else(|| panic!("{validator} is no longer a validator"));
        assert!(
            acknowledgeable(*known, code) && now.contains(pair),
            "{pair} was acknowledgeable in v0.39.0 and no longer is"
        );
    }
    // What is acknowledgeable beyond them is the source-review rows (ADR 0148),
    // which v0.39.0 had no validator for.
    let pinned: BTreeSet<String> = ACKNOWLEDGEABLE_IN_V0_39_0
        .iter()
        .map(|pair| pair.to_string())
        .collect();
    for added in now.difference(&pinned) {
        assert!(
            added.starts_with("source-review: "),
            "{added} became acknowledgeable without a decision"
        );
    }
}
