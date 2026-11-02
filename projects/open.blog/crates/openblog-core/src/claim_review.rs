//! Evidence gaps and provenance prompts for private claims (ADR 0074).
//!
//! A review reads a valid claims file beside the saved drafts, the source
//! library and the notebook, and reports [`EvidenceFinding`]s in the shared
//! finding contract that citation and research checks already use, so
//! `openblog check`, builds and Evidence Studio show the same findings in the
//! same order.
//!
//! Every finding is a gap in the author's record or a prompt for something
//! only a person can do: a claim with no evidence, contradicting evidence the
//! draft may not discuss yet, a source or passage that is archived, a link
//! without a location or a rationale, a location nobody has checked, a
//! suggestion nobody has reviewed, or words that are no longer where they
//! were anchored. None of them says whether a claim is true, whether a
//! source is right or authoritative, or how strong the evidence is: there is
//! no score and no combined figure, and findings are never summed into one.
//!
//! Findings name ids, slugs, relations and counts only. They never repeat a
//! statement, rationale, uncertainty note, anchor text or passage, so a
//! finding is safe on a terminal or in a build log.

use std::collections::BTreeMap;

use crate::claims::{
    anchor_status, AnchorCheck, Claim, ClaimSet, Drafts, EvidenceLink, Origin, Relation,
    ReviewState,
};
use crate::research::{
    EvidenceCode as Code, EvidenceFinding, EvidenceObject, EvidenceOutcome as Outcome,
    EvidenceSource,
};
use crate::research_notes::{Locator, Notebook, Passage};
use crate::source_library::SourceLibrary;

/// What a review reads besides the claims file.
pub struct ReviewContext<'a> {
    /// Each post's anchor text by slug (see [`crate::claims::anchor_text`]).
    pub drafts: &'a Drafts,
    /// Each post's path relative to the content folder, by slug, so a finding
    /// names the post it is about.
    pub paths: &'a BTreeMap<String, String>,
    /// The claims file, named by findings about a claim whose post is missing.
    pub claims_file: &'a str,
    pub library: &'a SourceLibrary,
    pub notebook: &'a Notebook,
}

/// Review every claim in file order. Each claim's own findings come first,
/// in a fixed order (post or anchor, suggestion, missing evidence, support
/// only, undiscussed contradiction), then each of its links in file order
/// with theirs (suggestion, archived source, archived passage, missing
/// location, unchecked location, missing rationale). The same inputs always
/// give the same findings in the same order.
pub fn review_claims(set: &ClaimSet, context: &ReviewContext<'_>) -> Vec<EvidenceFinding> {
    let mut findings = Vec::new();
    for claim in &set.claims {
        review_claim(set, claim, context, &mut findings);
        for link in set.links_of(&claim.id) {
            review_link(claim, link, context, &mut findings);
        }
    }
    findings
}

/// Findings about one claim and its links, in review order, picked out of a
/// whole review so a view of one post keeps the order the CLI prints.
pub fn findings_for_post<'a>(
    findings: &'a [EvidenceFinding],
    set: &'a ClaimSet,
    post: &'a str,
) -> impl Iterator<Item = &'a EvidenceFinding> {
    findings.iter().filter(move |finding| {
        finding
            .object
            .as_ref()
            .and_then(|object| set.claim(&object.claim))
            .is_some_and(|claim| claim.post == post)
    })
}

struct Place<'a> {
    path: &'a str,
    claim: &'a str,
    link: Option<&'a str>,
}

impl Place<'_> {
    fn finding(
        &self,
        code: Code,
        outcome: Outcome,
        field: &str,
        message: String,
        repair: &str,
    ) -> EvidenceFinding {
        let scope = match self.link {
            Some(link) => format!("links[{link}]"),
            None => format!("claims[{}]", self.claim),
        };
        EvidenceFinding {
            code,
            outcome,
            source: EvidenceSource {
                path: self.path.to_string(),
                line: None,
                column: None,
                field: Some(if field.is_empty() {
                    scope
                } else {
                    format!("{scope}.{field}")
                }),
            },
            message,
            repair: repair.to_string(),
            object: Some(EvidenceObject {
                claim: self.claim.to_string(),
                link: self.link.map(str::to_string),
            }),
            facts: Vec::new(),
        }
    }
}

fn post_path<'a>(claim: &Claim, context: &'a ReviewContext<'_>) -> &'a str {
    context
        .paths
        .get(&claim.post)
        .filter(|_| context.drafts.contains_key(&claim.post))
        .map_or(context.claims_file, String::as_str)
}

