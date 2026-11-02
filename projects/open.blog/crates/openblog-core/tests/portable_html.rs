//! Golden and static-structure regressions for the portable HTML fallbacks of
//! every current interactive capability. Set `OPENBLOG_UPDATE_GOLDEN=1` to
//! rewrite the expected `.html` files after reviewing a deliberate change.

use std::collections::HashSet;

use openblog_core::{
    portability::PortableProjection, LoadOptions, Site, SiteConfig, SourceFile, Sources,
};

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/portable-html"
);
const CANONICAL_BASE: &str = "https://example.test/blog/";
const VOID: &[&str] = &["br", "hr", "img", "wbr"];

fn config() -> SiteConfig {
    SiteConfig::from_json(
        r#"{
            "title": "Portable fixture",
            "url": "https://example.test/blog",
            "postPath": "/{slug}/",
            "author": { "name": "Site Author" },
            "engagement": { "enabled": true, "endpoint": "https://engage.example/api" },
            "codeRunner": { "endpoint": "https://runner.example/execute", "languages": ["python"] },
            "contributors": {
                "mira": { "name": "Mira Øster", "url": "/people/mira/", "orcid": "0000-0002-1825-0097" },
                "lantern": { "name": "Lantern <Team> & \"Friends\"", "url": "https://lantern.example/" },
                "jose": { "name": "José Ramírez" }
            }
        }"#,
    )
    .unwrap()
}

fn load(name: &str) -> (SiteConfig, Site) {
    let config = config();
    let contents = std::fs::read_to_string(format!("{FIXTURES}/{name}.md"))
        .unwrap()
        .replace("\r\n", "\n");
    let credits = std::fs::read_to_string(format!("{FIXTURES}/{name}.credits.json"))
        .map(|contents| SourceFile {
            path: format!("posts/{name}.credits.json"),
            contents,
        })
        .into_iter()
        .collect();
    let site = Site::load(
        config.clone(),
        Sources {
            posts: vec![SourceFile {
                path: format!("posts/{name}.md"),
                contents,
            }],
            credits,
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_or_else(|errors| panic!("{name}: {errors:?}"));
    (config, site)
}

fn portable(name: &str) -> (String, Site) {
    let (config, site) = load(name);
    let html = PortableProjection::from_post(&site.posts[0], &config)
        .unwrap()
        .portable_html()
        .unwrap_or_else(|error| panic!("{name}: {error}"))
        .html;
    (html, site)
}

/// Start and end tags in source order: `(name, attributes, closing)`. Text is
/// escaped by the renderer, so every `<` here opens markup.
fn tags(html: &str) -> Vec<(String, String, bool)> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        rest = &rest[start + 1..];
        let end = rest.find('>').expect("unterminated tag");
        let tag = &rest[..end];
        rest = &rest[end + 1..];
        let (closing, tag) = match tag.strip_prefix('/') {
            Some(tag) => (true, tag),
            None => (false, tag),
        };
        let name_end = tag
            .find(|c: char| c.is_whitespace() || c == '/')
            .unwrap_or(tag.len());
        out.push((
            tag[..name_end].to_ascii_lowercase(),
            tag[name_end..].to_string(),
            closing,
        ));
    }
    out
}

fn attribute<'a>(attributes: &'a str, name: &str) -> Option<&'a str> {
    let at = attributes.find(&format!(" {name}=\""))?;
    let value = &attributes[at + name.len() + 3..];
    value.split('"').next()
}

