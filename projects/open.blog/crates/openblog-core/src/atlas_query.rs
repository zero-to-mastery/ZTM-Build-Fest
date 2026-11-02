//! The public Knowledge Atlas query projection (ADR 0168).
//!
//! [`AtlasQuery`] is a bounded, deterministic reading of the one public atlas
//! ([`PublicAtlas`], ADR 0058) shaped for components and search: entry
//! previews, per-entry edge lists, a term lookup and a bounded trail walk.
//! It is derived from that value and from nothing else: it takes no private
//! atlas, notebook or library, so a query can only ever reach an entry or
//! relationship the atlas already publishes, and an id outside the projection
//! answers nothing. Its fields are an allowlist; adding a published field to
//! the atlas publishes nothing here until it is added here.
//!
//! Relationships keep their stored direction (`from` `kind` `to`; the reverse
//! reading is only `inverseLabel`), their asserting party, confidence,
//! standing, uncertainty and the sources they cite. Nothing here says a
//! relationship is true, agreed or authoritative, and nothing infers a
//! relationship the atlas does not publish.
//!
//! Everything is bounded (see the `MAX_` constants) and a projection over a
//! bound is refused as a whole, naming the limit and never an item's text, so
//! the pages and `atlas.json` stay the complete canonical fallback.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use serde::Serialize;

use crate::atlas_publication::{
    confidence_text, entry_url, escaped_json, kind_label, standing_text, PublicAtlas,
    PublicEvidence, PublicParty, ATLAS_URL,
};
use crate::knowledge_atlas::{valid_id, Confidence, EntryKind, RelationshipKind, Standing};

/// Names the artifact. Distinct from `atlas.json`'s format so one is never
/// read as the other.
pub const ATLAS_QUERY_FORMAT: &str = "openblog-atlas-query";
/// The only query format version this release writes.
pub const ATLAS_QUERY_FORMAT_VERSION: u64 = 1;
/// The artifact, relative to the site root.
pub const ATLAS_QUERY_JSON_FILE: &str = "atlas-query.json";

/// Most entries a query projection holds.
pub const MAX_ENTRIES: usize = 2_000;
/// Most relationships (edges) a query projection holds.
pub const MAX_EDGES: usize = 10_000;
/// Longest preview or uncertainty text, in characters, before it is clipped.
pub const MAX_TEXT_CHARS: usize = 240;
/// Most edge ids listed on one entry per direction; the rest are counted and
/// the entry's page lists them all.
pub const MAX_LISTED_EDGES: usize = 50;
/// Longest lookup term, in characters; longer labels are not indexed.
pub const MAX_TERM_CHARS: usize = 80;
/// Largest serialized artifact, in bytes.
pub const MAX_BYTES: usize = 4 * 1024 * 1024;
/// Deepest trail a query walks, in steps from its start.
pub const MAX_TRAIL_DEPTH: usize = 3;
/// Most steps one trail returns.
pub const MAX_TRAIL_STEPS: usize = 50;

/// Why a projection is not written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefusalKind {
    /// Over a count or size bound.
    OverLimit,
    /// The published atlas does not agree with itself (an id that is not a
    /// slug, an entry twice, a relationship that joins or cites something it
    /// does not publish).
    Inconsistent,
}

/// A refused projection: which kind, and a message naming limits and ids
/// only, never an item's text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryRefusal {
    pub kind: RefusalKind,
    pub message: String,
}

impl std::fmt::Display for QueryRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// The bounds a reader of the artifact can rely on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryLimits {
    pub max_text_chars: usize,
    pub max_listed_edges: usize,
    pub max_trail_depth: usize,
    pub max_trail_steps: usize,
}

const LIMITS: QueryLimits = QueryLimits {
    max_text_chars: MAX_TEXT_CHARS,
    max_listed_edges: MAX_LISTED_EDGES,
    max_trail_depth: MAX_TRAIL_DEPTH,
    max_trail_steps: MAX_TRAIL_STEPS,
};

