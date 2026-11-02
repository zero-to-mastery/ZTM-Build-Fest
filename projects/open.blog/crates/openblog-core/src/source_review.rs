//! Source-scoped identifier, version, quotation-location and
//! citation-consistency diagnostics (ADR 0148): the `source-review`
//! validator of the research-completeness contract (ADR 0146).
//!
//! Four checks, each a structural property of the research record:
//!
//! 1. **Identifier compatibility**: a record with two different values of a
//!    scheme that names one item (`identifier-conflict`), two records with
//!    the same identifier (`identifier-shared`), and an ISBN on a work whose
//!    editions are recorded (`identifier-on-work`).
//! 2. **Version identity**: a page or folio in a version published in
//!    several volumes with no volume, or a volume it does not have
//!    (`volume-missing`, `volume-unknown`); a translation without a
//!    translator (`translator-missing`); a witness without its repository
//!    or shelfmark (`witness-unidentified`); a quotation that cites a work
//!    whose versions are recorded (`version-unspecified`).
//! 3. **Quotation location**: a quotation in a post whose citation gives no
//!    location, or only a chapter or section (`quotation-locator-missing`,
//!    `quotation-location-broad`), and a notebook passage with no location
//!    (`passage-locator-missing`). A location is required of a quotation;
//!    whether the quoted words are there is never checked.
//! 4. **Citation consistency**: a post that cites two records with the same
//!    identifier (`citation-same-identifier`), or several versions of one
//!    work (`citation-versions-mixed`).
//!
//! Every check is offline and deterministic and reads only a post, the
//! source library and the notebook. Nothing is looked up, normalized in
//! place, merged or filled in: identifiers are compared through a
//! comparison key and the records keep exactly what was written, and when
//! two records disagree the finding names one and relates the other. A
//! condition another validator already reports (an unknown key, a page on a
//! work, a malformed identifier, a cited PMID's form, an evidence link
//! without a location) stays with that validator. Findings name ids,
//! schemes, fields, locator kinds and counts only, never a title, excerpt,
//! note or identifier value, and they are author guidance for
//! `openblog check` and builds that never reach a public page.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::ops::Range;

use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use serde::Serialize;

use crate::citations::{format_citation, scan_citations, Citation, CitationMention};
use crate::research::{normalize_doi_url, EvidenceOutcome};
use crate::research_notes::{Locator, LocatorKind, Notebook};
use crate::source_library::{ResearchSourceKind, SourceLibrary, SourceRecord};

/// The extension locator kind that names a volume (ADR 0084).
pub const VOLUME_LOCATOR: &str = "x-csl-volume";

/// Schemes whose values identify one published item, compared across
/// records. ISSN names a serial that many records share, and other schemes
/// are free-form author data, so neither is compared.
const STRONG_SCHEMES: [&str; 4] = ["doi", "isbn", "pmid", "pmcid"];
/// Strong schemes a record carries at most one value of. A book has an
/// ISBN per format, so ISBN is not one of them.
const SINGLE_SCHEMES: [&str; 3] = ["doi", "pmid", "pmcid"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceReviewCode {
    /// One record has two different values of a scheme that names one item.
    IdentifierConflict,
    /// Two records have the same identifier and neither realizes the other.
    IdentifierShared,
    /// A work whose versions are recorded carries an ISBN.
    IdentifierOnWork,
    /// A page or folio in a version in several volumes names no volume.
    VolumeMissing,
    /// A volume number the version does not have.
    VolumeUnknown,
    /// A translation that names no translator and is not anonymous.
    TranslatorMissing,
    /// A witness without a repository or shelfmark.
    WitnessUnidentified,
    /// A quotation that cites a work whose versions are recorded.
    VersionUnspecified,
    /// A quotation whose citation gives no location.
    QuotationLocatorMissing,
    /// A quotation whose citation gives only a chapter or section.
    QuotationLocationBroad,
    /// A notebook passage with no location.
    PassageLocatorMissing,
    /// A post cites two records with the same identifier.
    CitationSameIdentifier,
    /// A post cites several versions of one work.
    CitationVersionsMixed,
}

impl SourceReviewCode {
    pub const ALL: [Self; 13] = [
        Self::IdentifierConflict,
        Self::IdentifierShared,
        Self::IdentifierOnWork,
        Self::VolumeMissing,
        Self::VolumeUnknown,
        Self::TranslatorMissing,
        Self::WitnessUnidentified,
        Self::VersionUnspecified,
        Self::QuotationLocatorMissing,
        Self::QuotationLocationBroad,
        Self::PassageLocatorMissing,
        Self::CitationSameIdentifier,
        Self::CitationVersionsMixed,
    ];

    /// Detected for a deterministic gap, potential where the record may
    /// simply have nothing more to say, needs-review where only a person
    /// can tell what the structure means.
    pub fn outcome(self) -> EvidenceOutcome {
        match self {
            Self::VolumeMissing | Self::VolumeUnknown => EvidenceOutcome::Detected,
            Self::IdentifierConflict
            | Self::TranslatorMissing
            | Self::WitnessUnidentified
            | Self::QuotationLocatorMissing
            | Self::PassageLocatorMissing
            | Self::CitationSameIdentifier => EvidenceOutcome::Potential,
            Self::IdentifierShared
            | Self::IdentifierOnWork
            | Self::VersionUnspecified
            | Self::QuotationLocationBroad
            | Self::CitationVersionsMixed => EvidenceOutcome::NeedsReview,
        }
    }
}

impl fmt::Display for SourceReviewCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = serde_json::to_value(self)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default();
        formatter.write_str(&text)
    }
}

