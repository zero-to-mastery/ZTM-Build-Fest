//! Attributed interpretations: who rendered or read one located place in one
//! version of a source, and from which text (ADR 0087).
//!
//! Interpretations live beside the records of the private source library and
//! share its file, revision, and all-or-nothing validation. They are private
//! author research: nothing here renders or publishes one, and nothing here
//! decides whether an interpretation is right, whether it agrees with another,
//! or whether its text may be reused.
//!
//! An interpretation is never a source record, so it can never be cited, and
//! naming a contributor as its interpreter reuses that contributor's identity
//! without creating a work credit or a citation.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::contributor::{valid_registry_key, Contributor};
use crate::research_notes::{bidi_override, Locator, LocatorKind};
use crate::source_library::{
    credit_paths, library_diagnostic, parse_certainty, parse_rights, short_text_problem,
    valid_language_tag, valid_source_id, valid_timestamp, AttributionCertainty, ResearchSourceKind,
    RightsDeclaration, RightsStatus, SourceDiagnostic, SourceDiagnosticCode, CREDIT_FIELDS,
    CREDIT_FIELD_MESSAGE, LOCATION_SCHEMES, RIGHTS_FIELDS,
};

/// Upper bound on interpretations in one library.
pub const MAX_INTERPRETATIONS: usize = 10_000;
/// Upper bound on the characters of one interpretation's text.
pub const MAX_INTERPRETATION_CHARS: usize = 20_000;
/// Upper bound on the locators of one interpretation.
pub const MAX_INTERPRETATION_LOCATORS: usize = 8;
/// Upper bound on the people named on one interpretation.
pub const MAX_INTERPRETERS: usize = 16;
const MAX_LOCATOR_CHARS: usize = 200;
const MAX_KEY_BYTES: usize = 64;

const INTERPRETATION_FIELDS: &[&str] = &[
    "id",
    "kind",
    "source",
    "locators",
    "language",
    "text",
    "interpreters",
    "anonymous",
    "rights",
    "uncertainty",
];
const INTERPRETER_FIELDS: &[&str] = &["contributor", "name", "attribution"];
const LOCATOR_FIELDS: &[&str] = &["kind", "value", "to"];

/// What an interpretation is. Neither is a library translation: a published
/// translation is a `translation` source with its own editions and witnesses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InterpretationKind {
    /// Someone's translation of one located place into another language.
    Rendering,
    /// Someone's reading of what one located place means.
    Reading,
}

impl InterpretationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rendering => "rendering",
            Self::Reading => "reading",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "rendering" => Some(Self::Rendering),
            "reading" => Some(Self::Reading),
            _ => None,
        }
    }
}

/// One person named as having made an interpretation: either a contributor
/// from the site's registry, by key, or anyone else by a descriptive name.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Interpreter {
    /// A contributor registry key. Attribution, never a work credit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contributor: Option<String>,
    /// A descriptive name for someone who is not a site contributor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// How firmly the interpretation is tied to this person (ADR 0086).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attribution: Option<AttributionCertainty>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Who an interpreter is, exactly one way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InterpreterIdentity<'a> {
    Contributor(&'a str),
    Named(&'a str),
}

impl Interpreter {
    pub fn contributor(key: impl Into<String>) -> Self {
        Self {
            contributor: Some(key.into()),
            name: None,
            attribution: None,
            extra: BTreeMap::new(),
        }
    }

    pub fn named(name: impl Into<String>) -> Self {
        Self {
            contributor: None,
            name: Some(name.into()),
            attribution: None,
            extra: BTreeMap::new(),
        }
    }

    /// The interpreter's identity. Validation guarantees exactly one is set.
    pub fn identity(&self) -> InterpreterIdentity<'_> {
        match (&self.contributor, &self.name) {
            (Some(key), _) => InterpreterIdentity::Contributor(key),
            (None, Some(name)) => InterpreterIdentity::Named(name),
            (None, None) => InterpreterIdentity::Named(""),
        }
    }
}

