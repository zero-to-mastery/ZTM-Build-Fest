//! The research review before publication (#62, ADR 0123, ADR 0124): the
//! adapter onto the research-completeness contract groups findings by what
//! blocks the build and by outcome, keeps the contract's order and codes,
//! never scores anything, lets only advisory findings be acknowledged, and
//! never relabels an acknowledged finding resolved.

use openblog_core::context_links::{find_context_links, review_context_links, ContextGap};
use openblog_core::knowledge_atlas::{AtlasDiagnostic, AtlasDiagnosticCode, DiagnosticSubject};
use openblog_core::publication_review::{
    acknowledgeable, Acknowledgement, AcknowledgementSet, AcknowledgementState, Gate, ObjectKind,
    PublicationReview, ReviewFinding, ReviewGroupName, Validator, FILE_UNREADABLE,
};
use openblog_core::research::{
    EvidenceCode, EvidenceFinding, EvidenceObject, EvidenceOutcome, EvidenceSource,
};

fn evidence(code: EvidenceCode, outcome: EvidenceOutcome, line: Option<usize>) -> EvidenceFinding {
    EvidenceFinding {
        code,
        outcome,
        source: EvidenceSource {
            path: "posts/cave.md".into(),
            line,
            column: None,
            field: None,
        },
        message: format!("{code} at line {line:?}"),
        repair: "Do the thing.".into(),
        object: None,
        facts: Vec::new(),
    }
}

fn claim_finding(code: EvidenceCode, claim: &str, link: Option<&str>) -> EvidenceFinding {
    EvidenceFinding {
        object: Some(EvidenceObject {
            claim: claim.into(),
            link: link.map(str::to_string),
        }),
        ..evidence(code, EvidenceOutcome::Potential, None)
    }
}

fn notice(subject: DiagnosticSubject, code: AtlasDiagnosticCode, id: &str) -> AtlasDiagnostic {
    AtlasDiagnostic {
        code,
        subject,
        collection: Some(match subject {
            DiagnosticSubject::Atlas => "entries",
            DiagnosticSubject::Claims => "claims",
            DiagnosticSubject::Alignments => "alignments",
        }),
        index: Some(0),
        id: Some(id.into()),
        field: None,
        message: format!("notice about {id}"),
        facts: Vec::new(),
    }
}

fn sample() -> Vec<ReviewFinding> {
    vec![
        ReviewFinding::from_evidence(&evidence(
            EvidenceCode::CitationLocationReview,
            EvidenceOutcome::NeedsReview,
            Some(9),
        )),
        ReviewFinding::from_evidence(&evidence(
            EvidenceCode::CitationUnresolved,
            EvidenceOutcome::Detected,
            Some(12),
        )),
        ReviewFinding::from_evidence(&claim_finding(
            EvidenceCode::ClaimEvidenceMissing,
            "c1",
            None,
        )),
        ReviewFinding::from_evidence(&claim_finding(
            EvidenceCode::ClaimLocatorMissing,
            "c1",
            Some("l1"),
        )),
        ReviewFinding::from_atlas_diagnostic(&notice(
            DiagnosticSubject::Atlas,
            AtlasDiagnosticCode::UnpublishedDatings,
            "plato",
        )),
        ReviewFinding::from_evidence(&evidence(
            EvidenceCode::AbstractMissing,
            EvidenceOutcome::Detected,
            None,
        )),
        ReviewFinding::unreadable(ObjectKind::Atlas, "cannot read the atlas"),
    ]
}

