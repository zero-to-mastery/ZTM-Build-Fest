//! `openblog voice export` and `openblog voice import` (ADR 0284, #464).
//!
//! The author's voice library (sample files and the voice guide) in one portable JSON file. Both
//! need no hosted service and no build. Export is a dry run (the file is printed) unless `--out`
//! and `--write` say where to write it, and it leaves private material out unless
//! `--include-private` says otherwise. Import is a dry run unless `--write`: it reads the whole
//! file, checks every item, lists what it would do, and writes nothing at all when any part is
//! invalid or conflicts; a write is all-or-nothing and holds the voice store lock.
//!
//! Three rules hold throughout. A rough draft is never replaced, even with `--overwrite`. An item
//! keeps the folder it came from: an import never moves private material to the portable folder
//! (`--as private` can only do the opposite). A guide that quotes private samples never lands in
//! the portable folder. No message echoes text from the input.

use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use openblog_core::voice::exchange::{self, Item, MAX_EXPORT_BYTES, MAX_GUIDE_BYTES};
use openblog_core::voice::{VoiceSample, VoiceStage};

use crate::assistant_storage::contained_target;
use crate::voice_store::{self, Visibility};
use crate::{fsutil, portable_export};

pub struct Options<'a> {
    /// Export: the file to create. Import: the file to read.
    pub file: Option<&'a str>,
    pub write: bool,
    /// Export: include the private folder's samples and guide.
    pub include_private: bool,
    /// Import: replace a differing polished draft or guide.
    pub overwrite: bool,
    /// Import: land everything in the private folder.
    pub as_private: bool,
}

/// Where the guide for `visibility` lives, as defined once in `voice_store::guide_paths`.
fn guide_relative(root: &Path, visibility: Visibility) -> String {
    voice_store::guide_paths(root)
        .into_iter()
        .find(|(v, _)| *v == visibility)
        .map(|(_, relative)| relative)
        .unwrap_or_default()
}

fn guide_path(root: &Path, visibility: Visibility) -> Result<PathBuf, String> {
    contained_target(root, Path::new(&guide_relative(root, visibility)))
        .map_err(|error| format!("{error}."))
}

/// The guide's bytes, `None` if there is none; an oversized or irregular file is an error.
fn read_guide_bytes(root: &Path, visibility: Visibility) -> Result<Option<Vec<u8>>, String> {
    let path = guide_path(root, visibility)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read the voice guide: {error}")),
    };
    if !metadata.is_file() || metadata.len() as usize > MAX_GUIDE_BYTES {
        return Err(format!(
            "the {} voice guide is not a regular file of at most 64 KiB",
            visibility.as_str()
        ));
    }
    fs::read(&path)
        .map(Some)
        .map_err(|error| format!("cannot read the voice guide: {error}"))
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn visibility_named(item: &Item) -> Visibility {
    Visibility::parse(&item.visibility).unwrap_or(Visibility::Private)
}

// ---- export ----------------------------------------------------------------------------------

/// The export text, how many samples it holds and whether it holds a guide. Each thing left out
/// is said on standard error.
fn gather(root: &Path, include_private: bool) -> Result<Gathered, String> {
    let (gathered, left_out) = collect(root, include_private)?;
    for warning in left_out {
        eprintln!("warning: left out of the export: {warning}");
    }
    Ok(gathered)
}

/// The export text, how many samples it holds and whether it holds a guide.
type Gathered = (String, usize, bool);

/// [`gather`], with what was left out returned rather than printed.
fn collect(root: &Path, include_private: bool) -> Result<(Gathered, Vec<String>), String> {
    let mut left_out = Vec::new();
    let mut samples = Vec::new();
    for listed in voice_store::list(root) {
        if listed.visibility == Visibility::Private && !include_private {
            continue;
        }
        if !listed.valid {
            left_out.push(format!(
                "{} ({})",
                listed.file,
                listed.guidance.as_deref().unwrap_or("not a valid sample")
            ));
            continue;
        }
        let bytes = voice_store::raw(root, listed.visibility, &listed.file)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("{} disappeared while exporting", listed.file))?;
        let content =
            String::from_utf8(bytes).map_err(|_| format!("{} is not valid UTF-8", listed.file))?;
        samples.push(Item {
            visibility: listed.visibility.as_str().into(),
            file: listed.file,
            content,
        });
    }
    let mut guide = None;
    for visibility in [Visibility::Portable, Visibility::Private] {
        if visibility == Visibility::Private && !include_private {
            continue;
        }
        let Some(bytes) = read_guide_bytes(root, visibility)? else {
            continue;
        };
        let item = String::from_utf8(bytes).ok().map(|content| Item {
            visibility: visibility.as_str().into(),
            file: String::new(),
            content,
        });
        match item {
            Some(item) if exchange::check_guide(&item).is_ok() => {
                // One guide travels: the portable one, as the Assistant prefers it.
                if guide.is_none() {
                    guide = Some(item);
                } else {
                    left_out.push(format!(
                        "the {} voice guide (one guide travels, and the portable one is preferred)",
                        visibility.as_str()
                    ));
                }
            }
            _ => left_out.push(format!(
                "the {} voice guide (it is not text a guide may carry there)",
                visibility.as_str()
            )),
        }
    }
    let text = exchange::export(&samples, guide.as_ref());
    if text.len() > MAX_EXPORT_BYTES || samples.len() > exchange::MAX_SAMPLES {
        return Err(format!(
            "the library is larger than one export holds ({} samples, {} MiB); nothing was written",
            exchange::MAX_SAMPLES,
            MAX_EXPORT_BYTES / (1024 * 1024)
        ));
    }
    Ok(((text, samples.len(), guide.is_some()), left_out))
}

