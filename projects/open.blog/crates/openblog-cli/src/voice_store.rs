//! The voice sample store (ADR 0266, ADR 0267): the one place that reads and writes sample files.
//!
//! Samples live beside the other Assistant context, in `assistant/context/voice/` (portable) or
//! `.openblog/private/context/voice/` (private), as `<YYYY-MM-DD>-<prompt-id>-<stage>.md`. Every
//! path is resolved with [`crate::assistant_storage::contained_target`], every file is at most
//! 64 KiB of UTF-8, and a change to a polished draft carries a revision (the SHA-256 of the file
//! the caller last read), so a stale save is refused rather than lost.
//!
//! The rule everything else leans on is enforced here and not in any surface: **a rough draft is
//! created once and never changes.** [`write_rough`] creates the file without replacing anything
//! and only while a session record is open for that prompt (see `voice_session`); afterwards no
//! function in this module rewrites a rough file. Moving it copies the bytes unchanged and checks
//! them; erasing it is the author's act. Nothing here creates a folder until a sample is written,
//! so a project without samples is untouched.

use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use openblog_core::voice::catalog::{Catalog, MAX_CATALOG_BYTES};
use openblog_core::voice::draw::LibraryEntry;
use openblog_core::voice::{self, VoiceSample, VoiceStage};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::assistant_storage::contained_target;
use crate::fsutil;
use crate::transaction::FileLock;

/// The largest sample file, in bytes.
pub const MAX_BYTES: usize = voice::MAX_FILE_BYTES;
/// The site's own prompts and hidden packs.
pub const SITE_CATALOG_PATH: &str = "assistant/voice/catalog.md";
/// The open session record (always private); see `voice_session`.
pub const SESSION_PATH: &str = ".openblog/private/voice/session.json";
/// The `format` string of the session record.
pub const SESSION_FORMAT: &str = "openblog-voice-session";
const LOCK_PATH: &str = ".openblog/private/voice/store.lock";

/// Where a sample is kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Visibility {
    /// Beside the other portable Assistant context; may be committed and shared.
    Portable,
    /// Under `.openblog/private/`; never committed, published or exported.
    Private,
}

impl Visibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Portable => "portable",
            Self::Private => "private",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "portable" => Some(Self::Portable),
            "private" => Some(Self::Private),
            _ => None,
        }
    }

    /// The folder, relative to the project.
    pub fn directory(self) -> &'static str {
        match self {
            Self::Portable => "assistant/context/voice",
            Self::Private => ".openblog/private/context/voice",
        }
    }

    pub fn other(self) -> Self {
        match self {
            Self::Portable => Self::Private,
            Self::Private => Self::Portable,
        }
    }
}

/// Why the store did not do what was asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreError {
    /// Not allowed or not valid; the message is a plain sentence for the author.
    Refused(String),
    /// The file changed since the caller read it. `current` is its revision now, or `None` if it
    /// is gone.
    Stale {
        message: String,
        current: Option<String>,
    },
    /// The disk failed.
    Failed(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(message) | Self::Failed(message) => f.write_str(message),
            Self::Stale { message, .. } => f.write_str(message),
        }
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

fn refused<T>(message: impl Into<String>) -> Result<T> {
    Err(StoreError::Refused(message.into()))
}

fn failed(what: &str, error: impl fmt::Display) -> StoreError {
    StoreError::Failed(format!("{what}: {error}"))
}

/// What the store knows about one file without opening it as a sample.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listed {
    pub visibility: Visibility,
    pub file: String,
    pub valid: bool,
    /// Plain words about how to repair an invalid file.
    pub guidance: Option<String>,
    pub stage: Option<VoiceStage>,
    pub pack: Option<String>,
    pub prompt: Option<String>,
    pub title: Option<String>,
    pub words: Option<u32>,
    /// RFC 3339 date and time from the front matter.
    pub date: Option<String>,
    pub rough_of: Option<String>,
    pub revision: String,
    pub bytes: usize,
}

/// A sample and its listing entry.
#[derive(Clone, Debug)]
pub struct Loaded {
    pub listed: Listed,
    /// `None` if the file is invalid; `listed.guidance` says why.
    pub sample: Option<VoiceSample>,
}

/// A successful write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Written {
    pub visibility: Visibility,
    pub file: String,
    pub revision: String,
    /// False when the identical rough draft was already there (a repeated lock).
    pub created: bool,
}

/// The revision token of a file's bytes.
pub fn revision(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn check_file_name(file: &str) -> Result<()> {
    if file.len() > 160 || voice::parse_file_name(file).is_none() {
        return refused(
            "That is not a voice sample file name. It looks like 2026-10-28-a-mistake-i-made-rough.md.",
        );
    }
    Ok(())
}

pub(crate) fn path_of(root: &Path, visibility: Visibility, file: &str) -> Result<PathBuf> {
    check_file_name(file)?;
    contained_target(root, &Path::new(visibility.directory()).join(file))
        .map_err(|error| StoreError::Refused(format!("{error}.")))
}

fn directory_of(root: &Path, visibility: Visibility) -> Result<PathBuf> {
    contained_target(root, Path::new(visibility.directory()))
        .map_err(|error| StoreError::Refused(format!("{error}.")))
}

/// Read at most `MAX_BYTES + 1` bytes of a regular file; `None` if it is absent.
fn read_bounded(path: &Path) -> Result<Option<Vec<u8>>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failed("Cannot read the sample", error)),
    };
    if !metadata.is_file() {
        return refused("A voice sample must be a regular file, not a link or a folder.");
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes))
        .map_err(|error| failed("Cannot read the sample", error))?;
    Ok(Some(bytes))
}

pub(crate) fn lock(root: &Path) -> Result<FileLock> {
    let path = contained_target(root, Path::new(LOCK_PATH))
        .map_err(|error| StoreError::Refused(format!("{error}.")))?;
    FileLock::acquire(path, "voice sample write", Duration::from_secs(3))
        .map_err(StoreError::Failed)
}

