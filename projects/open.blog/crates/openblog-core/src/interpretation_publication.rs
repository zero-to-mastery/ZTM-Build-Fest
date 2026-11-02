//! The public interpretation comparisons a build publishes (ADR 0232, #90).
//!
//! [`PublicInterpretations`] is built only from [`PublicComparison::project`]
//! (ADR 0230) and from the descriptions of the sources and evidence links the
//! build itself publishes. The pages read nothing else, never the stored
//! comparison file, so what is private (a draft, an unapproved AI draft, a
//! source nothing public cites, a link the author did not approve) has no
//! path into a page.
//!
//! What counts as public is deliberately narrow: a comparison may point at an
//! evidence link only while `claimEvidence.publish` is on and the link is an
//! approved link of an approved claim, and at a source only through such a
//! link. Anything else a comparison points at is dropped from the public
//! value (evidence) or keeps the whole interpretation off the page
//! (attribution), and the author is told which items, by id, never why a
//! value was private.

use std::collections::{BTreeMap, BTreeSet};

use crate::citations::{format_reference, public_reference, PublicLocator};
use crate::claims::ClaimSet;
use crate::scholarly_comparison::{
    Comparison, PublicComparison, References, Withheld, WithheldReason,
};
use crate::source_library::SourceLibrary;

/// The address of the comparison pages. `/comparisons/` already belongs to
/// published passage comparisons (ADR 0092).
pub const INTERPRETATIONS_URL: &str = "/interpretations/";
/// The first path segment the pages reserve while they are published.
pub const INTERPRETATIONS_SEGMENT: &str = "interpretations";

/// A published evidence link as a comparison shows it: the author's claim, how
/// the evidence relates to it, and where in the source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicLink {
    pub claim: String,
    pub relation: &'static str,
    pub source: String,
    pub locators: Vec<PublicLocator>,
}

/// One published comparison and the address of its page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedComparison {
    pub url: String,
    pub comparison: PublicComparison,
}

/// Everything the pages and the sitemap read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PublicInterpretations {
    /// In slug order.
    pub comparisons: Vec<PublishedComparison>,
    /// Formatted reference text of each public source, by source id.
    pub sources: BTreeMap<String, String>,
    /// Each public evidence link, by link id.
    pub links: BTreeMap<String, PublicLink>,
}

/// The result of resolving the author's comparison files against what the
/// build publishes.
#[derive(Clone, Debug, Default)]
pub struct Resolution {
    pub public: PublicInterpretations,
    /// For the author, one line per item left out of a published comparison,
    /// naming the comparison and the item id and never a value.
    pub diagnostics: Vec<String>,
}

pub fn page_url(slug: &str) -> String {
    format!("{INTERPRETATIONS_URL}{slug}/")
}

impl PublicInterpretations {
    /// The sources and evidence links the build publishes: only an approved
    /// link of an approved claim, and the source it cites, and only while the
    /// site publishes claim evidence. `set` and `library` are the author's
    /// private files; nothing of them is kept except what is public.
    pub fn publishable(
        set: &ClaimSet,
        library: &SourceLibrary,
        claim_evidence_published: bool,
    ) -> (
        References,
        BTreeMap<String, String>,
        BTreeMap<String, PublicLink>,
    ) {
        let mut refs = References::default();
        let mut sources = BTreeMap::new();
        let mut links = BTreeMap::new();
        if !claim_evidence_published {
            return (refs, sources, links);
        }
        for link in set.projected_links() {
            let Some(claim) = set.claim(&link.claim) else {
                continue;
            };
            let Some(record) = library.get(&link.evidence.source) else {
                continue;
            };
            let id = &link.evidence.source;
            sources
                .entry(id.clone())
                .or_insert_with(|| format_reference(&public_reference(record)));
            refs.sources.insert(id.clone());
            refs.evidence_links.insert(link.id.clone());
            links.insert(
                link.id.clone(),
                PublicLink {
                    claim: claim.statement.clone(),
                    relation: link.relation.as_str(),
                    source: id.clone(),
                    locators: link
                        .evidence
                        .locators
                        .iter()
                        .map(PublicLocator::from)
                        .collect(),
                },
            );
        }
        (refs, sources, links)
    }

