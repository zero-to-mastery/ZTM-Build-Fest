//! Attributed interpretation comparisons and author-approved explanation
//! levels (ADR 0226, #88).
//!
//! A comparison sets several attributed readings of one subject side by side
//! and may carry audience-level explanations of that subject. It is its own
//! content type: it never edits a post, a source, a claim or an atlas entry,
//! and it is not the private source-library interpretation (ADR 0087), which
//! records who read one located place and is never published.
//!
//! The stored file is `content/comparisons/<slug>.json`
//! (`openblog-interpretation-comparison`, version 1). It is public,
//! author-written plain text. [`Comparison::parse`] checks it and
//! [`Comparison::to_canonical_json`] writes it back byte for byte the same,
//! keeping fields this release does not define (the reading-path idiom).
//!
//! The contract is deliberately silent about who is right:
//!
//! - An interpretation has an attribution, a statement, evidence, an
//!   uncertainty note and an origin. It has no verdict, score, rank,
//!   consensus or preferred flag, and a file that carries one is refused
//!   ([`JUDGEMENT_FIELDS`]). Relations between interpretations are
//!   `differs-from`, `agrees-with`, `builds-on` and `responds-to`; none is
//!   ordered by merit and none implies the other is wrong.
//! - An explanation is supplemental: a level (`beginner`, `student`,
//!   `scholarly`), about the whole comparison or one interpretation. It
//!   cannot replace canonical prose, and the file has no field for that.
//! - AI-drafted text is labelled by origin and publishes only after an
//!   explicit human approval bound to the exact text approved. Editing the
//!   text makes the approval stale. Nothing here calls a model.
//!
//! [`PublicComparison::project`] is the one allowlisted public value. It
//! carries only approved text, only evidence the build already publishes,
//! and says nothing about what it left out; the author-facing [`Withheld`]
//! list says it.

use std::collections::{BTreeMap, BTreeSet};

use blake2::{Blake2s256, Digest};
use serde::Serialize;
use serde_json::Value;

use crate::claims::ClaimSet;
use crate::reading_path::{
    is_ascii_slug, read_json, take_choice, take_object, take_text, Extra, Obj,
};
use crate::source_library::{valid_language_tag, valid_source_id, SourceLibrary};

/// Names the stored file.
pub const COMPARISON_FORMAT: &str = "openblog-interpretation-comparison";
/// The only stored version this release reads and writes.
pub const COMPARISON_VERSION: u64 = 1;
/// Where comparison files live, relative to the content folder.
pub const COMPARISONS_DIR: &str = "comparisons";

/// Largest comparison file, in bytes.
pub const MAX_FILE_BYTES: usize = 512 * 1024;
/// Most interpretations in one comparison.
pub const MAX_INTERPRETATIONS: usize = 50;
/// Most explanations in one comparison.
pub const MAX_EXPLANATIONS: usize = 150;
/// Most relations in one comparison.
pub const MAX_RELATIONS: usize = 200;
/// Most evidence references on one item.
pub const MAX_EVIDENCE: usize = 20;
/// Longest slug or item id, in bytes.
pub const MAX_ID_BYTES: usize = 64;
/// Longest title, in characters.
pub const MAX_TITLE_CHARS: usize = 120;
/// Longest short text (names, locators, labels), in characters.
pub const MAX_SHORT_CHARS: usize = 200;
/// Longest subject, relation note or uncertainty note, in characters.
pub const MAX_NOTE_CHARS: usize = 1_000;
/// Longest interpretation statement, in characters.
pub const MAX_STATEMENT_CHARS: usize = 4_000;
/// Most authors named on one explanation (ADR 0234).
pub const MAX_AUTHORS: usize = 5;

/// Longest explanation, in characters.
pub const MAX_EXPLANATION_CHARS: usize = 6_000;

/// Field names that would turn a comparison into a ruling, or an explanation
/// into a replacement for the canonical prose. A file holding one is refused
/// at any level (ADR 0227, 0228).
pub const JUDGEMENT_FIELDS: &[&str] = &[
    "correct",
    "incorrect",
    "right",
    "wrong",
    "true",
    "false",
    "winner",
    "verdict",
    "consensus",
    "score",
    "rank",
    "ranking",
    "rating",
    "authority",
    "authoritative",
    "preferred",
    "best",
    "majority",
    "replaces",
    "replacement",
    "canonical",
    "body",
    "overrides",
    "hides",
    "hidden",
    "gated",
    "locked",
];

/// Whether a comparison is public. Absent means a draft.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    #[default]
    Draft,
    Published,
}

impl Status {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "draft" => Some(Self::Draft),
            "published" => Some(Self::Published),
            _ => None,
        }
    }
}

/// The audience an explanation is written for, as the author states it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Level {
    Beginner,
    Student,
    Scholarly,
}

impl Level {
    /// Every level, in the order a reader is offered them.
    pub const ALL: [Self; 3] = [Self::Beginner, Self::Student, Self::Scholarly];

    /// The value as the file writes it.
    pub fn value(self) -> &'static str {
        match self {
            Self::Beginner => "beginner",
            Self::Student => "student",
            Self::Scholarly => "scholarly",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|l| l.value() == value)
    }
}

/// A reading mode a supplement may be offered in. `standard` shows no
/// supplement, so it is not a value here (ADR 0234).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExplanationMode {
    Guided,
    DeepDive,
}

impl ExplanationMode {
    pub const ALL: [Self; 2] = [Self::Guided, Self::DeepDive];

    pub fn value(self) -> &'static str {
        match self {
            Self::Guided => "guided",
            Self::DeepDive => "deep-dive",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|m| m.value() == value)
    }
}

/// An author's withdrawal of an explanation: it stays in the file and is
/// never public. The reason is for the author and never leaves the file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Withdrawal {
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// How an interpretation relates to another. None of these says which one is
/// right, and `differs-from` and `agrees-with` have no direction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RelationKind {
    DiffersFrom,
    AgreesWith,
    BuildsOn,
    RespondsTo,
}

impl RelationKind {
    pub const ALL: [Self; 4] = [
        Self::DiffersFrom,
        Self::AgreesWith,
        Self::BuildsOn,
        Self::RespondsTo,
    ];

    pub fn value(self) -> &'static str {
        match self {
            Self::DiffersFrom => "differs-from",
            Self::AgreesWith => "agrees-with",
            Self::BuildsOn => "builds-on",
            Self::RespondsTo => "responds-to",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.value() == value)
    }

    /// Whether the pair has no direction.
    pub fn symmetric(self) -> bool {
        matches!(self, Self::DiffersFrom | Self::AgreesWith)
    }
}

/// How firmly a name is tied to an interpretation, as the author records it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Certainty {
    Stated,
    Attributed,
    Uncertain,
    Disputed,
}

impl Certainty {
    pub const ALL: [Self; 4] = [
        Self::Stated,
        Self::Attributed,
        Self::Uncertain,
        Self::Disputed,
    ];

    pub fn value(self) -> &'static str {
        match self {
            Self::Stated => "stated",
            Self::Attributed => "attributed",
            Self::Uncertain => "uncertain",
            Self::Disputed => "disputed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.value() == value)
    }
}

