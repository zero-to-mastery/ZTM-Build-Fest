//! The public form of claims and evidence links: the one projection of what
//! the author approved, published with the post it is about (ADR 0075).
//!
//! [`ClaimEvidence::project`] reads a validated claims file and the source
//! library, and nothing else, so no notebook text can reach it. It copies the
//! approved claims and only the links [`ClaimSet::projected_links`] lets
//! through (approved, on an approved claim, no notebook passage, and support
//! only while every contradicting link on the claim is approved too), and from
//! them only the fields named here. Visibility, review state, origin,
//! `recordedBy`, notebook passage ids, unknown fields and every private item
//! have no place in these types.
//!
//! A post's projected claims become one section of its publication Markdown
//! ([`compose`]), so the native page, portable copies, feeds and `llms.txt`
//! all carry the same text. Supporting and contradicting evidence are listed
//! side by side under each claim, counted apart and never netted; a claim with
//! published contradiction says it is contested, and one without says only
//! that no contradiction is published, never that the claim is agreed or true.
//! [`check_section`] re-reads the published Markdown and refuses a post whose
//! section did not come out exactly as composed.
//!
//! Revision notes are public text the author writes in the post's own front
//! matter (`evidenceRevisions`), so they are versioned with the post and never
//! depend on the private claims file: removing it, or withdrawing a claim,
//! never removes a published note.

use std::collections::{BTreeMap, BTreeSet};

use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use serde::Serialize;

use crate::atlas_publication::{confidence_text, PublicSource};
use crate::bibliography::{block_safe, markdown_text, CitationLocale};
use crate::citations::{format_reference, public_reference, PublicLocator};
use crate::claims::{Anchor, AnchorCheck, ClaimSet, Relation};
use crate::knowledge_atlas::{Confidence, Standing, Visibility};
use crate::source_library::SourceLibrary;

/// Names the public artifact. It has no `version` key, so it is never
/// mistaken for the private claims file.
pub const PUBLIC_CLAIM_EVIDENCE_FORMAT: &str = "openblog-claim-evidence-projection";
/// The only public claim evidence format version this release writes.
pub const PUBLIC_CLAIM_EVIDENCE_FORMAT_VERSION: u64 = 1;
/// The JSON artifact, relative to the site root.
pub const CLAIM_EVIDENCE_JSON_FILE: &str = "claim-evidence.json";
/// The front matter list a post's public revision notes are written in.
pub const REVISIONS_FIELD: &str = "evidenceRevisions";
/// At most this many revision notes per post (Admin's limit for a list).
pub const MAX_REVISION_NOTES: usize = 100;
/// At most this many characters per note, date and claim included (Admin's
/// limit for one list item).
pub const MAX_REVISION_NOTE_CHARS: usize = 200;
/// The heading of the published section.
pub const SECTION_HEADING: &str = "Claims and evidence";
const REVISIONS_HEADING: &str = "Revision notes";

/// The projection of a claims file: each post's approved claims with the
/// links that may be published, and the public description of the sources
/// they cite. It is the input of a site load and is never serialized; what is
/// published is the [`PostEvidence`] each post builds from it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClaimEvidence {
    /// By post slug, each post's approved claims in file order.
    posts: BTreeMap<String, Vec<ProjectedClaim>>,
    /// By source id.
    sources: BTreeMap<String, PublicSource>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProjectedClaim {
    id: String,
    statement: String,
    uncertainty: Option<String>,
    /// Offsets and words, used only to find the claim in the post; the words
    /// are published only when they are still there.
    anchor: Option<(usize, usize, String)>,
    /// In file order.
    links: Vec<ProjectedLink>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProjectedLink {
    id: String,
    relation: Relation,
    source: String,
    locators: Vec<PublicLocator>,
    rationale: Option<String>,
    confidence: Confidence,
    uncertainty: Option<String>,
}

/// What one post publishes: its claims in reading order and its revision
/// notes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PostEvidence {
    pub claims: Vec<PublicClaim>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub revisions: Vec<RevisionNote>,
    /// The sources the claims cite, by id, for the site artifact.
    #[serde(skip)]
    pub(crate) sources: Vec<PublicSource>,
    /// The fragment of the "Revision notes" heading on the post's page, known once
    /// [`check_section`] has read the section back: where a published correction links
    /// to the change it made.
    #[serde(skip)]
    pub revisions_fragment: Option<String>,
}

/// One published claim.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicClaim {
    pub id: String,
    /// Its number in the post's section ("Claim 2"), in reading order.
    pub number: usize,
    /// Its heading on the post's page, root-relative with the fragment.
    pub url: String,
    /// The claim in the author's words.
    pub statement: String,
    /// The words of the post the claim is anchored to, only while they are
    /// still exactly where the author anchored it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncertainty: Option<String>,
    /// `contested` when contradicting evidence is published; `asserted`
    /// otherwise, which says only that none is published here.
    pub standing: Standing,
    /// Each relation in file order, always present and never combined.
    pub supports: Vec<PublicEvidenceLink>,
    pub contradicts: Vec<PublicEvidenceLink>,
    pub contextualizes: Vec<PublicEvidenceLink>,
}