fn listed_from(visibility: Visibility, file: &str, bytes: &[u8]) -> Loaded {
    let base = Listed {
        visibility,
        file: file.to_string(),
        valid: false,
        guidance: None,
        stage: None,
        pack: None,
        prompt: None,
        title: None,
        words: None,
        date: None,
        rough_of: None,
        revision: revision(bytes),
        bytes: bytes.len(),
    };
    let invalid = |guidance: String, base: Listed| Loaded {
        listed: Listed {
            guidance: Some(guidance),
            ..base
        },
        sample: None,
    };
    let Some((day, prompt, stage)) = voice::parse_file_name(file) else {
        return invalid(
            "The file name must look like 2026-10-28-prompt-id-rough.md. Rename it, or erase it here.".into(),
            base,
        );
    };
    if bytes.len() > MAX_BYTES {
        return invalid(
            format!(
                "This file is larger than the {} KiB limit. Shorten it before using it.",
                MAX_BYTES / 1024
            ),
            base,
        );
    }
    let sample = match VoiceSample::parse_bytes(bytes) {
        Ok(sample) => sample,
        Err(error) => {
            return invalid(
                format!("{error} Repair the file in a text editor, or erase it here."),
                base,
            );
        }
    };
    let mismatch = if sample.voice.stage != stage {
        Some("the stage in its name differs from the stage inside it")
    } else if sample.voice.prompt != prompt {
        Some("the prompt in its name differs from the prompt inside it")
    } else if stage == VoiceStage::Rough && sample.date.get(..10) != Some(day) {
        Some("the day in its name differs from the date inside it")
    } else {
        None
    };
    if let Some(reason) = mismatch {
        return invalid(
            format!("This file is not consistent: {reason}. Fix the name or the file."),
            base,
        );
    }
    Loaded {
        listed: Listed {
            valid: true,
            stage: Some(sample.voice.stage),
            pack: Some(sample.voice.pack.clone()),
            prompt: Some(sample.voice.prompt.clone()),
            title: Some(sample.title.clone()),
            words: Some(sample.voice.words),
            date: Some(sample.date.clone()),
            rough_of: sample.voice.rough_of.clone(),
            ..base
        },
        sample: Some(sample),
    }
}

/// Every sample file in both folders, valid or not, ordered by file name then visibility. Read
/// only: it creates nothing, and a project without samples lists nothing.
pub fn list(root: &Path) -> Vec<Listed> {
    let mut out: Vec<Listed> = Vec::new();
    for visibility in [Visibility::Portable, Visibility::Private] {
        let Ok(directory) = directory_of(root, visibility) else {
            continue;
        };
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        let mut found: Vec<Listed> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !name.ends_with(".md") {
                continue;
            }
            match read_bounded(&entry.path()) {
                Ok(Some(bytes)) => found.push(listed_from(visibility, &name, &bytes).listed),
                Ok(None) => {}
                Err(error) => found.push(Listed {
                    visibility,
                    file: name,
                    valid: false,
                    guidance: Some(format!(
                        "{error} Replace it with a regular file, or remove it."
                    )),
                    stage: None,
                    pack: None,
                    prompt: None,
                    title: None,
                    words: None,
                    date: None,
                    rough_of: None,
                    revision: String::new(),
                    bytes: 0,
                }),
            }
        }
        // A polished draft whose rough draft is gone cannot be trusted as a pair.
        let names: Vec<String> = found.iter().map(|l| l.file.clone()).collect();
        for item in &mut found {
            if let (true, Some(rough)) = (item.valid, item.rough_of.clone()) {
                if !names.contains(&rough) {
                    item.valid = false;
                    item.guidance = Some(format!(
                        "Its rough draft {rough} is missing from this folder. Put it back, or erase this polished draft."
                    ));
                }
            }
        }
        out.extend(found);
    }
    out.sort_by(|a, b| (&a.file, a.visibility).cmp(&(&b.file, b.visibility)));
    out
}

/// What the draw needs to know: which prompts have which stages, from the valid samples.
pub fn library(root: &Path) -> Vec<LibraryEntry> {
    list(root)
        .into_iter()
        .filter(|l| l.valid)
        .filter_map(|l| {
            Some(LibraryEntry {
                prompt: l.prompt?,
                stage: l.stage?,
            })
        })
        .collect()
}

/// The bytes of one stored sample file exactly as they are on disk, or `None` if there is no such
/// file. Read only; used by the portable export and import.
pub fn raw(root: &Path, visibility: Visibility, file: &str) -> Result<Option<Vec<u8>>> {
    read_bounded(&path_of(root, visibility, file)?)
}

/// One sample, with its revision.
pub fn read(root: &Path, visibility: Visibility, file: &str) -> Result<Loaded> {
    let path = path_of(root, visibility, file)?;
    match read_bounded(&path)? {
        Some(bytes) => Ok(listed_from(visibility, file, &bytes)),
        None => refused("There is no such voice sample."),
    }
}

/// The prompt id of the open session, if a valid session record exists.
pub fn open_session_prompt(root: &Path) -> Option<String> {
    open_session_key(root).map(|(prompt, _)| prompt)
}

/// The prompt and start time of the open session, which name it. (A real record always has its
/// start time; a test fixture may leave it out.)
fn open_session_key(root: &Path) -> Option<(String, Option<String>)> {
    let path = contained_target(root, Path::new(SESSION_PATH)).ok()?;
    let bytes = read_bounded(&path).ok()??;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    if value["format"] != SESSION_FORMAT || value["version"].as_u64() != Some(1) {
        return None;
    }
    Some((
        value["promptId"].as_str()?.to_string(),
        value["startedAt"].as_str().map(str::to_string),
    ))
}

fn write_text(sample: &VoiceSample) -> Result<Vec<u8>> {
    sample
        .serialize()
        .map(String::into_bytes)
        .map_err(StoreError::Refused)
}

