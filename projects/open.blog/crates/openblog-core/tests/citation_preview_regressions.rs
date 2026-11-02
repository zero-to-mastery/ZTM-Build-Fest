//! Citation-preview security, publication and compatibility regressions
//! (#67): a corpus of hostile reference data reaches the page only as inert
//! text and allowlisted links, the page adds no inline script, style or
//! handler that a strict content security policy would refuse, very large
//! data still builds a complete page, the data never leaves the post's own
//! page (indexes, feeds, search, `llms.txt`, portable copies), a base path
//! changes neither the data nor the anchors, the output is deterministic
//! whatever order the library lists its sources in, and a site that publishes
//! no citations is byte for byte what it was before previews.

use std::collections::BTreeMap;

use openblog_core::bibliography::{
    CitationLocale, CitationPlacement, CitationStyle, CitationSummary,
};
use openblog_core::citations::PublicReference;
use openblog_core::model::LibrarySource;
use openblog_core::portability::PortableProjection;
use openblog_core::reader_references::ReaderReferences;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};

/// Text that would be markup, script, a template, an entity, a line
/// separator or a Markdown link if it were ever interpreted.
const HOSTILE_TEXT: &[&str] = &[
    "</script><script>window.__x=1</script>",
    "</SCRIPT >tail",
    "<!--<script>window.__x=1//",
    "<img src=x onerror=window.__x=1>",
    "\" onmouseover=\"window.__x=1",
    "' autofocus onfocus='window.__x=1",
    "<svg><a xlink:href=\"javascript:window.__x=1\">x</a></svg>",
    "[click](javascript:window.__x=1)",
    "<javascript:window.__x=1>",
    "${window.__x=1} {{constructor.constructor('window.__x=1')()}}",
    "&lt;script&gt;window.__x=1&lt;/script&gt; &amp; &#x3c;b&#x3e;",
    "]]> \u{2028}\u{2029} line separators",
    "\u{202e}lanigiro\u{202c} bidi override",
    "`code` *em* _em_ **strong** # heading | table ~strike~ \\ backslash",
];

/// Identifier values the source library accepts that are still awkward in a
/// page (quotes, markup, bidi controls and `?`/`#` in a DOI), with the link
/// each must get. `None`: never a link (the identifier is not public).
const ACCEPTED_LINKS: &[(&str, &str, Option<&str>)] = &[
    (
        "url",
        "https://example.org/a_(b)?q=1&r=2#frag",
        Some("https://example.org/a_(b)?q=1&r=2#frag"),
    ),
    (
        "url",
        "https://example.org/%22%3E%3Cscript%3E",
        Some("https://example.org/%22%3E%3Cscript%3E"),
    ),
    (
        "url",
        "https://example.org:8443/x'y",
        Some("https://example.org:8443/x'y"),
    ),
    (
        "url",
        "https://example.org/\u{202e}x",
        Some("https://example.org/%E2%80%AEx"),
    ),
    (
        "url",
        "https://xn--e1afmkfd.xn--p1ai/",
        Some("https://xn--e1afmkfd.xn--p1ai/"),
    ),
    (
        "doi",
        "10.1000/\"><script>window.__x=1</script>",
        Some("https://doi.org/10.1000/%22%3E%3Cscript%3Ewindow.__x%3D1%3C%2Fscript%3E"),
    ),
    (
        "doi",
        "doi:10.1000/x?y#z",
        Some("https://doi.org/10.1000/x%3Fy%23z"),
    ),
    (
        "doi",
        "https://dx.doi.org/10.1000/x",
        Some("https://doi.org/10.1000/x"),
    ),
    ("pmid", "\" onclick=\"window.__x=1", None),
];

