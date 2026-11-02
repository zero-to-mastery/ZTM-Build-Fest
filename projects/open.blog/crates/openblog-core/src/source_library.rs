//! Private research source library: works, editions, translations, witnesses,
//! and references with stable identities and a versioned, lossless file format,
//! plus the attributed interpretations made from them (see [`crate::interpretation`]).
//!
//! The library is author research data. Nothing here renders, publishes, or
//! contacts a metadata service; validation is offline and structural, and it
//! never rates a source's accuracy or authority.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::contributor::{valid_registry_key, Contributor};
use crate::interpretation::{self, Interpretation};
use crate::research::{absolute_http_url, normalize_doi_url};

/// The only library file version this release reads and writes.
pub const LIBRARY_VERSION: u64 = 1;
/// Upper bound on a serialized library, checked before JSON parsing.
pub const MAX_LIBRARY_BYTES: usize = 4 * 1024 * 1024;
/// Upper bound on the number of records in one library.
pub const MAX_SOURCES: usize = 10_000;
const MAX_ID_BYTES: usize = 64;
pub(crate) const MAX_TEXT_CHARS: usize = 1_000;

const CREATOR_ROLES: &[&str] = &[
    "author",
    "editor",
    "translator",
    "compiler",
    "scribe",
    "other",
];
pub(crate) const LOCATION_SCHEMES: &[&str] = &[
    "page",
    "folio",
    "line",
    "section",
    "chapter",
    "canonical",
    "timestamp",
];
/// Field names that belong to contributor credit sidecars. A source record
/// describes a researched work; it never carries or points at work credits.
pub(crate) const CREDIT_FIELDS: &[&str] = &["credit", "credits", "contributor", "contributors"];
pub(crate) const CREDIT_FIELD_MESSAGE: &str = "contributor credits stay in `.credits.json` sidecars; describe a source's makers as `creators`";
pub(crate) const RECORD_FIELDS: &[&str] = &[
    "id",
    "kind",
    "title",
    "creators",
    "language",
    "issued",
    "of",
    "basedOn",
    "location",
    "identifiers",
    "archived",
    "anonymous",
    "revises",
    "repository",
    "shelfmark",
    "volumes",
    "rights",
];
const CREATOR_FIELDS: &[&str] = &["name", "role", "attribution", "note"];
const LOCATION_FIELDS: &[&str] = &["scheme", "value", "volume"];
pub(crate) const RIGHTS_FIELDS: &[&str] = &["status", "note", "license"];
const LIBRARY_FIELDS: &[&str] = &["version", "sources", "interpretations"];
/// Upper bound on the volumes one edition or witness may declare.
pub const MAX_VOLUMES: u64 = 10_000;

/// What a source-library record is. Distinct from the crate-root
/// `SourceKind`, which classifies content files for the loader.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResearchSourceKind {
    Work,
    Edition,
    Translation,
    Witness,
    Reference,
}

impl ResearchSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::Edition => "edition",
            Self::Translation => "translation",
            Self::Witness => "witness",
            Self::Reference => "reference",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "work" => Self::Work,
            "edition" => Self::Edition,
            "translation" => Self::Translation,
            "witness" => Self::Witness,
            "reference" => Self::Reference,
            _ => return None,
        })
    }

    /// Editions, translations, and witnesses have a text of their own; a work
    /// is abstract and a reference only points into a version.
    pub fn is_version(self) -> bool {
        matches!(self, Self::Edition | Self::Translation | Self::Witness)
    }

    /// Kinds an `of` relationship from this kind may point at.
    fn of_targets(self) -> &'static [ResearchSourceKind] {
        match self {
            Self::Work => &[],
            Self::Edition => &[Self::Work, Self::Translation],
            Self::Translation => &[Self::Work],
            Self::Witness => &[Self::Work, Self::Edition, Self::Translation],
            Self::Reference => &[Self::Work, Self::Edition, Self::Translation, Self::Witness],
        }
    }
}

impl ResearchSourceKind {
    fn with_article(self) -> &'static str {
        match self {
            Self::Work => "a work",
            Self::Edition => "an edition",
            Self::Translation => "a translation",
            Self::Witness => "a witness",
            Self::Reference => "a reference",
        }
    }
}

impl fmt::Display for ResearchSourceKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// How firmly a name is tied to a source or an interpretation, as the author
/// records it (ADR 0086). An absent value says nothing either way; none of
/// these is a finding, and open.blog never decides between them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AttributionCertainty {
    /// The source itself names this person, for example on a title page.
    Stated,
    /// Tradition or scholarship assigns the name; the source does not state it.
    Attributed,
    /// The author is unsure of the attribution.
    Uncertain,
    /// Scholars disagree about the attribution.
    Disputed,
}

impl AttributionCertainty {
    pub const ALL: [Self; 4] = [
        Self::Stated,
        Self::Attributed,
        Self::Uncertain,
        Self::Disputed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stated => "stated",
            Self::Attributed => "attributed",
            Self::Uncertain => "uncertain",
            Self::Disputed => "disputed",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|certainty| certainty.as_str() == value)
    }

    /// Whether the name is firm enough to contradict an anonymous source: an
    /// unqualified name reads as stated.
    pub(crate) fn names_maker(certainty: Option<Self>) -> bool {
        matches!(certainty, None | Some(Self::Stated))
    }
}

/// The author's own statement of the rights in one version's text (ADR 0085).
/// It is never a legal determination, and `Unknown` is the honest default.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RightsStatus {
    /// Nobody has looked into it yet. Also what an undeclared version means.
    Unknown,
    /// The author believes the text is under copyright with rights reserved.
    RightsReserved,
    /// The rights holder gave the author permission.
    Permission,
    /// The text carries an open licence, named in `license`.
    OpenLicense,
    /// The author believes the text is in the public domain.
    PublicDomain,
    /// The text is the author's own work.
    OwnWork,
}

impl RightsStatus {
    pub const ALL: [Self; 6] = [
        Self::Unknown,
        Self::RightsReserved,
        Self::Permission,
        Self::OpenLicense,
        Self::PublicDomain,
        Self::OwnWork,
    ];

    /// The stable value written to the file and exchanged with clients.
    pub fn tag(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::RightsReserved => "rightsReserved",
            Self::Permission => "permission",
            Self::OpenLicense => "openLicense",
            Self::PublicDomain => "publicDomain",
            Self::OwnWork => "ownWork",
        }
    }

    /// The status as the author states it, in a few words. Never "allowed".
    pub fn label(self) -> &'static str {
        match self {
            Self::Unknown => "Rights not checked yet",
            Self::RightsReserved => "The author states the text is under copyright",
            Self::Permission => "The author states the rights holder gave permission",
            Self::OpenLicense => "The author states the text is under an open licence",
            Self::PublicDomain => "The author states the text is in the public domain",
            Self::OwnWork => "The author states the text is their own work",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|status| status.tag() == value)
    }
}

/// A rights declaration with an optional one-line note and licence name.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RightsDeclaration {
    pub status: RightsStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// The licence's name or identifier, such as `CC-BY-4.0`; only with an
    /// open licence. Kept as text and never resolved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// A descriptive name recorded on a source, such as a manuscript's scribe.
/// Creators are bibliographic description, not contributor credits.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCreator {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// How firmly the source is tied to this name (ADR 0086).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attribution: Option<AttributionCertainty>,
    /// The author's one-line note on the attribution, such as who disputes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// A scheme-qualified bibliographic identifier such as a DOI or ISBN. It
/// describes the record and never replaces its stable source identifier.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SourceIdentifier {
    pub scheme: String,
    pub value: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// A position inside the source a reference points at.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SourceLocation {
    pub scheme: String,
    pub value: String,
    /// The volume of a multi-volume edition or witness the position is in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecord {
    /// Stable, author-assigned identity. It never changes with the title.
    pub id: String,
    pub kind: ResearchSourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub creators: Vec<SourceCreator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Authored date text, kept verbatim (`2003`, `c. 375 BCE`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issued: Option<String>,
    /// The source this record realizes, translates, attests, or describes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub of: Option<String>,
    /// For a translation, the edition, witness, or translation it was made from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub based_on: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<SourceLocation>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub identifiers: Vec<SourceIdentifier>,
    /// Hidden from everyday lists but kept in place, so records that point
    /// at it still resolve. `false` is written as an absent field.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
    /// The source names no maker for this record (ADR 0086). Names tradition
    /// assigns may still be recorded as attributed, uncertain, or disputed
    /// creators. `false` is written as an absent field.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub anonymous: bool,
    /// For an edition, the earlier edition of the same text it revises.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revises: Option<String>,
    /// For a witness, the library, archive, or owner that holds it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// For a witness, its call number or shelfmark in that repository.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shelfmark: Option<String>,
    /// For an edition or witness in several volumes, how many there are.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volumes: Option<u64>,
    /// For an edition, translation, or witness, the author's own statement of
    /// the rights in its text (ADR 0085).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rights: Option<RightsDeclaration>,
    /// Fields this release does not understand, preserved verbatim.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl SourceRecord {
    /// A record of this kind with only its identity set, for callers that
    /// fill in the rest.
    pub fn new(id: impl Into<String>, kind: ResearchSourceKind) -> Self {
        Self {
            id: id.into(),
            kind,
            title: None,
            creators: Vec::new(),
            language: None,
            issued: None,
            of: None,
            based_on: None,
            location: None,
            identifiers: Vec::new(),
            archived: false,
            anonymous: false,
            revises: None,
            repository: None,
            shelfmark: None,
            volumes: None,
            rights: None,
            extra: BTreeMap::new(),
        }
    }

    /// Whether this record is a version with a text of its own: an edition,
    /// translation, or witness. Only versions carry rights.
    pub fn is_version(&self) -> bool {
        self.kind.is_version()
    }

    /// The rights status the author declared for this version, or `Unknown`
    /// when none is declared. `None` for a work or reference, which have no
    /// text of their own. Nothing here decides whether a use is allowed.
    pub fn rights_status(&self) -> Option<RightsStatus> {
        self.is_version().then(|| {
            self.rights
                .as_ref()
                .map_or(RightsStatus::Unknown, |rights| rights.status)
        })
    }
}

