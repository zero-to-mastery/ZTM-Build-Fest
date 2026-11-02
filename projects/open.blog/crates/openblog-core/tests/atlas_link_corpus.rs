//! The atlas-link leak guard (ADR 0173). Every Markdown form of a link or an
//! image whose destination is `atlas:` and names an entry that is not
//! published is written into a post, a page, a series description and the
//! home introduction, and EVERY file the build writes, plus the portable
//! copies of the post, is scanned: no `atlas:` address in a link or image
//! attribute, no private id, no private title and no raw `<ob-concept` mark
//! may appear, with the atlas on and with it off.
//!
//! A new Markdown form that leaks an id fails here by adding one line to
//! [`CORPUS`], instead of being found by a review.

use std::collections::BTreeMap;

use openblog_core::atlas_publication::PublicAtlas;
use openblog_core::knowledge_atlas::{Atlas, Links};
use openblog_core::portability::PortableProjection;
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};
use serde_json::json;

/// Every private id starts with this, and every private title with the other,
/// so one scan finds either anywhere.
const SECRET_ID: &str = "zsecret";
const SECRET_TITLE: &str = "ztitle";

/// One block of Markdown per form. Labels and alt texts hold neither token.
const CORPUS: &[(&str, &str)] = &[
    ("inline", "An [inline label](atlas:zsecretinline) here."),
    ("inline with a title", "An [titled label](atlas:zsecrettitled \"ztitle one\") here."),
    ("inline with a single-quoted title", "An [quoted label](atlas:zsecretquoted 'ztitle two') here."),
    ("inline with a parenthesised title", "An [paren label](atlas:zsecretparen (ztitle three)) here."),
    ("reference full", "A [full label][zfull] here.\n\n[zfull]: atlas:zsecretfull \"ztitle four\""),
    ("reference collapsed", "A [zcollapsed][] here.\n\n[zcollapsed]: atlas:zsecretcollapsed \"ztitle five\""),
    ("reference shortcut", "A [zshortcut] here.\n\n[zshortcut]: atlas:zsecretshortcut \"ztitle six\""),
    ("autolink", "An autolink <atlas:zsecretauto> here."),
    ("autolink in capitals", "An autolink <ATLAS:zsecretautoupper> here."),
    ("image inline", "An ![inline alt](atlas:zsecretimage \"ztitle seven\") here."),
    ("image inline without a title", "An ![bare alt](atlas:zsecretimagebare) here."),
    ("image reference full", "An ![ref alt][zimgfull] here.\n\n[zimgfull]: atlas:zsecretimgfull \"ztitle eight\""),
    ("image reference collapsed", "An ![zimgcollapsed][] here.\n\n[zimgcollapsed]: atlas:zsecretimgcollapsed"),
    ("image reference shortcut", "An ![zimgshortcut] here.\n\n[zimgshortcut]: atlas:zsecretimgshortcut"),
    ("link inside an image's alt text", "An ![alt with [inner](atlas:zsecretinalt) words](/pic.png \"a title\") here."),
    ("link inside an atlas image's alt text", "An ![alt with [inner](atlas:zsecretinatlasalt) words](atlas:zsecretatlasimage) here."),
    ("image inside an atlas link", "An [![pic alt](/pic.png)](atlas:zsecretimagelink) here."),
    ("atlas image inside an ordinary link", "An [![linked alt](atlas:zsecretimageinlink)](https://example.com/) here."),
    ("emphasis in the label", "An **[strong label](atlas:zsecretstrong)** and *[em label](atlas:zsecretem)* here."),
    ("link inside a link", "An [outer [nested label](atlas:zsecretnested)](https://example.com/) here."),
    ("heading with a link", "## Heading [heading label](atlas:zsecretheading)"),
    ("heading with an autolink", "## <atlas:zsecretheadingauto>"),
    ("heading with an image", "## Heading ![heading alt](atlas:zsecretheadingimage)"),
    ("footnote", "A note[^zn] here.\n\n[^zn]: Footnote [note label](atlas:zsecretfootnote) and <atlas:zsecretfootnoteauto> and ![note alt](atlas:zsecretfootnoteimage)."),
    ("table", "| a | b | c |\n|---|---|---|\n| [cell label](atlas:zsecretcell) | ![cell alt](atlas:zsecretcellimage) | <atlas:zsecretcellauto> |"),
    ("list item", "- A [list label](atlas:zsecretlist)\n- An ![list alt][zlistimg]\n\n[zlistimg]: atlas:zsecretlistimg"),
    ("block quote", "> A [quote label](atlas:zsecretquote) and <atlas:zsecretquoteauto>."),
    ("the scheme in capitals", "A [capital label](ATLAS:zsecretcapital) here."),
    ("the scheme in mixed case with padding", "A [mixed label](<  AtLaS:zsecretmixed >) here."),
    ("an entity in the scheme", "A [entity label](atlas&#58;zsecretentity) here."),
    ("a malformed id", "A [bad label](atlas:ZSECRETBAD) and [spacey label](<atlas:zsecret space>)."),
    ("raw mark", "A <ob-concept data-id=\"zsecretraw\">raw label</ob-concept> here."),
    ("raw mark in capitals with other quotes", "A <OB-CONCEPT data-id='zsecretrawupper' class=\"a>b\">upper label</OB-CONCEPT> here."),
    ("raw mark unclosed", "A <ob-concept data-id=\"zsecretrawopen\">dangling label here."),
    ("raw mark closing tag only", "A stray </ob-concept> here."),
    ("raw mark in a raw block", "<div>\n<ob-concept data-id=\"zsecretrawblock\">block label</ob-concept>\n</div>"),
    ("raw anchor", "A <a href=\"atlas:zsecretrawhref\">raw href label</a> here."),
    ("raw anchor in capitals, unquoted", "A <A HREF=atlas:zsecretrawunquoted>raw unquoted label</A> here."),
    ("raw anchor in single quotes with padding", "A <a\n  href = ' AtLaS:zsecretrawpadded '>raw padded label</a> here."),
    ("raw anchor with entities in the scheme", "A <a href=\"atlas&#58;zsecretrawentity\">raw entity label</a> and <a href=\"&#x61;tlas&colon;zsecretrawcolon\">raw colon label</a> and <a href=\"at&Tab;las:zsecretrawtab\">raw tab label</a>."),
    ("raw image", "An <img src=\"atlas:zsecretrawsrc\" alt=\"raw src alt\"> here."),
    ("raw image srcset", "An <img src=\"/pic.png\" srcset=\"/a.png 1x, atlas:zsecretrawsrcset 2x\" alt=\"raw srcset alt\"> here."),
    ("raw image srcset first candidate unquoted", "An <img srcset=atlas:zsecretrawsrcsetfirst alt=\"raw first alt\"> here."),
    ("raw video poster", "<video poster=\"atlas:zsecretrawposter\" src=\"/v.mp4\">raw poster label</video>"),
    ("raw object data", "<object data=\"atlas:zsecretrawdata\">raw data label</object>"),
    ("raw form action", "<form action=\"atlas:zsecretrawaction\"><button formaction=\"atlas:zsecretrawformaction\">raw form label</button></form>"),
    ("raw cite", "<blockquote cite=\"atlas:zsecretrawcite\">raw cite label</blockquote>"),
    ("raw svg xlink", "<svg><a xlink:href=\"atlas:zsecretrawxlink\"><text>raw xlink label</text></a></svg>"),
    ("raw background", "<table background=\"atlas:zsecretrawbackground\"><tr><td background=atlas:zsecretrawcellbackground>raw background label</td></tr></table>"),
    ("raw tag split across the lines of a block", "<div\n  class=\"x\"\n  data-x=\"1\"\n  href=\"atlas:zsecretrawsplit\">\nraw split label\n</div>"),
    ("raw anchor in a footnote", "A note[^zraw] here.\n\n[^zraw]: Footnote <a href=\"atlas:zsecretrawfootnote\">raw footnote label</a>."),
    ("raw anchor in a list and a quote", "- <a href=\"atlas:zsecretrawlist\">raw list label</a>\n\n> <a href=\"atlas:zsecretrawquote\">raw quote label</a>"),
    ("raw block tag never closed", "<div class=\"x\" href=\"atlas:zsecretrawunclosed\""),
];