/// The kind of object a source-review finding is scoped to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewObject {
    /// A post, named by its path.
    Post,
    /// A source-library record.
    Source,
    /// A notebook passage.
    Passage,
}

/// One source-review finding. `related` names the other sources it is
/// about: the record sharing an identifier, the versions a post mixes, the
/// source a passage quotes. A detail that does not apply stays absent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReviewFinding {
    pub code: SourceReviewCode,
    pub outcome: EvidenceOutcome,
    pub object: ReviewObject,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Zero-based position of the record or passage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
    /// The post's path relative to the content folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// One-based line in the post's file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<String>,
    pub message: String,
    pub repair: String,
    /// The position-free facts the finding states (ADR 0147): keys,
    /// locators, ids and comparison keys, never a line or sentence. Never
    /// serialized, so no identifier value reaches any output.
    #[serde(skip)]
    pub facts: Vec<String>,
}

impl SourceReviewFinding {
    fn new(code: SourceReviewCode, object: ReviewObject, message: String, repair: String) -> Self {
        Self {
            code,
            outcome: code.outcome(),
            object,
            id: None,
            index: None,
            path: None,
            line: None,
            field: None,
            related: Vec::new(),
            message,
            repair,
            facts: Vec::new(),
        }
    }

    fn record(code: SourceReviewCode, index: usize, id: &str, field: &str) -> Self {
        Self {
            id: Some(id.to_string()),
            index: Some(index),
            field: Some(field.to_string()),
            ..Self::new(code, ReviewObject::Source, String::new(), String::new())
        }
    }

    fn says(mut self, message: String, repair: String) -> Self {
        self.message = message;
        self.repair = repair;
        self
    }

    fn about<I: IntoIterator<Item = String>>(mut self, related: I, facts: Vec<String>) -> Self {
        self.related = related.into_iter().collect();
        self.facts = facts;
        self
    }

    /// Where the finding points, for a terminal line: `path:line`, or the
    /// record or passage and its field.
    pub fn location(&self) -> String {
        match (self.object, &self.path, self.line, &self.id) {
            (ReviewObject::Post, Some(path), Some(line), _) => format!("{path}:{line}"),
            (ReviewObject::Post, Some(path), None, _) => path.clone(),
            (ReviewObject::Source, _, _, Some(id)) => match &self.field {
                Some(field) => format!("source `{id}` ({field})"),
                None => format!("source `{id}`"),
            },
            (ReviewObject::Passage, _, _, Some(id)) => match &self.field {
                Some(field) => format!("passage `{id}` ({field})"),
                None => format!("passage `{id}`"),
            },
            _ => String::new(),
        }
    }
}

impl fmt::Display for SourceReviewFinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}: {} Repair: {} [{}]",
            self.location(),
            self.message,
            self.repair,
            self.code
        )
    }
}

/// Lookups over the library, built once per review.
struct Lookup<'a> {
    library: &'a SourceLibrary,
    records: BTreeMap<&'a str, &'a SourceRecord>,
    /// The versions (editions, translations, witnesses) recorded of each
    /// work, in library order, archived ones left out.
    versions: BTreeMap<&'a str, Vec<&'a str>>,
}