#[test]
fn findings_are_grouped_by_what_blocks_the_build_then_by_outcome_in_one_order() {
    let review = PublicationReview::new(sample(), &[]);
    let names: Vec<ReviewGroupName> = review.groups.iter().map(|group| group.name).collect();
    assert_eq!(
        names,
        vec![
            ReviewGroupName::Blocking,
            ReviewGroupName::Detected,
            ReviewGroupName::Potential,
            ReviewGroupName::NeedsReview
        ]
    );
    let codes = |name: ReviewGroupName| -> Vec<String> {
        review
            .groups
            .iter()
            .find(|group| group.name == name)
            .unwrap()
            .findings
            .iter()
            .map(|&index| review.findings[index].finding.code.clone())
            .collect()
    };
    assert_eq!(
        codes(ReviewGroupName::Blocking),
        vec![FILE_UNREADABLE, "citation-unresolved"]
    );
    assert_eq!(
        codes(ReviewGroupName::Detected),
        vec!["unpublished-datings", "abstract-missing"]
    );
    assert_eq!(
        codes(ReviewGroupName::Potential),
        vec!["claim-evidence-missing", "claim-locator-missing"]
    );
    assert_eq!(
        codes(ReviewGroupName::NeedsReview),
        vec!["citation-location-review"]
    );
    // The order depends only on the set of findings.
    let mut reversed = sample();
    reversed.reverse();
    assert_eq!(PublicationReview::new(reversed, &[]), review);
    // Exact duplicates collapse; nothing else is merged.
    let mut doubled = sample();
    doubled.extend(sample());
    assert_eq!(PublicationReview::new(doubled, &[]), review);
}

#[test]
fn findings_keep_their_validators_codes_and_scopes_and_only_refusals_block() {
    let review = PublicationReview::new(sample(), &[]);
    let by_code = |code: &str| {
        &review
            .findings
            .iter()
            .find(|entry| entry.finding.code == code)
            .unwrap()
            .finding
    };
    let unresolved = by_code("citation-unresolved");
    assert_eq!(unresolved.validator, Validator::CitationReview);
    assert_eq!(unresolved.gate, Gate::RefusesWhenPublished);
    assert!(unresolved.blocks_publication());
    assert_eq!(unresolved.scope.line, Some(12));
    let link = by_code("claim-locator-missing");
    assert_eq!(link.scope.object, ObjectKind::EvidenceLink);
    assert_eq!(link.scope.id.as_deref(), Some("l1"));
    assert_eq!(link.related[0].id, "c1");
    let dating = by_code("unpublished-datings");
    assert_eq!(dating.validator, Validator::Atlas);
    assert_eq!(dating.scope.object, ObjectKind::Entry);
    assert!(!dating.blocks_publication());
    for entry in &review.findings {
        let blocks = entry.finding.blocks_publication();
        assert_eq!(blocks, entry.finding.gate != Gate::Advisory);
        if entry.finding.outcome != EvidenceOutcome::Detected {
            assert!(!blocks, "a potential or needs-review finding never blocks");
        }
    }
    let json = serde_json::to_string(&review).unwrap();
    for word in [
        "\"score\"",
        "\"total\"",
        "\"resolved\"",
        "\"ready\"",
        "\"pass\"",
        "\"verdict\"",
    ] {
        assert!(!json.contains(word), "{word} in {json}");
    }
    assert!(!json.contains("facts"), "facts are never serialized");
}

#[test]
fn only_advisory_findings_can_be_acknowledged() {
    for finding in sample() {
        let acknowledgement = Acknowledgement::of(&finding);
        assert_eq!(acknowledgement.is_some(), finding.gate == Gate::Advisory);
        assert_eq!(
            acknowledgeable(finding.validator, &finding.code),
            finding.gate == Gate::Advisory,
            "{}",
            finding.code
        );
    }
    assert!(!acknowledgeable(Validator::Atlas, "invalid-json"));
    assert!(!acknowledgeable(
        Validator::SourceLibrary,
        "contributor-credit"
    ));
    assert!(!acknowledgeable(
        Validator::ResearchProfile,
        "citation-location-review"
    ));
    assert!(acknowledgeable(
        Validator::ChronologyIndex,
        "death-before-birth"
    ));
    assert!(acknowledgeable(
        Validator::ComparisonProjection,
        "withheld-rights"
    ));
    // A stored acknowledgement of a refusing code is never applied.
    let unresolved = sample().remove(1);
    let forged = Acknowledgement {
        validator: unresolved.validator,
        code: unresolved.code.clone(),
        object: unresolved.scope.object,
        path: unresolved.scope.path.clone(),
        id: None,
        field: None,
        fingerprint: unresolved.fingerprint(),
    };
    assert!(forged.problem().is_some());
    let review = PublicationReview::new(sample(), &[forged]);
    assert!(review
        .findings
        .iter()
        .all(|entry| entry.acknowledgement.is_none()));
    assert_eq!(review.unmatched_acknowledgements, 0);
}