fn public_atlas() -> PublicAtlas {
    let library = SourceLibrary::parse(
        &json!({"version": 1, "sources": [
            {"id": "plato-republic", "kind": "work", "title": "Politeia"}]})
        .to_string(),
        &BTreeMap::new(),
    )
    .unwrap();
    let notebook = Notebook::parse(
        &json!({"version": 1, "passages": [], "notes": []}).to_string(),
        &library,
    )
    .unwrap();
    let entry = |id: &str, label: &str, visibility: &str| json!({"id": id, "kind": "concept", "label": label, "visibility": visibility});
    let atlas = Atlas::parse(
        &json!({"version": 1, "entries": [
            entry("plato", "Plato", "approved"),
            // Private entries the corpus names: never published.
            entry("zsecretinline", "ztitle private label", "private"),
            entry("zsecretheading", "ztitle private heading", "private")],
            "relationships": []})
        .to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .expect("a valid atlas");
    PublicAtlas::project(&atlas, &library).expect("a projection")
}

fn corpus_markdown() -> String {
    let mut out = String::from("A published [Plato](atlas:plato) stays a link in a post.\n\n");
    for (_, block) in CORPUS {
        out.push_str(block);
        out.push_str("\n\n");
    }
    out
}

fn site(atlas_on: bool) -> Site {
    let mut config = SiteConfig::from_json(
        r#"{"title": "Corpus", "url": "https://example.com", "author": {"name": "Site Author"}}"#,
    )
    .unwrap();
    config.knowledge_atlas.publish = atlas_on;
    // The home introduction is one document too.
    config.home.intro = corpus_markdown();
    let body = corpus_markdown();
    let mut site = Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: "posts/cave.md".into(),
                contents: format!(
                    "---\ntitle: The cave\ndate: 2026-10-20\nseries: greeks\n---\n{body}"
                ),
            }],
            pages: vec![SourceFile {
                path: "pages/about.md".into(),
                contents: format!("---\ntitle: About\n---\n{body}"),
            }],
            series: vec![SourceFile {
                path: "series/greeks.md".into(),
                contents: format!("---\nname: Greeks\n---\n{body}"),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .expect("site");
    site.atlas = atlas_on.then(public_atlas);
    site.link_concepts();
    site
}

/// Whether `lower` holds the `ob-concept` element's tag. The reader's own
/// `<ob-concept-previews>` component is a different element.
fn has_raw_mark(lower: &str) -> bool {
    ["<ob-concept", "</ob-concept"].iter().any(|open| {
        lower.match_indices(open).any(|(at, _)| {
            lower[at + open.len()..]
                .chars()
                .next()
                .is_none_or(|c| c.is_whitespace() || c == '>' || c == '/')
        })
    })
}

/// The character references a browser decodes in an attribute value, as far
/// as the corpus uses them.
fn decode(value: &str) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let end = rest.find(';').filter(|end| *end <= 10);
        let decoded = end.and_then(|end| {
            let name = &rest[1..end];
            let character = match name {
                "colon" => Some(':'),
                "Tab" => Some('\t'),
                "NewLine" => Some('\n'),
                "amp" => Some('&'),
                _ => name.strip_prefix('#').and_then(|number| {
                    let code = match number.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok(),
                        None => number.parse().ok(),
                    };
                    code.and_then(char::from_u32)
                }),
            };
            character.map(|character| (character, end + 1))
        });
        match decoded {
            Some((character, length)) => {
                out.push(character);
                rest = &rest[length..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Whether an address value, after the trimming a browser does, has the
/// `atlas:` scheme in any letter case.
fn is_atlas(value: &str) -> bool {
    let cleaned: String = value
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    cleaned
        .trim_matches(|c: char| c.is_control() || c.is_whitespace())
        .to_ascii_lowercase()
        .starts_with("atlas:")
}

/// Every address attribute in `html` whose value has the `atlas:` scheme: the
/// name in any case, the value quoted either way or not at all, with its
/// character references decoded, and every candidate of a `srcset`.
fn atlas_addresses(html: &str) -> Vec<String> {
    const ADDRESSES: [&str; 11] = [
        "href",
        "src",
        "srcset",
        "poster",
        "data",
        "action",
        "formaction",
        "cite",
        "xlink:href",
        "background",
        "imagesrcset",
    ];
    let bytes = html.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(open) = html[at..].find('<') {
        let mut i = at + open + 1;
        at = i;
        if !bytes.get(i).is_some_and(u8::is_ascii_alphabetic) {
            continue;
        }
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && !matches!(bytes[i], b'>' | b'/')
        {
            i += 1;
        }
        loop {
            while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
                i += 1;
            }
            if i >= bytes.len() || bytes[i] == b'>' {
                break;
            }
            let start = i;
            i += 1;
            while i < bytes.len()
                && !bytes[i].is_ascii_whitespace()
                && !matches!(bytes[i], b'/' | b'>' | b'=')
            {
                i += 1;
            }
            let name = html[start..i].to_ascii_lowercase();
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if bytes.get(i) != Some(&b'=') {
                continue;
            }
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let value = match bytes.get(i) {
                Some(&quote @ (b'"' | b'\'')) => {
                    let end = html[i + 1..]
                        .find(quote as char)
                        .map_or(html.len(), |end| i + 1 + end);
                    let value = &html[i + 1..end];
                    i = (end + 1).min(html.len());
                    value
                }
                _ => {
                    let start = i;
                    while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                        i += 1;
                    }
                    &html[start..i]
                }
            };
            if !ADDRESSES.contains(&name.as_str()) {
                continue;
            }
            let value = decode(value);
            let hit = if name.ends_with("srcset") {
                value
                    .split(|c: char| c == ',' || c.is_whitespace())
                    .any(is_atlas)
            } else {
                is_atlas(&value)
            };
            if hit {
                found.push(name);
            }
        }
    }
    found
}

/// What a file must never hold, named so a failure says which guard.
fn leaks(path: &str, contents: &str) -> Vec<String> {
    let lower = contents.to_ascii_lowercase();
    let mut found = Vec::new();
    if lower.contains(SECRET_ID) {
        found.push(format!("{path}: a private id"));
    }
    if lower.contains(SECRET_TITLE) {
        found.push(format!("{path}: a private title"));
    }
    if has_raw_mark(&lower) {
        found.push(format!("{path}: a raw <ob-concept mark"));
    }
    // An `atlas:` scheme in any address attribute, as a browser reads it. A
    // JSON file holds HTML as an escaped string, so it is read unescaped.
    let readable = if path.ends_with(".json") {
        contents
            .replace("\\\"", "\"")
            .replace("\\u003c", "<")
            .replace("\\u003e", ">")
            .replace("\\u0026", "&")
    } else {
        contents.to_string()
    };
    for attribute in atlas_addresses(&readable) {
        found.push(format!("{path}: an `atlas:` address in `{attribute}`"));
    }
    // The scheme as a Markdown destination in a portable copy.
    if lower.contains("](atlas:") || lower.contains("]: atlas:") || lower.contains("<atlas:") {
        found.push(format!("{path}: an atlas Markdown destination"));
    }
    found
}

#[test]
fn no_markdown_form_of_an_atlas_link_or_image_leaks_anywhere_in_the_build() {
    for atlas_on in [true, false] {
        let site = site(atlas_on);
        let mut found = Vec::new();
        let dist = generate(&site, &ThemeSet::new()).expect("a build");
        let paths: Vec<&String> = dist.iter().map(|file| &file.path).collect();
        for expected in [
            "feed.json",
            "search.json",
            "llms-full.txt",
            "posts/cave/index.html",
            "about/index.html",
            "series/greeks/index.html",
            "index.html",
        ] {
            assert!(
                paths.iter().any(|path| path.as_str() == expected),
                "{expected} is not in {paths:?}"
            );
        }
        for file in &dist {
            found.extend(leaks(&file.path, &file.contents));
        }
        // The portable copies of the post: Markdown, HTML and text.
        let projection =
            PortableProjection::from_post(&site.posts[0], &site.config).expect("a projection");
        found.extend(leaks(
            "portable markdown",
            &projection.portable_markdown().expect("markdown"),
        ));
        found.extend(leaks(
            "portable text",
            &projection.portable_text().expect("text"),
        ));
        found.extend(leaks(
            "portable html",
            &projection.portable_html().expect("html").html,
        ));
        // The documents themselves, before any template wraps them.
        found.extend(leaks("post html", &site.posts[0].html));
        found.extend(leaks("post text", &site.posts[0].text));
        found.extend(leaks("page html", &site.pages[0].html));
        found.extend(leaks("series html", &site.series[0].description_html));
        assert!(
            found.is_empty(),
            "atlas {}: {} leaks\n{}",
            if atlas_on { "on" } else { "off" },
            found.len(),
            found.join("\n")
        );
    }
}

#[test]
fn every_form_keeps_the_authors_label_and_the_author_hears_about_it() {
    let site = site(true);
    let html = &site.posts[0].html;
    // Labels survive as words, whatever the form.
    for label in [
        "inline label",
        "titled label",
        "full label",
        "zcollapsed",
        "zshortcut",
        "inline alt",
        "ref alt",
        "alt with inner words",
        "strong label",
        "cell label",
        "note label",
        "raw label",
    ] {
        assert!(html.contains(label), "{label} is missing from {html}");
    }
    // The published entry is still a real link, and only that one.
    assert!(html.contains("href=\"/atlas/plato/\""));
    assert_eq!(html.matches("class=\"ob-concept\"").count(), 1, "{html}");
    // An autolink has no label, and the author is told what to write.
    let warnings = site.warnings.join("\n");
    assert!(warnings.contains("write `[label](atlas:id)`"), "{warnings}");
    for source in [
        "posts/cave.md",
        "pages/about.md",
        "series/greeks.md",
        "openblog.json (home.intro)",
    ] {
        assert!(
            site.warnings.iter().any(|w| w.starts_with(source)),
            "{source}: no warning in {warnings}"
        );
    }
    // A raw HTML address is removed, and the warning names the document and
    // never the address.
    for source in [
        "posts/cave.md",
        "pages/about.md",
        "series/greeks.md",
        "openblog.json (home.intro)",
    ] {
        assert!(
            site.warnings.iter().any(|w| w.starts_with(source)
                && w.contains("raw HTML cannot carry an `atlas:` address")),
            "{source}: no raw HTML warning in {warnings}"
        );
    }
    assert!(
        site.warnings
            .iter()
            .filter(|w| w.contains("raw HTML cannot carry"))
            .all(|w| !w.contains("zsecret")),
        "{warnings}"
    );
    // An image is always refused.
    assert!(
        warnings.contains("an image cannot have an `atlas:` address"),
        "{warnings}"
    );
    // The page and the post agree: a page makes no concept link.
    let page = &site.pages[0].html;
    assert!(!page.contains("class=\"ob-concept\""), "{page}");
}