/// Whether a read validates the library's interpretations or keeps them raw.
#[derive(Clone, Copy)]
enum Interpretations {
    Validate,
    KeepRaw,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SourceLibrary {
    pub version: u64,
    pub sources: Vec<SourceRecord>,
    /// Attributed renderings and readings of places in the library's versions
    /// (ADR 0087). Private research, never a source, citation, or credit.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub interpretations: Vec<Interpretation>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for SourceLibrary {
    fn default() -> Self {
        Self {
            version: LIBRARY_VERSION,
            sources: Vec::new(),
            interpretations: Vec::new(),
            extra: BTreeMap::new(),
        }
    }
}

/// In-memory lookups over one library, in library order. See
/// [`SourceLibrary::index`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SourceIndex {
    positions: BTreeMap<String, usize>,
    kinds: BTreeMap<ResearchSourceKind, Vec<String>>,
    dependents: BTreeMap<String, Vec<String>>,
}

impl SourceIndex {
    /// Zero-based position of the record with this identifier.
    pub fn position(&self, id: &str) -> Option<usize> {
        self.positions.get(id).copied()
    }

    /// Identifiers of every record of one kind.
    pub fn of_kind(&self, kind: ResearchSourceKind) -> &[String] {
        self.kinds.get(&kind).map_or(&[], Vec::as_slice)
    }

    /// Identifiers of the records whose `of`, `basedOn`, or `revises` names this one.
    pub fn dependents(&self, id: &str) -> &[String] {
        self.dependents.get(id).map_or(&[], Vec::as_slice)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceDiagnosticCode {
    TooLarge,
    InvalidJson,
    UnsupportedVersion,
    MissingField,
    InvalidField,
    InvalidId,
    DuplicateId,
    UnknownKind,
    KindChanged,
    UnknownSource,
    UnresolvedRelationship,
    InvalidRelationship,
    AmbiguousRelationship,
    RelationshipCycle,
    AmbiguousLocation,
    InvalidIdentifier,
    ContributorCredit,
    /// Private research (a passage, note, or interpretation) still points at the record.
    StillUsed,
    /// An anonymous record or interpretation also names a stated maker.
    ConflictingAttribution,
}

impl fmt::Display for SourceDiagnosticCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::TooLarge => "too-large",
            Self::InvalidJson => "invalid-json",
            Self::UnsupportedVersion => "unsupported-version",
            Self::MissingField => "missing-field",
            Self::InvalidField => "invalid-field",
            Self::InvalidId => "invalid-id",
            Self::DuplicateId => "duplicate-id",
            Self::UnknownKind => "unknown-kind",
            Self::KindChanged => "kind-changed",
            Self::UnknownSource => "unknown-source",
            Self::UnresolvedRelationship => "unresolved-relationship",
            Self::InvalidRelationship => "invalid-relationship",
            Self::AmbiguousRelationship => "ambiguous-relationship",
            Self::RelationshipCycle => "relationship-cycle",
            Self::AmbiguousLocation => "ambiguous-location",
            Self::InvalidIdentifier => "invalid-identifier",
            Self::ContributorCredit => "contributor-credit",
            Self::StillUsed => "still-used",
            Self::ConflictingAttribution => "conflicting-attribution",
        })
    }
}

/// A problem scoped to the library, one record, or one field of a record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDiagnostic {
    pub code: SourceDiagnosticCode,
    /// Zero-based position in `sources`, when the problem belongs to a record.
    pub index: Option<usize>,
    pub source_id: Option<String>,
    /// Field path inside the record, such as `of` or `identifiers[0].value`.
    pub field: Option<String>,
    pub message: String,
}

impl fmt::Display for SourceDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (self.index, &self.source_id) {
            (Some(index), Some(id)) => write!(formatter, "sources[{index}] `{id}`")?,
            (Some(index), None) => write!(formatter, "sources[{index}]")?,
            (None, Some(id)) => write!(formatter, "source `{id}`")?,
            (None, None) => formatter.write_str("source library")?,
        }
        if let Some(field) = &self.field {
            write!(formatter, " {field}")?;
        }
        write!(formatter, ": {} ({})", self.message, self.code)
    }
}

impl SourceRecord {
    /// Read one record from untrusted JSON, such as an Admin request, with
    /// the same field checks as a stored record. Relationships are checked
    /// only once the record joins a library, so diagnostics carry no index.
    pub fn from_json(value: Value) -> Result<Self, Vec<SourceDiagnostic>> {
        let mut diagnostics = Vec::new();
        let (_, record) = parse_record(0, value, &mut diagnostics);
        for diagnostic in &mut diagnostics {
            diagnostic.index = None;
        }
        match record {
            Some(record) if diagnostics.is_empty() => Ok(record),
            _ => Err(diagnostics),
        }
    }
}

impl SourceLibrary {
    /// Parse and validate a serialized library. Every problem found is
    /// returned at once, each scoped as narrowly as possible; nothing is
    /// partially accepted.
    pub fn parse(
        text: &str,
        contributors: &BTreeMap<String, Contributor>,
    ) -> Result<Self, Vec<SourceDiagnostic>> {
        Self::parse_with(text, contributors, Interpretations::Validate)
    }

    /// Parse a library for a build, which reads only its sources. Builds never
    /// output interpretations (ADR 0087), so a problem in one, such as an
    /// interpreter whose contributor was removed, must not fail every build
    /// that cites a source: they are not validated and are kept raw in
    /// [`Self::extra`], leaving [`Self::interpretations`] empty. Admin, the
    /// store, and `openblog check` use [`Self::parse`], which validates them.
    pub fn parse_for_build(
        text: &str,
        contributors: &BTreeMap<String, Contributor>,
    ) -> Result<Self, Vec<SourceDiagnostic>> {
        Self::parse_with(text, contributors, Interpretations::KeepRaw)
    }

    fn parse_with(
        text: &str,
        contributors: &BTreeMap<String, Contributor>,
        mode: Interpretations,
    ) -> Result<Self, Vec<SourceDiagnostic>> {
        if text.len() > MAX_LIBRARY_BYTES {
            return Err(vec![too_large()]);
        }
        // Editors on Windows may save a byte-order mark, which is not JSON.
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        match serde_json::from_str(text) {
            Ok(value) => Self::from_value(value, contributors, mode),
            Err(error) => Err(vec![library_diagnostic(
                SourceDiagnosticCode::InvalidJson,
                None,
                format!("invalid JSON: {error}"),
            )]),
        }
    }