impl<'a> Lookup<'a> {
    fn new(library: &'a SourceLibrary) -> Self {
        let records = library
            .sources
            .iter()
            .map(|record| (record.id.as_str(), record))
            .collect();
        let mut lookup = Self {
            library,
            records,
            versions: BTreeMap::new(),
        };
        for record in &library.sources {
            if record.kind.is_version() && !record.archived {
                if let Some(work) = lookup.work_of(&record.id) {
                    lookup
                        .versions
                        .entry(work)
                        .or_default()
                        .push(record.id.as_str());
                }
            }
        }
        lookup
    }

    fn get(&self, id: &str) -> Option<&'a SourceRecord> {
        self.records.get(id).copied()
    }

    fn chain(&self, id: &str) -> Vec<&'a SourceRecord> {
        self.library.realization_chain(id)
    }

    /// The work a record realizes, following `of`.
    fn work_of(&self, id: &str) -> Option<&'a str> {
        self.chain(id)
            .into_iter()
            .find(|record| record.kind == ResearchSourceKind::Work)
            .map(|record| record.id.as_str())
    }

    /// The version whose text a citation of `id` reads: the first edition,
    /// translation or witness on its realization chain.
    fn version_of(&self, id: &str) -> Option<&'a SourceRecord> {
        self.chain(id)
            .into_iter()
            .find(|record| record.kind.is_version())
    }

    /// Whether either record is on the other's realization chain, as a
    /// reference into a book and the book are.
    fn related_by_chain(&self, a: &str, b: &str) -> bool {
        self.chain(a).iter().any(|record| record.id == b)
            || self.chain(b).iter().any(|record| record.id == a)
    }

    /// Whether two records are parts of one thing for an ISBN: one is on the
    /// other's chain, or both read the same version or share any other
    /// non-reference ancestor, as two chapters of one edition do.
    fn related_for_isbn(&self, a: &str, b: &str) -> bool {
        if self.related_by_chain(a, b) {
            return true;
        }
        let ancestors = |id: &str| -> BTreeSet<&'a str> {
            self.chain(id)
                .into_iter()
                .filter(|record| record.kind != ResearchSourceKind::Reference)
                .map(|record| record.id.as_str())
                .collect()
        };
        !ancestors(a).is_disjoint(&ancestors(b))
    }

    /// The location a reference record on the chain gives itself.
    fn own_location(&self, id: &str) -> Option<&'a crate::source_library::SourceLocation> {
        self.chain(id)
            .into_iter()
            .take_while(|record| record.kind == ResearchSourceKind::Reference)
            .find_map(|record| record.location.as_ref())
    }
}

/// The comparison key of a strong identifier: what two forms of one
/// identifier share. A DOI in any accepted form, case-folded; an ISBN as
/// ISBN-13 digits, so an ISBN-10 and its ISBN-13 meet; a PMID or PMCID as
/// written, the PMCID's prefix upper-cased. The record keeps what was
/// written; this key is only compared.
fn identity(scheme: &str, value: &str) -> Option<String> {
    match scheme {
        "doi" => normalize_doi_url(value).map(|url| url.to_lowercase()),
        "isbn" => {
            let digits: String = value
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .collect::<String>()
                .to_ascii_uppercase();
            match digits.len() {
                13 => Some(digits),
                10 => {
                    let body = format!("978{}", &digits[..9]);
                    let sum: u32 = body
                        .chars()
                        .filter_map(|c| c.to_digit(10))
                        .enumerate()
                        .map(|(at, d)| if at % 2 == 0 { d } else { d * 3 })
                        .sum();
                    Some(format!("{body}{}", (10 - sum % 10) % 10))
                }
                _ => None,
            }
        }
        "pmid" => Some(value.trim().to_string()),
        "pmcid" => Some(value.trim().to_ascii_uppercase()),
        _ => None,
    }
}

/// A record's strong identifiers as `(scheme, comparison key)`, once each.
fn identities(record: &SourceRecord) -> BTreeSet<(&str, String)> {
    record
        .identifiers
        .iter()
        .filter(|identifier| STRONG_SCHEMES.contains(&identifier.scheme.as_str()))
        .filter_map(|identifier| {
            identity(&identifier.scheme, &identifier.value)
                .map(|key| (identifier.scheme.as_str(), key))
        })
        .collect()
}

fn ticked(ids: &[&str]) -> String {
    let ticked: Vec<String> = ids.iter().map(|id| format!("`{id}`")).collect();
    match ticked.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// What a version's volume count says about a set of locators: a page or
/// folio with no volume in a version in several volumes, or a volume the
/// version does not have. A reference record that gives its own volume
/// settles it.
enum VolumeGap<'a> {
    Missing {
        version: &'a SourceRecord,
        count: u64,
        kind: &'static str,
    },
    Unknown {
        version: &'a SourceRecord,
        count: u64,
        volume: String,
    },
    /// The citation names a volume other than the one its reference gives.
    Differs {
        version: &'a SourceRecord,
        own: String,
        volume: String,
    },
}

