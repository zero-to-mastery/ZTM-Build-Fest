//! File-backed storage for the landing page (ADR 0246, #323).
//!
//! The page is the public, author-written file `<content>/landing.json`
//! (ADR 0245). Admin reads and writes it through this module and nothing
//! else, and never touches `openblog.json` to do so. A save names the
//! revision (SHA-256 of the stored bytes) it was based on, is checked by
//! `openblog_core::landing` before anything is written, and replaces the file
//! by atomic rename while the caller holds the content lock, so a refused,
//! stale or interrupted save leaves the stored file exactly as it was. What is
//! written is always the canonical form. A file written by a newer release is
//! never overwritten.

use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use openblog_core::landing::{
    LandingPage, LandingProblem, LANDING_FILE, LANDING_VERSION_MAX, MAX_FILE_BYTES,
};

use crate::source_store::{self, StoreError as RootError};

/// The stored file as read: its bytes' revision and what they parse to.
#[derive(Clone, Debug)]
pub struct Stored {
    /// SHA-256 of the bytes on disk.
    pub revision: String,
    /// The file as stored, exactly (lossy only if it is not UTF-8).
    pub text: String,
    pub parsed: Result<LandingPage, Vec<LandingProblem>>,
}

#[derive(Debug)]
pub enum StoreError {
    /// The file changed (or appeared, or went) after the revision was read.
    Conflict,
    /// The stored file was written by a newer release and is left alone.
    Newer(u64),
    /// The page is not acceptable. Nothing was written.
    Invalid(Vec<LandingProblem>),
    /// The file or folder could not be located, read or written safely.
    Storage(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict => f.write_str(
                "the landing page changed since it was read; reload it and apply the change again",
            ),
            Self::Newer(version) => write!(
                f,
                "the landing page was written by a newer open.blog (version {version}); it was not changed. Update open.blog to edit it"
            ),
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

fn file_path(root: &Path, content: &str) -> Result<PathBuf, StoreError> {
    source_store::contained(root, &Path::new(content).join(LANDING_FILE)).map_err(root_error)
}

fn read_file(path: &Path) -> Result<Option<Stored>, StoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(StoreError::Storage(format!(
                "cannot inspect {LANDING_FILE}: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(StoreError::Storage(format!(
            "{LANDING_FILE} is not a regular file"
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
    .map_err(|error| StoreError::Storage(format!("cannot read {LANDING_FILE}: {error}")))?;
    let revision = source_store::revision(&bytes);
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let parsed = if std::str::from_utf8(&bytes).is_err() {
        Err(vec![LandingProblem {
            section: None,
            message: "is not valid UTF-8".into(),
        }])
    } else {
        LandingPage::parse(&text)
    };
    Ok(Some(Stored {
        revision,
        text,
        parsed,
    }))
}

/// The stored landing page, if the site has one. A missing file is `None`,
/// not an error; a file that does not parse is returned with its problems.
pub fn read(root: &Path, content: &str) -> Result<Option<Stored>, StoreError> {
    read_file(&file_path(root, content)?)
}

/// The version a stored file declares, if it declares one this release does
/// not know. Such a file is never overwritten.
fn newer_version(text: &str) -> Option<u64> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()?
        .get("version")?
        .as_u64()
        .filter(|version| *version > LANDING_VERSION_MAX)
}

/// What a save wrote.
#[derive(Clone, Debug)]
pub struct Saved {
    pub revision: String,
    pub text: String,
    pub page: LandingPage,
}

/// Saves `page`. `expected_revision` is the revision the caller read, or
/// `None` to create the file where there is none. A different or missing
/// stored file is a [`StoreError::Conflict`]; the page is checked first, so an
/// invalid page writes nothing.
pub fn save(
    root: &Path,
    content: &str,
    expected_revision: Option<&str>,
    page: &LandingPage,
) -> Result<Saved, StoreError> {
    let problems = page.validate();
    if !problems.is_empty() {
        return Err(StoreError::Invalid(problems));
    }
    let target = file_path(root, content)?;
    match (read_file(&target)?, expected_revision) {
        (None, None) => {}
        (Some(current), Some(expected)) if current.revision == expected => {
            if let Some(version) = newer_version(&current.text) {
                return Err(StoreError::Newer(version));
            }
        }
        _ => return Err(StoreError::Conflict),
    }
    let text = page.to_canonical_json();
    write_bytes(&target, text.as_bytes())?;
    Ok(Saved {
        revision: source_store::revision(text.as_bytes()),
        text,
        page: page.clone(),
    })
}

fn write_bytes(target: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(StoreError::Invalid(vec![LandingProblem {
            section: None,
            message: format!("is over {MAX_FILE_BYTES} bytes"),
        }]));
    }
    let directory = target
        .parent()
        .ok_or_else(|| StoreError::Storage("the content folder has no parent".into()))?;
    fs::create_dir_all(directory).map_err(|error| {
        StoreError::Storage(format!("cannot create the content folder: {error}"))
    })?;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let temporary = directory.join(format!(".landing.{}-{unique}.tmp", std::process::id()));
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
            "could not save the landing page ({error}); the stored file is unchanged"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use openblog_core::config::HomeConfig;

    fn dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ob-landing-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("content")).unwrap();
        dir
    }