/// An attributed rendering or reading of one located place in one source.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Interpretation {
    /// Stable identity, distinct from every source identifier.
    pub id: String,
    pub kind: InterpretationKind,
    /// The library record whose text was interpreted: an edition,
    /// translation, or witness, or for a reading also a work.
    pub source: String,
    /// Where in that text, as notebook locators. Required on a rendering.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locators: Vec<Locator>,
    /// The language of `text`. Required on a rendering.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// The rendering or reading itself, stored exactly as written and never
    /// interpreted as markup here.
    pub text: String,
    /// Who made it, in order. Empty only when `anonymous`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub interpreters: Vec<Interpreter>,
    /// Nobody is named as having made it, such as an anonymous gloss.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub anonymous: bool,
    /// The author's own statement of the rights in `text` (ADR 0085).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rights: Option<RightsDeclaration>,
    /// The author's one-line note on what is uncertain about it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncertainty: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Interpretation {
    /// Read one interpretation from untrusted JSON, such as an Admin request,
    /// with the same field checks as a stored one. Field paths are relative to
    /// the interpretation; whether its source and contributors resolve is
    /// decided once it joins a library.
    pub fn from_json(value: Value) -> Result<Self, Vec<SourceDiagnostic>> {
        let mut diagnostics = Vec::new();
        let (_, interpretation) = parse_one(String::new(), value, &mut diagnostics);
        match interpretation {
            Some(interpretation) if diagnostics.is_empty() => Ok(interpretation),
            _ => Err(diagnostics),
        }
    }

    /// The declared rights status of the text, or `Unknown` when none is
    /// declared. Never a decision that a use is allowed.
    pub fn rights_status(&self) -> RightsStatus {
        self.rights
            .as_ref()
            .map_or(RightsStatus::Unknown, |rights| rights.status)
    }

    /// Paths of unknown fields that reuse a defined field's name.
    pub(crate) fn shadowed_fields(&self) -> Vec<String> {
        let mut found = Vec::new();
        let mut check = |extra: &BTreeMap<String, Value>, defined: &[&str], prefix: &str| {
            for key in extra.keys().filter(|key| defined.contains(&key.as_str())) {
                found.push(if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                });
            }
        };
        check(&self.extra, INTERPRETATION_FIELDS, "");
        for (position, interpreter) in self.interpreters.iter().enumerate() {
            check(
                &interpreter.extra,
                INTERPRETER_FIELDS,
                &format!("interpreters[{position}]"),
            );
        }
        for (position, locator) in self.locators.iter().enumerate() {
            check(
                &locator.extra,
                LOCATOR_FIELDS,
                &format!("locators[{position}]"),
            );
        }
        if let Some(rights) = &self.rights {
            check(&rights.extra, RIGHTS_FIELDS, "rights");
        }
        found
    }
}

/// The diagnostic for an interpretation identifier nobody holds.
pub(crate) fn unknown(id: &str) -> SourceDiagnostic {
    library_diagnostic(
        SourceDiagnosticCode::UnknownSource,
        Some("interpretations"),
        format!("no interpretation has the id `{id}`"),
    )
}

fn join(prefix: &str, field: &str) -> String {
    if prefix.is_empty() {
        field.into()
    } else {
        format!("{prefix}.{field}")
    }
}

/// Field-by-field reader for one raw interpretation.
struct Reader<'a> {
    prefix: String,
    fields: Map<String, Value>,
    diagnostics: &'a mut Vec<SourceDiagnostic>,
    failed: bool,
}

