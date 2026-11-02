//! Portable export and import of reading paths (ADR 0217, #79).
//!
//! An export is one deterministic JSON file holding the author's path files
//! (the canonical text of each, so the rationale and the relationship of every
//! transition travel as written, and so do fields this release does not
//! define). An import reads such a file, checks every path with the same rules
//! as a hand-edited file, and plans what it would do; it writes nothing. A
//! caller applies the plan only when it holds no problem, so an invalid
//! import never leaves a partial write. This module is pure: it reads and
//! writes no file, and no message echoes a value from the input.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::reading_path::{
    valid_path_slug, PathProblem, ReadingPath, Status, MAX_FILE_BYTES, MAX_PATHS, PATHS_DIR,
};

/// The `format` of an export file.
pub const EXPORT_FORMAT: &str = "openblog-reading-paths-export";
/// The only export version this release writes and reads.
pub const EXPORT_VERSION: u64 = 1;
/// The largest export file read. The per-file and per-count limits still apply
/// inside it.
pub const MAX_EXPORT_BYTES: usize = 16 * 1024 * 1024;

/// The export of `paths`: sorted by slug, two-space JSON, `\n` line ends and a
/// final newline. Drafts are left out unless `include_drafts`, so a portable
/// copy never carries a path the author has not published by accident. The
/// same paths always give the same bytes, and `plan_import` of the result
/// against the same paths finds every one unchanged.
pub fn export(paths: &[ReadingPath], include_drafts: bool) -> String {
    let mut chosen: Vec<&ReadingPath> = paths
        .iter()
        .filter(|path| include_drafts || path.status == Status::Published)
        .collect();
    chosen.sort_by(|a, b| a.slug.cmp(&b.slug));
    let mut out = String::from("{\n");
    out.push_str(&format!("  \"format\": \"{EXPORT_FORMAT}\",\n"));
    out.push_str(&format!("  \"version\": {EXPORT_VERSION},\n"));
    if chosen.is_empty() {
        out.push_str("  \"paths\": []\n}\n");
        return out;
    }
    out.push_str("  \"paths\": [\n");
    for (index, path) in chosen.iter().enumerate() {
        let canonical = path.to_canonical_json();
        let indented: Vec<String> = canonical
            .trim_end()
            .lines()
            .enumerate()
            .map(|(line, text)| {
                if line == 0 {
                    text.to_string()
                } else {
                    format!("      {text}")
                }
            })
            .collect();
        out.push_str("    {\n");
        out.push_str(&format!(
            "      \"slug\": {},\n",
            serde_json::to_string(&path.slug).expect("a string serializes")
        ));
        out.push_str(&format!("      \"path\": {}\n", indented.join("\n")));
        out.push_str(if index + 1 == chosen.len() {
            "    }\n"
        } else {
            "    },\n"
        });
    }
    out.push_str("  ]\n}\n");
    out
}

/// What an import would do to one path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// The slug has no file.
    Create,
    /// The slug has a different file, and the import may replace it.
    Replace,
    /// The slug has this very path already.
    Unchanged,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedPath {
    pub path: ReadingPath,
    pub action: Action,
}

/// The result of reading an export: what would change, and every reason it
/// cannot. Apply the paths only if `problems` is empty.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportPlan {
    /// In slug order; only the paths that could be read.
    pub paths: Vec<PlannedPath>,
    pub problems: Vec<PathProblem>,
}

impl ImportPlan {
    pub fn is_valid(&self) -> bool {
        self.problems.is_empty()
    }

    /// The paths a caller must write: not the unchanged ones.
    pub fn writes(&self) -> impl Iterator<Item = &PlannedPath> {
        self.paths
            .iter()
            .filter(|planned| planned.action != Action::Unchanged)
    }
}

#[derive(Deserialize)]
struct Bundle {
    format: String,
    version: u64,
    paths: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    slug: String,
    path: Box<RawValue>,
}

fn problem(file: &str, message: impl Into<String>) -> PathProblem {
    PathProblem {
        file: file.to_string(),
        step: None,
        message: message.into(),
    }
}

