//! `openblog paths export` and `openblog paths import` (ADR 0217, #79).
//!
//! Both work on the author's path files and need no hosted service and no
//! build. Export is a dry run (the file is printed) unless `--out` and
//! `--write` say where to write it. Import is a dry run unless `--write`: it
//! reads the whole export, checks every path, and writes nothing at all when
//! any part is invalid or conflicts; a write is all-or-nothing and holds the
//! content lock. No message echoes text from the input.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use openblog_core::reading_path::{PathProblem, ReadingPath};
use openblog_core::reading_path_exchange::{self as exchange, Action};

use crate::{fsutil, portable_export, reading_path_store as store, site, transaction, workspace};

pub struct Options<'a> {
    /// The export file to read (import) or write (export).
    pub file: Option<&'a str>,
    pub write: bool,
    /// Export: include draft paths.
    pub drafts: bool,
    /// Import: replace a stored path that differs.
    pub overwrite: bool,
}

fn stored_paths(root: &Path, content: &str) -> Result<Vec<store::Stored>, String> {
    store::list(root, content).map_err(|error| error.to_string())
}

pub fn export(root: &Path, options: &Options<'_>) -> Result<(), String> {
    let config = site::load_config(root)?;
    let stored = stored_paths(root, &config.paths.content)?;
    let mut paths = Vec::new();
    for file in stored {
        match file.parsed {
            Ok(path) => paths.push(path),
            Err(problems) => {
                for problem in problems {
                    eprintln!("warning: left out of the export: {problem}");
                }
            }
        }
    }
    let text = exchange::export(&paths, options.drafts);
    let count = paths
        .iter()
        .filter(|path| {
            options.drafts || path.status == openblog_core::reading_path::Status::Published
        })
        .count();
    let Some(file) = options.file else {
        if options.write {
            return Err("--write needs --out <file>; nothing was written".into());
        }
        print!("{text}");
        return Ok(());
    };
    let destination = portable_export::output_path(root, file)?;
    if !options.write {
        println!(
            "Dry run: {count} reading path{} would be exported to {}. Re-run with --write to create the file.",
            if count == 1 { "" } else { "s" },
            destination.display()
        );
        return Ok(());
    }
    fsutil::write_new_atomic(&destination, text.as_bytes())?;
    println!(
        "Exported {count} reading path{} to {}.",
        if count == 1 { "" } else { "s" },
        destination.display()
    );
    Ok(())
}

fn existing(root: &Path, content: &str) -> Result<BTreeMap<String, Option<ReadingPath>>, String> {
    Ok(stored_paths(root, content)?
        .into_iter()
        .map(|file| (file.slug, file.parsed.ok()))
        .collect())
}

