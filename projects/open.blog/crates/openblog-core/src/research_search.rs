//! Deterministic search and backlinks over the private research notebook.
//!
//! Everything here is a pure function of a validated [`Notebook`] and the
//! [`SourceLibrary`] it points into: no index is stored, so results can never
//! drift from the files after an edit, an archive, or a hand repair. Results
//! carry bounded plain-text context (never markup) and are meant only for
//! the private Admin workspace. Nothing here renders, publishes, or contacts a
//! service, and a hit says only that words match, never that a passage is
//! accurate or an open question matters.
//!
//! Matching is case-insensitive over Unicode text with runs of whitespace
//! collapsed and the Greek final sigma folded to sigma. It does not fold
//! diacritics or convert between composed and decomposed forms, so a search
//! matches the characters as the author stored them.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::research_notes::{
    LocatorKind, NoteDiagnostic, NoteDiagnosticCode, Notebook, Passage, QuestionState, ResearchNote,
};
use crate::source_library::{valid_source_id, SourceLibrary};

/// Longest search text, in characters.
pub const MAX_QUERY_CHARS: usize = 200;
/// Most words a search may name; every word must match.
pub const MAX_TERMS: usize = 16;
/// Most hits returned; `total` still counts every match.
pub const MAX_HITS: usize = 100;
/// Characters of context shown for a hit or a linked entry.
const SNIPPET_CHARS: usize = 160;
const PREVIEW_CHARS: usize = 80;
/// How far up a chain of `of` links a source filter looks.
const MAX_CHAIN: usize = 8;

/// What to look for. Empty fields do not narrow the search.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchQuery {
    /// Words that must all appear, in any order.
    pub text: String,
    /// A source-library id: matches that source and everything that is an
    /// edition, translation, witness or reference of it.
    pub source: Option<String>,
    /// A locator kind such as `page` or `x-stephanus`.
    pub locator_kind: Option<String>,
    /// A concept slug. Only notes carry concepts, so this selects notes.
    pub concept: Option<String>,
    /// A question state. Only questions have one, so this selects questions.
    pub state: Option<QuestionState>,
    /// Archived entries are left out unless asked for.
    pub include_archived: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryType {
    Passage,
    Note,
}

/// A source as shown beside a hit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceContext {
    pub id: String,
    pub label: String,
    /// Absent when the source no longer exists in the library.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    pub archived: bool,
    pub missing: bool,
}

/// A short view of another entry, for context and backlinks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryLink {
    pub id: String,
    pub entry: EntryType,
    /// `observation` or `question` for notes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<QuestionState>,
    pub preview: String,
    /// The link points at an entry that is not in the notebook.
    pub missing: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub entry: EntryType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<QuestionState>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
    pub score: u32,
    /// Plain text around the first match, or the start of the entry.
    pub snippet: String,
    /// Which fields matched: `excerpt`, `text`, `id`, `concepts`, `source`, `locators`.
    pub matched: Vec<&'static str>,
    /// A passage's own source, or the sources a note names.
    pub sources: Vec<SourceContext>,
    /// A passage's locators written `kind: value`, or `kind: value to value`.
    pub locators: Vec<String>,
    pub concepts: Vec<String>,
    /// For a note, the passages it is about.
    pub passages: Vec<EntryLink>,
    /// For a passage, the notes that link to it (its backlinks).
    pub notes: Vec<EntryLink>,
}

/// A link inside the notebook whose target is missing, so a hand edit or a
/// bug can be seen rather than hidden.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokenLink {
    pub from: String,
    pub entry: EntryType,
    /// `source`, `passages[1]` or `sources[0]`.
    pub field: String,
    pub target: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookCounts {
    pub passages: usize,
    pub notes: usize,
    /// Live questions still waiting for an answer; archived ones are not counted.
    pub open_questions: usize,
    pub resolved_questions: usize,
    /// Entries (passages and notes) the author has set aside.
    pub archived: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub hits: Vec<SearchHit>,
    /// Every match, which may be more than the hits shown.
    pub total: usize,
    pub truncated: bool,
    /// The whole notebook, not just the matches.
    pub counts: NotebookCounts,
    /// Every dangling link in the notebook, whether or not it matched.
    pub broken: Vec<BrokenLink>,
}

/// What a backlink search starts from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BacklinkTarget {
    Source(String),
    Passage(String),
    Concept(String),
}

/// How an entry points at the target.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Relation {
    /// A passage quotes the source.
    Quotes,
    /// A note names the source, passage or concept.
    Notes,
    /// A note links a passage that quotes the source.
    ViaPassage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    #[serde(flatten)]
    pub link: EntryLink,
    pub relation: Relation,
    /// For a source, the edition, translation, witness or reference the
    /// entry actually points at, when that is not the source itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub through: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlinks {
    pub entries: Vec<Backlink>,
    pub broken: Vec<BrokenLink>,
}

fn diagnostic(code: NoteDiagnosticCode, field: &str, message: impl Into<String>) -> NoteDiagnostic {
    NoteDiagnostic {
        code,
        collection: None,
        index: None,
        id: None,
        field: Some(field.into()),
        message: message.into(),
    }
}

/// Lowercase, collapse whitespace runs to one space, trim, and fold the
/// Greek final sigma, so one comparison serves both sides.
fn fold(text: &str) -> String {
    let mut folded = String::with_capacity(text.len());
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            pending_space = !folded.is_empty();
            continue;
        }
        if pending_space {
            folded.push(' ');
            pending_space = false;
        }
        for lower in ch.to_lowercase() {
            folded.push(if lower == 'ς' { 'σ' } else { lower });
        }
    }
    folded
}