/// Who held an interpretation. There is no default: an interpretation with
/// no attribution is refused, and an unknown author says so with
/// `anonymous` rather than being left blank.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Attribution {
    /// A named person, school or tradition.
    Named {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        certainty: Option<Certainty>,
        #[serde(flatten)]
        extra: Extra,
    },
    /// A source record of the library (a commentary, an edition).
    Source {
        source: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        certainty: Option<Certainty>,
        #[serde(flatten)]
        extra: Extra,
    },
    /// An unknown author, described in the author's words (for example
    /// "an anonymous twelfth-century commentator").
    Anonymous {
        description: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        certainty: Option<Certainty>,
        #[serde(flatten)]
        extra: Extra,
    },
}

/// Where a piece of text came from. Never inferred.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Origin {
    /// Written by the author. The default.
    Author {
        #[serde(flatten)]
        extra: Extra,
    },
    /// A draft produced by an AI tool. `tool` is the author's label for it.
    AiDraft {
        tool: String,
        #[serde(rename = "draftedAt", skip_serializing_if = "Option::is_none")]
        drafted_at: Option<String>,
        #[serde(flatten)]
        extra: Extra,
    },
}

impl Default for Origin {
    fn default() -> Self {
        Self::Author {
            extra: Extra::new(),
        }
    }
}

impl Origin {
    pub fn is_ai(&self) -> bool {
        matches!(self, Self::AiDraft { .. })
    }

    /// Plain author origin: the default, which a file may leave out.
    fn is_plain(&self) -> bool {
        matches!(self, Self::Author { extra } if extra.is_empty())
    }
}

/// A human's explicit approval of the exact text next to it. `digest` binds
/// the approval to that text: change the text and the approval is stale.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    /// The person who read the text and approved it.
    pub by: String,
    pub at: String,
    pub digest: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A pointer at evidence the author already holds. It is a reference, never
/// a quotation: the evidence stays where it is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum EvidenceRef {
    /// An evidence link of Evidence Studio, by id.
    Link {
        link: String,
        #[serde(flatten)]
        extra: Extra,
    },
    /// A source of the library, with where in it to look.
    Source {
        source: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        locator: Option<String>,
        #[serde(flatten)]
        extra: Extra,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Interpretation {
    pub id: String,
    pub attribution: Attribution,
    /// What this reading holds, in the author's words about that reading.
    pub statement: String,
    /// The language of `statement`, when it is not the site's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// The id of the interpretation this one translates.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation_of: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<EvidenceRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncertainty: Option<String>,
    #[serde(skip_serializing_if = "Origin::is_plain")]
    pub origin: Origin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<Approval>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Interpretation {
    pub fn new(
        id: impl Into<String>,
        attribution: Attribution,
        statement: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            attribution,
            statement: statement.into(),
            language: None,
            translation_of: None,
            evidence: Vec::new(),
            uncertainty: None,
            origin: Origin::default(),
            approval: None,
            extra: Extra::new(),
        }
    }

    /// The digest an approval of this interpretation must carry. It covers
    /// everything a reader sees of the item: the statement, the attribution
    /// and its certainty, the uncertainty note, the language and the
    /// translation link. Origin, tool and dates stay out, so recording them
    /// never withdraws an approval.
    pub fn digest(&self) -> String {
        let (kind, who, certainty) = match &self.attribution {
            Attribution::Named {
                name, certainty, ..
            } => ("named", name.as_str(), *certainty),
            Attribution::Source {
                source, certainty, ..
            } => ("source", source.as_str(), *certainty),
            Attribution::Anonymous {
                description,
                certainty,
                ..
            } => ("anonymous", description.as_str(), *certainty),
        };
        let mut text = String::new();
        for part in [
            kind,
            who,
            certainty.map_or("", Certainty::value),
            self.uncertainty.as_deref().unwrap_or(""),
            self.language.as_deref().unwrap_or(""),
            self.translation_of.as_deref().unwrap_or(""),
            &self.statement,
        ] {
            text.push_str(&part.len().to_string());
            text.push(':');
            text.push_str(part);
            text.push(' ');
        }
        text_digest("interpretation", &self.id, &text)
    }

    pub fn standing(&self) -> Standing {
        standing(&self.origin, self.approval.as_ref(), &self.digest())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub from: String,
    pub to: String,
    pub kind: RelationKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Explanation {
    pub id: String,
    pub level: Level,
    /// The interpretation explained; absent means the comparison's subject.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    pub text: String,
    /// Who wrote it, as display names. Empty means the comparison's author.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    /// What the author suggests a reader know first. Advice, never a gate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prerequisite: Option<String>,
    /// The reading modes it is offered in; empty means every mode that
    /// shows supplements. One explanation serves them all.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub modes: Vec<ExplanationMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// The explanation this one translates (same level, same subject).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation_of: Option<String>,
    /// The author's number for the revision on view; informational.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<EvidenceRef>,
    #[serde(skip_serializing_if = "Origin::is_plain")]
    pub origin: Origin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<Approval>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub withdrawn: Option<Withdrawal>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Explanation {
    pub fn new(id: impl Into<String>, level: Level, text: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            level,
            about: None,
            text: text.into(),
            authors: Vec::new(),
            prerequisite: None,
            modes: Vec::new(),
            language: None,
            translation_of: None,
            revision: None,
            evidence: Vec::new(),
            origin: Origin::default(),
            approval: None,
            withdrawn: None,
            extra: Extra::new(),
        }
    }

    /// The digest an approval of this explanation must carry. It covers the
    /// text and, when present, what else a reader sees of it: authors,
    /// prerequisite, language and translation link. An explanation that has
    /// none of those keeps the digest it had before they existed (ADR 0234).
    pub fn digest(&self) -> String {
        let plain = self.authors.is_empty()
            && self.prerequisite.is_none()
            && self.language.is_none()
            && self.translation_of.is_none();
        if plain {
            return text_digest("explanation", &self.id, &self.text);
        }
        let mut text = String::new();
        let authors = self.authors.join("\u{1f}");
        for part in [
            authors.as_str(),
            self.prerequisite.as_deref().unwrap_or(""),
            self.language.as_deref().unwrap_or(""),
            self.translation_of.as_deref().unwrap_or(""),
            &self.text,
        ] {
            text.push_str(&part.len().to_string());
            text.push(':');
            text.push_str(part);
            text.push(' ');
        }
        text_digest("explanation", &self.id, &text)
    }

    pub fn standing(&self) -> Standing {
        standing(&self.origin, self.approval.as_ref(), &self.digest())
    }
}

/// One comparison as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Comparison {
    /// From the file name; never stored in the file.
    pub slug: String,
    pub title: String,
    /// What the interpretations are about, in neutral words.
    pub subject: String,
    pub status: Status,
    pub interpretations: Vec<Interpretation>,
    pub relations: Vec<Relation>,
    pub explanations: Vec<Explanation>,
    pub extra: Extra,
}

impl Comparison {
    pub fn draft(
        slug: impl Into<String>,
        title: impl Into<String>,
        subject: impl Into<String>,
    ) -> Self {
        Self {
            slug: slug.into(),
            title: title.into(),
            subject: subject.into(),
            status: Status::Draft,
            interpretations: Vec::new(),
            relations: Vec::new(),
            explanations: Vec::new(),
            extra: Extra::new(),
        }
    }
}

fn text_digest(kind: &str, id: &str, text: &str) -> String {
    let mut hasher = Blake2s256::new();
    hasher.update(b"openblog-comparison-text-v1\0");
    for part in [kind, id, text] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// One refusal, scoped to a file and, where it has one, an item. It names
/// ids and limits, never an item's text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComparisonProblem {
    pub file: String,
    pub item: Option<String>,
    pub message: String,
}

impl std::fmt::Display for ComparisonProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.item {
            Some(item) => write!(f, "{}: `{}`: {}", self.file, item, self.message),
            None => write!(f, "{}: {}", self.file, self.message),
        }
    }
}