/// Whatever the session said, a sample written to the private folder keeps that folder out of Git.
pub(crate) fn keep_private_out_of_git(root: &Path, visibility: Visibility) {
    if visibility == Visibility::Private {
        crate::landing_history::keep_out_of_git(root);
    }
}

/// Create a new file without replacing one, with a sentence that names the file and the cause but
/// never its absolute path.
pub(crate) fn create_new(path: &Path, bytes: &[u8]) -> Result<()> {
    fsutil::create_new_file(path, bytes).map_err(|cause| {
        let name = path
            .file_name()
            .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
        StoreError::Failed(format!(
            "Cannot save `{name}`; nothing was replaced ({cause})."
        ))
    })
}

/// Create the rough draft. Allowed only while the session that began at `sample.date` is open
/// for `sample.voice.prompt`, and only once: the file is created without replacing anything.
/// Writing the identical bytes again (a lock repeated after a crash) succeeds without touching
/// the file; anything else for an existing rough draft is refused. The session is checked while
/// the store lock is held, so a session scrapped (and perhaps started again) meanwhile is never
/// turned into a rough draft.
pub fn write_rough(root: &Path, visibility: Visibility, sample: &VoiceSample) -> Result<Written> {
    if sample.voice.stage != VoiceStage::Rough {
        return refused("Only a rough draft is written this way.");
    }
    let bytes = write_text(sample)?;
    let file = sample.file_name().map_err(StoreError::Refused)?;
    let path = path_of(root, visibility, &file)?;
    refuse_linked_folder(root, visibility)?;
    let _lock = lock(root)?;
    match open_session_key(root) {
        Some((prompt, started))
            if prompt == sample.voice.prompt
                && started
                    .as_deref()
                    .is_none_or(|started| started == sample.date) => {}
        Some((prompt, _)) if prompt == sample.voice.prompt => {
            return refused("That session was given up, so its text was not locked.")
        }
        Some(_) => return refused("The open session is for a different prompt."),
        None => {
            return refused(
                "A rough draft can only be saved at the end of a session, and no session is open.",
            )
        }
    }
    match read_bounded(&path)? {
        Some(existing) if existing == bytes => {
            keep_private_out_of_git(root, visibility);
            Ok(Written {
                visibility,
                file,
                revision: revision(&bytes),
                created: false,
            })
        }
        Some(_) => refused("This rough draft is locked. A rough draft is never changed after its session ends; polish a copy instead."),
        None => {
            // The same prompt on the same day in the other folder would split the pair.
            if let Ok(other) = path_of(root, visibility.other(), &file) {
                if read_bounded(&other)?.is_some() {
                    return refused("A rough draft for this prompt and day already exists in the other folder.");
                }
            }
            create_new(&path, &bytes)?;
            keep_private_out_of_git(root, visibility);
            Ok(Written {
                visibility,
                file,
                revision: revision(&bytes),
                created: true,
            })
        }
    }
}

/// Create or update the polished draft of an existing rough draft. The polished file takes its
/// name from the rough draft named in `voice.roughOf` and lives in the same folder. A new polished
/// draft passes `expected_revision: None`; saving over one passes the revision the caller read,
/// and a different current revision is [`StoreError::Stale`].
pub fn write_polished(
    root: &Path,
    visibility: Visibility,
    sample: &VoiceSample,
    expected_revision: Option<&str>,
) -> Result<Written> {
    if sample.voice.stage != VoiceStage::Polished {
        return refused(
            "Only a polished draft can be saved this way. A rough draft is never rewritten.",
        );
    }
    let rough_name =
        sample.voice.rough_of.as_deref().ok_or_else(|| {
            StoreError::Refused("A polished draft must name its rough draft.".into())
        })?;
    let file = voice::polished_file_name(rough_name).ok_or_else(|| {
        StoreError::Refused("A polished draft must name a rough draft file.".into())
    })?;
    let mut bytes = write_text(sample)?;
    let rough_path = path_of(root, visibility, rough_name)?;
    let path = path_of(root, visibility, &file)?;
    refuse_linked_folder(root, visibility)?;
    let _lock = lock(root)?;
    let rough = match read_bounded(&rough_path)? {
        Some(rough) => listed_from(visibility, rough_name, &rough),
        None => {
            return refused(
                "The rough draft this polished draft is for does not exist in this folder.",
            )
        }
    };
    match &rough.sample {
        Some(rough) if rough.voice.prompt == sample.voice.prompt && rough.voice.stage == VoiceStage::Rough => {}
        _ => return refused("The rough draft this polished draft names is not a valid rough draft for the same prompt."),
    }
    let current = read_bounded(&path)?;
    match (&current, expected_revision) {
        (None, None) => {
            create_new(&path, &bytes)?;
        }
        (None, Some(_)) => {
            return Err(StoreError::Stale {
                message: "This polished draft was erased since you opened it.".into(),
                current: None,
            })
        }
        (Some(existing), None) => {
            return Err(StoreError::Stale {
                message: "A polished draft already exists. Open it and save your changes to it."
                    .into(),
                current: Some(revision(existing)),
            })
        }
        (Some(existing), Some(expected)) => {
            let now = revision(existing);
            if now != expected {
                return Err(StoreError::Stale {
                    message: "This polished draft changed since you opened it. Reload it, then save again.".into(),
                    current: Some(now),
                });
            }
            // Only a readable polished draft of this very rough draft is ever replaced. A file
            // this release cannot read (a newer format, or damaged) is left for its owner.
            let old = match VoiceSample::parse_bytes(existing) {
                Ok(old) => old,
                Err(error) => {
                    return refused(format!(
                        "The saved polished draft cannot be read by this release, so it is left as it is. {error}"
                    ))
                }
            };
            if old.voice.stage != VoiceStage::Polished
                || old.voice.prompt != sample.voice.prompt
                || old.voice.rough_of != sample.voice.rough_of
            {
                return refused(
                    "That file is not the polished draft of this rough draft, so it is left as it is.",
                );
            }
            // Keep keys a newer release added that this save does not carry.
            let mut merged = sample.clone();
            for (key, value) in old.extra {
                merged.extra.entry(key).or_insert(value);
            }
            bytes = write_text(&merged)?;
            replace(&path, &bytes)?;
        }
    }
    keep_private_out_of_git(root, visibility);
    Ok(Written {
        visibility,
        file,
        revision: revision(&bytes),
        created: current.is_none(),
    })
}

