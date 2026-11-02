//! The owner's look in a whole build (ADR 0248): a site without a look builds exactly as before, and a
//! site with one gets a hashed, layered `tokens.css` on every page.

use openblog_core::config::SiteConfig;
use openblog_core::{
    generate, LoadOptions, OutputFile, Site, SourceFile, Sources, ThemeFile, ThemeSet,
};

fn build(config: &str) -> Vec<OutputFile> {
    let src = |path: &str, contents: &str| SourceFile {
        path: path.into(),
        contents: contents.into(),
    };
    let site = Site::load(
        SiteConfig::from_json(config).unwrap(),
        Sources {
            posts: vec![
                src(
                    "posts/one.md",
                    "---\ntitle: One\ndate: 2026-01-01\nseries: s\n---\nbody",
                ),
                src(
                    "posts/two.md",
                    "---\ntitle: Two\ndate: 2026-02-01\n---\nbody",
                ),
            ],
            series: vec![src("series/s.md", "---\nname: S\ntheme: loud\n---\nAbout")],
            pages: vec![src(
                "pages/about.md",
                "---\ntitle: About\nnav: true\n---\nHi",
            )],
            ..Sources::default()
        },
        LoadOptions::default(),
    )
    .unwrap();
    let mut themes = ThemeSet::new();
    themes.insert(
        "loud",
        ThemeFile::from_json(r##"{"extends":"base","colors":{"dark":{"accent":"#ff0"}}}"##)
            .unwrap(),
    );
    generate(&site, &themes).unwrap()
}

fn get<'a>(files: &'a [OutputFile], path: &str) -> &'a str {
    &files
        .iter()
        .find(|f| f.path == path)
        .unwrap_or_else(|| panic!("missing {path}"))
        .contents
}

const SITE: &str = r#""title":"T","url":"https://t.dev","postPath":"/{slug}/""#;

fn config(extra: &str) -> String {
    if extra.is_empty() {
        format!("{{{SITE}}}")
    } else {
        format!("{{{SITE},{extra}}}")
    }
}

const LOOK: &str = r##""appearance":{"version":1,"accent":"#aa3300","roundness":"square"}"##;

#[test]
fn a_site_with_no_look_builds_byte_for_byte_as_before() {
    let before = build(&config(""));
    for appearance in [
        r#""appearance":{}"#,
        r#""appearance":{"version":1}"#,
        r#""appearance":{"palette":"theme","fontStyle":"theme"}"#,
        r#""appearance":null"#,
        // Preserved unknown fields are not a look.
        r#""appearance":{"version":1,"futureKnob":true}"#,
    ] {
        let after = build(&config(appearance));
        assert_eq!(before.len(), after.len(), "{appearance}");
        for (a, b) in before.iter().zip(&after) {
            assert_eq!(a, b, "{appearance}: {} differs", a.path);
        }
    }
    assert!(!get(&before, "index.html").contains("tokens.css?v="));
}

#[test]
fn a_look_is_layered_over_every_theme_with_a_hashed_url() {
    let plain = build(&config(""));
    let files = build(&config(LOOK));
    for theme in ["base", "loud"] {
        let path = format!("themes/{theme}/tokens.css");
        let css = get(&files, &path);
        assert!(
            css.starts_with(get(&plain, &path)),
            "{theme}: theme tokens come first"
        );
        assert!(css.contains("--ob-radius: 0;"), "{theme}");
        assert!(css.contains("--ob-color-accent: "), "{theme}");
    }
    // Pages link the hashed URL of the theme they use; series and posts keep their own theme.
    let home = get(&files, "index.html");
    let link = home
        .split("href=\"")
        .map(|s| s.split('"').next().unwrap())
        .find(|h| h.starts_with("/themes/base/tokens.css?v="))
        .expect("home links the hashed base tokens");
    assert_eq!(link.len(), "/themes/base/tokens.css?v=".len() + 16);
    assert!(get(&files, "series/s/index.html").contains("/themes/loud/tokens.css?v="));
    // A rebuild is identical (deterministic) and a different look changes the URL.
    let again = build(&config(LOOK));
    assert_eq!(get(&files, "index.html"), get(&again, "index.html"));
    let other = build(&config(&LOOK.replace("aa3300", "aa3301")));
    assert_ne!(get(&files, "index.html"), get(&other, "index.html"));
}

#[test]
fn an_invalid_look_refuses_the_config_with_a_plain_message() {
    let error = SiteConfig::from_json(&config(
        r#""appearance":{"accent":"red;}","roundness":"blob"}"#,
    ))
    .unwrap_err();
    assert!(
        error.contains("accent") && error.contains("roundness"),
        "{error}"
    );
}
