//! Private research notebook: quoted passages and author research notes that
//! point into the source library.
//!
//! Everything here is private author research. Nothing renders, publishes, or
//! contacts a service; validation is offline and structural, and it never
//! claims that a quotation is accurate, permitted, or authoritative.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::de::{Deserialize, Deserializer, Error as _};
use serde::ser::{Serialize, Serializer};
use serde_json::{Map, Value};

use crate::contributor::valid_registry_key;
use crate::source_library::{
    valid_language_tag, valid_source_id, valid_timestamp, ResearchSourceKind, SourceLibrary,
    LOCATION_SCHEMES,
};

/// The only notebook file version this release reads and writes.
pub const NOTEBOOK_VERSION: u64 = 1;
/// Upper bound on a serialized notebook, checked before JSON parsing and again
/// on the canonical written form.
pub const MAX_NOTEBOOK_BYTES: usize = 4 * 1024 * 1024;
/// Upper bound on passages, and separately on notes, in one notebook.
pub const MAX_ENTRIES: usize = 10_000;
/// Upper bound on the characters of one quoted excerpt or note body.
pub const MAX_BODY_CHARS: usize = 20_000;
const MAX_SHORT_CHARS: usize = 200;
const MAX_LOCATORS: usize = 8;
const MAX_LINKS: usize = 100;
const CREDIT_FIELDS: &[&str] = &["credit", "credits", "contributor", "contributors"];
/// Fields of reader feedback provenance (ADR 0078): a reader's name and when
/// feedback was seen or received never become research.
const READER_FEEDBACK_FIELDS: &[&str] = &["attribution", "receivedAt", "seenAt"];

const NOTEBOOK_FIELDS: &[&str] = &["version", "passages", "notes"];
const PASSAGE_FIELDS: &[&str] = &[
    "id",
    "source",
    "excerpt",
    "locators",
    "archived",
    "visibility",
];
const EXCERPT_FIELDS: &[&str] = &["text", "language"];
const LOCATOR_FIELDS: &[&str] = &["kind", "value", "to"];
const NOTE_FIELDS: &[&str] = &[
    "id",
    "kind",
    "text",
    "passages",
    "sources",
    "concepts",
    "status",
    "archived",
    "visibility",
];

/// Who may see an entry. There is exactly one value: this format has no
/// publication path, so making research public is a separate, explicit
/// projection that copies what it approves and never flips this field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Visibility {
    Private,
}

impl Serialize for Visibility {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str("private")
    }
}

/// What a research note is. Notes are the author's own prose, never a quotation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteKind {
    Observation,
    Question,
}

impl NoteKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "observation" => Some(Self::Observation),
            "question" => Some(Self::Question),
            _ => None,
        }
    }
}

/// Whether a question still needs an answer. Only questions have a state;
/// a question that never wrote one is open. Nothing here claims that a
/// resolved question was answered correctly: the author decides.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionState {
    Open,
    Resolved,
}

impl QuestionState {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "open" => Some(Self::Open),
            "resolved" => Some(Self::Resolved),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Resolved => "resolved",
        }
    }
}

/// The way a locator addresses a position. The known kinds mirror the source
/// library's location schemes; `x-` extension kinds keep the format open
/// without letting a typo pass as a new kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocatorKind {
    Page,
    Folio,
    Line,
    Section,
    Chapter,
    Canonical,
    Timestamp,
    /// A lowercase slug starting with `x-`, such as `x-stephanus`.
    Extension(String),
}

impl LocatorKind {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Page => "page",
            Self::Folio => "folio",
            Self::Line => "line",
            Self::Section => "section",
            Self::Chapter => "chapter",
            Self::Canonical => "canonical",
            Self::Timestamp => "timestamp",
            Self::Extension(name) => name,
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "page" => Self::Page,
            "folio" => Self::Folio,
            "line" => Self::Line,
            "section" => Self::Section,
            "chapter" => Self::Chapter,
            "canonical" => Self::Canonical,
            "timestamp" => Self::Timestamp,
            _ if value.len() > 2
                && value.len() <= 64
                && value.starts_with("x-")
                && valid_registry_key(value) =>
            {
                Self::Extension(value.into())
            }
            _ => return None,
        })
    }
}

impl Serialize for LocatorKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// Reads the same kinds [`LocatorKind::parse`] accepts, so stored forms that embed a locator
/// (media moments, ADR 0062) refuse an unknown kind exactly as the notebook does.
impl<'de> Deserialize<'de> for LocatorKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::parse(&text).ok_or_else(|| D::Error::custom("unknown locator kind"))
    }
}

/// One position inside a source, with an optional end for a range. A passage
/// holds several in order for compound locations such as folio 12r, lines 4-7.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Locator {
    pub kind: LocatorKind,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Locator {
    /// The locator as one stated value, `kind value` or `kind value to end`,
    /// without unknown fields: what a finding about it states.
    pub fn stated(&self) -> String {
        match &self.to {
            Some(to) => format!("{} {} to {to}", self.kind.as_str(), self.value),
            None => format!("{} {}", self.kind.as_str(), self.value),
        }
    }
}

/// Text copied from a source. It lives in its own object, apart from every
/// field of author prose, and is stored exactly as quoted: no normalization,
/// trimming, or markup interpretation. It is someone else's words.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct QuotedExcerpt {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// An excerpt of one source, with where in it the excerpt sits.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Passage {
    /// Immutable identity, unique across passages and notes.
    pub id: String,
    /// The source-library record the excerpt comes from. Never changes.
    pub source: String,
    pub excerpt: QuotedExcerpt,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locators: Vec<Locator>,
    /// Set aside by the author: kept, exported and searchable on request, but
    /// out of the way. Written only when true, and never a publication switch.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
    pub visibility: Visibility,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// An observation or question written by the author.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ResearchNote {
    /// Immutable identity, unique across passages and notes.
    pub id: String,
    pub kind: NoteKind,
    /// The author's prose. Quotation belongs in a passage, not here.
    pub text: String,
    /// Passages this note is about.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub passages: Vec<String>,
    /// Source-library records this note is about.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<String>,
    /// Concept identifiers: lowercase slugs checked for shape only, because
    /// no concept registry exists yet.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub concepts: Vec<String>,
    /// Only on a question, and only once the author has set it; absent means open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<QuestionState>,
    /// Set aside by the author; see [`Passage::archived`].
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
    pub visibility: Visibility,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl ResearchNote {
    /// `None` for an observation; for a question, its written state or open.
    pub fn question_state(&self) -> Option<QuestionState> {
        (self.kind == NoteKind::Question).then(|| self.status.unwrap_or(QuestionState::Open))
    }
}