    /// Validate a parsed document. The size limit is measured on the
    /// canonical [`Self::to_json`] form, so every library this accepts can be
    /// written out and read back, and can always shrink.
    fn from_value(
        value: Value,
        contributors: &BTreeMap<String, Contributor>,
        mode: Interpretations,
    ) -> Result<Self, Vec<SourceDiagnostic>> {
        let mut diagnostics = Vec::new();
        let Value::Object(mut root) = value else {
            diagnostics.push(library_diagnostic(
                SourceDiagnosticCode::InvalidField,
                None,
                "the library must be a JSON object".into(),
            ));
            return Err(diagnostics);
        };
        if root.contains_key("credits") && !root.contains_key("sources") {
            diagnostics.push(library_diagnostic(
                SourceDiagnosticCode::ContributorCredit,
                Some("credits"),
                "this is a contributor credit sidecar; work credits record who made a post and are never bibliographic sources".into(),
            ));
            return Err(diagnostics);
        }

        let version = match root.remove("version") {
            Some(Value::Number(number)) if number.as_u64() == Some(LIBRARY_VERSION) => {
                LIBRARY_VERSION
            }
            Some(Value::Number(number)) if number.as_u64().is_some_and(|v| v > LIBRARY_VERSION) => {
                diagnostics.push(library_diagnostic(
                    SourceDiagnosticCode::UnsupportedVersion,
                    Some("version"),
                    format!(
                        "library version {number} was written by a newer open.blog; upgrade before editing so newer data is not lost"
                    ),
                ));
                return Err(diagnostics);
            }
            Some(_) => {
                diagnostics.push(library_diagnostic(
                    SourceDiagnosticCode::UnsupportedVersion,
                    Some("version"),
                    format!("version must be {LIBRARY_VERSION}"),
                ));
                return Err(diagnostics);
            }
            None => {
                diagnostics.push(library_diagnostic(
                    SourceDiagnosticCode::MissingField,
                    Some("version"),
                    format!("add `\"version\": {LIBRARY_VERSION}`"),
                ));
                return Err(diagnostics);
            }
        };

        let raw_sources = match root.remove("sources") {
            Some(Value::Array(sources)) => sources,
            Some(_) => {
                diagnostics.push(library_diagnostic(
                    SourceDiagnosticCode::InvalidField,
                    Some("sources"),
                    "sources must be a JSON array".into(),
                ));
                return Err(diagnostics);
            }
            None => {
                diagnostics.push(library_diagnostic(
                    SourceDiagnosticCode::MissingField,
                    Some("sources"),
                    "add a `sources` array".into(),
                ));
                return Err(diagnostics);
            }
        };
        if raw_sources.len() > MAX_SOURCES {
            diagnostics.push(library_diagnostic(
                SourceDiagnosticCode::TooLarge,
                Some("sources"),
                format!("a library may hold at most {MAX_SOURCES} sources"),
            ));
            return Err(diagnostics);
        }
        // Interpretations name contributors on purpose and check credit
        // fields themselves (ADR 0087); everything else at this level may not.
        let raw_interpretations = root.remove("interpretations");
        for (key, value) in &root {
            for field in credit_paths(value, key.clone(), CREDIT_FIELDS.contains(&key.as_str())) {
                diagnostics.push(library_diagnostic(
                    SourceDiagnosticCode::ContributorCredit,
                    Some(&field),
                    CREDIT_FIELD_MESSAGE.into(),
                ));
            }
        }

        let mut identities = Vec::new();
        let mut parsed = Vec::with_capacity(raw_sources.len());
        for (index, raw) in raw_sources.into_iter().enumerate() {
            let (id, record) = parse_record(index, raw, &mut diagnostics);
            if let Some(id) = id {
                identities.push((index, id, record.as_ref().map(|record| record.kind)));
            }
            if let Some(record) = record {
                parsed.push((index, record));
            }
        }
        validate_relationships(&identities, &parsed, contributors, &mut diagnostics);
        let interpretations = match mode {
            Interpretations::Validate => interpretation::parse_all(
                raw_interpretations,
                &identities,
                contributors,
                &mut diagnostics,
            ),
            Interpretations::KeepRaw => {
                if let Some(raw) = raw_interpretations {
                    root.insert("interpretations".into(), raw);
                }
                Vec::new()
            }
        };
        if !diagnostics.is_empty() {
            diagnostics.sort_by_key(|diagnostic| diagnostic.index);
            return Err(diagnostics);
        }
        let library = Self {
            version,
            sources: parsed.into_iter().map(|(_, record)| record).collect(),
            interpretations,
            extra: root.into_iter().collect(),
        };
        if library.written_len() > MAX_LIBRARY_BYTES {
            return Err(vec![too_large()]);
        }
        Ok(library)
    }

    /// The record with exactly this source identifier.
    pub fn get(&self, id: &str) -> Option<&SourceRecord> {
        self.sources.iter().find(|record| record.id == id)
    }

    /// Lookups derived from the records. The index is never stored: it is
    /// rebuilt from the canonical library, so it cannot drift from it or
    /// reach any output the library itself does not.
    pub fn index(&self) -> SourceIndex {
        let mut index = SourceIndex::default();
        for (position, record) in self.sources.iter().enumerate() {
            index.positions.insert(record.id.clone(), position);
            index
                .kinds
                .entry(record.kind)
                .or_default()
                .push(record.id.clone());
            for target in record
                .of
                .iter()
                .chain(&record.based_on)
                .chain(&record.revises)
            {
                index
                    .dependents
                    .entry(target.clone())
                    .or_default()
                    .push(record.id.clone());
            }
        }
        index
    }

    /// Deterministic, pretty-printed JSON with a trailing newline.
    pub fn to_json(&self) -> String {
        let mut text = serde_json::to_string_pretty(self).unwrap_or_default();
        text.push('\n');
        text
    }

    /// The byte length of [`Self::to_json`], without building the string.
    fn written_len(&self) -> usize {
        let mut counter = ByteCounter(1);
        match serde_json::to_writer_pretty(&mut counter, self) {
            Ok(()) => counter.0,
            Err(_) => usize::MAX,
        }
    }

    /// Validate an edited copy of this library the same way a file is read,
    /// without a text round trip.
    fn validated(
        candidate: &Self,
        contributors: &BTreeMap<String, Contributor>,
    ) -> Result<Self, Vec<SourceDiagnostic>> {
        let shadowed = shadowed_fields(candidate);
        if !shadowed.is_empty() {
            return Err(shadowed);
        }
        match serde_json::to_value(candidate) {
            Ok(value) => Self::from_value(value, contributors, Interpretations::Validate),
            Err(error) => Err(vec![library_diagnostic(
                SourceDiagnosticCode::InvalidJson,
                None,
                format!("the library could not be serialized: {error}"),
            )]),
        }
    }

    /// Add a record, or replace the record with the same identifier in place.
    /// The library changes only when the whole result is valid, and an
    /// identifier never changes kind.
    pub fn upsert(
        &mut self,
        record: SourceRecord,
        contributors: &BTreeMap<String, Contributor>,
    ) -> Result<(), Vec<SourceDiagnostic>> {
        let mut candidate = self.clone();
        let position = candidate
            .sources
            .iter()
            .position(|existing| existing.id == record.id);
        match position {
            Some(index) => {
                let existing = candidate.sources[index].kind;
                if existing != record.kind {
                    return Err(vec![record_diagnostic(
                        SourceDiagnosticCode::KindChanged,
                        index,
                        &record.id,
                        "kind",
                        format!(
                            "`{}` is a {existing}; record the {} as a new source with its own id",
                            record.id, record.kind
                        ),
                    )]);
                }
                candidate.sources[index] = record;
            }
            None => candidate.sources.push(record),
        }
        *self = Self::validated(&candidate, contributors)?;
        Ok(())
    }

    /// The library as it would be with all of these records added or replaced
    /// in place, validated once as a whole so records may point at each other
    /// in any order. `self` is never changed; a caller adopts the result.
    pub fn with_records(
        &self,
        records: Vec<SourceRecord>,
        contributors: &BTreeMap<String, Contributor>,
    ) -> Result<Self, Vec<SourceDiagnostic>> {
        let mut candidate = self.clone();
        for record in records {
            match candidate
                .sources
                .iter()
                .position(|existing| existing.id == record.id)
            {
                Some(index) if candidate.sources[index].kind != record.kind => {
                    return Err(vec![record_diagnostic(
                        SourceDiagnosticCode::KindChanged,
                        index,
                        &record.id,
                        "kind",
                        format!(
                            "`{}` is a {}; record the {} as a new source with its own id",
                            record.id, candidate.sources[index].kind, record.kind
                        ),
                    )]);
                }
                Some(index) => candidate.sources[index] = record,
                None => candidate.sources.push(record),
            }
        }
        Self::validated(&candidate, contributors)
    }

    /// Remove a record. Removal fails, leaving the library unchanged, while
    /// any other record still depends on it.
    pub fn remove(
        &mut self,
        id: &str,
        contributors: &BTreeMap<String, Contributor>,
    ) -> Result<SourceRecord, Vec<SourceDiagnostic>> {
        let Some(index) = self.sources.iter().position(|record| record.id == id) else {
            return Err(vec![SourceDiagnostic {
                code: SourceDiagnosticCode::UnknownSource,
                index: None,
                source_id: Some(id.into()),
                field: None,
                message: format!("no source has the id `{id}`"),
            }]);
        };
        let users: Vec<&str> = self
            .interpretations_of(id)
            .map(|interpretation| interpretation.id.as_str())
            .collect();
        if !users.is_empty() {
            return Err(vec![record_diagnostic(
                SourceDiagnosticCode::StillUsed,
                index,
                id,
                "id",
                format!(
                    "the interpretation{} {} still {} this source; remove or repoint {} first",
                    if users.len() == 1 { "" } else { "s" },
                    users
                        .iter()
                        .map(|user| format!("`{user}`"))
                        .collect::<Vec<_>>()
                        .join(", "),
                    if users.len() == 1 {
                        "interprets"
                    } else {
                        "interpret"
                    },
                    if users.len() == 1 { "it" } else { "them" },
                ),
            )]);
        }
        let mut candidate = self.clone();
        let removed = candidate.sources.remove(index);
        match Self::validated(&candidate, contributors) {
            Ok(library) => {
                *self = library;
                Ok(removed)
            }
            Err(mut diagnostics) => {
                // Report positions in the library the caller holds, which
                // still contains the record that was to be removed.
                for position in diagnostics.iter_mut().filter_map(|d| d.index.as_mut()) {
                    if *position >= index {
                        *position += 1;
                    }
                }
                Err(diagnostics)
            }
        }
    }