impl Reader<'_> {
    fn report(&mut self, code: SourceDiagnosticCode, field: &str, message: impl Into<String>) {
        self.failed = true;
        let path = join(&self.prefix, field);
        self.diagnostics.push(library_diagnostic(
            code,
            (!path.is_empty()).then_some(path.as_str()),
            message.into(),
        ));
    }

    fn short_text(&mut self, field: &str, text: &str) -> bool {
        match short_text_problem(text) {
            Some((code, message)) => {
                self.report(code, field, message);
                false
            }
            None => true,
        }
    }

    fn take_text(&mut self, field: &str) -> Option<String> {
        match self.fields.remove(field)? {
            Value::String(text) => self.short_text(field, &text).then_some(text),
            _ => {
                self.report(
                    SourceDiagnosticCode::InvalidField,
                    field,
                    "must be a string",
                );
                None
            }
        }
    }

    fn take_id(&mut self, field: &str, what: &str) -> Option<String> {
        let id = self.take_text(field)?;
        if valid_source_id(&id) {
            Some(id)
        } else {
            self.report(
                SourceDiagnosticCode::InvalidId,
                field,
                format!(
                    "`{id}` is not {what}; use a lowercase ASCII slug of at most {MAX_KEY_BYTES} bytes"
                ),
            );
            None
        }
    }

    fn take_flag(&mut self, field: &str) -> bool {
        match self.fields.remove(field) {
            Some(Value::Bool(flag)) => flag,
            Some(_) => {
                self.report(
                    SourceDiagnosticCode::InvalidField,
                    field,
                    "must be true or false",
                );
                false
            }
            None => false,
        }
    }

    /// Relay problems a shared parser reported with relative paths.
    fn relay(&mut self, problems: Vec<(SourceDiagnosticCode, String, String)>) {
        for (code, field, message) in problems {
            self.report(code, &field, message);
        }
    }

    fn credit_fields(&mut self, value: &Value, path: String, is_credit: bool) {
        for field in credit_paths(value, path, is_credit) {
            self.report(
                SourceDiagnosticCode::ContributorCredit,
                &field,
                CREDIT_FIELD_MESSAGE,
            );
        }
    }
}

/// The interpretation's text: multi-line prose, so line breaks and tabs are
/// allowed, but other control characters and invisible reordering are not.
fn text_problem(text: &str) -> Option<(SourceDiagnosticCode, String)> {
    if text.trim().is_empty() {
        Some((
            SourceDiagnosticCode::MissingField,
            "must not be empty".into(),
        ))
    } else if text.chars().count() > MAX_INTERPRETATION_CHARS {
        Some((
            SourceDiagnosticCode::TooLarge,
            format!("must be at most {MAX_INTERPRETATION_CHARS} characters"),
        ))
    } else if text
        .chars()
        .any(|c| (c.is_control() && !matches!(c, '\n' | '\r' | '\t')) || bidi_override(c))
    {
        Some((
            SourceDiagnosticCode::InvalidField,
            "must not contain control characters or bidirectional overrides".into(),
        ))
    } else {
        None
    }
}