pub(crate) fn replace(path: &Path, bytes: &[u8]) -> Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| StoreError::Failed("The sample has no folder.".into()))?;
    let token = crate::auth::random_token().map_err(StoreError::Failed)?;
    let temporary = directory.join(format!(".voice-{token}.tmp"));
    fs::write(&temporary, bytes).map_err(|error| failed("Cannot save the sample", error))?;
    if let Err(error) = fsutil::replace_file(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(failed("Cannot save the sample", error));
    }
    Ok(())
}

/// The names of the sample and, if it has one, its polished or rough partner that exist.
// Used by the Admin voice screen, not by the CLI.
fn pair(root: &Path, visibility: Visibility, file: &str) -> Result<(String, Option<String>)> {
    check_file_name(file)?;
    let path = path_of(root, visibility, file)?;
    let Some(bytes) = read_bounded(&path)? else {
        return refused("There is no such voice sample.");
    };
    let (_, _, stage) = voice::parse_file_name(file).expect("checked");
    match stage {
        VoiceStage::Rough => {
            let polished = voice::polished_file_name(file).expect("a rough name");
            let exists = read_bounded(&path_of(root, visibility, &polished)?)?.is_some();
            Ok((file.to_string(), exists.then_some(polished)))
        }
        VoiceStage::Polished => {
            let rough = listed_from(visibility, file, &bytes)
                .listed
                .rough_of
                .or_else(|| {
                    // An unreadable polished draft: the partner is the rough draft of its name.
                    let (day, prompt, _) = voice::parse_file_name(file)?;
                    Some(format!("{day}-{prompt}-rough.md"))
                })
                .expect("a rough name");
            Ok((rough, Some(file.to_string())))
        }
    }
}

/// Remove one original after its copy was verified. A test can make a named file fail here.
// Used by the Admin voice screen, not by the CLI.
fn remove_source(path: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    {
        let blocked = FAIL_REMOVE.with(|f| f.borrow().clone());
        if let (Some(name), Some(file)) = (blocked, path.file_name()) {
            if file.to_string_lossy() == name {
                return Err(std::io::Error::other("injected removal failure"));
            }
        }
    }
    fsutil::retry_transient(|| fs::remove_file(path))
}

#[cfg(test)]
thread_local! {
    static FAIL_REMOVE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Move a sample, with its polished or rough partner, to the other folder. The bytes are copied
/// unchanged and checked before the originals are removed, so a rough draft arrives exactly as it
/// was. Nothing is overwritten: a different file already at the destination refuses the move, but
/// a byte-identical copy there counts as already moved, so an interrupted move can be repeated.
/// The polished original is removed first and the rough original last; once any original is gone
/// no copy is ever deleted, and a failure reports that the move is partly done.
// Used by the Admin voice screen, not by the CLI.
pub fn move_visibility(
    root: &Path,
    from: Visibility,
    file: &str,
    to: Visibility,
) -> Result<Vec<String>> {
    if from == to {
        return refused("The sample is already there.");
    }
    refuse_linked_folder(root, from)?;
    refuse_linked_folder(root, to)?;
    let _lock = lock(root)?;
    let (rough, polished) = pair(root, from, file)?;
    let mut names = vec![rough];
    names.extend(polished);
    // Copies this call created, which are undone only while every original is still in place.
    let mut copies: Vec<PathBuf> = Vec::new();
    let mut removed = 0usize;
    let result = (|| -> Result<()> {
        let mut staged = Vec::new();
        for name in &names {
            let source = path_of(root, from, name)?;
            let target = path_of(root, to, name)?;
            let Some(bytes) = read_bounded(&source)? else {
                return refused("A file of this sample is missing.");
            };
            if bytes.len() > MAX_BYTES {
                return refused("A file of this sample is larger than the limit.");
            }
            let present = match read_bounded(&target)? {
                None => false,
                Some(existing) if existing == bytes => true,
                Some(_) => return refused(format!("{name} already exists in the other folder.")),
            };
            staged.push((source, target, bytes, present));
        }
        for (_, target, bytes, present) in &staged {
            if !present {
                create_new(target, bytes)?;
                copies.push(target.clone());
            }
        }
        for (_, target, bytes, _) in &staged {
            if read_bounded(target)?.as_deref() != Some(bytes.as_slice()) {
                return Err(StoreError::Failed(
                    "The copy did not match the original, so nothing was moved.".into(),
                ));
            }
        }
        // Polished first, rough last: the rough draft's original is the last thing to go.
        for (source, _, _, _) in staged.iter().rev() {
            remove_source(source).map_err(|error| failed("Cannot remove the original", error))?;
            removed += 1;
        }
        Ok(())
    })();
    if let Err(error) = result {
        if removed > 0 {
            // An original is gone, so its copy is now the only one. Keep every copy.
            return Err(StoreError::Failed(format!(
                "The move is partly done: {error} Nothing was deleted. Run the move again to finish it."
            )));
        }
        // No original was touched; undo only the copies.
        for copy in copies {
            let _ = fsutil::retry_transient(|| fs::remove_file(&copy));
        }
        return Err(error);
    }
    keep_private_out_of_git(root, to);
    Ok(names)
}

/// Where the voice guide lives, in each visibility, relative to the project. This is the ONE place
/// that names those files: the plan, the erase and the post-check all read it, so the guide the
/// Assistant writes (epic VS4) is wired in here and nowhere else.
pub fn guide_paths(_root: &Path) -> Vec<(Visibility, String)> {
    vec![
        (
            Visibility::Portable,
            "assistant/context/voice.md".to_string(),
        ),
        (
            Visibility::Private,
            ".openblog/private/context/voice.md".to_string(),
        ),
    ]
}

/// The largest voice guide a move carries: the context file limit.
pub const MAX_GUIDE_BYTES: u64 = 64 * 1024;

/// The guide's file in one visibility, relative to the project (from [`guide_paths`]).
pub fn guide_path(root: &Path, visibility: Visibility) -> String {
    guide_paths(root)
        .into_iter()
        .find(|(v, _)| *v == visibility)
        .map(|(_, path)| path)
        .expect("both visibilities are named")
}

/// What a voice guide move would do, or did (ADR 0289).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuideMove {
    pub from: Visibility,
    pub to: Visibility,
    /// Relative paths.
    pub from_path: String,
    pub to_path: String,
    pub bytes: usize,
    /// An identical copy is already at the destination: an interrupted move that only needs the
    /// original removed.
    pub finishing: bool,
}