    /// The interpretation with exactly this identifier.
    pub fn interpretation(&self, id: &str) -> Option<&Interpretation> {
        self.interpretations
            .iter()
            .find(|interpretation| interpretation.id == id)
    }

    /// Whether the library holds an interpretation with this identifier,
    /// validated or, in a library read by [`Self::parse_for_build`], still
    /// raw. A build checks that the alignments it reads point at entries
    /// that exist without validating every interpretation (ADR 0087).
    pub fn has_interpretation(&self, id: &str) -> bool {
        self.interpretation(id).is_some()
            || self.raw_interpretations().is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item.get("id").and_then(Value::as_str) == Some(id))
            })
    }

    fn raw_interpretations(&self) -> Option<&Vec<Value>> {
        self.extra.get("interpretations").and_then(Value::as_array)
    }

    /// For a build that publishes comparisons (ADR 0092): validate exactly
    /// the raw interpretations with these identifiers, each with the same
    /// field, id and contributor checks as a full parse, and add them to
    /// [`Self::interpretations`]. Every other interpretation stays raw and
    /// unvalidated, so a problem in one that nothing published uses never
    /// stops the build. Problems are grouped by the identifier named, with
    /// field paths at the entry's position in the stored array. An
    /// identifier with no raw entry is left for the caller to report.
    pub fn validate_interpretations_for_build(
        &mut self,
        ids: &BTreeSet<String>,
        contributors: &BTreeMap<String, Contributor>,
    ) -> Result<(), Vec<(String, Vec<SourceDiagnostic>)>> {
        if ids.is_empty() {
            return Ok(());
        }
        let Some(items) = self.raw_interpretations() else {
            if self.extra.contains_key("interpretations") {
                let problem = library_diagnostic(
                    SourceDiagnosticCode::InvalidField,
                    Some("interpretations"),
                    "interpretations must be a JSON array".into(),
                );
                return Err(ids
                    .iter()
                    .map(|id| (id.clone(), vec![problem.clone()]))
                    .collect());
            }
            return Ok(());
        };
        let identities: Vec<(usize, String, Option<ResearchSourceKind>)> = self
            .sources
            .iter()
            .enumerate()
            .map(|(index, record)| (index, record.id.clone(), Some(record.kind)))
            .collect();
        let mut validated = Vec::new();
        let mut failures = Vec::new();
        for id in ids {
            let (positions, entries): (Vec<usize>, Vec<Value>) = items
                .iter()
                .enumerate()
                .filter(|(_, item)| item.get("id").and_then(Value::as_str) == Some(id))
                .map(|(position, item)| (position, item.clone()))
                .unzip();
            if entries.is_empty() {
                continue;
            }
            let mut diagnostics = Vec::new();
            let parsed = interpretation::parse_all(
                Some(Value::Array(entries)),
                &identities,
                contributors,
                &mut diagnostics,
            );
            if diagnostics.is_empty() {
                validated.extend(parsed);
            } else {
                for diagnostic in &mut diagnostics {
                    if let Some(field) = &mut diagnostic.field {
                        *field = at_stored_position(field, &positions);
                    }
                }
                failures.push((id.clone(), diagnostics));
            }
        }
        if !failures.is_empty() {
            return Err(failures);
        }
        self.interpretations.extend(validated);
        Ok(())
    }

    /// Interpretations made from this source's text, in library order.
    pub fn interpretations_of<'a>(
        &'a self,
        source: &'a str,
    ) -> impl Iterator<Item = &'a Interpretation> + 'a {
        self.interpretations
            .iter()
            .filter(move |interpretation| interpretation.source == source)
    }

    /// The record and every record it realizes, following `of` up to the work:
    /// a reference, then the witness, edition, or translation it points into,
    /// then the work. Each keeps its own kind, so a translation in the chain
    /// is never read as an edition or as the original work.
    pub fn realization_chain(&self, id: &str) -> Vec<&SourceRecord> {
        let mut chain: Vec<&SourceRecord> = Vec::new();
        let mut current = self.get(id);
        while let Some(record) = current {
            if chain.iter().any(|seen| seen.id == record.id) {
                break;
            }
            chain.push(record);
            current = record.of.as_deref().and_then(|of| self.get(of));
        }
        chain
    }

    /// Add an interpretation, or replace the one with the same identifier in
    /// place. The library changes only when the whole result is valid.
    pub fn upsert_interpretation(
        &mut self,
        interpretation: Interpretation,
        contributors: &BTreeMap<String, Contributor>,
    ) -> Result<(), Vec<SourceDiagnostic>> {
        let mut candidate = self.clone();
        match candidate
            .interpretations
            .iter()
            .position(|existing| existing.id == interpretation.id)
        {
            Some(index) => candidate.interpretations[index] = interpretation,
            None => candidate.interpretations.push(interpretation),
        }
        *self = Self::validated(&candidate, contributors)?;
        Ok(())
    }

    /// Remove an interpretation. Nothing else points at one, so this fails
    /// only when the identifier is unknown.
    pub fn remove_interpretation(
        &mut self,
        id: &str,
        contributors: &BTreeMap<String, Contributor>,
    ) -> Result<Interpretation, Vec<SourceDiagnostic>> {
        let Some(index) = self
            .interpretations
            .iter()
            .position(|interpretation| interpretation.id == id)
        else {
            return Err(vec![interpretation::unknown(id)]);
        };
        let mut candidate = self.clone();
        let removed = candidate.interpretations.remove(index);
        *self = Self::validated(&candidate, contributors)?;
        Ok(removed)
    }
}

fn too_large() -> SourceDiagnostic {
    library_diagnostic(
        SourceDiagnosticCode::TooLarge,
        None,
        format!("the library is larger than {MAX_LIBRARY_BYTES} bytes as read or as written"),
    )
}

/// Counts serialized bytes so the written size can be checked cheaply.
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

/// Unknown fields that collide with a defined field. With flattened extras the
/// colliding key would be written twice and the unknown value would replace
/// the typed one on the next read, so such an edit is refused instead.
/// Rewrite a field path such as `interpretations[1].text`, whose index is a
/// position in a filtered array, to the entry's position in the stored one.
fn at_stored_position(field: &str, positions: &[usize]) -> String {
    let Some(rest) = field.strip_prefix("interpretations[") else {
        return field.to_string();
    };
    let Some((index, tail)) = rest.split_once(']') else {
        return field.to_string();
    };
    match index.parse::<usize>().ok().and_then(|i| positions.get(i)) {
        Some(stored) => format!("interpretations[{stored}]{tail}"),
        None => field.to_string(),
    }
}

fn shadowed_fields(library: &SourceLibrary) -> Vec<SourceDiagnostic> {
    let mut diagnostics = Vec::new();
    let message = || "an unknown field cannot shadow a defined field".to_string();
    for key in library.extra.keys() {
        if LIBRARY_FIELDS.contains(&key.as_str()) {
            diagnostics.push(library_diagnostic(
                SourceDiagnosticCode::InvalidField,
                Some(key),
                message(),
            ));
        }
    }
    for (index, record) in library.sources.iter().enumerate() {
        let mut report = |path: String| {
            diagnostics.push(record_diagnostic(
                SourceDiagnosticCode::InvalidField,
                index,
                &record.id,
                &path,
                message(),
            ));
        };
        let mut check = |extra: &BTreeMap<String, Value>, defined: &[&str], prefix: &str| {
            for key in extra.keys().filter(|key| defined.contains(&key.as_str())) {
                report(if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                });
            }
        };
        check(&record.extra, RECORD_FIELDS, "");
        for (position, creator) in record.creators.iter().enumerate() {
            check(
                &creator.extra,
                CREATOR_FIELDS,
                &format!("creators[{position}]"),
            );
        }
        for (position, identifier) in record.identifiers.iter().enumerate() {
            check(
                &identifier.extra,
                &["scheme", "value"],
                &format!("identifiers[{position}]"),
            );
        }
        if let Some(location) = &record.location {
            check(&location.extra, LOCATION_FIELDS, "location");
        }
        if let Some(rights) = &record.rights {
            check(&rights.extra, RIGHTS_FIELDS, "rights");
        }
    }
    for (index, interpretation) in library.interpretations.iter().enumerate() {
        for path in interpretation.shadowed_fields() {
            diagnostics.push(library_diagnostic(
                SourceDiagnosticCode::InvalidField,
                Some(&format!("interpretations[{index}].{path}")),
                message(),
            ));
        }
    }
    diagnostics
}