/// Whether `value` can name a comparison file: a plain slug that is not a
/// name Windows reserves for a device.
pub fn valid_comparison_slug(value: &str) -> bool {
    const DEVICES: [&str; 4] = ["con", "prn", "aux", "nul"];
    let device = DEVICES.contains(&value)
        || ((value.starts_with("com") || value.starts_with("lpt"))
            && value.len() == 4
            && value.as_bytes()[3].is_ascii_digit()
            && value.as_bytes()[3] != b'0');
    is_ascii_slug(value) && !device
}

fn direction_char(c: char) -> bool {
    matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

fn text_problem(value: &str, max_chars: usize, prose: bool) -> Option<String> {
    if value.chars().count() > max_chars {
        return Some(format!("is over {max_chars} characters"));
    }
    let bad =
        |c: char| direction_char(c) || (c.is_control() && !(prose && (c == '\n' || c == '\t')));
    value
        .chars()
        .any(bad)
        .then(|| "holds a control or direction character".to_string())
}

fn check_required(value: &str, name: &str, max: usize, prose: bool, at: &mut dyn FnMut(String)) {
    if value.trim().is_empty() {
        at(format!("`{name}` is required"));
    } else if let Some(p) = text_problem(value, max, prose) {
        at(format!("`{name}` {p}"));
    }
}

fn check_optional(value: Option<&str>, name: &str, max: usize, at: &mut dyn FnMut(String)) {
    if let Some(p) = value.and_then(|v| text_problem(v, max, false)) {
        at(format!("`{name}` {p}"));
    }
}

fn check_time(value: &str, name: &str, at: &mut dyn FnMut(String)) {
    if value.is_empty() || text_problem(value, 40, false).is_some() {
        at(format!("`{name}` is not a time"));
    }
}

// ---------------------------------------------------------------------------
// Reading the file. A message names a field, never what it held.
// ---------------------------------------------------------------------------

fn reject_judgement(obj: &Obj, errs: &mut Vec<String>) {
    for name in JUDGEMENT_FIELDS {
        if obj.contains_key(*name) {
            errs.push(format!(
                "`{name}` is not a field of a comparison: it never rules on which reading is right or replaces the canonical prose"
            ));
        }
    }
}

type AttributionCtor = fn(String, Option<Certainty>, Extra) -> Attribution;

fn read_attribution(obj: &mut Obj, errs: &mut Vec<String>) -> Option<Attribution> {
    let mut a = take_object(obj, "attribution", true, errs)?;
    let kind = take_text(&mut a, "kind", "attribution.", true, errs)?;
    let certainty = take_choice(
        &mut a,
        "certainty",
        "attribution.",
        false,
        Certainty::parse,
        "`stated`, `attributed`, `uncertain` or `disputed`",
        errs,
    );
    let (key, ctor): (&str, AttributionCtor) = match kind.as_str() {
        "named" => ("name", |name, certainty, extra| Attribution::Named {
            name,
            certainty,
            extra,
        }),
        "source" => ("source", |source, certainty, extra| Attribution::Source {
            source,
            certainty,
            extra,
        }),
        "anonymous" => ("description", |description, certainty, extra| {
            Attribution::Anonymous {
                description,
                certainty,
                extra,
            }
        }),
        _ => {
            errs.push("`attribution.kind` must be `named`, `source` or `anonymous`".into());
            return None;
        }
    };
    let value = take_text(&mut a, key, "attribution.", true, errs)?;
    Some(ctor(value, certainty, a.into_iter().collect()))
}

fn read_origin(obj: &mut Obj, errs: &mut Vec<String>) -> Origin {
    let Some(mut o) = take_object(obj, "origin", false, errs) else {
        return Origin::default();
    };
    let Some(kind) = take_text(&mut o, "kind", "origin.", true, errs) else {
        return Origin::default();
    };
    match kind.as_str() {
        "author" => Origin::Author {
            extra: o.into_iter().collect(),
        },
        "ai-draft" => {
            let tool = take_text(&mut o, "tool", "origin.", true, errs).unwrap_or_default();
            let drafted_at = take_text(&mut o, "draftedAt", "origin.", false, errs);
            Origin::AiDraft {
                tool,
                drafted_at,
                extra: o.into_iter().collect(),
            }
        }
        _ => {
            errs.push("`origin.kind` must be `author` or `ai-draft`".into());
            Origin::default()
        }
    }
}

fn read_approval(obj: &mut Obj, errs: &mut Vec<String>) -> Option<Approval> {
    let mut a = take_object(obj, "approval", false, errs)?;
    let by = take_text(&mut a, "by", "approval.", true, errs);
    let at = take_text(&mut a, "at", "approval.", true, errs);
    let digest = take_text(&mut a, "digest", "approval.", true, errs);
    Some(Approval {
        by: by?,
        at: at?,
        digest: digest?,
        extra: a.into_iter().collect(),
    })
}

fn read_evidence(obj: &mut Obj, errs: &mut Vec<String>) -> Vec<EvidenceRef> {
    let items = match obj.remove("evidence") {
        None => return Vec::new(),
        Some(Value::Array(items)) => items,
        Some(_) => {
            errs.push("`evidence` must be a list".into());
            return Vec::new();
        }
    };
    if items.len() > MAX_EVIDENCE {
        errs.push(format!(
            "has {} evidence references; at most {MAX_EVIDENCE}",
            items.len()
        ));
        return Vec::new();
    }
    let mut out = Vec::new();
    for (n, item) in items.into_iter().enumerate() {
        let Value::Object(mut e) = item else {
            errs.push(format!("`evidence[{n}]` must be an object"));
            continue;
        };
        let scope = format!("evidence[{n}].");
        let link = take_text(&mut e, "link", &scope, false, errs);
        let source = take_text(&mut e, "source", &scope, false, errs);
        let locator = take_text(&mut e, "locator", &scope, false, errs);
        match (link, source) {
            (Some(link), None) => {
                if locator.is_some() {
                    errs.push(format!("`evidence[{n}].locator` belongs to a `source`"));
                }
                out.push(EvidenceRef::Link {
                    link,
                    extra: e.into_iter().collect(),
                });
            }
            (None, Some(source)) => out.push(EvidenceRef::Source {
                source,
                locator,
                extra: e.into_iter().collect(),
            }),
            _ => errs.push(format!(
                "`evidence[{n}]` names exactly one of `link` or `source`"
            )),
        }
    }
    out
}

fn read_interpretation(value: Value, errs: &mut Vec<String>) -> Option<Interpretation> {
    let Value::Object(mut obj) = value else {
        errs.push("must be an object".into());
        return None;
    };
    let before = errs.len();
    reject_judgement(&obj, errs);
    let id = take_text(&mut obj, "id", "", true, errs);
    let attribution = read_attribution(&mut obj, errs);
    let statement = take_text(&mut obj, "statement", "", true, errs);
    let language = take_text(&mut obj, "language", "", false, errs);
    let translation_of = take_text(&mut obj, "translationOf", "", false, errs);
    let evidence = read_evidence(&mut obj, errs);
    let uncertainty = take_text(&mut obj, "uncertainty", "", false, errs);
    let origin = read_origin(&mut obj, errs);
    let approval = read_approval(&mut obj, errs);
    if errs.len() > before {
        return None;
    }
    Some(Interpretation {
        id: id?,
        attribution: attribution?,
        statement: statement?,
        language,
        translation_of,
        evidence,
        uncertainty,
        origin,
        approval,
        extra: obj.into_iter().collect(),
    })
}

fn read_explanation(value: Value, errs: &mut Vec<String>) -> Option<Explanation> {
    let Value::Object(mut obj) = value else {
        errs.push("must be an object".into());
        return None;
    };
    let before = errs.len();
    reject_judgement(&obj, errs);
    let id = take_text(&mut obj, "id", "", true, errs);
    let level = take_choice(
        &mut obj,
        "level",
        "",
        true,
        Level::parse,
        "`beginner`, `student` or `scholarly`",
        errs,
    );
    let about = take_text(&mut obj, "about", "", false, errs);
    let text = take_text(&mut obj, "text", "", true, errs);
    let authors = read_text_list(&mut obj, "authors", MAX_AUTHORS, errs);
    let prerequisite = take_text(&mut obj, "prerequisite", "", false, errs);
    let modes = read_modes(&mut obj, errs);
    let language = take_text(&mut obj, "language", "", false, errs);
    let translation_of = take_text(&mut obj, "translationOf", "", false, errs);
    let revision = match obj.remove("revision") {
        None => None,
        Some(Value::Number(n)) if n.as_u64().is_some_and(|n| n >= 1) => n.as_u64(),
        Some(_) => {
            errs.push("`revision` must be a whole number from 1".into());
            None
        }
    };
    let evidence = read_evidence(&mut obj, errs);
    let origin = read_origin(&mut obj, errs);
    let approval = read_approval(&mut obj, errs);
    let withdrawn = read_withdrawal(&mut obj, errs);
    if errs.len() > before {
        return None;
    }
    Some(Explanation {
        id: id?,
        level: level?,
        about,
        text: text?,
        authors,
        prerequisite,
        modes,
        language,
        translation_of,
        revision,
        evidence,
        origin,
        approval,
        withdrawn,
        extra: obj.into_iter().collect(),
    })
}

fn read_text_list(obj: &mut Obj, name: &str, max: usize, errs: &mut Vec<String>) -> Vec<String> {
    let items = take_list(obj, name, max, errs);
    let mut out = Vec::new();
    for item in items {
        match item {
            Value::String(s) => out.push(s),
            _ => errs.push(format!("`{name}` holds text only")),
        }
    }
    out
}

fn read_modes(obj: &mut Obj, errs: &mut Vec<String>) -> Vec<ExplanationMode> {
    let items = take_list(obj, "modes", ExplanationMode::ALL.len(), errs);
    let mut out = Vec::new();
    for item in items {
        match item.as_str().and_then(ExplanationMode::parse) {
            Some(m) if !out.contains(&m) => out.push(m),
            Some(_) => errs.push("`modes` names a mode twice".into()),
            None => errs.push("`modes` holds `guided` or `deep-dive`".into()),
        }
    }
    out
}

fn read_withdrawal(obj: &mut Obj, errs: &mut Vec<String>) -> Option<Withdrawal> {
    let mut w = take_object(obj, "withdrawn", false, errs)?;
    let at = take_text(&mut w, "at", "withdrawn.", true, errs);
    let reason = take_text(&mut w, "reason", "withdrawn.", false, errs);
    Some(Withdrawal {
        at: at?,
        reason,
        extra: w.into_iter().collect(),
    })
}

fn read_relation(value: Value, errs: &mut Vec<String>) -> Option<Relation> {
    let Value::Object(mut obj) = value else {
        errs.push("must be an object".into());
        return None;
    };
    let before = errs.len();
    reject_judgement(&obj, errs);
    let from = take_text(&mut obj, "from", "", true, errs);
    let to = take_text(&mut obj, "to", "", true, errs);
    let kind = take_choice(
        &mut obj,
        "kind",
        "",
        true,
        RelationKind::parse,
        "`differs-from`, `agrees-with`, `builds-on` or `responds-to`",
        errs,
    );
    let note = take_text(&mut obj, "note", "", false, errs);
    if errs.len() > before {
        return None;
    }
    Some(Relation {
        from: from?,
        to: to?,
        kind: kind?,
        note,
        extra: obj.into_iter().collect(),
    })
}

fn take_list(root: &mut Obj, name: &str, max: usize, errs: &mut Vec<String>) -> Vec<Value> {
    match root.remove(name) {
        None => Vec::new(),
        Some(Value::Array(items)) if items.len() <= max => items,
        Some(Value::Array(items)) => {
            errs.push(format!(
                "has {} entries in `{name}`; at most {max}",
                items.len()
            ));
            Vec::new()
        }
        Some(_) => {
            errs.push(format!("`{name}` must be a list"));
            Vec::new()
        }
    }
}

fn item_label(value: &Value, index: usize) -> String {
    value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_ascii_slug(id))
        .map_or_else(|| format!("#{}", index + 1), str::to_string)
}