fn text_without_tags(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

/// Static checks a no-JavaScript or no-stylesheet reader depends on. Print is
/// covered by `quiz_answers_are_visible_without_disclosure_on_screen_and_in_print`.
fn assert_static_and_accessible(name: &str, html: &str) {
    let tags = tags(html);
    let mut stack: Vec<&str> = Vec::new();
    let mut ids = HashSet::new();
    let mut fragments = Vec::new();
    for (index, (tag, attributes, closing)) in tags.iter().enumerate() {
        assert!(
            !tag.starts_with("ob-")
                && ![
                    "script", "iframe", "input", "button", "form", "textarea", "select", "dialog",
                    "template", "style", "link", "object", "embed",
                ]
                .contains(&tag.as_str()),
            "{name}: runtime-only element <{tag}>"
        );
        for runtime in [
            " hidden",
            " style=",
            "aria-hidden",
            "data-correct",
            "data-key",
            "data-endpoint",
            "data-runnable",
        ] {
            assert!(
                !attributes.contains(runtime),
                "{name}: <{tag}{attributes}> depends on {runtime}"
            );
        }
        assert!(
            !attributes
                .split_whitespace()
                .any(|attribute| attribute.starts_with("on")),
            "{name}: event handler on <{tag}{attributes}>"
        );
        if *closing {
            assert_eq!(
                stack.pop(),
                Some(tag.as_str()),
                "{name}: unbalanced </{tag}>"
            );
            continue;
        }
        if !VOID.contains(&tag.as_str()) {
            stack.push(tag);
        }
        if let Some(id) = attribute(attributes, "id") {
            assert!(ids.insert(id.to_string()), "{name}: duplicate id {id}");
        }
        for url in ["href", "src"]
            .iter()
            .filter_map(|name| attribute(attributes, name))
        {
            assert!(
                url.starts_with("https://"),
                "{name}: relative or unsafe URL {url}"
            );
            if let Some(fragment) = url
                .strip_prefix(CANONICAL_BASE)
                .and_then(|path| path.split_once('#'))
                .map(|(_, fragment)| fragment)
            {
                fragments.push(fragment.to_string());
            }
        }
        match tag.as_str() {
            "img" => assert!(
                attribute(attributes, "alt").is_some_and(|alt| !alt.trim().is_empty()),
                "{name}: image without alternative text"
            ),
            "a" if attribute(attributes, "aria-label").is_none() => {
                let start = html
                    .match_indices("<a ")
                    .nth(
                        tags[..index]
                            .iter()
                            .filter(|(t, _, c)| t == "a" && !c)
                            .count(),
                    )
                    .unwrap()
                    .0;
                let end = start + html[start..].find("</a>").unwrap();
                assert!(
                    !text_without_tags(&html[start..end]).trim().is_empty(),
                    "{name}: link without an accessible name"
                );
            }
            "details" => assert_eq!(
                tags.get(index + 1).map(|(tag, _, _)| tag.as_str()),
                Some("summary"),
                "{name}: disclosure without a summary"
            ),
            _ => {}
        }
    }
    assert!(stack.is_empty(), "{name}: unclosed {stack:?}");
    let (_, site) = load(name);
    let native = openblog_core::render::generate_document(
        &site,
        &openblog_core::theme::ThemeSet::new(),
        &format!("posts/{name}.md"),
    )
    .unwrap();
    for fragment in fragments {
        assert!(
            ids.contains(&fragment) || native.contents.contains(&format!("id=\"{fragment}\"")),
            "{name}: anchor #{fragment} has no target"
        );
    }
    for private in ["engage.example", "runner.example"] {
        assert!(!html.contains(private), "{name}: leaked {private}");
    }
}

fn assert_golden(name: &str, html: &str) {
    let path = format!("{FIXTURES}/{name}.html");
    if std::env::var_os("OPENBLOG_UPDATE_GOLDEN").is_some() {
        std::fs::write(&path, html).unwrap();
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{name}: missing golden file {path}"))
        .replace("\r\n", "\n");
    assert_eq!(html, expected, "{name}: portable HTML differs from {path}");
}

#[test]
fn current_markdown_fallbacks_match_reviewed_golden_artifacts() {
    use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag};

    for name in ["video-lesson", "recipe", "research", "hostile-html"] {
        let (config, site) = load(name);
        let post = &site.posts[0];
        let authored = post.authored_markdown().to_string();
        let native = post.html.clone();
        let projection = PortableProjection::from_post(post, &config).unwrap();
        let markdown = projection.portable_markdown().unwrap();
        let path = format!("{FIXTURES}/{name}.portable.md");
        if std::env::var_os("OPENBLOG_UPDATE_GOLDEN").is_some() {
            std::fs::write(&path, &markdown).unwrap();
        }
        let expected = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{name}: missing Markdown golden: {error}"))
            .replace("\r\n", "\n");
        assert_eq!(markdown, expected, "{name}: Markdown golden changed");
        assert_eq!(markdown, projection.portable_markdown().unwrap());
        let events = Parser::new_ext(&markdown, Options::empty()).collect::<Vec<_>>();
        for event in &events {
            match event {
                Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) => {
                    assert!(!info.contains("runnable"), "{name}: {info}");
                    assert_ne!(info.as_ref(), "quiz");
                }
                Event::Html(html) | Event::InlineHtml(html) => {
                    panic!("{name}: active HTML in Markdown artifact: {html}");
                }
                _ => {}
            }
        }
        let mut html = String::new();
        pulldown_cmark::html::push_html(&mut html, events.into_iter());
        assert!(!html.contains("<script"));
        assert!(!html.contains("<ob-"));
        assert!(!html.contains("<iframe"));
        for private in ["engage.example", "runner.example", "Private: ask Dana"] {
            assert!(!markdown.contains(private), "{name}: leaked {private}");
        }
        assert_eq!(post.authored_markdown(), authored);
        assert_eq!(post.html, native);
        match name {
            "video-lesson" => {
                for fact in [
                    "00:00 The gate opens",
                    "1:02:03 Into the ruin",
                    "Native disclosure works without JavaScript",
                    "Zürich",
                    "cargo run --release",
                    "**HTML**",
                    "**CSS**",
                    "**JavaScript**",
                    "Try it on the canonical article",
                    "https://codepen.io/team/acme/pen/xyz",
                    "The café gate",
                    "**Answer:** 2.",
                    "**Answer:** 1. No",
                    "Join the discussion on the canonical article",
                ] {
                    assert!(markdown.contains(fact), "{name}: missing {fact}");
                }
            }
            "recipe" => {
                for fact in [
                    "**Tip:**",
                    "**Warning:**",
                    "2 cups *tomatoes*",
                    "Toss with the sauce.",
                    "**Answer:** 2. At the end",
                    "Prep: 10 min",
                    "Cook: 10-15 min",
                    "Serves: 4",
                    "Read the discussion on the canonical article",
                ] {
                    assert!(markdown.contains(fact), "{name}: missing {fact}");
                }
            }
            "research" => {
                for fact in [
                    "Mira Øster",
                    "José Ramírez",
                    "Author, Investigation",
                    "Translator",
                    "(unauthenticated)",
                    "10.5555/zürich.bridges/2026",
                    "https://creativecommons.org/licenses/by/4.0/",
                    "https://journal.example/bridges?lang=de&v=2",
                    "date uncertain",
                    "https://archive.example/annals?folio=12v#line-4",
                    "https://doi.org/10.1000/survey.42#page=42",
                    "print edition only",
                    "the year is written over an erasure",
                ] {
                    assert!(markdown.contains(fact), "{name}: missing {fact}");
                }
                assert!(!markdown.contains("Reviewer 2"));
                let references = markdown
                    .split("## References")
                    .nth(1)
                    .unwrap()
                    .split("## Contributions")
                    .next()
                    .unwrap();
                for credit in ["Mira", "Lantern", "José", "orcid"] {
                    assert!(!references.contains(credit), "{credit} in references");
                }
                assert_eq!(markdown.matches("[^annals]").count(), 3);
            }
            _ => {
                assert!(markdown.contains("Portable export note"));
                assert!(markdown.contains("A hand-written custom element keeps its text."));
                assert!(!markdown.contains("Join the discussion"));
            }
        }
    }
}