fn preview(text: &str, limit: usize) -> String {
    let collapsed: Vec<char> = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .collect();
    if collapsed.len() <= limit {
        return collapsed.into_iter().collect();
    }
    let mut cut: String = collapsed[..limit.saturating_sub(1)].iter().collect();
    cut.push('…');
    cut
}

/// A window of the text around the first matching word, on character
/// boundaries, with whitespace collapsed.
fn snippet(text: &str, terms: &[String]) -> String {
    let collapsed: Vec<char> = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .collect();
    if collapsed.len() <= SNIPPET_CHARS {
        return collapsed.into_iter().collect();
    }
    // Fold each character on its own so positions stay aligned with the original.
    let folded: Vec<char> = collapsed
        .iter()
        .map(|ch| {
            let mut lower = ch.to_lowercase();
            match (lower.next(), lower.next()) {
                (Some('ς'), None) => 'σ',
                (Some(one), None) => one,
                _ => *ch,
            }
        })
        .collect();
    let at = terms.iter().find_map(|term| {
        let needle: Vec<char> = term.chars().collect();
        if needle.is_empty() || needle.len() > folded.len() {
            return None;
        }
        folded
            .windows(needle.len())
            .position(|window| window == needle.as_slice())
    });
    let start = at.map_or(0, |at| at.saturating_sub(SNIPPET_CHARS / 3));
    let end = (start + SNIPPET_CHARS).min(collapsed.len());
    let start = end.saturating_sub(SNIPPET_CHARS).min(start);
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&collapsed[start..end]);
    if end < collapsed.len() {
        out.push('…');
    }
    out
}

fn source_label(library: &SourceLibrary, id: &str) -> String {
    library
        .get(id)
        .and_then(|record| record.title.clone())
        .unwrap_or_else(|| id.to_string())
}

fn source_context(library: &SourceLibrary, id: &str) -> SourceContext {
    match library.get(id) {
        Some(record) => SourceContext {
            id: id.into(),
            label: source_label(library, id),
            kind: Some(record.kind.as_str()),
            archived: record.archived,
            missing: false,
        },
        None => SourceContext {
            id: id.into(),
            label: id.into(),
            kind: None,
            archived: false,
            missing: true,
        },
    }
}

/// The source and each source it is an edition, translation, witness or
/// reference of, nearest first. Bounded, so a hand-made cycle cannot loop.
fn chain<'a>(library: &'a SourceLibrary, id: &'a str) -> Vec<&'a str> {
    let mut found = vec![id];
    let mut current = id;
    for _ in 0..MAX_CHAIN {
        let Some(next) = library.get(current).and_then(|record| record.of.as_deref()) else {
            break;
        };
        if found.contains(&next) {
            break;
        }
        found.push(next);
        current = next;
    }
    found
}

fn locator_text(passage: &Passage) -> Vec<String> {
    passage
        .locators
        .iter()
        .map(|locator| match &locator.to {
            Some(to) => format!("{}: {} to {}", locator.kind.as_str(), locator.value, to),
            None => format!("{}: {}", locator.kind.as_str(), locator.value),
        })
        .collect()
}

fn note_link(note: &ResearchNote) -> EntryLink {
    EntryLink {
        id: note.id.clone(),
        entry: EntryType::Note,
        kind: Some(match note.kind {
            crate::research_notes::NoteKind::Observation => "observation",
            crate::research_notes::NoteKind::Question => "question",
        }),
        state: note.question_state(),
        preview: preview(&note.text, PREVIEW_CHARS),
        missing: false,
        archived: note.archived,
    }
}

fn passage_link(passage: &Passage) -> EntryLink {
    EntryLink {
        id: passage.id.clone(),
        entry: EntryType::Passage,
        kind: None,
        state: None,
        preview: preview(&passage.excerpt.text, PREVIEW_CHARS),
        missing: false,
        archived: passage.archived,
    }
}

fn missing_passage(id: &str) -> EntryLink {
    EntryLink {
        id: id.into(),
        entry: EntryType::Passage,
        kind: None,
        state: None,
        preview: String::new(),
        missing: true,
        archived: false,
    }
}

/// Every link whose target is missing. A notebook read from disk is already
/// validated, so this is empty there; it exists so an in-memory or
/// mid-repair notebook shows its damage instead of failing a search.
pub fn broken_links(notebook: &Notebook, library: &SourceLibrary) -> Vec<BrokenLink> {
    let passage_ids: BTreeSet<&str> = notebook.passages.iter().map(|p| p.id.as_str()).collect();
    let mut broken = Vec::new();
    for passage in &notebook.passages {
        if library.get(&passage.source).is_none() {
            broken.push(BrokenLink {
                from: passage.id.clone(),
                entry: EntryType::Passage,
                field: "source".into(),
                target: passage.source.clone(),
            });
        }
    }
    for note in &notebook.notes {
        for (position, id) in note.passages.iter().enumerate() {
            if !passage_ids.contains(id.as_str()) {
                broken.push(BrokenLink {
                    from: note.id.clone(),
                    entry: EntryType::Note,
                    field: format!("passages[{position}]"),
                    target: id.clone(),
                });
            }
        }
        for (position, id) in note.sources.iter().enumerate() {
            if library.get(id).is_none() {
                broken.push(BrokenLink {
                    from: note.id.clone(),
                    entry: EntryType::Note,
                    field: format!("sources[{position}]"),
                    target: id.clone(),
                });
            }
        }
    }
    broken
}