/// Identifier values that must never become a link. The source library
/// refuses each of them where it enters; the reader data refuses them again
/// if one ever got past it.
const REFUSED_LINKS: &[(&str, &str)] = &[
    ("url", "javascript:window.__x=1"),
    ("url", "JaVaScRiPt:window.__x=1"),
    ("url", "data:text/html,<script>window.__x=1</script>"),
    ("url", "vbscript:msgbox(1)"),
    ("url", "file:///etc/passwd"),
    ("url", "https://user:secret@example.org/"),
    ("url", "https://:secret@example.org/"),
    ("url", "//example.org/protocol-relative"),
    ("url", "/root-relative"),
    ("url", "#cite-1"),
    ("url", "http://"),
    ("doi", "javascript:window.__x=1"),
    ("doi", "https://evil.example/10.1000/x"),
    ("doi", "https://user@doi.org/10.1000/x"),
];

fn library(sources: &[String]) -> String {
    format!(
        "{{\"version\": 1, \"sources\": [\n{}\n]}}",
        sources.join(",\n\n")
    )
}

fn json(text: &str) -> String {
    serde_json::to_string(text).unwrap()
}

/// One source per hostile text (as title, creator, container and
/// publisher) and one per hostile identifier, then a post citing them all.
fn hostile_corpus() -> (String, String) {
    let mut sources = Vec::new();
    let mut keys = Vec::new();
    for (index, text) in HOSTILE_TEXT.iter().enumerate() {
        let key = format!("text-{index}");
        sources.push(format!(
            "{{\"id\": \"{key}\", \"kind\": \"work\", \"title\": {t}, \"issued\": {t},
              \"creators\": [{{\"name\": {t}, \"role\": \"author\"}}],
              \"csl\": {{\"container-title\": {t}, \"publisher\": {t}, \"publisher-place\": {t}}}}}",
            t = json(text)
        ));
        keys.push(key);
    }
    for (index, (scheme, value, _)) in ACCEPTED_LINKS.iter().enumerate() {
        let key = format!("link-{index}");
        sources.push(format!(
            "{{\"id\": \"{key}\", \"kind\": \"work\", \"title\": \"Link {index}\",
              \"identifiers\": [{{\"scheme\": \"{scheme}\", \"value\": {}}}]}}",
            json(value)
        ));
        keys.push(key);
    }
    let citations = keys
        .iter()
        .map(|key| format!("Claim [@{key}, canonical 1]."))
        .collect::<Vec<_>>()
        .join("\n");
    let post =
        format!("---\ntitle: Hostile\ndate: 2026-10-20\ncitations: notes\n---\n{citations}\n");
    (library(&sources), post)
}

fn config() -> SiteConfig {
    SiteConfig::from_json(
        r#"{"title": "T", "url": "https://example.test", "author": {"name": "A"}}"#,
    )
    .unwrap()
}

fn load(posts: &[(&str, &str)], library: &str) -> Site {
    let sources = Sources {
        posts: posts
            .iter()
            .map(|(path, contents)| SourceFile {
                path: (*path).into(),
                contents: (*contents).into(),
            })
            .collect(),
        source_library: Some(LibrarySource::Text(SourceFile {
            path: ".openblog/private/research/sources.json".into(),
            contents: library.into(),
        })),
        ..Default::default()
    };
    Site::load(config(), sources, LoadOptions::default()).expect("site loads")
}

