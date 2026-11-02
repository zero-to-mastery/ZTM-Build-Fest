//! `openblog new --profile service` through the real command line (ADR 0313): a draft service the
//! build accepts as unfinished, written with the same front matter the build reads.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use openblog_core::{frontmatter, service};

fn project(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "openblog-service-new-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(root.join("content/posts")).unwrap();
    fs::write(
        root.join("openblog.json"),
        "{\"title\":\"Shop\",\"url\":\"https://shop.example.org\"}",
    )
    .unwrap();
    root
}

fn run(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_openblog"))
        .args(args)
        .arg("--root")
        .arg(root)
        .env_remove("OPENBLOG_WORKSPACE")
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn services(root: &Path) -> Vec<PathBuf> {
    match fs::read_dir(root.join("content/services")) {
        Ok(entries) => entries.map(|entry| entry.unwrap().path()).collect(),
        Err(_) => Vec::new(),
    }
}

#[test]
fn a_service_starts_as_a_draft_with_version_one_front_matter() {
    let root = project("full");
    let output = run(
        &root,
        &[
            "new",
            "Hardwood installation",
            "--profile",
            "service",
            "--price-band",
            "2k-10k",
        ],
    );
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert!(text(&output.stdout).contains("created content/services/hardwood-installation.md"));
    let source =
        fs::read_to_string(root.join("content/services/hardwood-installation.md")).unwrap();
    let document = frontmatter::parse(&source).unwrap();
    let fm = &document.front_matter;
    assert_eq!(fm.get("version"), Some("1"));
    assert_eq!(fm.get("id"), Some("hardwood-installation"));
    assert_eq!(fm.get("name"), Some("Hardwood installation"));
    assert_eq!(fm.get("priceBand"), Some("2k-10k"));
    assert_eq!(fm.get("draft"), Some("true"));
    let problems = service::from_front_matter(fm).unwrap_err();
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert!(problems[0].starts_with("summary:"), "{problems:?}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn check_reports_the_draft_as_unfinished_without_stopping_the_build() {
    let root = project("check");
    let output = run(
        &root,
        &["new", "Tile", "--profile", "service", "--id", "tile-work"],
    );
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert!(root.join("content/services/tile-work.md").is_file());
    let check = run(&root, &["check"]);
    assert!(check.status.success(), "{}", text(&check.stderr));
    let report = format!("{}{}", text(&check.stdout), text(&check.stderr));
    assert!(report.contains("service not ready to publish"), "{report}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_finished_service_builds_its_pages() {
    let root = project("build");
    let output = run(&root, &["new", "Tile", "--profile", "service"]);
    assert!(output.status.success(), "{}", text(&output.stderr));
    let path = root.join("content/services/tile.md");
    let source = fs::read_to_string(&path).unwrap();
    let source = source
        .replace("summary: \"\"", "summary: Bathroom and kitchen tile.")
        .replace("draft: \"true\"\n", "");
    fs::write(&path, source).unwrap();
    let out = root.join("site-out");
    let build = run(&root, &["build", "--out", out.to_str().unwrap()]);
    assert!(build.status.success(), "{}", text(&build.stderr));
    let page = fs::read_to_string(out.join("services/tile/index.html")).unwrap();
    assert!(page.contains("Bathroom and kitchen tile."));
    assert!(out.join("services/index.html").is_file());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn bad_answers_are_refused_and_write_nothing() {
    let root = project("bad");
    for (args, expected) in [
        (
            vec!["--id", "two words"],
            "id: `two words` is not a service id",
        ),
        (vec!["--id", "page"], "not a service id"),
        (
            vec!["--price-band", "cheap"],
            "priceBand: `cheap` is not a price band",
        ),
        (vec!["--trade", "flooring"], "a service takes only"),
        (vec!["--tags", "a"], "a service takes only"),
    ] {
        let mut all = vec!["new", "Tile", "--profile", "service"];
        all.extend(args);
        let output = run(&root, &all);
        assert!(!output.status.success());
        assert!(
            text(&output.stderr).contains(expected),
            "{}",
            text(&output.stderr)
        );
    }
    assert!(services(&root).is_empty());

    assert!(run(&root, &["new", "Tile", "--profile", "service"])
        .status
        .success());
    let again = run(&root, &["new", "Tile", "--profile", "service"]);
    assert!(!again.status.success());
    assert!(text(&again.stderr).contains("already exists"));
    let _ = fs::remove_dir_all(&root);
}