/// One published evidence link: the source, where in it, and the author's
/// stated reading. Never a notebook passage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicEvidenceLink {
    pub id: String,
    pub source: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locators: Vec<PublicLocator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    /// How firmly the author holds this reading, not how widely it is shared.
    pub confidence: Confidence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncertainty: Option<String>,
}

/// A public note about how a post's evidence changed, written by the author
/// in the post's front matter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RevisionNote {
    /// `YYYY-MM-DD`.
    pub date: String,
    /// The claim it is about, published only while that claim is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim: Option<String>,
    pub note: String,
}

impl ClaimEvidence {
    /// Project the approved part of a validated claims file. The library
    /// supplies the public description of the sources projected links cite;
    /// the notebook is not an input. Fails, naming ids only, if a projected
    /// link cites a source the library does not hold, or if support would be
    /// published while contradiction on the same claim is not.
    pub fn project(set: &ClaimSet, library: &SourceLibrary) -> Result<Self, String> {
        let mut claims: BTreeMap<&str, ProjectedClaim> = BTreeMap::new();
        let mut order: Vec<(&str, &str)> = Vec::new();
        for claim in &set.claims {
            if claim.visibility != Visibility::Approved {
                continue;
            }
            order.push((claim.post.as_str(), claim.id.as_str()));
            claims.insert(
                claim.id.as_str(),
                ProjectedClaim {
                    id: claim.id.clone(),
                    statement: claim.statement.clone(),
                    uncertainty: claim.uncertainty.clone(),
                    anchor: claim.anchor.as_ref().map(anchor_parts),
                    links: Vec::new(),
                },
            );
        }
        let projected = set.projected_links();
        let published: BTreeSet<&str> = projected.iter().map(|link| link.id.as_str()).collect();
        let mut sources = BTreeMap::new();
        for link in projected {
            // Re-check what the projection rests on rather than trusting it.
            let Some(claim) = claims.get_mut(link.claim.as_str()) else {
                return Err(format!(
                    "the evidence link `{}` is on the claim `{}`, which is not published",
                    link.id, link.claim
                ));
            };
            if link.evidence.passage.is_some() {
                return Err(format!(
                    "the evidence link `{}` carries a notebook passage and cannot be published",
                    link.id
                ));
            }
            if !sources.contains_key(&link.evidence.source) {
                let Some(record) = library.get(&link.evidence.source) else {
                    return Err(format!(
                        "the evidence link `{}` cites the source `{}`, which is not in the source library",
                        link.id, link.evidence.source
                    ));
                };
                let reference = public_reference(record);
                let text = format_reference(&reference);
                sources.insert(
                    link.evidence.source.clone(),
                    PublicSource { reference, text },
                );
            }
            claim.links.push(ProjectedLink {
                id: link.id.clone(),
                relation: link.relation,
                source: link.evidence.source.clone(),
                locators: link
                    .evidence
                    .locators
                    .iter()
                    .map(PublicLocator::from)
                    .collect(),
                rationale: link.rationale.clone(),
                confidence: link.confidence,
                uncertainty: link.uncertainty.clone(),
            });
        }
        // Support is never published while contradiction is withheld.
        for claim in claims.values() {
            let supported = claim.links.iter().any(|l| l.relation == Relation::Supports);
            let withheld = set.links_of(&claim.id).find(|l| {
                l.relation == Relation::Contradicts && !published.contains(l.id.as_str())
            });
            if let (true, Some(link)) = (supported, withheld) {
                return Err(format!(
                    "the claim `{}` would publish support while its contradicting link `{}` stays private",
                    claim.id, link.id
                ));
            }
        }
        let mut posts: BTreeMap<String, Vec<ProjectedClaim>> = BTreeMap::new();
        for (post, id) in order {
            if let Some(claim) = claims.remove(id) {
                posts.entry(post.to_string()).or_default().push(claim);
            }
        }
        Ok(Self { posts, sources })
    }

    /// Whether nothing is published: no approved claim.
    pub fn is_empty(&self) -> bool {
        self.posts.is_empty()
    }

    fn claims_of(&self, post: &str) -> &[ProjectedClaim] {
        self.posts.get(post).map(Vec::as_slice).unwrap_or_default()
    }
}

fn anchor_parts(anchor: &Anchor) -> (usize, usize, String) {
    (anchor.start, anchor.end, anchor.text.clone())
}