fn volume_gap<'a>(
    lookup: &Lookup<'a>,
    source: &str,
    locators: &[Locator],
) -> Option<VolumeGap<'a>> {
    let own = lookup
        .own_location(source)
        .and_then(|location| location.volume.as_deref());
    let version = lookup.version_of(source)?;
    let volume = locators
        .iter()
        .find(|locator| locator.kind.as_str() == VOLUME_LOCATOR);
    if let (Some(own), Some(volume)) = (own, volume) {
        if own.trim() != volume.value.trim() {
            return Some(VolumeGap::Differs {
                version,
                own: own.to_string(),
                volume: volume.value.clone(),
            });
        }
    }
    let count = version.volumes?;
    match volume {
        Some(volume) => volume
            .value
            .parse::<u64>()
            .is_ok_and(|number| number == 0 || number > count)
            .then(|| VolumeGap::Unknown {
                version,
                count,
                volume: volume.value.clone(),
            }),
        None if count > 1 && own.is_none() => {
            locators.iter().find_map(|locator| match locator.kind {
                LocatorKind::Page => Some(VolumeGap::Missing {
                    version,
                    count,
                    kind: "page",
                }),
                LocatorKind::Folio => Some(VolumeGap::Missing {
                    version,
                    count,
                    kind: "folio",
                }),
                _ => None,
            })
        }
        None => None,
    }
}

/// The finding for a volume gap, before it is placed.
fn volume_finding(
    gap: VolumeGap<'_>,
    object: ReviewObject,
    subject: &str,
    repair: String,
    mut facts: Vec<String>,
) -> SourceReviewFinding {
    let (code, message, version) = match gap {
        VolumeGap::Missing {
            version,
            count,
            kind,
        } => {
            facts.push(format!("volumes {count}"));
            (
                SourceReviewCode::VolumeMissing,
                format!(
                    "{subject} gives a {kind} in `{}`, which is recorded in {count} volumes that may each restart their {kind}s, but names no volume.",
                    version.id
                ),
                version,
            )
        }
        VolumeGap::Unknown {
            version,
            count,
            volume,
        } => {
            facts.push(format!("volumes {count}"));
            (
                SourceReviewCode::VolumeUnknown,
                format!(
                    "{subject} names volume {volume} of `{}`, which is recorded in {}.",
                    version.id,
                    plural(count as usize, "volume", "volumes")
                ),
                version,
            )
        }
        VolumeGap::Differs {
            version,
            own,
            volume,
        } => {
            facts.push(format!("volume {own}"));
            (
                SourceReviewCode::VolumeUnknown,
                format!(
                    "{subject} names volume {volume} of `{}`, but the reference it cites records volume {own}.",
                    version.id
                ),
                version,
            )
        }
    };
    let repair = if code == SourceReviewCode::VolumeUnknown {
        "Compare the volume with the source, and with the volume count recorded in the source library.".to_string()
    } else {
        repair
    };
    SourceReviewFinding::new(code, object, message, repair).about([version.id.clone()], facts)
}

/// A citation's key and locators in its canonical `[@key, ...]` form.
fn citation_fact(citation: &Citation) -> String {
    format_citation(citation).unwrap_or_else(|_| citation.key.clone())
}