fn review_claim(
    set: &ClaimSet,
    claim: &Claim,
    context: &ReviewContext<'_>,
    findings: &mut Vec<EvidenceFinding>,
) {
    let place = Place {
        path: post_path(claim, context),
        claim: &claim.id,
        link: None,
    };
    let id = &claim.id;
    if !context.drafts.contains_key(&claim.post) {
        findings.push(place.finding(
            Code::ClaimPostMissing,
            Outcome::Detected,
            "post",
            format!(
                "Claim `{id}` is about the post `{}`, but no saved post has that slug, so its words cannot be found in a draft.",
                claim.post
            ),
            "Save the post with that slug, or edit the claim in Evidence Studio to name the post it is about.",
        ).with_facts([claim.post.as_str()]));
    } else if let Some(check) = anchor_status(claim, context.drafts) {
        let (code, message, repair) = match check {
            AnchorCheck::Verified => (None, String::new(), ""),
            AnchorCheck::Moved { start } => (
                Some(Code::ClaimAnchorMoved),
                format!("The words claim `{id}` is anchored to are no longer at the recorded position in the saved draft; they occur once, from byte {start}. This compares text positions only."),
                "Re-anchor the claim to its new position in Evidence Studio.",
            ),
            AnchorCheck::Stale => (
                Some(Code::ClaimAnchorStale),
                format!("The words claim `{id}` is anchored to no longer occur in the saved draft, so evidence cannot be linked to it. This compares text positions only."),
                "Select the words the claim is about in the saved post and re-anchor it in Evidence Studio.",
            ),
            AnchorCheck::Ambiguous => (
                Some(Code::ClaimAnchorAmbiguous),
                format!("The words claim `{id}` is anchored to occur more than once in the saved draft and the recorded position no longer matches, so evidence cannot be linked to it. This compares text positions only."),
                "Select the occurrence you mean in the saved post and re-anchor the claim in Evidence Studio.",
            ),
        };
        if let Some(code) = code {
            findings.push(place.finding(code, Outcome::Detected, "anchor", message, repair));
        }
    }
    if claim.origin == Origin::Suggested {
        findings.push(place.finding(
            Code::ClaimSuggestionUnreviewed,
            Outcome::NeedsReview,
            "origin",
            format!("Claim `{id}` was suggested rather than written by you, so it is not your claim yet and cannot be approved."),
            "Read it, then edit it in Evidence Studio as your own, or remove it.",
        ));
    }
    let counts = set.counts(id);
    let linked = |relation: Relation| {
        set.links_of(id)
            .filter(move |link| link.relation == relation)
            .map(|link| link.id.as_str())
    };
    let total = counts.supports + counts.contradicts + counts.contextualizes;
    if total == 0 {
        findings.push(place.finding(
            Code::ClaimEvidenceMissing,
            Outcome::Potential,
            "",
            format!("Claim `{id}` has no evidence links: no source is recorded as supporting, contradicting or contextualizing it. This is a gap in the record, not a judgement of the claim."),
            "Link the sources you relied on, including any that disagree, in Evidence Studio.",
        ));
    }
    if claim.uncertainty.is_some() && counts.supports > 0 && counts.supports == total {
        findings.push(place.finding(
            Code::ClaimSupportOnly,
            Outcome::NeedsReview,
            "uncertainty",
            format!(
                "Claim `{id}` has an uncertainty note, but all {total} of its evidence link{} support it; no contradicting or contextualizing source is recorded.",
                if total == 1 { "" } else { "s" }
            ),
            "If the doubt comes from a source, link it as contradicting or contextualizing evidence in Evidence Studio; if not, nothing needs to change.",
        ).with_facts(linked(Relation::Supports)));
    }
    if counts.contradicts > 0 && claim.uncertainty.is_none() {
        findings.push(place.finding(
            Code::ClaimContradictionUndiscussed,
            Outcome::NeedsReview,
            "uncertainty",
            format!(
                "Claim `{id}` has {} contradicting evidence link{} and no uncertainty note saying how the post addresses {}.",
                counts.contradicts,
                if counts.contradicts == 1 { "" } else { "s" },
                if counts.contradicts == 1 { "it" } else { "them" }
            ),
            "Discuss the contradicting evidence in the post, then record how in the claim's uncertainty note in Evidence Studio.",
        ).with_facts(linked(Relation::Contradicts)));
    }
}

