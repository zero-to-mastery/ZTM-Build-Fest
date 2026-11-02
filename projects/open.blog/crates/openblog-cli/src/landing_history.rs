//! Previous saved versions of the landing page (ADR 0264, #337).
//!
//! Every page Admin saves is also kept as one small file under `.openblog/private/landing-history/`,
//! outside the content folder, so no build, feed, search index, export or Git commit ever sees it.
//! The newest [`MAX_VERSIONS`] are kept; older ones are pruned after a new one is safely written.
//! Each file is `{ "format": "openblog-landing-history", "version": 1, ... }`: a file written by a
//! newer release is listed as skipped and never rewritten or deleted. Restoring a version is an
//! ordinary save of that page (so it creates a new version) made by the route, under the same
//! locks and revision check as any save.
//!
//! Recording is best effort and never makes a save fail: the page file is the source of truth.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use openblog_core::landing::{LandingPage, LANDING_FORMAT, MAX_FILE_BYTES};
use serde_json::{json, Value};

use crate::source_store;

pub const HISTORY_FORMAT: &str = "openblog-landing-history";
pub const HISTORY_VERSION: u64 = 1;
/// How many previous versions are kept.
pub const MAX_VERSIONS: usize = 20;
const DIRECTORY: &str = ".openblog/private/landing-history";
/// A history file is a page plus a few short fields.
const MAX_ENTRY_BYTES: usize = MAX_FILE_BYTES * 2 + 4096;

/// One kept version, without its page.
#[derive(Clone, Debug, PartialEq)]
pub struct Meta {
    pub id: u64,
    pub saved_at: String,
    /// SHA-256 revision of the landing file this version wrote.
    pub revision: String,
    pub summary: String,
    pub sections: usize,
}

/// A kept version with its page.
#[derive(Clone, Debug)]
pub struct Entry {
    pub meta: Meta,
    pub page: LandingPage,
}

/// The versions on disk, newest first, and how many files were left alone because this release
/// cannot read them.
#[derive(Clone, Debug, Default)]
pub struct Listing {
    pub versions: Vec<Meta>,
    pub skipped: usize,
}

fn directory(root: &Path) -> Result<PathBuf, String> {
    source_store::contained(root, Path::new(DIRECTORY)).map_err(|error| error.to_string())
}

fn file_name(id: u64) -> String {
    format!("{id:010}.json")
}

fn id_of(name: &str) -> Option<u64> {
    let stem = name.strip_suffix(".json")?;
    if stem.len() == 10 && stem.bytes().all(|b| b.is_ascii_digit()) {
        stem.parse().ok()
    } else {
        None
    }
}

fn read_value(path: &Path) -> Option<Value> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(MAX_ENTRY_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > MAX_ENTRY_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

/// The entry in `value`, or `None` if it is not one this release can read.
fn entry_from(id: u64, value: &Value) -> Option<Entry> {
    if value["format"] != HISTORY_FORMAT || value["version"].as_u64() != Some(HISTORY_VERSION) {
        return None;
    }
    let mut page = value["page"].as_object()?.clone();
    page.insert("format".into(), json!(LANDING_FORMAT));
    let version = openblog_core::landing::version_for_page(&page);
    page.insert("version".into(), json!(version));
    let page = LandingPage::parse(&Value::Object(page).to_string()).ok()?;
    Some(Entry {
        meta: Meta {
            id,
            saved_at: value["savedAt"].as_str()?.to_string(),
            revision: value["revision"].as_str()?.to_string(),
            summary: value["summary"].as_str().unwrap_or("").to_string(),
            sections: page.sections.len(),
        },
        page,
    })
}

fn ids(directory: &Path) -> Vec<u64> {
    let mut found: Vec<u64> = fs::read_dir(directory)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter_map(|entry| id_of(&entry.file_name().to_string_lossy()))
                .collect()
        })
        .unwrap_or_default();
    found.sort_unstable();
    found
}

/// The kept versions, newest first.
pub fn list(root: &Path) -> Listing {
    let Ok(directory) = directory(root) else {
        return Listing::default();
    };
    let mut listing = Listing::default();
    for id in ids(&directory).into_iter().rev() {
        match read_value(&directory.join(file_name(id))).and_then(|value| entry_from(id, &value)) {
            Some(entry) => listing.versions.push(entry.meta),
            None => listing.skipped += 1,
        }
    }
    listing
}

/// One kept version with its page.
pub fn read(root: &Path, id: u64) -> Option<Entry> {
    let directory = directory(root).ok()?;
    entry_from(id, &read_value(&directory.join(file_name(id)))?)
}

