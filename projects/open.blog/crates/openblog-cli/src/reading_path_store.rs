//! File-backed storage for reading paths (ADR 0213, #77).
//!
//! A path is the public, author-written file `<content>/paths/<slug>.json`
//! (ADR 0208). Admin reads and writes it through this module and nothing
//! else. Every change names the revision (SHA-256 of the stored bytes) it was
//! based on, is checked by `openblog_core::reading_path` before anything is
//! written, and replaces the file by atomic rename while the caller holds the
//! content lock, so a refused, stale or interrupted change leaves the stored
//! file exactly as it was. What is written is always the canonical form, so an
//! Admin save and a hand edit of the same path agree byte for byte, and fields
//! this release does not define are kept (ADR 0208).

use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use openblog_core::reading_path::{
    followed_index, valid_path_slug, PathProblem, ReadingPath, MAX_FILE_BYTES, MAX_PATHS, PATHS_DIR,
};

use crate::source_store::{self, StoreError as RootError};

/// One stored path file as read: its bytes' revision and what they parse to.
#[derive(Clone, Debug)]
pub struct Stored {
    pub slug: String,
    /// SHA-256 of the bytes on disk.
    pub revision: String,
    /// The file as stored, exactly (lossy only if it is not UTF-8).
    pub text: String,
    pub parsed: Result<ReadingPath, Vec<PathProblem>>,
}

#[derive(Debug)]
pub enum StoreError {
    /// The file changed (or appeared, or went) after the revision was read.
    Conflict,
    /// A create named a slug that already has a file.
    Exists,
    /// The slug has no file.
    Missing,
    /// The path is not acceptable. Nothing was written.
    Invalid(Vec<PathProblem>),
    /// The file or folder could not be located, read or written safely.
    Storage(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict => f.write_str(
                "this reading path changed since it was read; reload it and apply the change again",
            ),
            Self::Exists => f.write_str("a reading path with that slug already exists"),
            Self::Missing => f.write_str("no reading path has that slug"),
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
    source_store::contained(root, &Path::new(content).join(PATHS_DIR)).map_err(root_error)
}

fn file_path(root: &Path, content: &str, slug: &str) -> Result<PathBuf, StoreError> {
    if !valid_path_slug(slug) {
        return Err(StoreError::Invalid(vec![PathProblem {
            file: format!("{PATHS_DIR}/<slug>.json"),
            step: None,
            message:
                "a path slug is lowercase letters, digits and single hyphens, at most 64 characters"
                    .into(),
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
                "cannot inspect {PATHS_DIR}/{slug}.json: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(StoreError::Storage(format!(
            "{PATHS_DIR}/{slug}.json is not a regular file"
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
        StoreError::Storage(format!("cannot read {PATHS_DIR}/{slug}.json: {error}"))
    })?;
    let revision = source_store::revision(&bytes);
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let file = format!("{PATHS_DIR}/{slug}.json");
    let parsed = if std::str::from_utf8(&bytes).is_err() {
        Err(vec![PathProblem {
            file,
            step: None,
            message: "is not valid UTF-8".into(),
        }])
    } else {
        ReadingPath::parse(&file, &text)
    };
    Ok(Some(Stored {
        slug: slug.to_string(),
        revision,
        text,
        parsed,
    }))
}

/// One stored path, if the slug has a file.
pub fn read(root: &Path, content: &str, slug: &str) -> Result<Option<Stored>, StoreError> {
    let path = file_path(root, content, slug)?;
    read_file(&path, slug)
}

/// Every path file, sorted by slug, at most [`MAX_PATHS`]. A file that does
/// not parse is listed with its problems and never stops the others.
pub fn list(root: &Path, content: &str) -> Result<Vec<Stored>, StoreError> {
    let dir = directory(root, content)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(StoreError::Storage(format!(
                "cannot read {PATHS_DIR}: {error}"
            )))
        }
    };
    let mut slugs: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.strip_suffix(".json")
                .filter(|slug| valid_path_slug(slug))
                .map(str::to_string)
        })
        .collect();
    slugs.sort();
    slugs.truncate(MAX_PATHS);
    let mut stored = Vec::new();
    for slug in slugs {
        if let Some(file) = read_file(&dir.join(format!("{slug}.json")), &slug)? {
            stored.push(file);
        }
    }
    Ok(stored)
}