/// The samples a saved guide's traits cite, read again from the store: each file's visibility and
/// text. A sample that no longer exists (or no longer parses) is left out. Read only.
pub fn carried_samples(
    root: &Path,
    saved: &openblog_core::voice::merge::SavedGuide,
) -> std::collections::BTreeMap<String, (Visibility, String)> {
    let mut found = std::collections::BTreeMap::new();
    for file in saved.cited_samples() {
        for visibility in [Visibility::Portable, Visibility::Private] {
            if let Ok(loaded) = read(root, visibility, file) {
                if let Some(sample) = loaded.sample {
                    found.insert(file.to_string(), (visibility, sample.body));
                    break;
                }
            }
        }
    }
    found
}

/// Whether a guide's text is private-derived (ADR 0288, ADR 0289): its provenance line names a
/// private sample, or one of its traits cites a sample that is private now. Such a guide never
/// goes to portable context, which Git tracks. The guide merge and the guide move share this rule.
pub fn guide_is_private_derived(root: &Path, text: &str) -> bool {
    openblog_core::voice::guide::quotes_private_samples(text)
        || carried_samples(root, &openblog_core::voice::merge::SavedGuide::parse(text))
            .values()
            .any(|(visibility, _)| *visibility == Visibility::Private)
}

/// Check a guide move and read the guide. Read only.
fn check_guide_move(root: &Path, to: Visibility) -> Result<(GuideMove, Vec<u8>)> {
    let from = to.other();
    let from_path = guide_path(root, from);
    let to_path = guide_path(root, to);
    for relative in [&from_path, &to_path] {
        if linked_on_the_way(root, Path::new(relative))? {
            return refused(format!(
                "{relative}, or a folder on the way to it, is a link, so the guide was not moved. Replace it with a real file or folder, then try again."
            ));
        }
    }
    let source = contained(root, &from_path)?;
    let target = contained(root, &to_path)?;
    let unreadable = |why: &str| -> StoreError {
        StoreError::Refused(format!(
            "The {} voice guide {why}, so it was not moved. Repair or replace it in the Context view first.",
            from.as_str()
        ))
    };
    let bytes = match fs::symlink_metadata(&source) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return refused(format!(
                "There is no {} voice guide to move.",
                from.as_str()
            ));
        }
        Err(error) => return Err(failed("Cannot inspect the voice guide", error)),
        Ok(metadata) if !metadata.is_file() => return Err(unreadable("is not a regular file")),
        Ok(metadata) if metadata.len() > MAX_GUIDE_BYTES => {
            return Err(unreadable("is larger than 64 KiB"))
        }
        Ok(_) => fsutil::retry_transient(|| fs::read(&source))
            .map_err(|_| unreadable("cannot be read"))?,
    };
    if bytes.len() as u64 > MAX_GUIDE_BYTES {
        return Err(unreadable("is larger than 64 KiB"));
    }
    if to == Visibility::Portable {
        // Portable context is tracked by Git: only a guide that can be read, and whose provenance
        // does not name a private sample, goes there.
        let text = std::str::from_utf8(&bytes).map_err(|_| unreadable("is not readable text"))?;
        if guide_is_private_derived(root, text) {
            return refused(
                "This guide quotes private samples, so it stays private. Portable context is tracked by Git.",
            );
        }
    }
    let finishing = match fs::symlink_metadata(&target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(failed("Cannot inspect the voice guide", error)),
        Ok(metadata) if !metadata.is_file() => {
            return refused(format!(
                "{to_path} is not a regular file, so the guide was not moved."
            ));
        }
        Ok(_) => {
            let existing = fsutil::retry_transient(|| fs::read(&target))
                .map_err(|error| failed("Cannot read the other voice guide", error))?;
            if existing != bytes {
                return refused(format!(
                    "A {} voice guide already exists and differs, so nothing was moved. Keep one of the two first.",
                    to.as_str()
                ));
            }
            true
        }
    };
    Ok((
        GuideMove {
            from,
            to,
            from_path,
            to_path,
            bytes: bytes.len(),
            finishing,
        },
        bytes,
    ))
}

/// What moving the guide to `to` would do, or why it is refused. Read only; it creates nothing.
pub fn plan_guide_move(root: &Path, to: Visibility) -> Result<GuideMove> {
    check_guide_move(root, to).map(|(planned, _)| planned)
}

/// Move the voice guide to the other folder in one step (ADR 0289). The bytes are copied unchanged
/// and read back before the original is removed, so a failure never loses the guide: a copy that
/// does not match is removed and the original stays, and an original that cannot be removed leaves
/// two identical copies and a move that can be run again. Nothing is overwritten. The caller holds
/// the content transaction lock (a guide save holds it too); this takes the store lock, the same
/// order an import uses.
pub fn move_guide(root: &Path, to: Visibility) -> Result<GuideMove> {
    let _lock = lock(root)?;
    let (planned, bytes) = check_guide_move(root, to)?;
    let source = contained(root, &planned.from_path)?;
    let target = contained(root, &planned.to_path)?;
    // The ignore rule is in place before a private copy exists.
    keep_private_out_of_git(root, to);
    if !planned.finishing {
        create_new(&target, &bytes)?;
        let copied = fsutil::retry_transient(|| fs::read(&target)).ok();
        if copied.as_deref() != Some(bytes.as_slice()) {
            let _ = fsutil::retry_transient(|| fs::remove_file(&target));
            return Err(StoreError::Failed(
                "The copy did not match the guide, so nothing was moved.".into(),
            ));
        }
    }
    if let Err(error) = remove_source(&source) {
        return Err(StoreError::Failed(format!(
            "The guide was copied to {}, but {} could not be removed ({error}). Both copies are the same; run the move again to finish it.",
            planned.to_path, planned.from_path
        )));
    }
    Ok(planned)
}

