//! File-backed storage for interpretation comparisons (ADR 0226 and 0231, #89).
//!
//! A comparison is the public, author-written file
//! `<content>/comparisons/<slug>.json` (ADR 0226). Admin reads and writes it
//! through this module and nothing else. Every change names the revision
//! (SHA-256 of the stored bytes) it was based on, is checked by
//! `openblog_core::scholarly_comparison` before anything is written, and
//! replaces the file by atomic rename while the caller holds the content
//! lock, so a refused, stale or interrupted change leaves the stored file
//! exactly as it was. What is written is always the canonical form, so an
//! Admin save and a hand edit of the same comparison agree byte for byte, and
//! fields this release does not define are kept.

use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use openblog_core::scholarly_comparison::{
    valid_comparison_slug, Comparison, ComparisonProblem, COMPARISONS_DIR, MAX_FILE_BYTES,
};

use crate::source_store::{self, StoreError as RootError};

/// The most comparison files Admin lists.
pub const MAX_LISTED: usize = 500;

/// One stored comparison file as read: its bytes' revision and what they
/// parse to.
#[derive(Clone, Debug)]
pub struct Stored {
    pub slug: String,
    /// SHA-256 of the bytes on disk.
    pub revision: String,
    /// The file as stored, exactly (lossy only if it is not UTF-8).
    pub text: String,
    pub parsed: Result<Comparison, Vec<ComparisonProblem>>,
}

#[derive(Debug)]
pub enum StoreError {
    /// The file changed (or appeared, or went) after the revision was read.
    Conflict,
    /// A create named a slug that already has a file.
    Exists,
    /// The slug has no file.
    Missing,
    /// The comparison is not acceptable. Nothing was written.
    Invalid(Vec<ComparisonProblem>),
    /// The file or folder could not be located, read or written safely.
    Storage(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict => f.write_str(
                "this comparison changed since it was read; reload it and apply the change again",
            ),
            Self::Exists => f.write_str("a comparison with that slug already exists"),
            Self::Missing => f.write_str("no comparison has that slug"),
            Self::Invalid(problems) => {
                let lines: Vec<String> = problems.iter().map(ToString::to_string).collect();
                f.write_str(&lines.join("\n"))
            }
            Self::Storage(message) => f.write_str(message),
        }
    }
}

fn root_error(error: RootError) -> StoreError {
    StoreError::Storage(error.to_string())
}

fn directory(root: &Path, content: &str) -> Result<PathBuf, StoreError> {
    source_store::contained(root, &Path::new(content).join(COMPARISONS_DIR)).map_err(root_error)
}

fn file_path(root: &Path, content: &str, slug: &str) -> Result<PathBuf, StoreError> {
    if !valid_comparison_slug(slug) {
        return Err(StoreError::Invalid(vec![ComparisonProblem {
            file: format!("{COMPARISONS_DIR}/<slug>.json"),
            item: None,
            message: "a comparison slug is lowercase letters, digits and single hyphens, at most 64 characters".into(),
        }]));
    }
    Ok(directory(root, content)?.join(format!("{slug}.json")))
}

fn read_file(path: &Path, slug: &str) -> Result<Option<Stored>, StoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(StoreError::Storage(format!(
                "cannot inspect {COMPARISONS_DIR}/{slug}.json: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(StoreError::Storage(format!(
            "{COMPARISONS_DIR}/{slug}.json is not a regular file"
        )));
    }
    let mut bytes = Vec::new();
    crate::fsutil::retry_transient(|| {
        bytes.clear();
        fs::File::open(path)?
            .take(MAX_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map(|_| ())
    })
    .map_err(|error| {
        StoreError::Storage(format!(
            "cannot read {COMPARISONS_DIR}/{slug}.json: {error}"
        ))
    })?;
    let revision = source_store::revision(&bytes);
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let file = format!("{COMPARISONS_DIR}/{slug}.json");
    let parsed = if std::str::from_utf8(&bytes).is_err() {
        Err(vec![ComparisonProblem {
            file,
            item: None,
            message: "is not valid UTF-8".into(),
        }])
    } else {
        Comparison::parse(&file, &text)
    };
    Ok(Some(Stored {
        slug: slug.to_string(),
        revision,
        text,
        parsed,
    }))
}

/// One stored comparison, if the slug has a file.
pub fn read(root: &Path, content: &str, slug: &str) -> Result<Option<Stored>, StoreError> {
    let path = file_path(root, content, slug)?;
    read_file(&path, slug)
}