/// The block quotations of a post, as byte ranges. A GitHub-style alert
/// (`> [!NOTE]`) is a callout, not a quotation.
fn block_quotations(markdown: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut depth = 0usize;
    let parser = Parser::new_ext(markdown, crate::markdown::parser_options(false));
    for (event, range) in parser.into_offset_iter() {
        match event {
            Event::Start(Tag::BlockQuote(kind)) => {
                if depth == 0 && kind.is_none() {
                    ranges.push(range);
                }
                depth += 1;
            }
            Event::End(TagEnd::BlockQuote(_)) => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    ranges
}

const CLOSING_QUOTES: [char; 9] = [
    '"', '\u{201d}', '\u{201c}', '\u{bb}', '\u{ab}', '\u{203a}', '\u{2039}', '\u{300d}', '\u{300f}',
];

/// The quoted words at the end of `line`, from the opening mark to the
/// closing mark, so other prose on the line and its wrapping do not count.
/// A line with no opening mark before the closing one gives the whole line.
fn quoted_span(line: &str) -> &str {
    let line = line.trim();
    let Some(close) = line.chars().next_back() else {
        return line;
    };
    let opens: &[char] = match close {
        '\u{201d}' => &['\u{201c}'],
        '\u{bb}' => &['\u{ab}'],
        '\u{ab}' => &['\u{bb}'],
        '\u{203a}' => &['\u{2039}'],
        '\u{2039}' => &['\u{203a}'],
        '\u{300d}' => &['\u{300c}'],
        '\u{300f}' => &['\u{300e}'],
        '\u{201c}' => &['\u{201d}'],
        _ => &['"'],
    };
    let inner = &line[..line.len() - close.len_utf8()];
    match inner.rfind(opens) {
        Some(at) => &line[at..],
        None => line,
    }
}

/// The quotation a citation attributes, if it attributes one: a block
/// quotation it sits in, or that it directly follows (after a dash), or
/// quoted words it directly follows (`"..." [@key]`, `«...» [@key]`). The
/// result is the quotation's source text, which identifies it.
fn quotation_of<'m>(
    markdown: &'m str,
    blocks: &[Range<usize>],
    mention: &CitationMention,
) -> Option<&'m str> {
    let start = mention.span.start;
    if let Some(block) = blocks.iter().find(|block| block.contains(&start)) {
        return Some(markdown[block.clone()].trim());
    }
    if let Some(block) = blocks.iter().rev().find(|block| block.end <= start) {
        let gap = &markdown[block.end..start];
        if gap
            .chars()
            .all(|c| c.is_whitespace() || matches!(c, '-' | '\u{2013}' | '\u{2014}' | '\u{2015}'))
            && gap.matches('\n').count() <= 2
        {
            return Some(markdown[block.clone()].trim());
        }
    }
    let before =
        markdown[..start].trim_end_matches(|c: char| c.is_whitespace() || c == '*' || c == '_');
    if before.ends_with(CLOSING_QUOTES) {
        let line_start = before.rfind('\n').map_or(0, |at| at + 1);
        return Some(quoted_span(&before[line_start..]));
    }
    None
}