    /// Projects every comparison against the public references. A draft
    /// publishes nothing and is not reported (it is meant to be unfinished);
    /// anything left out of a comparison that is published is reported.
    pub fn resolve(
        comparisons: &[Comparison],
        refs: &References,
        sources: BTreeMap<String, String>,
        links: BTreeMap<String, PublicLink>,
    ) -> Resolution {
        let mut published = Vec::new();
        let mut diagnostics = Vec::new();
        let mut seen = BTreeSet::new();
        let mut ordered: Vec<&Comparison> = comparisons.iter().collect();
        ordered.sort_by(|a, b| a.slug.cmp(&b.slug));
        for comparison in ordered {
            if !seen.insert(comparison.slug.as_str()) {
                continue;
            }
            let (projected, withheld) = PublicComparison::project(comparison, refs);
            let draft = withheld.iter().any(|w| w.reason == WithheldReason::Draft);
            if !draft {
                for Withheld { id, reason } in &withheld {
                    diagnostics.push(format!(
                        "interpretation comparison `{}`: `{id}` is left out of the page ({})",
                        comparison.slug,
                        reason_text(*reason)
                    ));
                }
            }
            if let Some(projected) = projected {
                published.push(PublishedComparison {
                    url: page_url(&projected.slug),
                    comparison: projected,
                });
            }
        }
        // Keep only the descriptions the published comparisons point at, so
        // nothing else about the public evidence is carried.
        let mut used_sources = BTreeSet::new();
        let mut used_links = BTreeSet::new();
        for p in &published {
            let c = &p.comparison;
            for i in &c.interpretations {
                if let crate::scholarly_comparison::PublicAttribution::Source { source, .. } =
                    &i.attribution
                {
                    used_sources.insert(source.clone());
                }
                note_evidence(&i.evidence, &mut used_sources, &mut used_links);
            }
            for x in &c.explanations {
                note_evidence(&x.evidence, &mut used_sources, &mut used_links);
            }
        }
        for id in used_links.clone() {
            if let Some(link) = links.get(&id) {
                used_sources.insert(link.source.clone());
            }
        }
        Resolution {
            public: PublicInterpretations {
                comparisons: published,
                sources: sources
                    .into_iter()
                    .filter(|(id, _)| used_sources.contains(id))
                    .collect(),
                links: links
                    .into_iter()
                    .filter(|(id, _)| used_links.contains(id))
                    .collect(),
            },
            diagnostics,
        }
    }
}

fn note_evidence(
    evidence: &[crate::scholarly_comparison::PublicEvidence],
    sources: &mut BTreeSet<String>,
    links: &mut BTreeSet<String>,
) {
    for e in evidence {
        match e {
            crate::scholarly_comparison::PublicEvidence::Link { link } => {
                links.insert(link.clone());
            }
            crate::scholarly_comparison::PublicEvidence::Source { source, .. } => {
                sources.insert(source.clone());
            }
        }
    }
}

fn reason_text(reason: WithheldReason) -> &'static str {
    match reason {
        WithheldReason::AwaitingApproval => "an AI draft nobody has approved",
        WithheldReason::StaleApproval => "an AI draft edited after it was approved",
        WithheldReason::SubjectWithheld => "it explains an interpretation that is left out",
        WithheldReason::EvidenceNotPublic => "some evidence is not published and was dropped",
        WithheldReason::AttributionNotPublic => {
            "it is attributed to a source that is not published"
        }
        WithheldReason::Withdrawn => "the author withdrew it",
        WithheldReason::Draft => "the comparison is a draft",
        WithheldReason::TooFewInterpretations => {
            "fewer than two interpretations can be shown, so the comparison is not published"
        }
    }
}