/// The folder (relative) that holds the session record, the editor files and the erase trash.
const PRIVATE_VOICE_DIR: &str = ".openblog/private/voice";
/// File-name stems the CLI gives its editor files in [`PRIVATE_VOICE_DIR`].
const EDITOR_STEMS: [&str; 2] = ["editing", "polishing"];
const TRASH_PREFIX: &str = "erasing-";

/// What kind of thing an erase removes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EraseKind {
    Sample,
    Session,
    Guide,
    EditorFile,
    /// A half-written temporary file or other regular file left in a sample folder.
    Leftover,
}

impl EraseKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sample => "sample",
            Self::Session => "session record",
            Self::Guide => "voice guide",
            Self::EditorFile => "editor file",
            Self::Leftover => "leftover file",
        }
    }
}

/// One file an erase would remove, named relative to the project. Never its contents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EraseItem {
    pub path: String,
    pub kind: EraseKind,
}

/// The result of an erase: what went, and anything the post-check still found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EraseReport {
    pub erased: Vec<EraseItem>,
    /// Paths that still exist after the erase; empty means the post-check passed.
    pub remaining: Vec<String>,
}

fn is_editor_file(name: &str) -> bool {
    EDITOR_STEMS.iter().any(|stem| {
        name == format!("{stem}.md")
            || (name.starts_with(&format!("{stem}-")) && name.ends_with(".md"))
    })
}

fn is_file_or_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| !m.is_dir())
}

fn contained(root: &Path, relative: &str) -> Result<PathBuf> {
    contained_target(root, Path::new(relative))
        .map_err(|error| StoreError::Refused(format!("{error}.")))
}

/// Whether a path is a symlink, a junction or any other reparse point.
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// A voice folder (relative to the project) with every ancestor up to the root checked: if any is
/// a link or reparse point the erase is refused, because enumerating or deleting through it could
/// reach another folder of the project (the posts, say). A folder that does not exist is fine.
/// Whether `relative` (or a folder on the way to it) is a link or a reparse point.
fn linked_on_the_way(root: &Path, relative: &Path) -> Result<bool> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if is_link_or_reparse(&metadata) => return Ok(true),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(failed("Cannot inspect a voice folder", error)),
        }
    }
    Ok(false)
}

fn unlinked_dir(root: &Path, relative: &Path) -> Result<PathBuf> {
    if linked_on_the_way(root, relative)? {
        return refused(format!(
            "{} is a link, so nothing was erased. Replace it with a real folder or remove the link, then run erase again.",
            relative.display()
        ));
    }
    contained(root, &relative.to_string_lossy())
}

/// A sample folder reached through a link is never written to, even when the link points inside
/// the project (for example at `content/posts`, where a build or a commit would pick a sample up).
/// The erase refuses the same layout.
pub(crate) fn refuse_linked_folder(root: &Path, visibility: Visibility) -> Result<()> {
    if linked_on_the_way(root, Path::new(visibility.directory()))? {
        return refused(format!(
            "{} is a link, so nothing was saved. Replace it with a real folder or remove the link, then try again.",
            visibility.directory()
        ));
    }
    Ok(())
}

/// Every folder an erase reads or deletes from, checked for links. Touches nothing.
fn guard_voice_folders(root: &Path) -> Result<()> {
    for visibility in [Visibility::Portable, Visibility::Private] {
        unlinked_dir(root, Path::new(visibility.directory()))?;
    }
    unlinked_dir(root, Path::new(PRIVATE_VOICE_DIR))?;
    for (_, relative) in guide_paths(root) {
        if let Some(parent) = Path::new(&relative).parent() {
            unlinked_dir(root, parent)?;
        }
    }
    Ok(())
}