/// The private notebook document.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Notebook {
    pub version: u64,
    pub passages: Vec<Passage>,
    pub notes: Vec<ResearchNote>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for Notebook {
    fn default() -> Self {
        Self {
            version: NOTEBOOK_VERSION,
            passages: Vec::new(),
            notes: Vec::new(),
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoteDiagnosticCode {
    TooLarge,
    InvalidJson,
    UnsupportedVersion,
    MissingField,
    InvalidField,
    InvalidId,
    DuplicateId,
    UnknownSource,
    UnknownPassage,
    UnknownLocatorKind,
    InvalidLocator,
    AmbiguousLocator,
    NotPrivate,
    ContributorCredit,
    ReaderFeedback,
    SourceChanged,
    StillLinked,
    UnknownEntry,
}

impl NoteDiagnosticCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::TooLarge => "too-large",
            Self::InvalidJson => "invalid-json",
            Self::UnsupportedVersion => "unsupported-version",
            Self::MissingField => "missing-field",
            Self::InvalidField => "invalid-field",
            Self::InvalidId => "invalid-id",
            Self::DuplicateId => "duplicate-id",
            Self::UnknownSource => "unknown-source",
            Self::UnknownPassage => "unknown-passage",
            Self::UnknownLocatorKind => "unknown-locator-kind",
            Self::InvalidLocator => "invalid-locator",
            Self::AmbiguousLocator => "ambiguous-locator",
            Self::NotPrivate => "not-private",
            Self::ContributorCredit => "contributor-credit",
            Self::ReaderFeedback => "reader-feedback",
            Self::SourceChanged => "source-changed",
            Self::StillLinked => "still-linked",
            Self::UnknownEntry => "unknown-entry",
        }
    }
}

impl fmt::Display for NoteDiagnosticCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A problem scoped to the notebook, one entry, or one field of an entry.
/// Messages never repeat quoted or noted text.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDiagnostic {
    pub code: NoteDiagnosticCode,
    /// `passages` or `notes` when the problem belongs to an entry.
    pub collection: Option<&'static str>,
    /// Zero-based position in the collection.
    pub index: Option<usize>,
    pub id: Option<String>,
    /// Field path inside the entry, such as `source` or `locators[1].value`.
    pub field: Option<String>,
    pub message: String,
}

impl fmt::Display for NoteDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (self.collection, self.index, &self.id) {
            (Some(collection), Some(index), Some(id)) => {
                write!(formatter, "{collection}[{index}] `{id}`")?
            }
            (Some(collection), Some(index), None) => write!(formatter, "{collection}[{index}]")?,
            (Some(collection), None, Some(id)) => write!(formatter, "{collection} `{id}`")?,
            _ => formatter.write_str("research notebook")?,
        }
        if let Some(field) = &self.field {
            write!(formatter, " {field}")?;
        }
        write!(formatter, ": {} ({})", self.message, self.code)
    }
}

fn notebook_diagnostic(
    code: NoteDiagnosticCode,
    field: Option<&str>,
    message: impl Into<String>,
) -> NoteDiagnostic {
    NoteDiagnostic {
        code,
        collection: None,
        index: None,
        id: None,
        field: field.map(str::to_string),
        message: message.into(),
    }
}

fn too_large() -> NoteDiagnostic {
    notebook_diagnostic(
        NoteDiagnosticCode::TooLarge,
        None,
        format!("the notebook is larger than {MAX_NOTEBOOK_BYTES} bytes as read or as written"),
    )
}

/// Field-by-field reader for one raw entry, so each problem names its field.
struct Reader<'a> {
    collection: &'static str,
    index: usize,
    id: Option<String>,
    fields: Map<String, Value>,
    diagnostics: &'a mut Vec<NoteDiagnostic>,
    failed: bool,
}

impl Reader<'_> {
    fn report(&mut self, code: NoteDiagnosticCode, field: &str, message: impl Into<String>) {
        self.failed = true;
        self.diagnostics.push(NoteDiagnostic {
            code,
            collection: Some(self.collection),
            index: Some(self.index),
            id: self.id.clone(),
            field: Some(field.into()),
            message: message.into(),
        });
    }

    /// Check authored or quoted text. `verbatim` keeps surrounding whitespace
    /// legal (quotations); line breaks are allowed only in multi-line fields.
    fn check_text(&mut self, field: &str, text: &str, max: usize, multiline: bool) {
        if text.trim().is_empty() {
            self.report(NoteDiagnosticCode::InvalidField, field, "must not be empty");
        } else if text.chars().count() > max {
            self.report(
                NoteDiagnosticCode::TooLarge,
                field,
                format!("must be at most {max} characters"),
            );
        } else if text.chars().any(|c| {
            (c.is_control() && !(multiline && (c == '\n' || c == '\t'))) || bidi_override(c)
        }) {
            self.report(
                NoteDiagnosticCode::InvalidField,
                field,
                if multiline {
                    "must use `\\n` line breaks and no other control or bidirectional override characters"
                } else {
                    "must not contain control or bidirectional override characters"
                },
            );
        }
    }

    fn text_in(
        &mut self,
        object: &mut Map<String, Value>,
        path: &str,
        key: &str,
        required: bool,
        max: usize,
        multiline: bool,
    ) -> Option<String> {
        let field = if path.is_empty() {
            key.to_string()
        } else {
            format!("{path}.{key}")
        };
        match object.remove(key) {
            Some(Value::String(text)) => {
                self.check_text(&field, &text, max, multiline);
                Some(text)
            }
            Some(_) => {
                self.report(NoteDiagnosticCode::InvalidField, &field, "must be a string");
                None
            }
            None if required => {
                self.report(NoteDiagnosticCode::MissingField, &field, "is required");
                None
            }
            None => None,
        }
    }

    fn take_object(&mut self, key: &str, required: bool) -> Option<Map<String, Value>> {
        match self.fields.remove(key) {
            Some(Value::Object(object)) => Some(object),
            Some(_) => {
                self.report(NoteDiagnosticCode::InvalidField, key, "must be an object");
                None
            }
            None if required => {
                self.report(NoteDiagnosticCode::MissingField, key, "is required");
                None
            }
            None => None,
        }
    }

    fn slug(&mut self, field: &str, value: &str, what: &str) -> bool {
        let ok = valid_source_id(value);
        if !ok {
            self.report(
                NoteDiagnosticCode::InvalidId,
                field,
                format!("not a {what}; use a lowercase ASCII slug of at most 64 bytes"),
            );
        }
        ok
    }

    fn take_id(&mut self, key: &str, what: &str, required: bool) -> Option<String> {
        match self.fields.remove(key) {
            Some(Value::String(value)) => self.slug(key, &value, what).then_some(value),
            Some(_) => {
                self.report(NoteDiagnosticCode::InvalidField, key, "must be a string");
                None
            }
            None if required => {
                self.report(NoteDiagnosticCode::MissingField, key, "is required");
                None
            }
            None => None,
        }
    }

    fn take_id_list(&mut self, key: &str, what: &str) -> Vec<String> {
        let Some(value) = self.fields.remove(key) else {
            return Vec::new();
        };
        let Value::Array(items) = value else {
            self.report(
                NoteDiagnosticCode::InvalidField,
                key,
                "must be an array of identifiers",
            );
            return Vec::new();
        };
        if items.len() > MAX_LINKS {
            self.report(
                NoteDiagnosticCode::TooLarge,
                key,
                format!("may hold at most {MAX_LINKS} links"),
            );
            return Vec::new();
        }
        let mut seen = BTreeSet::new();
        let mut ids = Vec::new();
        for (position, item) in items.into_iter().enumerate() {
            let field = format!("{key}[{position}]");
            match item {
                Value::String(id) if self.slug(&field, &id, what) => {
                    if seen.insert(id.clone()) {
                        ids.push(id);
                    } else {
                        self.report(NoteDiagnosticCode::DuplicateId, &field, "is already linked");
                    }
                }
                Value::String(_) => {}
                _ => self.report(NoteDiagnosticCode::InvalidField, &field, "must be a string"),
            }
        }
        ids
    }

    /// An optional boolean flag: absent is false, anything but a boolean is refused.
    fn flag(&mut self, name: &str) -> bool {
        match self.fields.remove(name) {
            None => false,
            Some(Value::Bool(value)) => value,
            Some(_) => {
                self.report(
                    NoteDiagnosticCode::InvalidField,
                    name,
                    "must be true or false",
                );
                false
            }
        }
    }

    fn visibility(&mut self) {
        match self.fields.remove("visibility") {
            None => {}
            Some(Value::String(value)) if value == "private" => {}
            Some(_) => self.report(
                NoteDiagnosticCode::NotPrivate,
                "visibility",
                "research entries are always private; this format has no publication path, and publishing needs an explicit projection that copies approved text",
            ),
        }
    }

    fn reject_credits(&mut self) {
        let found: Vec<String> = self
            .fields
            .keys()
            .filter(|key| CREDIT_FIELDS.contains(&key.as_str()))
            .cloned()
            .collect();
        for field in found {
            self.report(
                NoteDiagnosticCode::ContributorCredit,
                &field,
                "contributor credits stay in `.credits.json` sidecars; notes and passages are private research",
            );
        }
        let found: Vec<String> = self
            .fields
            .keys()
            .filter(|key| READER_FEEDBACK_FIELDS.contains(&key.as_str()))
            .cloned()
            .collect();
        for field in found {
            self.report(
                NoteDiagnosticCode::ReaderFeedback,
                &field,
                READER_FEEDBACK_MESSAGE,
            );
        }
    }
}