/// Read a post's `evidenceRevisions` front matter: each item is
/// `YYYY-MM-DD: note` or `YYYY-MM-DD claim-id: note`. Notes are sorted by
/// date, keeping the written order within a day. Any malformed item refuses
/// them all, naming the item, so a note is never dropped silently.
pub fn revision_notes(items: &[String]) -> Result<Vec<RevisionNote>, String> {
    if items.len() > MAX_REVISION_NOTES {
        return Err(format!(
            "`{REVISIONS_FIELD}` has {} items; keep at most {MAX_REVISION_NOTES}",
            items.len()
        ));
    }
    let mut notes = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let problem = |what: &str| format!("`{REVISIONS_FIELD}` item {}: {what}", index + 1);
        let item = item.trim();
        if item.chars().count() > MAX_REVISION_NOTE_CHARS {
            return Err(problem(&format!(
                "keep a note to {MAX_REVISION_NOTE_CHARS} characters"
            )));
        }
        if item
            .chars()
            .any(|c| c.is_control() || crate::research_notes::bidi_override(c))
        {
            return Err(problem("contains control or direction-override characters"));
        }
        let shape = "write `YYYY-MM-DD: what changed` or `YYYY-MM-DD claim-id: what changed`";
        let Some((head, note)) = item.split_once(':') else {
            return Err(problem(shape));
        };
        let note = note.trim();
        let mut words = head.split_whitespace();
        let (Some(date), claim, None) = (words.next(), words.next(), words.next()) else {
            return Err(problem(shape));
        };
        let dated = date.len() == 10
            && date
                .bytes()
                .enumerate()
                .all(|(at, byte)| matches!(at, 4 | 7) == (byte == b'-'))
            && date.bytes().filter(u8::is_ascii_digit).count() == 8
            && crate::date::DateTime::parse(date).is_some();
        if !dated {
            return Err(problem(&format!("`{date}` is not a date; {shape}")));
        }
        if let Some(claim) = claim {
            let slug = claim
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            if !slug {
                return Err(problem(&format!(
                    "`{claim}` is not a claim id (lowercase letters, digits and hyphens)"
                )));
            }
        }
        if note.is_empty() {
            return Err(problem("say what changed after the colon"));
        }
        notes.push(RevisionNote {
            date: date.to_string(),
            claim: claim.map(str::to_string),
            note: note.to_string(),
        });
    }
    notes.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(notes)
}

/// The section a post publishes, and what it holds, or `None` when the post
/// has neither a published claim nor a revision note, so it is published
/// exactly as before. `draft` is the post's anchor text
/// ([`crate::claims::anchor_text`]): a claim's words are quoted, and the claim
/// is placed in reading order, only while its anchor is verified there.
/// `url` is the post's root-relative address.
pub fn compose(
    evidence: Option<&ClaimEvidence>,
    slug: &str,
    url: &str,
    draft: Option<&str>,
    revisions: Vec<RevisionNote>,
) -> Option<(String, PostEvidence)> {
    let projected = evidence.map_or(&[][..], |evidence| evidence.claims_of(slug));
    if projected.is_empty() && revisions.is_empty() {
        return None;
    }
    // Reading order: claims whose words are still in place, by position, then
    // the rest in file order.
    let mut placed: Vec<(Option<usize>, &ProjectedClaim, Option<String>)> = projected
        .iter()
        .map(|claim| {
            let verified = claim.anchor.as_ref().and_then(|(start, end, text)| {
                let anchor = Anchor {
                    start: *start,
                    end: *end,
                    text: text.clone(),
                    extra: BTreeMap::new(),
                };
                (anchor.check(draft?) == AnchorCheck::Verified).then(|| (*start, text.clone()))
            });
            match verified {
                Some((start, text)) => (Some(start), claim, Some(text)),
                None => (None, claim, None),
            }
        })
        .collect();
    placed.sort_by_key(|(start, _, _)| start.map_or((1, 0), |start| (0, start)));

    let mut used: BTreeSet<&str> = BTreeSet::new();
    let claims: Vec<PublicClaim> = placed
        .into_iter()
        .enumerate()
        .map(|(index, (_, claim, quote))| {
            let group = |relation: Relation| -> Vec<PublicEvidenceLink> {
                claim
                    .links
                    .iter()
                    .filter(|link| link.relation == relation)
                    .map(|link| PublicEvidenceLink {
                        id: link.id.clone(),
                        source: link.source.clone(),
                        locators: link.locators.clone(),
                        rationale: link.rationale.clone(),
                        confidence: link.confidence,
                        uncertainty: link.uncertainty.clone(),
                    })
                    .collect()
            };
            used.extend(claim.links.iter().map(|link| link.source.as_str()));
            let contradicts = group(Relation::Contradicts);
            PublicClaim {
                id: claim.id.clone(),
                number: index + 1,
                url: url.to_string(),
                statement: claim.statement.clone(),
                quote,
                uncertainty: claim.uncertainty.clone(),
                standing: if contradicts.is_empty() {
                    Standing::Asserted
                } else {
                    Standing::Contested
                },
                supports: group(Relation::Supports),
                contradicts,
                contextualizes: group(Relation::Contextualizes),
            }
        })
        .collect();
    let sources: Vec<PublicSource> = evidence
        .map(|evidence| {
            used.iter()
                .filter_map(|id| evidence.sources.get(*id).cloned())
                .collect()
        })
        .unwrap_or_default();
    // A note names its claim only while that claim is published.
    let published: BTreeMap<String, usize> = claims
        .iter()
        .map(|claim| (claim.id.clone(), claim.number))
        .collect();
    let revisions: Vec<RevisionNote> = revisions
        .into_iter()
        .map(|mut note| {
            if note
                .claim
                .as_deref()
                .is_some_and(|id| !published.contains_key(id))
            {
                note.claim = None;
            }
            note
        })
        .collect();
    let post = PostEvidence {
        claims,
        revisions,
        sources,
        revisions_fragment: None,
    };
    Some((section_markdown(&post, &published), post))
}

