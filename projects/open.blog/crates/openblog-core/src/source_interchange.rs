//! Standards-compatible interchange for the private source library: a
//! dry-run-first CSL JSON import and deterministic CSL JSON and BibTeX export.
//!
//! Import never writes. [`plan_csl_import`] reads untrusted text and reports,
//! item by item, what would be created, updated, left alone, or refused, plus
//! every field the library cannot represent. Only [`ImportPlan::apply`] builds
//! a changed library, and only when nothing conflicts. Merging an item into an
//! existing record only ever adds or replaces what the item states, so richer
//! open.blog metadata (relationships, locations, unknown fields, extra
//! creators and identifiers) survives a re-import, and importing the same
//! file twice changes nothing. See ADR 0012.
//!
//! Nothing here contacts a metadata service or decides what a source proves.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use blake2::{Blake2b512, Digest};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::citations::{public_identifier, PublicReference};
use crate::contributor::{valid_registry_key, Contributor};
use crate::research::normalize_doi_url;
use crate::source_library::{
    ResearchSourceKind, SourceCreator, SourceDiagnostic, SourceDiagnosticCode, SourceIdentifier,
    SourceLibrary, SourceRecord, MAX_TEXT_CHARS, RECORD_FIELDS,
};

/// Upper bound on a CSL JSON import, checked before parsing.
pub const MAX_IMPORT_BYTES: usize = 2 * 1024 * 1024;
/// Upper bound on the items in one import.
pub const MAX_IMPORT_ITEMS: usize = 5_000;
const MAX_ID_BYTES: usize = 64;

/// CSL name variables the library records as creator roles.
pub(crate) const NAME_ROLES: [&str; 3] = ["author", "editor", "translator"];
/// Name parts kept on a creator so an export can rebuild the CSL name.
const NAME_PARTS: [&str; 5] = [
    "family",
    "given",
    "dropping-particle",
    "non-dropping-particle",
    "suffix",
];
/// Identifier schemes with a dedicated CSL variable, in output order.
pub(crate) const IDENTIFIER_FIELDS: [(&str, &str); 6] = [
    ("doi", "DOI"),
    ("isbn", "ISBN"),
    ("issn", "ISSN"),
    ("url", "URL"),
    ("pmid", "PMID"),
    ("pmcid", "PMCID"),
];
/// CSL variables with no source-library field. Their text or number is kept
/// verbatim under the record's `csl` field.
pub(crate) const PRESERVED_FIELDS: &[&str] = &[
    "archive",
    "archive_location",
    "collection-title",
    "container-title",
    "edition",
    "event-title",
    "genre",
    "issue",
    "medium",
    "number",
    "number-of-pages",
    "number-of-volumes",
    "original-title",
    "page",
    "publisher",
    "publisher-place",
    "source",
    "title-short",
    "volume",
];
/// Private notes never enter the library through an import, so they cannot
/// reach an export a person shares.
pub(crate) const NOTE_FIELDS: &[&str] = &["abstract", "annote", "keyword", "note"];
const CUSTOM_KEYS: [&str; 14] = [
    "openblog-kind",
    "openblog-of",
    "openblog-basedOn",
    "openblog-location",
    "openblog-archived",
    "openblog-creators",
    "openblog-identifiers",
    "openblog-extra",
    "openblog-anonymous",
    "openblog-revises",
    "openblog-repository",
    "openblog-shelfmark",
    "openblog-volumes",
    "openblog-rights",
];
/// Version provenance fields (ADR 0084, 0085, 0086) that CSL has no variable
/// for. Each travels verbatim in its own `custom` key, so an export imports
/// back unchanged. CSL's own `archive`, `archive_location`, and
/// `number-of-volumes` stay preserved CSL description and are never read as
/// these fields.
const PROVENANCE_FIELDS: [(&str, &str); 6] = [
    ("openblog-anonymous", "anonymous"),
    ("openblog-revises", "revises"),
    ("openblog-repository", "repository"),
    ("openblog-shelfmark", "shelfmark"),
    ("openblog-volumes", "volumes"),
    ("openblog-rights", "rights"),
];
/// Strong identifiers that mark two records as the same published thing.
const DUPLICATE_SCHEMES: [&str; 5] = ["doi", "isbn", "issn", "pmid", "pmcid"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportAction {
    Create,
    Update,
    Unchanged,
    Conflict,
}

/// One top-level record field an update would change.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FieldChange {
    pub field: String,
    pub before: Option<Value>,
    pub after: Option<Value>,
}