const READER_FEEDBACK_MESSAGE: &str =
    "reader feedback and its provenance stay out of the notebook; the notebook holds only the author's private research";

/// Unicode embedding, override, and isolate controls can reorder displayed
/// text invisibly. They are refused in every text field.
pub(crate) fn bidi_override(character: char) -> bool {
    matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

fn open_entry<'a>(
    collection: &'static str,
    index: usize,
    raw: Value,
    diagnostics: &'a mut Vec<NoteDiagnostic>,
) -> Option<Reader<'a>> {
    let Value::Object(fields) = raw else {
        diagnostics.push(NoteDiagnostic {
            code: NoteDiagnosticCode::InvalidField,
            collection: Some(collection),
            index: Some(index),
            id: None,
            field: None,
            message: "each entry must be a JSON object".into(),
        });
        return None;
    };
    let id = match fields.get("id") {
        Some(Value::String(id)) if valid_source_id(id) => Some(id.clone()),
        _ => None,
    };
    Some(Reader {
        collection,
        index,
        id,
        fields,
        diagnostics,
        failed: false,
    })
}

fn parse_passage(
    index: usize,
    raw: Value,
    diagnostics: &mut Vec<NoteDiagnostic>,
) -> (Option<String>, Option<Passage>) {
    let Some(mut reader) = open_entry("passages", index, raw, diagnostics) else {
        return (None, None);
    };
    let known_id = reader.id.clone();
    let id = reader.take_id("id", "passage identifier", true);
    reader.reject_credits();
    let source = reader.take_id("source", "source identifier", true);
    reader.visibility();
    let archived = reader.flag("archived");

    let excerpt = reader.take_object("excerpt", true).and_then(|mut object| {
        let text = reader.text_in(&mut object, "excerpt", "text", true, MAX_BODY_CHARS, true);
        let language = reader.text_in(&mut object, "excerpt", "language", false, 64, false);
        if language.as_deref().is_some_and(|l| !valid_language_tag(l)) {
            reader.report(
                NoteDiagnosticCode::InvalidField,
                "excerpt.language",
                "not a language tag such as `en` or `grc`",
            );
        }
        text.map(|text| QuotedExcerpt {
            text,
            language,
            extra: object.into_iter().collect(),
        })
    });

    let mut locators = Vec::new();
    if let Some(value) = reader.fields.remove("locators") {
        match value {
            Value::Array(items) if items.len() <= MAX_LOCATORS => {
                for (position, item) in items.into_iter().enumerate() {
                    if let Some(locator) = parse_locator(&mut reader, position, item) {
                        if locators.iter().any(|l: &Locator| {
                            l.kind == locator.kind && l.value == locator.value && l.to == locator.to
                        }) {
                            reader.report(
                                NoteDiagnosticCode::InvalidLocator,
                                &format!("locators[{position}]"),
                                "repeats an earlier locator",
                            );
                        }
                        locators.push(locator);
                    }
                }
            }
            Value::Array(_) => reader.report(
                NoteDiagnosticCode::TooLarge,
                "locators",
                format!("a passage may have at most {MAX_LOCATORS} locators"),
            ),
            _ => reader.report(
                NoteDiagnosticCode::InvalidField,
                "locators",
                "must be an array of objects",
            ),
        }
    }

    let failed = reader.failed;
    let extra: BTreeMap<String, Value> = std::mem::take(&mut reader.fields).into_iter().collect();
    match (id, source, excerpt, failed) {
        (Some(id), Some(source), Some(excerpt), false) => (
            Some(id.clone()),
            Some(Passage {
                id,
                source,
                excerpt,
                locators,
                archived,
                visibility: Visibility::Private,
                extra,
            }),
        ),
        (id, ..) => (id.or(known_id), None),
    }
}

fn parse_locator(reader: &mut Reader<'_>, position: usize, item: Value) -> Option<Locator> {
    let path = format!("locators[{position}]");
    let Value::Object(mut object) = item else {
        reader.report(NoteDiagnosticCode::InvalidField, &path, "must be an object");
        return None;
    };
    let kind_text = reader.text_in(&mut object, &path, "kind", true, 64, false);
    let value = reader.text_in(&mut object, &path, "value", true, MAX_SHORT_CHARS, false);
    let to = reader.text_in(&mut object, &path, "to", false, MAX_SHORT_CHARS, false);
    let kind = kind_text.as_deref().and_then(|text| {
        let kind = LocatorKind::parse(text);
        if kind.is_none() {
            reader.report(
                NoteDiagnosticCode::UnknownLocatorKind,
                &format!("{path}.kind"),
                format!(
                    "use one of: {}, or an extension kind such as `x-stephanus`",
                    LOCATION_SCHEMES.join(", ")
                ),
            );
        }
        kind
    })?;
    let value = value?;
    if kind == LocatorKind::Timestamp {
        for (key, text) in [("value", Some(&value)), ("to", to.as_ref())] {
            if text.is_some_and(|text| !valid_timestamp(text)) {
                reader.report(
                    NoteDiagnosticCode::InvalidLocator,
                    &format!("{path}.{key}"),
                    "use seconds or `h:mm:ss`, optionally with a decimal fraction",
                );
            }
        }
    }
    Some(Locator {
        kind,
        value,
        to,
        extra: object.into_iter().collect(),
    })
}