fn read_export(root: &Path, file: &str) -> Result<String, String> {
    let path = portable_export::output_path(root, file)
        .map_err(|_| "the import path must name a file without `..`".to_string())?;
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("cannot read the import file: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("the import path is not a regular file".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .and_then(|file| {
            file.take(exchange::MAX_EXPORT_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| format!("cannot read the import file: {error}"))?;
    if bytes.len() > exchange::MAX_EXPORT_BYTES {
        return Err(format!(
            "the import file is over {} bytes; nothing was changed",
            exchange::MAX_EXPORT_BYTES
        ));
    }
    String::from_utf8(bytes).map_err(|_| "the import file is not valid UTF-8".to_string())
}

/// The plan for `text`, with the rules Admin adds to a path before it writes
/// one, so a dry run reports exactly what a write would refuse.
fn plan(
    text: &str,
    stored: &BTreeMap<String, Option<ReadingPath>>,
    overwrite: bool,
) -> exchange::ImportPlan {
    let mut plan = exchange::plan_import(text, stored, overwrite);
    let mut extra: Vec<PathProblem> = Vec::new();
    for planned in plan.writes() {
        extra.extend(store::requirements(&planned.path));
    }
    plan.problems.extend(extra);
    plan
}

pub fn import(root: &Path, options: &Options<'_>) -> Result<(), String> {
    let file = options
        .file
        .ok_or("usage: openblog paths import <file> [--overwrite] [--write]")?;
    if options.write && workspace::configured() {
        return Err("durable workspace mode requires content mutations through the admin API; CLI mutations are disabled to avoid unacknowledged writes".into());
    }
    let config = site::load_config(root)?;
    let content = &config.paths.content;
    let text = read_export(root, file)?;
    let _lock = if options.write {
        Some(transaction::ContentTransactionLock::acquire(root)?)
    } else {
        None
    };
    let stored = existing(root, content)?;
    let plan = plan(&text, &stored, options.overwrite);
    for planned in &plan.paths {
        let verb = match planned.action {
            Action::Create => "create",
            Action::Replace => "replace",
            Action::Unchanged => "unchanged",
        };
        println!("{verb} paths/{}.json", planned.path.slug);
    }
    if !plan.is_valid() {
        for problem in &plan.problems {
            eprintln!("error: {problem}");
        }
        return Err(format!(
            "{} problem{} found; nothing was written",
            plan.problems.len(),
            if plan.problems.len() == 1 { "" } else { "s" }
        ));
    }
    let writes: Vec<&ReadingPath> = plan.writes().map(|planned| &planned.path).collect();
    if !options.write {
        println!(
            "Dry run: {} path{} would be written, {} already match. Re-run with --write to apply.",
            writes.len(),
            if writes.len() == 1 { "" } else { "s" },
            plan.paths.len() - writes.len()
        );
        return Ok(());
    }
    store::write_all(root, content, &writes).map_err(|error| error.to_string())?;
    println!(
        "Imported {} path{}; {} already matched.",
        writes.len(),
        if writes.len() == 1 { "" } else { "s" },
        plan.paths.len() - writes.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn project(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "openblog-paths-exchange-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("content/paths")).unwrap();
        fs::write(root.join("openblog.json"), "{}").unwrap();
        root
    }

    fn path_json(title: &str, status: &str) -> String {
        serde_json::json!({
            "format": "openblog-reading-path", "version": 1, "title": title, "status": status,
            "futureField": {"kept": true},
            "steps": [
                {"id": "a", "target": {"kind": "post", "slug": "one"}},
                {"id": "b", "target": {"kind": "post", "slug": "two"},
                 "transition": {"relationship": "contrasts-with", "why": "Takes the opposite view."}}
            ]
        })
        .to_string()
    }

    fn read_all(root: &Path) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for entry in fs::read_dir(root.join("content/paths")).unwrap().flatten() {
            out.insert(
                entry.file_name().to_string_lossy().into_owned(),
                fs::read_to_string(entry.path()).unwrap(),
            );
        }
        out
    }

    fn opts(file: Option<&str>, write: bool) -> Options<'_> {
        Options {
            file,
            write,
            drafts: false,
            overwrite: false,
        }
    }

    #[test]
    fn export_then_import_into_an_empty_site_round_trips_every_field_and_is_idempotent() {
        let source = project("source");
        fs::write(
            source.join("content/paths/route.json"),
            path_json("Route", "published"),
        )
        .unwrap();
        fs::write(
            source.join("content/paths/wip.json"),
            path_json("Wip", "draft"),
        )
        .unwrap();
        export(
            &source,
            &Options {
                file: Some("out.json"),
                write: true,
                drafts: false,
                overwrite: false,
            },
        )
        .unwrap();
        let bundle = fs::read_to_string(source.join("out.json")).unwrap();
        assert!(
            bundle.contains("Route") && !bundle.contains("Wip"),
            "drafts stay out by default"
        );
        assert!(bundle.contains("contrasts-with") && bundle.contains("Takes the opposite view."));
        assert!(bundle.ends_with("}\n") && !bundle.contains('\r'));

        let target = project("target");
        fs::copy(source.join("out.json"), target.join("in.json")).unwrap();
        import(&target, &opts(Some("in.json"), false)).unwrap();
        assert!(read_all(&target).is_empty(), "a dry run writes nothing");
        import(&target, &opts(Some("in.json"), true)).unwrap();
        let written = read_all(&target);
        assert_eq!(written.keys().collect::<Vec<_>>(), ["route.json"]);
        assert!(
            written["route.json"].contains("futureField"),
            "unknown fields survive"
        );
        // Idempotent: a second import changes nothing, and an export of the copy is the same bytes.
        import(&target, &opts(Some("in.json"), true)).unwrap();
        assert_eq!(read_all(&target), written);
        export(
            &target,
            &Options {
                file: Some("again.json"),
                write: true,
                drafts: false,
                overwrite: false,
            },
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(target.join("again.json")).unwrap(),
            bundle
        );
        let _ = fs::remove_dir_all(source);
        let _ = fs::remove_dir_all(target);
    }

    #[test]
    fn an_invalid_import_writes_nothing_even_for_the_valid_paths_in_it() {
        let root = project("invalid");
        let good: serde_json::Value =
            serde_json::from_str(&path_json("Good", "published")).unwrap();
        let mut bad = good.clone();
        bad["steps"][1]["transition"]["relationship"] = "influenced".into();
        let bundle = serde_json::json!({
            "format": "openblog-reading-paths-export", "version": 1,
            "paths": [{"slug": "good", "path": good}, {"slug": "bad", "path": bad},
                      {"slug": "../escape", "path": good}]
        });
        fs::write(root.join("in.json"), bundle.to_string()).unwrap();
        let error = import(&root, &opts(Some("in.json"), true)).unwrap_err();
        assert!(error.contains("nothing was written"), "{error}");
        assert!(read_all(&root).is_empty());
        assert!(!root.join("content/escape.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_conflict_is_reported_and_only_overwrite_replaces_the_stored_path() {
        let root = project("conflict");
        let stored = path_json("Old title", "published");
        fs::write(root.join("content/paths/route.json"), &stored).unwrap();
        let bundle = serde_json::json!({
            "format": "openblog-reading-paths-export", "version": 1,
            "paths": [{"slug": "route", "path": serde_json::from_str::<serde_json::Value>(&path_json("New title", "published")).unwrap()}]
        });
        fs::write(root.join("in.json"), bundle.to_string()).unwrap();
        assert!(import(&root, &opts(Some("in.json"), true)).is_err());
        assert_eq!(
            read_all(&root)["route.json"],
            stored,
            "the stored bytes are untouched"
        );
        let mut replace = opts(Some("in.json"), true);
        replace.overwrite = true;
        import(&root, &replace).unwrap();
        assert!(read_all(&root)["route.json"].contains("New title"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_hostile_or_oversized_import_is_refused_without_echoing_it() {
        let root = project("hostile");
        for (name, body) in [
            ("junk.json", "{ \"SECRET-WORDS\": ".to_string()),
            (
                "version.json",
                r#"{"format":"openblog-reading-paths-export","version":2,"paths":[]}"#.to_string(),
            ),
            (
                "format.json",
                r#"{"format":"SECRET-WORDS","version":1,"paths":[]}"#.to_string(),
            ),
            (
                "dup.json",
                format!(
                    r#"{{"format":"openblog-reading-paths-export","version":1,"paths":[{p},{p}]}}"#,
                    p = format!(r#"{{"slug":"a","path":{}}}"#, path_json("T", "published"))
                ),
            ),
        ] {
            fs::write(root.join(name), body).unwrap();
            let before = read_all(&root);
            let error = import(&root, &opts(Some(name), true)).unwrap_err();
            assert!(!error.contains("SECRET-WORDS"), "{name}: {error}");
            assert_eq!(read_all(&root), before);
        }
        // A path file beside the folder, or a symlink-like escape, is not read.
        assert!(import(&root, &opts(Some("../x.json"), false)).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