/// The query projection of the published atlas.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasQuery {
    pub format: &'static str,
    pub format_version: u64,
    pub limits: QueryLimits,
    /// Sorted by id.
    pub entries: Vec<QueryEntry>,
    /// Sorted by id; each joins two entries above.
    pub edges: Vec<QueryEdge>,
    /// Sorted by id; each one an edge above cites or is attributed to, as
    /// the public text readers see it.
    pub sources: Vec<QuerySource>,
    /// Sorted by term. A term two entries share lists both: it is never
    /// resolved to one.
    pub terms: Vec<QueryTerm>,
}

/// One published entry as a query shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryEntry {
    pub id: String,
    pub kind: EntryKind,
    /// The kind as a word in running text ("Person"), so a component never
    /// restates the page's wording.
    pub kind_label: &'static str,
    pub label: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    /// Only on a work: the id of the source it stands for, one of `sources`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// The first paragraph of the published summary, clipped to
    /// [`MAX_TEXT_CHARS`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// Whether the preview is less than the whole published summary; the
    /// entry's page always has all of it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub preview_clipped: bool,
    /// The complete static entry page, root-relative.
    pub url: String,
    /// Ids of relationships that start here, at most [`MAX_LISTED_EDGES`].
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub out: Vec<String>,
    /// Ids of relationships that end here, at most [`MAX_LISTED_EDGES`].
    #[serde(rename = "in", skip_serializing_if = "Vec::is_empty")]
    pub incoming: Vec<String>,
    /// How many starting relationships are not listed in `out`.
    #[serde(skip_serializing_if = "is_zero")]
    pub more_out: usize,
    /// How many ending relationships are not listed in `in`.
    #[serde(skip_serializing_if = "is_zero")]
    pub more_in: usize,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// One published relationship as a query shows it, in its stored direction.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryEdge {
    pub id: String,
    pub kind: RelationshipKind,
    pub from: String,
    pub to: String,
    pub label: &'static str,
    pub inverse_label: &'static str,
    pub asserted_by: PublicParty,
    /// Who holds the position, as the page words it: the site author's name,
    /// a source's title or the named party.
    pub asserted_by_text: String,
    pub confidence: Confidence,
    /// How firmly the asserting party holds it ("Plausible"), never how
    /// widely it is accepted.
    pub confidence_text: &'static str,
    /// `asserted`, or `contested` when any dissent is published. Never
    /// consensus.
    pub standing: Standing,
    /// The standing as the page words it, including that nothing recorded is
    /// not a claim of agreement.
    pub standing_text: String,
    /// How many dissents the page lists; their text is on the page.
    #[serde(skip_serializing_if = "is_zero")]
    pub dissents: usize,
    /// Never empty: an unsourced relationship is never projected.
    pub evidence: Vec<QueryEvidence>,
    /// The author's stated doubt, clipped to [`MAX_TEXT_CHARS`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncertainty: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub uncertainty_clipped: bool,
    /// Where the relationship is shown in full: its anchor on the page of the
    /// entry it starts from.
    pub url: String,
}

/// One cited source and where in it, with the reference as the page words it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct QueryEvidence {
    #[serde(flatten)]
    pub evidence: PublicEvidence,
    /// The reference, then where ("Politeia, p. 514-520").
    pub text: String,
}

/// A source's public plain text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct QuerySource {
    pub id: String,
    pub text: String,
}

/// A lookup term and the entries whose label or alias it normalizes from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct QueryTerm {
    pub term: String,
    pub entries: Vec<String>,
}

/// Which way along its stored direction a trail step crossed a relationship.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    /// From the relationship's `from` to its `to`.
    Forward,
    /// From its `to` back to its `from`.
    Backward,
}