/// Review the sources a post cites. `path` and `body_line` place findings
/// in the post's file, as citation review does. Only a post that opts in
/// to citations is reviewed, by its caller. `library` is called only when
/// the post cites something, and a post reviews nothing without one; a
/// citation whose key the library does not hold is citation review's and
/// is skipped here.
pub fn review_post<'l>(
    path: &str,
    markdown: &str,
    body_line: usize,
    library: impl FnOnce() -> Result<Option<&'l SourceLibrary>, String>,
) -> Vec<SourceReviewFinding> {
    let scan = scan_citations(markdown);
    if scan.mentions.is_empty() {
        return Vec::new();
    }
    let Ok(Some(library)) = library() else {
        return Vec::new();
    };
    let lookup = Lookup::new(library);
    let file_line = |line: usize| line + body_line.max(1) - 1;
    let blocks = block_quotations(markdown);
    let mut findings = Vec::new();
    let place = |mut finding: SourceReviewFinding, line: usize| {
        finding.path = Some(path.to_string());
        finding.line = Some(file_line(line));
        finding
    };

    for mention in &scan.mentions {
        let citation = &mention.citation;
        let key = citation.key.as_str();
        if lookup.get(key).is_none() {
            continue;
        }
        let fact = citation_fact(citation);
        if let Some(gap) = volume_gap(&lookup, key, &citation.locators) {
            findings.push(place(
                volume_finding(
                    gap,
                    ReviewObject::Post,
                    &format!("Citation `{key}`"),
                    format!(
                        "Add the volume, such as `[@{key}, {VOLUME_LOCATOR} 2; page 41]`, or cite a reference that records it."
                    ),
                    vec![fact.clone()],
                ),
                mention.line,
            ));
        }
        let Some(quotation) = quotation_of(markdown, &blocks, mention) else {
            continue;
        };
        let mut located: Vec<&str> = citation
            .locators
            .iter()
            .filter(|locator| locator.kind.as_str() != VOLUME_LOCATOR)
            .map(|locator| locator.kind.as_str())
            .collect();
        if let Some(location) = lookup.own_location(key) {
            located.push(location.scheme.as_str());
        }
        let facts = vec![fact.clone(), quotation.to_string()];
        if located.is_empty() {
            findings.push(place(
                SourceReviewFinding::new(
                    SourceReviewCode::QuotationLocatorMissing,
                    ReviewObject::Post,
                    format!("A quotation cites `{key}` without a location in it. open.blog checks only that a location is given, never that the quoted words are there."),
                    format!("Add where the words are, such as `[@{key}, page 514]`, a line or a timestamp, if the source has one; a source with no locations needs no change."),
                )
                .about([key.to_string()], facts.clone()),
                mention.line,
            ));
        } else if located
            .iter()
            .all(|kind| matches!(*kind, "chapter" | "section"))
        {
            let kinds: BTreeSet<&str> = located.iter().copied().collect();
            let kinds: Vec<&str> = kinds.into_iter().collect();
            findings.push(place(
                SourceReviewFinding::new(
                    SourceReviewCode::QuotationLocationBroad,
                    ReviewObject::Post,
                    format!(
                        "A quotation cites `{key}` only by {}, which spans more than the quoted words. open.blog checks only the kind of location, never that the words are there.",
                        kinds.join(" and ")
                    ),
                    "Add a page, line, folio, canonical or timestamp location if the source has one.".into(),
                )
                .about([key.to_string()], facts.clone()),
                mention.line,
            ));
        }
        if lookup.version_of(key).is_none() {
            if let Some(work) = lookup.work_of(key) {
                if let Some(versions) = lookup.versions.get(work) {
                    let mut facts = facts;
                    facts.push(format!("work {work}"));
                    facts.extend(versions.iter().map(|id| format!("version {id}")));
                    findings.push(place(
                        SourceReviewFinding::new(
                            SourceReviewCode::VersionUnspecified,
                            ReviewObject::Post,
                            format!(
                                "A quotation cites the work `{work}`, and the library records {} of it. Quoted words come from one edition, translation or witness.",
                                plural(versions.len(), "version", "versions")
                            ),
                            "Cite the version the words are quoted from, or keep the work if the words are the same in each.".into(),
                        )
                        .about(versions.iter().map(|id| id.to_string()), facts),
                        mention.line,
                    ));
                }
            }
        }
    }

    // Each resolved key once, in order of first citation, with that line.
    let mut cited: Vec<(&str, usize)> = Vec::new();
    for mention in &scan.mentions {
        let key = mention.citation.key.as_str();
        if lookup.get(key).is_some() && !cited.iter().any(|(seen, _)| *seen == key) {
            cited.push((key, mention.line));
        }
    }

    // Two cited records with the same identifier.
    for (position, &(key, line)) in cited.iter().enumerate() {
        let Some(record) = lookup.get(key) else {
            continue;
        };
        let mine = identities(record);
        let mut shared: Vec<&str> = Vec::new();
        let mut schemes: BTreeSet<&str> = BTreeSet::new();
        let mut facts = vec![format!("key {key}")];
        for &(earlier, _) in &cited[..position] {
            let Some(other) = lookup.get(earlier) else {
                continue;
            };
            let common: Vec<(&str, String)> = identities(other)
                .intersection(&mine)
                .filter(|(scheme, _)| *scheme != "isbn" || !lookup.related_for_isbn(key, earlier))
                .cloned()
                .collect();
            if common.is_empty() {
                continue;
            }
            shared.push(earlier);
            facts.push(format!("key {earlier}"));
            for (scheme, value) in common {
                schemes.insert(scheme);
                facts.push(format!("{scheme} {value}"));
            }
        }
        if shared.is_empty() {
            continue;
        }
        let schemes: Vec<&str> = schemes.into_iter().collect();
        findings.push(place(
            SourceReviewFinding::new(
                SourceReviewCode::CitationSameIdentifier,
                ReviewObject::Post,
                format!(
                    "The post cites `{key}` and {}, which have the same {} identifier, so readers may see one source listed as several references.",
                    ticked(&shared),
                    schemes.join(" and ")
                ),
                "Cite one record for the source, or merge the records in the source library.".into(),
            )
            .about(
                std::iter::once(key.to_string()).chain(shared.iter().map(|id| id.to_string())),
                facts,
            ),
            line,
        ));
    }

    // Several versions of one work: the version each key reads, or the
    // work itself when it reads none, grouped by work.
    let mut works: BTreeMap<&str, Vec<(&str, usize)>> = BTreeMap::new();
    let mut work_order: Vec<&str> = Vec::new();
    for &(key, line) in &cited {
        let Some(work) = lookup.work_of(key) else {
            continue;
        };
        let version = lookup
            .version_of(key)
            .map_or(work, |record| record.id.as_str());
        let versions = works.entry(work).or_default();
        if !versions.iter().any(|(seen, _)| *seen == version) {
            versions.push((version, line));
        }
        if !work_order.contains(&work) {
            work_order.push(work);
        }
    }
    for work in work_order {
        let versions = &works[work];
        if versions.len() < 2 {
            continue;
        }
        let ids: Vec<&str> = versions.iter().map(|(id, _)| *id).collect();
        let mut facts = vec![format!("work {work}")];
        facts.extend(ids.iter().map(|id| format!("version {id}")));
        findings.push(place(
            SourceReviewFinding::new(
                SourceReviewCode::CitationVersionsMixed,
                ReviewObject::Post,
                format!(
                    "The post cites {} of the work `{work}`: {}. Each place may need the version its words or location come from.",
                    plural(ids.len(), "version", "versions"),
                    ticked(&ids)
                ),
                "Check that each citation names the version it quotes or locates; citing several versions on purpose needs no change.".into(),
            )
            .about(ids.iter().map(|id| id.to_string()), facts),
            versions[1].1,
        ));
    }

    findings.sort_by(|a, b| a.line.cmp(&b.line).then(a.code.cmp(&b.code)));
    findings
}