/// Paths of every credit sidecar field inside `value`, at any depth.
pub(crate) fn credit_paths(value: &Value, path: String, is_credit: bool) -> Vec<String> {
    let mut found = Vec::new();
    let mut pending = vec![(value, path, is_credit)];
    while let Some((value, path, is_credit)) = pending.pop() {
        if is_credit {
            found.push(path);
            continue;
        }
        match value {
            Value::Object(object) => {
                for (key, child) in object {
                    let credit = CREDIT_FIELDS.contains(&key.as_str());
                    pending.push((child, format!("{path}.{key}"), credit));
                }
            }
            Value::Array(items) => {
                for (position, item) in items.iter().enumerate() {
                    pending.push((item, format!("{path}[{position}]"), false));
                }
            }
            _ => {}
        }
    }
    found.sort();
    found
}

fn record_diagnostic(
    code: SourceDiagnosticCode,
    index: usize,
    id: &str,
    field: &str,
    message: String,
) -> SourceDiagnostic {
    SourceDiagnostic {
        code,
        index: Some(index),
        source_id: Some(id.into()),
        field: Some(field.into()),
        message,
    }
}

fn validate_relationships(
    identities: &[(usize, String, Option<ResearchSourceKind>)],
    records: &[(usize, SourceRecord)],
    contributors: &BTreeMap<String, Contributor>,
    diagnostics: &mut Vec<SourceDiagnostic>,
) {
    // Records that failed to parse still own their identifier, so references
    // to them are not reported a second time.
    let mut known: BTreeMap<&str, (usize, Option<ResearchSourceKind>)> = BTreeMap::new();
    for (index, id, kind) in identities {
        if let Some((first, _)) = known.get(id.as_str()) {
            diagnostics.push(record_diagnostic(
                SourceDiagnosticCode::DuplicateId,
                *index,
                id,
                "id",
                format!(
                    "`{id}` is already used by sources[{first}]; every source needs its own id"
                ),
            ));
        } else {
            known.insert(id, (*index, *kind));
        }
    }

    // Only edges that passed every check take part in the graph checks below.
    let mut of_edges: BTreeMap<&str, (&str, ResearchSourceKind)> = BTreeMap::new();
    let mut based_on_edges: BTreeMap<&str, &str> = BTreeMap::new();
    let mut revises_edges: BTreeMap<&str, &str> = BTreeMap::new();
    let mut volumes: BTreeMap<&str, u64> = BTreeMap::new();
    let mut holdings: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    for (index, record) in records {
        // A duplicate is reported once; its relationships are ambiguous.
        if known.get(record.id.as_str()).map(|(first, _)| first) != Some(index) {
            continue;
        }
        if let Some(count) = record.volumes {
            volumes.insert(&record.id, count);
        }
        if let Some(shelfmark) = &record.shelfmark {
            let holding = (
                record.repository.as_deref().unwrap_or_default(),
                shelfmark.as_str(),
            );
            if let Some(first) = holdings.get(&holding) {
                diagnostics.push(record_diagnostic(
                    SourceDiagnosticCode::DuplicateId,
                    *index,
                    &record.id,
                    "shelfmark",
                    format!(
                        "sources[{first}] is already the witness with this repository and shelfmark; one copy is one witness"
                    ),
                ));
            } else {
                holdings.insert(holding, *index);
            }
        }
        let edges = [
            ("of", record.of.as_deref(), record.kind.of_targets()),
            (
                "basedOn",
                record.based_on.as_deref(),
                &[
                    ResearchSourceKind::Edition,
                    ResearchSourceKind::Witness,
                    ResearchSourceKind::Translation,
                ][..],
            ),
            (
                "revises",
                record.revises.as_deref(),
                &[ResearchSourceKind::Edition][..],
            ),
        ];
        for (field, target, permitted) in edges {
            let Some(target) = target else {
                continue;
            };
            let report =
                |code, message| record_diagnostic(code, *index, &record.id, field, message);
            if target == record.id {
                diagnostics.push(report(
                    SourceDiagnosticCode::InvalidRelationship,
                    format!("a source cannot be `{field}` itself"),
                ));
                continue;
            }
            let Some((_, target_kind)) = known.get(target) else {
                diagnostics.push(if contributors.contains_key(target) {
                    report(
                        SourceDiagnosticCode::ContributorCredit,
                        format!(
                            "`{target}` is a contributor; work credits are attribution and cannot be cited as a source"
                        ),
                    )
                } else {
                    report(
                        SourceDiagnosticCode::UnresolvedRelationship,
                        format!("no source has the id `{target}`"),
                    )
                });
                continue;
            };
            let Some(target_kind) = target_kind else {
                continue;
            };
            if !permitted.contains(target_kind) {
                diagnostics.push(report(
                    SourceDiagnosticCode::InvalidRelationship,
                    format!(
                        "{} cannot be `{field}` the {target_kind} `{target}`; point it at {}",
                        record.kind.with_article(),
                        kind_list(permitted)
                    ),
                ));
                continue;
            }
            match field {
                "of" => {
                    of_edges.insert(&record.id, (target, *target_kind));
                }
                "basedOn" => {
                    based_on_edges.insert(&record.id, target);
                }
                _ => {
                    revises_edges.insert(&record.id, target);
                }
            }
        }
    }

    for (index, record) in records {
        if let (Some(source_text), Some(work)) = (
            based_on_edges.get(record.id.as_str()),
            of_edges.get(record.id.as_str()).map(|(work, _)| *work),
        ) {
            if depends_on(source_text, &record.id, &of_edges, &based_on_edges) {
                diagnostics.push(record_diagnostic(
                    SourceDiagnosticCode::RelationshipCycle,
                    *index,
                    &record.id,
                    "basedOn",
                    format!(
                        "`{}` is based on `{source_text}`, which itself depends on `{}`",
                        record.id, record.id
                    ),
                ));
            } else if let Some(other) =
                root_work(source_text, &of_edges, &known).filter(|root| *root != work)
            {
                diagnostics.push(record_diagnostic(
                    SourceDiagnosticCode::AmbiguousRelationship,
                    *index,
                    &record.id,
                    "basedOn",
                    format!(
                        "this translation is `of` `{work}` but is based on `{source_text}`, which belongs to `{other}`; record one translation per original work"
                    ),
                ));
            }
        }

        if let Some(earlier) = revises_edges.get(record.id.as_str()) {
            let text = of_edges.get(record.id.as_str()).map(|(text, _)| *text);
            let earlier_text = of_edges.get(earlier).map(|(text, _)| *text);
            if revises_chain_reaches(earlier, &record.id, &revises_edges) {
                diagnostics.push(record_diagnostic(
                    SourceDiagnosticCode::RelationshipCycle,
                    *index,
                    &record.id,
                    "revises",
                    format!(
                        "`{}` revises `{earlier}`, which itself revises `{}`",
                        record.id, record.id
                    ),
                ));
            } else if let (Some(text), Some(earlier_text)) = (text, earlier_text) {
                if text != earlier_text {
                    diagnostics.push(record_diagnostic(
                        SourceDiagnosticCode::AmbiguousRelationship,
                        *index,
                        &record.id,
                        "revises",
                        format!(
                            "this edition is `of` `{text}` but revises `{earlier}`, an edition of `{earlier_text}`; a revision is an edition of the same text"
                        ),
                    ));
                }
            }
        }

        if let (Some(location), Some((target, target_kind))) =
            (&record.location, of_edges.get(record.id.as_str()))
        {
            let count = volumes.get(target).copied().unwrap_or(1);
            let volume_message = match location.volume.as_deref() {
                None if count > 1 && matches!(location.scheme.as_str(), "page" | "folio") => {
                    Some(format!(
                        "`{target}` has {count} volumes and each may restart its {}s; add the location's `volume`",
                        location.scheme
                    ))
                }
                Some(volume)
                    if volumes.contains_key(target)
                        && volume.parse::<u64>().is_ok_and(|n| n == 0 || n > count) =>
                {
                    Some(format!(
                        "`{target}` has {count} volume{}; volume {volume} is not one of them",
                        if count == 1 { "" } else { "s" }
                    ))
                }
                _ => None,
            };
            if let Some(message) = volume_message {
                diagnostics.push(record_diagnostic(
                    SourceDiagnosticCode::AmbiguousLocation,
                    *index,
                    &record.id,
                    "location.volume",
                    message,
                ));
            }
            let message = match location.scheme.as_str() {
                "page" if *target_kind == ResearchSourceKind::Work => Some(format!(
                    "pages differ between editions of the work `{target}`; point this reference at the edition, translation, or witness whose pages are cited"
                )),
                "folio" if *target_kind != ResearchSourceKind::Witness => Some(format!(
                    "folios belong to one manuscript or copy, but `{target}` is a {target_kind}; point this reference at a witness"
                )),
                _ => None,
            };
            if let Some(message) = message {
                diagnostics.push(record_diagnostic(
                    SourceDiagnosticCode::AmbiguousLocation,
                    *index,
                    &record.id,
                    "location.scheme",
                    message,
                ));
            }
        }
    }
}