/// The section as escaped Markdown. Every authored value is inline text
/// that cannot open a block, link, HTML or an entity of its own.
fn section_markdown(post: &PostEvidence, numbers: &BTreeMap<String, usize>) -> String {
    let source_text = |id: &str| -> String {
        post.sources
            .iter()
            .find(|source| source.reference.key == id)
            .map(|source| CitationLocale::En.reference_markdown(&source.reference))
            .unwrap_or_else(|| markdown_text(id))
    };
    let mut out = format!("\n## {SECTION_HEADING}\n\n");
    out.push_str("The author's own reading of the sources for claims this post makes: the evidence that supports each claim, the evidence that contradicts it and any that adds context, listed side by side. It records the author's judgement, not whether a claim is true, and nothing is weighed against anything else.\n");
    if post.claims.is_empty() {
        out.push_str("\nNo claims are published for this post at present.\n");
    }
    for claim in &post.claims {
        out.push_str(&format!("\n### Claim {}\n\n", claim.number));
        out.push_str(&block_safe(&markdown_text(&claim.statement)));
        out.push('\n');
        if let Some(quote) = &claim.quote {
            out.push_str(&format!(
                "\nIn the post: \u{201c}{}\u{201d}\n",
                markdown_text(quote)
            ));
        }
        if let Some(uncertainty) = &claim.uncertainty {
            out.push_str(&format!("\nUncertainty: {}\n", markdown_text(uncertainty)));
        }
        out.push_str(&match claim.standing {
            Standing::Contested => format!(
                "\n**Contested:** {} and {} are published here.\n",
                pieces(claim.contradicts.len(), "contradicting"),
                pieces(claim.supports.len(), "supporting"),
            ),
            Standing::Asserted => "\nNo contradicting evidence is published for this claim. That is not a statement that none exists.\n".to_string(),
        });
        let groups = [
            ("Supporting evidence", &claim.supports, true),
            ("Contradicting evidence", &claim.contradicts, true),
            ("Context", &claim.contextualizes, false),
        ];
        for (heading, links, always) in groups {
            if links.is_empty() && !always {
                continue;
            }
            out.push_str(&format!("\n#### {heading} ({})\n\n", links.len()));
            if links.is_empty() {
                out.push_str("None published.\n");
            }
            for link in links {
                let mut item = source_text(&link.source);
                if !link.locators.is_empty() {
                    item.push_str(", ");
                    item.push_str(&markdown_text(
                        &CitationLocale::En.locators_text(&link.locators),
                    ));
                }
                item.push_str(&format!(
                    ". Confidence: {} (how firmly the author holds this reading).",
                    confidence_text(link.confidence)
                ));
                if let Some(rationale) = &link.rationale {
                    item.push_str(&format!(" Rationale: {}", markdown_text(rationale)));
                    end_sentence(&mut item);
                }
                if let Some(uncertainty) = &link.uncertainty {
                    item.push_str(&format!(" Uncertainty: {}", markdown_text(uncertainty)));
                    end_sentence(&mut item);
                }
                out.push_str(&format!("- {}\n", block_safe(&item)));
            }
        }
    }
    if !post.revisions.is_empty() {
        out.push_str(&format!("\n### {REVISIONS_HEADING}\n\n"));
        for note in &post.revisions {
            let about = note
                .claim
                .as_deref()
                .and_then(|id| numbers.get(id))
                .map(|number| format!(" (Claim {number})"))
                .unwrap_or_default();
            out.push_str(&format!(
                "- {}{about}: {}\n",
                note.date,
                markdown_text(&note.note)
            ));
        }
    }
    out
}

fn end_sentence(text: &mut String) {
    if !text.ends_with(['.', '!', '?']) {
        text.push('.');
    }
}

fn pieces(count: usize, kind: &str) -> String {
    if count == 1 {
        format!("1 piece of {kind} evidence")
    } else {
        format!("{count} pieces of {kind} evidence")
    }
}