fn parse_note(
    index: usize,
    raw: Value,
    diagnostics: &mut Vec<NoteDiagnostic>,
) -> (Option<String>, Option<ResearchNote>) {
    let Some(mut reader) = open_entry("notes", index, raw, diagnostics) else {
        return (None, None);
    };
    let known_id = reader.id.clone();
    let id = reader.take_id("id", "note identifier", true);
    reader.reject_credits();
    reader.visibility();
    let archived = reader.flag("archived");
    let kind = match reader.fields.remove("kind") {
        Some(Value::String(text)) => {
            let kind = NoteKind::parse(&text);
            if kind.is_none() {
                reader.report(
                    NoteDiagnosticCode::InvalidField,
                    "kind",
                    "use `observation` or `question`",
                );
            }
            kind
        }
        Some(_) => {
            reader.report(NoteDiagnosticCode::InvalidField, "kind", "must be a string");
            None
        }
        None => {
            reader.report(
                NoteDiagnosticCode::MissingField,
                "kind",
                "add a kind: observation or question",
            );
            None
        }
    };
    let mut fields = std::mem::take(&mut reader.fields);
    let text = reader.text_in(&mut fields, "", "text", true, MAX_BODY_CHARS, true);
    reader.fields = fields;
    let passages = reader.take_id_list("passages", "passage identifier");
    let sources = reader.take_id_list("sources", "source identifier");
    let concepts = reader.take_id_list("concepts", "concept identifier");
    let status = match reader.fields.remove("status") {
        None => None,
        Some(Value::String(text)) => match (QuestionState::parse(&text), kind) {
            (Some(state), Some(NoteKind::Question)) => Some(state),
            (Some(_), Some(NoteKind::Observation)) => {
                reader.report(
                    NoteDiagnosticCode::InvalidField,
                    "status",
                    "only a question has a state; remove it or make the note a question",
                );
                None
            }
            (Some(_), None) => None,
            (None, _) => {
                reader.report(
                    NoteDiagnosticCode::InvalidField,
                    "status",
                    "use `open` or `resolved`",
                );
                None
            }
        },
        Some(_) => {
            reader.report(
                NoteDiagnosticCode::InvalidField,
                "status",
                "must be a string",
            );
            None
        }
    };

    let failed = reader.failed;
    let extra: BTreeMap<String, Value> = std::mem::take(&mut reader.fields).into_iter().collect();
    match (id, kind, text, failed) {
        (Some(id), Some(kind), Some(text), false) => (
            Some(id.clone()),
            Some(ResearchNote {
                id,
                kind,
                text,
                passages,
                sources,
                concepts,
                status,
                archived,
                visibility: Visibility::Private,
                extra,
            }),
        ),
        (id, ..) => (id.or(known_id), None),
    }
}

/// Why a locator cannot address the source it is attached to, if it cannot.
/// Shared by notebook passages and citations so both refuse the same
/// ambiguous page and folio locators.
pub(crate) fn locator_ambiguity(
    target: Option<ResearchSourceKind>,
    source: &str,
    locator: &Locator,
) -> Option<String> {
    match locator.kind {
        LocatorKind::Page if target == Some(ResearchSourceKind::Work) => Some(format!(
            "pages differ between editions of a work; point the passage at the edition, translation, or witness whose pages are cited, not `{source}`"
        )),
        LocatorKind::Folio if target != Some(ResearchSourceKind::Witness) => Some(format!(
            "folios belong to one manuscript or copy; point the passage at a witness, not `{source}`"
        )),
        _ => None,
    }
}

/// The kind of source record a locator is checked against: a reference stands
/// for the edition, translation, witness, or work it points at.
pub(crate) fn resolved_kind(library: &SourceLibrary, id: &str) -> Option<ResearchSourceKind> {
    let mut record = library.get(id)?;
    for _ in 0..4 {
        if record.kind != ResearchSourceKind::Reference {
            return Some(record.kind);
        }
        record = library.get(record.of.as_deref()?)?;
    }
    Some(record.kind)
}

fn entry_diagnostic(
    code: NoteDiagnosticCode,
    collection: &'static str,
    index: usize,
    id: &str,
    field: &str,
    message: impl Into<String>,
) -> NoteDiagnostic {
    NoteDiagnostic {
        code,
        collection: Some(collection),
        index: Some(index),
        id: Some(id.into()),
        field: Some(field.into()),
        message: message.into(),
    }
}

impl Passage {
    /// Read one passage from a request body with the same rules as a stored
    /// notebook. Diagnostics are scoped to the entry and carry no position;
    /// whether the source resolves is decided when the notebook changes.
    pub fn from_json(raw: Value) -> Result<Self, Vec<NoteDiagnostic>> {
        let mut diagnostics = Vec::new();
        let (_, passage) = parse_passage(0, raw, &mut diagnostics);
        entry_result(passage, diagnostics)
    }
}

impl ResearchNote {
    /// Read one note from a request body with the same rules as a stored
    /// notebook. See [`Passage::from_json`].
    pub fn from_json(raw: Value) -> Result<Self, Vec<NoteDiagnostic>> {
        let mut diagnostics = Vec::new();
        let (_, note) = parse_note(0, raw, &mut diagnostics);
        entry_result(note, diagnostics)
    }
}

fn entry_result<T>(
    entry: Option<T>,
    mut diagnostics: Vec<NoteDiagnostic>,
) -> Result<T, Vec<NoteDiagnostic>> {
    for diagnostic in &mut diagnostics {
        diagnostic.index = None;
    }
    match entry {
        Some(entry) if diagnostics.is_empty() => Ok(entry),
        _ => Err(diagnostics),
    }
}

impl Notebook {
    /// Parse and validate a serialized notebook against the source library it
    /// points into. Every problem is returned at once, scoped as narrowly as
    /// possible; nothing is partially accepted.
    pub fn parse(text: &str, library: &SourceLibrary) -> Result<Self, Vec<NoteDiagnostic>> {
        if text.len() > MAX_NOTEBOOK_BYTES {
            return Err(vec![too_large()]);
        }
        // Editors on Windows may save a byte-order mark, which is not JSON.
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        match serde_json::from_str(text) {
            Ok(value) => Self::from_value(value, library),
            Err(error) => Err(vec![notebook_diagnostic(
                NoteDiagnosticCode::InvalidJson,
                None,
                format!("invalid JSON: {error}"),
            )]),
        }
    }