/// A short plain sentence about what changed from `previous` to `page`.
pub fn summarize(previous: Option<&LandingPage>, page: &LandingPage) -> String {
    let count = page.sections.len();
    let Some(previous) = previous else {
        return format!(
            "First saved version, {count} section{}",
            if count == 1 { "" } else { "s" }
        );
    };
    let find = |sections: &'_ [openblog_core::landing::Section], id: &str| {
        sections.iter().position(|section| section.id == id)
    };
    let (mut added, mut removed, mut changed, mut hidden, mut shown) = (0, 0, 0, 0, 0);
    for section in &page.sections {
        match find(&previous.sections, &section.id) {
            None => added += 1,
            Some(at) => {
                let before = &previous.sections[at];
                if before.hidden != section.hidden {
                    if section.hidden {
                        hidden += 1;
                    } else {
                        shown += 1;
                    }
                }
                if before.kind != section.kind || before.extra != section.extra {
                    changed += 1;
                }
            }
        }
    }
    for section in &previous.sections {
        if find(&page.sections, &section.id).is_none() {
            removed += 1;
        }
    }
    let kept: Vec<&str> = page
        .sections
        .iter()
        .filter(|s| find(&previous.sections, &s.id).is_some())
        .map(|s| s.id.as_str())
        .collect();
    let before: Vec<&str> = previous
        .sections
        .iter()
        .filter(|s| find(&page.sections, &s.id).is_some())
        .map(|s| s.id.as_str())
        .collect();
    let mut parts = Vec::new();
    let plural = |n: usize| if n == 1 { "section" } else { "sections" };
    for (n, verb) in [
        (added, "Added"),
        (removed, "Removed"),
        (changed, "Changed"),
        (hidden, "Hid"),
        (shown, "Showed"),
    ] {
        if n > 0 {
            parts.push(format!("{verb} {n} {}", plural(n)));
        }
    }
    if kept != before {
        parts.push("Reordered sections".to_string());
    }
    if previous.extra != page.extra && parts.is_empty() {
        parts.push("Changed page details".to_string());
    }
    if parts.is_empty() {
        "No visible change".to_string()
    } else {
        parts.join(", ")
    }
}

/// Whether `root` is inside a Git working tree: it, or a folder above it, holds `.git` (a folder,
/// or the file a worktree or submodule has).
fn inside_git(root: &Path) -> bool {
    let start = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    start.ancestors().any(|folder| folder.join(".git").exists())
}

/// Keep `.openblog/private/` out of Git for a project that uses it, as `openblog init` does. A site
/// in a subfolder of a repository gets the rule in its own `.gitignore`, which Git honours there.
pub(crate) fn keep_out_of_git(root: &Path) {
    if !inside_git(root) {
        return;
    }
    let path = root.join(".gitignore");
    // Only a missing file counts as empty. A file that cannot be read (for example one that is not
    // UTF-8) is left exactly as it is: the history still works, it just is not added to it.
    let existing = match fs::read(&path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => return,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return,
    };
    if existing.lines().any(|line| {
        matches!(
            line.trim(),
            "/.openblog"
                | "/.openblog/"
                | ".openblog"
                | ".openblog/"
                | "/.openblog/private/"
                | "/.openblog/private"
                | ".openblog/private/"
        )
    }) {
        return;
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str("/.openblog/private/\n");
    let _ = crate::fsutil::write_file(&path, text.as_bytes());
}

fn write_entry(directory: &Path, id: u64, value: &Value) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("cannot create the history folder: {error}"))?;
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())? + "\n";
    let temporary = directory.join(format!(".{}.{}.tmp", file_name(id), std::process::id()));
    let target = directory.join(file_name(id));
    fs::write(&temporary, text.as_bytes())
        .map_err(|error| format!("cannot write the history: {error}"))?;
    crate::fsutil::replace_file(&temporary, &target).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("cannot write the history: {error}")
    })
}

/// Keep `page` (written as `text`, with this `revision`) as the newest version. A revision that is
/// already the newest version is not kept twice. Returns the new version's id, if one was made.
pub fn record(
    root: &Path,
    revision: &str,
    page: &LandingPage,
    summary: &str,
) -> Result<Option<u64>, String> {
    let directory = directory(root)?;
    let existing = ids(&directory);
    if let Some(&newest) = existing.last() {
        if read_value(&directory.join(file_name(newest)))
            .is_some_and(|value| value["revision"] == revision)
        {
            return Ok(None);
        }
    }
    let id = existing.last().map_or(1, |newest| newest + 1);
    let canonical: Value =
        serde_json::from_str(&page.to_canonical_json()).map_err(|e| e.to_string())?;
    let mut body = canonical.as_object().cloned().unwrap_or_default();
    body.remove("format");
    body.remove("version");
    let value = json!({
        "format": HISTORY_FORMAT,
        "version": HISTORY_VERSION,
        "id": id,
        "savedAt": crate::clock::now().rfc3339(),
        "revision": revision,
        "summary": summary,
        "page": Value::Object(body),
    });
    keep_out_of_git(root);
    write_entry(&directory, id, &value)?;
    prune(&directory);
    Ok(Some(id))
}