impl Comparison {
    /// Reads and checks one file. `file` is its path under the content
    /// folder (`comparisons/<slug>.json`), which names the comparison. Every
    /// refusal found is returned, and a refused file is never partly read.
    pub fn parse(file: &str, text: &str) -> Result<Self, Vec<ComparisonProblem>> {
        let mut problems: Vec<ComparisonProblem> = Vec::new();
        let add = |problems: &mut Vec<ComparisonProblem>, item: Option<&str>, message: String| {
            problems.push(ComparisonProblem {
                file: file.to_string(),
                item: item.map(str::to_string),
                message,
            });
        };
        let stem = file
            .strip_prefix("comparisons/")
            .and_then(|rest| rest.strip_suffix(".json"))
            .filter(|stem| valid_comparison_slug(stem));
        let Some(slug) = stem else {
            add(
                &mut problems,
                None,
                format!(
                    "a comparison file is `{COMPARISONS_DIR}/<slug>.json` with a lowercase slug of at most {MAX_ID_BYTES} characters"
                ),
            );
            return Err(problems);
        };
        if text.len() > MAX_FILE_BYTES {
            add(
                &mut problems,
                None,
                format!("is over {MAX_FILE_BYTES} bytes"),
            );
            return Err(problems);
        }
        let mut root = match read_json(text) {
            Ok(Value::Object(root)) => root,
            Ok(_) => {
                add(&mut problems, None, "must be a JSON object".into());
                return Err(problems);
            }
            Err(message) => {
                add(&mut problems, None, message);
                return Err(problems);
            }
        };
        if root.get("format").and_then(Value::as_str) != Some(COMPARISON_FORMAT) {
            add(
                &mut problems,
                None,
                format!("`format` must be `{COMPARISON_FORMAT}`"),
            );
            return Err(problems);
        }
        match root.get("version").and_then(Value::as_u64) {
            Some(COMPARISON_VERSION) => {}
            Some(other) => {
                add(
                    &mut problems,
                    None,
                    format!(
                        "is version {other}; this release reads version {COMPARISON_VERSION} only"
                    ),
                );
                return Err(problems);
            }
            None => {
                add(&mut problems, None, "`version` must be a number".into());
                return Err(problems);
            }
        }
        root.remove("format");
        root.remove("version");
        let mut errs: Vec<String> = Vec::new();
        reject_judgement(&root, &mut errs);
        let title = take_text(&mut root, "title", "", true, &mut errs);
        let subject = take_text(&mut root, "subject", "", true, &mut errs);
        let status = take_choice(
            &mut root,
            "status",
            "",
            false,
            Status::parse,
            "`draft` or `published`",
            &mut errs,
        )
        .unwrap_or_default();
        let raw_interpretations =
            take_list(&mut root, "interpretations", MAX_INTERPRETATIONS, &mut errs);
        let raw_relations = take_list(&mut root, "relations", MAX_RELATIONS, &mut errs);
        let raw_explanations = take_list(&mut root, "explanations", MAX_EXPLANATIONS, &mut errs);
        for message in errs {
            add(&mut problems, None, message);
        }
        let title = title.unwrap_or_default();
        let subject = subject.unwrap_or_default();
        {
            let mut top = |message: String| add(&mut problems, None, message);
            if !title.is_empty() {
                check_required(&title, "title", MAX_TITLE_CHARS, false, &mut top);
            }
            if !subject.is_empty() {
                check_required(&subject, "subject", MAX_NOTE_CHARS, false, &mut top);
            }
        }
        let mut interpretations = Vec::new();
        for (index, value) in raw_interpretations.into_iter().enumerate() {
            let name = item_label(&value, index);
            let mut e = Vec::new();
            match read_interpretation(value, &mut e) {
                Some(i) => interpretations.push(i),
                None => e
                    .into_iter()
                    .for_each(|m| add(&mut problems, Some(&name), m)),
            }
        }
        let mut relations = Vec::new();
        for (index, value) in raw_relations.into_iter().enumerate() {
            let name = format!("relation #{}", index + 1);
            let mut e = Vec::new();
            match read_relation(value, &mut e) {
                Some(r) => relations.push(r),
                None => e
                    .into_iter()
                    .for_each(|m| add(&mut problems, Some(&name), m)),
            }
        }
        let mut explanations = Vec::new();
        for (index, value) in raw_explanations.into_iter().enumerate() {
            let name = item_label(&value, index);
            let mut e = Vec::new();
            match read_explanation(value, &mut e) {
                Some(x) => explanations.push(x),
                None => e
                    .into_iter()
                    .for_each(|m| add(&mut problems, Some(&name), m)),
            }
        }
        let comparison = Self {
            slug: slug.to_string(),
            title,
            subject,
            status,
            interpretations,
            relations,
            explanations,
            extra: root.into_iter().collect(),
        };
        // Cross-item checks only make sense once every item was read.
        if problems.is_empty() {
            comparison.check(file, &mut problems);
        }
        if !problems.is_empty() {
            return Err(problems);
        }
        Ok(comparison)
    }