#[test]
fn semantic_loss_analysis_detects_mutated_facts_in_every_portable_representation() {
    use openblog_core::portability::{DiagnosticSeverity, RepresentationFormat};
    for (name, mutations) in [
        (
            "video-lesson",
            vec![
                (
                    "Native disclosure works without JavaScript",
                    "knowledge-check",
                ),
                ("Yes", "knowledge-check"),
                ("cargo run --release", "runnable-code"),
                ("button { color: red; }", "web-sandbox"),
                ("00:14", "content"),
                ("The café gate", "content"),
                ("dQw4w9WgXcQ", "video"),
            ],
        ),
        (
            "research",
            vec![
                ("José Ramírez", "credits"),
                ("Investigation", "credits"),
                ("unauthenticated", "credits"),
                ("https://lantern.example/", "credits"),
                ("10.5555/zürich.bridges/2026", "research"),
                ("https://creativecommons.org/licenses/by/4.0/", "research"),
                ("https://archive.example/annals?folio=12v#line-4", "content"),
                ("date uncertain", "content"),
            ],
        ),
        ("recipe", vec![("10 min", "recipe"), ("2 bowls", "recipe")]),
    ] {
        let (config, site) = load(name);
        let post = &site.posts[0];
        let source = post.authored_markdown().to_string();
        let native = post.html.clone();
        let projection = PortableProjection::from_post(post, &config).unwrap();
        for (format, artifact) in [
            (
                RepresentationFormat::Html,
                projection.portable_html().unwrap().html,
            ),
            (
                RepresentationFormat::Markdown,
                projection.portable_markdown().unwrap(),
            ),
            (
                RepresentationFormat::Text,
                projection.portable_text().unwrap(),
            ),
        ] {
            assert!(projection
                .analyze_portable_artifact(format, &artifact)
                .unwrap()
                .is_empty());
            for (value, capability) in &mutations {
                let encoded = openblog_core::escape::attr(value);
                let mutated = artifact
                    .replace(value, "REMOVED")
                    .replace(&encoded, "REMOVED");
                assert_ne!(artifact, mutated, "{name}: mutation did not reach {value}");
                let findings = projection
                    .analyze_portable_artifact(format, &mutated)
                    .unwrap();
                assert!(
                    findings.iter().any(|finding| {
                        finding.code == "missing-semantic-fact"
                            && finding.severity == DiagnosticSeverity::Error
                            && finding.capability_id.as_deref() == Some(*capability)
                            && finding.source_path == post.source
                            && finding.context.representation.is_some()
                    }),
                    "{name} {format:?} {value}: {findings:?}"
                );
            }
            if name == "video-lesson" {
                let mutated = artifact
                    .replace("Answer: A. No", "Answer: A. WRONG")
                    .replace("Answer: 1. No", "Answer: 1. WRONG")
                    .replace("**Answer:** 1. No", "**Answer:** 1. WRONG");
                assert_ne!(artifact, mutated);
                assert!(projection.analyze_portable_artifact(format, &mutated).unwrap().iter().any(|finding|
                    finding.capability_id.as_deref() == Some("knowledge-check")
                        && finding.context.affected_semantics.as_deref() == Some("answer")
                ), "an answer still present among the choices must not hide a missing designated answer");
            }
        }
        assert_eq!(post.authored_markdown(), source);
        assert_eq!(post.html, native);
    }
}