fn review_link(
    claim: &Claim,
    link: &EvidenceLink,
    context: &ReviewContext<'_>,
    findings: &mut Vec<EvidenceFinding>,
) {
    let place = Place {
        path: post_path(claim, context),
        claim: &claim.id,
        link: Some(&link.id),
    };
    let id = &link.id;
    let source = &link.evidence.source;
    let passage = link
        .evidence
        .passage
        .as_deref()
        .and_then(|passage| context.notebook.passage(passage));
    let suggested = link.origin == Origin::Suggested && link.review_state != ReviewState::Reviewed;
    if suggested {
        findings.push(place.finding(
            Code::ClaimSuggestionUnreviewed,
            Outcome::NeedsReview,
            "reviewState",
            format!("Evidence link `{id}` was suggested rather than recorded by you, and nobody has reviewed it, so it is not your reading of source `{source}` yet."),
            "Read the source, then set the link's review state to reviewed in Evidence Studio, or remove the link.",
        ).with_facts([source.as_str()]));
    }
    if context
        .library
        .get(source)
        .is_some_and(|record| record.archived)
    {
        findings.push(place.finding(
            Code::ClaimSourceArchived,
            Outcome::NeedsReview,
            "evidence.source",
            format!("Evidence link `{id}` rests on source `{source}`, which is archived in your library."),
            "Decide whether the link should still rest on it: restore the source in Sources, link a current one, or remove the link.",
        ).with_facts([source.as_str()]));
    }
    if let Some(passage) = passage.filter(|passage| passage.archived) {
        findings.push(place.finding(
            Code::ClaimPassageArchived,
            Outcome::NeedsReview,
            "evidence.passage",
            format!(
                "Evidence link `{id}` points to notebook passage `{}`, which is archived.",
                passage.id
            ),
            "Decide whether the link should still point to it: restore the passage in the notebook, choose another, or remove it from the link.",
        ).with_facts([passage.id.as_str()]));
    }
    let located =
        !link.evidence.locators.is_empty() || passage.is_some_and(|p| !p.locators.is_empty());
    if !located {
        findings.push(place.finding(
            Code::ClaimLocatorMissing,
            Outcome::Potential,
            "evidence.locators",
            format!("Evidence link `{id}` names source `{source}` but no page or other location in it, so the passage the link rests on cannot be found again from the record."),
            "If the link rests on a particular passage, add where it is, such as page: 514, in Evidence Studio.",
        ).with_facts([source.as_str()]));
    } else if link.review_state == ReviewState::Unreviewed && !suggested {
        findings.push(place.finding(
            Code::ClaimLocationUnreviewed,
            Outcome::NeedsReview,
            "reviewState",
            format!("Evidence link `{id}` gives a location in source `{source}`. open.blog checked only that the location is well formed and fits the source; nobody has recorded checking that the passage is there."),
            "Compare the location with the source, then set the link's review state to location checked or reviewed in Evidence Studio.",
        ).with_facts(location_facts(link, passage)));
    }
    if link.rationale.is_none() {
        let reading = match link.relation {
            Relation::Supports => "supports",
            Relation::Contradicts => "contradicts",
            Relation::Contextualizes => "contextualizes",
        };
        findings.push(place.finding(
            Code::ClaimRationaleMissing,
            Outcome::Potential,
            "rationale",
            format!(
                "Evidence link `{id}` records that source `{source}` {reading} claim `{}`, but not why you read it that way.",
                claim.id
            ),
            "Add a rationale to the link in Evidence Studio.",
        ).with_facts([source.as_str(), reading]));
    }
}

