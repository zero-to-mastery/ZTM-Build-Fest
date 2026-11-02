//! Offline citation checks and portable bibliography exports (ADR 0050):
//! each diagnostic class, offline determinism, malformed identifiers,
//! escaping, hostile input, privacy and unchanged legacy posts.

use openblog_core::citation_review::review_citations;
use openblog_core::model::LibrarySource;
use openblog_core::research::{EvidenceCode, EvidenceFinding, EvidenceOutcome};
use openblog_core::source_interchange::{export_cited_bibtex, export_cited_csl_json};
use openblog_core::source_library::SourceLibrary;
use openblog_core::{LoadOptions, Site, SiteConfig, SourceFile, Sources};

const PRIVATE: &str = "PRIVATE-MARKER";

const LIBRARY: &str = r#"{
  "version": 1,
  "sources": [
    {"id": "plato-republic", "kind": "work", "title": "Politeia",
     "creators": [{"name": "Plato", "role": "author"}],
     "secretPlan": "PRIVATE-MARKER unknown field"},
    {"id": "slings-2003", "kind": "edition", "of": "plato-republic",
     "title": "Platonis Rempublicam", "issued": "2003",
     "creators": [{"name": "S. R. Slings", "role": "editor", "given": "PRIVATE-MARKER"}],
     "identifiers": [
       {"scheme": "doi", "value": "10.1000/xyz"},
       {"scheme": "my-drive", "value": "C:/PRIVATE-MARKER/scan.pdf"},
       {"scheme": "pmid", "value": "PMID: 77"}
     ],
     "csl": {"publisher": "Oxford University Press", "publisher-place": "Oxford",
             "type": "book", "note": "PRIVATE-MARKER csl note"}},
    {"id": "bare-article", "kind": "work", "title": "Bare",
     "csl": {"type": "article-journal"}},
    {"id": "ref-514", "kind": "reference", "of": "slings-2003",
     "location": {"scheme": "page", "value": "514"}},
    {"id": "hostile", "kind": "work", "issued": "2020",
     "title": "Braces } { and \\ backslash, 100% & $x$ _under_ #tag ~ ^ \"quotes\" </script>",
     "creators": [{"name": "Smith, Jones and Co", "role": "author"},
                  {"name": "A Reader", "role": "compiler"}],
     "identifiers": [{"scheme": "url", "value": "https://example.org/a}b"}],
     "csl": {"type": "webpage", "container-title": "Site"}},
    {"id": "never-cited", "kind": "work", "title": "PRIVATE-MARKER uncited title"}
  ]
}"#;

fn library() -> SourceLibrary {
    SourceLibrary::parse(LIBRARY, &Default::default()).expect("valid library")
}

fn review(body: &str) -> Vec<EvidenceFinding> {
    let library = library();
    review_citations("posts/p.md", body, 6, || Ok(Some(&library)))
}

fn codes(findings: &[EvidenceFinding]) -> Vec<String> {
    findings.iter().map(|f| f.code.to_string()).collect()
}

#[test]
fn each_class_is_a_separate_code_with_its_own_outcome_and_place() {
    let body = "\
A [@plato-republic, canonical 514a] claim.
Bad [@Not A Key] syntax.
Unknown [@nobody] key and a page on a work [@plato-republic, page 5].
An edition [@slings-2003, page 514 to 520], a bare article [@bare-article] and [@ref-514].
";
    let findings = review(body);
    let by = |code: EvidenceCode| -> Vec<&EvidenceFinding> {
        findings.iter().filter(|f| f.code == code).collect()
    };

    let syntax = by(EvidenceCode::CitationSyntax);
    assert_eq!(syntax.len(), 1, "{findings:#?}");
    assert_eq!(syntax[0].outcome, EvidenceOutcome::Detected);
    assert_eq!(syntax[0].source.line, Some(7));
    assert!(
        syntax[0].message.contains("(invalid-key)"),
        "{}",
        syntax[0].message
    );

    let unresolved = by(EvidenceCode::CitationUnresolved);
    assert_eq!(unresolved.len(), 2, "{findings:#?}");
    assert!(unresolved
        .iter()
        .all(|f| f.outcome == EvidenceOutcome::Detected && f.source.line == Some(8)));
    assert!(
        unresolved[0].message.contains("`nobody`")
            && unresolved[0].message.contains("(unknown-key)")
    );
    assert!(unresolved[1].message.contains("(ambiguous-locator)"));

    let identifier = by(EvidenceCode::CitationIdentifierUnpublished);
    assert_eq!(identifier.len(), 1, "{findings:#?}");
    assert_eq!(identifier[0].outcome, EvidenceOutcome::Potential);
    assert!(
        identifier[0].message.contains("`slings-2003`") && identifier[0].message.contains("`pmid`")
    );

    let incomplete = by(EvidenceCode::CitationReferenceIncomplete);
    let fields: Vec<(&str, Option<&str>)> = incomplete
        .iter()
        .map(|f| (f.message.split('`').nth(1).unwrap(), f.source.field()))
        .collect();
    assert_eq!(
        fields,
        vec![
            ("bare-article", Some("creators")),
            ("bare-article", Some("issued")),
            ("bare-article", Some("container-title")),
            ("ref-514", Some("title")),
        ],
        "{findings:#?}"
    );
    assert!(incomplete
        .iter()
        .all(|f| f.outcome == EvidenceOutcome::Potential
            && f.source.line == Some(9)
            && f.repair.contains("never fills in")));

    let location = by(EvidenceCode::CitationLocationReview);
    assert_eq!(location.len(), 1, "{findings:#?}");
    assert_eq!(location[0].outcome, EvidenceOutcome::NeedsReview);
    assert_eq!(location[0].source.line, Some(6));
    assert!(
        location[0]
            .message
            .contains("2 citations give a location (lines 6, 9)"),
        "{}",
        location[0].message
    );
}