#[test]
fn video_lesson_fallbacks_match_the_golden_output() {
    let (html, site) = portable("video-lesson");
    assert_golden("video-lesson", &html);
    assert_static_and_accessible("video-lesson", &html);

    let visible = text_without_tags(&html);
    for essential in [
        "Gate of Embers — a lesson on YouTube",
        "A warning &amp; a &lt;script&gt; in the dark",
        "Into the ruin — Ünter",
        "Which tag opens a disclosure without &lt;script&gt;?",
        "&lt;dialog onclick=\"alert(1)\"&gt;",
        "Answer: B. &lt;details&gt;",
        "Native disclosure works without JavaScript — even in Zürich.",
        "Answer: A. No",
        "&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
        "&lt;button onclick=&quot;alert(1)&quot;&gt;Hi&lt;/button&gt;",
        "print(&quot;runs on the canonical page&quot;)",
        "A pen about gates &lt;3 (See the Pen on CodePen)",
        "Join the discussion on the original article",
        "Season 1, episode 3",
        "Writing by Mira &amp; &lt;Lantern&gt; Team",
        "cargo run --release",
    ] {
        assert!(
            visible.contains(essential),
            "missing {essential:?}:\n{html}"
        );
    }
    assert!(
        html.contains(
            "<code class=\"language-python\" data-line-numbers=\"true\" data-highlight-lines=\"1\">"
        ),
        "runnable fences keep their line options:\n{html}"
    );
    // The native page shows the AI disclosure only as structured data, so the
    // portable body adds no visible copy of it either.
    assert!(!site.posts[0].html.contains("AI-assisted animation"));
    assert!(!html.contains("AI-assisted animation"));

    // The same post's native page keeps its interactive markup.
    let native = &site.posts[0].html;
    for interactive in ["<ob-quiz", "<ob-code-runner", "<ob-web-sandbox>", "<iframe"] {
        assert!(native.contains(interactive), "native lost {interactive}");
    }
}

#[test]
fn quiz_answers_are_visible_without_disclosure_on_screen_and_in_print() {
    let (html, _) = portable("video-lesson");
    assert!(!html.contains("<details"), "{html}");
    for answer in ["Answer: B.", "Answer: A. No"] {
        let at = html.find(answer).expect(answer);
        let opened = html[..at]
            .rfind("<div class=\"ob-quiz-answer\">")
            .expect("answer outside a visible answer block");
        assert!(
            !html[opened..at].contains("</div>"),
            "{answer} must sit inside its visible answer block"
        );
        assert!(html[..opened].ends_with("</ol>\n"));
    }
}

