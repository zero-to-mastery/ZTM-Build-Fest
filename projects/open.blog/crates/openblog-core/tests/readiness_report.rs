//! The one research readiness report (#194, ADR 0150), over the unified
//! contract: Admin and the command line list the same codes in the same order;
//! a post's review and the site's report differ only in what counts as
//! blocking; acknowledged findings stay listed and counted; and the terminal
//! text and the JSON are deterministic, written to the shared fixtures that the
//! Admin tests (`tests/web/admin-readiness-report.test.mjs`) read too.
//!
//! Set `OPENBLOG_UPDATE_FIXTURES=1` to rewrite the fixtures after an
//! intentional change.

use std::path::PathBuf;

use openblog_core::context_links::{find_context_links, review_context_links, ContextGap};
use openblog_core::knowledge_atlas::{AtlasDiagnostic, AtlasDiagnosticCode, DiagnosticSubject};
use openblog_core::publication_review::{
    Acknowledgement, AcknowledgementState, Gate, ObjectKind, PublicationReview, ReviewFinding,
    ReviewGroupName, ReviewScope, Validator,
};
use openblog_core::research::{
    EvidenceCode, EvidenceFinding, EvidenceObject, EvidenceOutcome, EvidenceSource,
};
use openblog_core::research_completeness::CompletenessReport;
use serde_json::Value;

fn evidence(code: EvidenceCode, outcome: EvidenceOutcome, line: Option<usize>) -> EvidenceFinding {
    EvidenceFinding {
        code,
        outcome,
        source: EvidenceSource {
            path: "posts/cave.md".into(),
            line,
            column: line.map(|_| 1),
            field: None,
        },
        message: format!("{code} message."),
        repair: "Do the thing.".into(),
        object: None,
        facts: vec![format!("{code}")],
    }
}

fn claim_finding() -> EvidenceFinding {
    EvidenceFinding {
        object: Some(EvidenceObject {
            claim: "c1".into(),
            link: None,
        }),
        facts: vec!["c1".into()],
        ..evidence(
            EvidenceCode::ClaimLocationUnreviewed,
            EvidenceOutcome::NeedsReview,
            None,
        )
    }
}

fn context_link(markdown: &str) -> ReviewFinding {
    let links = find_context_links(markdown, 7);
    let gap = |_, _: &str| Some(ContextGap::NotApproved);
    ReviewFinding::from_context_link("posts/cave.md", &review_context_links(&links, gap)[0])
}

fn stale_approval() -> ReviewFinding {
    ReviewFinding::from_atlas_diagnostic(&AtlasDiagnostic {
        code: AtlasDiagnosticCode::StaleApproval,
        subject: DiagnosticSubject::Alignments,
        collection: Some("alignments"),
        index: Some(0),
        id: Some("cave-places".into()),
        field: None,
        message: "The approval of comparison `cave-places` no longer holds.".into(),
        facts: vec!["cave-places".into()],
    })
}

fn findings() -> Vec<ReviewFinding> {
    vec![
        ReviewFinding::from_evidence(&evidence(
            EvidenceCode::CitationUnresolved,
            EvidenceOutcome::Detected,
            Some(12),
        )),
        ReviewFinding::from_evidence(&evidence(
            EvidenceCode::AbstractMissing,
            EvidenceOutcome::Detected,
            None,
        )),
        ReviewFinding::from_evidence(&evidence(
            EvidenceCode::CitationReferenceIncomplete,
            EvidenceOutcome::Potential,
            Some(5),
        )),
        ReviewFinding::from_evidence(&claim_finding()),
        ReviewFinding::unreadable(ObjectKind::Atlas, "The Knowledge Atlas cannot be read."),
        context_link("[the Good](/atlas/the-good/)"),
        stale_approval(),
    ]
}

fn acknowledgements() -> Vec<Acknowledgement> {
    let all = findings();
    let by = |code: &str| all.iter().find(|finding| finding.code == code).unwrap();
    let mut stale = Acknowledgement::of(by("abstract-missing")).unwrap();
    // An earlier form of the finding: same key, a fingerprint it no longer has.
    stale.fingerprint = "0123456789abcdef0123456789abcdef".into();
    vec![
        Acknowledgement::of(by("citation-reference-incomplete")).unwrap(),
        stale,
    ]
}

fn site() -> PublicationReview {
    PublicationReview::scoped(
        CompletenessReport::new(findings(), &acknowledgements()),
        ReviewScope::Site,
    )
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/research-readiness")
        .join(name)
}