/// Confirm the published Markdown carries the section exactly as composed:
/// one heading per claim and per relation, with one list item per published
/// link, and one per revision note, under the last `Claims and evidence`
/// heading. An unclosed code block, HTML block or comment at the end of a post
/// would swallow or reshape the section, so a reader could see support
/// without its contradiction; that post is refused instead. On success each
/// claim's `url` gets the fragment of its heading.
pub fn check_section(
    markdown: &str,
    post: &mut PostEvidence,
    supplements: bool,
) -> Result<(), String> {
    let mut expected: Vec<(u8, String, usize)> = Vec::new();
    for claim in &post.claims {
        expected.push((3, format!("Claim {}", claim.number), 0));
        expected.push((
            4,
            format!("Supporting evidence ({})", claim.supports.len()),
            claim.supports.len(),
        ));
        expected.push((
            4,
            format!("Contradicting evidence ({})", claim.contradicts.len()),
            claim.contradicts.len(),
        ));
        if !claim.contextualizes.is_empty() {
            expected.push((
                4,
                format!("Context ({})", claim.contextualizes.len()),
                claim.contextualizes.len(),
            ));
        }
    }
    if !post.revisions.is_empty() {
        expected.push((3, REVISIONS_HEADING.to_string(), post.revisions.len()));
    }

    // Every heading in document order: (ordinal, level, text, event index).
    let events: Vec<Event<'_>> =
        Parser::new_ext(markdown, crate::markdown::parser_options(false)).collect();
    let mut headings: Vec<(usize, u8, String, usize)> = Vec::new();
    let mut open: Option<(u8, String, usize)> = None;
    for (index, event) in events.iter().enumerate() {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                open = Some((heading_level(*level), String::new(), index));
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, title, _)) = open.as_mut() {
                    title.push_str(text);
                }
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((level, title, start)) = open.take() {
                    headings.push((headings.len(), level, title, start));
                }
            }
            _ => {}
        }
    }
    let refused = || {
        "the claim evidence could not be published as a section of the post; close any code block, HTML block or comment left open at the end of the post".to_string()
    };
    let Some(section) = headings
        .iter()
        .rposition(|(_, level, title, _)| *level == 2 && title == SECTION_HEADING)
    else {
        return Err(refused());
    };
    let start = headings[section].3;
    let end = headings[section + 1..]
        .iter()
        .find(|(_, level, _, _)| *level <= 2)
        .map_or(events.len(), |(_, _, _, at)| *at);
    let inside: Vec<&(usize, u8, String, usize)> = headings[section + 1..]
        .iter()
        .take_while(|(_, _, _, at)| *at < end)
        .collect();
    // Top-level list items after each heading, up to the next one.
    let mut found: Vec<(u8, String, usize)> = Vec::with_capacity(inside.len());
    for (position, (_, level, title, at)) in inside.iter().enumerate() {
        let until = inside.get(position + 1).map_or(end, |next| next.3);
        let mut depth = 0usize;
        let mut items = 0;
        for event in &events[*at..until] {
            match event {
                Event::Start(Tag::List(_)) => depth += 1,
                Event::End(TagEnd::List(_)) => depth = depth.saturating_sub(1),
                Event::Start(Tag::Item) if depth == 1 => items += 1,
                _ => {}
            }
        }
        found.push((*level, title.clone(), items));
    }
    // Nothing of the section may sit before its first heading but prose.
    let lists_before = events[start..inside.first().map_or(end, |first| first.3)]
        .iter()
        .any(|event| matches!(event, Event::Start(Tag::List(_))));
    if found != expected || lists_before {
        return Err(refused());
    }
    let ids = crate::markdown::heading_ids(markdown, supplements);
    for claim in &mut post.claims {
        let title = format!("Claim {}", claim.number);
        let Some(ordinal) = inside
            .iter()
            .find(|(_, level, text, _)| *level == 3 && *text == title)
            .map(|(ordinal, _, _, _)| *ordinal)
        else {
            return Err(refused());
        };
        let Some(id) = ids.get(ordinal) else {
            return Err(refused());
        };
        claim.url = format!("{}#{id}", claim.url.split('#').next().unwrap_or_default());
    }
    post.revisions_fragment = if post.revisions.is_empty() {
        None
    } else {
        let ordinal = inside
            .iter()
            .find(|(_, level, text, _)| *level == 3 && text == REVISIONS_HEADING)
            .map(|(ordinal, _, _, _)| *ordinal)
            .ok_or_else(refused)?;
        Some(ids.get(ordinal).ok_or_else(refused)?.clone())
    };
    Ok(())
}

/// The words a copy of a post must show, in this order, for its claim
/// evidence to be whole: each claim's heading, its contested marker, and each
/// relation's heading with its count, then the revision notes heading.
pub fn required_labels(post: &PostEvidence) -> Vec<String> {
    let mut labels = vec![SECTION_HEADING.to_string()];
    for claim in &post.claims {
        labels.push(format!("Claim {}", claim.number));
        if claim.standing == Standing::Contested {
            labels.push("Contested:".to_string());
        }
        labels.push(format!("Supporting evidence ({})", claim.supports.len()));
        labels.push(format!(
            "Contradicting evidence ({})",
            claim.contradicts.len()
        ));
        if !claim.contextualizes.is_empty() {
            labels.push(format!("Context ({})", claim.contextualizes.len()));
        }
    }
    if !post.revisions.is_empty() {
        labels.push(REVISIONS_HEADING.to_string());
    }
    labels
}