/// Parse one raw interpretation. Returns its identifier whenever readable,
/// so a broken entry still owns its id, and the entry only when valid.
fn parse_one(
    prefix: String,
    raw: Value,
    diagnostics: &mut Vec<SourceDiagnostic>,
) -> (Option<String>, Option<Interpretation>) {
    let Value::Object(fields) = raw else {
        diagnostics.push(library_diagnostic(
            SourceDiagnosticCode::InvalidField,
            (!prefix.is_empty()).then_some(prefix.as_str()),
            "each interpretation must be a JSON object".into(),
        ));
        return (None, None);
    };
    let mut reader = Reader {
        prefix,
        fields,
        diagnostics,
        failed: false,
    };
    let known_id = match reader.fields.get("id") {
        Some(Value::String(id)) if valid_source_id(id) => Some(id.clone()),
        _ => None,
    };
    let id = if reader.fields.contains_key("id") {
        reader.take_id("id", "an interpretation identifier")
    } else {
        reader.report(
            SourceDiagnosticCode::MissingField,
            "id",
            "every interpretation needs a stable `id`",
        );
        None
    };

    // Interpreters may name a contributor; every other field may not carry
    // credit fields at any depth.
    let raw_interpreters = reader.fields.remove("interpreters");
    let had_interpreters = raw_interpreters
        .as_ref()
        .is_some_and(|value| value.as_array().is_none_or(|items| !items.is_empty()));
    let other: Vec<(String, Value)> = reader
        .fields
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    for (key, value) in other {
        let credit = CREDIT_FIELDS.contains(&key.as_str());
        reader.credit_fields(&value, key, credit);
    }

    let kind = match reader.fields.remove("kind") {
        Some(Value::String(text)) => {
            let kind = InterpretationKind::parse(&text);
            if kind.is_none() {
                reader.report(
                    SourceDiagnosticCode::UnknownKind,
                    "kind",
                    format!(
                        "`{text}` is not an interpretation kind; use `rendering` or `reading`. A published translation is a `translation` source, not an interpretation"
                    ),
                );
            }
            kind
        }
        Some(_) => {
            reader.report(
                SourceDiagnosticCode::InvalidField,
                "kind",
                "must be a string",
            );
            None
        }
        None => {
            reader.report(
                SourceDiagnosticCode::MissingField,
                "kind",
                "add a kind: `rendering` or `reading`",
            );
            None
        }
    };

    let source = if reader.fields.contains_key("source") {
        reader.take_id("source", "a source identifier")
    } else {
        reader.report(
            SourceDiagnosticCode::MissingField,
            "source",
            "name the edition, translation, or witness whose text was interpreted",
        );
        None
    };

    let language = reader.take_text("language");
    if let Some(language) = &language {
        if !valid_language_tag(language) {
            reader.report(
                SourceDiagnosticCode::InvalidField,
                "language",
                format!("`{language}` is not a language tag such as `en` or `grc`"),
            );
        }
    }

    let text = match reader.fields.remove("text") {
        Some(Value::String(text)) => match text_problem(&text) {
            Some((code, message)) => {
                reader.report(code, "text", message);
                None
            }
            None => Some(text),
        },
        Some(_) => {
            reader.report(
                SourceDiagnosticCode::InvalidField,
                "text",
                "must be a string",
            );
            None
        }
        None => {
            reader.report(
                SourceDiagnosticCode::MissingField,
                "text",
                "add the rendering or reading itself",
            );
            None
        }
    };

    let had_locators = reader
        .fields
        .get("locators")
        .is_some_and(|value| value.as_array().is_none_or(|items| !items.is_empty()));
    let locators = parse_locators(&mut reader);
    let anonymous = reader.take_flag("anonymous");
    let uncertainty = reader.take_text("uncertainty");
    let rights = match reader.fields.remove("rights") {
        Some(value) => {
            let mut problems = Vec::new();
            let rights = parse_rights(value, "rights", &mut |code, field, message| {
                problems.push((code, field, message));
            });
            reader.relay(problems);
            rights
        }
        None => None,
    };
    let interpreters = parse_interpreters(&mut reader, raw_interpreters);

    if interpreters.is_empty() && !anonymous && !had_interpreters {
        reader.report(
            SourceDiagnosticCode::MissingField,
            "interpreters",
            "name who made this interpretation, as a contributor key or a name, or mark it `anonymous`; attribution is never left implicit",
        );
    }
    if anonymous {
        for (position, interpreter) in interpreters.iter().enumerate() {
            if AttributionCertainty::names_maker(interpreter.attribution) {
                reader.report(
                    SourceDiagnosticCode::ConflictingAttribution,
                    &format!("interpreters[{position}].attribution"),
                    "this interpretation is marked anonymous but states who made it; record the name as attributed, uncertain, or disputed, or remove `anonymous`",
                );
            }
        }
    }
    if kind == Some(InterpretationKind::Rendering) {
        if language.is_none() {
            reader.report(
                SourceDiagnosticCode::MissingField,
                "language",
                "a rendering needs the language tag it renders into",
            );
        }
        if locators.is_empty() && !had_locators {
            reader.report(
                SourceDiagnosticCode::MissingField,
                "locators",
                "a rendering translates one located place; add where in the source it is",
            );
        }
    }

    let extra: BTreeMap<String, Value> = std::mem::take(&mut reader.fields).into_iter().collect();
    match (id, kind, source, text, reader.failed) {
        (Some(id), Some(kind), Some(source), Some(text), false) => (
            Some(id.clone()),
            Some(Interpretation {
                id,
                kind,
                source,
                locators,
                language,
                text,
                interpreters,
                anonymous,
                rights,
                uncertainty,
                extra,
            }),
        ),
        (id, ..) => (id.or(known_id), None),
    }
}