/// What Admin asks of a path beyond what the file format allows: every step
/// after the first states why it follows and how, even in a draft, because
/// the editor never writes a step the author has not explained.
pub fn requirements(path: &ReadingPath) -> Vec<PathProblem> {
    let mut problems = Vec::new();
    for (index, step) in path.steps.iter().enumerate() {
        if index > 0 && step.transition.is_none() {
            problems.push(PathProblem {
                file: format!("{PATHS_DIR}/{}.json", path.slug),
                step: Some(step.id.clone()),
                message: "choose how this step relates to the step it follows and say why in your own words".into(),
            });
        }
        // Admin never leaves an author with a step that follows nothing.
        if index > 0 && followed_index(&path.steps, index).is_none() {
            problems.push(PathProblem {
                file: format!("{PATHS_DIR}/{}.json", path.slug),
                step: Some(step.id.clone()),
                message: "there is no required step before this one to follow".into(),
            });
        }
    }
    problems
}

/// Whether the path may be written: the format's rules and Admin's.
pub fn check(path: &ReadingPath) -> Result<(), StoreError> {
    let mut problems = path.validate();
    problems.extend(requirements(path));
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
    pub path: ReadingPath,
}

/// Create a path. Refuses a slug that already has a file.
pub fn create(root: &Path, content: &str, path: &ReadingPath) -> Result<Saved, StoreError> {
    check(path)?;
    let target = file_path(root, content, &path.slug)?;
    if read_file(&target, &path.slug)?.is_some() {
        return Err(StoreError::Exists);
    }
    write(&target, path)
}

/// Replace a path named by `expected_revision`. Refuses when the file changed
/// or went, and when the path's slug is not the file's.
pub fn update(
    root: &Path,
    content: &str,
    expected_revision: &str,
    path: &ReadingPath,
) -> Result<Saved, StoreError> {
    check(path)?;
    let target = file_path(root, content, &path.slug)?;
    match read_file(&target, &path.slug)? {
        None => Err(StoreError::Missing),
        Some(current) if current.revision != expected_revision => Err(StoreError::Conflict),
        Some(_) => write(&target, path),
    }
}

/// Move a path file to the trash folder (`.openblog/trash`), never destroying
/// it, if it is still the revision the caller read. Returns the trashed name.
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
    let mut name = format!("{stamp}-paths_{slug}.json");
    let mut n = 1;
    while trash.join(&name).exists() {
        n += 1;
        name = format!("{stamp}-paths_{slug}-{n}.json");
    }
    crate::fsutil::replace_file(&target, &trash.join(&name)).map_err(|error| {
        StoreError::Storage(format!(
            "cannot move the reading path to the trash ({error}); it is unchanged"
        ))
    })?;
    Ok(name)
}

fn write(target: &Path, path: &ReadingPath) -> Result<Saved, StoreError> {
    let text = path.to_canonical_json();
    write_bytes(target, &path.slug, text.as_bytes())?;
    Ok(Saved {
        revision: source_store::revision(text.as_bytes()),
        text,
        path: path.clone(),
    })
}

/// Atomically replace (or create) one path file with exactly `bytes`.
fn write_bytes(target: &Path, slug: &str, bytes: &[u8]) -> Result<(), StoreError> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(StoreError::Invalid(vec![PathProblem {
            file: format!("{PATHS_DIR}/{slug}.json"),
            step: None,
            message: format!("is over {MAX_FILE_BYTES} bytes"),
        }]));
    }
    let directory = target
        .parent()
        .ok_or_else(|| StoreError::Storage("the paths folder has no parent".into()))?;
    fs::create_dir_all(directory)
        .map_err(|error| StoreError::Storage(format!("cannot create {PATHS_DIR}: {error}")))?;
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
            "could not save the reading path ({error}); the stored file is unchanged"
        )));
    }
    Ok(())
}

/// Write several already-checked paths as one unit (an import, ADR 0217): if
/// any write fails, every path written so far is put back to the bytes it had
/// (or removed if it was new), so a failed import leaves the folder as it
/// was. The caller holds the content lock.
pub fn write_all(root: &Path, content: &str, paths: &[&ReadingPath]) -> Result<(), StoreError> {
    let mut targets = Vec::new();
    for path in paths {
        check(path)?;
        let target = file_path(root, content, &path.slug)?;
        let before = match read_file(&target, &path.slug)? {
            Some(stored) => Some(stored.text.into_bytes()),
            None => None,
        };
        targets.push((target, path, before));
    }
    let mut done = 0;
    let mut failure = None;
    for (target, path, _) in &targets {
        if let Err(error) = write(target, path) {
            failure = Some(error);
            break;
        }
        done += 1;
    }
    let Some(error) = failure else {
        return Ok(());
    };
    for (target, path, before) in targets.iter().take(done).rev() {
        let _ = match before {
            Some(bytes) => write_bytes(target, &path.slug, bytes),
            None => crate::fsutil::retry_transient(|| fs::remove_file(target))
                .map_err(|error| StoreError::Storage(error.to_string())),
        };
    }
    Err(error)
}