fn file_names(directory: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| is_file_or_link(&entry.path()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// Every voice file that exists, in both folders. Read only. A regular file or link inside a sample
/// folder counts, valid sample or not; a folder inside one does not (it is never touched).
fn collect(root: &Path) -> Result<Vec<EraseItem>> {
    guard_voice_folders(root)?;
    let mut items = Vec::new();
    for visibility in [Visibility::Portable, Visibility::Private] {
        for name in file_names(&directory_of(root, visibility)?) {
            let kind = if name.starts_with('.') || !name.ends_with(".md") {
                EraseKind::Leftover
            } else {
                EraseKind::Sample
            };
            items.push(EraseItem {
                path: format!("{}/{name}", visibility.directory()),
                kind,
            });
        }
    }
    if is_file_or_link(&contained(root, SESSION_PATH)?) {
        items.push(EraseItem {
            path: SESSION_PATH.to_string(),
            kind: EraseKind::Session,
        });
    }
    for (_, relative) in guide_paths(root) {
        if is_file_or_link(&contained(root, &relative)?) {
            items.push(EraseItem {
                path: relative,
                kind: EraseKind::Guide,
            });
        }
    }
    for name in file_names(&contained(root, PRIVATE_VOICE_DIR)?) {
        let kind = if is_editor_file(&name) {
            EraseKind::EditorFile
        } else if name.starts_with(".session-") && name.ends_with(".tmp") {
            // A session record a crash left half-written: it holds the timed draft.
            EraseKind::Leftover
        } else {
            continue;
        };
        items.push(EraseItem {
            path: format!("{PRIVATE_VOICE_DIR}/{name}"),
            kind,
        });
    }
    Ok(items)
}

/// What [`erase_all`] would remove now. Read only; it creates nothing.
pub fn erase_plan(root: &Path) -> Result<Vec<EraseItem>> {
    collect(root)
}

/// Put one file in the trash folder. A test can make a named file fail here.
fn stage_for_erase(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    {
        let blocked = FAIL_ERASE.with(|f| f.borrow().clone());
        if let (Some(name), Some(file)) = (blocked, from.file_name()) {
            if file.to_string_lossy() == name {
                return Err(std::io::Error::other("injected erase failure"));
            }
        }
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    fsutil::retry_transient(|| fs::rename(from, to))
}

#[cfg(test)]
thread_local! {
    static FAIL_CHECK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_ERASE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Delete the `erasing-*` folders an earlier failed erase left behind. Only real folders are
/// deleted; a link with that name is left alone and the post-check reports it.
fn remove_stale_trash(root: &Path) -> Result<()> {
    let private = unlinked_dir(root, Path::new(PRIVATE_VOICE_DIR))?;
    let Ok(entries) = fs::read_dir(&private) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(TRASH_PREFIX)
        {
            continue;
        }
        let is_real_dir =
            fs::symlink_metadata(entry.path()).is_ok_and(|m| m.is_dir() && !is_link_or_reparse(&m));
        if is_real_dir {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

/// Erase everything the voice feature stored: samples in both folders, the session record, the
/// guide and leftover editor files. All or nothing: every file is first moved into a trash folder
/// under `.openblog/private/voice/`, a failed move puts every moved file back and changes nothing,
/// and only when every file is in the trash is the trash deleted. The post-check then lists
/// anything that still exists. The caller has already asked the author to confirm.
pub fn erase_all(root: &Path) -> Result<EraseReport> {
    let lock = lock(root)?;
    let plan = collect(root)?;
    let token = crate::auth::random_token().map_err(StoreError::Failed)?;
    let trash_relative = format!("{PRIVATE_VOICE_DIR}/{TRASH_PREFIX}{token}");
    let trash = contained(root, &trash_relative)?;
    // Work out and check every (from, to) pair before the first rename, so a bad entry changes
    // nothing. Containment is checked on the parent folder only and the file name is joined on, so
    // a link entry is renamed as a link and never followed.
    let mut pairs: Vec<(PathBuf, PathBuf, String)> = Vec::new();
    for (index, item) in plan.iter().enumerate() {
        let relative = Path::new(&item.path);
        let (Some(parent), Some(name)) = (relative.parent(), relative.file_name()) else {
            return refused("A voice file has no folder to erase it from.");
        };
        let from = contained_target(root, parent)
            .map_err(|error| StoreError::Refused(format!("{error}.")))?
            .join(name);
        // The index keeps two files with the same name in different folders apart.
        pairs.push((from, trash.join(index.to_string()), item.path.clone()));
    }
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut failure = None;
    for (from, to, shown) in pairs {
        match stage_for_erase(&from, &to) {
            Ok(()) => staged.push((from, to)),
            Err(error) => {
                failure = Some(format!("Cannot erase {shown}: {error}"));
                break;
            }
        }
    }
    if let Some(message) = failure {
        let mut stuck = false;
        for (from, to) in staged.iter().rev() {
            stuck |= fsutil::retry_transient(|| fs::rename(to, from)).is_err();
        }
        if !stuck {
            let _ = fs::remove_dir_all(&trash);
            return Err(StoreError::Failed(format!(
                "{message}. Nothing was erased."
            )));
        }
        return Err(StoreError::Failed(format!(
            "{message}. Some files could not be put back and are kept in {trash_relative}."
        )));
    }
    if let Err(error) = fsutil::retry_transient(|| fs::remove_dir_all(&trash)) {
        if trash.exists() {
            return Err(StoreError::Failed(format!(
                "The voice files were set aside but could not be deleted: {error}. Delete {trash_relative} by hand, or run erase again."
            )));
        }
    }
    // A trash folder an earlier failed erase left behind goes too, unless the folders are links.
    remove_stale_trash(root)?;
    // Empty sample folders go too; a folder that is not empty stays and the post-check says so.
    for visibility in [Visibility::Portable, Visibility::Private] {
        if let Ok(directory) = unlinked_dir(root, Path::new(visibility.directory())) {
            let _ = fs::remove_dir(&directory);
        }
    }
    drop(lock);
    // The post-check: look again, from scratch. The files are already gone, so if the check itself
    // cannot run that is said plainly and is not reported as a failed erase.
    let remaining = match post_check(root, &trash_relative) {
        Ok(remaining) => remaining,
        Err(error) => {
            return Err(StoreError::Failed(format!(
                "The voice files were erased, but the check afterwards could not run: {error}. Run erase again to check."
            )));
        }
    };
    Ok(EraseReport {
        erased: plan,
        remaining,
    })
}

/// What still exists after an erase. Errors only when the check could not look.
fn post_check(root: &Path, trash_relative: &str) -> Result<Vec<String>> {
    #[cfg(test)]
    if FAIL_CHECK.with(|f| f.get()) {
        return Err(StoreError::Failed("injected check failure".into()));
    }
    let mut remaining: Vec<String> = collect(root)?.into_iter().map(|item| item.path).collect();
    for name in file_names(&contained(root, PRIVATE_VOICE_DIR)?) {
        if name.starts_with(TRASH_PREFIX) {
            remaining.push(format!("{PRIVATE_VOICE_DIR}/{name}"));
        }
    }
    if contained(root, trash_relative).is_ok_and(|path| path.exists()) {
        remaining.push(trash_relative.to_string());
    }
    for visibility in [Visibility::Portable, Visibility::Private] {
        let directory = directory_of(root, visibility)?;
        if fs::read_dir(&directory).is_ok_and(|mut entries| entries.next().is_some()) {
            remaining.push(visibility.directory().to_string());
        }
    }
    remaining.sort();
    remaining.dedup();
    Ok(remaining)
}

/// The slugs the posts under the content folder already use, drafts included, worked out the
/// way a site load does: the `slug` front matter field, else the file name without its date.
fn post_slugs(root: &Path, config: &openblog_core::SiteConfig) -> Result<Vec<String>> {
    let sources = crate::site::read_sources(root, config).map_err(StoreError::Failed)?;
    Ok(sources
        .posts
        .iter()
        .map(|file| {
            let from_field = openblog_core::frontmatter::parse(&file.contents)
                .ok()
                .and_then(|doc| {
                    doc.front_matter
                        .get("slug")
                        .map(openblog_core::slug::slugify)
                });
            from_field.unwrap_or_else(|| {
                let name = file.path.rsplit('/').next().unwrap_or(&file.path);
                let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
                openblog_core::slug::from_file_stem(stem)
            })
        })
        .collect())
}

/// Make a post draft from a polished sample: the one promotion path for the CLI and Admin.
///
/// `file` names a sample in `visibility`'s folder. It must be a valid polished draft (a rough
/// draft is refused, since the author's rough words are never what gets published). `dir` is an
/// optional folder inside the content folder's `posts/` folder; the default is `posts`. The post is
/// created once, as `draft: true`, without replacing anything, and it is checked with the
/// ordinary post parser before it is written. A slug already used by a post, or a file that
/// already exists, is refused and nothing is written. The sample is never touched. Returns the
/// new file's path relative to the project root, with `/` separators.
///
/// The caller holds the content transaction lock (`transaction::ContentTransactionLock`), as
/// every other content write does.
pub fn promote_to_post_draft(
    root: &Path,
    visibility: Visibility,
    file: &str,
    dir: Option<&str>,
) -> Result<PathBuf> {
    let folder = dir.map_or("posts", str::trim).trim_matches('/');
    let folder_ok = !folder.is_empty()
        && !folder.contains('\\')
        && folder
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && !part.starts_with('_'))
        && (folder == "posts" || folder.starts_with("posts/"));
    if !folder_ok {
        return refused("The folder must be `posts` or a folder inside it, such as `posts/2026`.");
    }
    let loaded = read(root, visibility, file)?;
    let Some(sample) = loaded.sample else {
        return refused(format!(
            "That sample cannot be used: {}",
            loaded.listed.guidance.unwrap_or_default()
        ));
    };
    let config = crate::site::load_config(root).map_err(StoreError::Refused)?;
    let slugs = post_slugs(root, &config)?;
    let slug_refs: Vec<&str> = slugs.iter().map(String::as_str).collect();
    let draft = sample
        .to_post_draft(&slug_refs)
        .map_err(StoreError::Refused)?;

    let relative = format!("{}/{}/{}", config.paths.content, folder, draft.file_name);
    // The post loads with the ordinary parser before anything is written.
    let in_content = format!("{folder}/{}", draft.file_name);
    openblog_core::model::load_post(
        &openblog_core::SourceFile {
            path: in_content,
            contents: draft.markdown.clone(),
        },
        &config,
        openblog_core::markdown::RenderOptions::default(),
    )
    .map_err(|error| StoreError::Refused(format!("The post draft is not valid: {error}")))?;

    let target = contained_target(root, Path::new(&relative))
        .map_err(|error| StoreError::Refused(format!("{error}.")))?;
    if target.exists() {
        return refused(format!(
            "{relative} already exists. Nothing was written; choose a different slug first."
        ));
    }
    create_new(&target, draft.markdown.as_bytes())?;
    Ok(PathBuf::from(relative))
}

/// The prompt catalog for this site: the bundled one plus `assistant/voice/catalog.md` if the
/// site has it. A site file that cannot be used is reported in `warnings` and the bundled catalog
/// is used on its own, so a typo never takes the feature away.
pub fn load_catalog(root: &Path) -> Catalog {
    let bundled = Catalog::parse_bundled(crate::voice_prompts::BUNDLED)
        .expect("the bundled voice catalog is valid (tested)");
    let site = contained_target(root, Path::new(SITE_CATALOG_PATH))
        .map_err(|error| format!("{error}."))
        .and_then(|path| match fs::symlink_metadata(&path) {
            Ok(m) if m.is_file() && m.len() <= MAX_CATALOG_BYTES as u64 => {
                fs::read_to_string(&path)
                    .map(Some)
                    .map_err(|_| "The site voice catalog is not valid UTF-8 text.".to_string())
            }
            Ok(_) => Err(format!(
                "The site voice catalog must be a regular file under {} KiB.",
                MAX_CATALOG_BYTES / 1024
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("Cannot read the site voice catalog: {error}.")),
        });
    match site {
        Ok(None) => bundled,
        Ok(Some(text)) => {
            match Catalog::parse_site(&text).and_then(|s| Catalog::merge(bundled.clone(), s)) {
                Ok(merged) => merged,
                Err(error) => {
                    let mut fallback = bundled;
                    fallback
                        .warnings
                        .push(format!("The site voice catalog was not used. {error}"));
                    fallback
                }
            }
        }
        Err(warning) => {
            let mut fallback = bundled;
            fallback.warnings.push(warning);
            fallback
        }
    }
}

#[cfg(test)]
pub(crate) mod tests_support {
    //! A throwaway project folder shared by the store and session tests.
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    pub struct Project(pub PathBuf);

    impl Project {
        pub fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ob-voice-store-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        /// A project with an open session for `prompt`.
        pub fn with_session(prompt: &str) -> Self {
            let project = Self::new();
            project.open_session(prompt);
            project
        }

        pub fn open_session(&self, prompt: &str) {
            let path = self.0.join(SESSION_PATH);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(
                path,
                format!(r#"{{"format":"{SESSION_FORMAT}","version":1,"promptId":"{prompt}"}}"#),
            )
            .unwrap();
        }

        pub fn close_session(&self) {
            fs::remove_file(self.0.join(SESSION_PATH)).unwrap();
        }
    }

    impl Drop for Project {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests;