fn build(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

fn page_path(post: &openblog_core::model::Post) -> String {
    format!("{}index.html", post.url.trim_start_matches('/'))
}

/// The text of the page's one reference data element.
fn embedded_data(page: &str) -> &str {
    let opening = "<script type=\"application/json\" id=\"ob-references\">";
    assert_eq!(page.matches(opening).count(), 1);
    let start = page.find(opening).unwrap() + opening.len();
    &page[start..start + page[start..].find("</script>").unwrap()]
}

/// Every start tag of the page as `(name, [(attribute, value)])`, both
/// names in lowercase. Text, comments and attribute values are skipped as a
/// browser skips them, so text that only looks like markup is not counted.
fn tags(page: &str) -> Vec<(String, Vec<(String, String)>)> {
    let bytes = page.as_bytes();
    let name_end = |mut at: usize, stop: &[u8]| {
        while at < bytes.len() && !bytes[at].is_ascii_whitespace() && !stop.contains(&bytes[at]) {
            at += 1;
        }
        at
    };
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at..].starts_with(b"<!--") {
            at += page[at..].find("-->").map_or(bytes.len(), |end| end + 3);
            continue;
        }
        if bytes[at] != b'<' || !bytes.get(at + 1).is_some_and(u8::is_ascii_alphabetic) {
            at += 1;
            continue;
        }
        let end = name_end(at + 1, b"/>");
        let name = page[at + 1..end].to_ascii_lowercase();
        let mut attributes = Vec::new();
        at = end;
        loop {
            while at < bytes.len() && (bytes[at].is_ascii_whitespace() || bytes[at] == b'/') {
                at += 1;
            }
            if at >= bytes.len() || bytes[at] == b'>' {
                at += 1;
                break;
            }
            let end = name_end(at + 1, b"/>=");
            let attribute = page[at..end].to_ascii_lowercase();
            at = end;
            while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                at += 1;
            }
            let mut value = String::new();
            if bytes.get(at) == Some(&b'=') {
                at += 1;
                while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                    at += 1;
                }
                if let Some(quote @ (b'"' | b'\'')) = bytes.get(at).copied() {
                    let close = at + 1 + page[at + 1..].find(quote as char).unwrap();
                    value = page[at + 1..close].replace("&amp;", "&");
                    at = close + 1;
                } else {
                    let end = name_end(at, b">");
                    value = page[at..end].to_string();
                    at = end;
                }
            }
            attributes.push((attribute, value));
        }
        found.push((name, attributes));
    }
    found
}

/// The page's structure, whatever text it holds: how many elements of each
/// name, and every attribute name in use, by element.
fn structure(page: &str) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for (name, attributes) in tags(page) {
        *counts.entry(name.clone()).or_default() += 1;
        for (attribute, _) in attributes {
            *counts.entry(format!("{name}[{attribute}]")).or_default() += 1;
        }
    }
    counts
}

/// Every value of an attribute, from start tags only.
fn attribute_values(page: &str, wanted: &str) -> Vec<String> {
    tags(page)
        .into_iter()
        .flat_map(|(_, attributes)| attributes)
        .filter(|(name, _)| name == wanted)
        .map(|(_, value)| value)
        .collect()
}