/// A field that cannot be carried across, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Loss {
    pub field: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEntry {
    /// Zero-based position in the imported array.
    pub index: usize,
    /// The identifier the item carried.
    pub csl_id: Option<String>,
    /// The stable source identifier the item maps to.
    pub source_id: Option<String>,
    pub action: ImportAction,
    /// What an update changes, field by field.
    pub changes: Vec<FieldChange>,
    /// Fields the existing record has that the item does not state, which an
    /// import leaves exactly as they are.
    pub kept: Vec<String>,
    /// Item fields the library does not store.
    pub unsupported: Vec<Loss>,
    pub diagnostics: Vec<SourceDiagnostic>,
    /// For a conflict caused by a duplicate, the source it duplicates.
    pub duplicate_of: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ImportCounts {
    pub create: usize,
    pub update: usize,
    pub unchanged: usize,
    pub conflict: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ImportPlan {
    pub entries: Vec<ImportEntry>,
    /// Problems that belong to no single item.
    pub diagnostics: Vec<SourceDiagnostic>,
    pub counts: ImportCounts,
    #[serde(skip)]
    records: Vec<SourceRecord>,
}

impl ImportPlan {
    /// Whether the plan can be applied: nothing conflicts.
    pub fn is_applicable(&self) -> bool {
        self.counts.conflict == 0 && self.diagnostics.is_empty()
    }

    /// Whether applying the plan would change the library.
    pub fn has_changes(&self) -> bool {
        self.counts.create + self.counts.update > 0
    }

    /// Every problem that blocks the plan, each scoped to its item.
    pub fn blockers(&self) -> Vec<SourceDiagnostic> {
        let mut blockers = Vec::new();
        for entry in &self.entries {
            for diagnostic in &entry.diagnostics {
                let mut diagnostic = diagnostic.clone();
                diagnostic.message = format!("items[{}]: {}", entry.index, diagnostic.message);
                blockers.push(diagnostic);
            }
        }
        blockers.extend(self.diagnostics.iter().cloned());
        blockers
    }

    /// The library with the planned creates and updates, validated as a
    /// whole. A plan with any conflict applies nothing.
    pub fn apply(
        &self,
        library: &SourceLibrary,
        contributors: &BTreeMap<String, Contributor>,
    ) -> Result<SourceLibrary, Vec<SourceDiagnostic>> {
        if !self.is_applicable() {
            return Err(self.blockers());
        }
        library.with_records(self.records.clone(), contributors)
    }
}

fn file_diagnostic(code: SourceDiagnosticCode, message: String) -> SourceDiagnostic {
    SourceDiagnostic {
        code,
        index: None,
        source_id: None,
        field: None,
        message,
    }
}

fn problem(
    code: SourceDiagnosticCode,
    id: Option<&str>,
    field: &str,
    message: impl Into<String>,
) -> SourceDiagnostic {
    SourceDiagnostic {
        code,
        index: None,
        source_id: id.map(str::to_string),
        field: Some(field.into()),
        message: message.into(),
    }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// What one CSL item says, ready to become a record.
struct Mapped {
    csl_id: Option<String>,
    id: Option<String>,
    object: Map<String, Value>,
    /// Record fields the item states, as opposed to defaults.
    provided: BTreeSet<String>,
    unsupported: Vec<Loss>,
    problems: Vec<SourceDiagnostic>,
}

/// Read CSL JSON and report what importing it would do. Nothing is written.
/// Failures that make the whole file unreadable are returned as `Err`;
/// everything else is scoped to its item.
pub fn plan_csl_import(
    library: &SourceLibrary,
    text: &str,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<ImportPlan, Vec<SourceDiagnostic>> {
    if text.len() > MAX_IMPORT_BYTES {
        return Err(vec![file_diagnostic(
            SourceDiagnosticCode::TooLarge,
            format!("a CSL JSON import may be at most {MAX_IMPORT_BYTES} bytes"),
        )]);
    }
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let items = match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(items)) => items,
        Ok(_) => {
            return Err(vec![file_diagnostic(
                SourceDiagnosticCode::InvalidField,
                "CSL JSON must be an array of items".into(),
            )])
        }
        Err(error) => {
            return Err(vec![file_diagnostic(
                SourceDiagnosticCode::InvalidJson,
                format!("invalid JSON: {error}"),
            )])
        }
    };
    if items.len() > MAX_IMPORT_ITEMS {
        return Err(vec![file_diagnostic(
            SourceDiagnosticCode::TooLarge,
            format!("a CSL JSON import may hold at most {MAX_IMPORT_ITEMS} items"),
        )]);
    }

    let mapped: Vec<Mapped> = items.into_iter().map(map_item).collect();
    let mut entries: Vec<ImportEntry> = Vec::with_capacity(mapped.len());
    let mut records: Vec<Option<SourceRecord>> = Vec::with_capacity(mapped.len());
    let mut first_by_id: BTreeMap<String, usize> = BTreeMap::new();
    let mut seen_identifiers: BTreeMap<(String, String), String> = BTreeMap::new();
    let mut id_uses: BTreeMap<&str, usize> = BTreeMap::new();
    for item in &mapped {
        if let Some(id) = &item.id {
            *id_uses.entry(id).or_default() += 1;
        }
    }

    for (index, item) in mapped.iter().enumerate() {
        let mut entry = ImportEntry {
            index,
            csl_id: item.csl_id.clone(),
            source_id: item.id.clone(),
            action: ImportAction::Conflict,
            changes: Vec::new(),
            kept: Vec::new(),
            unsupported: item.unsupported.clone(),
            diagnostics: item.problems.clone(),
            duplicate_of: None,
        };
        let mut record = None;
        if entry.diagnostics.is_empty() {
            // An item that matches a stored record is validated as that
            // record with the stated fields applied, not as a standalone one.
            let mut object = item.object.clone();
            if let Some(existing) = item.id.as_deref().and_then(|id| library.get(id)) {
                if !item.provided.contains("kind") {
                    object.remove("kind");
                }
                let mut base = record_map(existing);
                base.extend(object);
                object = base;
            }
            match SourceRecord::from_json(Value::Object(object)) {
                Ok(parsed) => record = Some(parsed),
                Err(diagnostics) => entry.diagnostics = diagnostics,
            }
        }
        if let (Some(parsed), Some(id)) = (record.clone(), item.id.clone()) {
            let (parsed, id) = (&parsed, &id);
            if id_uses.get(id.as_str()).copied().unwrap_or(0) > 1 {
                let first = *first_by_id.entry(id.clone()).or_insert(index);
                entry.diagnostics.push(problem(
                    SourceDiagnosticCode::DuplicateId,
                    Some(id),
                    "id",
                    if first == index {
                        format!("more than one item maps to `{id}`; give each item its own id")
                    } else {
                        format!("items[{first}] already maps to `{id}`; give each item its own id")
                    },
                ));
                entry.duplicate_of = Some(id.clone());
                record = None;
            } else if let Some(existing) = library.get(id) {
                let explicit_kind = item.provided.contains("kind");
                if explicit_kind && existing.kind != parsed.kind {
                    entry.diagnostics.push(problem(
                        SourceDiagnosticCode::KindChanged,
                        Some(id),
                        "kind",
                        format!(
                            "`{id}` is already a {}; an import cannot turn it into a {}",
                            existing.kind, parsed.kind
                        ),
                    ));
                    record = None;
                } else {
                    match merge(existing, parsed, &item.provided) {
                        Err(conflicts) => {
                            entry.diagnostics.extend(conflicts);
                            record = None;
                        }
                        Ok(merged) => {
                            entry.changes = diff(existing, &merged);
                            entry.kept = kept_fields(existing, &item.provided);
                            entry.action = if entry.changes.is_empty() {
                                ImportAction::Unchanged
                            } else {
                                ImportAction::Update
                            };
                            // Identifiers the update adds must not belong to another record.
                            let mut added = merged.clone();
                            added.identifiers.retain(|identifier| {
                                let key = identifier_key(&identifier.scheme, &identifier.value);
                                !existing
                                    .identifiers
                                    .iter()
                                    .any(|held| identifier_key(&held.scheme, &held.value) == key)
                            });
                            if let Some(other) =
                                duplicate_identifier(library, &added, id, &mut seen_identifiers)
                            {
                                entry.diagnostics.push(problem(
                            SourceDiagnosticCode::DuplicateId,
                            Some(id),
                            "identifiers",
                            format!(
                                "shares an identifier with `{other}`; import it under the id `{other}` or remove the duplicate"
                            ),
                        ));
                                entry.duplicate_of = Some(other);
                                entry.changes = Vec::new();
                                record = None;
                            } else {
                                record = Some(merged);
                            }
                        }
                    }
                }
            } else if library.interpretation(id).is_some() {
                // Sources and interpretations share one set of ids (ADR 0087).
                entry.diagnostics.push(problem(
                    SourceDiagnosticCode::DuplicateId,
                    Some(id),
                    "id",
                    format!(
                        "`{id}` is already used by an interpretation; sources and interpretations share one set of ids, so give the item another id"
                    ),
                ));
                record = None;
            } else if let Some(other) =
                duplicate_identifier(library, parsed, id, &mut seen_identifiers)
            {
                entry.diagnostics.push(problem(
                    SourceDiagnosticCode::DuplicateId,
                    Some(id),
                    "identifiers",
                    format!(
                        "shares an identifier with `{other}`; import it under the id `{other}` or remove the duplicate"
                    ),
                ));
                entry.duplicate_of = Some(other);
                record = None;
            } else {
                entry.action = ImportAction::Create;
            }
        }
        if !entry.diagnostics.is_empty() {
            entry.action = ImportAction::Conflict;
            record = None;
        }
        entries.push(entry);
        records.push(record);
    }

    // Relationships are checked across the whole result, so items may point
    // at each other and at existing sources in any order.
    let mut plan_diagnostics = Vec::new();
    let planned: Vec<SourceRecord> = records
        .iter()
        .zip(&entries)
        .filter(|(_, entry)| matches!(entry.action, ImportAction::Create | ImportAction::Update))
        .filter_map(|(record, _)| record.clone())
        .collect();
    if let Err(diagnostics) = library.with_records(planned, contributors) {
        for diagnostic in diagnostics {
            let owner = diagnostic.source_id.as_deref().and_then(|id| {
                entries.iter_mut().find(|entry| {
                    entry.source_id.as_deref() == Some(id)
                        && matches!(entry.action, ImportAction::Create | ImportAction::Update)
                })
            });
            match owner {
                Some(entry) => {
                    entry.action = ImportAction::Conflict;
                    entry.diagnostics.push(SourceDiagnostic {
                        index: None,
                        ..diagnostic
                    });
                }
                None => plan_diagnostics.push(SourceDiagnostic {
                    index: None,
                    ..diagnostic
                }),
            }
        }
    }

    let mut counts = ImportCounts::default();
    for entry in &entries {
        match entry.action {
            ImportAction::Create => counts.create += 1,
            ImportAction::Update => counts.update += 1,
            ImportAction::Unchanged => counts.unchanged += 1,
            ImportAction::Conflict => counts.conflict += 1,
        }
    }
    let records = records
        .into_iter()
        .zip(&entries)
        .filter(|(_, entry)| matches!(entry.action, ImportAction::Create | ImportAction::Update))
        .filter_map(|(record, _)| record)
        .collect();
    Ok(ImportPlan {
        entries,
        diagnostics: plan_diagnostics,
        counts,
        records,
    })
}

/// A stable source identifier for a CSL id: its lowercase ASCII slug, or a
/// short digest when the id has no usable slug, so distinct non-ASCII ids
/// never collapse into each other.
pub(crate) fn derive_id(raw: &str) -> String {
    if raw.is_ascii() {
        let mut slug = String::new();
        let mut separator = false;
        for character in raw.chars() {
            if character.is_ascii_alphanumeric() {
                if separator && !slug.is_empty() {
                    slug.push('-');
                }
                separator = false;
                slug.push(character.to_ascii_lowercase());
            } else {
                separator = true;
            }
        }
        if !slug.is_empty() && slug.len() <= MAX_ID_BYTES && valid_registry_key(&slug) {
            return slug;
        }
    }
    let digest = Blake2b512::digest(raw.as_bytes());
    let mut id = String::from("csl-");
    for byte in digest.iter().take(8) {
        let _ = write!(id, "{byte:02x}");
    }
    id
}

fn is_plain_text(text: &str) -> bool {
    !text.trim().is_empty()
        && text.chars().count() <= MAX_TEXT_CHARS
        && !text.chars().any(char::is_control)
}

fn map_item(raw: Value) -> Mapped {
    let mut mapped = Mapped {
        csl_id: None,
        id: None,
        object: Map::new(),
        provided: BTreeSet::new(),
        unsupported: Vec::new(),
        problems: Vec::new(),
    };
    let Value::Object(mut item) = raw else {
        mapped.problems.push(problem(
            SourceDiagnosticCode::InvalidField,
            None,
            "item",
            "each CSL item must be a JSON object",
        ));
        return mapped;
    };
    let csl_id = match item.remove("id") {
        Some(Value::String(text)) if !text.trim().is_empty() => text,
        Some(Value::Number(number)) => number.to_string(),
        _ => {
            mapped.problems.push(problem(
                SourceDiagnosticCode::MissingField,
                None,
                "id",
                "every item needs a non-empty `id`, which becomes its stable source id",
            ));
            return mapped;
        }
    };
    if csl_id.chars().count() > MAX_TEXT_CHARS || csl_id.chars().any(char::is_control) {
        mapped.problems.push(problem(
            SourceDiagnosticCode::InvalidField,
            None,
            "id",
            "the item id must be short text without control characters",
        ));
        return mapped;
    }
    let id = derive_id(&csl_id);
    mapped.csl_id = Some(csl_id);
    mapped.id = Some(id.clone());
    let id = id.as_str();
    mapped.object.insert("id".into(), Value::String(id.into()));
    let mut problems: Vec<SourceDiagnostic> = Vec::new();
    let mut unsupported: Vec<Loss> = Vec::new();
    let mut provided: BTreeSet<String> = BTreeSet::new();

    // The item type is kept with the other preserved CSL variables. The
    // generic `document` type is the export default, so it is not stored.
    let mut bag = Map::new();
    match item.remove("type") {
        Some(Value::String(kind)) if kind != "document" && is_plain_text(&kind) => {
            bag.insert("type".into(), Value::String(kind));
        }
        Some(Value::String(kind)) if kind == "document" => {}
        Some(_) => problems.push(problem(
            SourceDiagnosticCode::InvalidField,
            Some(id),
            "type",
            "must be short text",
        )),
        None => {}
    }

    let mut custom = match item.remove("custom") {
        Some(Value::Object(custom)) => custom,
        Some(_) => {
            problems.push(problem(
                SourceDiagnosticCode::InvalidField,
                Some(id),
                "custom",
                "must be an object",
            ));
            Map::new()
        }
        None => Map::new(),
    };

    // Kind defaults to a work; only an explicit open.blog kind is "provided".
    let kind = custom.remove("openblog-kind");
    if kind.is_some() {
        provided.insert("kind".into());
    }
    mapped
        .object
        .insert("kind".into(), kind.unwrap_or_else(|| "work".into()));
    for (custom_key, field) in [
        ("openblog-of", "of"),
        ("openblog-basedOn", "basedOn"),
        ("openblog-location", "location"),
        ("openblog-archived", "archived"),
    ]
    .into_iter()
    .chain(PROVENANCE_FIELDS)
    {
        if let Some(value) = custom.remove(custom_key) {
            provided.insert(field.into());
            mapped.object.insert(field.into(), value);
        }
    }
    if let Some(value) = item.remove("title") {
        provided.insert("title".into());
        mapped.object.insert("title".into(), value);
    }
    if let Some(value) = item.remove("language") {
        provided.insert("language".into());
        mapped.object.insert("language".into(), value);
    }
    match item.remove("issued") {
        None | Some(Value::Null) => {}
        Some(date) => match date_from_csl(&date, &mut unsupported) {
            Ok(text) => {
                provided.insert("issued".into());
                mapped.object.insert("issued".into(), Value::String(text));
            }
            Err(message) => problems.push(problem(
                SourceDiagnosticCode::InvalidField,
                Some(id),
                "issued",
                message,
            )),
        },
    }

    // Creators: the standard CSL name variables, unless a verified
    // open.blog envelope says the same thing with full fidelity.
    let mut standard_names = Map::new();
    for role in NAME_ROLES {
        if let Some(value) = item.remove(role) {
            standard_names.insert(role.into(), value);
        }
    }
    let envelope = take_array(&mut custom, "openblog-creators", id, &mut problems);
    let creators = match envelope {
        Some(values) if creators_to_csl(&values) == standard_names => Some(values),
        other => {
            if other.is_some() {
                unsupported.push(Loss {
                    field: "custom.openblog-creators".into(),
                    reason: "does not match the item's author, editor, and translator lists, which were edited elsewhere; the lists win".into(),
                });
            }
            names_from_csl(&standard_names, id, &mut problems, &mut unsupported)
        }
    };
    if let Some(creators) = creators.filter(|creators| !creators.is_empty()) {
        provided.insert("creators".into());
        mapped
            .object
            .insert("creators".into(), Value::Array(creators));
    }

    // Identifiers follow the same rule.
    let mut standard_ids = Map::new();
    for (_, key) in IDENTIFIER_FIELDS {
        if let Some(value) = item.remove(key) {
            standard_ids.insert(key.into(), value);
        }
    }
    let envelope = take_array(&mut custom, "openblog-identifiers", id, &mut problems);
    let identifiers = match envelope {
        Some(values) if identifiers_to_csl(&values) == standard_ids => Some(values),
        other => {
            if other.is_some() {
                unsupported.push(Loss {
                    field: "custom.openblog-identifiers".into(),
                    reason: "does not match the item's identifier fields, which were edited elsewhere; the fields win".into(),
                });
            }
            identifiers_from_csl(&standard_ids, id, &mut problems)
        }
    };
    if let Some(identifiers) = identifiers.filter(|identifiers| !identifiers.is_empty()) {
        provided.insert("identifiers".into());
        mapped
            .object
            .insert("identifiers".into(), Value::Array(identifiers));
    }

    // Preserved CSL variables and open.blog's own unknown fields.
    for key in PRESERVED_FIELDS {
        match item.remove(*key) {
            Some(value @ (Value::String(_) | Value::Number(_))) => {
                if value.as_str().is_some_and(|text| !is_plain_text(text)) {
                    problems.push(problem(
                        SourceDiagnosticCode::InvalidField,
                        Some(id),
                        key,
                        "must be short text without control characters",
                    ));
                } else {
                    bag.insert((*key).into(), value);
                }
            }
            Some(_) => unsupported.push(Loss {
                field: (*key).into(),
                reason: "only text and numbers are kept for this variable".into(),
            }),
            None => {}
        }
    }
    match custom.remove("openblog-extra") {
        Some(Value::Object(extra)) => {
            for (key, value) in extra {
                if key == "csl" {
                    match value {
                        Value::Object(rest) => {
                            for (name, value) in rest {
                                if NOTE_FIELDS.contains(&name.as_str()) {
                                    unsupported.push(Loss {
                                        field: format!("custom.openblog-extra.csl.{name}"),
                                        reason: "private notes and abstracts are never imported, so they cannot reach a public artifact".into(),
                                    });
                                } else if matches!(&value, Value::String(text) if is_plain_text(text))
                                    || value.is_number()
                                {
                                    bag.insert(name, value);
                                } else if matches!(value, Value::String(_)) {
                                    problems.push(problem(
                                        SourceDiagnosticCode::InvalidField,
                                        Some(id),
                                        &format!("custom.openblog-extra.csl.{name}"),
                                        "must be short text without control characters",
                                    ));
                                } else {
                                    unsupported.push(Loss {
                                        field: format!("custom.openblog-extra.csl.{name}"),
                                        reason: "only text and numbers are kept for this variable"
                                            .into(),
                                    });
                                }
                            }
                        }
                        _ => problems.push(problem(
                            SourceDiagnosticCode::InvalidField,
                            Some(id),
                            "custom.openblog-extra.csl",
                            "must be an object",
                        )),
                    }
                } else if NOTE_FIELDS.contains(&key.as_str()) {
                    unsupported.push(Loss {
                        field: format!("custom.openblog-extra.{key}"),
                        reason: "private notes and abstracts are never imported, so they cannot reach a public artifact".into(),
                    });
                } else if RECORD_FIELDS.contains(&key.as_str()) || mapped.object.contains_key(&key)
                {
                    problems.push(problem(
                        SourceDiagnosticCode::InvalidField,
                        Some(id),
                        &format!("custom.openblog-extra.{key}"),
                        "an unknown field cannot shadow a defined field",
                    ));
                } else {
                    provided.insert(key.clone());
                    mapped.object.insert(key, value);
                }
            }
        }
        Some(_) => problems.push(problem(
            SourceDiagnosticCode::InvalidField,
            Some(id),
            "custom.openblog-extra",
            "must be an object",
        )),
        None => {}
    }
    if !bag.is_empty() {
        provided.insert("csl".into());
        mapped.object.insert("csl".into(), Value::Object(bag));
    }

    // Everything left is reported, never silently dropped.
    for key in custom.keys() {
        unsupported.push(Loss {
            field: format!("custom.{key}"),
            reason: "not an open.blog custom field".into(),
        });
    }
    for key in item.keys() {
        let reason = if NOTE_FIELDS.contains(&key.as_str()) {
            "private notes and abstracts are never imported, so they cannot reach a public artifact"
        } else if key == "custom" {
            continue;
        } else {
            "the source library does not store this CSL variable"
        };
        unsupported.push(Loss {
            field: key.clone(),
            reason: reason.into(),
        });
    }
    unsupported.sort_by(|left, right| left.field.cmp(&right.field));
    mapped.provided = provided;
    mapped.unsupported = unsupported;
    mapped.problems = problems;
    mapped
}

fn take_array(
    custom: &mut Map<String, Value>,
    key: &str,
    id: &str,
    problems: &mut Vec<SourceDiagnostic>,
) -> Option<Vec<Value>> {
    match custom.remove(key)? {
        Value::Array(values) => Some(values),
        _ => {
            problems.push(problem(
                SourceDiagnosticCode::InvalidField,
                Some(id),
                &format!("custom.{key}"),
                "must be an array",
            ));
            None
        }
    }
}

/// CSL name variables to creator objects. A structured name keeps its parts
/// beside the display name so an export can rebuild it.
fn names_from_csl(
    standard: &Map<String, Value>,
    id: &str,
    problems: &mut Vec<SourceDiagnostic>,
    unsupported: &mut Vec<Loss>,
) -> Option<Vec<Value>> {
    let mut creators = Vec::new();
    for role in NAME_ROLES {
        let Some(value) = standard.get(role) else {
            continue;
        };
        let Value::Array(names) = value else {
            problems.push(problem(
                SourceDiagnosticCode::InvalidField,
                Some(id),
                role,
                "must be an array of names",
            ));
            continue;
        };
        for (position, name) in names.iter().enumerate() {
            let path = format!("{role}[{position}]");
            let Value::Object(name) = name else {
                problems.push(problem(
                    SourceDiagnosticCode::InvalidField,
                    Some(id),
                    &path,
                    "must be a name object",
                ));
                continue;
            };
            let mut creator = Map::new();
            let mut display = None;
            if let Some(literal) = name.get("literal") {
                match literal.as_str() {
                    Some(text) => display = Some(text.to_string()),
                    None => problems.push(problem(
                        SourceDiagnosticCode::InvalidField,
                        Some(id),
                        &format!("{path}.literal"),
                        "must be text",
                    )),
                }
            } else {
                let mut parts = Vec::new();
                for part in NAME_PARTS {
                    match name.get(part) {
                        Some(Value::String(text)) => {
                            creator.insert(part.into(), Value::String(text.clone()));
                            parts.push((part, text.as_str()));
                        }
                        Some(_) => problems.push(problem(
                            SourceDiagnosticCode::InvalidField,
                            Some(id),
                            &format!("{path}.{part}"),
                            "must be text",
                        )),
                        None => {}
                    }
                }
                if parts.is_empty() {
                    problems.push(problem(
                        SourceDiagnosticCode::MissingField,
                        Some(id),
                        &path,
                        "a name needs `literal`, `family`, or `given`",
                    ));
                    continue;
                }
                let mut text = [
                    "given",
                    "dropping-particle",
                    "non-dropping-particle",
                    "family",
                ]
                .iter()
                .filter_map(|wanted| {
                    parts
                        .iter()
                        .find(|(part, _)| part == wanted)
                        .map(|(_, text)| *text)
                })
                .collect::<Vec<_>>()
                .join(" ");
                if let Some((_, suffix)) = parts.iter().find(|(part, _)| *part == "suffix") {
                    text = if text.is_empty() {
                        (*suffix).to_string()
                    } else {
                        format!("{text}, {suffix}")
                    };
                }
                display = Some(text);
            }
            for key in name.keys() {
                if key != "literal" && !NAME_PARTS.contains(&key.as_str()) {
                    unsupported.push(Loss {
                        field: format!("{path}.{key}"),
                        reason: "the source library does not store this name option".into(),
                    });
                }
            }
            let Some(display) = display else {
                continue;
            };
            creator.insert("name".into(), Value::String(display));
            creator.insert("role".into(), Value::String(role.into()));
            creators.push(Value::Object(creator));
        }
    }
    Some(creators)
}

/// Creator objects to the CSL name variables they can be written as. Roles
/// CSL has no variable for are not listed; the open.blog envelope carries them.
fn creators_to_csl(creators: &[Value]) -> Map<String, Value> {
    let mut names: BTreeMap<&str, Vec<Value>> = BTreeMap::new();
    for creator in creators {
        let Some(creator) = creator.as_object() else {
            continue;
        };
        let role = creator
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("author");
        let Some(role) = NAME_ROLES.iter().find(|candidate| **candidate == role) else {
            continue;
        };
        let mut name = Map::new();
        if NAME_PARTS.iter().any(|part| creator.contains_key(*part)) {
            for part in NAME_PARTS {
                if let Some(value @ Value::String(_)) = creator.get(part) {
                    name.insert(part.into(), value.clone());
                }
            }
        } else if let Some(text) = creator.get("name") {
            name.insert("literal".into(), text.clone());
        }
        names.entry(role).or_default().push(Value::Object(name));
    }
    names
        .into_iter()
        .map(|(role, names)| (role.to_string(), Value::Array(names)))
        .collect()
}

fn is_plain_identifier(identifier: &Map<String, Value>) -> bool {
    identifier.len() == 2
        && identifier.get("scheme").is_some_and(Value::is_string)
        && identifier.get("value").is_some_and(Value::is_string)
}

/// Identifier objects to the dedicated CSL variables they fit: the first
/// value of a single-valued scheme, or every ISBN or ISSN joined by `, `.
fn identifiers_to_csl(identifiers: &[Value]) -> Map<String, Value> {
    let mut found: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for identifier in identifiers {
        let Some(identifier) = identifier
            .as_object()
            .filter(|map| is_plain_identifier(map))
        else {
            continue;
        };
        let (Some(scheme), Some(value)) =
            (identifier["scheme"].as_str(), identifier["value"].as_str())
        else {
            continue;
        };
        if IDENTIFIER_FIELDS.iter().any(|(known, _)| *known == scheme) {
            found.entry(scheme).or_default().push(value);
        }
    }
    let mut map = Map::new();
    for (scheme, key) in IDENTIFIER_FIELDS {
        let Some(values) = found.get(scheme) else {
            continue;
        };
        let text = if matches!(scheme, "isbn" | "issn") {
            values.join(", ")
        } else {
            values[0].to_string()
        };
        map.insert(key.into(), Value::String(text));
    }
    map
}

fn identifiers_from_csl(
    standard: &Map<String, Value>,
    id: &str,
    problems: &mut Vec<SourceDiagnostic>,
) -> Option<Vec<Value>> {
    let mut identifiers = Vec::new();
    for (scheme, key) in IDENTIFIER_FIELDS {
        let Some(value) = standard.get(key) else {
            continue;
        };
        let Value::String(text) = value else {
            problems.push(problem(
                SourceDiagnosticCode::InvalidField,
                Some(id),
                key,
                "must be text",
            ));
            continue;
        };
        let values: Vec<&str> = if matches!(scheme, "isbn" | "issn") {
            text.split([',', ';']).map(str::trim).collect()
        } else {
            vec![text.trim()]
        };
        for value in values.into_iter().filter(|value| !value.is_empty()) {
            identifiers.push(serde_json::json!({ "scheme": scheme, "value": value }));
        }
    }
    Some(identifiers)
}

/// Parse a canonical date text into its CSL date parts. Anything that would
/// not format back to exactly the same text is not canonical.
fn canonical_date_parts(text: &str) -> Option<Vec<Vec<u32>>> {
    let parts: Vec<Vec<u32>> = text
        .split('/')
        .map(|half| {
            half.split('-')
                .map(|piece| {
                    piece
                        .bytes()
                        .all(|byte| byte.is_ascii_digit())
                        .then(|| piece.parse::<u32>().ok())
                        .flatten()
                })
                .collect::<Option<Vec<u32>>>()
        })
        .collect::<Option<_>>()?;
    (format_date_parts(&parts).ok()?.as_str() == text).then_some(parts)
}

fn format_date_parts(parts: &[Vec<u32>]) -> Result<String, String> {
    if parts.is_empty() || parts.len() > 2 {
        return Err("date-parts must hold one date or a range of two".into());
    }
    let mut halves = Vec::new();
    for half in parts {
        let valid = match half.as_slice() {
            [year] => *year <= 9999,
            [year, month] => *year <= 9999 && (1..=12).contains(month),
            [year, month, day] => {
                *year <= 9999 && (1..=12).contains(month) && (1..=31).contains(day)
            }
            _ => false,
        };
        if !valid {
            return Err(
                "date-parts must be a year with an optional month (1-12) and day (1-31)".into(),
            );
        }
        halves.push(match half.as_slice() {
            [year] => format!("{year}"),
            [year, month] => format!("{year}-{month:02}"),
            [year, month, day] => format!("{year}-{month:02}-{day:02}"),
            _ => unreachable!("validated above"),
        });
    }
    Ok(halves.join("/"))
}

fn date_from_csl(value: &Value, unsupported: &mut Vec<Loss>) -> Result<String, String> {
    let object = match value {
        Value::String(text) => return Ok(text.clone()),
        Value::Object(object) => object,
        _ => return Err("must be a CSL date object".into()),
    };
    for key in object.keys() {
        if !["date-parts", "literal", "raw"].contains(&key.as_str()) {
            unsupported.push(Loss {
                field: format!("issued.{key}"),
                reason: "the source library keeps authored date text only".into(),
            });
        }
    }
    if let Some(parts) = object.get("date-parts") {
        let Value::Array(halves) = parts else {
            return Err("date-parts must be an array".into());
        };
        let mut numbers = Vec::new();
        for half in halves {
            let Value::Array(pieces) = half else {
                return Err("date-parts must hold arrays of numbers".into());
            };
            let mut parsed = Vec::new();
            for piece in pieces {
                let number = match piece {
                    Value::Number(number) => number.as_u64().and_then(|n| u32::try_from(n).ok()),
                    Value::String(text) if text.bytes().all(|byte| byte.is_ascii_digit()) => {
                        text.parse().ok()
                    }
                    _ => None,
                };
                parsed.push(number.ok_or("date-parts must be non-negative whole numbers")?);
            }
            numbers.push(parsed);
        }
        return format_date_parts(&numbers);
    }
    match object.get("literal").or_else(|| object.get("raw")) {
        Some(Value::String(text)) => Ok(text.clone()),
        _ => Err("a date needs `date-parts`, `literal`, or `raw`".into()),
    }
}

/// Merge an incoming item into the record it matches. Only what the item
/// states changes; every other field of the existing record stays as it is,
/// and lists are unioned so an import never removes a creator or identifier.
/// A creator's attribution or note that differs from the one held is
/// returned as a conflict instead of being merged.
fn merge(
    existing: &SourceRecord,
    incoming: &SourceRecord,
    provided: &BTreeSet<String>,
) -> Result<SourceRecord, Vec<SourceDiagnostic>> {
    let mut conflicts = Vec::new();
    let mut merged = existing.clone();
    if provided.contains("title") {
        merged.title.clone_from(&incoming.title);
    }
    if provided.contains("language") {
        merged.language.clone_from(&incoming.language);
    }
    if provided.contains("issued") {
        merged.issued.clone_from(&incoming.issued);
    }
    if provided.contains("of") {
        merged.of.clone_from(&incoming.of);
    }
    if provided.contains("basedOn") {
        merged.based_on.clone_from(&incoming.based_on);
    }
    if provided.contains("location") {
        merged.location.clone_from(&incoming.location);
    }
    if provided.contains("archived") {
        merged.archived = incoming.archived;
    }
    if provided.contains("anonymous") {
        merged.anonymous = incoming.anonymous;
    }
    if provided.contains("revises") {
        merged.revises.clone_from(&incoming.revises);
    }
    if provided.contains("repository") {
        merged.repository.clone_from(&incoming.repository);
    }
    if provided.contains("shelfmark") {
        merged.shelfmark.clone_from(&incoming.shelfmark);
    }
    if provided.contains("volumes") {
        merged.volumes = incoming.volumes;
    }
    if provided.contains("rights") {
        merged.rights.clone_from(&incoming.rights);
    }
    for creator in &incoming.creators {
        let found = merged.creators.iter_mut().enumerate().find(|(_, held)| {
            held.name == creator.name
                && (held.role == creator.role || held.role.is_none() || creator.role.is_none())
        });
        match found {
            Some((position, held)) => {
                // Attribution certainty and its note are filled in when the
                // library has none; two different statements are a conflict
                // for the author to settle, never a silent choice.
                match (&held.attribution, creator.attribution) {
                    (None, Some(stated)) => held.attribution = Some(stated),
                    (Some(kept), Some(stated)) if *kept != stated => {
                        conflicts.push(problem(
                            SourceDiagnosticCode::ConflictingAttribution,
                            Some(&existing.id),
                            &format!("creators[{position}].attribution"),
                            format!(
                                "the library records {} as {} and the item as {}; make them agree before importing",
                                creator.name,
                                kept.as_str(),
                                stated.as_str()
                            ),
                        ));
                    }
                    _ => {}
                }
                match (&held.note, &creator.note) {
                    (None, Some(note)) => held.note = Some(note.clone()),
                    (Some(kept), Some(note)) if kept != note => {
                        conflicts.push(problem(
                            SourceDiagnosticCode::ConflictingAttribution,
                            Some(&existing.id),
                            &format!("creators[{position}].note"),
                            format!(
                                "the library and the item give {} different attribution notes; make them agree before importing",
                                creator.name
                            ),
                        ));
                    }
                    _ => {}
                }
                for (key, value) in &creator.extra {
                    held.extra
                        .entry(key.clone())
                        .or_insert_with(|| value.clone());
                }
            }
            None => merged.creators.push(creator.clone()),
        }
    }
    for identifier in &incoming.identifiers {
        let key = identifier_key(&identifier.scheme, &identifier.value);
        let held = merged
            .identifiers
            .iter()
            .any(|held| identifier_key(&held.scheme, &held.value) == key);
        if !held {
            merged.identifiers.push(identifier.clone());
        }
    }
    for (key, value) in &incoming.extra {
        match (merged.extra.get_mut(key), value) {
            (Some(Value::Object(held)), Value::Object(incoming)) if key == "csl" => {
                for (name, value) in incoming {
                    held.insert(name.clone(), value.clone());
                }
            }
            _ => {
                merged.extra.insert(key.clone(), value.clone());
            }
        }
    }
    if conflicts.is_empty() {
        Ok(merged)
    } else {
        Err(conflicts)
    }
}

/// Identifier comparison key: the same DOI or ISBN written differently
/// matches itself.
fn identifier_key(scheme: &str, value: &str) -> (String, String) {
    let normal = match scheme {
        "doi" => normalize_doi_url(value)
            .unwrap_or_else(|| value.to_string())
            .to_lowercase(),
        "isbn" | "issn" => value
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
            .to_ascii_uppercase(),
        _ => value.to_string(),
    };
    (scheme.to_string(), normal)
}

fn duplicate_identifier(
    library: &SourceLibrary,
    record: &SourceRecord,
    id: &str,
    seen: &mut BTreeMap<(String, String), String>,
) -> Option<String> {
    let mut duplicate = None;
    for identifier in record
        .identifiers
        .iter()
        .filter(|identifier| DUPLICATE_SCHEMES.contains(&identifier.scheme.as_str()))
    {
        let key = identifier_key(&identifier.scheme, &identifier.value);
        let held = library
            .sources
            .iter()
            .find(|source| {
                source.id != id
                    && source
                        .identifiers
                        .iter()
                        .any(|held| identifier_key(&held.scheme, &held.value) == key)
            })
            .map(|source| source.id.clone())
            .or_else(|| seen.get(&key).cloned());
        if duplicate.is_none() {
            duplicate = held;
        }
        seen.entry(key).or_insert_with(|| id.to_string());
    }
    duplicate
}

fn record_map(record: &SourceRecord) -> Map<String, Value> {
    match serde_json::to_value(record) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn diff(before: &SourceRecord, after: &SourceRecord) -> Vec<FieldChange> {
    let (before, after) = (record_map(before), record_map(after));
    let keys: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    keys.into_iter()
        .filter(|key| before.get(*key) != after.get(*key))
        .map(|key| FieldChange {
            field: key.clone(),
            before: before.get(key).cloned(),
            after: after.get(key).cloned(),
        })
        .collect()
}

fn kept_fields(existing: &SourceRecord, provided: &BTreeSet<String>) -> Vec<String> {
    record_map(existing)
        .into_iter()
        .map(|(key, _)| key)
        .filter(|key| key != "id" && key != "kind" && !provided.contains(key))
        .collect()
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// A deterministic export and everything the format could not carry.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Export {
    pub content: String,
    pub count: usize,
    pub losses: Vec<ExportLoss>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLoss {
    pub source_id: String,
    pub field: String,
    pub reason: String,
}

fn creators_as_values(record: &SourceRecord) -> Vec<Value> {
    match serde_json::to_value(&record.creators) {
        Ok(Value::Array(values)) => values,
        _ => Vec::new(),
    }
}

fn identifiers_as_values(record: &SourceRecord) -> Vec<Value> {
    match serde_json::to_value(&record.identifiers) {
        Ok(Value::Array(values)) => values,
        _ => Vec::new(),
    }
}

/// The library as CSL JSON 1.0.2: an array of items in library order. What
/// CSL has no variable for travels in each item's `custom` object, so an
/// import of the export restores every record exactly. Nothing is lost.
pub fn export_csl_json(library: &SourceLibrary) -> Export {
    let items: Vec<Value> = library.sources.iter().map(csl_item).collect();
    let mut content = serde_json::to_string_pretty(&items).unwrap_or_else(|_| "[]".into());
    content.push('\n');
    Export {
        content,
        count: items.len(),
        losses: Vec::new(),
    }
}

fn csl_item(record: &SourceRecord) -> Value {
    let mut item = Map::new();
    item.insert("id".into(), Value::String(record.id.clone()));
    let mut bag = match record.extra.get("csl") {
        Some(Value::Object(bag)) => bag.clone(),
        _ => Map::new(),
    };
    let kind = match bag.get("type") {
        Some(Value::String(kind)) => {
            let kind = kind.clone();
            bag.remove("type");
            kind
        }
        _ => "document".into(),
    };
    item.insert("type".into(), Value::String(kind));
    if let Some(title) = &record.title {
        item.insert("title".into(), Value::String(title.clone()));
    }
    if let Some(language) = &record.language {
        item.insert("language".into(), Value::String(language.clone()));
    }
    if let Some(issued) = &record.issued {
        item.insert("issued".into(), csl_date(issued));
    }
    let creators = creators_as_values(record);
    let identifiers = identifiers_as_values(record);
    item.extend(creators_to_csl(&creators));
    item.extend(identifiers_to_csl(&identifiers));
    for key in PRESERVED_FIELDS {
        if let Some(value) = bag.remove(*key) {
            item.insert((*key).into(), value);
        }
    }

    let mut custom = Map::new();
    custom.insert(
        "openblog-kind".into(),
        Value::String(record.kind.to_string()),
    );
    if let Some(of) = &record.of {
        custom.insert("openblog-of".into(), Value::String(of.clone()));
    }
    if let Some(based_on) = &record.based_on {
        custom.insert("openblog-basedOn".into(), Value::String(based_on.clone()));
    }
    if let Ok(location) = serde_json::to_value(&record.location) {
        if !location.is_null() {
            custom.insert("openblog-location".into(), location);
        }
    }
    if record.archived {
        custom.insert("openblog-archived".into(), Value::Bool(true));
    }
    if let Ok(Value::Object(mut fields)) = serde_json::to_value(record) {
        for (custom_key, field) in PROVENANCE_FIELDS {
            if let Some(value) = fields.remove(field) {
                custom.insert(custom_key.into(), value);
            }
        }
    }
    if !creators.is_empty() {
        custom.insert("openblog-creators".into(), Value::Array(creators));
    }
    if !identifiers.is_empty() {
        custom.insert("openblog-identifiers".into(), Value::Array(identifiers));
    }
    let mut extra: Map<String, Value> = record
        .extra
        .iter()
        .filter(|(key, _)| key.as_str() != "csl")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if !bag.is_empty() {
        extra.insert("csl".into(), Value::Object(bag));
    }
    if !extra.is_empty() {
        custom.insert("openblog-extra".into(), Value::Object(extra));
    }
    debug_assert!(custom.keys().all(|key| CUSTOM_KEYS.contains(&key.as_str())));
    item.insert("custom".into(), Value::Object(custom));
    Value::Object(item)
}

fn csl_date(text: &str) -> Value {
    match canonical_date_parts(text) {
        Some(parts) => serde_json::json!({ "date-parts": parts }),
        None => serde_json::json!({ "literal": text }),
    }
}

/// The library as BibTeX, one entry per record in library order, keyed by
/// the stable source id. BibTeX cannot express editions of a work,
/// relationships, locations, or unknown fields, so each record reports what
/// the entry leaves out.
pub fn export_bibtex(library: &SourceLibrary) -> Export {
    let mut content = String::new();
    let mut losses = Vec::new();
    for (position, record) in library.sources.iter().enumerate() {
        if position > 0 {
            content.push('\n');
        }
        content.push_str(&bibtex_entry(record, &mut losses));
    }
    Export {
        content,
        count: library.sources.len(),
        losses,
    }
}

/// A post's cited references as CSL JSON, in order of first citation: a
/// portable bibliography (ADR 0050). Unlike [`export_csl_json`] it is built
/// only from the public description ([`PublicReference`]) a published post
/// already shows, so it carries no `custom` envelope, no relationships,
/// locations, archived flags, unknown fields or private identifiers. What
/// CSL cannot carry of that description is reported in `losses`.
pub fn export_cited_csl_json(references: &[PublicReference]) -> Export {
    let mut losses = Vec::new();
    let items: Vec<Value> = references
        .iter()
        .map(|reference| {
            let record = public_record(reference);
            let mut item = csl_item(&record);
            if let Value::Object(map) = &mut item {
                map.remove("custom");
            }
            let mut lose = |field: String, reason: String| {
                losses.push(ExportLoss {
                    source_id: reference.key.clone(),
                    field,
                    reason,
                });
            };
            if record.kind != ResearchSourceKind::Work {
                lose(
                    "kind".into(),
                    format!("CSL JSON cannot tell {} from a work", record.kind.as_str()),
                );
            }
            for (position, creator) in reference.creators.iter().enumerate() {
                let role = creator.role.as_deref().unwrap_or("author");
                if !NAME_ROLES.contains(&role) {
                    lose(
                        format!("creators[{position}]"),
                        format!("CSL JSON has no name variable for the role `{role}`"),
                    );
                }
            }
            for (scheme, _) in IDENTIFIER_FIELDS {
                let count = reference
                    .identifiers
                    .iter()
                    .filter(|(held, _)| held == scheme)
                    .count();
                if count > 1 && !matches!(scheme, "isbn" | "issn") {
                    lose(
                        "identifiers".into(),
                        format!("CSL JSON holds one `{scheme}`; the others are omitted"),
                    );
                }
            }
            item
        })
        .collect();
    let mut content = serde_json::to_string_pretty(&items).unwrap_or_else(|_| "[]".into());
    content.push('\n');
    Export {
        content,
        count: items.len(),
        losses,
    }
}

/// A post's cited references as BibTeX, in order of first citation and keyed
/// by source id, built only from their public description like
/// [`export_cited_csl_json`]. What BibTeX cannot carry is reported in
/// `losses`.
pub fn export_cited_bibtex(references: &[PublicReference]) -> Export {
    let mut content = String::new();
    let mut losses = Vec::new();
    for (position, reference) in references.iter().enumerate() {
        if position > 0 {
            content.push('\n');
        }
        content.push_str(&bibtex_entry(&public_record(reference), &mut losses));
    }
    Export {
        content,
        count: references.len(),
        losses,
    }
}

/// A record holding exactly a reference's public description, so the library
/// exporters can write it without ever seeing a private field.
fn public_record(reference: &PublicReference) -> SourceRecord {
    let mut extra = BTreeMap::new();
    if !reference.csl.is_empty() {
        extra.insert(
            "csl".into(),
            Value::Object(
                reference
                    .csl
                    .iter()
                    .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                    .collect(),
            ),
        );
    }
    SourceRecord {
        id: reference.key.clone(),
        kind: ResearchSourceKind::parse(reference.kind).unwrap_or(ResearchSourceKind::Work),
        title: reference.title.clone(),
        creators: reference
            .creators
            .iter()
            .map(|creator| SourceCreator {
                name: creator.name.clone(),
                role: creator.role.clone(),
                attribution: None,
                note: None,
                extra: BTreeMap::new(),
            })
            .collect(),
        language: reference.language.clone(),
        issued: reference.issued.clone(),
        of: None,
        based_on: None,
        location: None,
        identifiers: reference
            .identifiers
            .iter()
            .filter(|(scheme, value)| public_identifier(scheme, value))
            .map(|(scheme, value)| SourceIdentifier {
                scheme: scheme.clone(),
                value: value.clone(),
                extra: BTreeMap::new(),
            })
            .collect(),
        archived: false,
        anonymous: false,
        revises: None,
        repository: None,
        shelfmark: None,
        volumes: None,
        rights: None,
        extra,
    }
}

fn bibtex_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '\\' => out.push_str("\\textbackslash{}"),
            // BibTeX counts braces even after a backslash; write them as commands.
            '{' => out.push_str("\\textbraceleft{}"),
            '}' => out.push_str("\\textbraceright{}"),
            '%' | '&' | '$' | '#' | '_' => {
                out.push('\\');
                out.push(character);
            }
            '^' => out.push_str("\\^{}"),
            '~' => out.push_str("\\~{}"),
            // Line breaks would end the field early in some readers.
            '\n' | '\r' => out.push(' '),
            other => out.push(other),
        }
    }
    out
}

fn bibtex_name(creator: &Value) -> Option<String> {
    let creator = creator.as_object()?;
    let part = |key: &str| creator.get(key).and_then(Value::as_str);
    if NAME_PARTS.iter().any(|key| creator.contains_key(*key)) {
        let mut family = [part("non-dropping-particle"), part("family")]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        if family.contains(" and ") || family.contains(',') {
            family = format!("{{{}}}", bibtex_escape(&family));
        } else {
            family = bibtex_escape(&family);
        }
        let given = [part("given"), part("dropping-particle")]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        let mut out = family;
        if let Some(suffix) = part("suffix") {
            let _ = write!(out, ", {}", bibtex_escape(suffix));
        }
        if !given.is_empty() {
            let _ = write!(out, ", {}", bibtex_escape(&given));
        }
        Some(out)
    } else {
        // A braced name is one name, even if it contains " and " or a comma.
        Some(format!("{{{}}}", bibtex_escape(part("name")?)))
    }
}

fn month_macro(month: u32) -> &'static str {
    [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ][month as usize - 1]
}