/// Whether a portable copy (HTML, Markdown or text) carries the post's claim
/// evidence whole: every [`required_labels`] word in order, from an occurrence
/// of the "Claims and evidence" heading. Any occurrence may start the match,
/// because the same words can appear later as plain text inside the section
/// (a revision note, a source title, a rationale); only the heading is
/// followed by every label. A copy that lost or reordered part of it is
/// refused by the portable projection rather than published.
pub fn carried_whole(artifact: &str, post: &PostEvidence) -> bool {
    let labels = required_labels(post);
    artifact
        .match_indices(SECTION_HEADING)
        .any(|(start, _)| labels_in_order(&artifact[start..], &labels))
}

fn labels_in_order(mut rest: &str, labels: &[String]) -> bool {
    for label in labels {
        match rest.find(label.as_str()) {
            Some(at) => rest = &rest[at + label.len()..],
            None => return false,
        }
    }
    true
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// The site's published claim evidence as data: every published post's claims
/// and revision notes, and the public description of the sources they cite.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicClaimEvidence<'a> {
    pub format: &'static str,
    pub format_version: u64,
    /// Sorted by slug.
    pub posts: Vec<PublicPostEvidence<'a>>,
    /// Sorted by id.
    pub sources: Vec<&'a PublicSource>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PublicPostEvidence<'a> {
    pub slug: &'a str,
    pub url: &'a str,
    pub title: &'a str,
    #[serde(flatten)]
    pub evidence: &'a PostEvidence,
}

impl<'a> PublicClaimEvidence<'a> {
    /// The artifact for the posts a build publishes.
    pub fn of(posts: &'a [crate::model::Post]) -> Self {
        let mut published: Vec<PublicPostEvidence<'a>> = posts
            .iter()
            .filter_map(|post| {
                post.claim_evidence().map(|evidence| PublicPostEvidence {
                    slug: &post.slug,
                    url: &post.url,
                    title: &post.title,
                    evidence,
                })
            })
            .collect();
        published.sort_by(|a, b| a.slug.cmp(b.slug));
        let mut sources: BTreeMap<&str, &'a PublicSource> = BTreeMap::new();
        for post in &published {
            for source in &post.evidence.sources {
                sources.insert(source.reference.key.as_str(), source);
            }
        }
        Self {
            format: PUBLIC_CLAIM_EVIDENCE_FORMAT,
            format_version: PUBLIC_CLAIM_EVIDENCE_FORMAT_VERSION,
            posts: published,
            sources: sources.into_values().collect(),
        }
    }

    /// Compact, deterministic JSON with root-relative URLs; `<`, `>` and `&`
    /// are written as escapes so the data can be embedded in a page.
    pub fn to_json(&self) -> String {
        let json = serde_json::to_string(self).expect("the claim evidence is serializable");
        let mut out = String::with_capacity(json.len());
        for c in json.chars() {
            match c {
                '<' | '>' | '&' => out.push_str(&format!("\\u{:04x}", u32::from(c))),
                _ => out.push(c),
            }
        }
        out
    }
}

/// What a site load knows about the private claims file when the site
/// publishes claim evidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimEvidenceSource {
    /// The projection of the stored claims file.
    Stored(ClaimEvidence),
    /// No claims file is stored (a CI or static-host build): no claim is
    /// published, revision notes still are, and the load warns.
    Unstored { warning: String },
    /// The claims file, library or notebook cannot be read or validated.
    /// Every full generation refuses, with a message that names the file and
    /// never its text; a load that only reads content is not stopped.
    Unreadable(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_atlas::Links;
    use crate::research_notes::Notebook;
    use serde_json::json;

    const BODY: &str = "The cave educates. Later the sun appears.";

    fn library() -> SourceLibrary {
        SourceLibrary::parse(
            &json!({"version": 1, "sources": [
                {"id": "plato", "kind": "work", "title": "Politeia"},
                {"id": "slings", "kind": "edition", "of": "plato", "title": "Slings *ed*"},
                {"id": "critic", "kind": "work", "title": "A Critic"}]})
            .to_string(),
            &Default::default(),
        )
        .unwrap()
    }

    fn set(value: serde_json::Value) -> ClaimSet {
        let library = library();
        let notebook = Notebook::default();
        ClaimSet::parse(
            &value.to_string(),
            Links {
                library: &library,
                notebook: &notebook,
            },
        )
        .unwrap()
    }

    fn sample() -> ClaimSet {
        set(json!({"version": 1,
            "claims": [
                {"id": "sun", "post": "cave", "statement": "The sun appears.", "visibility": "approved",
                 "anchor": {"start": 25, "end": 41, "text": "the sun appears."}},
                {"id": "cave", "post": "cave", "statement": "# The cave educates.", "uncertainty": "Scope.",
                 "visibility": "approved", "anchor": {"start": 0, "end": 18, "text": "The cave educates."}},
                {"id": "hidden", "post": "cave", "statement": "PRIVATE claim", "visibility": "private"}],
            "links": [
                {"id": "s1", "claim": "cave", "relation": "supports", "visibility": "approved",
                 "evidence": {"source": "slings", "locators": [{"kind": "page", "value": "514", "to": "517"}]},
                 "rationale": "Book *VII*", "confidence": "plausible", "reviewState": "reviewed"},
                {"id": "c1", "claim": "cave", "relation": "contradicts", "visibility": "approved",
                 "evidence": {"source": "critic"}, "uncertainty": "1984. A guess"},
                {"id": "x1", "claim": "cave", "relation": "contextualizes", "visibility": "private",
                 "evidence": {"source": "plato"}, "rationale": "PRIVATE rationale"},
                {"id": "h1", "claim": "hidden", "relation": "supports", "visibility": "approved",
                 "evidence": {"source": "plato"}, "rationale": "PRIVATE endpoint"}]}))
    }

    #[test]
    fn only_approved_items_and_allowlisted_fields_are_projected() {
        let evidence = ClaimEvidence::project(&sample(), &library()).unwrap();
        let (markdown, post) =
            compose(Some(&evidence), "cave", "/posts/cave/", Some(BODY), vec![]).unwrap();
        assert_eq!(
            post.claims
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            ["cave", "sun"],
            "reading order, private claims left out"
        );
        let cave = &post.claims[0];
        assert_eq!(cave.standing, Standing::Contested);
        assert_eq!(
            (
                cave.supports.len(),
                cave.contradicts.len(),
                cave.contextualizes.len()
            ),
            (1, 1, 0)
        );
        assert_eq!(cave.quote.as_deref(), Some("The cave educates."));
        let json = serde_json::to_string(&post).unwrap();
        for private in [
            "PRIVATE",
            "visibility",
            "reviewState",
            "recordedBy",
            "origin",
            "anchor",
            "passage",
        ] {
            assert!(!json.contains(private), "{private} leaked: {json}");
            assert!(!markdown.contains(private), "{private} leaked: {markdown}");
        }
        // Authored text stays inline text: no heading, emphasis or list of its own.
        assert!(markdown.contains("\\# The cave educates."));
        assert!(markdown.contains("Book \\*VII\\*"));
        assert!(markdown.contains("Uncertainty: 1984. A guess."));
        assert!(markdown.contains("#### Supporting evidence (1)\n\n- Slings \\*ed\\*, pp. 514\u{2013}517. Confidence: Plausible"));
        assert!(markdown.contains(
            "**Contested:** 1 piece of contradicting evidence and 1 piece of supporting evidence"
        ));
        assert!(markdown.contains(
            "### Claim 2\n\nThe sun appears.\n\nIn the post: \u{201c}the sun appears.\u{201d}"
        ));
        assert!(markdown.contains("#### Contradicting evidence (0)\n\nNone published."));
        assert!(!markdown.to_lowercase().contains("consensus") && !markdown.contains("verified"));
    }

    #[test]
    fn support_is_withdrawn_with_a_private_contradiction_and_stale_words_are_not_quoted() {
        let mut value = serde_json::to_value(sample()).unwrap();
        value["links"][1]["visibility"] = json!("private");
        let evidence = ClaimEvidence::project(&set(value), &library()).unwrap();
        let (_, post) = compose(
            Some(&evidence),
            "cave",
            "/p/",
            Some("Changed words."),
            vec![],
        )
        .unwrap();
        let cave = post.claims.iter().find(|c| c.id == "cave").unwrap();
        assert!(cave.supports.is_empty() && cave.contradicts.is_empty());
        assert_eq!(cave.standing, Standing::Asserted);
        assert!(
            post.claims.iter().all(|c| c.quote.is_none()),
            "stale anchors are never quoted"
        );
        assert!(
            post.sources.is_empty(),
            "no source of a withheld link is described"
        );
    }

    #[test]
    fn a_post_without_claims_or_notes_is_unchanged() {
        let evidence = ClaimEvidence::project(&sample(), &library()).unwrap();
        assert!(compose(Some(&evidence), "other", "/o/", Some(BODY), vec![]).is_none());
        assert!(compose(None, "cave", "/c/", Some(BODY), vec![]).is_none());
        // Notes alone still publish, without a claim that is not published.
        let notes = revision_notes(&["2026-10-20 hidden: Withdrew a source.".into()]).unwrap();
        let (markdown, post) = compose(None, "cave", "/c/", Some(BODY), notes).unwrap();
        assert!(post.claims.is_empty());
        assert_eq!(post.revisions[0].claim, None);
        assert!(markdown.contains("No claims are published for this post at present."));
        assert!(markdown.contains("- 2026-10-20: Withdrew a source.\n"));
        assert!(!markdown.contains("hidden"));
    }

    #[test]
    fn revision_notes_are_validated_sorted_and_scoped_to_their_item() {
        let notes = revision_notes(&[
            "2026-10-21 cave: Added a contradicting reading.".into(),
            "2026-10-20: First published.".into(),
        ])
        .unwrap();
        assert_eq!(notes[0].date, "2026-10-20");
        assert_eq!(notes[1].claim.as_deref(), Some("cave"));
        for (bad, expect) in [
            ("no date here", "item 1"),
            ("2026-13-40: Bad date.", "not a date"),
            ("2026-10-20 Cave Id: Two words.", "YYYY-MM-DD"),
            ("2026-10-20 Cave: Capital.", "not a claim id"),
            ("2026-10-20:   ", "what changed"),
            ("2026-10-20: \u{202e}flip", "direction-override"),
        ] {
            let error = revision_notes(&[bad.to_string()]).unwrap_err();
            assert!(error.contains(expect), "{bad}: {error}");
        }
        assert!(revision_notes(&["2026-10-20: ".to_string() + &"x".repeat(200)]).is_err());
        assert!(revision_notes(&vec!["2026-10-20: x".to_string(); 101]).is_err());
    }

    #[test]
    fn the_section_is_checked_after_publication_and_names_its_headings() {
        let evidence = ClaimEvidence::project(&sample(), &library()).unwrap();
        let notes = revision_notes(&["2026-10-20 sun: Re-read Book VII.".into()]).unwrap();
        let (section, mut post) =
            compose(Some(&evidence), "cave", "/posts/cave/", Some(BODY), notes).unwrap();
        // An author heading with the same text gets the plain slug first.
        let body = "## Claim 1\n\nIntro.\n";
        let published = format!("{body}{section}");
        check_section(&published, &mut post, false).unwrap();
        assert_eq!(post.claims[0].url, "/posts/cave/#claim-1-2");
        assert_eq!(post.claims[1].url, "/posts/cave/#claim-2");
        assert!(section.contains("- 2026-10-20 (Claim 2): Re-read Book VII."));
        // An unclosed fence swallows the section: refused, never published half.
        let (section, mut post) =
            compose(Some(&evidence), "cave", "/p/", Some(BODY), vec![]).unwrap();
        let swallowed = format!("Text.\n\n```\nunclosed\n{section}");
        assert!(check_section(&swallowed, &mut post, false)
            .unwrap_err()
            .contains("code block"));
        for opener in ["<pre>", "<!-- open"] {
            let unclosed = format!("Text.\n\n{opener}\n{section}");
            assert!(
                check_section(&unclosed, &mut post, false).is_err(),
                "{opener}"
            );
        }
    }

    #[test]
    fn a_copy_missing_or_reordering_evidence_is_not_whole() {
        let evidence = ClaimEvidence::project(&sample(), &library()).unwrap();
        let (section, post) = compose(Some(&evidence), "cave", "/p/", Some(BODY), vec![]).unwrap();
        assert!(carried_whole(&section, &post));
        let without_contradiction = section.replace("Contradicting evidence (1)", "");
        assert!(!carried_whole(&without_contradiction, &post));
        let without_marker = section.replace("**Contested:**", "");
        assert!(!carried_whole(&without_marker, &post));
        let truncated = &section[..section.find("### Claim 2").unwrap()];
        assert!(!carried_whole(truncated, &post));
        assert!(!carried_whole("No section at all.", &post));
        // The heading's words later in the section, as plain text, are not
        // mistaken for the heading.
        let mentioned = format!(
            "{section}
- 2026-10-22: Reworded the Claims and evidence intro.
"
        );
        assert!(carried_whole(&mentioned, &post));
        let mentioned =
            without_contradiction.replace("**Contested:**", "**Contested:** Claims and evidence");
        assert!(!carried_whole(&mentioned, &post));
    }

    #[test]
    fn the_artifact_is_deterministic_and_escaped() {
        let evidence = ClaimEvidence::project(&sample(), &library()).unwrap();
        assert_eq!(
            ClaimEvidence::project(&sample(), &library()).unwrap(),
            evidence,
            "projection is deterministic"
        );
        let (_, post) = compose(Some(&evidence), "cave", "/p/", Some(BODY), vec![]).unwrap();
        let artifact = PublicClaimEvidence {
            format: PUBLIC_CLAIM_EVIDENCE_FORMAT,
            format_version: PUBLIC_CLAIM_EVIDENCE_FORMAT_VERSION,
            posts: vec![PublicPostEvidence {
                slug: "cave",
                url: "/p/",
                title: "</script><b>",
                evidence: &post,
            }],
            sources: post.sources.iter().collect(),
        };
        let json = artifact.to_json();
        assert!(!json.contains('<') && json.contains("\\u003c/script\\u003e"));
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(value.get("version").is_none());
        assert_eq!(
            value["posts"][0]["claims"][0]["contextualizes"],
            json!([]),
            "every relation is present"
        );
        assert_eq!(value["sources"].as_array().unwrap().len(), 2);
    }
}