/// Whether following `revises` edges from `start` reaches `goal`.
fn revises_chain_reaches(start: &str, goal: &str, revises_edges: &BTreeMap<&str, &str>) -> bool {
    let mut current = start;
    let mut seen = BTreeSet::new();
    loop {
        if current == goal {
            return true;
        }
        if !seen.insert(current) {
            return false;
        }
        match revises_edges.get(current) {
            Some(next) => current = next,
            None => return false,
        }
    }
}

/// Whether following valid edges from `start` reaches `goal`.
fn depends_on(
    start: &str,
    goal: &str,
    of_edges: &BTreeMap<&str, (&str, ResearchSourceKind)>,
    based_on_edges: &BTreeMap<&str, &str>,
) -> bool {
    let mut pending = vec![start];
    let mut seen = BTreeSet::new();
    while let Some(current) = pending.pop() {
        if current == goal {
            return true;
        }
        if !seen.insert(current) {
            continue;
        }
        pending.extend(of_edges.get(current).map(|(target, _)| *target));
        pending.extend(based_on_edges.get(current).copied());
    }
    false
}

/// The work a record ultimately realizes, following only `of` edges.
fn root_work<'a>(
    start: &'a str,
    of_edges: &BTreeMap<&'a str, (&'a str, ResearchSourceKind)>,
    known: &BTreeMap<&str, (usize, Option<ResearchSourceKind>)>,
) -> Option<&'a str> {
    let mut current = start;
    for _ in 0..=ResearchSourceKind::Reference as usize {
        if known.get(current).and_then(|(_, kind)| *kind) == Some(ResearchSourceKind::Work) {
            return Some(current);
        }
        current = of_edges.get(current)?.0;
    }
    None
}