    /// Checks a comparison built in memory (an Admin edit) by the rules
    /// `parse` applies to a file, without writing anything.
    pub fn validate(&self) -> Vec<ComparisonProblem> {
        match Self::parse(
            &format!("{COMPARISONS_DIR}/{}.json", self.slug),
            &self.to_canonical_json(),
        ) {
            Ok(_) => Vec::new(),
            Err(problems) => problems,
        }
    }

    /// The file's bytes: two-space JSON, fixed field order, `\n` line ends and
    /// a final newline. Fields this release does not define follow the
    /// defined ones in name order.
    pub fn to_canonical_json(&self) -> String {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Out<'a> {
            format: &'a str,
            version: u64,
            title: &'a str,
            subject: &'a str,
            status: Status,
            interpretations: &'a [Interpretation],
            #[serde(skip_serializing_if = "<[Relation]>::is_empty")]
            relations: &'a [Relation],
            #[serde(skip_serializing_if = "<[Explanation]>::is_empty")]
            explanations: &'a [Explanation],
            #[serde(flatten)]
            extra: &'a Extra,
        }
        let mut text = serde_json::to_string_pretty(&Out {
            format: COMPARISON_FORMAT,
            version: COMPARISON_VERSION,
            title: &self.title,
            subject: &self.subject,
            status: self.status,
            interpretations: &self.interpretations,
            relations: &self.relations,
            explanations: &self.explanations,
            extra: &self.extra,
        })
        .expect("a comparison is serializable");
        text.push('\n');
        text
    }

    fn check(&self, file: &str, problems: &mut Vec<ComparisonProblem>) {
        let published = self.status == Status::Published;
        let mut ids: BTreeSet<&str> = BTreeSet::new();
        let interp_ids: BTreeSet<&str> =
            self.interpretations.iter().map(|i| i.id.as_str()).collect();
        let name = |id: &str, index: usize| {
            if is_ascii_slug(id) {
                id.to_string()
            } else {
                format!("#{}", index + 1)
            }
        };
        let mut push = |item: &str, message: String| {
            problems.push(ComparisonProblem {
                file: file.to_string(),
                item: Some(item.to_string()),
                message,
            })
        };
        for (index, i) in self.interpretations.iter().enumerate() {
            let label = name(&i.id, index);
            let mut at = |message: String| push(&label, message);
            if !is_ascii_slug(&i.id) {
                at(format!(
                    "`id` is a lowercase slug of at most {MAX_ID_BYTES} characters"
                ));
            } else if !ids.insert(i.id.as_str()) {
                at("`id` is used by an earlier item".into());
            }
            check_required(
                &i.statement,
                "statement",
                MAX_STATEMENT_CHARS,
                true,
                &mut at,
            );
            check_optional(
                i.uncertainty.as_deref(),
                "uncertainty",
                MAX_NOTE_CHARS,
                &mut at,
            );
            match &i.attribution {
                Attribution::Named { name, .. } => {
                    check_required(name, "attribution.name", MAX_SHORT_CHARS, false, &mut at)
                }
                Attribution::Anonymous { description, .. } => check_required(
                    description,
                    "attribution.description",
                    MAX_SHORT_CHARS,
                    false,
                    &mut at,
                ),
                Attribution::Source { source, .. } => {
                    if !valid_source_id(source) {
                        at("`attribution.source` is not a source id".into());
                    }
                }
            }
            if let Some(language) = &i.language {
                if !valid_language_tag(language) {
                    at("`language` is not a language tag such as `en` or `grc`".into());
                }
            }
            if let Some(of) = &i.translation_of {
                if of == &i.id {
                    at("`translationOf` names this interpretation itself".into());
                } else if !interp_ids.contains(of.as_str()) {
                    at("`translationOf` names no interpretation of this comparison".into());
                } else if i.language.is_none() {
                    at("a translation says its `language`".into());
                }
            }
            check_evidence(&i.evidence, &mut at);
            check_provenance(
                &i.origin,
                i.approval.as_ref(),
                &i.digest(),
                published,
                &mut at,
            );
        }
        // A chain of translations must end at an original.
        for (index, i) in self.interpretations.iter().enumerate() {
            let mut seen = BTreeSet::new();
            let mut cursor = i;
            while let Some(of) = &cursor.translation_of {
                if !seen.insert(cursor.id.as_str()) {
                    push(
                        &name(&i.id, index),
                        "`translationOf` leads back to this interpretation".into(),
                    );
                    break;
                }
                match self.interpretations.iter().find(|n| &n.id == of) {
                    Some(next) => cursor = next,
                    None => break,
                }
            }
        }
        let mut pairs: BTreeSet<(RelationKind, String, String)> = BTreeSet::new();
        for (index, r) in self.relations.iter().enumerate() {
            let label = format!("relation #{}", index + 1);
            let mut at = |message: String| push(&label, message);
            check_optional(r.note.as_deref(), "note", MAX_NOTE_CHARS, &mut at);
            if !interp_ids.contains(r.from.as_str()) || !interp_ids.contains(r.to.as_str()) {
                at("`from` and `to` name interpretations of this comparison".into());
                continue;
            }
            if r.from == r.to {
                at("an interpretation is not related to itself".into());
                continue;
            }
            let (a, b) = if r.kind.symmetric() && r.from > r.to {
                (r.to.clone(), r.from.clone())
            } else {
                (r.from.clone(), r.to.clone())
            };
            if !pairs.insert((r.kind, a, b)) {
                at("repeats an earlier relation of the same kind between the same pair".into());
            }
        }
        let mut subjects: BTreeSet<(Level, Option<&str>, Option<&str>)> = BTreeSet::new();
        for (index, x) in self.explanations.iter().enumerate() {
            let label = name(&x.id, index);
            let mut at = |message: String| push(&label, message);
            if !is_ascii_slug(&x.id) {
                at(format!(
                    "`id` is a lowercase slug of at most {MAX_ID_BYTES} characters"
                ));
            } else if !ids.insert(x.id.as_str()) {
                at("`id` is used by an earlier item".into());
            }
            check_required(&x.text, "text", MAX_EXPLANATION_CHARS, true, &mut at);
            if let Some(about) = &x.about {
                if !interp_ids.contains(about.as_str()) {
                    at("`about` names no interpretation of this comparison".into());
                }
            }
            // A withdrawn explanation gives up its place, so a replacement
            // can take it; a translation has its own language.
            if x.withdrawn.is_none()
                && !subjects.insert((x.level, x.about.as_deref(), x.language.as_deref()))
            {
                at(format!(
                    "a second `{}` explanation of the same subject in the same language; there is one per level",
                    x.level.value()
                ));
            }
            let mut named: BTreeSet<&str> = BTreeSet::new();
            for author in &x.authors {
                check_required(author, "authors", MAX_SHORT_CHARS, false, &mut at);
                if !named.insert(author.as_str()) {
                    at("`authors` names someone twice".into());
                }
            }
            check_optional(
                x.prerequisite.as_deref(),
                "prerequisite",
                MAX_SHORT_CHARS,
                &mut at,
            );
            if x.prerequisite
                .as_deref()
                .is_some_and(|p| p.trim().is_empty())
            {
                at("`prerequisite` is empty; leave it out".into());
            }
            if let Some(w) = &x.withdrawn {
                check_time(&w.at, "withdrawn.at", &mut at);
                check_optional(
                    w.reason.as_deref(),
                    "withdrawn.reason",
                    MAX_NOTE_CHARS,
                    &mut at,
                );
            }
            if let Some(language) = &x.language {
                if !valid_language_tag(language) {
                    at("`language` is not a language tag such as `en` or `grc`".into());
                }
            }
            if let Some(of) = &x.translation_of {
                match self.explanations.iter().find(|o| &o.id == of) {
                    _ if of == &x.id => at("`translationOf` names this explanation itself".into()),
                    None => at("`translationOf` names no explanation of this comparison".into()),
                    Some(o) if o.translation_of.is_some() => {
                        at("`translationOf` names a translation; point at the original".into())
                    }
                    Some(o) if o.level != x.level || o.about != x.about => at(
                        "`translationOf` names an explanation for another level or subject".into(),
                    ),
                    Some(_) if x.language.is_none() => {
                        at("a translation says its `language`".into())
                    }
                    Some(_) => {}
                }
            }
            check_evidence(&x.evidence, &mut at);
            // An explanation never brings evidence of its own: what it cites
            // is cited by the interpretation it explains (or, for the whole
            // comparison, by some interpretation), so no level changes it.
            for e in &x.evidence {
                let held = |i: &Interpretation| i.evidence.iter().any(|h| same_evidence(h, e));
                let known = match &x.about {
                    Some(about) => self
                        .interpretations
                        .iter()
                        .find(|i| &i.id == about)
                        .is_some_and(held),
                    None => self.interpretations.iter().any(held),
                };
                if !known {
                    at("`evidence` cites something no interpretation it explains cites; an explanation adds no evidence of its own".into());
                    break;
                }
            }
            check_provenance(
                &x.origin,
                x.approval.as_ref(),
                &x.digest(),
                published,
                &mut at,
            );
        }
        if published && self.interpretations.len() < 2 {
            problems.push(ComparisonProblem {
                file: file.to_string(),
                item: None,
                message: "a published comparison sets at least two interpretations side by side"
                    .into(),
            });
        }
    }
}