fn check_fixture(name: &str, actual: &str) {
    let path = fixture(name);
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

fn json(review: &PublicationReview) -> String {
    let mut text = serde_json::to_string_pretty(review).unwrap();
    text.push('\n');
    text
}

#[test]
fn the_site_report_matches_the_shared_fixtures_byte_for_byte() {
    let review = site();
    check_fixture("report.json", &json(&review));
    check_fixture("report.txt", &review.text());
}

#[test]
fn a_posts_review_and_the_sites_report_differ_only_in_what_blocks() {
    let report = CompletenessReport::new(findings(), &acknowledgements());
    let post = PublicationReview::scoped(report.clone(), ReviewScope::Post);
    let site = site();
    // Same findings, same order, same counts, same acknowledgements.
    assert_eq!(post.findings, site.findings);
    assert_eq!(post.counts, site.counts);
    assert_eq!(
        post.unmatched_acknowledgements,
        site.unmatched_acknowledgements
    );
    let blocking = |review: &PublicationReview| -> Vec<String> {
        review
            .groups
            .iter()
            .filter(|group| group.name == ReviewGroupName::Blocking)
            .flat_map(|group| &group.findings)
            .map(|&position| review.findings[position].finding.code.clone())
            .collect()
    };
    // Publishing this post is refused for its unresolved citation and the damaged
    // atlas; the next build is refused only for the damaged atlas, because a
    // draft's citation only warns until it is published.
    assert_eq!(blocking(&post), ["file-unreadable", "citation-unresolved"]);
    assert_eq!(blocking(&site), ["file-unreadable"]);
    assert_eq!(site.blocking(), 1);
    assert_eq!(post.blocking(), 2);
    let unresolved = site
        .findings
        .iter()
        .find(|entry| entry.finding.code == "citation-unresolved")
        .unwrap();
    assert_eq!(unresolved.finding.gate, Gate::RefusesWhenPublished);
}

#[test]
fn the_terminal_lists_the_json_groups_in_order_and_acknowledgement_never_resolves() {
    let review = site();
    let text = review.text();
    // One line per finding, then the counts; the lines follow the groups.
    let listed: Vec<String> = review
        .groups
        .iter()
        .flat_map(|group| &group.findings)
        .map(|&position| {
            let finding = &review.findings[position].finding;
            format!("[{}: {}]", finding.validator, finding.code)
        })
        .collect();
    let printed: Vec<&str> = text
        .lines()
        .filter(|line| line.starts_with("research "))
        .map(|line| &line[line.rfind('[').unwrap()..])
        .collect();
    assert_eq!(printed, listed);
    assert_eq!(text.lines().count(), listed.len() + 1);
    assert!(text
        .lines()
        .last()
        .unwrap()
        .starts_with("Research checks: "));
    // An acknowledgement is shown beside a finding that stays listed and counted.
    assert!(text.contains("research potential (acknowledged): posts/cave.md:5:1"));
    assert!(text.contains("(acknowledgement stale)"));
    for line in text.lines().filter(|line| line.contains("(acknowledged)")) {
        assert!(!line.to_lowercase().contains("resolved"), "{line}");
    }
    assert_eq!(review.counts.potential.found, 1);
    assert_eq!(review.counts.potential.acknowledged, 1);
    let stale = review
        .findings
        .iter()
        .find(|entry| entry.finding.code == "abstract-missing")
        .unwrap();
    assert_eq!(stale.acknowledgement, Some(AcknowledgementState::Stale));
    assert_eq!(review.counts.detected.acknowledged, 0);
    // The stale approval withholds and is never acknowledged.
    let approval = review
        .findings
        .iter()
        .find(|entry| entry.finding.code == "stale-approval")
        .unwrap();
    assert_eq!(approval.finding.gate, Gate::Withholds);
    assert_eq!(approval.acknowledgement, None);
    assert_eq!(approval.finding.validator, Validator::Alignments);
    // The counts sentence is the one Admin shows.
    assert_eq!(
        review.counts_text(),
        "1 must be fixed before the next build. Detected: 4. Potential: 1 (1 acknowledged). Needs review: 2."
    );
}

#[test]
fn the_report_is_deterministic_whatever_order_findings_arrive_in_and_empty_prints_nothing() {
    let forward = site();
    let mut reversed = findings();
    reversed.reverse();
    let backward = PublicationReview::scoped(
        CompletenessReport::new(reversed, &acknowledgements()),
        ReviewScope::Site,
    );
    assert_eq!(json(&forward), json(&backward));
    assert_eq!(forward.text(), backward.text());
    let empty = PublicationReview::scoped(CompletenessReport::new([], &[]), ReviewScope::Site);
    assert_eq!(empty.text(), "");
    assert_eq!(empty.blocking(), 0);
    let value: Value = serde_json::from_str(&json(&empty)).unwrap();
    assert_eq!(value["findings"], serde_json::json!([]));
    assert_eq!(value["groups"], serde_json::json!([]));
}

#[test]
fn the_text_names_places_and_repairs_but_never_a_statement_or_a_score() {
    let text = site().text();
    for word in ["score", "passed", "verdict", "ready to publish"] {
        assert!(!text.to_lowercase().contains(word), "{word}");
    }
    assert!(text.contains("the Knowledge Atlas"));
    assert!(text.contains("posts/cave.md:12:1"));
    assert!(text.contains("claim c1"));
    assert!(text.contains("comparison cave-places"));
}

#[test]
fn a_blocking_sentence_names_what_it_holds_up_in_each_scope() {
    let report = || CompletenessReport::new(findings(), &acknowledgements());
    let post = PublicationReview::scoped(report(), ReviewScope::Post);
    let site = PublicationReview::scoped(report(), ReviewScope::Site);
    assert!(post
        .counts_text()
        .contains("must be fixed before publishing."));
    assert!(site
        .counts_text()
        .contains("must be fixed before the next build."));
    assert_eq!(
        serde_json::to_value(&site).unwrap()["scope"],
        serde_json::json!("site")
    );
}