/// Every comparison file, sorted by slug, at most [`MAX_LISTED`]. A file that
/// does not parse is listed with its problems and never stops the others.
pub fn list(root: &Path, content: &str) -> Result<Vec<Stored>, StoreError> {
    let dir = directory(root, content)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(StoreError::Storage(format!(
                "cannot read {COMPARISONS_DIR}: {error}"
            )))
        }
    };
    let mut slugs: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.strip_suffix(".json")
                .filter(|slug| valid_comparison_slug(slug))
                .map(str::to_string)
        })
        .collect();
    slugs.sort();
    slugs.truncate(MAX_LISTED);
    let mut stored = Vec::new();
    for slug in slugs {
        if let Some(file) = read_file(&dir.join(format!("{slug}.json")), &slug)? {
            stored.push(file);
        }
    }
    Ok(stored)
}

/// Whether the comparison may be written: the format's rules.
pub fn check(comparison: &Comparison) -> Result<(), StoreError> {
    let problems = comparison.validate();
    if problems.is_empty() {
        Ok(())
    } else {
        Err(StoreError::Invalid(problems))
    }
}

/// The result of a write: what is now stored.
#[derive(Clone, Debug)]
pub struct Saved {
    pub revision: String,
    pub text: String,
    pub comparison: Comparison,
}

/// Create a comparison. Refuses a slug that already has a file.
pub fn create(root: &Path, content: &str, comparison: &Comparison) -> Result<Saved, StoreError> {
    check(comparison)?;
    let target = file_path(root, content, &comparison.slug)?;
    if read_file(&target, &comparison.slug)?.is_some() {
        return Err(StoreError::Exists);
    }
    write(&target, comparison)
}

/// Replace a comparison named by `expected_revision`. Refuses when the file
/// changed or went.
pub fn update(
    root: &Path,
    content: &str,
    expected_revision: &str,
    comparison: &Comparison,
) -> Result<Saved, StoreError> {
    check(comparison)?;
    let target = file_path(root, content, &comparison.slug)?;
    match read_file(&target, &comparison.slug)? {
        None => Err(StoreError::Missing),
        Some(current) if current.revision != expected_revision => Err(StoreError::Conflict),
        Some(_) => write(&target, comparison),
    }
}

/// Move a comparison file to the trash folder (`.openblog/trash`), never
/// destroying it, if it is still the revision the caller read. Returns the
/// trashed name.
pub fn delete(
    root: &Path,
    content: &str,
    slug: &str,
    expected_revision: &str,
    stamp: &str,
) -> Result<String, StoreError> {
    let target = file_path(root, content, slug)?;
    match read_file(&target, slug)? {
        None => return Err(StoreError::Missing),
        Some(current) if current.revision != expected_revision => return Err(StoreError::Conflict),
        Some(_) => {}
    }
    let trash = root.join(".openblog").join("trash");
    fs::create_dir_all(&trash)
        .map_err(|error| StoreError::Storage(format!("cannot create the trash folder: {error}")))?;
    let mut name = format!("{stamp}-comparisons_{slug}.json");
    let mut n = 1;
    while trash.join(&name).exists() {
        n += 1;
        name = format!("{stamp}-comparisons_{slug}-{n}.json");
    }
    crate::fsutil::replace_file(&target, &trash.join(&name)).map_err(|error| {
        StoreError::Storage(format!(
            "cannot move the comparison to the trash ({error}); it is unchanged"
        ))
    })?;
    Ok(name)
}

fn write(target: &Path, comparison: &Comparison) -> Result<Saved, StoreError> {
    let text = comparison.to_canonical_json();
    write_bytes(target, &comparison.slug, text.as_bytes())?;
    Ok(Saved {
        revision: source_store::revision(text.as_bytes()),
        text,
        comparison: comparison.clone(),
    })
}

/// Atomically replace (or create) one comparison file with exactly `bytes`.
fn write_bytes(target: &Path, slug: &str, bytes: &[u8]) -> Result<(), StoreError> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(StoreError::Invalid(vec![ComparisonProblem {
            file: format!("{COMPARISONS_DIR}/{slug}.json"),
            item: None,
            message: format!("is over {MAX_FILE_BYTES} bytes"),
        }]));
    }
    let directory = target
        .parent()
        .ok_or_else(|| StoreError::Storage("the comparisons folder has no parent".into()))?;
    fs::create_dir_all(directory).map_err(|error| {
        StoreError::Storage(format!("cannot create {COMPARISONS_DIR}: {error}"))
    })?;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let temporary = directory.join(format!(".{slug}.{}-{unique}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        crate::fsutil::replace_file(&temporary, target)
    })();
    if let Err(error) = result {
        let _ = crate::fsutil::retry_transient(|| fs::remove_file(&temporary));
        return Err(StoreError::Storage(format!(
            "could not save the comparison ({error}); the stored file is unchanged"
        )));
    }
    Ok(())
}