fn kind_list(kinds: &[ResearchSourceKind]) -> String {
    let names: Vec<&str> = kinds.iter().map(|kind| kind.with_article()).collect();
    match names.as_slice() {
        [] => "nothing".into(),
        [only] => (*only).to_string(),
        [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
    }
}

pub(crate) fn library_diagnostic(
    code: SourceDiagnosticCode,
    field: Option<&str>,
    message: String,
) -> SourceDiagnostic {
    SourceDiagnostic {
        code,
        index: None,
        source_id: None,
        field: field.map(str::to_string),
        message,
    }
}

/// What is wrong with one line of authored text, if anything: it must be
/// non-empty, at most [`MAX_TEXT_CHARS`] characters, and free of control
/// characters.
pub(crate) fn short_text_problem(text: &str) -> Option<(SourceDiagnosticCode, String)> {
    if text.trim().is_empty() {
        Some((
            SourceDiagnosticCode::InvalidField,
            "must not be empty".into(),
        ))
    } else if text.chars().count() > MAX_TEXT_CHARS {
        Some((
            SourceDiagnosticCode::TooLarge,
            format!("must be at most {MAX_TEXT_CHARS} characters"),
        ))
    } else if text.chars().any(char::is_control) {
        Some((
            SourceDiagnosticCode::InvalidField,
            "must not contain control characters".into(),
        ))
    } else {
        None
    }
}

/// Read a rights declaration at `path`, reporting each problem through
/// `report` with a field path. Shared by records and interpretations.
pub(crate) fn parse_rights(
    value: Value,
    path: &str,
    report: &mut dyn FnMut(SourceDiagnosticCode, String, String),
) -> Option<RightsDeclaration> {
    let Value::Object(mut object) = value else {
        report(
            SourceDiagnosticCode::InvalidField,
            path.into(),
            "must be an object with a `status`".into(),
        );
        return None;
    };
    let text = |object: &mut Map<String, Value>,
                field: &str,
                report: &mut dyn FnMut(SourceDiagnosticCode, String, String)| {
        match object.remove(field) {
            Some(Value::String(text)) => match short_text_problem(&text) {
                Some((code, message)) => {
                    report(code, format!("{path}.{field}"), message);
                    None
                }
                None => Some(text),
            },
            Some(_) => {
                report(
                    SourceDiagnosticCode::InvalidField,
                    format!("{path}.{field}"),
                    "must be a string".into(),
                );
                None
            }
            None => None,
        }
    };
    let note = text(&mut object, "note", report);
    let license = text(&mut object, "license", report);
    let statuses = || {
        RightsStatus::ALL
            .iter()
            .map(|status| status.tag())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let status = match object.remove("status") {
        Some(Value::String(tag)) => {
            let status = RightsStatus::parse(&tag);
            if status.is_none() {
                report(
                    SourceDiagnosticCode::InvalidField,
                    format!("{path}.status"),
                    format!("use one of: {}", statuses()),
                );
            }
            status
        }
        Some(_) => {
            report(
                SourceDiagnosticCode::InvalidField,
                format!("{path}.status"),
                "must be a string".into(),
            );
            None
        }
        None => {
            report(
                SourceDiagnosticCode::MissingField,
                format!("{path}.status"),
                format!(
                    "state the rights as you understand them: {}; this is your declaration, never a legal determination",
                    statuses()
                ),
            );
            None
        }
    };
    if license.is_some() && status.is_some_and(|status| status != RightsStatus::OpenLicense) {
        report(
            SourceDiagnosticCode::InvalidField,
            format!("{path}.license"),
            "a licence belongs with the `openLicense` status".into(),
        );
    }
    // Credit fields inside a declaration are reported by the caller's scan
    // of the whole record or interpretation.
    status.map(|status| RightsDeclaration {
        status,
        note,
        license,
        extra: object.into_iter().collect(),
    })
}

/// Read a creator or interpreter `attribution` certainty at `path`.
pub(crate) fn parse_certainty(
    value: Option<Value>,
    path: &str,
    report: &mut dyn FnMut(SourceDiagnosticCode, String, String),
) -> Option<AttributionCertainty> {
    let value = value?;
    let certainty = value.as_str().and_then(AttributionCertainty::parse);
    if certainty.is_none() {
        report(
            SourceDiagnosticCode::InvalidField,
            path.into(),
            format!(
                "use one of: {}",
                AttributionCertainty::ALL
                    .iter()
                    .map(|certainty| certainty.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        );
    }
    certainty
}

/// Field-by-field reader for one raw record, so each problem names its field.
struct RecordReader<'a> {
    index: usize,
    id: Option<String>,
    fields: Map<String, Value>,
    diagnostics: &'a mut Vec<SourceDiagnostic>,
    failed: bool,
}

impl RecordReader<'_> {
    fn report(&mut self, code: SourceDiagnosticCode, field: Option<String>, message: String) {
        self.failed = true;
        self.diagnostics.push(SourceDiagnostic {
            code,
            index: Some(self.index),
            source_id: self.id.clone(),
            field,
            message,
        });
    }

    fn take_text(&mut self, field: &str) -> Option<String> {
        let value = self.fields.remove(field)?;
        let Value::String(text) = value else {
            self.report(
                SourceDiagnosticCode::InvalidField,
                Some(field.into()),
                "must be a string".into(),
            );
            return None;
        };
        self.check_text(field.into(), &text);
        Some(text)
    }

    /// Report a problem with authored text.
    fn check_text(&mut self, field: String, text: &str) {
        if let Some((code, message)) = short_text_problem(text) {
            self.report(code, Some(field), message);
        }
    }

    fn take_flag(&mut self, field: &str) -> bool {
        match self.fields.remove(field) {
            Some(Value::Bool(flag)) => flag,
            Some(_) => {
                self.report(
                    SourceDiagnosticCode::InvalidField,
                    Some(field.into()),
                    "must be true or false".into(),
                );
                false
            }
            None => false,
        }
    }

    fn rights(&mut self, value: Value) -> Option<RightsDeclaration> {
        let mut problems = Vec::new();
        let rights = parse_rights(value, "rights", &mut |code, field, message| {
            problems.push((code, field, message));
        });
        for (code, field, message) in problems {
            self.report(code, Some(field), message);
        }
        rights
    }

    fn certainty(&mut self, value: Option<Value>, path: &str) -> Option<AttributionCertainty> {
        let mut problems = Vec::new();
        let certainty = parse_certainty(value, path, &mut |code, field, message| {
            problems.push((code, field, message));
        });
        for (code, field, message) in problems {
            self.report(code, Some(field), message);
        }
        certainty
    }

    fn take_id(&mut self, field: &str) -> Option<String> {
        let before = self.diagnostics.len();
        let id = self.take_text(field)?;
        if self.diagnostics.len() == before && !valid_source_id(&id) {
            self.report(
                SourceDiagnosticCode::InvalidId,
                Some(field.into()),
                format!(
                    "`{id}` is not a source identifier; use a lowercase ASCII slug of at most {MAX_ID_BYTES} bytes such as `plato-republic`"
                ),
            );
        }
        Some(id)
    }

    fn take_array(&mut self, field: &str) -> Vec<(String, Map<String, Value>)> {
        let Some(value) = self.fields.remove(field) else {
            return Vec::new();
        };
        let Value::Array(items) = value else {
            self.report(
                SourceDiagnosticCode::InvalidField,
                Some(field.into()),
                "must be an array of objects".into(),
            );
            return Vec::new();
        };
        let mut objects = Vec::with_capacity(items.len());
        for (position, item) in items.into_iter().enumerate() {
            let path = format!("{field}[{position}]");
            match item {
                Value::Object(object) => objects.push((path, object)),
                _ => self.report(
                    SourceDiagnosticCode::InvalidField,
                    Some(path),
                    "must be an object".into(),
                ),
            }
        }
        objects
    }

    fn nested_text(
        &mut self,
        object: &mut Map<String, Value>,
        path: &str,
        field: &str,
        required: bool,
    ) -> Option<String> {
        let full = format!("{path}.{field}");
        match object.remove(field) {
            Some(Value::String(text)) => {
                self.check_text(full, &text);
                Some(text)
            }
            Some(_) => {
                self.report(
                    SourceDiagnosticCode::InvalidField,
                    Some(full),
                    "must be a string".into(),
                );
                None
            }
            None if required => {
                self.report(
                    SourceDiagnosticCode::MissingField,
                    Some(full),
                    "is required".into(),
                );
                None
            }
            None => None,
        }
    }

    /// Credit sidecar fields never belong in a source record, at any depth.
    fn reject_credit_fields(&mut self) {
        let mut found = Vec::new();
        for (key, value) in &self.fields {
            found.extend(credit_paths(
                value,
                key.clone(),
                CREDIT_FIELDS.contains(&key.as_str()),
            ));
        }
        for field in found {
            self.report(
                SourceDiagnosticCode::ContributorCredit,
                Some(field),
                CREDIT_FIELD_MESSAGE.into(),
            );
        }
    }
}

/// Parse one raw record. Returns the identifier whenever it was readable, so
/// a broken record still owns its id, and the record only when it is valid.
fn parse_record(
    index: usize,
    raw: Value,
    diagnostics: &mut Vec<SourceDiagnostic>,
) -> (Option<String>, Option<SourceRecord>) {
    let Value::Object(fields) = raw else {
        diagnostics.push(SourceDiagnostic {
            code: SourceDiagnosticCode::InvalidField,
            index: Some(index),
            source_id: None,
            field: None,
            message: "each source must be a JSON object".into(),
        });
        return (None, None);
    };
    let mut reader = RecordReader {
        index,
        id: None,
        fields,
        diagnostics,
        failed: false,
    };

    let id = match reader.fields.get("id") {
        Some(Value::String(id)) if valid_source_id(id) => Some(id.clone()),
        _ => None,
    };
    reader.id = id.clone();
    if reader.fields.contains_key("id") {
        reader.take_id("id");
    } else {
        reader.report(
            SourceDiagnosticCode::MissingField,
            Some("id".into()),
            "every source needs a stable `id`".into(),
        );
    }
    reader.reject_credit_fields();

    let kind = match reader.fields.remove("kind") {
        Some(Value::String(kind)) => match ResearchSourceKind::parse(&kind) {
            Some(kind) => Some(kind),
            None if CREDIT_FIELDS.contains(&kind.as_str()) => {
                reader.report(
                    SourceDiagnosticCode::ContributorCredit,
                    Some("kind".into()),
                    "contributors are credited in `.credits.json` sidecars and are never sources"
                        .into(),
                );
                None
            }
            None => {
                reader.report(
                    SourceDiagnosticCode::UnknownKind,
                    Some("kind".into()),
                    format!(
                        "`{kind}` is not a source kind; use work, edition, translation, witness, or reference"
                    ),
                );
                None
            }
        },
        Some(_) => {
            reader.report(
                SourceDiagnosticCode::InvalidField,
                Some("kind".into()),
                "must be a string".into(),
            );
            None
        }
        None => {
            reader.report(
                SourceDiagnosticCode::MissingField,
                Some("kind".into()),
                "add a kind: work, edition, translation, witness, or reference".into(),
            );
            None
        }
    };

    let title = reader.take_text("title");
    let language = reader.take_text("language");
    let issued = reader.take_text("issued");
    let of = reader.take_id("of");
    let based_on = reader.take_id("basedOn");

    let mut creators = Vec::new();
    for (path, mut object) in reader.take_array("creators") {
        let name = reader.nested_text(&mut object, &path, "name", true);
        let role = reader.nested_text(&mut object, &path, "role", false);
        if role
            .as_deref()
            .is_some_and(|role| !CREATOR_ROLES.contains(&role))
        {
            reader.report(
                SourceDiagnosticCode::InvalidField,
                Some(format!("{path}.role")),
                format!("use one of: {}", CREATOR_ROLES.join(", ")),
            );
        }
        let note = reader.nested_text(&mut object, &path, "note", false);
        let attribution =
            reader.certainty(object.remove("attribution"), &format!("{path}.attribution"));
        if let Some(name) = name {
            creators.push(SourceCreator {
                name,
                role,
                attribution,
                note,
                extra: object.into_iter().collect(),
            });
        }
    }

    let mut identifiers = Vec::new();
    for (path, mut object) in reader.take_array("identifiers") {
        let scheme = reader.nested_text(&mut object, &path, "scheme", true);
        let value = reader.nested_text(&mut object, &path, "value", true);
        let (Some(scheme), Some(value)) = (scheme, value) else {
            continue;
        };
        if let Err(message) = check_identifier(&scheme, &value) {
            reader.report(SourceDiagnosticCode::InvalidIdentifier, Some(path), message);
        }
        identifiers.push(SourceIdentifier {
            scheme,
            value,
            extra: object.into_iter().collect(),
        });
    }

    let archived = reader.take_flag("archived");
    let anonymous = reader.take_flag("anonymous");
    let revises = reader.take_id("revises");
    let repository = reader.take_text("repository");
    let shelfmark = reader.take_text("shelfmark");
    let volumes = match reader.fields.remove("volumes") {
        Some(Value::Number(number))
            if number
                .as_u64()
                .is_some_and(|count| (1..=MAX_VOLUMES).contains(&count)) =>
        {
            number.as_u64()
        }
        Some(_) => {
            reader.report(
                SourceDiagnosticCode::InvalidField,
                Some("volumes".into()),
                format!("must be a whole number of volumes from 1 to {MAX_VOLUMES}"),
            );
            None
        }
        None => None,
    };
    let rights = match reader.fields.remove("rights") {
        Some(value) => reader.rights(value),
        None => None,
    };

    let location = match reader.fields.remove("location") {
        Some(Value::Object(mut object)) => {
            let scheme = reader.nested_text(&mut object, "location", "scheme", true);
            let value = reader.nested_text(&mut object, "location", "value", true);
            let volume = reader.nested_text(&mut object, "location", "volume", false);
            if let Some(scheme) = &scheme {
                if !LOCATION_SCHEMES.contains(&scheme.as_str()) {
                    reader.report(
                        SourceDiagnosticCode::InvalidField,
                        Some("location.scheme".into()),
                        format!("use one of: {}", LOCATION_SCHEMES.join(", ")),
                    );
                } else if scheme == "timestamp"
                    && value
                        .as_deref()
                        .is_some_and(|value| !valid_timestamp(value))
                {
                    reader.report(
                        SourceDiagnosticCode::InvalidField,
                        Some("location.value".into()),
                        "use seconds or `h:mm:ss`, optionally with a decimal fraction".into(),
                    );
                }
            }
            scheme.zip(value).map(|(scheme, value)| SourceLocation {
                scheme,
                value,
                volume,
                extra: object.into_iter().collect(),
            })
        }
        Some(_) => {
            reader.report(
                SourceDiagnosticCode::InvalidField,
                Some("location".into()),
                "must be an object".into(),
            );
            None
        }
        None => None,
    };
    let fields = std::mem::take(&mut reader.fields);

    if let Some(kind) = kind {
        check_kind_fields(
            &mut reader,
            kind,
            KindFields {
                title: title.is_some(),
                language: language.as_deref(),
                of: of.is_some(),
                based_on: based_on.is_some(),
                location: location.is_some(),
                revises: revises.is_some(),
                repository: repository.is_some(),
                shelfmark: shelfmark.is_some(),
                volumes: volumes.is_some(),
                rights: rights.is_some(),
                anonymous,
            },
        );
        if anonymous {
            check_anonymous(&mut reader, kind, &creators);
        }
    }

    let failed = reader.failed;
    let (Some(record_id), Some(kind), false) = (id.clone(), kind, failed) else {
        return (id, None);
    };
    let record = SourceRecord {
        id: record_id,
        kind,
        title,
        creators,
        language,
        issued,
        of,
        based_on,
        location,
        identifiers,
        archived,
        anonymous,
        revises,
        repository,
        shelfmark,
        volumes,
        rights,
        extra: fields.into_iter().collect(),
    };
    (id, Some(record))
}

struct KindFields<'a> {
    title: bool,
    language: Option<&'a str>,
    of: bool,
    based_on: bool,
    location: bool,
    revises: bool,
    repository: bool,
    shelfmark: bool,
    volumes: bool,
    rights: bool,
    anonymous: bool,
}

/// The creator role that names the maker of each kind of record, which an
/// anonymous record cannot also state.
fn maker_role(kind: ResearchSourceKind) -> Option<&'static str> {
    match kind {
        ResearchSourceKind::Work => Some("author"),
        ResearchSourceKind::Edition => Some("editor"),
        ResearchSourceKind::Translation => Some("translator"),
        ResearchSourceKind::Witness => Some("scribe"),
        ResearchSourceKind::Reference => None,
    }
}

