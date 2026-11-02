//! Portable export and dry-run import of the private research notebook.
//!
//! A bundle is a versioned JSON document that carries the whole notebook (every
//! passage and note, archived ones included, unknown fields kept) so it can be
//! moved to another project or kept as a backup. It is private data: building
//! it is always an explicit author action, it is marked as private so tools can
//! recognise and refuse it, and nothing here reads or writes a file.
//!
//! Import mirrors the source library's CSL import: [`plan_import`] is pure and
//! reports, entry by entry, what would be created, what already matches, and
//! what conflicts. Only [`ImportPlan::apply`] builds a changed notebook, and
//! only when nothing conflicts and the merged result validates as a whole. An
//! import never overwrites or removes an entry, and importing the same bundle
//! twice changes nothing. Messages never repeat quoted or noted text.

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::research_notes::{
    NoteDiagnostic, NoteDiagnosticCode, Notebook, MAX_NOTEBOOK_BYTES, NOTEBOOK_VERSION,
};
use crate::source_library::SourceLibrary;

/// The `format` every bundle declares.
pub const BUNDLE_FORMAT: &str = "open.blog/research-notebook";
/// The bundle layout version this code reads and writes.
pub const BUNDLE_VERSION: u64 = 1;
/// A bundle wraps one notebook, so it may exceed the notebook limit by its envelope.
pub const MAX_BUNDLE_BYTES: usize = MAX_NOTEBOOK_BYTES + 256 * 1024;
/// The default file name offered for an export.
pub const BUNDLE_FILENAME: &str = "open-blog-research-notebook.json";

/// A built export.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Export {
    pub content: String,
    pub passages: usize,
    pub notes: usize,
    /// Entries that were archived when exported.
    pub archived: usize,
}

/// What an import would do with one entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Create,
    Unchanged,
    Conflict,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlanEntry {
    pub id: String,
    /// `passages` or `notes`.
    pub collection: &'static str,
    pub action: Action,
    /// Why an entry conflicts; never contains entry text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct PlanCounts {
    pub create: usize,
    pub unchanged: usize,
    pub conflict: usize,
}

/// A dry run: describes the merge and holds what is needed to perform it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ImportPlan {
    pub counts: PlanCounts,
    pub entries: Vec<PlanEntry>,
    #[serde(skip)]
    incoming: Notebook,
}