fn parse_locators(reader: &mut Reader<'_>) -> Vec<Locator> {
    let mut locators: Vec<Locator> = Vec::new();
    let items = match reader.fields.remove("locators") {
        None => return locators,
        Some(Value::Array(items)) if items.len() <= MAX_INTERPRETATION_LOCATORS => items,
        Some(Value::Array(_)) => {
            reader.report(
                SourceDiagnosticCode::TooLarge,
                "locators",
                format!(
                    "an interpretation may have at most {MAX_INTERPRETATION_LOCATORS} locators"
                ),
            );
            return locators;
        }
        Some(_) => {
            reader.report(
                SourceDiagnosticCode::InvalidField,
                "locators",
                "must be an array of objects",
            );
            return locators;
        }
    };
    for (position, item) in items.into_iter().enumerate() {
        let path = format!("locators[{position}]");
        let Value::Object(mut object) = item else {
            reader.report(
                SourceDiagnosticCode::InvalidField,
                &path,
                "must be an object",
            );
            continue;
        };
        let mut text = |reader: &mut Reader<'_>, field: &str, required: bool| {
            let full = format!("{path}.{field}");
            match object.remove(field) {
                Some(Value::String(text)) if text.chars().count() > MAX_LOCATOR_CHARS => {
                    reader.report(
                        SourceDiagnosticCode::TooLarge,
                        &full,
                        format!("must be at most {MAX_LOCATOR_CHARS} characters"),
                    );
                    None
                }
                Some(Value::String(text)) => reader.short_text(&full, &text).then_some(text),
                Some(_) => {
                    reader.report(
                        SourceDiagnosticCode::InvalidField,
                        &full,
                        "must be a string",
                    );
                    None
                }
                None if required => {
                    reader.report(SourceDiagnosticCode::MissingField, &full, "is required");
                    None
                }
                None => None,
            }
        };
        let kind_text = text(reader, "kind", true);
        let value = text(reader, "value", true);
        let to = text(reader, "to", false);
        let kind = kind_text.as_deref().and_then(|text| {
            let kind = LocatorKind::parse(text);
            if kind.is_none() {
                reader.report(
                    SourceDiagnosticCode::InvalidField,
                    &format!("{path}.kind"),
                    format!(
                        "use one of: {}, or an extension kind such as `x-stephanus`",
                        LOCATION_SCHEMES.join(", ")
                    ),
                );
            }
            kind
        });
        let (Some(kind), Some(value)) = (kind, value) else {
            continue;
        };
        if kind == LocatorKind::Timestamp {
            for (key, text) in [("value", Some(&value)), ("to", to.as_ref())] {
                if text.is_some_and(|text| !valid_timestamp(text)) {
                    reader.report(
                        SourceDiagnosticCode::InvalidField,
                        &format!("{path}.{key}"),
                        "use seconds or `h:mm:ss`, optionally with a decimal fraction",
                    );
                }
            }
        }
        let locator = Locator {
            kind,
            value,
            to,
            extra: object.into_iter().collect(),
        };
        if locators.iter().any(|held| {
            held.kind == locator.kind && held.value == locator.value && held.to == locator.to
        }) {
            reader.report(
                SourceDiagnosticCode::InvalidField,
                &path,
                "repeats an earlier locator",
            );
        }
        locators.push(locator);
    }
    locators
}