#[test]
fn diagnostics_never_claim_truth_relevance_or_authority_and_never_leak() {
    let body = "[@plato-republic, canonical 1] [@slings-2003, page 2] [@bare-article] [@hostile] [@nobody] [@Bad Key]\n";
    let findings = review(body);
    assert!(findings.len() > 5);
    for finding in &findings {
        let text = format!("{} {}", finding.message, finding.repair).to_lowercase();
        for claim in [
            "true",
            "false",
            "verified",
            "accurate",
            "supports",
            "proves",
            "relevant",
            "authoritative",
            "trustworthy",
            "credible",
        ] {
            assert!(!text.contains(claim), "`{claim}` in {text}");
        }
        assert!(!text.contains(&PRIVATE.to_lowercase()), "{text}");
        assert!(
            !text.contains("77"),
            "the malformed identifier's value is not repeated: {text}"
        );
    }
}

#[test]
fn checks_are_offline_deterministic_and_read_the_library_only_when_needed() {
    let body = "Claim [@slings-2003, page 514].\n";
    assert_eq!(review(body), review(body));
    let mut called = false;
    let none = review_citations(
        "posts/p.md",
        "No citations, [^1] or \\[@x].\n\n[^1]: n\n",
        1,
        || {
            called = true;
            Ok(None)
        },
    );
    assert!(none.is_empty() && !called);
    // Without a library, only syntax is reviewed; publication reports the rest.
    let syntax_only = review_citations("posts/p.md", "[@ok-key] [@Bad Key]\n", 1, || Ok(None));
    assert_eq!(codes(&syntax_only), vec!["citation-syntax"]);
}