fn problem(
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

/// Wrap the notebook as a bundle. Deterministic for a given notebook: keys are
/// sorted by the serializer's field order and the text ends in a newline, so
/// exporting twice gives the same bytes. Nothing is dropped.
pub fn export(notebook: &Notebook, library: &SourceLibrary) -> Export {
    // Name each source the entries point at, so a reader of the bundle knows
    // what the ids mean without the library. Titles are the author's own
    // library labels and are as private as the rest of the bundle.
    let mut referenced: Vec<&str> = Vec::new();
    for passage in &notebook.passages {
        referenced.push(passage.source.as_str());
    }
    for note in &notebook.notes {
        referenced.extend(note.sources.iter().map(String::as_str));
    }
    referenced.sort_unstable();
    referenced.dedup();
    let sources: Vec<Value> = referenced
        .into_iter()
        .map(|id| match library.get(id) {
            Some(record) => json!({
                "id": id,
                "kind": record.kind.as_str(),
                "title": record.title,
            }),
            None => json!({ "id": id }),
        })
        .collect();
    let bundle = json!({
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "private": true,
        "contains": ["passages", "notes"],
        "sources": sources,
        "notebook": notebook,
    });
    let mut content = serde_json::to_string_pretty(&bundle).unwrap_or_default();
    content.push('\n');
    Export {
        content,
        passages: notebook.passages.len(),
        notes: notebook.notes.len(),
        archived: notebook.passages.iter().filter(|p| p.archived).count()
            + notebook.notes.iter().filter(|n| n.archived).count(),
    }
}

/// Read a bundle and say what importing it into `current` would do. The
/// bundle is validated as a whole, against the library the notebook points
/// into, before any entry is compared; a malformed, oversized, unreadable or
/// newer-version bundle is refused with scoped diagnostics.
pub fn plan_import(
    current: &Notebook,
    library: &SourceLibrary,
    text: &str,
) -> Result<ImportPlan, Vec<NoteDiagnostic>> {
    if text.len() > MAX_BUNDLE_BYTES {
        return Err(vec![problem(
            NoteDiagnosticCode::TooLarge,
            None,
            format!("a research bundle is limited to {MAX_BUNDLE_BYTES} bytes"),
        )]);
    }
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Ok(Value::Object(mut root)) = serde_json::from_str::<Value>(text) else {
        return Err(vec![problem(
            NoteDiagnosticCode::InvalidJson,
            None,
            "the bundle is not a JSON object",
        )]);
    };
    if root.get("format").and_then(Value::as_str) != Some(BUNDLE_FORMAT) {
        return Err(vec![problem(
            NoteDiagnosticCode::InvalidField,
            Some("format"),
            format!(
                "this is not an open.blog research bundle (`format` must be `{BUNDLE_FORMAT}`)"
            ),
        )]);
    }
    match root.get("version").and_then(Value::as_u64) {
        Some(BUNDLE_VERSION) => {}
        Some(newer) if newer > BUNDLE_VERSION => {
            return Err(vec![problem(
                NoteDiagnosticCode::UnsupportedVersion,
                Some("version"),
                format!("bundle version {newer} was written by a newer open.blog; upgrade before importing so nothing is misread"),
            )]);
        }
        _ => {
            return Err(vec![problem(
                NoteDiagnosticCode::UnsupportedVersion,
                Some("version"),
                format!("bundle version must be {BUNDLE_VERSION}"),
            )]);
        }
    }
    if root.get("private") != Some(&Value::Bool(true)) {
        return Err(vec![problem(
            NoteDiagnosticCode::NotPrivate,
            Some("private"),
            "a research bundle must declare `\"private\": true`",
        )]);
    }
    let Some(notebook) = root.remove("notebook") else {
        return Err(vec![problem(
            NoteDiagnosticCode::MissingField,
            Some("notebook"),
            "the bundle has no `notebook`",
        )]);
    };
    // The same reader that loads the stored file: one set of rules.
    let notebook_text = serde_json::to_string(&notebook).unwrap_or_default();
    let incoming = Notebook::parse(&notebook_text, library).map_err(|mut found| {
        for diagnostic in &mut found {
            diagnostic.field = Some(match diagnostic.field.take() {
                Some(field) if !field.is_empty() => format!("notebook.{field}"),
                _ => "notebook".into(),
            });
        }
        found
    })?;
    if incoming.version != NOTEBOOK_VERSION {
        return Err(vec![problem(
            NoteDiagnosticCode::UnsupportedVersion,
            Some("notebook.version"),
            format!("notebook version must be {NOTEBOOK_VERSION}"),
        )]);
    }

    let mut entries = Vec::new();
    let mut counts = PlanCounts::default();
    let mut record = |entry: PlanEntry| {
        match entry.action {
            Action::Create => counts.create += 1,
            Action::Unchanged => counts.unchanged += 1,
            Action::Conflict => counts.conflict += 1,
        }
        entries.push(entry);
    };
    let conflict = |id: &str, collection: &'static str, message: &str| PlanEntry {
        id: id.into(),
        collection,
        action: Action::Conflict,
        message: Some(message.into()),
    };
    for passage in &incoming.passages {
        record(match (current.passage(&passage.id), current.note(&passage.id)) {
            (_, Some(_)) => conflict(
                &passage.id,
                "passages",
                "a note in this notebook already uses this id",
            ),
            (Some(held), None) if held == passage => PlanEntry {
                id: passage.id.clone(),
                collection: "passages",
                action: Action::Unchanged,
                message: None,
            },
            (Some(_), None) => conflict(
                &passage.id,
                "passages",
                "a different passage in this notebook already uses this id; nothing is overwritten",
            ),
            (None, None) => PlanEntry {
                id: passage.id.clone(),
                collection: "passages",
                action: Action::Create,
                message: None,
            },
        });
    }
    for note in &incoming.notes {
        record(match (current.note(&note.id), current.passage(&note.id)) {
            (_, Some(_)) => conflict(
                &note.id,
                "notes",
                "a passage in this notebook already uses this id",
            ),
            (Some(held), None) if held == note => PlanEntry {
                id: note.id.clone(),
                collection: "notes",
                action: Action::Unchanged,
                message: None,
            },
            (Some(_), None) => conflict(
                &note.id,
                "notes",
                "a different note in this notebook already uses this id; nothing is overwritten",
            ),
            (None, None) => PlanEntry {
                id: note.id.clone(),
                collection: "notes",
                action: Action::Create,
                message: None,
            },
        });
    }
    Ok(ImportPlan {
        counts,
        entries,
        incoming,
    })
}