#[test]
fn an_acknowledged_finding_is_still_listed_and_counted_and_goes_stale_when_it_changes() {
    let findings = sample();
    let location = Acknowledgement::of(&findings[0]).unwrap();
    let review = PublicationReview::new(findings.clone(), std::slice::from_ref(&location));
    let entry = review
        .findings
        .iter()
        .find(|entry| entry.finding.code == "citation-location-review")
        .unwrap();
    assert_eq!(entry.acknowledgement, Some(AcknowledgementState::Current));
    assert_eq!(
        review.findings.len(),
        PublicationReview::new(sample(), &[]).findings.len()
    );
    assert_eq!(review.counts.needs_review.found, 1);
    assert_eq!(review.counts.needs_review.acknowledged, 1);

    // A line or message change moves nothing: the fingerprint holds no position or wording.
    let moved = ReviewFinding::from_evidence(&evidence(
        EvidenceCode::CitationLocationReview,
        EvidenceOutcome::NeedsReview,
        Some(40),
    ));
    assert_eq!(moved.fingerprint(), findings[0].fingerprint());

    // A context link whose address changes goes stale; a stale one counts for nothing.
    let links = find_context_links("[a](/atlas/a/)", 3);
    let gap = |_: openblog_core::context_links::ContextKind, _: &str| Some(ContextGap::NotApproved);
    let before =
        ReviewFinding::from_context_link("posts/cave.md", &review_context_links(&links, gap)[0]);
    let acknowledged = Acknowledgement::of(&before).unwrap();
    let links = find_context_links("[a](/atlas/a/#dates)", 3);
    let after =
        ReviewFinding::from_context_link("posts/cave.md", &review_context_links(&links, gap)[0]);
    let stale = PublicationReview::new(vec![after], std::slice::from_ref(&acknowledged));
    assert_eq!(
        stale.findings[0].acknowledgement,
        Some(AcknowledgementState::Stale)
    );
    assert_eq!(stale.counts.detected.acknowledged, 0);

    // Two findings under one key: acknowledging one leaves the other unacknowledged, not stale.
    let one = ReviewFinding::from_context_link(
        "posts/cave.md",
        &review_context_links(&find_context_links("[a](/atlas/a/)", 1), gap)[0],
    );
    let two = ReviewFinding::from_context_link(
        "posts/cave.md",
        &review_context_links(&find_context_links("[b](/atlas/b/)", 1), gap)[0],
    );
    let pair = PublicationReview::new(
        vec![one.clone(), two],
        &[Acknowledgement::of(&one).unwrap()],
    );
    let states: Vec<_> = pair
        .findings
        .iter()
        .map(|entry| entry.acknowledgement)
        .collect();
    assert!(states.contains(&Some(AcknowledgementState::Current)));
    assert!(states.contains(&None));
    assert!(!states.contains(&Some(AcknowledgementState::Stale)));

    // An acknowledgement no finding has any more is counted apart, never shown as a resolution.
    let gone = PublicationReview::new(Vec::new(), &[location]);
    assert_eq!(gone.unmatched_acknowledgements, 1);
    assert!(gone.findings.is_empty());
}