fn parse_interpreters(reader: &mut Reader<'_>, raw: Option<Value>) -> Vec<Interpreter> {
    let mut interpreters: Vec<Interpreter> = Vec::new();
    let items = match raw {
        None => return interpreters,
        Some(Value::Array(items)) if items.len() <= MAX_INTERPRETERS => items,
        Some(Value::Array(_)) => {
            reader.report(
                SourceDiagnosticCode::TooLarge,
                "interpreters",
                format!("an interpretation may name at most {MAX_INTERPRETERS} interpreters"),
            );
            return interpreters;
        }
        Some(_) => {
            reader.report(
                SourceDiagnosticCode::InvalidField,
                "interpreters",
                "must be an array of objects",
            );
            return interpreters;
        }
    };
    for (position, item) in items.into_iter().enumerate() {
        let path = format!("interpreters[{position}]");
        let Value::Object(mut object) = item else {
            reader.report(
                SourceDiagnosticCode::InvalidField,
                &path,
                "must be an object",
            );
            continue;
        };
        let mut text = |reader: &mut Reader<'_>, field: &str| {
            let full = format!("{path}.{field}");
            match object.remove(field) {
                Some(Value::String(text)) => reader.short_text(&full, &text).then_some(text),
                Some(_) => {
                    reader.report(
                        SourceDiagnosticCode::InvalidField,
                        &full,
                        "must be a string",
                    );
                    None
                }
                None => None,
            }
        };
        let contributor = text(reader, "contributor");
        let name = text(reader, "name");
        let mut problems = Vec::new();
        let attribution = parse_certainty(
            object.remove("attribution"),
            &format!("{path}.attribution"),
            &mut |code, field, message| problems.push((code, field, message)),
        );
        reader.relay(problems);
        for (key, value) in &object {
            let credit = CREDIT_FIELDS.contains(&key.as_str());
            reader.credit_fields(value, format!("{path}.{key}"), credit);
        }
        if let Some(key) = &contributor {
            if key.len() > MAX_KEY_BYTES || !valid_registry_key(key) {
                reader.report(
                    SourceDiagnosticCode::InvalidId,
                    &format!("{path}.contributor"),
                    format!("`{key}` is not a contributor key from the site's registry"),
                );
                continue;
            }
        }
        let interpreter = match (contributor, name) {
            (Some(_), Some(_)) => {
                reader.report(
                    SourceDiagnosticCode::InvalidField,
                    &path,
                    "name a contributor key or a name, not both; a contributor's name comes from the registry",
                );
                continue;
            }
            (None, None) => {
                reader.report(
                    SourceDiagnosticCode::MissingField,
                    &path,
                    "add a `contributor` key from the site's registry, or a `name` for anyone else",
                );
                continue;
            }
            (contributor, name) => Interpreter {
                contributor,
                name,
                attribution,
                extra: object.into_iter().collect(),
            },
        };
        if interpreters
            .iter()
            .any(|held| held.identity() == interpreter.identity())
        {
            reader.report(
                SourceDiagnosticCode::InvalidField,
                &path,
                "names an interpreter already listed",
            );
        }
        interpreters.push(interpreter);
    }
    interpreters
}