fn same_evidence(a: &EvidenceRef, b: &EvidenceRef) -> bool {
    match (a, b) {
        (EvidenceRef::Link { link: x, .. }, EvidenceRef::Link { link: y, .. }) => x == y,
        (
            EvidenceRef::Source {
                source: x,
                locator: lx,
                ..
            },
            EvidenceRef::Source {
                source: y,
                locator: ly,
                ..
            },
        ) => x == y && lx == ly,
        _ => false,
    }
}

fn check_evidence(evidence: &[EvidenceRef], at: &mut dyn FnMut(String)) {
    for (n, e) in evidence.iter().enumerate() {
        match e {
            EvidenceRef::Link { link, .. } => {
                if !valid_source_id(link) {
                    at(format!("`evidence[{n}].link` is not an evidence link id"));
                }
            }
            EvidenceRef::Source {
                source, locator, ..
            } => {
                if !valid_source_id(source) {
                    at(format!("`evidence[{n}].source` is not a source id"));
                }
                check_optional(locator.as_deref(), "evidence locator", MAX_SHORT_CHARS, at);
            }
        }
    }
}

/// An AI draft is labelled and needs approval to be published; an approval
/// must be complete, and in a published comparison must be for this text.
fn check_provenance(
    origin: &Origin,
    approval: Option<&Approval>,
    digest: &str,
    published: bool,
    at: &mut dyn FnMut(String),
) {
    if let Origin::AiDraft {
        tool, drafted_at, ..
    } = origin
    {
        check_required(tool, "origin.tool", MAX_SHORT_CHARS, false, at);
        if let Some(t) = drafted_at {
            check_time(t, "origin.draftedAt", at);
        }
    }
    if let Some(a) = approval {
        check_required(&a.by, "approval.by", MAX_SHORT_CHARS, false, at);
        check_time(&a.at, "approval.at", at);
        if published && a.digest != digest {
            at("`approval.digest` is not this text's: it changed after it was approved, so approve it again".into());
        }
    }
    if published && origin.is_ai() && approval.is_none() {
        at("an AI draft is published only after a person approves it: add an `approval`".into());
    }
}