/// What a link's location is: its source, its own locators and its passage
/// with that passage's locators, in record order.
fn location_facts(link: &EvidenceLink, passage: Option<&Passage>) -> Vec<String> {
    let mut facts = vec![link.evidence.source.clone()];
    facts.extend(link.evidence.locators.iter().map(Locator::stated));
    if let Some(passage) = passage {
        facts.push(format!("passage {}", passage.id));
        facts.extend(passage.locators.iter().map(Locator::stated));
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_atlas::Links;
    use serde_json::{json, Value};

    const SENTINELS: [&str; 5] = [
        "ob-statement-4411",
        "ob-uncertainty-4412",
        "ob-rationale-4413",
        "ob-anchor-4414",
        "ob-passage-4415",
    ];

    fn library() -> SourceLibrary {
        let text = json!({"version": 1, "sources": [
            {"id": "plato", "kind": "work", "title": "Politeia"},
            {"id": "slings", "kind": "edition", "of": "plato", "title": "Edition"},
            {"id": "old-study", "kind": "work", "title": "Old", "archived": true}
        ]})
        .to_string();
        SourceLibrary::parse(&text, &BTreeMap::new()).expect("library")
    }

    fn notebook(library: &SourceLibrary) -> Notebook {
        let text = json!({"version": 1, "passages": [
            {"id": "p-located", "source": "slings", "excerpt": {"text": SENTINELS[4]},
             "locators": [{"kind": "page", "value": "514"}]},
            {"id": "p-bare", "source": "slings", "excerpt": {"text": "bare"}},
            {"id": "p-archived", "source": "slings", "excerpt": {"text": "set aside"}, "archived": true}
        ], "notes": []})
        .to_string();
        Notebook::parse(&text, library).expect("notebook")
    }

    struct Fixture {
        library: SourceLibrary,
        notebook: Notebook,
        drafts: Drafts,
        paths: BTreeMap<String, String>,
    }

    fn fixture(draft: &str) -> Fixture {
        let library = library();
        let notebook = notebook(&library);
        Fixture {
            notebook,
            library,
            drafts: [("cave".to_string(), draft.to_string())].into(),
            paths: [("cave".to_string(), "posts/2026-01-07-cave.md".to_string())].into(),
        }
    }

    fn review(f: &Fixture, value: Value) -> Vec<EvidenceFinding> {
        let set = ClaimSet::parse(
            &value.to_string(),
            Links {
                library: &f.library,
                notebook: &f.notebook,
            },
        )
        .expect("valid claims");
        review_claims(
            &set,
            &ReviewContext {
                drafts: &f.drafts,
                paths: &f.paths,
                claims_file: ".openblog/private/research/claims.json",
                library: &f.library,
                notebook: &f.notebook,
            },
        )
    }

    fn codes(findings: &[EvidenceFinding]) -> Vec<String> {
        findings
            .iter()
            .map(|f| {
                format!(
                    "{} {} {}",
                    f.code,
                    f.outcome,
                    f.source.field.as_deref().unwrap_or("")
                )
            })
            .collect()
    }

    fn reviewed_link(id: &str, claim: &str, relation: &str) -> Value {
        json!({"id": id, "claim": claim, "relation": relation,
            "evidence": {"source": "slings", "locators": [{"kind": "page", "value": "514"}]},
            "rationale": SENTINELS[2], "reviewState": "reviewed"})
    }

    #[test]
    fn a_well_recorded_claim_has_no_findings() {
        let f = fixture(&format!("The {} cave.", SENTINELS[3]));
        let findings = review(
            &f,
            json!({"version": 1,
                "claims": [{"id": "c1", "post": "cave", "statement": SENTINELS[0],
                    "anchor": {"start": 4, "end": 4 + SENTINELS[3].len(), "text": SENTINELS[3]}}],
                "links": [reviewed_link("l1", "c1", "supports")]}),
        );
        assert!(findings.is_empty(), "{findings:?}");
    }

    #[test]
    fn every_gap_is_named_by_property_scoped_to_its_record_and_ordered() {
        let f = fixture("The cave is dark. The cave is deep.");
        let findings = review(
            &f,
            json!({"version": 1,
            "claims": [
                {"id": "c1", "post": "cave", "statement": SENTINELS[0]},
                {"id": "c2", "post": "cave", "statement": "S", "uncertainty": SENTINELS[1],
                 "anchor": {"start": 4, "end": 8, "text": "dark"}},
                {"id": "c3", "post": "cave", "statement": "S", "origin": "suggested",
                 "anchor": {"start": 1, "end": 9, "text": "The cave"}},
                {"id": "c4", "post": "gone", "statement": "S"}
            ],
            "links": [
                {"id": "l1", "claim": "c2", "relation": "supports",
                 "evidence": {"source": "old-study"}},
                {"id": "l2", "claim": "c3", "relation": "contradicts",
                 "evidence": {"source": "slings", "passage": "p-archived"},
                 "origin": "suggested", "rationale": SENTINELS[2]},
                {"id": "l3", "claim": "c3", "relation": "contextualizes",
                 "evidence": {"source": "slings", "passage": "p-located"}}
            ]}),
        );
        assert_eq!(
            codes(&findings),
            [
                "claim-evidence-missing potential claims[c1]",
                "claim-anchor-moved detected claims[c2].anchor",
                "claim-support-only needs-review claims[c2].uncertainty",
                "claim-source-archived needs-review links[l1].evidence.source",
                "claim-locator-missing potential links[l1].evidence.locators",
                "claim-rationale-missing potential links[l1].rationale",
                "claim-anchor-ambiguous detected claims[c3].anchor",
                "claim-suggestion-unreviewed needs-review claims[c3].origin",
                "claim-contradiction-undiscussed needs-review claims[c3].uncertainty",
                "claim-suggestion-unreviewed needs-review links[l2].reviewState",
                "claim-passage-archived needs-review links[l2].evidence.passage",
                "claim-locator-missing potential links[l2].evidence.locators",
                "claim-location-unreviewed needs-review links[l3].reviewState",
                "claim-rationale-missing potential links[l3].rationale",
                "claim-post-missing detected claims[c4].post",
                "claim-evidence-missing potential claims[c4]",
            ]
        );
        // Findings name the post they are about, or the claims file when the
        // post is missing, and carry the record for Evidence Studio.
        assert!(findings[..14]
            .iter()
            .all(|f| f.source.path == "posts/2026-01-07-cave.md"));
        assert_eq!(
            findings[14].source.path,
            ".openblog/private/research/claims.json"
        );
        assert_eq!(
            findings[9].object,
            Some(EvidenceObject {
                claim: "c3".into(),
                link: Some("l2".into())
            })
        );
        // Every finding names an action, repeats no authored text, and never
        // passes judgement on truth.
        for finding in &findings {
            assert!(!finding.repair.is_empty());
            let text = format!("{} {}", finding.message, finding.repair).to_lowercase();
            for sentinel in SENTINELS.iter().chain(["dark", "the cave"].iter()) {
                assert!(!text.contains(sentinel), "{text}");
            }
            for verdict in [
                "verified", "true", "false", "proven", "correct", "accurate", "score", "valid",
            ] {
                assert!(!text.contains(verdict), "{verdict}: {text}");
            }
        }
        let location = &findings[12];
        assert!(location
            .message
            .contains("checked only that the location is well formed"));
        // The same inputs give the same findings.
        let again = review(
            &f,
            json!({"version": 1,
                "claims": [{"id": "c1", "post": "cave", "statement": SENTINELS[0]}]}),
        );
        assert_eq!(
            codes(&again),
            ["claim-evidence-missing potential claims[c1]"]
        );
    }

    #[test]
    fn a_gap_resolves_when_the_author_records_what_was_missing() {
        let f = fixture("The cave.");
        let open = json!({"version": 1,
            "claims": [{"id": "c1", "post": "cave", "statement": "S"}],
            "links": [{"id": "l1", "claim": "c1", "relation": "contradicts",
                       "evidence": {"source": "slings", "passage": "p-located"}}]});
        assert_eq!(
            codes(&review(&f, open.clone())),
            [
                "claim-contradiction-undiscussed needs-review claims[c1].uncertainty",
                "claim-location-unreviewed needs-review links[l1].reviewState",
                "claim-rationale-missing potential links[l1].rationale",
            ]
        );
        let mut discussed = open.clone();
        discussed["claims"][0]["uncertainty"] = json!("Discussed in the third paragraph.");
        discussed["links"][0]["rationale"] = json!("Reads otherwise.");
        discussed["links"][0]["reviewState"] = json!("location-checked");
        assert!(review(&f, discussed).is_empty());
        // A passage's own location counts; one without a location does not.
        let mut bare = open;
        bare["links"][0]["evidence"]["passage"] = json!("p-bare");
        assert!(codes(&review(&f, bare))
            .contains(&"claim-locator-missing potential links[l1].evidence.locators".into()));
        // A reviewed suggestion is the author's reading: no suggestion prompt.
        let reviewed = json!({"version": 1,
            "claims": [{"id": "c1", "post": "cave", "statement": "S"}],
            "links": [{"id": "l1", "claim": "c1", "relation": "supports", "origin": "suggested",
                "reviewState": "reviewed", "rationale": "R",
                "evidence": {"source": "slings", "locators": [{"kind": "page", "value": "1"}]}}]});
        assert!(review(&f, reviewed).is_empty());
    }

    #[test]
    fn a_post_view_keeps_the_review_order() {
        let mut f = fixture("A.");
        f.drafts.insert("other".into(), "B.".into());
        f.paths.insert("other".into(), "posts/other.md".into());
        let value = json!({"version": 1, "claims": [
            {"id": "a", "post": "cave", "statement": "S"},
            {"id": "b", "post": "other", "statement": "S"},
            {"id": "c", "post": "cave", "statement": "S", "origin": "suggested"}]});
        let set = ClaimSet::parse(
            &value.to_string(),
            Links {
                library: &f.library,
                notebook: &f.notebook,
            },
        )
        .unwrap();
        let findings = review(&f, value);
        let ids: Vec<_> = findings_for_post(&findings, &set, "cave")
            .map(|f| {
                (
                    f.object.as_ref().unwrap().claim.as_str(),
                    f.code.to_string(),
                )
            })
            .collect();
        assert_eq!(
            ids,
            [
                ("a", "claim-evidence-missing".to_string()),
                ("c", "claim-suggestion-unreviewed".to_string()),
                ("c", "claim-evidence-missing".to_string()),
            ]
        );
    }
}