/// Parse and validate the library's `interpretations` array against its
/// records and the contributor registry. Problems are appended to
/// `diagnostics`, scoped by field path; the result is only meaningful when
/// no diagnostic was added.
pub(crate) fn parse_all(
    raw: Option<Value>,
    identities: &[(usize, String, Option<ResearchSourceKind>)],
    contributors: &BTreeMap<String, Contributor>,
    diagnostics: &mut Vec<SourceDiagnostic>,
) -> Vec<Interpretation> {
    let items = match raw {
        None => return Vec::new(),
        Some(Value::Array(items)) if items.len() <= MAX_INTERPRETATIONS => items,
        Some(Value::Array(_)) => {
            diagnostics.push(library_diagnostic(
                SourceDiagnosticCode::TooLarge,
                Some("interpretations"),
                format!("a library may hold at most {MAX_INTERPRETATIONS} interpretations"),
            ));
            return Vec::new();
        }
        Some(_) => {
            diagnostics.push(library_diagnostic(
                SourceDiagnosticCode::InvalidField,
                Some("interpretations"),
                "interpretations must be a JSON array".into(),
            ));
            return Vec::new();
        }
    };

    let sources: BTreeMap<&str, Option<ResearchSourceKind>> = identities
        .iter()
        .map(|(_, id, kind)| (id.as_str(), *kind))
        .collect();
    let mut owners: BTreeMap<String, usize> = BTreeMap::new();
    let mut parsed = Vec::with_capacity(items.len());
    for (index, raw) in items.into_iter().enumerate() {
        let prefix = format!("interpretations[{index}]");
        let (id, interpretation) = parse_one(prefix.clone(), raw, diagnostics);
        let duplicate = id.as_ref().and_then(|id| {
            if sources.contains_key(id.as_str()) {
                Some(format!(
                    "`{id}` is already a source identifier; interpretations and sources share one set of ids so a citation key never names an interpretation"
                ))
            } else if let Some(first) = owners.get(id) {
                Some(format!(
                    "`{id}` is already used by interpretations[{first}]; every interpretation needs its own id"
                ))
            } else {
                owners.insert(id.clone(), index);
                None
            }
        });
        if let Some(message) = duplicate {
            diagnostics.push(library_diagnostic(
                SourceDiagnosticCode::DuplicateId,
                Some(&format!("{prefix}.id")),
                message,
            ));
            continue;
        }
        if let Some(interpretation) = interpretation {
            parsed.push((index, interpretation));
        }
    }

    for (index, interpretation) in &parsed {
        let report = |code, field: &str, message: String| {
            library_diagnostic(
                code,
                Some(&format!("interpretations[{index}].{field}")),
                message,
            )
        };
        let source = interpretation.source.as_str();
        match sources.get(source) {
            None if contributors.contains_key(source) => diagnostics.push(report(
                SourceDiagnosticCode::ContributorCredit,
                "source",
                format!(
                    "`{source}` is a contributor; name contributors as interpreters, and point `source` at the text they interpreted"
                ),
            )),
            None if owners.contains_key(source) => diagnostics.push(report(
                SourceDiagnosticCode::InvalidRelationship,
                "source",
                format!(
                    "`{source}` is an interpretation; point `source` at the edition, translation, or witness it was made from"
                ),
            )),
            None => diagnostics.push(report(
                SourceDiagnosticCode::UnresolvedRelationship,
                "source",
                format!("no source has the id `{source}`"),
            )),
            // A record that failed to parse was already reported.
            Some(None) => {}
            Some(Some(kind)) => {
                if let Some(message) = source_kind_problem(interpretation, source, *kind) {
                    diagnostics.push(report(
                        SourceDiagnosticCode::InvalidRelationship,
                        "source",
                        message,
                    ));
                } else {
                    for (position, locator) in interpretation.locators.iter().enumerate() {
                        if let Some(message) = locator_problem(*kind, source, locator) {
                            diagnostics.push(report(
                                SourceDiagnosticCode::AmbiguousLocation,
                                &format!("locators[{position}].kind"),
                                message,
                            ));
                        }
                    }
                }
            }
        }
        let mut seen = BTreeSet::new();
        for (position, interpreter) in interpretation.interpreters.iter().enumerate() {
            let Some(key) = &interpreter.contributor else {
                continue;
            };
            if !contributors.contains_key(key) && seen.insert(key) {
                diagnostics.push(report(
                    SourceDiagnosticCode::UnresolvedRelationship,
                    &format!("interpreters[{position}].contributor"),
                    format!(
                        "no contributor has the key `{key}`; add them to the site's contributor registry or give a `name` instead"
                    ),
                ));
            }
        }
    }
    parsed
        .into_iter()
        .map(|(_, interpretation)| interpretation)
        .collect()
}

/// Why an interpretation cannot be made from a record of this kind, if not.
fn source_kind_problem(
    interpretation: &Interpretation,
    source: &str,
    kind: ResearchSourceKind,
) -> Option<String> {
    match (interpretation.kind, kind) {
        (_, ResearchSourceKind::Reference) => Some(format!(
            "`{source}` is a reference; point `source` at the version it points into and give the place as `locators`"
        )),
        (InterpretationKind::Rendering, ResearchSourceKind::Work) => Some(format!(
            "`{source}` is a work, which has no text of its own; point a rendering at the edition, translation, or witness it was made from"
        )),
        _ => None,
    }
}

/// Why a locator cannot address a record of this kind, if not.
fn locator_problem(kind: ResearchSourceKind, source: &str, locator: &Locator) -> Option<String> {
    match locator.kind {
        LocatorKind::Page if kind == ResearchSourceKind::Work => Some(format!(
            "pages differ between editions of a work; point the interpretation at the edition, translation, or witness whose pages are meant, not `{source}`"
        )),
        LocatorKind::Folio if kind != ResearchSourceKind::Witness => Some(format!(
            "folios belong to one manuscript or copy; point the interpretation at a witness, not `{source}`"
        )),
        _ => None,
    }
}