fn bibtex_entry(record: &SourceRecord, losses: &mut Vec<ExportLoss>) -> String {
    let mut lose = |field: &str, reason: &str| {
        losses.push(ExportLoss {
            source_id: record.id.clone(),
            field: field.into(),
            reason: reason.into(),
        });
    };
    let bag = match record.extra.get("csl") {
        Some(Value::Object(bag)) => bag.clone(),
        _ => Map::new(),
    };
    let text = |key: &str| match bag.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    };
    let csl_type = text("type").unwrap_or_default();
    let entry_type = match csl_type.as_str() {
        "book" => "book",
        "chapter" => "incollection",
        "article" | "article-journal" | "article-magazine" | "article-newspaper" => "article",
        "paper-conference" => "inproceedings",
        "thesis" => "phdthesis",
        "report" => "techreport",
        "manuscript" => "unpublished",
        _ => "misc",
    };
    let mut fields: Vec<(&str, String)> = Vec::new();
    let braced = |value: &str| format!("{{{}}}", bibtex_escape(value));

    let mut names: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for (position, creator) in creators_as_values(record).iter().enumerate() {
        let role = creator
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("author");
        match NAME_ROLES.iter().find(|candidate| **candidate == role) {
            Some(role) => {
                if let Some(name) = bibtex_name(creator) {
                    names.entry(role).or_default().push(name);
                }
            }
            None => lose(
                &format!("creators[{position}]"),
                &format!("BibTeX has no name field for the role `{role}`"),
            ),
        }
    }
    for role in NAME_ROLES {
        if let Some(list) = names.get(role) {
            fields.push((role, format!("{{{}}}", list.join(" and "))));
        }
    }
    if let Some(title) = &record.title {
        fields.push(("title", braced(title)));
    }
    if let Some(container) = text("container-title") {
        let field = match entry_type {
            "article" => "journal",
            "incollection" | "inproceedings" => "booktitle",
            _ => "howpublished",
        };
        fields.push((field, braced(&container)));
    }
    for (key, field) in [
        ("publisher", "publisher"),
        ("publisher-place", "address"),
        ("edition", "edition"),
        ("volume", "volume"),
        ("page", "pages"),
        ("genre", "type"),
    ] {
        if let Some(value) = text(key) {
            fields.push((field, braced(&value)));
        }
    }
    if let Some(value) = text("issue").or_else(|| text("number")) {
        fields.push(("number", braced(&value)));
    }
    if let Some(issued) = &record.issued {
        match canonical_date_parts(issued).as_deref() {
            Some([date]) => {
                fields.push(("year", format!("{{{}}}", date[0])));
                if let Some(month) = date.get(1) {
                    fields.push(("month", month_macro(*month).into()));
                }
                if date.len() > 2 {
                    lose(
                        "issued",
                        "BibTeX records the year and month; the day is omitted",
                    );
                }
            }
            _ => {
                fields.push(("year", braced(issued)));
                lose(
                    "issued",
                    "the date is not a single year, month, or day, so it is written as free text in `year`",
                );
            }
        }
    }
    if let Some(language) = &record.language {
        fields.push(("language", braced(language)));
    }
    let mut written: BTreeSet<&str> = BTreeSet::new();
    for identifier in &record.identifiers {
        let field = match identifier.scheme.as_str() {
            "doi" => "doi",
            "isbn" => "isbn",
            "issn" => "issn",
            "url" => "url",
            _ => {
                lose(
                    "identifiers",
                    &format!(
                        "BibTeX has no field for the `{}` identifier",
                        identifier.scheme
                    ),
                );
                continue;
            }
        };
        if !identifier.extra.is_empty() {
            lose("identifiers", "identifier annotations are omitted");
        }
        let value = if field == "doi" {
            identifier
                .value
                .strip_prefix("https://doi.org/")
                .or_else(|| identifier.value.strip_prefix("http://doi.org/"))
                .unwrap_or(&identifier.value)
                .to_string()
        } else {
            identifier.value.clone()
        };
        if matches!(field, "doi" | "url") {
            // These are written without escaping, so unbalanced braces or a
            // backslash could break the entry; encode braces, refuse the rest.
            if value.contains('\\') {
                lose(
                    "identifiers",
                    "an identifier containing a backslash cannot be written safely",
                );
                continue;
            }
            let value = value.replace('{', "%7B").replace('}', "%7D");
            if !written.insert(field) {
                lose(
                    "identifiers",
                    &format!("BibTeX holds one `{field}`; the others are omitted"),
                );
                continue;
            }
            fields.push((field, format!("{{{value}}}")));
        } else if written.insert(field) {
            fields.push((field, braced(&identifier.value)));
        } else if let Some((_, held)) = fields.iter_mut().find(|(name, _)| *name == field) {
            // Several ISBNs or ISSNs share one field.
            held.pop();
            let _ = write!(held, ", {}}}", bibtex_escape(&identifier.value));
        }
    }

    if record.kind != ResearchSourceKind::Work {
        lose(
            "kind",
            &format!("BibTeX cannot tell {} from a work", record.kind.as_str()),
        );
    }
    if record.of.is_some() {
        lose(
            "of",
            "BibTeX cannot express the work, edition, or translation this record belongs to",
        );
    }
    if record.based_on.is_some() {
        lose(
            "basedOn",
            "BibTeX cannot express which source a translation was made from",
        );
    }
    if record.location.is_some() {
        lose("location", "BibTeX has no position inside a source");
    }
    if record.archived {
        lose("archived", "the archived flag is open.blog's own");
    }
    if record.anonymous {
        lose(
            "anonymous",
            "BibTeX cannot say that a source names no maker",
        );
    }
    if record.revises.is_some() {
        lose(
            "revises",
            "BibTeX cannot express which edition this one revises",
        );
    }
    if record.repository.is_some() || record.shelfmark.is_some() {
        lose(
            "shelfmark",
            "BibTeX has no field for a witness's repository and shelfmark",
        );
    }
    if record.volumes.is_some() {
        lose(
            "volumes",
            "the declared number of volumes is open.blog's own",
        );
    }
    if record.rights.is_some() {
        lose(
            "rights",
            "the rights declaration is the author's private statement and BibTeX has no field for it",
        );
    }
    if record
        .creators
        .iter()
        .any(|creator| creator.attribution.is_some() || creator.note.is_some())
    {
        lose(
            "creators",
            "BibTeX cannot express how firmly a name is attributed",
        );
    }
    let unknown: Vec<&String> = record
        .extra
        .keys()
        .filter(|key| key.as_str() != "csl")
        .collect();
    if !unknown.is_empty() {
        lose("extra", "fields open.blog does not define are omitted");
    }
    let skipped: Vec<&String> = bag
        .keys()
        .filter(|key| {
            !matches!(
                key.as_str(),
                "type"
                    | "container-title"
                    | "publisher"
                    | "publisher-place"
                    | "edition"
                    | "volume"
                    | "page"
                    | "genre"
                    | "issue"
                    | "number"
            )
        })
        .collect();
    if !skipped.is_empty() {
        lose(
            "csl",
            "some preserved CSL variables have no BibTeX field and are omitted",
        );
    }

    let mut out = format!("@{entry_type}{{{},\n", record.id);
    for (name, value) in fields {
        let _ = writeln!(out, "  {name} = {value},");
    }
    out.push_str("}\n");
    out
}