fn config() -> SiteConfig {
    SiteConfig::from_json(r#"{"title": "T", "url": "https://example.test", "language": "en"}"#)
        .unwrap()
}

fn load(posts: Vec<(&str, &str)>) -> Site {
    Site::load(
        config(),
        Sources {
            posts: posts
                .into_iter()
                .map(|(path, contents)| SourceFile {
                    path: path.into(),
                    contents: contents.into(),
                })
                .collect(),
            source_library: Some(LibrarySource::Text(SourceFile {
                path: ".openblog/private/research/sources.json".into(),
                contents: LIBRARY.into(),
            })),
            ..Default::default()
        },
        LoadOptions {
            include_drafts: true,
            ..LoadOptions::default()
        },
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"))
}

#[test]
fn a_site_load_reports_findings_for_opted_in_posts_only() {
    let site = load(vec![
        (
            "posts/cited.md",
            "---\ntitle: Cited\ndate: 2026-10-01\ncitations: bibliography\n---\nSee [@bare-article] and [@slings-2003, page 3].\n",
        ),
        (
            "posts/legacy.md",
            "---\ntitle: Legacy\ndate: 2026-10-02\n---\nPing [@nobody] and [@Bad Key].\n",
        ),
        (
            "posts/draft.md",
            "---\ntitle: Draft\ndraft: true\ncitations: notes\n---\nSoon [@not-yet].\n",
        ),
    ]);
    let paths: Vec<(&str, String)> = site
        .evidence
        .iter()
        .map(|f| (f.source.path.as_str(), f.code.to_string()))
        .collect();
    assert!(
        paths.iter().all(|(path, _)| *path != "posts/legacy.md"),
        "{paths:?}"
    );
    assert!(paths.contains(&("posts/cited.md", "citation-reference-incomplete".into())));
    assert!(paths.contains(&("posts/cited.md", "citation-location-review".into())));
    assert!(
        paths.contains(&("posts/draft.md", "citation-unresolved".into())),
        "{paths:?}"
    );

    let cited = site.posts.iter().find(|p| p.slug == "cited").unwrap();
    let summary = cited.citations().expect("published citations");
    assert_eq!(
        (summary.citations, summary.notes, summary.references.len()),
        (2, 2, 2)
    );
    assert_eq!(summary.references[0].key, "bare-article");
    for post in site.posts.iter().filter(|p| p.slug != "cited") {
        assert!(post.citations().is_none(), "{}", post.slug);
    }
}

#[test]
fn exports_hold_only_the_public_description_in_citation_order() {
    let site = load(vec![(
        "posts/cited.md",
        "---\ntitle: Cited\ndate: 2026-10-01\ncitations: notes\n---\nSee [@hostile], [@slings-2003, page 3] and [@hostile].\n",
    )]);
    let references = &site.posts[0].citations().unwrap().references;
    let csl = export_cited_csl_json(references);
    let bibtex = export_cited_bibtex(references);
    for content in [&csl.content, &bibtex.content] {
        assert!(!content.contains(PRIVATE), "{content}");
        assert!(
            !content.contains("my-drive") && !content.contains("never-cited"),
            "{content}"
        );
        assert!(
            !content.contains("openblog-") && !content.contains("custom"),
            "{content}"
        );
    }
    assert_eq!((csl.count, bibtex.count), (2, 2));

    let items: serde_json::Value = serde_json::from_str(&csl.content).unwrap();
    assert_eq!(items[0]["id"], "hostile");
    assert_eq!(items[0]["type"], "webpage");
    assert_eq!(items[0]["URL"], "https://example.org/a}b");
    assert_eq!(items[1]["id"], "slings-2003");
    assert_eq!(items[1]["type"], "book");
    assert_eq!(items[1]["DOI"], "10.1000/xyz");
    assert_eq!(items[1]["publisher"], "Oxford University Press");
    assert_eq!(
        items[1]["issued"],
        serde_json::json!({"date-parts": [[2003]]})
    );
    assert!(
        items[1].get("PMID").is_none(),
        "a malformed PMID is never exported"
    );
    assert_eq!(
        items[1]["editor"],
        serde_json::json!([{"literal": "S. R. Slings"}])
    );
    let csl_losses: Vec<(&str, &str)> = csl
        .losses
        .iter()
        .map(|loss| (loss.source_id.as_str(), loss.field.as_str()))
        .collect();
    assert_eq!(
        csl_losses,
        vec![("hostile", "creators[1]"), ("slings-2003", "kind")]
    );

    assert!(
        bibtex.content.starts_with("@misc{hostile,\n"),
        "{}",
        bibtex.content
    );
    assert!(
        bibtex.content.contains("\n@book{slings-2003,\n"),
        "{}",
        bibtex.content
    );
    assert!(
        bibtex.content.contains("title = {Braces \\textbraceright{} \\textbraceleft{} and \\textbackslash{} backslash, 100\\% \\& \\$x\\$ \\_under\\_ \\#tag \\~{} \\^{} \"quotes\" </script>}"),
        "{}",
        bibtex.content
    );
    assert!(
        bibtex.content.contains("author = {{Smith, Jones and Co}}"),
        "{}",
        bibtex.content
    );
    assert!(
        bibtex.content.contains("url = {https://example.org/a%7Db}"),
        "{}",
        bibtex.content
    );
    assert_eq!(
        bibtex.content.matches('{').count() - bibtex.content.matches("\\textbraceleft{}").count(),
        bibtex.content.matches('}').count() - bibtex.content.matches("\\textbraceright{}").count()
    );
    assert!(bibtex
        .losses
        .iter()
        .any(|loss| loss.source_id == "slings-2003" && loss.field == "kind"));
    assert!(bibtex
        .losses
        .iter()
        .any(|loss| loss.source_id == "hostile" && loss.field == "creators[1]"));

    // Deterministic: the same references always export the same bytes.
    assert_eq!(export_cited_csl_json(references), csl);
    assert_eq!(export_cited_bibtex(references), bibtex);
    assert_eq!(export_cited_csl_json(&[]).content, "[]\n");
}