    fn page() -> LandingPage {
        LandingPage::from_legacy(&HomeConfig {
            heading: "Latest".into(),
            intro: "Hello".into(),
            show_series: true,
        })
    }

    fn on_disk(root: &Path) -> String {
        fs::read_to_string(root.join("content/landing.json")).unwrap()
    }

    #[test]
    fn a_missing_file_is_none_and_a_first_save_creates_it_atomically() {
        let root = dir("create");
        assert!(read(&root, "content").unwrap().is_none());
        let saved = save(&root, "content", None, &page()).unwrap();
        let stored = read(&root, "content").unwrap().unwrap();
        assert_eq!(stored.revision, saved.revision);
        assert_eq!(stored.text, saved.text);
        assert_eq!(stored.parsed.unwrap(), page());
        let names: Vec<_> = fs::read_dir(root.join("content"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["landing.json"], "no temporary file is left");
        assert!(matches!(
            save(&root, "content", None, &page()),
            Err(StoreError::Conflict)
        ));
    }

    #[test]
    fn a_stale_revision_conflicts_and_changes_nothing() {
        let root = dir("stale");
        let first = save(&root, "content", None, &page()).unwrap();
        let mut edited = page();
        edited.sections[1].hidden = true;
        let second = save(&root, "content", Some(&first.revision), &edited).unwrap();
        assert_eq!(on_disk(&root), second.text);
        for stale in [first.revision.as_str(), "nope"] {
            assert!(matches!(
                save(&root, "content", Some(stale), &page()),
                Err(StoreError::Conflict)
            ));
        }
        assert_eq!(on_disk(&root), second.text);
    }

    #[test]
    fn saving_over_a_missing_file_with_a_revision_conflicts() {
        let root = dir("vanished");
        assert!(matches!(
            save(&root, "content", Some("abc"), &page()),
            Err(StoreError::Conflict)
        ));
        assert!(!root.join("content/landing.json").exists());
    }

    #[test]
    fn an_invalid_page_writes_nothing() {
        let root = dir("invalid");
        let first = save(&root, "content", None, &page()).unwrap();
        let mut bad = page();
        bad.sections.push(bad.sections[0].clone());
        assert!(matches!(
            save(&root, "content", Some(&first.revision), &bad),
            Err(StoreError::Invalid(_))
        ));
        assert_eq!(on_disk(&root), first.text);
    }

    #[test]
    fn a_malformed_file_is_read_with_its_problems_and_can_be_repaired() {
        let root = dir("malformed");
        fs::write(root.join("content/landing.json"), "{ not json").unwrap();
        let stored = read(&root, "content").unwrap().unwrap();
        assert!(stored.parsed.is_err());
        let saved = save(&root, "content", Some(&stored.revision), &page()).unwrap();
        assert_eq!(
            read(&root, "content").unwrap().unwrap().revision,
            saved.revision
        );
    }

    #[test]
    fn a_file_from_a_newer_release_is_never_overwritten() {
        let root = dir("newer");
        let newer = r#"{"format":"openblog-landing","version":3,"sections":[],"kept":true}"#;
        fs::write(root.join("content/landing.json"), newer).unwrap();
        let stored = read(&root, "content").unwrap().unwrap();
        assert!(stored.parsed.is_err());
        assert!(matches!(
            save(&root, "content", Some(&stored.revision), &page()),
            Err(StoreError::Newer(3))
        ));
        assert_eq!(on_disk(&root), newer);
    }

    #[test]
    fn an_interrupted_write_leaves_the_previous_file_intact() {
        let root = dir("crash");
        let first = save(&root, "content", None, &page()).unwrap();
        // A crash mid-write leaves a temporary file that never replaced the
        // target, and the rename is the only step that changes the target.
        fs::write(root.join("content/.landing.1-2.tmp"), "{ half a fi").unwrap();
        let stored = read(&root, "content").unwrap().unwrap();
        assert_eq!(stored.text, first.text);
        assert_eq!(on_disk(&root), first.text);
        // A later save still works and does not read the leftover.
        let mut edited = page();
        edited.sections[0].hidden = false;
        assert!(save(&root, "content", Some(&first.revision), &edited).is_ok());
    }

    #[test]
    fn a_directory_in_the_way_is_refused() {
        let root = dir("directory");
        fs::create_dir_all(root.join("content/landing.json")).unwrap();
        assert!(matches!(
            read(&root, "content"),
            Err(StoreError::Storage(_))
        ));
        assert!(matches!(
            save(&root, "content", None, &page()),
            Err(StoreError::Storage(_))
        ));
    }

    #[test]
    fn the_content_folder_must_be_a_plain_path_inside_the_project() {
        let root = dir("escape");
        assert!(matches!(
            save(&root, "../outside", None, &page()),
            Err(StoreError::Storage(_))
        ));
    }
}