/// How an item stands for publication.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Standing {
    /// Written by the author; nothing further needed.
    Authored,
    /// An AI draft with a person's approval of exactly this text.
    Approved,
    /// An AI draft nobody has approved.
    AwaitingApproval,
    /// An approval exists but the text changed after it.
    Stale,
}

impl Standing {
    pub fn publishable(self) -> bool {
        matches!(self, Self::Authored | Self::Approved)
    }

    fn withheld(self) -> WithheldReason {
        if self == Self::Stale {
            WithheldReason::StaleApproval
        } else {
            WithheldReason::AwaitingApproval
        }
    }
}

fn standing(origin: &Origin, approval: Option<&Approval>, digest: &str) -> Standing {
    match (origin.is_ai(), approval) {
        (false, _) => Standing::Authored,
        (true, None) => Standing::AwaitingApproval,
        (true, Some(a)) if a.digest == digest => Standing::Approved,
        (true, Some(_)) => Standing::Stale,
    }
}

// ---------------------------------------------------------------------------
// References the author already holds.
// ---------------------------------------------------------------------------

/// The ids a comparison may point at. For checking a draft this is every
/// source and evidence link; for projecting it is only those the build
/// publishes.
#[derive(Clone, Debug, Default)]
pub struct References {
    pub sources: BTreeSet<String>,
    pub evidence_links: BTreeSet<String>,
}

impl References {
    /// Every source record and evidence link the author holds, public or not.
    pub fn of(library: &SourceLibrary, claims: &ClaimSet) -> Self {
        Self {
            sources: library.sources.iter().map(|s| s.id.clone()).collect(),
            evidence_links: claims.links.iter().map(|l| l.id.clone()).collect(),
        }
    }

    fn has(&self, e: &EvidenceRef) -> bool {
        match e {
            EvidenceRef::Link { link, .. } => self.evidence_links.contains(link),
            EvidenceRef::Source { source, .. } => self.sources.contains(source),
        }
    }
}