#[test]
fn hostile_reference_data_reaches_the_page_only_as_text_and_safe_links() {
    let (library, post) = hostile_corpus();
    let site = load(&[("posts/hostile.md", &post)], &library);
    let page = build(&site).remove(&page_path(&site.posts[0])).unwrap();
    let data = site.posts[0].reader_references().unwrap();
    data.check_page(&page).unwrap();
    assert_eq!(
        data.references.len(),
        HOSTILE_TEXT.len() + ACCEPTED_LINKS.len()
    );

    // The data element cannot be closed, commented or split by any text.
    let embedded = embedded_data(&page);
    for raw in ['<', '>', '&', '\u{2028}', '\u{2029}'] {
        assert!(!embedded.contains(raw), "raw {raw:?} in the data element");
    }
    let parsed: serde_json::Value = serde_json::from_str(embedded).unwrap();
    assert_eq!(
        parsed,
        serde_json::from_str::<serde_json::Value>(&data.to_json()).unwrap()
    );

    // The text is kept exactly, as text.
    for (index, text) in HOSTILE_TEXT.iter().enumerate() {
        let reference = &parsed["references"][index];
        assert_eq!(reference["preview"]["title"], **text);
        assert!(
            reference["formatted"].as_str().unwrap().contains(text),
            "{text}"
        );
        assert!(reference.get("link").is_none(), "{text}");
    }
    // Each identifier links only where it is an allowlisted address.
    for (index, (_, value, expected)) in ACCEPTED_LINKS.iter().enumerate() {
        let reference = &parsed["references"][HOSTILE_TEXT.len() + index];
        assert_eq!(reference["link"].as_str(), *expected, "{value}");
        if let Some(link) = expected {
            let url = url::Url::parse(link).unwrap();
            assert!(matches!(url.scheme(), "http" | "https"), "{link}");
            assert!(
                url.username().is_empty() && url.password().is_none(),
                "{link}"
            );
            assert!(url.host_str().is_some(), "{link}");
        }
    }

    // The page has exactly the structure of the same citations of harmless
    // sources: no element, script or handler came from the data.
    let benign_text = HOSTILE_TEXT.iter().fold(library.clone(), |library, text| {
        library.replace(&json(text), "\"Harmless\"")
    });
    let benign_links =
        ACCEPTED_LINKS
            .iter()
            .fold(benign_text, |library, (scheme, value, expected)| {
                let replacement = match (expected, *scheme) {
                    (Some(_), "doi") => "10.1000/harmless",
                    (Some(_), _) => "https://example.org/harmless",
                    (None, _) => "plain",
                };
                library.replace(
                    &format!("\"value\": {}", json(value)),
                    &format!("\"value\": {}", json(replacement)),
                )
            });
    let benign_site = load(&[("posts/hostile.md", &post)], &benign_links);
    let benign = build(&benign_site)
        .remove(&page_path(&benign_site.posts[0]))
        .unwrap();
    assert!(
        !benign.contains("window.__x"),
        "the benign corpus is harmless"
    );
    assert_eq!(structure(&page), structure(&benign));

    // No link on the page has a scheme other than http(s), and none carries
    // credentials.
    for href in attribute_values(&page, "href") {
        let lower = href.to_ascii_lowercase();
        assert!(
            lower.starts_with('#')
                || lower.starts_with('/') && !lower.starts_with("//")
                || lower.starts_with("https://")
                || lower.starts_with("http://")
                || lower.starts_with("mailto:"),
            "unexpected link {href}"
        );
        assert!(
            !href.contains("secret@") && !href.contains("user@"),
            "{href}"
        );
    }
    assert!(attribute_values(&page, "src")
        .iter()
        .all(|src| src.starts_with('/') && !src.starts_with("//")));
}

#[test]
fn the_page_adds_nothing_a_strict_content_security_policy_refuses() {
    let (library, post) = hostile_corpus();
    let cited = load(&[("posts/hostile.md", &post)], &library);
    let page = build(&cited).remove(&page_path(&cited.posts[0])).unwrap();
    let plain_post = post.replace("citations: notes\n", "");
    let plain = load(&[("posts/hostile.md", &plain_post)], &library);
    let plain_page = build(&plain).remove(&page_path(&plain.posts[0])).unwrap();

    // Inline executable scripts (no `src`, not a data type) are exactly the
    // ones the page has without citations.
    let inline_scripts = |page: &str| -> Vec<String> {
        page.match_indices("<script")
            .map(|(at, _)| {
                let tag = &page[at..at + page[at..].find('>').unwrap() + 1];
                let body_end = page[at..].find("</script>").unwrap();
                (
                    tag.to_string(),
                    page[at + tag.len()..at + body_end].to_string(),
                )
            })
            .filter(|(tag, _)| {
                !tag.contains(" src=\"")
                    && !tag.contains("type=\"application/json\"")
                    && !tag.contains("type=\"application/ld+json\"")
            })
            .map(|(_, body)| body)
            .collect()
    };
    assert_eq!(inline_scripts(&page), inline_scripts(&plain_page));
    // External scripts come from the site itself.
    for (at, _) in page.match_indices("<script type=\"module\" src=\"") {
        let rest = &page[at + "<script type=\"module\" src=\"".len()..];
        let src = &rest[..rest.find('"').unwrap()];
        assert!(src.starts_with('/') && !src.starts_with("//"), "{src}");
    }
    assert!(page.contains(
        "<script type=\"module\" src=\"/assets/components/ob-citation-previews.js\"></script>"
    ));
    // No inline style attribute or event handler anywhere on the page.
    let attributes: Vec<String> = tags(&page)
        .into_iter()
        .flat_map(|(_, attributes)| attributes)
        .map(|(name, _)| name)
        .collect();
    assert!(
        !attributes
            .iter()
            .any(|name| name == "style" || name.starts_with("on")),
        "{attributes:?}"
    );

    // The component never needs anything beyond `script-src 'self'` and
    // `style-src 'self'`: no HTML parsing sinks, evaluation, requests,
    // storage, history or inline style.
    let component = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/components/ob-citation-previews.js"
    ))
    .unwrap();
    for sink in [
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "createContextualFragment",
        "DOMParser",
        "eval(",
        "Function(",
        "import(",
        "fetch(",
        "XMLHttpRequest",
        "WebSocket",
        "EventSource",
        "sendBeacon",
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "cookie",
        "history.",
        "location",
        "cssText",
        "setAttribute(\"style\"",
        "scrollTo",
        "scrollIntoView",
        "new Image",
        ".src =",
        "srcdoc",
    ] {
        assert!(!component.contains(sink), "the component uses `{sink}`");
    }
}