/// Reads an export against the paths a site already has. `existing` maps each
/// stored slug to its path, or to `None` when the stored file does not parse.
/// A stored path that differs from the imported one is a conflict unless
/// `overwrite`, and a stored file that does not parse is always one, so an
/// import never silently replaces a file the author may want to repair.
pub fn plan_import(
    text: &str,
    existing: &BTreeMap<String, Option<ReadingPath>>,
    overwrite: bool,
) -> ImportPlan {
    const WHOLE: &str = "import";
    let mut plan = ImportPlan::default();
    if text.len() > MAX_EXPORT_BYTES {
        plan.problems
            .push(problem(WHOLE, format!("is over {MAX_EXPORT_BYTES} bytes")));
        return plan;
    }
    let bundle: Bundle = match serde_json::from_str(text) {
        Ok(bundle) => bundle,
        Err(error) => {
            // Line and column only: the parser's message can quote the input.
            plan.problems.push(problem(
                WHOLE,
                format!(
                    "is not a reading-path export (invalid JSON or shape at line {}, column {})",
                    error.line(),
                    error.column()
                ),
            ));
            return plan;
        }
    };
    if bundle.format != EXPORT_FORMAT {
        plan.problems.push(problem(
            WHOLE,
            format!("`format` must be `{EXPORT_FORMAT}`"),
        ));
        return plan;
    }
    if bundle.version != EXPORT_VERSION {
        plan.problems.push(problem(
            WHOLE,
            format!("`version` must be {EXPORT_VERSION}; this release reads no other"),
        ));
        return plan;
    }
    if bundle.paths.len() > MAX_PATHS {
        plan.problems.push(problem(
            WHOLE,
            format!(
                "holds {} paths; a site reads at most {MAX_PATHS}",
                bundle.paths.len()
            ),
        ));
        return plan;
    }
    let mut seen = BTreeSet::new();
    for (index, entry) in bundle.paths.iter().enumerate() {
        let number = index + 1;
        if !valid_path_slug(&entry.slug) {
            plan.problems.push(problem(
                &format!("{WHOLE} entry {number}"),
                "the slug is not a valid path slug: lowercase letters, digits and single hyphens, at most 64 characters, and not a name Windows reserves",
            ));
            continue;
        }
        let file = format!("{PATHS_DIR}/{}.json", entry.slug);
        if !seen.insert(entry.slug.clone()) {
            plan.problems
                .push(problem(&file, "appears more than once in the import"));
            continue;
        }
        if entry.path.get().len() > MAX_FILE_BYTES {
            plan.problems
                .push(problem(&file, format!("is over {MAX_FILE_BYTES} bytes")));
            continue;
        }
        let path = match ReadingPath::parse(&file, entry.path.get()) {
            Ok(path) => path,
            Err(mut problems) => {
                plan.problems.append(&mut problems);
                continue;
            }
        };
        let action = match existing.get(&entry.slug) {
            None => Action::Create,
            Some(Some(stored)) if *stored == path => Action::Unchanged,
            Some(Some(_)) if overwrite => Action::Replace,
            Some(Some(_)) => {
                plan.problems.push(problem(
                    &file,
                    "already exists with different content; nothing was written. Import with overwrite to replace it",
                ));
                Action::Replace
            }
            Some(None) => {
                plan.problems.push(problem(
                    &file,
                    "already exists and does not parse; repair or remove it first. Nothing was written",
                ));
                Action::Replace
            }
        };
        plan.paths.push(PlannedPath { path, action });
    }
    plan.paths.sort_by(|a, b| a.path.slug.cmp(&b.path.slug));
    let created = plan
        .paths
        .iter()
        .filter(|planned| planned.action == Action::Create)
        .count();
    if existing.len() + created > MAX_PATHS {
        plan.problems.push(problem(
            WHOLE,
            format!("would leave the site with more than {MAX_PATHS} path files"),
        ));
    }
    plan
}