impl Comparison {
    /// Reports every source, evidence link or attribution source that does
    /// not exist, each scoped to its item. Nothing is changed.
    pub fn check_references(&self, refs: &References) -> Vec<ComparisonProblem> {
        let mut out = Vec::new();
        let file = format!("{COMPARISONS_DIR}/{}.json", self.slug);
        let mut miss = |item: &str, what: &str| {
            out.push(ComparisonProblem {
                file: file.clone(),
                item: Some(item.to_string()),
                message: format!("{what} is not in the research library"),
            })
        };
        let evidence_name = |e: &EvidenceRef| match e {
            EvidenceRef::Link { .. } => "an `evidence` link",
            EvidenceRef::Source { .. } => "an `evidence` source",
        };
        for i in &self.interpretations {
            if let Attribution::Source { source, .. } = &i.attribution {
                if !refs.sources.contains(source) {
                    miss(&i.id, "`attribution.source`");
                }
            }
            for e in i.evidence.iter().filter(|e| !refs.has(e)) {
                miss(&i.id, evidence_name(e));
            }
        }
        for x in &self.explanations {
            for e in x.evidence.iter().filter(|e| !refs.has(e)) {
                miss(&x.id, evidence_name(e));
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// The one public value.
// ---------------------------------------------------------------------------

/// Why something was left out, for the author only. The public value never
/// says that anything was left out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WithheldReason {
    /// An AI draft nobody approved.
    AwaitingApproval,
    /// An AI draft edited after it was approved.
    StaleApproval,
    /// Its interpretation is withheld.
    SubjectWithheld,
    /// Evidence the build does not publish (dropped, the item kept).
    EvidenceNotPublic,
    /// Its attribution names a source record the build does not publish. An
    /// interpretation cannot be shown without saying who holds it, and the
    /// id of a private source is never written to a public value.
    AttributionNotPublic,
    /// The author withdrew it (ADR 0234).
    Withdrawn,
    /// The comparison is a draft.
    Draft,
    /// Fewer than two interpretations are public.
    TooFewInterpretations,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Withheld {
    pub id: String,
    pub reason: WithheldReason,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicInterpretation {
    pub id: String,
    pub attribution: PublicAttribution,
    pub statement: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation_of: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<PublicEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncertainty: Option<String>,
    pub provenance: PublicProvenance,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PublicAttribution {
    Named {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        certainty: Option<Certainty>,
    },
    Source {
        source: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        certainty: Option<Certainty>,
    },
    Anonymous {
        description: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        certainty: Option<Certainty>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum PublicEvidence {
    Link {
        link: String,
    },
    Source {
        source: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        locator: Option<String>,
    },
}

/// Who wrote the text, and for an AI draft that a person approved it. The
/// label a reader sees follows from this and is never softened.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "origin", rename_all = "kebab-case")]
pub enum PublicProvenance {
    Author,
    #[serde(rename_all = "camelCase")]
    AiDraft {
        tool: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicRelation {
    pub from: String,
    pub to: String,
    pub kind: RelationKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicExplanation {
    pub id: String,
    pub level: Level,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prerequisite: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub modes: Vec<ExplanationMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<PublicEvidence>,
    pub provenance: PublicProvenance,
}

/// A published comparison as readers see it. Explanations are supplemental
/// by construction: `supplemental` is always true and the value carries no
/// replacement for any prose.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicComparison {
    pub slug: String,
    pub title: String,
    pub subject: String,
    pub interpretations: Vec<PublicInterpretation>,
    pub relations: Vec<PublicRelation>,
    pub explanations: Vec<PublicExplanation>,
    pub supplemental: bool,
}

fn public_attribution(a: &Attribution) -> PublicAttribution {
    match a {
        Attribution::Named {
            name, certainty, ..
        } => PublicAttribution::Named {
            name: name.clone(),
            certainty: *certainty,
        },
        Attribution::Source {
            source, certainty, ..
        } => PublicAttribution::Source {
            source: source.clone(),
            certainty: *certainty,
        },
        Attribution::Anonymous {
            description,
            certainty,
            ..
        } => PublicAttribution::Anonymous {
            description: description.clone(),
            certainty: *certainty,
        },
    }
}

/// Names the tool and the fact of approval, never the account that gave it.
fn public_provenance(origin: &Origin) -> PublicProvenance {
    match origin {
        Origin::Author { .. } => PublicProvenance::Author,
        Origin::AiDraft { tool, .. } => PublicProvenance::AiDraft { tool: tool.clone() },
    }
}

fn public_evidence(
    evidence: &[EvidenceRef],
    refs: &References,
    id: &str,
    withheld: &mut Vec<Withheld>,
) -> Vec<PublicEvidence> {
    let mut out = Vec::new();
    let mut dropped = false;
    for e in evidence {
        if !refs.has(e) {
            dropped = true;
            continue;
        }
        out.push(match e {
            EvidenceRef::Link { link, .. } => PublicEvidence::Link { link: link.clone() },
            EvidenceRef::Source {
                source, locator, ..
            } => PublicEvidence::Source {
                source: source.clone(),
                locator: locator.clone(),
            },
        });
    }
    if dropped {
        withheld.push(Withheld {
            id: id.to_string(),
            reason: WithheldReason::EvidenceNotPublic,
        });
    }
    out
}

impl PublicComparison {
    /// Projects one comparison. `public` holds the sources and evidence
    /// links the build publishes; any other reference is dropped, never
    /// named. Returns `None` (with the reason for the author) for a draft or
    /// when fewer than two interpretations can be shown.
    pub fn project(comparison: &Comparison, public: &References) -> (Option<Self>, Vec<Withheld>) {
        let mut withheld = Vec::new();
        if comparison.status != Status::Published {
            withheld.push(Withheld {
                id: comparison.slug.clone(),
                reason: WithheldReason::Draft,
            });
            return (None, withheld);
        }
        // An attribution to a source the build does not publish would put a
        // private id in the public value, so that interpretation is withheld.
        let attribution_public = |i: &Interpretation| match &i.attribution {
            Attribution::Source { source, .. } => public.sources.contains(source),
            _ => true,
        };
        let shown: BTreeSet<&str> = comparison
            .interpretations
            .iter()
            .filter(|i| i.standing().publishable() && attribution_public(i))
            .map(|i| i.id.as_str())
            .collect();
        let mut interpretations = Vec::new();
        for i in &comparison.interpretations {
            let standing = i.standing();
            if !standing.publishable() {
                withheld.push(Withheld {
                    id: i.id.clone(),
                    reason: standing.withheld(),
                });
                continue;
            }
            if !attribution_public(i) {
                withheld.push(Withheld {
                    id: i.id.clone(),
                    reason: WithheldReason::AttributionNotPublic,
                });
                continue;
            }
            interpretations.push(PublicInterpretation {
                id: i.id.clone(),
                attribution: public_attribution(&i.attribution),
                statement: i.statement.clone(),
                language: i.language.clone(),
                // A translation keeps its pointer only while the original is shown.
                translation_of: i
                    .translation_of
                    .clone()
                    .filter(|of| shown.contains(of.as_str())),
                evidence: public_evidence(&i.evidence, public, &i.id, &mut withheld),
                uncertainty: i.uncertainty.clone(),
                provenance: public_provenance(&i.origin),
            });
        }
        if interpretations.len() < 2 {
            withheld.push(Withheld {
                id: comparison.slug.clone(),
                reason: WithheldReason::TooFewInterpretations,
            });
            return (None, withheld);
        }
        let relations = comparison
            .relations
            .iter()
            .filter(|r| shown.contains(r.from.as_str()) && shown.contains(r.to.as_str()))
            .map(|r| PublicRelation {
                from: r.from.clone(),
                to: r.to.clone(),
                kind: r.kind,
                note: r.note.clone(),
            })
            .collect();
        let mut explanations: Vec<PublicExplanation> = Vec::new();
        for x in &comparison.explanations {
            if x.about.as_deref().is_some_and(|a| !shown.contains(a)) {
                withheld.push(Withheld {
                    id: x.id.clone(),
                    reason: WithheldReason::SubjectWithheld,
                });
                continue;
            }
            if x.withdrawn.is_some() {
                withheld.push(Withheld {
                    id: x.id.clone(),
                    reason: WithheldReason::Withdrawn,
                });
                continue;
            }
            let standing = x.standing();
            if !standing.publishable() {
                withheld.push(Withheld {
                    id: x.id.clone(),
                    reason: standing.withheld(),
                });
                continue;
            }
            explanations.push(PublicExplanation {
                id: x.id.clone(),
                level: x.level,
                about: x.about.clone(),
                text: x.text.clone(),
                authors: x.authors.clone(),
                prerequisite: x.prerequisite.clone(),
                modes: x.modes.clone(),
                language: x.language.clone(),
                translation_of: x.translation_of.clone(),
                revision: x.revision,
                evidence: public_evidence(&x.evidence, public, &x.id, &mut withheld),
                provenance: public_provenance(&x.origin),
            });
        }
        // A translation keeps its pointer only while the original is shown.
        let shown_x: BTreeSet<String> = explanations.iter().map(|x| x.id.clone()).collect();
        for x in &mut explanations {
            if x.translation_of
                .as_ref()
                .is_some_and(|of| !shown_x.contains(of))
            {
                x.translation_of = None;
            }
        }
        // Readers are offered the whole-comparison explanations first, then
        // each interpretation's, levels always in the same order.
        explanations.sort_by(|a, b| {
            (a.about.is_some(), &a.about, a.level).cmp(&(b.about.is_some(), &b.about, b.level))
        });
        let projected = Self {
            slug: comparison.slug.clone(),
            title: comparison.title.clone(),
            subject: comparison.subject.clone(),
            interpretations,
            relations,
            explanations,
            supplemental: true,
        };
        (Some(projected), withheld)
    }

    /// Deterministic JSON: two-space indented with a final newline.
    pub fn to_json(&self) -> String {
        let mut text = serde_json::to_string_pretty(self).expect("a projection is serializable");
        text.push('\n');
        text
    }
}

/// Reads every `comparisons/*.json` among `files`. A file that fails is
/// reported and contributes nothing; the others are unaffected.
pub fn load_comparisons(
    files: &BTreeMap<String, String>,
) -> (Vec<Comparison>, Vec<ComparisonProblem>) {
    let mut ok = Vec::new();
    let mut problems = Vec::new();
    for (file, text) in files {
        if !file.starts_with("comparisons/") {
            continue;
        }
        match Comparison::parse(file, text) {
            Ok(c) => ok.push(c),
            Err(p) => problems.extend(p),
        }
    }
    (ok, problems)
}