    fn from_value(value: Value, library: &SourceLibrary) -> Result<Self, Vec<NoteDiagnostic>> {
        let fail = |code, field: &str, message: String| {
            Err(vec![notebook_diagnostic(code, Some(field), message)])
        };
        let Value::Object(mut root) = value else {
            return fail(
                NoteDiagnosticCode::InvalidField,
                "",
                "the notebook must be a JSON object".into(),
            );
        };
        match root.remove("version") {
            Some(Value::Number(n)) if n.as_u64() == Some(NOTEBOOK_VERSION) => {}
            Some(Value::Number(n)) if n.as_u64().is_some_and(|v| v > NOTEBOOK_VERSION) => {
                return fail(
                    NoteDiagnosticCode::UnsupportedVersion,
                    "version",
                    format!("notebook version {n} was written by a newer open.blog; upgrade before editing so newer data is not lost"),
                );
            }
            Some(_) => {
                return fail(
                    NoteDiagnosticCode::UnsupportedVersion,
                    "version",
                    format!("version must be {NOTEBOOK_VERSION}"),
                )
            }
            None => {
                return fail(
                    NoteDiagnosticCode::MissingField,
                    "version",
                    format!("add `\"version\": {NOTEBOOK_VERSION}`"),
                )
            }
        }
        let mut take_array = |key: &str| match root.remove(key) {
            Some(Value::Array(items)) if items.len() > MAX_ENTRIES => {
                Err(vec![notebook_diagnostic(
                    NoteDiagnosticCode::TooLarge,
                    Some(key),
                    format!("a notebook may hold at most {MAX_ENTRIES} {key}"),
                )])
            }
            Some(Value::Array(items)) => Ok(items),
            Some(_) => Err(vec![notebook_diagnostic(
                NoteDiagnosticCode::InvalidField,
                Some(key),
                "must be a JSON array",
            )]),
            None => Ok(Vec::new()),
        };
        let raw_passages = take_array("passages")?;
        let raw_notes = take_array("notes")?;

        let mut diagnostics = Vec::new();
        for key in root.keys().filter(|k| CREDIT_FIELDS.contains(&k.as_str())) {
            diagnostics.push(notebook_diagnostic(
                NoteDiagnosticCode::ContributorCredit,
                Some(key),
                "contributor credits stay in `.credits.json` sidecars",
            ));
        }
        for key in root
            .keys()
            .filter(|k| READER_FEEDBACK_FIELDS.contains(&k.as_str()))
        {
            diagnostics.push(notebook_diagnostic(
                NoteDiagnosticCode::ReaderFeedback,
                Some(key),
                READER_FEEDBACK_MESSAGE,
            ));
        }
        let mut passages = Vec::new();
        let mut notes = Vec::new();
        let mut identities: Vec<(&'static str, usize, String)> = Vec::new();
        for (index, raw) in raw_passages.into_iter().enumerate() {
            let (id, passage) = parse_passage(index, raw, &mut diagnostics);
            identities.extend(id.map(|id| ("passages", index, id)));
            passages.extend(passage.map(|p| (index, p)));
        }
        for (index, raw) in raw_notes.into_iter().enumerate() {
            let (id, note) = parse_note(index, raw, &mut diagnostics);
            identities.extend(id.map(|id| ("notes", index, id)));
            notes.extend(note.map(|n| (index, n)));
        }
        check_relationships(&identities, &passages, &notes, library, &mut diagnostics);
        if !diagnostics.is_empty() {
            return Err(diagnostics);
        }
        let notebook = Self {
            version: NOTEBOOK_VERSION,
            passages: passages.into_iter().map(|(_, p)| p).collect(),
            notes: notes.into_iter().map(|(_, n)| n).collect(),
            extra: root.into_iter().collect(),
        };
        if notebook.written_len() > MAX_NOTEBOOK_BYTES {
            return Err(vec![too_large()]);
        }
        Ok(notebook)
    }

    pub fn passage(&self, id: &str) -> Option<&Passage> {
        self.passages.iter().find(|passage| passage.id == id)
    }

    pub fn note(&self, id: &str) -> Option<&ResearchNote> {
        self.notes.iter().find(|note| note.id == id)
    }

    /// Passages and notes that point at this source-library record, so a
    /// caller can refuse to remove a source that research still uses.
    pub fn entries_using_source(&self, source: &str) -> Vec<String> {
        let passages = self.passages.iter().filter(|p| p.source == source);
        let notes = self
            .notes
            .iter()
            .filter(|n| n.sources.iter().any(|s| s == source));
        passages
            .map(|p| p.id.clone())
            .chain(notes.map(|n| n.id.clone()))
            .collect()
    }

    /// Deterministic, pretty-printed JSON with a trailing newline.
    pub fn to_json(&self) -> String {
        let mut text = serde_json::to_string_pretty(self).unwrap_or_default();
        text.push('\n');
        text
    }

    fn written_len(&self) -> usize {
        let mut counter = ByteCounter(1);
        match serde_json::to_writer_pretty(&mut counter, self) {
            Ok(()) => counter.0,
            Err(_) => usize::MAX,
        }
    }

    /// Validate an edited copy the same way a file is read.
    fn validated(candidate: &Self, library: &SourceLibrary) -> Result<Self, Vec<NoteDiagnostic>> {
        let shadowed = shadowed_fields(candidate);
        if !shadowed.is_empty() {
            return Err(shadowed);
        }
        match serde_json::to_value(candidate) {
            Ok(value) => Self::from_value(value, library),
            Err(error) => Err(vec![notebook_diagnostic(
                NoteDiagnosticCode::InvalidJson,
                None,
                format!("the notebook could not be serialized: {error}"),
            )]),
        }
    }

    /// Add a passage, or replace the passage with the same identifier in
    /// place. A passage keeps its source for life: quoting a different source
    /// is a new passage. The notebook changes only when the whole result is
    /// valid.
    pub fn upsert_passage(
        &mut self,
        passage: Passage,
        library: &SourceLibrary,
    ) -> Result<(), Vec<NoteDiagnostic>> {
        let mut candidate = self.clone();
        match candidate.passages.iter().position(|p| p.id == passage.id) {
            Some(index) => {
                if candidate.passages[index].source != passage.source {
                    return Err(vec![entry_diagnostic(
                        NoteDiagnosticCode::SourceChanged,
                        "passages",
                        index,
                        &passage.id,
                        "source",
                        "a passage keeps the source it was quoted from; record the quotation from another source as a new passage",
                    )]);
                }
                candidate.passages[index] = passage;
            }
            None => candidate.passages.push(passage),
        }
        *self = Self::validated(&candidate, library)?;
        Ok(())
    }

    /// Add a note, or replace the note with the same identifier in place.
    pub fn upsert_note(
        &mut self,
        note: ResearchNote,
        library: &SourceLibrary,
    ) -> Result<(), Vec<NoteDiagnostic>> {
        let mut candidate = self.clone();
        match candidate.notes.iter().position(|n| n.id == note.id) {
            Some(index) => candidate.notes[index] = note,
            None => candidate.notes.push(note),
        }
        *self = Self::validated(&candidate, library)?;
        Ok(())
    }

    /// Remove a passage. Refused, leaving the notebook unchanged, while a
    /// note still links to it.
    pub fn remove_passage(
        &mut self,
        id: &str,
        library: &SourceLibrary,
    ) -> Result<Passage, Vec<NoteDiagnostic>> {
        let Some(index) = self.passages.iter().position(|p| p.id == id) else {
            return Err(vec![unknown_entry("passages", id)]);
        };
        let linked: Vec<_> = self
            .notes
            .iter()
            .enumerate()
            .filter(|(_, note)| note.passages.iter().any(|p| p == id))
            .map(|(position, note)| {
                entry_diagnostic(
                    NoteDiagnosticCode::StillLinked,
                    "notes",
                    position,
                    &note.id,
                    "passages",
                    format!("this note still links to the passage `{id}`"),
                )
            })
            .collect();
        if !linked.is_empty() {
            return Err(linked);
        }
        let mut candidate = self.clone();
        let removed = candidate.passages.remove(index);
        *self = Self::validated(&candidate, library)
            .map_err(|diagnostics| unshift("passages", index, diagnostics))?;
        Ok(removed)
    }

    /// Remove a note.
    pub fn remove_note(
        &mut self,
        id: &str,
        library: &SourceLibrary,
    ) -> Result<ResearchNote, Vec<NoteDiagnostic>> {
        let Some(index) = self.notes.iter().position(|n| n.id == id) else {
            return Err(vec![unknown_entry("notes", id)]);
        };
        let mut candidate = self.clone();
        let removed = candidate.notes.remove(index);
        *self = Self::validated(&candidate, library)
            .map_err(|diagnostics| unshift("notes", index, diagnostics))?;
        Ok(removed)
    }
}

/// Report positions in the notebook the caller holds, which still contains
/// the entry that was to be removed.
fn unshift(
    collection: &'static str,
    removed: usize,
    mut diagnostics: Vec<NoteDiagnostic>,
) -> Vec<NoteDiagnostic> {
    for diagnostic in diagnostics
        .iter_mut()
        .filter(|d| d.collection == Some(collection))
    {
        if let Some(position) = diagnostic.index.as_mut() {
            if *position >= removed {
                *position += 1;
            }
        }
    }
    diagnostics
}

fn unknown_entry(collection: &'static str, id: &str) -> NoteDiagnostic {
    NoteDiagnostic {
        code: NoteDiagnosticCode::UnknownEntry,
        collection: Some(collection),
        index: None,
        id: Some(id.into()),
        field: None,
        message: format!("no entry has the id `{id}`"),
    }
}

fn check_relationships(
    identities: &[(&'static str, usize, String)],
    passages: &[(usize, Passage)],
    notes: &[(usize, ResearchNote)],
    library: &SourceLibrary,
    diagnostics: &mut Vec<NoteDiagnostic>,
) {
    let mut first: BTreeMap<&str, (&'static str, usize)> = BTreeMap::new();
    for (collection, index, id) in identities {
        if let Some((other, position)) = first.get(id.as_str()) {
            diagnostics.push(entry_diagnostic(
                NoteDiagnosticCode::DuplicateId,
                collection,
                *index,
                id,
                "id",
                format!("`{id}` is already used by {other}[{position}]; passages and notes share one identifier space"),
            ));
        } else {
            first.insert(id, (collection, *index));
        }
    }
    let passage_ids: BTreeSet<&str> = identities
        .iter()
        .filter(|(collection, ..)| *collection == "passages")
        .map(|(_, _, id)| id.as_str())
        .collect();

    for (index, passage) in passages {
        if first.get(passage.id.as_str()) != Some(&("passages", *index)) {
            continue;
        }
        let report = |code, field: &str, message: String| {
            entry_diagnostic(code, "passages", *index, &passage.id, field, message)
        };
        let Some(_) = library.get(&passage.source) else {
            diagnostics.push(report(
                NoteDiagnosticCode::UnknownSource,
                "source",
                format!("no source in the library has the id `{}`", passage.source),
            ));
            continue;
        };
        let target = resolved_kind(library, &passage.source);
        for (position, locator) in passage.locators.iter().enumerate() {
            let field = format!("locators[{position}].kind");
            let message = locator_ambiguity(target, &passage.source, locator);
            if let Some(message) = message {
                diagnostics.push(report(
                    NoteDiagnosticCode::AmbiguousLocator,
                    &field,
                    message,
                ));
            }
        }
    }

    for (index, note) in notes {
        if first.get(note.id.as_str()) != Some(&("notes", *index)) {
            continue;
        }
        for (position, id) in note.passages.iter().enumerate() {
            if !passage_ids.contains(id.as_str()) {
                diagnostics.push(entry_diagnostic(
                    NoteDiagnosticCode::UnknownPassage,
                    "notes",
                    *index,
                    &note.id,
                    &format!("passages[{position}]"),
                    format!("no passage has the id `{id}`"),
                ));
            }
        }
        for (position, id) in note.sources.iter().enumerate() {
            if library.get(id).is_none() {
                diagnostics.push(entry_diagnostic(
                    NoteDiagnosticCode::UnknownSource,
                    "notes",
                    *index,
                    &note.id,
                    &format!("sources[{position}]"),
                    format!("no source in the library has the id `{id}`"),
                ));
            }
        }
    }
}

/// Unknown fields that collide with a defined field would be written twice
/// and replace the typed value on the next read, so such an edit is refused.
fn shadowed_fields(notebook: &Notebook) -> Vec<NoteDiagnostic> {
    let mut diagnostics = Vec::new();
    let message = "an unknown field cannot shadow a defined field";
    for key in notebook
        .extra
        .keys()
        .filter(|k| NOTEBOOK_FIELDS.contains(&k.as_str()))
    {
        diagnostics.push(notebook_diagnostic(
            NoteDiagnosticCode::InvalidField,
            Some(key),
            message,
        ));
    }
    let mut check = |collection,
                     index,
                     id: &str,
                     extra: &BTreeMap<String, Value>,
                     defined: &[&str],
                     prefix: &str| {
        for key in extra.keys().filter(|k| defined.contains(&k.as_str())) {
            let field = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            diagnostics.push(entry_diagnostic(
                NoteDiagnosticCode::InvalidField,
                collection,
                index,
                id,
                &field,
                message,
            ));
        }
    };
    for (index, passage) in notebook.passages.iter().enumerate() {
        check(
            "passages",
            index,
            &passage.id,
            &passage.extra,
            PASSAGE_FIELDS,
            "",
        );
        check(
            "passages",
            index,
            &passage.id,
            &passage.excerpt.extra,
            EXCERPT_FIELDS,
            "excerpt",
        );
        for (position, locator) in passage.locators.iter().enumerate() {
            check(
                "passages",
                index,
                &passage.id,
                &locator.extra,
                LOCATOR_FIELDS,
                &format!("locators[{position}]"),
            );
        }
    }
    for (index, note) in notebook.notes.iter().enumerate() {
        check("notes", index, &note.id, &note.extra, NOTE_FIELDS, "");
    }
    diagnostics
}

struct ByteCounter(usize);

impl std::io::Write for ByteCounter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(buf.len());
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn library() -> SourceLibrary {
        let text = json!({"version": 1, "sources": [
            {"id": "plato-republic", "kind": "work", "title": "Politeia"},
            {"id": "republic-slings", "kind": "edition", "of": "plato-republic", "title": "Platonis Rempublicam"},
            {"id": "paris-gr-1807", "kind": "witness", "of": "plato-republic", "title": "Paris gr. 1807"},
            {"id": "cave", "kind": "reference", "of": "paris-gr-1807"},
            {"id": "old-archived", "kind": "edition", "of": "plato-republic", "title": "Old", "archived": true}
        ]})
        .to_string();
        SourceLibrary::parse(&text, &BTreeMap::new()).expect("library")
    }

    fn parse(value: Value) -> Result<Notebook, Vec<NoteDiagnostic>> {
        Notebook::parse(&value.to_string(), &library())
    }

    fn sample() -> Value {
        json!({"version": 1,
            "passages": [{"id": "p-cave", "source": "republic-slings",
                "excerpt": {"text": "ὁ δὲ Σωκράτης — “naïve” 🙂", "language": "grc"},
                "locators": [
                    {"kind": "page", "value": "514"},
                    {"kind": "canonical", "value": "514a", "to": "520a"},
                    {"kind": "x-stephanus", "value": "514a"}]}],
            "notes": [{"id": "n-1", "kind": "question", "text": "Why a cave?",
                "passages": ["p-cave"], "sources": ["plato-republic"], "concepts": ["allegory"]}]})
    }

    fn codes(result: Result<Notebook, Vec<NoteDiagnostic>>) -> Vec<NoteDiagnosticCode> {
        result
            .expect_err("expected failure")
            .iter()
            .map(|d| d.code)
            .collect()
    }

    #[test]
    fn removal_diagnostics_name_the_entry_in_the_callers_notebook() {
        let full = SourceLibrary::parse(
            &json!({"version": 1, "sources": [
                {"id": "a", "kind": "work", "title": "A"},
                {"id": "b", "kind": "work", "title": "B"}]})
            .to_string(),
            &BTreeMap::new(),
        )
        .expect("library");
        let without_b = SourceLibrary::parse(
            &json!({"version": 1, "sources": [{"id": "a", "kind": "work", "title": "A"}]})
                .to_string(),
            &BTreeMap::new(),
        )
        .expect("library");
        let text = json!({"version": 1, "notes": [
            {"id": "n0", "kind": "question", "text": "zero", "sources": ["a"]},
            {"id": "n1", "kind": "question", "text": "one", "sources": ["a"]},
            {"id": "n2", "kind": "question", "text": "two", "sources": ["b"]}]})
        .to_string();
        let mut notebook = Notebook::parse(&text, &full).expect("valid");
        let diagnostics = notebook
            .remove_note("n0", &without_b)
            .expect_err("b is gone");
        assert_eq!(diagnostics[0].collection, Some("notes"));
        assert_eq!(diagnostics[0].index, Some(2));
        assert_eq!(diagnostics[0].id.as_deref(), Some("n2"));
        assert_eq!(notebook.notes.len(), 3);
    }

    #[test]
    fn single_entries_read_with_the_stored_rules_and_unscoped_positions() {
        let passage = Passage::from_json(sample()["passages"][0].clone()).expect("passage");
        assert_eq!(passage.id, "p-cave");
        assert_eq!(passage.visibility, Visibility::Private);
        let note = ResearchNote::from_json(sample()["notes"][0].clone()).expect("note");
        assert_eq!(note.passages, vec!["p-cave".to_string()]);
        let mut hostile = sample()["notes"][0].clone();
        hostile["visibility"] = json!("public");
        hostile["text"] = json!("a\u{202e}b");
        let found = ResearchNote::from_json(hostile).expect_err("refused");
        assert!(found.len() >= 2 && found.iter().all(|d| d.index.is_none()));
        assert!(Passage::from_json(json!("text")).is_err());
        assert!(Passage::from_json(json!({"id": "p"})).is_err());
    }

    #[test]
    fn round_trips_compound_locators_and_unicode_verbatim() {
        let notebook = parse(sample()).expect("valid");
        assert_eq!(
            notebook.passages[0].excerpt.text,
            "ὁ δὲ Σωκράτης — “naïve” 🙂"
        );
        assert_eq!(notebook.passages[0].locators.len(), 3);
        assert_eq!(
            notebook.passages[0].locators[2].kind,
            LocatorKind::Extension("x-stephanus".into())
        );
        let text = notebook.to_json();
        assert!(text.ends_with('\n'));
        let again = Notebook::parse(&text, &library()).expect("re-read");
        assert_eq!(again, notebook);
        assert_eq!(again.to_json(), text);
        assert!(text.contains("\"visibility\": \"private\""));
    }

    #[test]
    fn serialization_is_stable_and_preserves_unknown_fields() {
        let mut value = sample();
        value["zeta"] = json!({"b": 1, "a": [2]});
        value["passages"][0]["note-from-tool"] = json!("keep");
        value["passages"][0]["excerpt"]["scan"] = json!("p1.png");
        value["passages"][0]["locators"][0]["hint"] = json!(true);
        value["notes"][0]["colour"] = json!("red");
        let first = parse(value).expect("valid").to_json();
        let second = Notebook::parse(&first, &library())
            .expect("re-read")
            .to_json();
        assert_eq!(first, second);
        for kept in ["zeta", "note-from-tool", "scan", "hint", "colour"] {
            assert!(first.contains(kept), "{kept}");
        }
    }

    #[test]
    fn notes_default_to_private_and_cannot_be_made_public() {
        let mut value = sample();
        value["notes"][0]["visibility"] = json!("public");
        let diagnostics = parse(value).expect_err("public refused");
        assert_eq!(diagnostics[0].code, NoteDiagnosticCode::NotPrivate);
        assert_eq!(diagnostics[0].collection, Some("notes"));
        let mut value = sample();
        value["passages"][0]["visibility"] = json!("shared");
        assert_eq!(codes(parse(value)), vec![NoteDiagnosticCode::NotPrivate]);
        let mut value = sample();
        value["notes"][0]["visibility"] = json!("private");
        assert!(parse(value).is_ok());
        // Absent visibility reads as private and is written explicitly.
        let notebook = parse(sample()).expect("valid");
        assert_eq!(notebook.notes[0].visibility, Visibility::Private);
    }

    #[test]
    fn quoted_text_is_separate_from_author_prose() {
        let notebook = parse(sample()).expect("valid");
        let value: Value = serde_json::from_str(&notebook.to_json()).expect("json");
        assert!(value["passages"][0]["excerpt"]["text"].is_string());
        assert!(value["passages"][0].get("text").is_none());
        // A passage cannot smuggle prose beside the excerpt as a typed field
        // and an excerpt object is required.
        let mut value = sample();
        value["passages"][0]["excerpt"] = json!("a bare string");
        assert_eq!(codes(parse(value)), vec![NoteDiagnosticCode::InvalidField]);
        let mut value = sample();
        value["passages"][0]
            .as_object_mut()
            .unwrap()
            .remove("excerpt");
        assert_eq!(codes(parse(value)), vec![NoteDiagnosticCode::MissingField]);
    }

    #[test]
    fn missing_sources_are_scoped_and_archived_sources_resolve() {
        let mut value = sample();
        value["passages"][0]["source"] = json!("nope");
        value["notes"][0]["sources"] = json!(["plato-republic", "ghost"]);
        let diagnostics = parse(value).expect_err("missing");
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[0].collection, Some("passages"));
        assert_eq!(diagnostics[0].field.as_deref(), Some("source"));
        assert_eq!(diagnostics[1].field.as_deref(), Some("sources[1]"));
        assert!(!diagnostics[0].to_string().contains("ὁ"));
        let mut value = sample();
        value["passages"][0]["source"] = json!("old-archived");
        assert!(parse(value).is_ok());
    }

    #[test]
    fn locators_are_checked_against_the_source_they_address() {
        let mut value = sample();
        value["passages"][0]["source"] = json!("plato-republic");
        assert_eq!(
            codes(parse(value)),
            vec![NoteDiagnosticCode::AmbiguousLocator]
        );
        let mut value = sample();
        value["passages"][0]["locators"] = json!([{"kind": "folio", "value": "12r"}]);
        assert_eq!(
            codes(parse(value)),
            vec![NoteDiagnosticCode::AmbiguousLocator]
        );
        // A reference to a witness resolves through to the witness.
        let mut value = sample();
        value["passages"][0]["source"] = json!("cave");
        value["passages"][0]["locators"] =
            json!([{"kind": "folio", "value": "12r"}, {"kind": "line", "value": "4", "to": "7"}]);
        assert!(parse(value).is_ok());
        let mut value = sample();
        value["passages"][0]["locators"] = json!([{"kind": "pagee", "value": "1"}]);
        assert_eq!(
            codes(parse(value)),
            vec![NoteDiagnosticCode::UnknownLocatorKind]
        );
        let mut value = sample();
        value["passages"][0]["locators"] = json!([{"kind": "timestamp", "value": "1:5"}]);
        assert_eq!(
            codes(parse(value)),
            vec![NoteDiagnosticCode::InvalidLocator]
        );
        let mut value = sample();
        value["passages"][0]["locators"] = json!([{"kind": "x-", "value": "1"}]);
        assert_eq!(
            codes(parse(value)),
            vec![NoteDiagnosticCode::UnknownLocatorKind]
        );
        let mut value = sample();
        value["passages"][0]["locators"] =
            json!([{"kind": "line", "value": "1"}, {"kind": "line", "value": "1"}]);
        assert_eq!(
            codes(parse(value)),
            vec![NoteDiagnosticCode::InvalidLocator]
        );
    }

    #[test]
    fn hostile_text_is_refused_without_echoing_it() {
        for bad in ["a\u{202e}b", "nul\u{0}", "a\r\nb", "   "] {
            let mut value = sample();
            value["passages"][0]["excerpt"]["text"] = json!(bad);
            let diagnostics = parse(value).expect_err(bad);
            assert_eq!(diagnostics[0].field.as_deref(), Some("excerpt.text"));
            assert!(!diagnostics[0].message.contains("nul"));
        }
        let mut value = sample();
        value["notes"][0]["text"] = json!("x".repeat(MAX_BODY_CHARS + 1));
        assert_eq!(codes(parse(value)), vec![NoteDiagnosticCode::TooLarge]);
        let mut value = sample();
        value["notes"][0]["text"] = json!("line one\nline two\ttabbed");
        assert!(parse(value).is_ok());
        let mut value = sample();
        value["notes"][0]["sources"] = json!(["../../etc/passwd"]);
        assert_eq!(codes(parse(value)), vec![NoteDiagnosticCode::InvalidId]);
        let oversized = format!(
            "{{\"version\":1,\"pad\":\"{}\"}}",
            "a".repeat(MAX_NOTEBOOK_BYTES)
        );
        assert_eq!(
            Notebook::parse(&oversized, &library()).unwrap_err()[0].code,
            NoteDiagnosticCode::TooLarge
        );
    }

    #[test]
    fn versions_and_shapes_are_checked() {
        assert_eq!(
            codes(parse(json!({"version": 2, "passages": []}))),
            vec![NoteDiagnosticCode::UnsupportedVersion]
        );
        assert_eq!(
            codes(parse(json!({"version": 0}))),
            vec![NoteDiagnosticCode::UnsupportedVersion]
        );
        assert_eq!(
            codes(parse(json!({"passages": []}))),
            vec![NoteDiagnosticCode::MissingField]
        );
        assert_eq!(
            Notebook::parse("{not json", &library()).unwrap_err()[0].code,
            NoteDiagnosticCode::InvalidJson
        );
        let empty = parse(json!({"version": 1})).expect("empty notebook");
        assert_eq!(empty, Notebook::default());
        let bom = format!("\u{feff}{}", empty.to_json());
        assert!(Notebook::parse(&bom, &library()).is_ok());
    }

    #[test]
    fn identifiers_are_unique_across_passages_and_notes() {
        let mut value = sample();
        value["notes"][0]["id"] = json!("p-cave");
        let diagnostics = parse(value).expect_err("duplicate");
        assert_eq!(diagnostics[0].code, NoteDiagnosticCode::DuplicateId);
        assert_eq!(diagnostics[0].collection, Some("notes"));
        let mut value = sample();
        value["notes"][0]["passages"] = json!(["missing-passage"]);
        assert_eq!(
            codes(parse(value)),
            vec![NoteDiagnosticCode::UnknownPassage]
        );
    }

    #[test]
    fn credits_stay_out_of_research_entries() {
        let mut value = sample();
        value["notes"][0]["contributors"] = json!(["ada"]);
        assert_eq!(
            codes(parse(value)),
            vec![NoteDiagnosticCode::ContributorCredit]
        );
        let mut value = sample();
        value["credits"] = json!([]);
        assert_eq!(
            codes(parse(value)),
            vec![NoteDiagnosticCode::ContributorCredit]
        );
    }

    #[test]
    fn reader_feedback_stays_out_of_the_notebook() {
        let mut value = sample();
        value["notes"][0]["attribution"] = json!({"name": "Ada", "publishName": true});
        assert_eq!(
            codes(parse(value)),
            vec![NoteDiagnosticCode::ReaderFeedback]
        );
        let mut value = sample();
        value["receivedAt"] = json!("2026-10-26T10:00:00Z");
        assert_eq!(
            codes(parse(value)),
            vec![NoteDiagnosticCode::ReaderFeedback]
        );
    }

    #[test]
    fn failed_changes_leave_the_notebook_unchanged() {
        let library = library();
        let mut notebook = parse(sample()).expect("valid");
        let before = notebook.clone();

        let mut moved = notebook.passages[0].clone();
        moved.source = "plato-republic".into();
        moved.locators.clear();
        let diagnostics = notebook.upsert_passage(moved, &library).unwrap_err();
        assert_eq!(diagnostics[0].code, NoteDiagnosticCode::SourceChanged);
        assert_eq!(notebook, before);

        let diagnostics = notebook.remove_passage("p-cave", &library).unwrap_err();
        assert_eq!(diagnostics[0].code, NoteDiagnosticCode::StillLinked);
        assert_eq!(diagnostics[0].id.as_deref(), Some("n-1"));
        assert_eq!(notebook, before);

        let mut shadow = notebook.notes[0].clone();
        shadow.extra.insert("text".into(), json!("shadow"));
        assert_eq!(
            notebook.upsert_note(shadow, &library).unwrap_err()[0].code,
            NoteDiagnosticCode::InvalidField
        );
        assert_eq!(
            notebook.remove_note("nope", &library).unwrap_err()[0].code,
            NoteDiagnosticCode::UnknownEntry
        );
        assert_eq!(notebook, before);
    }

    #[test]
    fn changes_apply_in_place_and_track_source_use() {
        let library = library();
        let mut notebook = parse(sample()).expect("valid");
        let mut note = notebook.notes[0].clone();
        note.kind = NoteKind::Observation;
        note.text = "The cave is a frame.".into();
        notebook.upsert_note(note, &library).expect("update");
        assert_eq!(notebook.notes.len(), 1);
        assert_eq!(notebook.notes[0].kind, NoteKind::Observation);
        assert_eq!(
            notebook.entries_using_source("plato-republic"),
            vec!["n-1".to_string()]
        );
        notebook.remove_note("n-1", &library).expect("remove note");
        notebook
            .remove_passage("p-cave", &library)
            .expect("remove passage");
        assert_eq!(notebook, Notebook::default());
    }

    #[test]
    fn a_source_missing_from_the_library_fails_changes_not_files() {
        // Validating against a library without the source (for example after
        // the source was removed by hand) reports it scoped to each entry.
        let empty = SourceLibrary::default();
        let diagnostics = Notebook::parse(&sample().to_string(), &empty).unwrap_err();
        assert!(diagnostics
            .iter()
            .all(|d| d.code == NoteDiagnosticCode::UnknownSource));
        assert_eq!(diagnostics.len(), 2);
    }
}