#[test]
fn very_large_reference_data_still_builds_a_complete_followable_page() {
    // Many sources at the library's longest title and name, in characters
    // that grow sixfold when escaped in the data element.
    let long = "<&>".repeat(333);
    let count = 100;
    let sources: Vec<String> = (0..count)
        .map(|index| {
            format!(
                "{{\"id\": \"big-{index}\", \"kind\": \"work\", \"title\": {t},
                  \"creators\": [{{\"name\": {t}}}],
                  \"identifiers\": [{{\"scheme\": \"url\", \"value\": \"https://example.org/{index}?{q}\"}}]}}",
                t = json(&long),
                q = "q".repeat(900)
            )
        })
        .collect();
    let citations = (0..count)
        .map(|index| {
            format!(
                "Claim [@big-{index}, canonical {index}] and [@big-{index}, canonical {index}]."
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let post = format!("---\ntitle: Big\ndate: 2026-10-20\ncitations: notes\n---\n{citations}\n");
    let site = load(&[("posts/big.md", &post)], &library(&sources));
    let page = build(&site).remove(&page_path(&site.posts[0])).unwrap();
    let data = site.posts[0].reader_references().unwrap();
    assert_eq!(data.references.len(), count);
    assert_eq!(data.citations.len(), 2 * count);
    data.check_page(&page).unwrap();
    let embedded = embedded_data(&page);
    assert!(!embedded.contains('<') && !embedded.contains('&'));
    // Past the component's 1 MB budget the previews are simply absent: every
    // marker still links to its note and back, so the page reads the same.
    assert!(embedded.len() > 1_000_000, "{}", embedded.len());
    let links: std::collections::BTreeSet<String> = attribute_values(&page, "href")
        .into_iter()
        .filter(|href| href.starts_with('#'))
        .collect();
    for citation in &data.citations {
        assert!(links.contains(&format!("#{}", citation.note)));
        assert!(links.contains(&format!("#{}", citation.marker)));
    }
    assert_eq!(
        page.matches("class=\"footnote-definition ob-citation-note\"")
            .count(),
        count
    );
}

#[test]
fn preview_data_never_leaves_the_posts_own_page() {
    let (library, post) = hostile_corpus();
    let plain = "---\ntitle: Plain\ndate: 2026-10-19\ntags: [a]\n---\nNo citations[^1].\n\n[^1]: A footnote.\n";
    let site = load(
        &[("posts/hostile.md", &post), ("posts/plain.md", plain)],
        &library,
    );
    let cited = site
        .posts
        .iter()
        .find(|post| post.slug == "hostile")
        .unwrap();
    let files = build(&site);
    assert!(files.contains_key("llms.txt") && files.contains_key("rss.xml"));
    let preview_only = [
        "ob-references",
        "ob-citation-previews",
        "ob-citation-preview",
        "\"marker\":",
        "\"locators\":",
    ];
    for (path, contents) in &files {
        if *path == page_path(cited) {
            continue;
        }
        for marker in preview_only {
            assert!(!contents.contains(marker), "{path} carries `{marker}`");
        }
    }
    // Feeds and `llms.txt` still carry the notes themselves.
    let carried: Vec<&String> = files
        .iter()
        .filter(|(_, contents)| contents.contains("Link 7"))
        .map(|(path, _)| path)
        .collect();
    assert!(
        carried.iter().any(|path| path.ends_with(".xml")),
        "{carried:?}"
    );
    // Portable copies carry the notes too, and none of the preview data.
    let projection = PortableProjection::for_site(&site, cited).unwrap();
    let html = projection.portable_html().unwrap().html;
    let markdown = projection.portable_markdown().unwrap();
    let text = projection.portable_text().unwrap();
    for (name, contents) in [("html", &html), ("markdown", &markdown), ("text", &text)] {
        for marker in preview_only {
            assert!(
                !contents.contains(marker),
                "portable {name} carries `{marker}`"
            );
        }
        assert!(
            contents.contains("Link 7"),
            "portable {name} lost the notes"
        );
    }
    // Hostile text stays text in each: no element in the HTML, every `<` of
    // it escaped in the Markdown.
    assert!(
        !html.contains("<script") && !html.contains("<img"),
        "{html}"
    );
    for (at, _) in markdown.match_indices("<script") {
        assert_eq!(
            &markdown[at - 1..at],
            "\\",
            "unescaped markup in the Markdown"
        );
    }
}

#[test]
fn output_is_byte_for_byte_deterministic_whatever_the_library_order() {
    let (library, post) = hostile_corpus();
    let first = build(&load(&[("posts/hostile.md", &post)], &library));
    let again = build(&load(&[("posts/hostile.md", &post)], &library));
    assert_eq!(first, again);
    // The same sources listed in reverse: references are numbered by first
    // citation, so nothing on any page changes.
    let body = library
        .trim_start_matches(
            "{\"version\": 1, \"sources\": [
",
        )
        .trim_end_matches(
            "
]}",
        );
    let mut sources: Vec<String> = body
        .split(
            ",

",
        )
        .map(str::to_string)
        .collect();
    assert_eq!(sources.len(), HOSTILE_TEXT.len() + ACCEPTED_LINKS.len());
    sources.reverse();
    let reversed = build(&load(
        &[("posts/hostile.md", &post)],
        &crate::library(&sources),
    ));
    assert_eq!(first, reversed);
}

#[test]
fn links_that_must_never_be_followed_are_refused_twice() {
    for (scheme, value) in REFUSED_LINKS {
        // Where they enter: the library refuses to load, and the post that
        // relies on it stops, without echoing the value.
        let source = format!(
            "{{\"id\": \"bad\", \"kind\": \"work\", \"title\": \"Bad\",
              \"identifiers\": [{{\"scheme\": \"{scheme}\", \"value\": {}}}]}}",
            json(value)
        );
        let sources = Sources {
            posts: vec![SourceFile {
                path: "posts/bad.md".into(),
                contents: "---\ntitle: Bad\ndate: 2026-10-20\ncitations: notes\n---\nA [@bad].\n"
                    .into(),
            }],
            source_library: Some(LibrarySource::Text(SourceFile {
                path: ".openblog/private/research/sources.json".into(),
                contents: library(&[source]),
            })),
            ..Default::default()
        };
        let errors = Site::load(config(), sources, LoadOptions::default()).unwrap_err();
        let errors = errors.join("\n");
        assert!(
            errors.contains("posts/bad.md") && errors.contains("sources.json"),
            "{errors}"
        );
        assert!(!errors.contains(value), "{errors}");

        // If one ever got past it, the reader data still gives it no link.
        let reference = PublicReference {
            key: "bad".into(),
            kind: "work",
            title: Some("Bad".into()),
            creators: Vec::new(),
            issued: None,
            language: None,
            identifiers: vec![((*scheme).into(), (*value).into())],
            csl: BTreeMap::new(),
        };
        let summary = CitationSummary {
            style: CitationStyle::Notes,
            locale: CitationLocale::En,
            citations: 1,
            notes: 1,
            references: vec![reference],
            prefix: "cite-".into(),
            placements: vec![CitationPlacement {
                reference: 1,
                note: 1,
                locators: Vec::new(),
            }],
        };
        let data = ReaderReferences::from_summary(&summary).unwrap();
        assert_eq!(data.references[0].link, None, "{value}");
    }
}

#[test]
fn markup_in_a_web_address_that_gets_past_the_library_is_percent_encoded() {
    // The library refuses it; the reader data, if it ever saw it, links the
    // address with every quote and bracket percent-encoded.
    let value = "https://example.org/\"><script>window.__x=1</script>";
    let source = format!(
        "{{\"id\": \"bad\", \"kind\": \"work\", \"title\": \"Bad\",
          \"identifiers\": [{{\"scheme\": \"url\", \"value\": {}}}]}}",
        json(value)
    );
    assert!(openblog_core::source_library::SourceLibrary::parse(
        &library(&[source]),
        &Default::default()
    )
    .is_err());
    let reference = PublicReference {
        key: "bad".into(),
        kind: "work",
        title: None,
        creators: Vec::new(),
        issued: None,
        language: None,
        identifiers: vec![("url".into(), value.into())],
        csl: BTreeMap::new(),
    };
    let summary = CitationSummary {
        style: CitationStyle::Notes,
        locale: CitationLocale::En,
        citations: 1,
        notes: 1,
        references: vec![reference],
        prefix: "cite-".into(),
        placements: vec![CitationPlacement {
            reference: 1,
            note: 1,
            locators: Vec::new(),
        }],
    };
    let data = ReaderReferences::from_summary(&summary).unwrap();
    assert_eq!(
        data.references[0].link.as_deref(),
        Some("https://example.org/%22%3E%3Cscript%3Ewindow.__x=1%3C/script%3E")
    );
}

/// A site with contributors, credits, a research post, an article, a recipe
/// and a page, none of which opts in to citations, though the private source
/// library is present and the posts mention `[@keys]`.
fn contributor_site() -> Site {
    let config = SiteConfig::from_json(
        r#"{"title": "T", "url": "https://example.test", "author": {"name": "A"},
            "contributors": {
              "ada": {"name": "Ada", "orcid": "0000-0002-1825-0097"},
              "grace": {"name": "Grace", "url": "https://grace.example/"}
            }}"#,
    )
    .unwrap();
    let file = |path: &str, contents: &str| SourceFile {
        path: path.into(),
        contents: contents.into(),
    };
    let credits = r#"{"version": 1, "credits": [
        {"contributor": "ada", "roles": [{"vocabulary": "crossref", "role": "author"},
                                         {"vocabulary": "credit", "role": "conceptualization"}]},
        {"contributor": "grace", "roles": [{"vocabulary": "crossref", "role": "editor"}]}
    ]}"#;
    let sources = Sources {
        posts: vec![
            file("posts/study.md", "---\ntitle: Study\ndate: 2026-09-02\nprofile: research\ndoi: 10.1234/study\n---\n## Abstract\n\nSummary [@plato-republic] and a note[^1].\n\n## References\n\n1. [Prior work](https://doi.org/10.1000/prior)\n\n[^1]: A note [@inside].\n"),
            file("posts/essay.md", "---\ntitle: Essay\ndate: 2026-09-03\ntags: [a]\n---\nA claim [@plato-republic, page 3].\n\n## Notes\n\nMine.\n"),
            file("posts/soup.md", "---\ntitle: Soup\ndate: 2026-09-04\nprofile: recipe\n---\n## Ingredients\n\n- Water [@plato-republic]\n\n## Steps\n\n1. Boil.\n"),
        ],
        credits: vec![
            file("posts/study.credits.json", credits),
            file("posts/essay.credits.json", credits),
        ],
        pages: vec![file("about.md", "---\ntitle: About\n---\nAbout [@plato-republic].\n")],
        source_library: Some(LibrarySource::Text(file(
            ".openblog/private/research/sources.json",
            r#"{"version": 1, "sources": [{"id": "plato-republic", "kind": "work", "title": "Πολιτεία"}]}"#,
        ))),
        ..Default::default()
    };
    Site::load(config, sources, LoadOptions::default()).expect("site loads")
}