/// One relationship crossed while walking out from an entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrailStep<'a> {
    /// 1 for a relationship touching the start.
    pub depth: usize,
    pub edge: &'a QueryEdge,
    pub direction: Direction,
    /// The entry the step arrives at.
    pub reached: &'a str,
}

/// A bounded walk over published relationships.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Trail<'a> {
    pub steps: Vec<TrailStep<'a>>,
    /// Whether more steps existed than [`MAX_TRAIL_STEPS`] allows.
    pub truncated: bool,
}

impl AtlasQuery {
    /// Derive the query projection from the published atlas. `author` is the
    /// site author's public name, which words an author-asserted position
    /// exactly as the atlas pages do. Refuses, naming the limit or ids only,
    /// when the atlas is over a bound ([`RefusalKind::OverLimit`]) or is not
    /// internally consistent ([`RefusalKind::Inconsistent`]). `base_path` is
    /// the site's base path (`""` or `"/blog"`), which the build puts in front
    /// of every root-relative address, so the size bound is checked as
    /// published.
    pub fn project(
        atlas: &PublicAtlas,
        author: &str,
        base_path: &str,
    ) -> Result<Self, QueryRefusal> {
        let over = |message: String| QueryRefusal {
            kind: RefusalKind::OverLimit,
            message,
        };
        let inconsistent = |message: String| QueryRefusal {
            kind: RefusalKind::Inconsistent,
            message,
        };
        if atlas.entries.len() > MAX_ENTRIES {
            return Err(over(format!(
                "the published atlas has {} entries, over the query limit of {MAX_ENTRIES}",
                atlas.entries.len()
            )));
        }
        if atlas.relationships.len() > MAX_EDGES {
            return Err(over(format!(
                "the published atlas has {} relationships, over the query limit of {MAX_EDGES}",
                atlas.relationships.len()
            )));
        }
        let mut entries: Vec<QueryEntry> = Vec::with_capacity(atlas.entries.len());
        for entry in &atlas.entries {
            if !valid_id(&entry.id) {
                return Err(inconsistent(
                    "a published atlas entry has an id that is not a slug".to_string(),
                ));
            }
            let url = entry_url(&entry.id);
            if entry.url != url || !safe_atlas_url(&url) {
                return Err(inconsistent(format!(
                    "the published atlas entry `{}` has a page address outside {ATLAS_URL}",
                    entry.id
                )));
            }
            let (preview, preview_clipped) = match entry.summary.as_deref() {
                Some(summary) => {
                    let summary = summary.trim();
                    let first = summary.split("\n\n").next().unwrap_or_default();
                    let (text, clipped) = clip(first);
                    let more = summary.len() > first.trim().len();
                    ((!text.is_empty()).then_some(text), clipped || more)
                }
                None => (None, false),
            };
            entries.push(QueryEntry {
                id: entry.id.clone(),
                kind: entry.kind,
                kind_label: kind_label(entry.kind),
                label: entry.label.clone(),
                aliases: entry.aliases.clone(),
                source: entry.source.clone(),
                preview,
                preview_clipped,
                url,
                out: Vec::new(),
                incoming: Vec::new(),
                more_out: 0,
                more_in: 0,
            });
        }
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        if let Some(pair) = entries.windows(2).find(|pair| pair[0].id == pair[1].id) {
            return Err(inconsistent(format!(
                "the published atlas lists the entry `{}` twice",
                pair[0].id
            )));
        }
        let index: HashMap<String, usize> = entries
            .iter()
            .enumerate()
            .map(|(at, entry)| (entry.id.clone(), at))
            .collect();

        let mut edges: Vec<QueryEdge> = Vec::with_capacity(atlas.relationships.len());
        let mut cited: BTreeSet<&str> = BTreeSet::new();
        // A work's own provenance is cited too, so its text is in `sources`.
        for entry in &atlas.entries {
            if let Some(source) = entry.source.as_deref() {
                cited.insert(source);
            }
        }
        for r in &atlas.relationships {
            if !valid_id(&r.id) {
                return Err(inconsistent(
                    "a published atlas relationship has an id that is not a slug".into(),
                ));
            }
            if !index.contains_key(&r.from) || !index.contains_key(&r.to) {
                return Err(inconsistent(format!(
                    "the published atlas relationship `{}` joins an entry that is not published",
                    r.id
                )));
            }
            if r.evidence.is_empty() {
                return Err(inconsistent(format!(
                    "the published atlas relationship `{}` cites no source",
                    r.id
                )));
            }
            let url = format!("{}#atlas-r-{}", entry_url(&r.from), r.id);
            if !safe_atlas_url(&url) {
                return Err(inconsistent(format!(
                    "the published atlas relationship `{}` has an unsafe page address",
                    r.id
                )));
            }
            let (uncertainty, uncertainty_clipped) = match r.uncertainty.as_deref() {
                Some(text) => {
                    let (text, clipped) = clip(text);
                    ((!text.is_empty()).then_some(text), clipped)
                }
                None => (None, false),
            };
            for evidence in &r.evidence {
                cited.insert(evidence.source.as_str());
            }
            if let Some(source) = r.asserted_by.source.as_deref() {
                cited.insert(source);
            }
            edges.push(QueryEdge {
                id: r.id.clone(),
                kind: r.kind,
                from: r.from.clone(),
                to: r.to.clone(),
                label: r.label,
                inverse_label: r.inverse_label,
                asserted_by: r.asserted_by.clone(),
                asserted_by_text: atlas.party_text(&r.asserted_by, author),
                confidence: r.confidence,
                confidence_text: confidence_text(r.confidence),
                standing: r.standing,
                standing_text: standing_text(r.standing, r.contested_by.len()),
                dissents: r.contested_by.len(),
                evidence: r
                    .evidence
                    .iter()
                    .map(|evidence| QueryEvidence {
                        evidence: evidence.clone(),
                        text: atlas.evidence_text(evidence),
                    })
                    .collect(),
                uncertainty,
                uncertainty_clipped,
                url,
            });
        }
        edges.sort_by(|a, b| a.id.cmp(&b.id));
        if let Some(pair) = edges.windows(2).find(|pair| pair[0].id == pair[1].id) {
            return Err(inconsistent(format!(
                "the published atlas lists the relationship `{}` twice",
                pair[0].id
            )));
        }

        // Each edge id goes on the entry it starts at and the entry it ends
        // at, in id order, up to the listing bound.
        for edge in &edges {
            let from = &mut entries[index[&edge.from]];
            if from.out.len() < MAX_LISTED_EDGES {
                from.out.push(edge.id.clone());
            } else {
                from.more_out += 1;
            }
            let to = &mut entries[index[&edge.to]];
            if to.incoming.len() < MAX_LISTED_EDGES {
                to.incoming.push(edge.id.clone());
            } else {
                to.more_in += 1;
            }
        }

        let mut sources = Vec::with_capacity(cited.len());
        for id in cited {
            let Some(source) = atlas.source(id) else {
                return Err(inconsistent(format!(
                    "a published atlas relationship cites the source `{id}`, which the atlas does not publish"
                )));
            };
            sources.push(QuerySource {
                id: id.to_string(),
                text: source.text.clone(),
            });
        }

        let mut by_term: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for entry in &entries {
            for text in std::iter::once(&entry.label).chain(&entry.aliases) {
                let term = normalize_term(text);
                if !term.is_empty() && term.chars().count() <= MAX_TERM_CHARS {
                    by_term.entry(term).or_default().insert(entry.id.clone());
                }
            }
        }
        let terms = by_term
            .into_iter()
            .map(|(term, ids)| QueryTerm {
                term,
                entries: ids.into_iter().collect(),
            })
            .collect();

        let query = Self {
            format: ATLAS_QUERY_FORMAT,
            format_version: ATLAS_QUERY_FORMAT_VERSION,
            limits: LIMITS,
            entries,
            edges,
            sources,
            terms,
        };
        // Every entry and edge carries one root-relative address, which the
        // build writes after the base path.
        let size =
            query.to_json().len() + (query.entries.len() + query.edges.len()) * base_path.len();
        if size > MAX_BYTES {
            return Err(over(format!(
                "the atlas query projection is {size} bytes as published, over the limit of {MAX_BYTES}"
            )));
        }
        Ok(query)
    }

