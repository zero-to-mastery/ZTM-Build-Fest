//! Landing sections are styled in every bundled theme (ADR 0247, #325).
//!
//! The section styles live once, in `web/base.css`, and read `--ob-*` tokens
//! only; a theme restyles by changing tokens. These tests check that every
//! class the renderer writes is either styled or a deliberate hook, that the
//! landing styles use no literal color and no unknown token, and that every
//! bundled theme inherits them and gives the colors they use enough contrast
//! in light and dark (WCAG AA).

use std::collections::BTreeSet;
use std::path::PathBuf;

use openblog_core::theme::{kebab, ThemeFile};
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};

fn repo(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}

fn base_css() -> String {
    std::fs::read_to_string(repo("web/base.css"))
        .unwrap()
        .replace("\r\n", "\n")
}

/// The landing block of the stylesheet.
fn landing_css() -> String {
    let css = base_css();
    let start = css
        .find("/* ---------- Landing sections")
        .expect("landing block");
    // The block ends where the next feature's styles begin.
    let end = css[start..]
        .find("/* Knowledge Atlas datings")
        .map_or(css.len(), |offset| start + offset);
    css[start..end].to_string()
}

fn every_section_page() -> String {
    let landing = serde_json::json!({"format": "openblog-landing", "version": 2, "sections": [
        {"id": "a", "type": "welcome", "heading": "H", "subheading": "S",
         "image": {"src": "/a.png", "alt": "A"}, "button": {"label": "B", "href": "/"}},
        {"id": "b", "type": "rich-text", "markdown": "text"},
        {"id": "c", "type": "latest-posts", "heading": "L"},
        {"id": "d", "type": "series", "heading": "S"},
        {"id": "e", "type": "featured-post", "post": "one", "heading": "F"},
        {"id": "f", "type": "buttons", "items": [{"label": "B", "href": "/"}, {"label": "C", "href": "/", "style": "secondary"}]},
        {"id": "g", "type": "image", "src": "/a.png", "alt": "A", "caption": "C"},
        {"id": "h", "type": "video", "provider": "youtube", "video": "dQw4w9WgXcQ", "title": "V"},
        {"id": "i", "type": "map", "provider": "openstreetmap", "label": "M", "lat": 1, "lon": 2},
        {"id": "j", "type": "opening-hours", "rows": [{"days": "D", "hours": "H"}], "note": "N"},
        {"id": "k", "type": "contact", "email": "a@b.co", "phone": "+1 555 0100", "address": "A"},
        {"id": "l", "type": "social-links", "items": [{"label": "L", "href": "https://e.social/@a"}]},
        {"id": "m", "type": "faq", "items": [{"question": "Q", "answer": "A"}]},
        {"id": "n", "type": "callout", "tone": "warning", "title": "T", "body": "B"},
        {"id": "o", "type": "callout", "tone": "success", "body": "B"},
        {"id": "p", "type": "business-facts", "heading": "Find us"}
    ]});
    let site = Site::load(
        SiteConfig::from_json(
            r#"{"title": "T", "url": "https://example.com", "business": {"displayName": "B", "phone": "+13605550142"}}"#,
        )
        .unwrap(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/one.md".into(),
                contents: "---\ntitle: One\ndate: 2026-10-01\nseries: guide\n---\nBody.".into(),
            }],
            series: vec![SourceFile {
                path: "series/guide.md".into(),
                contents: "---\nname: Guide\n---\nAbout.".into(),
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
    assert!(site.landing.is_some(), "{:?}", site.warnings);
    let files = generate(&site, &ThemeSet::new()).unwrap();
    files
        .into_iter()
        .find(|f| f.path == "index.html")
        .unwrap()
        .contents
}

#[test]
fn every_class_the_renderer_writes_is_styled_or_a_deliberate_hook() {
    // Section-type classes that only name a section for a theme to hook.
    const HOOKS: [&str; 15] = [
        "ob-home-business-facts",
        "ob-home-rich-text",
        "ob-home-latest-posts",
        "ob-home-series",
        "ob-home-featured-post",
        "ob-home-buttons",
        "ob-home-video",
        "ob-home-map",
        "ob-home-opening-hours",
        "ob-home-social-links",
        "ob-home-callout-info",
        "ob-home-title",
        "ob-home-place",
        "ob-home-callout",
        "ob-home-welcome-hook",
    ];
    let html = every_section_page();
    let css = landing_css();
    let mut classes = BTreeSet::new();
    for part in html.split("class=\"").skip(1) {
        for class in part[..part.find('"').unwrap()].split_whitespace() {
            if class.starts_with("ob-home-") {
                classes.insert(class.to_string());
            }
        }
    }
    assert!(classes.len() >= 20, "{classes:?}");
    for class in &classes {
        let styled = css.contains(&format!(".{class}"));
        assert!(
            styled || HOOKS.contains(&class.as_str()),
            ".{class} is written by the renderer but neither styled nor a listed hook"
        );
    }
    // Every section type in the page has its own type class.
    for ty in [
        "welcome",
        "rich-text",
        "latest-posts",
        "series",
        "featured-post",
        "buttons",
        "image",
        "video",
        "map",
        "opening-hours",
        "contact",
        "social-links",
        "faq",
        "callout",
        "business-facts",
    ] {
        assert!(classes.contains(&format!("ob-home-{ty}")), "ob-home-{ty}");
    }
}

#[test]
fn the_landing_styles_use_tokens_only() {
    let css = landing_css();
    for forbidden in [
        "#",
        "rgb(",
        "rgba(",
        "hsl(",
        "oklch(",
        "!important",
        "@import",
        "url(",
    ] {
        assert!(
            !css.contains(forbidden),
            "the landing styles must not contain `{forbidden}`"
        );
    }
    let base: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(repo("themes/base/theme.json")).unwrap())
            .unwrap();
    let mut known: BTreeSet<String> = BTreeSet::new();
    for scheme in ["light", "dark"] {
        for key in base["colors"][scheme].as_object().unwrap().keys() {
            known.insert(format!("--ob-color-{}", kebab(key)));
        }
    }
    for key in base["tokens"].as_object().unwrap().keys() {
        known.insert(format!("--ob-{}", kebab(key)));
    }
    // Tokens a theme may define and the stylesheet always gives a fallback.
    for optional in [
        "--ob-color-success",
        "--ob-color-warning",
        "--ob-space-4",
        "--ob-space-5",
    ] {
        known.insert(optional.to_string());
    }
    for part in css.split("var(--").skip(1) {
        let name = format!("--{}", part.split([',', ')']).next().unwrap());
        assert!(known.contains(&name), "{name} is not a theme token");
    }
    for part in css.split("var(").skip(1) {
        let name = part.split([',', ')']).next().unwrap();
        if matches!(
            name,
            "--ob-color-success" | "--ob-color-warning" | "--ob-space-4" | "--ob-space-5"
        ) {
            assert!(part.contains(','), "{name} needs a fallback");
        }
    }
    assert!(
        css.contains("prefers-reduced-motion: no-preference"),
        "motion is opt-in"
    );
    assert!(css.contains("min-height: 44px"), "touch targets");
}

// ----- contrast --------------------------------------------------------------

fn channel(c: u8) -> f64 {
    let c = f64::from(c) / 255.0;
    if c <= 0.039_28 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn luminance(hex: &str) -> f64 {
    let hex = hex.trim_start_matches('#');
    let value = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap();
    assert_eq!(hex.len(), 6, "{hex}");
    0.2126 * channel(value(0)) + 0.7152 * channel(value(2)) + 0.0722 * channel(value(4))
}

fn contrast(a: &str, b: &str) -> f64 {
    let (a, b) = (luminance(a), luminance(b));
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

#[test]
fn every_bundled_theme_inherits_the_section_styles_and_keeps_them_legible_in_light_and_dark() {
    let mut set = ThemeSet::new();
    let mut names = Vec::new();
    for entry in std::fs::read_dir(repo("themes")).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        let text = std::fs::read_to_string(entry.path().join("theme.json")).unwrap();
        set.insert(&name, ThemeFile::from_json(&text).unwrap());
        names.push(name);
    }
    assert!(names.len() >= 3, "{names:?}");
    // No bundled theme restyles the landing classes: they inherit base.css.
    for name in &names {
        for file in std::fs::read_dir(repo("themes").join(name)).unwrap() {
            let path = file.unwrap().path();
            if path.extension().is_some_and(|e| e == "css") {
                let css = std::fs::read_to_string(&path).unwrap();
                assert!(
                    !css.contains("ob-home-"),
                    "{} restyles structure",
                    path.display()
                );
            }
        }
    }
    // The pairs the landing styles put on each other, per scheme.
    let pairs = [
        ("text", "page"),
        ("text", "surface"),
        ("muted", "page"),
        ("muted", "surface"),
        ("link", "page"),
        ("link", "surface"),
        ("accentContrast", "accent"),
        ("accentSoft", "page"),
        ("accentSoft", "surface"),
    ];
    for name in &names {
        let theme = set.resolve(name).unwrap();
        assert!(
            theme.chain.iter().any(|n| n == "base"),
            "{name} inherits base"
        );
        for scheme in ["light", "dark"] {
            let colors = &theme.colors[scheme];
            for (foreground, background) in pairs {
                let ratio = contrast(&colors[foreground], &colors[background]);
                assert!(
                    ratio >= 4.5,
                    "{name} {scheme}: {foreground} on {background} is {ratio:.2}:1, below AA"
                );
            }
        }
    }
}