fn check_anonymous(
    reader: &mut RecordReader<'_>,
    kind: ResearchSourceKind,
    creators: &[SourceCreator],
) {
    let Some(role) = maker_role(kind) else {
        return;
    };
    for (position, creator) in creators.iter().enumerate() {
        if creator.role.as_deref() == Some(role)
            && AttributionCertainty::names_maker(creator.attribution)
        {
            reader.report(
                SourceDiagnosticCode::ConflictingAttribution,
                Some(format!("creators[{position}].attribution")),
                format!(
                    "this {kind} is marked anonymous but states `{}` as its {role}; record the name as attributed, uncertain, or disputed, or remove `anonymous`",
                    creator.name
                ),
            );
        }
    }
}

fn check_kind_fields(
    reader: &mut RecordReader<'_>,
    kind: ResearchSourceKind,
    fields: KindFields<'_>,
) {
    if kind == ResearchSourceKind::Work && fields.of {
        reader.report(
            SourceDiagnosticCode::InvalidRelationship,
            Some("of".into()),
            "a work stands alone; record each edition, translation, or witness as its own source that points at the work".into(),
        );
    }
    if kind != ResearchSourceKind::Work && !fields.of {
        reader.report(
            SourceDiagnosticCode::MissingField,
            Some("of".into()),
            format!(
                "{} must name the source it belongs to: {}",
                kind.with_article(),
                kind_list(kind.of_targets())
            ),
        );
    }
    if kind != ResearchSourceKind::Translation && fields.based_on {
        reader.report(
            SourceDiagnosticCode::InvalidRelationship,
            Some("basedOn".into()),
            "only a translation is based on another text".into(),
        );
    }
    if kind != ResearchSourceKind::Reference && !fields.title {
        reader.report(
            SourceDiagnosticCode::MissingField,
            Some("title".into()),
            format!("{} needs a title", kind.with_article()),
        );
    }
    if kind != ResearchSourceKind::Reference && fields.location {
        reader.report(
            SourceDiagnosticCode::InvalidField,
            Some("location".into()),
            "only a reference has a location; add a reference that points at this source".into(),
        );
    }
    if fields.revises && kind != ResearchSourceKind::Edition {
        reader.report(
            SourceDiagnosticCode::InvalidRelationship,
            Some("revises".into()),
            "only an edition revises an earlier edition; a new translation is its own translation record".into(),
        );
    }
    if kind != ResearchSourceKind::Witness {
        for (present, field) in [
            (fields.repository, "repository"),
            (fields.shelfmark, "shelfmark"),
        ] {
            if present {
                reader.report(
                    SourceDiagnosticCode::InvalidField,
                    Some(field.into()),
                    "only a witness is one held copy with a repository and shelfmark".into(),
                );
            }
        }
    }
    if fields.volumes
        && !matches!(
            kind,
            ResearchSourceKind::Edition | ResearchSourceKind::Witness
        )
    {
        reader.report(
            SourceDiagnosticCode::InvalidField,
            Some("volumes".into()),
            "only an edition or a witness is published or bound in volumes".into(),
        );
    }
    if fields.rights && !kind.is_version() {
        reader.report(
            SourceDiagnosticCode::InvalidField,
            Some("rights".into()),
            format!(
                "{} has no text of its own; declare rights on the edition, translation, or witness whose text is used",
                kind.with_article()
            ),
        );
    }
    if fields.anonymous && kind == ResearchSourceKind::Reference {
        reader.report(
            SourceDiagnosticCode::InvalidField,
            Some("anonymous".into()),
            "a reference has no maker of its own; mark the work, edition, translation, or witness anonymous".into(),
        );
    }
    match fields.language {
        Some(language) if !valid_language_tag(language) => reader.report(
            SourceDiagnosticCode::InvalidField,
            Some("language".into()),
            format!("`{language}` is not a language tag such as `en` or `grc`"),
        ),
        None if kind == ResearchSourceKind::Translation => reader.report(
            SourceDiagnosticCode::MissingField,
            Some("language".into()),
            "a translation needs the language tag it was translated into".into(),
        ),
        _ => {}
    }
}

pub(crate) fn valid_source_id(value: &str) -> bool {
    value.len() <= MAX_ID_BYTES && valid_registry_key(value)
}

/// BCP 47 shape only: a 2–8 letter primary subtag and 1–8 character subtags.
pub(crate) fn valid_language_tag(value: &str) -> bool {
    let mut subtags = value.split('-');
    let primary = subtags.next().unwrap_or_default();
    (2..=8).contains(&primary.len())
        && primary.bytes().all(|byte| byte.is_ascii_alphabetic())
        && subtags.all(|subtag| {
            (1..=8).contains(&subtag.len())
                && subtag.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

pub(crate) fn valid_timestamp(value: &str) -> bool {
    let (clock, fraction) = value.split_once('.').unwrap_or((value, "0"));
    let parts: Vec<&str> = clock.split(':').collect();
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    digits(fraction)
        && (1..=3).contains(&parts.len())
        && digits(parts[0])
        && parts[1..]
            .iter()
            .all(|part| part.len() == 2 && digits(part) && part.as_bytes()[0] < b'6')
}

/// Offline structural checks for known schemes; other schemes are kept as
/// authored once their name is a lowercase slug.
pub(crate) fn check_identifier(scheme: &str, value: &str) -> Result<(), String> {
    if value.trim() != value {
        return Err("must not start or end with whitespace".into());
    }
    match scheme {
        "doi" if normalize_doi_url(value).is_none() => {
            Err("not a DOI such as `10.1234/example` or its `https://doi.org/` URL".into())
        }
        "url" if !absolute_http_url(value) => {
            Err("must be an absolute HTTP(S) URL without credentials".into())
        }
        "isbn" if !valid_isbn(value) => {
            Err("not an ISBN-10 or ISBN-13 with a valid check digit".into())
        }
        "issn" if !valid_issn(value) => Err("not an ISSN with a valid check digit".into()),
        "doi" | "url" | "isbn" | "issn" => Ok(()),
        _ if !valid_registry_key(scheme) => Err(format!(
            "`{scheme}` is not an identifier scheme; use a lowercase slug such as `oclc`"
        )),
        _ => Ok(()),
    }
}

fn check_digits(value: &str) -> Vec<u32> {
    value
        .chars()
        .filter(|character| *character != '-' && *character != ' ')
        .map(|character| match character {
            'X' | 'x' => 10,
            _ => character.to_digit(10).unwrap_or(u32::MAX),
        })
        .collect()
}

fn valid_isbn(value: &str) -> bool {
    let digits = check_digits(value);
    let body_ok = |body: &[u32]| body.iter().all(|digit| *digit < 10);
    match digits.len() {
        10 => {
            body_ok(&digits[..9])
                && digits[9] <= 10
                && digits
                    .iter()
                    .zip((1..=10).rev())
                    .map(|(digit, weight)| digit * weight)
                    .sum::<u32>()
                    % 11
                    == 0
        }
        13 => {
            body_ok(&digits)
                && digits
                    .iter()
                    .enumerate()
                    .map(|(position, digit)| if position % 2 == 0 { *digit } else { digit * 3 })
                    .sum::<u32>()
                    % 10
                    == 0
        }
        _ => false,
    }
}

fn valid_issn(value: &str) -> bool {
    let digits = check_digits(value);
    digits.len() == 8
        && digits[..7].iter().all(|digit| *digit < 10)
        && digits[7] <= 10
        && digits
            .iter()
            .zip((1..=8).rev())
            .map(|(digit, weight)| digit * weight)
            .sum::<u32>()
            % 11
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_digits_follow_isbn_and_issn_rules() {
        assert!(valid_isbn("0-8044-2957-X"));
        assert!(valid_isbn("978 0 19 924849 0"));
        assert!(!valid_isbn("X-8044-2957-0"));
        assert!(!valid_isbn("978019924849X"));
        assert!(valid_issn("2049-3630"));
        assert!(!valid_issn("2049-363"));
    }

    #[test]
    fn timestamps_and_language_tags_are_structural() {
        for accepted in ["0", "75.5", "1:05", "1:02:03.25"] {
            assert!(valid_timestamp(accepted), "{accepted}");
        }
        for rejected in ["", ":05", "1:5", "1:60", "1:02:03:04", "1.", "soon"] {
            assert!(!valid_timestamp(rejected), "{rejected}");
        }
        for accepted in ["en", "grc", "zh-Hant-TW", "en-GB-oed"] {
            assert!(valid_language_tag(accepted), "{accepted}");
        }
        for rejected in ["e", "english language", "en_GB", "en--GB", "1en"] {
            assert!(!valid_language_tag(rejected), "{rejected}");
        }
    }
}