#[test]
fn recipe_fallbacks_match_the_golden_output() {
    let (html, site) = portable("recipe");
    assert_golden("recipe", &html);
    assert_static_and_accessible("recipe", &html);
    let visible = text_without_tags(&html);
    for essential in [
        "2 cups tomatoes",
        "Toss with the sauce.",
        "When do you add the basil?",
        "Answer: B. At the end",
        "Comments are closed.",
        "Prep10 min",
        "Cook10-15 min",
        "Serves4",
        "Makes2 bowls",
        "CuisineAndalusian &amp; &lt;Italian&gt;",
    ] {
        assert!(
            visible.contains(essential),
            "missing {essential:?}:\n{html}"
        );
    }
    assert_eq!(site.posts[0].recipe.as_ref().unwrap().steps.len(), 2);
}

#[test]
fn research_attribution_and_references_match_the_golden_output() {
    let (config, site) = load("research");
    let post = &site.posts[0];
    let projection = PortableProjection::from_post(post, &config).unwrap();
    let output = projection.portable_html().unwrap();
    let html = &output.html;
    assert_golden("research", html);
    assert_static_and_accessible("research", html);

    let visible = text_without_tags(html);
    for essential in [
        // Ordered attribution with roles, kept apart from the references.
        "Mira ØsterAuthor, Investigation",
        "Lantern &lt;Team&gt; &amp; &quot;Friends&quot;Author",
        "José RamírezTranslator",
        "https://orcid.org/0000-0002-1825-0097 (unauthenticated)",
        // Work identity, reuse terms, and provenance.
        "DOI10.5555/zürich.bridges/2026",
        "ReuseLicense",
        "Originally published at journal.example/bridges?lang=de&amp;v=2.",
        // Citations, precise locations, and stated uncertainty survive.
        "c. 1350 (date uncertain)",
        "Stadtarchiv Zürich, Annals, fol. 12v",
        "Survey of bridges, p. 42",
        "Hoffmann, Brücken, print edition only (no stable link).",
        "Annals, fol. 12v, line 4 — the year is written over an erasure.",
    ] {
        assert!(
            visible.contains(essential),
            "missing {essential:?}:\n{html}"
        );
    }
    for exact in [
        "href=\"https://archive.example/annals?folio=12v#line-4\"",
        "href=\"https://doi.org/10.1000/survey.42#page=42\"",
        "href=\"https://doi.org/10.5555/z%C3%BCrich.bridges%2F2026\"",
        "href=\"https://example.test/blog/archive/z%C3%BCrich-1480/\"",
        "href=\"https://example.test/blog/people/mira/\"",
    ] {
        assert!(html.contains(exact), "missing {exact}:\n{html}");
    }
    // The repeated citation keeps one note number and identity.
    assert_eq!(
        html.matches("<a href=\"https://example.test/blog/research/#annals\">1</a>")
            .count(),
        2,
        "{html}"
    );
    // Credits are attribution, never bibliography.
    let references = html.split("<h2 id=\"references\">").nth(1).unwrap();
    for credit in ["Mira", "Lantern", "José", "orcid"] {
        assert!(!references.contains(credit), "{credit} in references");
    }
    assert_eq!(
        projection
            .references()
            .iter()
            .map(|reference| (reference.label.as_str(), reference.line))
            .collect::<Vec<_>>(),
        [
            ("Stadtarchiv Zürich, Annals, fol. 12v", 23),
            ("Survey of bridges, p. 42", 24)
        ]
    );
    assert_eq!(
        projection
            .authors()
            .map(|credit| credit.contributor_id.as_str())
            .collect::<Vec<_>>(),
        ["mira", "lantern"]
    );
    // The Markdown representation keeps the authored citation markers.
    assert!(projection
        .representation(openblog_core::portability::RepresentationFormat::Markdown)
        .contains("[^annals]"));
    // Unknown front matter stays in the canonical source, never in the copy.
    let source = std::fs::read_to_string(format!("{FIXTURES}/research.md"))
        .unwrap()
        .replace("\r\n", "\n");
    let canonical = openblog_core::frontmatter::parse(&source).unwrap();
    assert_eq!(
        canonical.front_matter.get("privateNote"),
        Some("Reviewer 2 is <script>alert(\"leak\")</script> — do not publish")
    );
    for private in ["privateNote", "Reviewer 2", "leak", "<script"] {
        assert!(!html.contains(private), "leaked {private}:\n{html}");
    }
    assert!(output.capabilities.is_empty(), "{:?}", output.capabilities);
    assert_eq!(projection.portable_html().unwrap(), output);

    // The native page keeps its own byline, icon, and relative note anchors.
    assert!(post.html.contains("<a href=\"#annals\">1</a>"));
    assert!(!post.html.contains("ob-contributions"));
}