/// Review the source library and the notebook passages that quote it.
/// Archived records and passages are left out: they are set aside, and
/// whatever still rests on them is reported by the checks that read it.
pub fn review_library(library: &SourceLibrary, notebook: &Notebook) -> Vec<SourceReviewFinding> {
    let lookup = Lookup::new(library);
    let mut findings = Vec::new();

    // Who shares each strong identifier, in library order.
    let mut holders: BTreeMap<(&str, String), Vec<&str>> = BTreeMap::new();
    for record in library.sources.iter().filter(|record| !record.archived) {
        for key in identities(record) {
            holders.entry(key).or_default().push(record.id.as_str());
        }
    }

    for (index, record) in library.sources.iter().enumerate() {
        if record.archived {
            continue;
        }
        let id = record.id.as_str();

        for scheme in SINGLE_SCHEMES {
            let positions: Vec<usize> = record
                .identifiers
                .iter()
                .enumerate()
                .filter(|(_, identifier)| identifier.scheme == scheme)
                .map(|(at, _)| at)
                .collect();
            let values: BTreeSet<String> = positions
                .iter()
                .filter_map(|at| identity(scheme, &record.identifiers[*at].value))
                .collect();
            if values.len() < 2 {
                continue;
            }
            let fields: Vec<String> = positions
                .iter()
                .map(|at| format!("identifiers[{at}]"))
                .collect();
            let mut facts = vec![scheme.to_string()];
            facts.extend(values.iter().cloned());
            findings.push(
                SourceReviewFinding::record(SourceReviewCode::IdentifierConflict, index, id, "identifiers")
                    .says(
                        format!(
                            "Source `{id}` has {} different `{scheme}` identifiers ({}). A {} names one published item, so the record may describe more than one, such as a preprint and its published version. Neither was changed.",
                            values.len(),
                            fields.join(", "),
                            scheme.to_ascii_uppercase()
                        ),
                        "Keep the identifier that names this record and record the other item as its own source, or keep both if that is what you mean.".into(),
                    )
                    .about(Vec::new(), facts),
            );
        }

        let mut shared: Vec<&str> = Vec::new();
        let mut schemes: BTreeSet<&str> = BTreeSet::new();
        let mut facts = Vec::new();
        for key in identities(record) {
            let Some(group) = holders.get(&key) else {
                continue;
            };
            let Some(position) = group.iter().position(|holder| *holder == id) else {
                continue;
            };
            let earlier: Vec<&str> = group[..position]
                .iter()
                .copied()
                .filter(|other| key.0 != "isbn" || !lookup.related_for_isbn(id, other))
                .collect();
            if earlier.is_empty() {
                continue;
            }
            schemes.insert(key.0);
            facts.push(format!("{} {}", key.0, key.1));
            for other in earlier {
                if !shared.contains(&other) {
                    shared.push(other);
                }
            }
        }
        if !shared.is_empty() {
            let schemes: Vec<&str> = schemes.into_iter().collect();
            facts.extend(shared.iter().map(|other| format!("source {other}")));
            findings.push(
                SourceReviewFinding::record(SourceReviewCode::IdentifierShared, index, id, "identifiers")
                    .says(
                        format!(
                            "Source `{id}` has the same {} identifier as {}. They may be one source recorded twice, or the identifier may belong to only one of them. Neither record was changed.",
                            schemes.join(" and "),
                            ticked(&shared)
                        ),
                        "Merge the records in the source library, or move the identifier to the record it names.".into(),
                    )
                    .about(shared.iter().map(|other| other.to_string()), facts),
            );
        }

        if record.kind == ResearchSourceKind::Work {
            let isbns: BTreeSet<String> = record
                .identifiers
                .iter()
                .filter(|identifier| identifier.scheme == "isbn")
                .filter_map(|identifier| identity("isbn", &identifier.value))
                .collect();
            if let Some(versions) = lookup.versions.get(id).filter(|_| !isbns.is_empty()) {
                let mut facts: Vec<String> = isbns.into_iter().collect();
                facts.extend(versions.iter().map(|version| format!("version {version}")));
                findings.push(
                    SourceReviewFinding::record(SourceReviewCode::IdentifierOnWork, index, id, "identifiers")
                        .says(
                            format!(
                                "Work `{id}` has an ISBN, and the library records {} of it. An ISBN identifies one edition or printing, so it may belong on one of those versions.",
                                plural(versions.len(), "version", "versions")
                            ),
                            "Move the ISBN to the version it identifies, or keep it if the work has only that one edition.".into(),
                        )
                        .about(versions.iter().map(|version| version.to_string()), facts),
                );
            }
        }

        if record.kind == ResearchSourceKind::Translation
            && !record.anonymous
            && !record
                .creators
                .iter()
                .any(|creator| creator.role.as_deref() == Some("translator"))
        {
            findings.push(
                SourceReviewFinding::record(SourceReviewCode::TranslatorMissing, index, id, "creators")
                    .says(
                        format!("Translation `{id}` names no translator among its creators and is not marked anonymous, so the record does not say whose translation it is. Nothing is filled in."),
                        "Add the translator as a creator with the role `translator` if the translation names one, or mark it anonymous.".into(),
                    ),
            );
        }

        if record.kind == ResearchSourceKind::Witness {
            let missing: Vec<&str> = [
                ("repository", record.repository.is_none()),
                ("shelfmark", record.shelfmark.is_none()),
            ]
            .into_iter()
            .filter(|(_, missing)| *missing)
            .map(|(field, _)| field)
            .collect();
            if !missing.is_empty() {
                let field = missing.join(" and ");
                findings.push(
                    SourceReviewFinding::record(SourceReviewCode::WitnessUnidentified, index, id, missing[0])
                        .says(
                            format!("Witness `{id}` records no {field}, so the copy it describes cannot be told apart from other copies of the same text."),
                            "Add the repository and shelfmark that hold this copy if you know them.".into(),
                        )
                        .about(Vec::new(), missing.iter().map(|field| field.to_string()).collect()),
                );
            }
        }
    }

    for (index, passage) in notebook.passages.iter().enumerate() {
        if passage.archived || lookup.get(&passage.source).is_none() {
            continue;
        }
        let place = |mut finding: SourceReviewFinding, field: &str| {
            finding.id = Some(passage.id.clone());
            finding.index = Some(index);
            finding.field = Some(field.to_string());
            finding
        };
        if passage.locators.is_empty() {
            findings.push(place(
                SourceReviewFinding::new(
                    SourceReviewCode::PassageLocatorMissing,
                    ReviewObject::Passage,
                    format!(
                        "Passage `{}` quotes source `{}` but records no location in it, so the words cannot be found again from the record. open.blog never checks that the words are there.",
                        passage.id, passage.source
                    ),
                    "Add where the passage is, such as page 514, in the notebook.".into(),
                )
                .about([passage.source.clone()], vec![format!("source {}", passage.source)]),
                "locators",
            ));
        } else if let Some(gap) = volume_gap(&lookup, &passage.source, &passage.locators) {
            let mut facts = vec![format!("source {}", passage.source)];
            facts.extend(passage.locators.iter().map(Locator::stated));
            let mut finding = volume_finding(
                gap,
                ReviewObject::Passage,
                &format!("Passage `{}`", passage.id),
                format!("Add an `{VOLUME_LOCATOR}` locator to the passage in the notebook."),
                facts,
            );
            if !finding.related.contains(&passage.source) {
                finding.related.insert(0, passage.source.clone());
            }
            findings.push(place(finding, "locators"));
        }
    }
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_isbn_10_and_its_isbn_13_compare_equal_without_rewriting_either() {
        assert_eq!(
            identity("isbn", "0-19-924849-4"),
            identity("isbn", "978-0-19-924849-0")
        );
        assert_eq!(
            identity("doi", "10.1000/ABC"),
            identity("doi", "https://doi.org/10.1000/abc")
        );
        assert_eq!(identity("pmcid", "pmc123"), identity("pmcid", "PMC123"));
        assert_eq!(identity("oclc", "123"), None);
        assert_eq!(identity("isbn", "12"), None);
    }
}