pub fn counts(notebook: &Notebook) -> NotebookCounts {
    let state = |wanted| {
        notebook
            .notes
            .iter()
            .filter(|note| !note.archived && note.question_state() == Some(wanted))
            .count()
    };
    NotebookCounts {
        passages: notebook.passages.len(),
        notes: notebook.notes.len(),
        open_questions: state(QuestionState::Open),
        resolved_questions: state(QuestionState::Resolved),
        archived: notebook.passages.iter().filter(|p| p.archived).count()
            + notebook.notes.iter().filter(|n| n.archived).count(),
    }
}

struct Filters<'a> {
    library: &'a SourceLibrary,
    source: Option<&'a str>,
    locator_kind: Option<LocatorKind>,
    concept: Option<&'a str>,
    state: Option<QuestionState>,
    include_archived: bool,
}

impl Filters<'_> {
    fn source_matches(&self, id: &str) -> bool {
        self.source
            .is_none_or(|wanted| chain(self.library, id).contains(&wanted))
    }

    fn locator_matches(&self, passage: &Passage) -> bool {
        self.locator_kind.as_ref().is_none_or(|wanted| {
            passage
                .locators
                .iter()
                .any(|locator| &locator.kind == wanted)
        })
    }

    fn passage_matches(&self, passage: &Passage) -> bool {
        (self.include_archived || !passage.archived)
            && self.concept.is_none()
            && self.state.is_none()
            && self.source_matches(&passage.source)
            && self.locator_matches(passage)
    }

    /// A note takes on the source and locators of the passages it is about,
    /// so "page locators on this edition" finds the thoughts written about them.
    fn note_matches(&self, note: &ResearchNote, passages: &BTreeMap<&str, &Passage>) -> bool {
        let linked: Vec<&Passage> = note
            .passages
            .iter()
            .filter_map(|id| passages.get(id.as_str()).copied())
            .collect();
        let source_ok = self.source.is_none()
            || note.sources.iter().any(|id| self.source_matches(id))
            || linked
                .iter()
                .any(|passage| self.source_matches(&passage.source));
        let locator_ok = self.locator_kind.is_none()
            || linked.iter().any(|passage| self.locator_matches(passage));
        let concept_ok = self
            .concept
            .is_none_or(|wanted| note.concepts.iter().any(|c| c == wanted));
        let state_ok = self
            .state
            .is_none_or(|wanted| note.question_state() == Some(wanted));
        (self.include_archived || !note.archived)
            && source_ok
            && locator_ok
            && concept_ok
            && state_ok
    }
}

/// Validate the query and return its folded words, or scoped diagnostics.
fn terms(query: &SearchQuery) -> Result<Vec<String>, Vec<NoteDiagnostic>> {
    if query.text.chars().count() > MAX_QUERY_CHARS {
        return Err(vec![diagnostic(
            NoteDiagnosticCode::TooLarge,
            "q",
            format!("a search is limited to {MAX_QUERY_CHARS} characters"),
        )]);
    }
    if query
        .text
        .chars()
        .any(|ch| ch.is_control() && !ch.is_whitespace())
    {
        return Err(vec![diagnostic(
            NoteDiagnosticCode::InvalidField,
            "q",
            "a search cannot contain control characters",
        )]);
    }
    let words: Vec<String> = fold(&query.text)
        .split(' ')
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    if words.len() > MAX_TERMS {
        return Err(vec![diagnostic(
            NoteDiagnosticCode::TooLarge,
            "q",
            format!("a search may use at most {MAX_TERMS} words"),
        )]);
    }
    Ok(words)
}

/// A field that can hold a match, in the order they are reported.
struct Field {
    name: &'static str,
    weight: u32,
    text: String,
}

fn passage_fields(passage: &Passage, library: &SourceLibrary) -> Vec<Field> {
    let mut locators = locator_text(passage).join("\n");
    if let Some(language) = &passage.excerpt.language {
        locators.push('\n');
        locators.push_str(language);
    }
    vec![
        Field {
            name: "excerpt",
            weight: 3,
            text: fold(&passage.excerpt.text),
        },
        Field {
            name: "id",
            weight: 2,
            text: fold(&passage.id),
        },
        Field {
            name: "source",
            weight: 1,
            text: fold(&format!(
                "{}\n{}",
                passage.source,
                source_label(library, &passage.source)
            )),
        },
        Field {
            name: "locators",
            weight: 1,
            text: fold(&locators),
        },
    ]
}

fn note_fields(note: &ResearchNote, library: &SourceLibrary) -> Vec<Field> {
    let sources: Vec<String> = note
        .sources
        .iter()
        .map(|id| format!("{id}\n{}", source_label(library, id)))
        .collect();
    vec![
        Field {
            name: "text",
            weight: 3,
            text: fold(&note.text),
        },
        Field {
            name: "id",
            weight: 2,
            text: fold(&note.id),
        },
        Field {
            name: "concepts",
            weight: 2,
            text: fold(&note.concepts.join("\n")),
        },
        Field {
            name: "source",
            weight: 1,
            text: fold(&sources.join("\n")),
        },
    ]
}

/// Score a field set against the words: `None` when a word is missing from
/// every field, otherwise the summed best weight and the fields that matched.
fn score(fields: &[Field], words: &[String]) -> Option<(u32, Vec<&'static str>)> {
    let mut total = 0;
    let mut matched: Vec<&'static str> = Vec::new();
    for word in words {
        let mut best = 0;
        for field in fields {
            if field.text.contains(word.as_str()) {
                best = best.max(field.weight);
                if !matched.contains(&field.name) {
                    matched.push(field.name);
                }
            }
        }
        if best == 0 {
            return None;
        }
        total += best;
    }
    // Report fields in a fixed order, whatever order the words found them in.
    matched.sort_by_key(|name| fields.iter().position(|f| f.name == *name));
    Some((total, matched))
}