#[test]
fn hostile_raw_html_follows_the_portable_policy_and_matches_the_golden_output() {
    let (config, site) = load("hostile-html");
    let post = &site.posts[0];
    let output = PortableProjection::from_post(post, &config)
        .unwrap()
        .portable_html()
        .unwrap();
    let html = &output.html;
    assert_golden("hostile-html", html);
    assert_static_and_accessible("hostile-html", html);

    let visible = text_without_tags(html);
    for essential in [
        "keeps its HTML, its",
        "Ctrl+K shortcuts",
        "event handlers and",
        "link targets go. Inline\ncode in  tags is dropped.",
        "The gate plan, from the Stadtarchiv Zürich.",
        "The annals mention the gate twice.",
        "Box 12, folder 3 holds the original survey.",
        "Bridge built (uncertain)",
        "Embedded frame (Gate of Embers trailer): see it on the original article.",
        "Illustration (Bridge outline): see it on the original article.",
        "Email",
        "Unclosed bold and italic",
        "A hand-written custom element keeps its text.",
    ] {
        assert!(
            visible.contains(essential),
            "missing {essential:?}:\n{html}"
        );
    }
    for exact in [
        "<a href=\"https://example.test/blog/glossary/\">relative links</a>",
        "<img loading=\"lazy\" decoding=\"async\" src=\"https://example.test/blog/hostile-html/images/gate-plan.png\"",
        "<q cite=\"https://example.test/blog/sources/annals/\">",
        "<a id=\"archive-anchor\">",
        "<a href=\"https://partner.example/\" rel=\"noopener\">",
        "<b>bold and <i>italic</i></b></p></div>",
    ] {
        assert!(html.contains(exact), "missing {exact}:\n{html}");
    }
    // Comments may hold private notes; hostile and tracking markup never leaves.
    for leaked in [
        "Dana",
        "Private",
        "evil.example",
        "tracker.example",
        "steal",
        "javascript:",
        "srcset",
        "target=",
        "allowfullscreen",
        "data-correct",
    ] {
        assert!(!html.contains(leaked), "leaked {leaked}:\n{html}");
    }
    let report = output
        .capabilities
        .iter()
        .find(|capability| capability.id == "raw-html")
        .expect("the removed markup is reported");
    assert_eq!(
        report
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.message.as_str())
            .collect::<Vec<_>>(),
        [
            "Removed with their content: <script>, <button>, <style>, <noscript>.",
            "Removed: <base>, <meta>, <input>.",
            "Kept the content but removed the tags: <form>, <label>, <ob-quiz>.",
            "Replaced with a link to the original article: <iframe>, <svg>.",
            "Removed attributes: event handlers, target, srcset, style.",
            "Removed 1 duplicate, reserved, or invalid id.",
        ]
    );

    // The native page keeps the authored markup, as it always has.
    for native in [
        "<script>steal(document.cookie)</script>",
        "onclick=\"steal()\"",
        "<iframe",
    ] {
        assert!(post.html.contains(native), "native lost {native}");
    }
}

#[test]
fn portable_fallbacks_are_deterministic_and_leave_the_source_untouched() {
    for name in ["video-lesson", "recipe"] {
        let (config, site) = load(name);
        let post = &site.posts[0];
        let native = post.html.clone();
        let projection = PortableProjection::from_post(post, &config).unwrap();
        let first = projection.portable_html().unwrap();
        assert_eq!(projection.portable_html().unwrap(), first, "{name}");
        assert_eq!(post.html, native, "{name}");
        assert!(projection
            .representation(openblog_core::portability::RepresentationFormat::Markdown)
            .contains("```quiz"));
    }
}

#[test]
fn static_checks_reject_the_native_interactive_markup() {
    let (_, site) = load("video-lesson");
    let native = site.posts[0].html.clone();
    let rejected = std::panic::catch_unwind(|| assert_static_and_accessible("native", &native));
    assert!(
        rejected.is_err(),
        "the no-JavaScript checks must detect runtime markup"
    );
}
