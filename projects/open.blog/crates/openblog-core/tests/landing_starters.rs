//! Every starter layout of the landing builder renders cleanly on every bundled theme (ADR 0258, #338).
//!
//! The starters are data in `web/admin/landing.js`; `tests/web/admin-landing.test.mjs`
//! keeps `fixtures/landing-starters.json` equal to them, and this test builds a site from each
//! one with each bundled theme.

use std::path::PathBuf;

use openblog_core::theme::ThemeFile;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};

fn repo(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}

#[test]
fn every_starter_is_a_valid_page_and_renders_on_every_bundled_theme() {
    let text = std::fs::read_to_string(repo(
        "crates/openblog-core/tests/fixtures/landing-starters.json",
    ))
    .unwrap();
    let starters: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&text).unwrap();
    assert!(starters.len() >= 5, "{:?}", starters.keys());

    let mut set = ThemeSet::new();
    let mut names = Vec::new();
    for entry in std::fs::read_dir(repo("themes")).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        let json = std::fs::read_to_string(entry.path().join("theme.json")).unwrap();
        set.insert(&name, ThemeFile::from_json(&json).unwrap());
        names.push(name);
    }
    assert!(names.len() >= 3, "{names:?}");

    for (id, sections) in &starters {
        let landing =
            serde_json::json!({"format": "openblog-landing", "version": 1, "sections": sections});
        for theme in &names {
            let config =
                serde_json::json!({"title": "T", "url": "https://example.com", "theme": theme});
            let site = Site::load(
                SiteConfig::from_json(&config.to_string()).unwrap(),
                Sources {
                    posts: vec![SourceFile {
                        path: "posts/one.md".into(),
                        contents: "---\ntitle: One\ndate: 2026-10-01\n---\nBody.".into(),
                    }],
                    landing: Some(SourceFile {
                        path: "content/landing.json".into(),
                        contents: landing.to_string(),
                    }),
                    ..Default::default()
                },
                LoadOptions::default(),
            )
            .unwrap();
            let page = site
                .landing
                .as_ref()
                .unwrap_or_else(|| panic!("{id} on {theme}: {:?}", site.warnings));
            assert!(page.validate().is_empty(), "{id} on {theme}");
            assert!(
                !site.warnings.iter().any(|w| w.contains("landing")),
                "{id} on {theme}: {:?}",
                site.warnings
            );
            let files = generate(&site, &set).unwrap();
            let html = &files
                .iter()
                .find(|f| f.path == "index.html")
                .unwrap()
                .contents;
            assert!(html.contains("Sample layout"), "{id} on {theme}");
            assert!(html.contains("ob-home-"), "{id} on {theme}");
            assert!(!html.contains("undefined"), "{id} on {theme}");
        }
    }
}