/// Search the notebook. Results are ordered by score, then by where the entry
/// sits in the notebook (passages before notes), so the same notebook and
/// query always give the same answer. An empty query lists every entry the
/// filters allow.
pub fn search(
    notebook: &Notebook,
    library: &SourceLibrary,
    query: &SearchQuery,
) -> Result<SearchResults, Vec<NoteDiagnostic>> {
    let words = terms(query)?;
    let mut problems = Vec::new();
    if let Some(source) = &query.source {
        if library.get(source).is_none() {
            problems.push(diagnostic(
                NoteDiagnosticCode::UnknownSource,
                "source",
                "no source in the library has that id",
            ));
        }
    }
    let locator_kind = match &query.locator_kind {
        Some(kind) => {
            let parsed = LocatorKind::parse(kind);
            if parsed.is_none() {
                problems.push(diagnostic(
                    NoteDiagnosticCode::UnknownLocatorKind,
                    "locator",
                    "use a locator kind such as page, folio, canonical, or an extension kind such as x-stephanus",
                ));
            }
            parsed
        }
        None => None,
    };
    if let Some(concept) = &query.concept {
        if !valid_source_id(concept) {
            problems.push(diagnostic(
                NoteDiagnosticCode::InvalidId,
                "concept",
                "a concept is lowercase words joined by hyphens, such as allegory",
            ));
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let filters = Filters {
        library,
        source: query.source.as_deref(),
        locator_kind,
        concept: query.concept.as_deref(),
        state: query.state,
        include_archived: query.include_archived,
    };
    let passages: BTreeMap<&str, &Passage> = notebook
        .passages
        .iter()
        .map(|p| (p.id.as_str(), p))
        .collect();

    // Notes that cite each passage, built once so matching stays linear.
    let mut notes_by_passage: BTreeMap<&str, Vec<&ResearchNote>> = BTreeMap::new();
    for note in &notebook.notes {
        for id in &note.passages {
            notes_by_passage.entry(id.as_str()).or_default().push(note);
        }
    }

    // Score everything first, then build a full hit only for the survivors.
    enum Matched<'a> {
        Passage(&'a Passage),
        Note(&'a ResearchNote),
    }
    let mut scored: Vec<(u32, usize, Matched<'_>, Vec<&'static str>)> = Vec::new();
    let mut position = 0;
    for passage in &notebook.passages {
        position += 1;
        if !filters.passage_matches(passage) {
            continue;
        }
        let Some((points, matched)) = score(&passage_fields(passage, library), &words) else {
            continue;
        };
        scored.push((points, position, Matched::Passage(passage), matched));
    }
    for note in &notebook.notes {
        position += 1;
        if !filters.note_matches(note, &passages) {
            continue;
        }
        let Some((points, matched)) = score(&note_fields(note, library), &words) else {
            continue;
        };
        scored.push((points, position, Matched::Note(note), matched));
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let total = scored.len();
    let hits = scored
        .into_iter()
        .take(MAX_HITS)
        .map(|(points, _, entry, matched)| match entry {
            Matched::Passage(passage) => SearchHit {
                id: passage.id.clone(),
                entry: EntryType::Passage,
                kind: None,
                state: None,
                archived: passage.archived,
                score: points,
                snippet: snippet(&passage.excerpt.text, &words),
                matched,
                sources: vec![source_context(library, &passage.source)],
                locators: locator_text(passage),
                concepts: Vec::new(),
                passages: Vec::new(),
                notes: notes_by_passage
                    .get(passage.id.as_str())
                    .map(|notes| notes.iter().map(|note| note_link(note)).collect())
                    .unwrap_or_default(),
            },
            Matched::Note(note) => {
                let link = note_link(note);
                SearchHit {
                    id: note.id.clone(),
                    entry: EntryType::Note,
                    kind: link.kind,
                    state: link.state,
                    archived: note.archived,
                    score: points,
                    snippet: snippet(&note.text, &words),
                    matched,
                    sources: note
                        .sources
                        .iter()
                        .map(|id| source_context(library, id))
                        .collect(),
                    locators: Vec::new(),
                    concepts: note.concepts.clone(),
                    passages: note
                        .passages
                        .iter()
                        .map(|id| {
                            passages
                                .get(id.as_str())
                                .map_or_else(|| missing_passage(id), |p| passage_link(p))
                        })
                        .collect(),
                    notes: Vec::new(),
                }
            }
        })
        .collect();
    Ok(SearchResults {
        truncated: total > MAX_HITS,
        total,
        hits,
        counts: counts(notebook),
        broken: broken_links(notebook, library),
    })
}

/// Everything in the notebook that points at a source, a passage, or a
/// concept, in notebook order. A source's backlinks include entries that
/// point at its editions, translations, witnesses and references, saying
/// which one. An unknown source or passage is an error; a concept nobody
/// uses is simply empty, since there is no concept registry to check it against.
pub fn backlinks(
    notebook: &Notebook,
    library: &SourceLibrary,
    target: &BacklinkTarget,
) -> Result<Backlinks, Vec<NoteDiagnostic>> {
    let passages: BTreeMap<&str, &Passage> = notebook
        .passages
        .iter()
        .map(|p| (p.id.as_str(), p))
        .collect();
    let mut entries = Vec::new();
    match target {
        BacklinkTarget::Source(id) => {
            if library.get(id).is_none() {
                return Err(vec![diagnostic(
                    NoteDiagnosticCode::UnknownSource,
                    "source",
                    "no source in the library has that id",
                )]);
            }
            let through = |source: &str| (source != id).then(|| source.to_string());
            for passage in &notebook.passages {
                if chain(library, &passage.source).contains(&id.as_str()) {
                    entries.push(Backlink {
                        link: passage_link(passage),
                        relation: Relation::Quotes,
                        through: through(&passage.source),
                    });
                }
            }
            for note in &notebook.notes {
                let direct = note
                    .sources
                    .iter()
                    .find(|source| chain(library, source).contains(&id.as_str()));
                if let Some(source) = direct {
                    entries.push(Backlink {
                        link: note_link(note),
                        relation: Relation::Notes,
                        through: through(source),
                    });
                } else if let Some(passage) = note
                    .passages
                    .iter()
                    .filter_map(|p| passages.get(p.as_str()))
                    .find(|passage| chain(library, &passage.source).contains(&id.as_str()))
                {
                    entries.push(Backlink {
                        link: note_link(note),
                        relation: Relation::ViaPassage,
                        through: through(&passage.source),
                    });
                }
            }
        }
        BacklinkTarget::Passage(id) => {
            if !passages.contains_key(id.as_str()) {
                return Err(vec![diagnostic(
                    NoteDiagnosticCode::UnknownEntry,
                    "passage",
                    "no passage has that id",
                )]);
            }
            for note in notebook
                .notes
                .iter()
                .filter(|note| note.passages.contains(id))
            {
                entries.push(Backlink {
                    link: note_link(note),
                    relation: Relation::Notes,
                    through: None,
                });
            }
        }
        BacklinkTarget::Concept(id) => {
            if !valid_source_id(id) {
                return Err(vec![diagnostic(
                    NoteDiagnosticCode::InvalidId,
                    "concept",
                    "a concept is lowercase words joined by hyphens, such as allegory",
                )]);
            }
            for note in notebook
                .notes
                .iter()
                .filter(|note| note.concepts.contains(id))
            {
                entries.push(Backlink {
                    link: note_link(note),
                    relation: Relation::Notes,
                    through: None,
                });
            }
        }
    }
    Ok(Backlinks {
        entries,
        broken: broken_links(notebook, library),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn library() -> SourceLibrary {
        SourceLibrary::parse(&json!({"version": 1, "sources": [
            {"id": "plato", "kind": "work", "title": "Politeia"},
            {"id": "slings", "kind": "edition", "of": "plato", "title": "Slings 2003"},
            {"id": "shorey", "kind": "translation", "of": "plato", "title": "Shorey 1930", "language": "en", "archived": true},
            {"id": "cave-ref", "kind": "reference", "of": "slings"},
            {"id": "ms-a", "kind": "witness", "of": "plato", "title": "Codex A"},
            {"id": "other", "kind": "work", "title": "Timaeus"}]}).to_string(), &Default::default())
        .unwrap()
    }

    fn notebook() -> Notebook {
        Notebook::parse(&json!({"version": 1,
            "passages": [
                {"id": "cave", "source": "slings", "excerpt": {"text": "ὁ δὲ Σωκράτης  <b>ἔλεγε</b>\nτὸ σπήλαιον", "language": "grc"},
                 "locators": [{"kind": "page", "value": "514"}, {"kind": "canonical", "value": "514a", "to": "520a"}]},
                {"id": "sun", "source": "ms-a", "excerpt": {"text": "THE SUN IS THE GOOD"},
                 "locators": [{"kind": "folio", "value": "12r"}, {"kind": "x-stephanus", "value": "508"}]},
                {"id": "timaeus", "source": "other", "excerpt": {"text": "a likely story"}}],
            "notes": [
                {"id": "why-cave", "kind": "question", "text": "Why does the image start underground?", "passages": ["cave"], "sources": ["plato"], "concepts": ["allegory"]},
                {"id": "answered", "kind": "question", "status": "resolved", "text": "Who is the prisoner?", "passages": ["cave"], "concepts": ["allegory", "the-good"]},
                {"id": "obs", "kind": "observation", "text": "The sun image echoes the cave.", "passages": ["sun"], "concepts": ["the-good"]},
                {"id": "loose", "kind": "question", "text": "What is a likely story?", "sources": ["shorey"]}]}).to_string(), &library())
        .unwrap()
    }

    fn ids(results: &SearchResults) -> Vec<&str> {
        results.hits.iter().map(|hit| hit.id.as_str()).collect()
    }

    fn run(query: SearchQuery) -> SearchResults {
        search(&notebook(), &library(), &query).unwrap()
    }

    fn text(words: &str) -> SearchQuery {
        SearchQuery {
            text: words.into(),
            ..SearchQuery::default()
        }
    }

    #[test]
    fn an_empty_query_lists_everything_in_notebook_order() {
        let results = run(SearchQuery::default());
        assert_eq!(
            ids(&results),
            ["cave", "sun", "timaeus", "why-cave", "answered", "obs", "loose"]
        );
        assert_eq!(results.total, 7);
        assert!(!results.truncated);
        assert_eq!(
            results.counts,
            NotebookCounts {
                passages: 3,
                notes: 4,
                open_questions: 2,
                resolved_questions: 1,
                archived: 0
            }
        );
        assert!(results.broken.is_empty());
    }

    #[test]
    fn words_are_case_insensitive_whitespace_tolerant_and_all_required() {
        assert_eq!(ids(&run(text("the sun"))), ["sun", "obs"]);
        assert_eq!(
            ids(&run(text("  SUN\t  good "))),
            ["sun", "obs"],
            "a word may match a concept"
        );
        // Whitespace inside the stored text is collapsed, and markup is ordinary text.
        assert_eq!(ids(&run(text("σωκράτης <b>ἔλεγε</b> τὸ"))), ["cave"]);
        assert!(run(text("sun nonsense")).hits.is_empty());
        // The Greek final sigma matches however the author typed it.
        assert!(
            run(text("σωκρατησ")).hits.is_empty(),
            "diacritics are not folded"
        );
        assert_eq!(ids(&run(text("σωκράτης"))), ["cave"]);
        assert_eq!(ids(&run(text("σωκράτησ"))), ["cave"]);
    }

    #[test]
    fn matches_rank_by_field_then_notebook_order_and_name_what_matched() {
        // A text match (3) outranks an id match (2); equal scores keep notebook order.
        let results = run(text("cave"));
        assert_eq!(ids(&results), ["obs", "cave", "why-cave"]);
        let by = |id: &str| results.hits.iter().find(|h| h.id == id).unwrap();
        assert_eq!(by("cave").matched, ["id"]);
        assert_eq!(by("obs").matched, ["text"]);
        assert!(by("obs").score > by("cave").score);
        let again = run(text("cave"));
        assert_eq!(
            results, again,
            "the same query always gives the same answer"
        );
    }

    #[test]
    fn filters_narrow_by_source_family_locator_kind_concept_and_question_state() {
        let source = |id: &str| SearchQuery {
            source: Some(id.into()),
            ..SearchQuery::default()
        };
        // The work reaches its edition, witness, and the notes written about them.
        assert_eq!(
            ids(&run(source("plato"))),
            ["cave", "sun", "why-cave", "answered", "obs", "loose"]
        );
        assert_eq!(
            ids(&run(source("slings"))),
            ["cave", "why-cave", "answered"]
        );
        assert_eq!(
            ids(&run(source("cave-ref"))),
            Vec::<&str>::new(),
            "a reference does not stand for what it points at"
        );
        assert_eq!(ids(&run(source("ms-a"))), ["sun", "obs"]);

        let locator = |kind: &str| SearchQuery {
            locator_kind: Some(kind.into()),
            ..SearchQuery::default()
        };
        assert_eq!(ids(&run(locator("page"))), ["cave", "why-cave", "answered"]);
        assert_eq!(ids(&run(locator("folio"))), ["sun", "obs"]);
        assert_eq!(ids(&run(locator("x-stephanus"))), ["sun", "obs"]);
        assert_eq!(ids(&run(locator("line"))), Vec::<&str>::new());

        let concept = SearchQuery {
            concept: Some("the-good".into()),
            ..SearchQuery::default()
        };
        assert_eq!(
            ids(&run(concept)),
            ["answered", "obs"],
            "only notes carry concepts"
        );

        let state = |state| SearchQuery {
            state: Some(state),
            ..SearchQuery::default()
        };
        assert_eq!(
            ids(&run(state(QuestionState::Open))),
            ["why-cave", "loose"],
            "a question with no written state is open"
        );
        assert_eq!(ids(&run(state(QuestionState::Resolved))), ["answered"]);

        let combined = SearchQuery {
            text: "prisoner".into(),
            source: Some("plato".into()),
            concept: Some("allegory".into()),
            state: Some(QuestionState::Resolved),
            ..SearchQuery::default()
        };
        assert_eq!(ids(&run(combined)), ["answered"]);
    }

    #[test]
    fn hits_carry_bounded_plain_text_context() {
        let results = run(text("echoes"));
        let hit = &results.hits[0];
        assert_eq!((hit.id.as_str(), hit.entry), ("obs", EntryType::Note));
        assert_eq!(hit.passages.len(), 1);
        assert_eq!(hit.passages[0].id, "sun");
        assert_eq!(hit.passages[0].preview, "THE SUN IS THE GOOD");
        assert_eq!(hit.concepts, ["the-good"]);

        let results = run(text("graveyard"));
        assert!(results.hits.is_empty());

        let cave = &run(SearchQuery {
            text: "prisoner".into(),
            ..SearchQuery::default()
        })
        .hits[0];
        assert_eq!(cave.state, Some(QuestionState::Resolved));
        let passage = run(text("σπήλαιον")).hits.remove(0);
        assert_eq!(passage.locators, ["page: 514", "canonical: 514a to 520a"]);
        assert_eq!(passage.sources[0].label, "Slings 2003");
        assert_eq!(
            passage
                .notes
                .iter()
                .map(|n| n.id.as_str())
                .collect::<Vec<_>>(),
            ["why-cave", "answered"]
        );
        assert_eq!(passage.notes[1].state, Some(QuestionState::Resolved));
    }

    #[test]
    fn long_text_is_cut_around_the_match_on_character_boundaries() {
        let long = format!("{} needle ὁδός {}", "α".repeat(400), "β".repeat(400));
        let cut = snippet(&long, &["needle".to_string()]);
        assert!(cut.contains("needle"));
        assert!(cut.starts_with('…') && cut.ends_with('…'));
        assert!(cut.chars().count() <= SNIPPET_CHARS + 2);
        assert_eq!(snippet("short  text", &[]), "short text");
        let emoji = "🙂".repeat(300);
        assert_eq!(preview(&emoji, 10).chars().count(), 10);
    }

    #[test]
    fn a_bad_query_or_filter_is_refused_with_scoped_diagnostics() {
        let run = |query: SearchQuery| search(&notebook(), &library(), &query).unwrap_err();
        let fields = |found: Vec<NoteDiagnostic>| {
            found
                .into_iter()
                .map(|d| (d.code, d.field.unwrap()))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            fields(run(text(&"x".repeat(MAX_QUERY_CHARS + 1)))),
            [(NoteDiagnosticCode::TooLarge, "q".into())]
        );
        assert_eq!(
            fields(run(text("a\u{0}b"))),
            [(NoteDiagnosticCode::InvalidField, "q".into())]
        );
        assert_eq!(
            fields(run(text(&"w ".repeat(MAX_TERMS + 1)))),
            [(NoteDiagnosticCode::TooLarge, "q".into())]
        );
        let bad = SearchQuery {
            source: Some("ghost".into()),
            locator_kind: Some("pagee".into()),
            concept: Some("Bad Concept".into()),
            ..SearchQuery::default()
        };
        assert_eq!(
            fields(run(bad)),
            [
                (NoteDiagnosticCode::UnknownSource, "source".into()),
                (NoteDiagnosticCode::UnknownLocatorKind, "locator".into()),
                (NoteDiagnosticCode::InvalidId, "concept".into()),
            ]
        );
    }

    #[test]
    fn empty_results_are_a_result_not_an_error() {
        let results = run(text("zzz"));
        assert!(results.hits.is_empty());
        assert_eq!(results.total, 0);
        assert_eq!(results.counts.passages, 3);
        let empty = search(&Notebook::default(), &library(), &SearchQuery::default()).unwrap();
        assert!(empty.hits.is_empty() && empty.broken.is_empty());
    }

    #[test]
    fn results_stop_at_the_limit_but_still_count_every_match() {
        let mut big = Notebook::default();
        for number in 0..(MAX_HITS + 5) {
            big.notes.push(ResearchNote::from_json(json!({"id": format!("n-{number}"), "kind": "observation", "text": "same words"})).unwrap());
        }
        let results = search(&big, &library(), &text("same")).unwrap();
        assert_eq!(results.hits.len(), MAX_HITS);
        assert_eq!(results.total, MAX_HITS + 5);
        assert!(results.truncated);
        assert_eq!(results.hits[0].id, "n-0", "ties keep notebook order");
    }

    fn backlink_ids(target: BacklinkTarget) -> Vec<(String, Relation, Option<String>)> {
        backlinks(&notebook(), &library(), &target)
            .unwrap()
            .entries
            .into_iter()
            .map(|b| (b.link.id, b.relation, b.through))
            .collect()
    }

    #[test]
    fn backlinks_follow_sources_passages_and_concepts() {
        assert_eq!(
            backlink_ids(BacklinkTarget::Passage("cave".into())),
            [
                ("why-cave".into(), Relation::Notes, None),
                ("answered".into(), Relation::Notes, None)
            ]
        );
        assert_eq!(
            backlink_ids(BacklinkTarget::Concept("the-good".into())),
            [
                ("answered".into(), Relation::Notes, None),
                ("obs".into(), Relation::Notes, None)
            ]
        );
        assert!(backlink_ids(BacklinkTarget::Concept("unused".into())).is_empty());
        assert_eq!(
            backlink_ids(BacklinkTarget::Source("plato".into())),
            [
                ("cave".into(), Relation::Quotes, Some("slings".into())),
                ("sun".into(), Relation::Quotes, Some("ms-a".into())),
                ("why-cave".into(), Relation::Notes, None),
                (
                    "answered".into(),
                    Relation::ViaPassage,
                    Some("slings".into())
                ),
                ("obs".into(), Relation::ViaPassage, Some("ms-a".into())),
                ("loose".into(), Relation::Notes, Some("shorey".into())),
            ]
        );
        assert_eq!(
            backlink_ids(BacklinkTarget::Source("slings".into())),
            [
                ("cave".into(), Relation::Quotes, None),
                ("why-cave".into(), Relation::ViaPassage, None),
                ("answered".into(), Relation::ViaPassage, None),
            ]
        );
        assert!(backlinks(
            &notebook(),
            &library(),
            &BacklinkTarget::Source("ghost".into())
        )
        .is_err());
        assert!(backlinks(
            &notebook(),
            &library(),
            &BacklinkTarget::Passage("ghost".into())
        )
        .is_err());
    }

    #[test]
    fn archiving_a_source_changes_labels_not_links() {
        let mut archived = library();
        let mut record = archived.get("slings").unwrap().clone();
        record.archived = true;
        archived.upsert(record, &Default::default()).unwrap();
        let before = backlinks(
            &notebook(),
            &library(),
            &BacklinkTarget::Source("plato".into()),
        )
        .unwrap();
        let after = backlinks(
            &notebook(),
            &archived,
            &BacklinkTarget::Source("plato".into()),
        )
        .unwrap();
        assert_eq!(
            before, after,
            "archived sources still resolve and keep their backlinks"
        );
        let hits = search(&notebook(), &archived, &text("σπήλαιον"))
            .unwrap()
            .hits;
        assert!(hits[0].sources[0].archived);
        let family = search(
            &notebook(),
            &archived,
            &SearchQuery {
                source: Some("slings".into()),
                ..SearchQuery::default()
            },
        )
        .unwrap();
        assert_eq!(
            ids(&family),
            ["cave", "why-cave", "answered"],
            "an archived source can still be filtered on"
        );
    }

    #[test]
    fn safe_edits_move_backlinks_with_them() {
        let mut edited = notebook();
        let mut note = edited.notes[0].clone();
        note.passages = vec!["sun".into()];
        edited.upsert_note(note, &library()).unwrap();
        let on_cave =
            backlinks(&edited, &library(), &BacklinkTarget::Passage("cave".into())).unwrap();
        assert_eq!(
            on_cave
                .entries
                .iter()
                .map(|b| b.link.id.as_str())
                .collect::<Vec<_>>(),
            ["answered"]
        );
        let on_sun =
            backlinks(&edited, &library(), &BacklinkTarget::Passage("sun".into())).unwrap();
        assert_eq!(
            on_sun
                .entries
                .iter()
                .map(|b| b.link.id.as_str())
                .collect::<Vec<_>>(),
            ["why-cave", "obs"]
        );
        edited.remove_note("why-cave", &library()).unwrap();
        let on_sun =
            backlinks(&edited, &library(), &BacklinkTarget::Passage("sun".into())).unwrap();
        assert_eq!(on_sun.entries.len(), 1);
    }

    #[test]
    fn dangling_links_are_listed_rather_than_hidden_or_fatal() {
        let mut damaged = notebook();
        damaged.notes[0].passages.push("gone".into());
        damaged.notes[0].sources.push("ghost".into());
        damaged.passages[2].source = "vanished".into();
        let results = search(&damaged, &library(), &SearchQuery::default()).unwrap();
        let broken: Vec<_> = results
            .broken
            .iter()
            .map(|b| (b.from.as_str(), b.field.as_str(), b.target.as_str()))
            .collect();
        assert_eq!(
            broken,
            [
                ("timaeus", "source", "vanished"),
                ("why-cave", "passages[1]", "gone"),
                ("why-cave", "sources[1]", "ghost")
            ]
        );
        let hit = results.hits.iter().find(|h| h.id == "why-cave").unwrap();
        assert!(hit.passages[1].missing && hit.sources[1].missing);
        let timaeus = results.hits.iter().find(|h| h.id == "timaeus").unwrap();
        assert!(timaeus.sources[0].missing);
    }

    #[test]
    fn question_states_are_validated_and_only_for_questions() {
        let parse = |note: serde_json::Value| ResearchNote::from_json(note);
        let ok = parse(json!({"id": "q", "kind": "question", "text": "?", "status": "resolved"}))
            .unwrap();
        assert_eq!(ok.question_state(), Some(QuestionState::Resolved));
        assert!(serde_json::to_string(&ok)
            .unwrap()
            .contains("\"status\":\"resolved\""));
        let bare = parse(json!({"id": "q", "kind": "question", "text": "?"})).unwrap();
        assert_eq!(bare.question_state(), Some(QuestionState::Open));
        assert!(
            !serde_json::to_string(&bare).unwrap().contains("status"),
            "absent stays absent, so stored files round-trip"
        );
        let obs = parse(json!({"id": "o", "kind": "observation", "text": "."})).unwrap();
        assert_eq!(obs.question_state(), None);
        for bad in [
            json!({"id": "o", "kind": "observation", "text": ".", "status": "open"}),
            json!({"id": "q", "kind": "question", "text": "?", "status": "done"}),
            json!({"id": "q", "kind": "question", "text": "?", "status": 3}),
        ] {
            let found = parse(bad).unwrap_err();
            assert_eq!(found[0].field.as_deref(), Some("status"));
        }
    }

    #[test]
    fn archived_entries_are_kept_out_unless_asked_for_and_never_counted_as_open() {
        let mut book = notebook();
        book.notes[0].archived = true; // why-cave, an open question
        book.passages[2].archived = true; // timaeus
        let hidden = search(&book, &library(), &SearchQuery::default()).unwrap();
        assert_eq!(
            ids(&hidden),
            ["cave", "sun", "answered", "obs", "loose"],
            "archived entries are left out"
        );
        assert_eq!(hidden.counts.archived, 2);
        assert_eq!(
            hidden.counts.open_questions, 1,
            "an archived question is not open"
        );
        let shown = search(
            &book,
            &library(),
            &SearchQuery {
                include_archived: true,
                ..SearchQuery::default()
            },
        )
        .unwrap();
        assert_eq!(shown.total, 7);
        let why = shown.hits.iter().find(|h| h.id == "why-cave").unwrap();
        assert!(why.archived);
        let cave = shown.hits.iter().find(|h| h.id == "cave").unwrap();
        assert!(cave
            .notes
            .iter()
            .any(|link| link.id == "why-cave" && link.archived));
        let value = serde_json::to_value(cave).unwrap();
        assert!(value.get("archived").is_none(), "false is not written");
        assert_eq!(serde_json::to_value(why).unwrap()["archived"], true);
        // Backlinks still list archived entries, flagged.
        let found = backlinks(&book, &library(), &BacklinkTarget::Passage("cave".into())).unwrap();
        assert!(found
            .entries
            .iter()
            .any(|e| e.link.id == "why-cave" && e.link.archived));
    }

    #[test]
    fn the_archived_flag_is_a_boolean_and_round_trips() {
        let archived = ResearchNote::from_json(
            json!({"id": "n", "kind": "observation", "text": ".", "archived": true}),
        )
        .unwrap();
        assert!(archived.archived);
        assert!(serde_json::to_string(&archived)
            .unwrap()
            .contains("\"archived\":true"));
        let plain = ResearchNote::from_json(json!({"id": "n", "kind": "observation", "text": "."}))
            .unwrap();
        assert!(!plain.archived);
        assert!(!serde_json::to_string(&plain).unwrap().contains("archived"));
        let found = Passage::from_json(
            json!({"id": "p", "source": "plato", "excerpt": {"text": "q"}, "archived": "yes"}),
        )
        .unwrap_err();
        assert_eq!(found[0].field.as_deref(), Some("archived"));
    }
}