#[test]
fn a_site_that_publishes_no_citations_is_byte_for_byte_what_it_was() {
    // Every generated file, pinned. The golden was checked against the build
    // before citation previews (13dd184); set `OPENBLOG_UPDATE_GOLDEN=1` to
    // rewrite it only for a deliberate change to these pages.
    let files = build(&contributor_site());
    let mut pinned = String::new();
    for (path, contents) in &files {
        pinned.push_str(&format!("===== {path}\n{contents}\n"));
    }
    let golden = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/citation_navigation/contributor-site.txt"
    );
    if std::env::var_os("OPENBLOG_UPDATE_GOLDEN").is_some() {
        std::fs::write(golden, &pinned).unwrap();
    }
    let expected = std::fs::read_to_string(golden)
        .expect("missing golden")
        .replace("\r\n", "\n");
    assert_eq!(pinned, expected);
    for (path, contents) in &files {
        for marker in [
            "ob-references",
            "ob-citation",
            "doc-endnotes",
            "doc-noteref",
        ] {
            assert!(!contents.contains(marker), "{path} carries `{marker}`");
        }
    }
}

#[test]
fn a_site_under_a_base_path_keeps_the_data_and_the_anchors_exact() {
    let library = r#"{"version": 1, "sources": [
        {"id": "refresh", "kind": "work", "title": "Moved; url=/elsewhere/ and src=\"/x\" href=\"/y\"",
         "identifiers": [{"scheme": "url", "value": "https://example.org/a"}]}]}"#;
    let post = "---\ntitle: Based\ndate: 2026-10-20\ncitations: notes\n---\nA claim [@refresh].\n";
    let config = SiteConfig::from_json(
        r#"{"title": "T", "url": "https://example.test/blog/", "author": {"name": "A"}}"#,
    )
    .unwrap();
    let sources = Sources {
        posts: vec![SourceFile {
            path: "posts/based.md".into(),
            contents: post.into(),
        }],
        source_library: Some(LibrarySource::Text(SourceFile {
            path: ".openblog/private/research/sources.json".into(),
            contents: library.into(),
        })),
        ..Default::default()
    };
    let site = Site::load(config, sources, LoadOptions::default()).unwrap();
    let page = build(&site).remove(&page_path(&site.posts[0])).unwrap();
    let data = site.posts[0].reader_references().unwrap();
    data.check_page(&page).unwrap();
    assert!(page.contains("src=\"/blog/assets/components/ob-citation-previews.js"));
    let parsed: serde_json::Value = serde_json::from_str(embedded_data(&page)).unwrap();
    assert_eq!(
        parsed,
        serde_json::from_str::<serde_json::Value>(&data.to_json()).unwrap()
    );
}