impl ImportPlan {
    pub fn is_applicable(&self) -> bool {
        self.counts.conflict == 0
    }

    pub fn has_changes(&self) -> bool {
        self.counts.create > 0
    }

    /// One diagnostic per conflicting entry, scoped to its collection and id.
    pub fn blockers(&self) -> Vec<NoteDiagnostic> {
        self.entries
            .iter()
            .filter(|entry| entry.action == Action::Conflict)
            .map(|entry| NoteDiagnostic {
                code: NoteDiagnosticCode::DuplicateId,
                collection: Some(entry.collection),
                index: None,
                id: Some(entry.id.clone()),
                field: Some("id".into()),
                message: entry.message.clone().unwrap_or_default(),
            })
            .collect()
    }

    /// The notebook with the new entries added after the existing ones, in
    /// bundle order. Refused when any entry conflicts or the merged notebook
    /// does not validate against `library` (so a link, a limit or a locator
    /// rule the union breaks is caught here, not on the next read).
    pub fn apply(
        &self,
        current: &Notebook,
        library: &SourceLibrary,
    ) -> Result<Notebook, Vec<NoteDiagnostic>> {
        if !self.is_applicable() {
            return Err(self.blockers());
        }
        let mut merged = current.clone();
        for passage in &self.incoming.passages {
            if merged.passage(&passage.id).is_none() {
                merged.passages.push(passage.clone());
            }
        }
        for note in &self.incoming.notes {
            if merged.note(&note.id).is_none() {
                merged.notes.push(note.clone());
            }
        }
        Notebook::parse(&merged.to_json(), library)
    }
}

/// Whether bytes look like private research: a bundle, or a notebook,
/// Knowledge Atlas, claims, alignments, review-acknowledgements or curated-selections file copied
/// out of private storage. Build and publish guards use this to refuse
/// public input that would carry private research with it, wherever the file
/// was saved and whatever it was renamed to. It reads the structure, not any
/// particular text, so a post that merely quotes the same words is never flagged.
pub fn looks_like_private_research(bytes: &[u8]) -> bool {
    if bytes.len() > MAX_BUNDLE_BYTES * 2 {
        return false;
    }
    // An optional BOM, then whitespace, then the object.
    let bytes = bytes.strip_prefix("\u{feff}".as_bytes()).unwrap_or(bytes);
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(0);
    let body = bytes.get(start..).unwrap_or_default();
    if body.first() != Some(&b'{') {
        return false;
    }
    let Ok(Value::Object(root)) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    if root.get("format").and_then(Value::as_str) == Some(BUNDLE_FORMAT) {
        return true;
    }
    notebook_shaped(&root)
        || crate::knowledge_atlas::looks_like_atlas(&root)
        || crate::claims::looks_like_claims(&root)
        || crate::alignment::looks_like_alignments(&root)
        || crate::publication_review::looks_like_acknowledgements(&root)
        || crate::curated_selection::looks_like_selections(&root)
}