/// The nearest existing ancestor, resolved, with the rest appended.
fn resolved(path: &Path) -> PathBuf {
    let mut tail = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        if let Ok(mut found) = fs::canonicalize(&current) {
            for part in tail.iter().rev() {
                found.push(part);
            }
            return found;
        }
        match (current.file_name().map(|n| n.to_owned()), current.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                current = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// An export that carries private material may be written outside the project or in its private
/// folder, never somewhere a build, a feed or Git could pick it up.
fn private_destination_ok(root: &Path, destination: &Path) -> bool {
    let root = resolved(root);
    let destination = resolved(destination);
    !destination.starts_with(&root) || destination.starts_with(root.join(".openblog/private"))
}

pub fn export(root: &Path, options: &Options<'_>) -> Result<(), String> {
    crate::site::load_config(root)?;
    let (text, samples, guide) = gather(root, options.include_private)?;
    let Some(file) = options.file else {
        if options.write {
            return Err("--write needs --out <file>; nothing was written".into());
        }
        print!("{text}");
        return Ok(());
    };
    let destination = portable_export::output_path(root, file)?;
    if options.include_private && !private_destination_ok(root, &destination) {
        return Err("an export with private material cannot be written inside the project outside .openblog/private/; choose that folder or a place outside the project. Nothing was written".into());
    }
    let summary = format!(
        "{}{}{}",
        plural(samples, "voice sample", "voice samples"),
        if guide { " and the voice guide" } else { "" },
        if options.include_private {
            " (private material included)"
        } else {
            " (portable only)"
        }
    );
    if !options.write {
        println!(
            "Dry run: {summary} would be exported to {}. Re-run with --write to create the file.",
            destination.display()
        );
        return Ok(());
    }
    if options.include_private && resolved(&destination).starts_with(resolved(root)) {
        crate::landing_history::keep_out_of_git(root);
    }
    fsutil::write_new_atomic(&destination, text.as_bytes())?;
    println!("Exported {summary} to {}.", destination.display());
    Ok(())
}

// ---- import ----------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Create,
    Replace,
    Unchanged,
}

impl Action {
    fn verb(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Replace => "replace",
            Self::Unchanged => "unchanged",
        }
    }
}

struct Step {
    visibility: Visibility,
    /// A sample file name; `None` for the guide.
    file: Option<String>,
    content: String,
    action: Action,
}

impl Step {
    fn relative(&self, root: &Path) -> String {
        match &self.file {
            Some(file) => format!("{}/{file}", self.visibility.directory()),
            None => guide_relative(root, self.visibility),
        }
    }
}