/// Remove the oldest readable versions beyond [`MAX_VERSIONS`]. Files this release cannot read are
/// never counted or removed.
fn prune(directory: &Path) {
    let readable: Vec<u64> = ids(directory)
        .into_iter()
        .filter(|id| {
            read_value(&directory.join(file_name(*id)))
                .is_some_and(|value| entry_from(*id, &value).is_some())
        })
        .collect();
    let excess = readable.len().saturating_sub(MAX_VERSIONS);
    for id in readable.into_iter().take(excess) {
        let _ = fs::remove_file(directory.join(file_name(id)));
    }
}

/// Make sure the file Admin is about to replace is among the kept versions, so a save or a restore
/// never loses it: a page edited by hand, or saved before history existed, is kept as it was.
pub fn keep_current(root: &Path, revision: &str, page: &LandingPage) -> Result<(), String> {
    let directory = directory(root)?;
    for id in ids(&directory) {
        if read_value(&directory.join(file_name(id)))
            .is_some_and(|value| value["revision"] == revision)
        {
            return Ok(());
        }
    }
    record(root, revision, page, "Kept before the next change").map(|_| ())
}

/// Keep the bytes of a stored file that is not a readable page, as `raw-<revision>.bak` in the
/// history folder (never listed as a version), before it is replaced.
pub fn keep_raw(root: &Path, revision: &str, text: &str) -> Result<(), String> {
    let directory = directory(root)?;
    let safe: String = revision
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(64)
        .collect();
    fs::create_dir_all(&directory)
        .map_err(|error| format!("cannot create the history folder: {error}"))?;
    keep_out_of_git(root);
    let target = directory.join(format!("raw-{safe}.bak"));
    if target.exists() {
        return Ok(());
    }
    fs::write(&target, text.as_bytes())
        .map_err(|error| format!("cannot write the history: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ob-landing-history-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn page(headings: &[&str]) -> LandingPage {
        let sections: Vec<Value> = headings
            .iter()
            .enumerate()
            .map(|(i, h)| json!({"id": format!("s{i}"), "type": "welcome", "heading": h}))
            .collect();
        LandingPage::parse(
            &json!({"format": LANDING_FORMAT, "version": 1, "sections": sections}).to_string(),
        )
        .unwrap()
    }

    fn revision(page: &LandingPage) -> String {
        source_store::revision(page.to_canonical_json().as_bytes())
    }

    fn save(root: &Path, page: &LandingPage) -> Option<u64> {
        record(root, &revision(page), page, "test").unwrap()
    }

    #[test]
    fn versions_are_kept_newest_first_and_read_back_exactly() {
        let root = root("order");
        let (a, b) = (page(&["A"]), page(&["B"]));
        assert_eq!(save(&root, &a), Some(1));
        assert_eq!(save(&root, &b), Some(2));
        let listing = list(&root);
        assert_eq!(
            listing.versions.iter().map(|m| m.id).collect::<Vec<_>>(),
            [2, 1]
        );
        assert_eq!(listing.versions[0].revision, revision(&b));
        assert_eq!(read(&root, 1).unwrap().page, a);
        assert!(read(&root, 9).is_none());
        assert!(
            !root.join("content").exists(),
            "nothing goes into the content folder"
        );
    }

    #[test]
    fn the_same_revision_is_not_kept_twice_in_a_row() {
        let root = root("dedupe");
        let a = page(&["A"]);
        assert_eq!(save(&root, &a), Some(1));
        assert_eq!(save(&root, &a), None);
        assert_eq!(list(&root).versions.len(), 1);
        // Going back to an older page after a different one is a new version.
        save(&root, &page(&["B"]));
        assert_eq!(save(&root, &a), Some(3));
    }

    #[test]
    fn history_is_bounded_and_the_oldest_go_first() {
        let root = root("bound");
        for n in 0..(MAX_VERSIONS + 7) {
            save(&root, &page(&[&format!("Version {n}")]));
        }
        let listing = list(&root);
        assert_eq!(listing.versions.len(), MAX_VERSIONS);
        assert_eq!(listing.versions[0].id as usize, MAX_VERSIONS + 7);
        assert_eq!(listing.versions.last().unwrap().id as usize, 8);
        assert!(read(&root, 1).is_none());
        let files = fs::read_dir(root.join(DIRECTORY)).unwrap().count();
        assert_eq!(files, MAX_VERSIONS, "no temporary file is left");
    }

    #[test]
    fn a_file_from_a_newer_release_or_a_damaged_one_is_skipped_and_never_touched() {
        let root = root("future");
        save(&root, &page(&["A"]));
        let directory = root.join(DIRECTORY);
        let newer = r#"{"format":"openblog-landing-history","version":2,"id":2,"savedAt":"x","revision":"r","page":{}}"#;
        fs::write(directory.join(file_name(2)), newer).unwrap();
        fs::write(directory.join(file_name(3)), "{ damaged").unwrap();
        fs::write(directory.join("notes.txt"), "mine").unwrap();
        let listing = list(&root);
        assert_eq!(listing.versions.len(), 1);
        assert_eq!(listing.skipped, 2);
        // Many new versions prune only readable ones.
        for n in 0..(MAX_VERSIONS + 2) {
            save(&root, &page(&[&format!("V{n}")]));
        }
        assert_eq!(
            fs::read_to_string(directory.join(file_name(2))).unwrap(),
            newer
        );
        assert_eq!(
            fs::read_to_string(directory.join(file_name(3))).unwrap(),
            "{ damaged"
        );
        assert_eq!(
            fs::read_to_string(directory.join("notes.txt")).unwrap(),
            "mine"
        );
        assert_eq!(list(&root).versions.len(), MAX_VERSIONS);
    }

    #[test]
    fn the_page_being_replaced_is_kept_once_before_the_change() {
        let root = root("current");
        let hand = page(&["Edited by hand"]);
        keep_current(&root, &revision(&hand), &hand).unwrap();
        keep_current(&root, &revision(&hand), &hand).unwrap();
        assert_eq!(list(&root).versions.len(), 1);
        assert_eq!(read(&root, 1).unwrap().page, hand);
    }

    #[test]
    fn summaries_are_short_plain_sentences() {
        let one = page(&["A"]);
        assert_eq!(summarize(None, &one), "First saved version, 1 section");
        assert_eq!(summarize(Some(&one), &one), "No visible change");
        assert_eq!(summarize(Some(&one), &page(&["A", "B"])), "Added 1 section");
        assert_eq!(
            summarize(Some(&page(&["A", "B"])), &one),
            "Removed 1 section"
        );
        assert_eq!(
            summarize(Some(&one), &page(&["Changed"])),
            "Changed 1 section"
        );
        let mut hidden = page(&["A", "B"]);
        hidden.sections[0].hidden = true;
        assert_eq!(
            summarize(Some(&page(&["A", "B"])), &hidden),
            "Hid 1 section"
        );
        let mut swapped = page(&["A", "B"]);
        swapped.sections.reverse();
        assert_eq!(
            summarize(Some(&page(&["A", "B"])), &swapped),
            "Reordered sections"
        );
    }

    #[test]
    fn a_project_with_git_keeps_the_history_out_of_it() {
        let root = root("git");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".gitignore"), "/dist").unwrap();
        save(&root, &page(&["A"]));
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            "/dist\n/.openblog/private/\n"
        );
        save(&root, &page(&["B"]));
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            "/dist\n/.openblog/private/\n"
        );
        // A project that already ignores the whole folder is left alone.
        let other = self::root("git2");
        fs::create_dir_all(other.join(".git")).unwrap();
        fs::write(other.join(".gitignore"), "/.openblog\n").unwrap();
        save(&other, &page(&["A"]));
        assert_eq!(
            fs::read_to_string(other.join(".gitignore")).unwrap(),
            "/.openblog\n"
        );
    }

    #[test]
    fn a_site_in_a_subfolder_of_a_repository_gets_its_own_ignore_rule() {
        let repository = root("nested");
        fs::create_dir_all(repository.join(".git")).unwrap();
        let site = repository.join("blog");
        fs::create_dir_all(&site).unwrap();
        keep_out_of_git(&site);
        assert_eq!(
            fs::read_to_string(site.join(".gitignore")).unwrap(),
            "/.openblog/private/
"
        );
        assert!(!repository.join(".gitignore").exists());
    }

    #[test]
    fn an_unreadable_gitignore_is_left_byte_identical() {
        let root = root("badignore");
        fs::create_dir_all(root.join(".git")).unwrap();
        let bytes: Vec<u8> = vec![0xff, 0xfe, b'/', 0, b'd', 0, 0x80, 0xc3];
        fs::write(root.join(".gitignore"), &bytes).unwrap();
        assert!(save(&root, &page(&["A"])).is_some());
        assert_eq!(fs::read(root.join(".gitignore")).unwrap(), bytes);
    }

    #[test]
    fn a_missing_gitignore_is_created_and_raw_bytes_are_kept_once() {
        let root = root("rawkeep");
        fs::create_dir_all(root.join(".git")).unwrap();
        keep_raw(&root, "abc123", "not json").unwrap();
        keep_raw(&root, "abc123", "not json").unwrap();
        let kept = root.join(".openblog/private/landing-history/raw-abc123.bak");
        assert_eq!(fs::read_to_string(kept).unwrap(), "not json");
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            "/.openblog/private/
"
        );
        assert!(list(&root).versions.is_empty());
    }
}