fn notebook_shaped(root: &Map<String, Value>) -> bool {
    if root.get("version").and_then(Value::as_u64).is_none() {
        return false;
    }
    let list = |key: &str| root.get(key).and_then(Value::as_array);
    let passages = list("passages");
    let notes = list("notes");
    if passages.is_none() && notes.is_none() {
        return false;
    }
    let passage_like = |entry: &Value| {
        entry.get("id").is_some_and(Value::is_string)
            && entry.get("source").is_some_and(Value::is_string)
            && entry.pointer("/excerpt/text").is_some_and(Value::is_string)
    };
    let note_like = |entry: &Value| {
        entry.get("id").is_some_and(Value::is_string)
            && matches!(
                entry.get("kind").and_then(Value::as_str),
                Some("observation" | "question")
            )
            && entry.get("text").is_some_and(Value::is_string)
    };
    let all = passages.is_none_or(|items| items.iter().all(passage_like))
        && notes.is_none_or(|items| items.iter().all(note_like));
    let any = passages.is_some_and(|items| !items.is_empty())
        || notes.is_some_and(|items| !items.is_empty());
    all && any
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> SourceLibrary {
        SourceLibrary::parse(
            &json!({"version": 1, "sources": [
                {"id": "plato", "kind": "work", "title": "Politeia"},
                {"id": "slings", "kind": "edition", "of": "plato", "title": "Slings"}]})
            .to_string(),
            &Default::default(),
        )
        .unwrap()
    }

    fn notebook(extra_note: bool) -> Notebook {
        let mut notes = vec![
            json!({"id": "n1", "kind": "question", "text": "Why a cave?",
            "passages": ["p1"], "sources": ["plato"], "concepts": ["allegory"],
            "shelf": {"room": "B"}}),
        ];
        if extra_note {
            notes.push(
                json!({"id": "n2", "kind": "observation", "text": "Fire.", "archived": true}),
            );
        }
        Notebook::parse(
            &json!({"version": 1,
                "passages": [{"id": "p1", "source": "slings", "excerpt": {"text": "the cave"},
                    "locators": [{"kind": "page", "value": "514"}]}],
                "notes": notes})
            .to_string(),
            &library(),
        )
        .unwrap()
    }

    #[test]
    fn export_is_a_declared_private_deterministic_bundle_that_loses_nothing() {
        let book = notebook(true);
        let first = export(&book, &library());
        assert_eq!(first, export(&book, &library()), "deterministic");
        assert_eq!((first.passages, first.notes, first.archived), (1, 2, 1));
        assert!(first.content.ends_with("}\n"));
        let value: Value = serde_json::from_str(&first.content).unwrap();
        assert_eq!(value["format"], BUNDLE_FORMAT);
        assert_eq!(value["private"], true);
        assert_eq!(value["contains"], json!(["passages", "notes"]));
        assert_eq!(value["sources"][0]["id"], "plato");
        assert_eq!(
            value["notebook"]["notes"][0]["shelf"]["room"], "B",
            "unknown fields survive"
        );
        assert_eq!(value["notebook"]["notes"][1]["archived"], true);
    }

    #[test]
    fn a_round_trip_into_an_empty_notebook_restores_everything_and_a_second_import_is_unchanged() {
        let book = notebook(true);
        let bundle = export(&book, &library()).content;
        let empty = Notebook::default();
        let plan = plan_import(&empty, &library(), &bundle).unwrap();
        assert_eq!(
            plan.counts,
            PlanCounts {
                create: 3,
                unchanged: 0,
                conflict: 0
            }
        );
        let restored = plan.apply(&empty, &library()).unwrap();
        assert_eq!(restored, book);
        assert_eq!(restored.to_json(), book.to_json(), "byte-identical");
        let again = plan_import(&restored, &library(), &bundle).unwrap();
        assert_eq!(
            again.counts,
            PlanCounts {
                create: 0,
                unchanged: 3,
                conflict: 0
            }
        );
        assert!(!again.has_changes());
        assert_eq!(again.apply(&restored, &library()).unwrap(), restored);
    }

    #[test]
    fn an_import_adds_to_a_notebook_and_never_overwrites_or_removes() {
        let bundle = export(&notebook(true), &library()).content;
        let held = notebook(false);
        let plan = plan_import(&held, &library(), &bundle).unwrap();
        assert_eq!(
            plan.counts,
            PlanCounts {
                create: 1,
                unchanged: 2,
                conflict: 0
            }
        );
        let merged = plan.apply(&held, &library()).unwrap();
        assert_eq!(merged.notes.len(), 2);
        assert_eq!(merged.notes[0], held.notes[0]);

        // A different entry under the same id blocks the whole import.
        let mut changed = held.clone();
        changed.notes[0].text = "A different thought".into();
        let plan = plan_import(&changed, &library(), &bundle).unwrap();
        assert!(!plan.is_applicable());
        assert_eq!(plan.counts.conflict, 1);
        let blockers = plan.blockers();
        assert_eq!(blockers[0].id.as_deref(), Some("n1"));
        assert!(!format!("{blockers:?}").contains("different thought"));
        assert!(!format!("{blockers:?}").contains("Why a cave"));
        assert!(plan.apply(&changed, &library()).is_err());

        // An id used by the other kind of entry also conflicts.
        let mut crossed = Notebook::default();
        crossed.notes.push(
            crate::research_notes::ResearchNote::from_json(
                json!({"id": "p1", "kind": "observation", "text": "x"}),
            )
            .unwrap(),
        );
        let plan = plan_import(&crossed, &library(), &bundle).unwrap();
        assert!(plan
            .entries
            .iter()
            .any(|e| e.id == "p1" && e.action == Action::Conflict));
    }

    #[test]
    fn hostile_or_malformed_bundles_are_refused_with_scoped_text_free_diagnostics() {
        let empty = Notebook::default();
        let refuse = |text: &str| plan_import(&empty, &library(), text).unwrap_err();
        assert_eq!(
            refuse("not json at all")[0].code,
            NoteDiagnosticCode::InvalidJson
        );
        assert_eq!(refuse("[]")[0].code, NoteDiagnosticCode::InvalidJson);
        assert_eq!(refuse("{}")[0].field.as_deref(), Some("format"));
        let good = export(&notebook(true), &library()).content;
        let mut value: Value = serde_json::from_str(&good).unwrap();

        let mut newer = value.clone();
        newer["version"] = json!(2);
        assert_eq!(
            refuse(&newer.to_string())[0].code,
            NoteDiagnosticCode::UnsupportedVersion
        );

        let mut public = value.clone();
        public["private"] = json!(false);
        assert_eq!(
            refuse(&public.to_string())[0].code,
            NoteDiagnosticCode::NotPrivate
        );

        let mut ghost = value.clone();
        ghost["notebook"]["passages"][0]["source"] = json!("ghost");
        let found = refuse(&ghost.to_string());
        assert_eq!(found[0].code, NoteDiagnosticCode::UnknownSource);
        assert!(found[0].field.as_deref().unwrap().starts_with("notebook."));

        let mut credited = value.clone();
        credited["notebook"]["notes"][0]["credits"] = json!([{"name": "x"}]);
        assert_eq!(
            refuse(&credited.to_string())[0].code,
            NoteDiagnosticCode::ContributorCredit
        );

        let mut public_entry = value.clone();
        public_entry["notebook"]["notes"][0]["visibility"] = json!("public");
        assert_eq!(
            refuse(&public_entry.to_string())[0].code,
            NoteDiagnosticCode::NotPrivate
        );

        value["notebook"]["notes"][0]["text"] = json!("a\u{202e}b");
        assert!(
            !refuse(&value.to_string()).is_empty(),
            "bidi controls are refused"
        );

        let huge = " ".repeat(MAX_BUNDLE_BYTES + 1);
        assert_eq!(refuse(&huge)[0].code, NoteDiagnosticCode::TooLarge);
    }

    #[test]
    fn private_research_is_recognised_by_structure_not_by_words() {
        let book = notebook(true);
        assert!(looks_like_private_research(
            export(&book, &library()).content.as_bytes()
        ));
        assert!(
            looks_like_private_research(book.to_json().as_bytes()),
            "a copied notebook file"
        );
        assert!(looks_like_private_research(
            format!("\n  {}", book.to_json()).as_bytes()
        ));
        for harmless in [
            "the cave".to_string(),
            "---\ntitle: A post quoting the cave\n---\n".to_string(),
            "{\"version\":1,\"posts\":[]}".to_string(),
            "{\"version\":1,\"notes\":[]}".to_string(),
            "{\"version\":1,\"notes\":[{\"id\":\"a\"}]}".to_string(),
            "{\"name\":\"site\",\"notes\":[{\"id\":\"n\",\"kind\":\"observation\",\"text\":\"t\"}]}"
                .to_string(),
        ] {
            assert!(!looks_like_private_research(harmless.as_bytes()), "{harmless}");
        }
    }

    #[test]
    fn a_copied_acknowledgements_file_is_private_research() {
        let mut set = crate::publication_review::AcknowledgementSet::empty();
        set.add(crate::publication_review::Acknowledgement {
            validator: crate::publication_review::Validator::ResearchProfile,
            code: "abstract-missing".into(),
            object: crate::publication_review::ObjectKind::Post,
            path: Some("posts/cave.md".into()),
            id: None,
            field: None,
            fingerprint: "0123456789abcdef0123456789abcdef".into(),
        })
        .unwrap();
        assert!(looks_like_private_research(set.to_json().as_bytes()));
        assert!(looks_like_private_research(
            crate::publication_review::AcknowledgementSet::empty()
                .to_json()
                .as_bytes()
        ));
        for harmless in [
            r#"{"version":1,"acknowledgements":[{"name":"Thanks to my editor"}]}"#,
            r#"{"version":1,"acknowledgements":"Thanks","title":"Colophon"}"#,
            r#"{"title":"Colophon","acknowledgements":[]}"#,
            r#"{"version":1,"acknowledgements":[],"title":"Colophon"}"#,
        ] {
            assert!(
                !looks_like_private_research(harmless.as_bytes()),
                "{harmless}"
            );
        }
    }
}