fn read_export(root: &Path, file: &str) -> Result<String, String> {
    let path = portable_export::output_path(root, file)
        .map_err(|_| "the import path must name a file without `..`".to_string())?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("cannot read the import file: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("the import path is not a regular file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .and_then(|file| {
            file.take(MAX_EXPORT_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| format!("cannot read the import file: {error}"))?;
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err(format!(
            "the import file is over {MAX_EXPORT_BYTES} bytes; nothing was changed"
        ));
    }
    String::from_utf8(bytes).map_err(|_| "the import file is not valid UTF-8".to_string())
}

/// What importing `text` would do, and every reason it cannot. Reads the project, writes nothing.
fn plan(
    root: &Path,
    text: &str,
    overwrite: bool,
    as_private: bool,
) -> Result<(Vec<Step>, Vec<String>), String> {
    let mut bundle = match exchange::parse(text) {
        Ok(bundle) => bundle,
        Err(problems) => return Ok((Vec::new(), problems)),
    };
    let mut problems = Vec::new();
    if as_private {
        for item in bundle.samples.iter_mut().chain(bundle.guide.iter_mut()) {
            item.visibility = "private".into();
        }
        // Folding two folders into one can make a name appear twice.
        let mut seen = BTreeSet::new();
        if bundle.samples.iter().any(|item| !seen.insert(&item.file)) {
            problems.push("Two samples share a file name once both are private.".to_string());
        }
    }
    let mut steps: Vec<Step> = Vec::new();
    // Rough drafts are written before their polished partner, so a crash part-way never leaves
    // a polished draft without the rough draft it names.
    let mut polished_steps: Vec<Step> = Vec::new();
    let names: BTreeSet<(Visibility, String)> = bundle
        .samples
        .iter()
        .map(|item| (visibility_named(item), item.file.clone()))
        .collect();
    for item in &bundle.samples {
        let visibility = visibility_named(item);
        let sample = VoiceSample::parse(&item.content)?;
        let label = &item.file;
        // The same name in the other folder would split a pair; moving is a separate, explicit act.
        let other = visibility.other();
        let other_exists = voice_store::raw(root, other, &item.file)
            .map_err(|error| error.to_string())?
            .is_some()
            || names.contains(&(other, item.file.clone()));
        if other_exists {
            problems.push(format!(
                "{label}: a file with this name is already in the {} folder; an import never moves a sample between folders.",
                other.as_str()
            ));
            continue;
        }
        if sample.voice.stage == VoiceStage::Polished {
            let rough = sample.voice.rough_of.clone().unwrap_or_default();
            let has_rough = voice_store::raw(root, visibility, &rough)
                .map_err(|error| error.to_string())?
                .is_some()
                || names.contains(&(visibility, rough));
            if !has_rough {
                problems.push(format!(
                    "{label}: its rough draft is neither in the {} folder nor in this import.",
                    visibility.as_str()
                ));
                continue;
            }
        }
        let current =
            voice_store::raw(root, visibility, &item.file).map_err(|error| error.to_string())?;
        let action = match current {
            None => Action::Create,
            Some(bytes) if bytes == item.content.as_bytes() => Action::Unchanged,
            Some(bytes) => {
                let same_polished = VoiceSample::parse_bytes(&bytes).is_ok_and(|old| {
                    old.voice.stage == VoiceStage::Polished
                        && old.voice.prompt == sample.voice.prompt
                        && old.voice.rough_of == sample.voice.rough_of
                });
                if sample.voice.stage == VoiceStage::Rough {
                    problems.push(format!(
                        "{label}: a different rough draft is already saved. A rough draft is never replaced."
                    ));
                    continue;
                } else if !same_polished {
                    problems.push(format!(
                        "{label}: a file that is not this polished draft is already saved, so it is left as it is."
                    ));
                    continue;
                } else if !overwrite {
                    problems.push(format!(
                        "{label}: a different polished draft is already saved. Re-run with --overwrite to replace it."
                    ));
                    continue;
                }
                Action::Replace
            }
        };
        let step = Step {
            visibility,
            file: Some(item.file.clone()),
            content: item.content.clone(),
            action,
        };
        if sample.voice.stage == VoiceStage::Polished {
            polished_steps.push(step);
        } else {
            steps.push(step);
        }
    }
    steps.append(&mut polished_steps);
    if let Some(item) = &bundle.guide {
        let visibility = visibility_named(item);
        let action = match read_guide_bytes(root, visibility) {
            Ok(None) => Some(Action::Create),
            Ok(Some(bytes)) if bytes == item.content.as_bytes() => Some(Action::Unchanged),
            Ok(Some(_)) if overwrite => Some(Action::Replace),
            Ok(Some(_)) => {
                problems.push(format!(
                    "The {} voice guide: a different guide is already saved. Re-run with --overwrite to replace it.",
                    visibility.as_str()
                ));
                None
            }
            Err(error) => {
                problems.push(format!("The {} voice guide: {error}.", visibility.as_str()));
                None
            }
        };
        if let Some(action) = action {
            steps.push(Step {
                visibility,
                file: None,
                content: item.content.clone(),
                action,
            });
        }
    }
    Ok((steps, problems))
}

struct Undo {
    path: PathBuf,
    old: Option<Vec<u8>>,
    label: String,
}

/// The two filesystem effects `apply` can fail on, so a test can inject a failure.
struct Hooks {
    /// Runs after each write succeeds; an `Err` is treated as that write failing.
    after_write: fn(&Path) -> Result<(), String>,
    /// Puts one file back.
    restore: fn(&Undo) -> Result<(), String>,
}

fn restore_file(undo: &Undo) -> Result<(), String> {
    match &undo.old {
        Some(bytes) => voice_store::replace(&undo.path, bytes).map_err(|e| e.to_string()),
        None => match fs::remove_file(&undo.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        },
    }
}

/// Write every changing step, or put every file back and say why not.
fn apply(root: &Path, steps: &[Step]) -> Result<(), String> {
    apply_with(
        root,
        steps,
        &Hooks {
            after_write: |_| Ok(()),
            restore: restore_file,
        },
    )
}

fn apply_with(root: &Path, steps: &[Step], hooks: &Hooks) -> Result<(), String> {
    let mut done: Vec<Undo> = Vec::new();
    let result = (|| -> Result<(), String> {
        for step in steps.iter().filter(|s| s.action != Action::Unchanged) {
            let path = match &step.file {
                Some(file) => {
                    voice_store::refuse_linked_folder(root, step.visibility)
                        .map_err(|e| e.to_string())?;
                    voice_store::path_of(root, step.visibility, file).map_err(|e| e.to_string())?
                }
                None => guide_path(root, step.visibility)?,
            };
            let old = match step.action {
                Action::Replace => Some(
                    fs::read(&path)
                        .map_err(|error| format!("cannot read {}: {error}", step.relative(root)))?,
                ),
                _ => None,
            };
            // Recorded before the write: a write can publish the file and still report an error,
            // and the undo of a file that is not there is a no-op.
            done.push(Undo {
                path: path.clone(),
                old,
                label: step.relative(root),
            });
            if step.action == Action::Create {
                voice_store::create_new(&path, step.content.as_bytes())
                    .map_err(|error| error.to_string())?;
            } else {
                voice_store::replace(&path, step.content.as_bytes())
                    .map_err(|error| error.to_string())?;
            }
            (hooks.after_write)(&path)?;
            voice_store::keep_private_out_of_git(root, step.visibility);
        }
        Ok(())
    })();
    if let Err(message) = result {
        let failed: Vec<&str> = done
            .iter()
            .rev()
            .filter(|undo| (hooks.restore)(undo).is_err())
            .map(|undo| undo.label.as_str())
            .collect();
        if failed.is_empty() {
            return Err(format!("{message}; everything written was put back"));
        }
        return Err(format!(
            "{message}; could not restore: {}",
            failed.join(", ")
        ));
    }
    Ok(())
}

pub fn import(root: &Path, options: &Options<'_>) -> Result<(), String> {
    let file = options
        .file
        .ok_or("usage: openblog voice import <file> [--overwrite] [--as private] [--write]")?;
    crate::site::load_config(root)?;
    let text = read_export(root, file)?;
    // Same order Admin uses: the content transaction (a guide save holds it), then the voice
    // store lock. Admin's in-process build lock has no counterpart in a separate process.
    let _transaction = if options.write {
        Some(
            crate::transaction::ContentTransactionLock::acquire_with_wait(
                root,
                std::time::Duration::from_secs(3),
            )?,
        )
    } else {
        None
    };
    let _lock = if options.write {
        Some(voice_store::lock(root).map_err(|error| error.to_string())?)
    } else {
        None
    };
    let (steps, problems) = plan(root, &text, options.overwrite, options.as_private)?;
    for step in &steps {
        println!(
            "{} {} {}",
            step.action.verb(),
            step.visibility.as_str(),
            step.relative(root)
        );
    }
    if !problems.is_empty() {
        for problem in &problems {
            eprintln!("error: {problem}");
        }
        return Err(format!(
            "{} found; nothing was written",
            plural(problems.len(), "problem", "problems")
        ));
    }
    let writes = steps
        .iter()
        .filter(|s| s.action != Action::Unchanged)
        .count();
    let portable = steps
        .iter()
        .filter(|s| s.action != Action::Unchanged && s.visibility == Visibility::Portable)
        .count();
    if portable > 0 {
        println!(
            "Note: {} would go to the portable folder, which Git tracks. Re-run with --as private to keep everything private.",
            plural(portable, "file", "files")
        );
    }
    let matched = steps.len() - writes;
    if !options.write {
        println!(
            "Dry run: {} would be written, {matched} already match. Re-run with --write to apply.",
            plural(writes, "file", "files")
        );
        return Ok(());
    }
    apply(root, &steps)?;
    println!(
        "Imported {}; {matched} already matched.",
        plural(writes, "file", "files")
    );
    Ok(())
}

#[cfg(test)]
mod tests;