#[test]
fn the_acknowledgements_file_is_strict_sorted_and_holds_nothing_private() {
    let finding = sample().remove(0);
    let mut set = AcknowledgementSet::empty();
    set.add(Acknowledgement::of(&finding).unwrap()).unwrap();
    set.add(Acknowledgement::of(&finding).unwrap()).unwrap();
    assert_eq!(
        set.acknowledgements.len(),
        1,
        "a finding is acknowledged once"
    );
    let json = set.to_json();
    assert_eq!(AcknowledgementSet::parse(&json).unwrap(), set);
    assert!(json.ends_with('\n'));
    for hostile in [
        r#"{"version":1,"acknowledgements":[],"note":"x"}"#,
        r#"{"version":3,"acknowledgements":[]}"#,
        r#"{"version":1,"acknowledgements":[{"validator":"research-profile","code":"abstract-missing","object":"post","fingerprint":"XYZ"}]}"#,
        r#"{"version":1,"acknowledgements":[{"validator":"research-profile","code":"abstract-missing","object":"post","path":"a\u0000b","fingerprint":"0123456789abcdef0123456789abcdef"}]}"#,
        r#"{"version":1,"acknowledgements":[{"validator":"citation-review","code":"citation-syntax","object":"post","fingerprint":"0123456789abcdef0123456789abcdef"}]}"#,
    ] {
        assert!(AcknowledgementSet::parse(hostile).is_err(), "{hostile}");
    }
    let acknowledgement = Acknowledgement::of(&finding).unwrap();
    assert!(set.withdraw(&acknowledgement));
    assert!(set.acknowledgements.is_empty());
    assert!(!set.withdraw(&acknowledgement));
}

#[test]
fn acknowledging_one_unresolved_footnote_does_not_acknowledge_another() {
    // Two findings with no id or field share a key; the facts the research
    // audit states (the footnote's name) tell them apart.
    let front = openblog_core::frontmatter::parse(
        "---
title: Cave
---
",
    )
    .unwrap()
    .front_matter;
    let audit = |body: &str| -> Vec<ReviewFinding> {
        openblog_core::research::audit_document("posts/cave.md", &front, body, 4)
            .iter()
            .filter(|finding| finding.code == EvidenceCode::FootnoteUnresolved)
            .map(ReviewFinding::from_evidence)
            .collect()
    };
    let only_a = audit(
        "Text.[^a]
",
    );
    assert_eq!(only_a.len(), 1);
    let acknowledged = Acknowledgement::of(&only_a[0]).unwrap();

    let both = audit(
        "Text.[^a] More.[^b]
",
    );
    assert_eq!(both.len(), 2);
    assert_ne!(both[0].fingerprint(), both[1].fingerprint());
    let review = PublicationReview::new(both, std::slice::from_ref(&acknowledged));
    let states: Vec<_> = review
        .findings
        .iter()
        .map(|entry| (entry.finding.message.clone(), entry.acknowledgement))
        .collect();
    assert_eq!(
        states,
        vec![
            (
                "Footnote `[^a]` has no definition.".to_string(),
                Some(AcknowledgementState::Current)
            ),
            ("Footnote `[^b]` has no definition.".to_string(), None),
        ]
    );
    assert_eq!(review.counts.detected.acknowledged, 1);

    // A new footnote alone is never read as the acknowledged one.
    let only_b = PublicationReview::new(
        audit(
            "Text.[^b]
",
        ),
        &[acknowledged],
    );
    assert_ne!(
        only_b.findings[0].acknowledgement,
        Some(AcknowledgementState::Current)
    );
}

#[test]
fn a_stale_approval_withholds_its_comparison_and_cannot_be_acknowledged() {
    let stale = ReviewFinding::from_atlas_diagnostic(&notice(
        DiagnosticSubject::Alignments,
        AtlasDiagnosticCode::StaleApproval,
        "cave",
    ));
    assert_eq!(stale.gate, Gate::Withholds);
    assert!(!stale.blocks_publication(), "the post still publishes");
    assert!(Acknowledgement::of(&stale).is_none());
    assert!(!acknowledgeable(Validator::Alignments, "stale-approval"));
    // Locator drift with no recorded approval stays an advisory notice.
    let drift = ReviewFinding::from_atlas_diagnostic(&notice(
        DiagnosticSubject::Alignments,
        AtlasDiagnosticCode::StaleLocator,
        "cave",
    ));
    assert_eq!(drift.gate, Gate::Advisory);
    assert!(Acknowledgement::of(&drift).is_some());
    assert!(acknowledgeable(Validator::Alignments, "stale-locator"));
}
