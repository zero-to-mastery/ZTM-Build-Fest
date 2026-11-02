//! Guards that keep private research from being published by accident.
//!
//! The notebook itself is never read by a build. What can still go wrong is
//! that its bytes arrive in public input some other way: an exported research
//! bundle saved into `static/` or `content/`, a copy of the notebook,
//! Knowledge Atlas, claims file or alignments file, or a symlink. These guards
//! recognise such files by structure (see
//! [`openblog_core::research_bundle::looks_like_private_research`]), not by any
//! particular words, so a post that quotes the same passage is never flagged,
//! and they report only the file's path, never its contents.

use std::fs;
use std::io::Read;
use std::path::Path;

use openblog_core::research_bundle::{looks_like_private_research, MAX_BUNDLE_BYTES};
use openblog_core::SiteConfig;

use crate::fsutil;

/// Whether the file at `path` looks like private research. Unreadable and
/// oversized files are not private research (they fail where they are read).
pub fn is_private_research_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() > (MAX_BUNDLE_BYTES * 2) as u64 {
        return false;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    // Only a JSON object can be private research: look at a small prefix first so
    // ordinary public files (images, fonts, pages) are never read whole.
    let mut prefix = [0_u8; PREFIX_BYTES];
    let Ok(read) = read_up_to(&mut file, &mut prefix) else {
        return false;
    };
    if !starts_like_json_object(&prefix[..read]) {
        return false;
    }
    let mut bytes = prefix[..read].to_vec();
    file.take((MAX_BUNDLE_BYTES * 2) as u64)
        .read_to_end(&mut bytes)
        .is_ok()
        && looks_like_private_research(&bytes)
}

const PREFIX_BYTES: usize = 64;

fn read_up_to(file: &mut fs::File, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..])? {
            0 => break,
            count => filled += count,
        }
    }
    Ok(filled)
}

/// After an optional BOM and whitespace, does the text start with `{`?
fn starts_like_json_object(prefix: &[u8]) -> bool {
    let body = prefix.strip_prefix("\u{feff}".as_bytes()).unwrap_or(prefix);
    body.iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'{')
}

/// Public build inputs that look like private research, as project-relative
/// paths. Files inside the private `.openblog` directory are never public
/// input and are skipped, as the build skips them.
pub fn public_inputs_with_private_research(root: &Path, config: &SiteConfig) -> Vec<String> {
    let private = fsutil::PrivateState::of(root);
    let mut found = Vec::new();
    for dir in [
        &config.paths.content,
        &config.paths.static_dir,
        &config.paths.themes,
    ] {
        let base = root.join(dir);
        for file in fsutil::walk(&base) {
            if private.contains(&file) || !is_private_research_file(&file) {
                continue;
            }
            found.push(fsutil::relative(root, &file));
        }
    }
    found.sort();
    found.dedup();
    found
}

/// The build, `check` and `serve` refusal for [`public_inputs_with_private_research`].
pub fn refuse_private_research_in_public_inputs(
    root: &Path,
    config: &SiteConfig,
) -> Result<(), String> {
    let found = public_inputs_with_private_research(root, config);
    if found.is_empty() {
        return Ok(());
    }
    Err(format!(
        "refusing to build: {} look{} like private research (a research export, or a copy of the notebook, Knowledge Atlas, claims file or alignments file) inside a public folder, so it would be published. Move {} outside content, static and themes; builds never publish private research.",
        found
            .iter()
            .map(|path| format!("`{path}`"))
            .collect::<Vec<_>>()
            .join(", "),
        if found.len() == 1 { "s" } else { "" },
        if found.len() == 1 { "it" } else { "them" },
    ))
}