    pub fn entry(&self, id: &str) -> Option<&QueryEntry> {
        self.entries
            .binary_search_by(|entry| entry.id.as_str().cmp(id))
            .ok()
            .map(|at| &self.entries[at])
    }

    pub fn edge(&self, id: &str) -> Option<&QueryEdge> {
        self.edges
            .binary_search_by(|edge| edge.id.as_str().cmp(id))
            .ok()
            .map(|at| &self.edges[at])
    }

    pub fn source(&self, id: &str) -> Option<&QuerySource> {
        self.sources
            .binary_search_by(|source| source.id.as_str().cmp(id))
            .ok()
            .map(|at| &self.sources[at])
    }

    /// Every entry whose label or alias is this text once whitespace and case
    /// are normalized, by id. Two entries sharing a term are both returned;
    /// nothing chooses between them.
    pub fn lookup(&self, text: &str) -> Vec<&QueryEntry> {
        let term = normalize_term(text);
        self.terms
            .binary_search_by(|t| t.term.as_str().cmp(term.as_str()))
            .ok()
            .map(|at| {
                self.terms[at]
                    .entries
                    .iter()
                    .filter_map(|id| self.entry(id))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The relationships that start at an entry, then those that end at it,
    /// in id order, in full (not limited to the listed ids). An id the
    /// projection does not hold has none.
    pub fn edges_of(&self, id: &str) -> (Vec<&QueryEdge>, Vec<&QueryEdge>) {
        if self.entry(id).is_none() {
            return (Vec::new(), Vec::new());
        }
        (
            self.edges.iter().filter(|e| e.from == id).collect(),
            self.edges.iter().filter(|e| e.to == id).collect(),
        )
    }

    /// Walk the published relationships outward from an entry, breadth first
    /// and across either direction, to at most `depth` steps (capped at
    /// [`MAX_TRAIL_DEPTH`]). Each relationship is crossed once, so a cycle
    /// ends the walk instead of trapping it, and an entry is expanded once.
    /// Steps come in a fixed order: by depth, then in the order entries were
    /// reached, outgoing before incoming, each by id. An unknown start gives
    /// an empty trail, and nothing outside the projection is reachable.
    pub fn trail(&self, start: &str, depth: usize) -> Trail<'_> {
        let mut trail = Trail::default();
        let Some(start) = self.entry(start) else {
            return trail;
        };
        let depth = depth.min(MAX_TRAIL_DEPTH);
        let mut outgoing: HashMap<&str, Vec<&QueryEdge>> = HashMap::new();
        let mut incoming: HashMap<&str, Vec<&QueryEdge>> = HashMap::new();
        for edge in &self.edges {
            outgoing.entry(edge.from.as_str()).or_default().push(edge);
            incoming.entry(edge.to.as_str()).or_default().push(edge);
        }
        let mut seen_edges: BTreeSet<&str> = BTreeSet::new();
        let mut expanded: BTreeSet<&str> = BTreeSet::new();
        let mut queue: VecDeque<(&str, usize)> = VecDeque::new();
        queue.push_back((start.id.as_str(), 0));
        expanded.insert(start.id.as_str());
        while let Some((at, reached_at)) = queue.pop_front() {
            if reached_at >= depth {
                continue;
            }
            let forward = outgoing
                .get(at)
                .into_iter()
                .flatten()
                .map(|e| (*e, Direction::Forward, e.to.as_str()));
            let backward = incoming
                .get(at)
                .into_iter()
                .flatten()
                .map(|e| (*e, Direction::Backward, e.from.as_str()));
            for (edge, direction, reached) in forward.chain(backward) {
                if !seen_edges.insert(edge.id.as_str()) {
                    continue;
                }
                if trail.steps.len() >= MAX_TRAIL_STEPS {
                    trail.truncated = true;
                    return trail;
                }
                trail.steps.push(TrailStep {
                    depth: reached_at + 1,
                    edge,
                    direction,
                    reached,
                });
                if expanded.insert(reached) {
                    queue.push_back((reached, reached_at + 1));
                }
            }
        }
        trail
    }

    /// The artifact as compact, deterministic JSON with root-relative URLs,
    /// `<`, `>` and `&` written as escapes.
    pub fn to_json(&self) -> String {
        escaped_json(self)
    }
}

/// A term as the lookup compares it (ADR 0171): the text split on Unicode
/// `White_Space` (what `char::is_whitespace` tests: U+0009 to U+000D, U+0020,
/// U+0085, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F
/// and U+3000), the words joined with one space, then `str::to_lowercase`
/// (the default Unicode case conversion with the final-sigma rule, and no
/// locale). Nothing else: no normalization form, so a composed and a
/// decomposed spelling are different terms; no case folding, so `ß` stays
/// `ß`; U+FEFF and U+200B are not white space. No stemming, translation or
/// fuzzy matching. `web/components/atlas-terms.js` is the same algorithm and
/// both are tested against `tests/fixtures/atlas-lookup.json`.
pub fn normalize_term(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Whitespace collapsed and cut to [`MAX_TEXT_CHARS`] characters on a
/// character boundary, with an ellipsis when cut. Returns whether it was cut.
///
/// The cut never leaves a combining mark or variation selector at the start
/// of what was dropped, or a zero width joiner at the end of what is kept: the
/// base character such a mark or joiner belongs to goes with it, so the
/// ellipsis never follows half a cluster. Only the common extenders are
/// recognised (see [`is_extender`]); a script whose marks fall outside those
/// ranges can still be cut between a base and a mark.
fn clip(text: &str) -> (String, bool) {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX_TEXT_CHARS {
        return (flat, false);
    }
    let chars: Vec<char> = flat.chars().collect();
    let mut keep = MAX_TEXT_CHARS - 1;
    while keep > 0 && (is_extender(chars[keep]) || chars[keep - 1] == '\u{200D}') {
        keep -= 1;
    }
    let cut: String = chars[..keep].iter().collect();
    (format!("{}\u{2026}", cut.trim_end()), true)
}

/// A character that continues the one before it: combining marks, variation
/// selectors, emoji skin tone modifiers and the zero width joiner and
/// non-joiner.
fn is_extender(c: char) -> bool {
    matches!(c,
        '\u{0300}'..='\u{036F}'
        | '\u{0483}'..='\u{0489}'
        | '\u{0591}'..='\u{05BD}'
        | '\u{064B}'..='\u{065F}'
        | '\u{1AB0}'..='\u{1AFF}'
        | '\u{1DC0}'..='\u{1DFF}'
        | '\u{200C}'..='\u{200D}'
        | '\u{20D0}'..='\u{20FF}'
        | '\u{FE00}'..='\u{FE0F}'
        | '\u{FE20}'..='\u{FE2F}'
        | '\u{E0100}'..='\u{E01EF}'
        | '\u{1F3FB}'..='\u{1F3FF}')
}

/// A root-relative address under the atlas section: no scheme, authority,
/// traversal, backslash, control character or query.
fn safe_atlas_url(url: &str) -> bool {
    url.starts_with(ATLAS_URL)
        && !url.contains("..")
        && !url.contains('\\')
        && !url.contains('?')
        && !url.contains("//")
        && !url.chars().any(|c| c.is_control() || c == ':' || c == ' ')
        && url.matches('#').count() <= 1
}