/// The last check before a build writes anything: no generated file may be
/// shaped like private research. The public Knowledge Atlas artifact has its
/// own shape, so this holds by construction; the guard makes a regression
/// stop the build instead of publishing.
pub fn refuse_private_research_in_output(
    files: &[openblog_core::OutputFile],
) -> Result<(), String> {
    let found: Vec<&str> = files
        .iter()
        .filter(|file| {
            starts_like_json_object(file.contents.as_bytes())
                && looks_like_private_research(file.contents.as_bytes())
        })
        .map(|file| file.path.as_str())
        .collect();
    if found.is_empty() {
        return Ok(());
    }
    Err(format!(
        "refusing to build: the generated {} would carry private research; nothing was written",
        found
            .iter()
            .map(|path| format!("`{path}`"))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "openblog-guard-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    const NOTEBOOK: &str = r#"{"version":1,"notes":[{"id":"n","kind":"observation","text":"t"}]}"#;

    #[test]
    fn a_bundle_or_notebook_copy_in_a_public_folder_is_found_by_path_alone() {
        let root = temp_root("found");
        let config = SiteConfig::default();
        for dir in [
            "content/posts",
            "static/downloads",
            "themes/mine",
            "elsewhere",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::write(root.join("content/posts/backup.txt"), NOTEBOOK).unwrap();
        fs::write(root.join("static/downloads/notes.json"), NOTEBOOK).unwrap();
        fs::write(
            root.join("themes/mine/export.json"),
            r#"{"format":"open.blog/research-notebook","version":1}"#,
        )
        .unwrap();
        fs::write(root.join("elsewhere/notes.json"), NOTEBOOK).unwrap();
        fs::write(
            root.join("static/downloads/site.json"),
            r#"{"version":1,"posts":[]}"#,
        )
        .unwrap();
        fs::write(root.join("content/posts/a.md"), "---\ntitle: A\n---\nt\n").unwrap();
        // Private storage itself is not public input.
        fs::create_dir_all(root.join(".openblog/private/research")).unwrap();
        fs::write(
            root.join(".openblog/private/research/notebook.json"),
            NOTEBOOK,
        )
        .unwrap();

        let found = public_inputs_with_private_research(&root, &config);
        assert_eq!(
            found,
            [
                "content/posts/backup.txt",
                "static/downloads/notes.json",
                "themes/mine/export.json"
            ]
        );
        let error = refuse_private_research_in_public_inputs(&root, &config).unwrap_err();
        assert!(error.contains("content/posts/backup.txt") && !error.contains("observation"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn generated_output_shaped_like_private_research_is_refused_before_writing() {
        let file = |path: &str, contents: &str| openblog_core::OutputFile {
            path: path.into(),
            contents: contents.into(),
        };
        let public = file(
            "atlas.json",
            r#"{"format":"openblog-atlas-projection","formatVersion":1,"entries":[{"id":"c","kind":"concept","label":"C","url":"/atlas/c/"}],"relationships":[],"sources":[]}"#,
        );
        let page = file("index.html", "<!doctype html><p>Hello</p>");
        assert_eq!(
            refuse_private_research_in_output(&[public.clone(), page.clone()]),
            Ok(())
        );
        let leaked = file(
            "api/copy.json",
            r#"{"version":1,"entries":[{"id":"c","kind":"concept","label":"secret words"}]}"#,
        );
        let error = refuse_private_research_in_output(&[public, leaked, page]).unwrap_err();
        assert!(error.contains("`api/copy.json`"), "{error}");
        assert!(!error.contains("secret words"), "{error}");
        let notebook = file("feed.json", NOTEBOOK);
        assert!(refuse_private_research_in_output(&[notebook]).is_err());
    }

    #[test]
    fn a_knowledge_atlas_copy_in_a_public_folder_is_refused_by_path_alone() {
        let root = temp_root("atlas");
        let config = SiteConfig::default();
        fs::create_dir_all(root.join("static/data")).unwrap();
        fs::create_dir_all(root.join("content/posts")).unwrap();
        let atlas = r#"{"version":1,"entries":[{"id":"ob-atlas-secret","kind":"person","label":"ob-atlas-secret"}],"relationships":[]}"#;
        fs::write(root.join("static/data/graph.json"), atlas).unwrap();
        fs::write(
            root.join("content/posts/map.txt"),
            format!("\u{feff}  {atlas}"),
        )
        .unwrap();
        // Similar but not atlas-shaped public data stays publishable.
        fs::write(
            root.join("static/data/entries.json"),
            r#"{"version":1,"entries":[{"id":"x","kind":"post","label":"X"}]}"#,
        )
        .unwrap();
        fs::create_dir_all(root.join(".openblog/private/research")).unwrap();
        fs::write(root.join(".openblog/private/research/atlas.json"), atlas).unwrap();
        assert_eq!(
            public_inputs_with_private_research(&root, &config),
            ["content/posts/map.txt", "static/data/graph.json"]
        );
        let error = refuse_private_research_in_public_inputs(&root, &config).unwrap_err();
        assert!(error.contains("Knowledge Atlas") && !error.contains("ob-atlas-secret"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_claims_file_copy_in_a_public_folder_is_refused_by_structure_alone() {
        let root = temp_root("claims");
        let config = SiteConfig::default();
        fs::create_dir_all(root.join("static/data")).unwrap();
        fs::create_dir_all(root.join("content/posts")).unwrap();
        let claims = r#"{"version":1,"claims":[{"id":"c1","post":"p","statement":"ob-claims-secret"}],"links":[{"id":"l1","claim":"c1","relation":"contradicts","evidence":{"source":"s"}}]}"#;
        fs::write(root.join("static/data/evidence.json"), claims).unwrap();
        // Public data that merely mentions claims stays publishable.
        fs::write(
            root.join("static/data/claims.json"),
            r#"{"version":1,"claims":[{"id":"x","title":"Not a private claim"}]}"#,
        )
        .unwrap();
        // The private file itself is not public input.
        fs::create_dir_all(root.join(".openblog/private/research")).unwrap();
        fs::write(root.join(".openblog/private/research/claims.json"), claims).unwrap();
        assert_eq!(
            public_inputs_with_private_research(&root, &config),
            ["static/data/evidence.json"]
        );
        let error = refuse_private_research_in_public_inputs(&root, &config).unwrap_err();
        assert!(error.contains("claims file") && !error.contains("ob-claims-secret"));
        let leaked = openblog_core::OutputFile {
            path: "api/evidence.json".into(),
            contents: claims.into(),
        };
        assert!(refuse_private_research_in_output(&[leaked]).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_alignments_file_copy_in_a_public_folder_is_refused_by_structure_alone() {
        let root = temp_root("alignments");
        let config = SiteConfig::default();
        fs::create_dir_all(root.join("static/data")).unwrap();
        let alignments = r#"{"version":1,"alignments":[{"id":"a1","label":"ob-alignment-secret","members":[{"source":"e","passage":"p"},{"source":"t","absent":true}]}]}"#;
        fs::write(root.join("static/data/compare.json"), alignments).unwrap();
        // Public data that merely mentions alignments stays publishable.
        fs::write(
            root.join("static/data/alignments.json"),
            r#"{"version":1,"alignments":[{"id":"x","title":"A layout setting"}]}"#,
        )
        .unwrap();
        fs::create_dir_all(root.join(".openblog/private/research")).unwrap();
        fs::write(
            root.join(".openblog/private/research/alignments.json"),
            alignments,
        )
        .unwrap();
        assert_eq!(
            public_inputs_with_private_research(&root, &config),
            ["static/data/compare.json"]
        );
        let error = refuse_private_research_in_public_inputs(&root, &config).unwrap_err();
        assert!(!error.contains("ob-alignment-secret"), "{error}");
        let leaked = openblog_core::OutputFile {
            path: "api/compare.json".into(),
            contents: alignments.into(),
        };
        assert!(refuse_private_research_in_output(&[leaked]).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_selections_file_copy_in_a_public_folder_is_refused_by_structure_alone() {
        let root = temp_root("selections");
        let config = SiteConfig::default();
        fs::create_dir_all(root.join("static/data")).unwrap();
        let selections = r#"{"version":1,"selections":[{"id":"s1","kind":"source-annotation","target":"plato","revision":"0123456789abcdef","fields":["by","text"],"withdrawnReason":"ob-selection-secret"}]}"#;
        fs::write(root.join("static/data/curated.json"), selections).unwrap();
        // Public data that merely has a `selections` list stays publishable.
        fs::write(
            root.join("static/data/picks.json"),
            r#"{"version":1,"selections":[{"id":"x","title":"A layout setting"}]}"#,
        )
        .unwrap();
        fs::create_dir_all(root.join(".openblog/private/research")).unwrap();
        fs::write(
            root.join(".openblog/private/research/selections.json"),
            selections,
        )
        .unwrap();
        assert_eq!(
            public_inputs_with_private_research(&root, &config),
            ["static/data/curated.json"]
        );
        let error = refuse_private_research_in_public_inputs(&root, &config).unwrap_err();
        assert!(!error.contains("ob-selection-secret"), "{error}");
        let leaked = openblog_core::OutputFile {
            path: "api/curated.json".into(),
            contents: selections.into(),
        };
        assert!(refuse_private_research_in_output(&[leaked]).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_files_that_start_like_a_json_object_are_read_whole() {
        assert!(starts_like_json_object(b"{\"a\":1}"));
        assert!(starts_like_json_object(b" \r\n\t{"));
        assert!(starts_like_json_object("\u{feff}  {".as_bytes()));
        assert!(!starts_like_json_object(b"[{\"a\":1}]"));
        assert!(!starts_like_json_object(b"\x89PNG\r\n"));
        assert!(!starts_like_json_object(b""));

        let root = temp_root("prefix");
        let path = root.join("notes.json");
        fs::write(&path, format!("\u{feff}\n  {NOTEBOOK}")).unwrap();
        assert!(
            is_private_research_file(&path),
            "BOM and whitespace are tolerated"
        );
        fs::write(&path, format!("[{NOTEBOOK}]")).unwrap();
        assert!(!is_private_research_file(&path));
        fs::write(&path, vec![b'x'; 1 << 20]).unwrap();
        assert!(!is_private_research_file(&path));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_clean_project_passes() {
        let root = temp_root("clean");
        fs::create_dir_all(root.join("content/posts")).unwrap();
        fs::write(root.join("content/posts/a.md"), "---\ntitle: A\n---\nt\n").unwrap();
        assert!(refuse_private_research_in_public_inputs(&root, &SiteConfig::default()).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
