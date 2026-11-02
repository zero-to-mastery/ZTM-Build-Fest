//! Author-approved supplements and reading modes (ADRs 0140 and 0141): the
//! marker grammar, nesting, unknown kinds, hand-written Markdown, the
//! standard-mode byte-for-byte guarantee, mode invariants, escaping, and the
//! portable and no-JavaScript representations.

use std::collections::{BTreeMap, HashSet};

use openblog_core::markdown::{render, RenderOptions};
use openblog_core::portability::PortableProjection;
use openblog_core::reading_depth::{scan, Depth, Kind, ReadingMode, MAX_NESTING, MAX_SUPPLEMENTS};
use openblog_core::source_library::SourceLibrary;
use openblog_core::{model, SiteConfig, SourceFile};

const ARTICLE: &str = "# Title\n\nThe argument begins here.[^n]\n\n\
> [!supplement kind=definition level=guided] Aporia\n> A state of puzzlement.\n\n\
The argument goes on.\n\n\
> [!supplement kind=evidence level=deep-dive] The manuscripts\n> Three witnesses agree.\n>\n\
> > [!supplement kind=further-reading]\n> > Read the edition.\n\n\
> An ordinary quote stays a quote.\n\n\
[^n]: A footnote.\n";

fn on() -> RenderOptions<'static> {
    RenderOptions {
        supplements: true,
        ..RenderOptions::default()
    }
}

fn config() -> SiteConfig {
    SiteConfig::from_json(
        r#"{"title": "T", "url": "https://example.test", "author": {"name": "A"}}"#,
    )
    .unwrap()
}

fn post_source(front: &str, body: &str) -> SourceFile {
    SourceFile {
        path: "posts/p.md".into(),
        contents: format!("---\ntitle: P\ndate: 2026-10-20\n{front}---\n{body}"),
    }
}

#[test]
fn modes_show_supplements_cumulatively_and_standard_shows_none() {
    assert!(!ReadingMode::Standard.shows(Depth::Guided));
    assert!(!ReadingMode::Standard.shows(Depth::DeepDive));
    assert!(ReadingMode::Guided.shows(Depth::Guided));
    assert!(!ReadingMode::Guided.shows(Depth::DeepDive));
    assert!(ReadingMode::DeepDive.shows(Depth::Guided));
    assert!(ReadingMode::DeepDive.shows(Depth::DeepDive));
    assert_eq!(ReadingMode::parse("deep-dive"), Some(ReadingMode::DeepDive));
    assert_eq!(ReadingMode::parse("deep"), None);
    assert_eq!(ReadingMode::parse("Guided"), None);
}

#[test]
fn nested_supplements_are_read_in_order_with_parents_and_effective_depth() {
    let depth = scan(ARTICLE);
    assert!(depth.findings.is_empty(), "{:?}", depth.findings);
    let ids: Vec<_> = depth.supplements.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(
        ids,
        ["ob-supplement-1", "ob-supplement-2", "ob-supplement-3"]
    );
    let [definition, evidence, reading] = &depth.supplements[..] else {
        panic!()
    };
    assert_eq!(definition.kind, Kind::Definition);
    assert_eq!(definition.title.as_deref(), Some("Aporia"));
    assert_eq!(evidence.depth, Depth::DeepDive);
    assert_eq!(reading.parent.as_deref(), Some("ob-supplement-2"));
    assert!(reading.depth_defaulted);
    assert_eq!(reading.effective_depth, Depth::DeepDive);
    assert_eq!(reading.nesting, 2);
    let shown = |mode| {
        depth
            .visible(mode)
            .iter()
            .map(|s| s.id.clone())
            .collect::<Vec<_>>()
    };
    assert!(shown(ReadingMode::Standard).is_empty());
    assert_eq!(shown(ReadingMode::Guided), ["ob-supplement-1"]);
    assert_eq!(shown(ReadingMode::DeepDive).len(), 3);
}

#[test]
fn a_child_is_never_shown_without_its_parent() {
    let depth = scan(
        "> [!supplement kind=evidence level=deep-dive]\n> Deep.\n>\n> > [!supplement kind=definition level=guided]\n> > Short.\n",
    );
    let child = &depth.supplements[1];
    assert_eq!(child.depth, Depth::Guided);
    assert_eq!(child.effective_depth, Depth::DeepDive);
    assert_eq!(depth.findings.len(), 1);
    assert!(depth.visible(ReadingMode::Guided).is_empty());
}

#[test]
fn kinds_default_their_level_and_unknown_kinds_are_kept() {
    let depth = scan(
        "> [!supplement kind=context]\n> a\n\n> [!supplement kind=comparison]\n> b\n\n> [!supplement kind=marginalia-2]\n> c\n\n> [!supplement]\n> d\n",
    );
    let levels: Vec<_> = depth.supplements.iter().map(|s| s.depth).collect();
    assert_eq!(
        levels,
        [
            Depth::Guided,
            Depth::DeepDive,
            Depth::DeepDive,
            Depth::DeepDive
        ]
    );
    assert_eq!(depth.supplements[2].kind, Kind::Other);
    assert_eq!(depth.supplements[2].kind_token, "marginalia-2");
    assert_eq!(depth.supplements[3].kind_token, "supplement");
}

#[test]
fn hand_written_variants_read_tolerantly() {
    let depth = scan(
        "> [!SUPPLEMENT  Kind=Definition   LEVEL=GUIDED   future=x]   Spaced title  \n> body\n\n> [!supplement kind=context]Title no space\n> body\n\n> [!supplement kind=context]\n",
    );
    assert!(depth.findings.is_empty(), "{:?}", depth.findings);
    assert_eq!(depth.supplements.len(), 3);
    assert_eq!(depth.supplements[0].title.as_deref(), Some("Spaced title"));
    assert_eq!(
        depth.supplements[1].title.as_deref(),
        Some("Title no space")
    );
    assert_eq!(depth.supplements[2].title, None);
}

#[test]
fn a_marker_that_cannot_be_read_stays_a_quote_and_is_reported_alone() {
    for bad in [
        "> [!supplement kind=Bad_Kind]\n> body\n",
        "> [!supplement level=expert]\n> body\n",
        "> [!supplement kind=a kind=b]\n> body\n",
        "> [!supplement kind]\n> body\n",
        "> [!supplement kind=definition\n> body\n",
        "> [!supplement kind=definition] with *emphasis*\n> body\n",
    ] {
        let depth = scan(bad);
        assert!(depth.supplements.is_empty(), "{bad}");
        assert_eq!(depth.findings.len(), 1, "{bad}");
        let html = render(bad, on()).html;
        assert!(html.starts_with("<blockquote>"), "{bad}: {html}");
        assert!(html.contains("body"), "{bad}");
    }
    // A scoped failure: the readable marker next to the broken one still works.
    let depth = scan("> [!supplement kind=Bad_Kind]\n> x\n\n> [!supplement kind=context]\n> y\n");
    assert_eq!(depth.supplements.len(), 1);
    assert_eq!(depth.findings.len(), 1);
    // Not a marker at all: no finding.
    let depth = scan("> [!supplementary] words\n\n> [!NOTE]\n> n\n\n> plain\n");
    assert!(depth.supplements.is_empty() && depth.findings.is_empty());
}

#[test]
fn markers_in_code_are_not_supplements() {
    let depth = scan(
        "```\n> [!supplement kind=context]\n> x\n```\n\n    > [!supplement kind=context]\n\n`> [!supplement]`\n",
    );
    assert!(depth.supplements.is_empty() && depth.findings.is_empty());
}

#[test]
fn limits_leave_the_excess_as_quotes() {
    let mut deep = String::new();
    for level in 1..=MAX_NESTING + 1 {
        deep.push_str(&format!(
            "{}[!supplement kind=context]\n{}\n",
            "> ".repeat(level),
            "> ".repeat(level).trim_end()
        ));
    }
    let depth = scan(&deep);
    assert_eq!(depth.supplements.len(), MAX_NESTING);
    assert_eq!(depth.findings.len(), 1);

    let many = "> [!supplement kind=context]\n> x\n\n".repeat(MAX_SUPPLEMENTS + 5);
    let depth = scan(&many);
    assert_eq!(depth.supplements.len(), MAX_SUPPLEMENTS);
    assert_eq!(depth.findings.len(), 5);

    let huge = "x".repeat(2 * 1024 * 1024);
    assert!(scan(&huge).supplements.is_empty());
    assert_eq!(scan(&huge).findings.len(), 1);
}

#[test]
fn without_supplements_the_output_is_byte_for_byte_the_legacy_output() {
    let plain = "# Title\n\nWords [a link](https://example.test) here.\n\n> A quote.\n>\n> > Inner.\n\n> [!NOTE]\n> A note.\n\n- one\n- two\n\n## Next\n\nMore.\n";
    let legacy = render(plain, RenderOptions::default());
    let opted = render(plain, on());
    assert_eq!(legacy.html, opted.html);
    assert_eq!(legacy.text, opted.text);
    assert_eq!(legacy.prose, opted.prose);
    assert_eq!(legacy.word_count, opted.word_count);
    assert_eq!(legacy.capabilities, opted.capabilities);
    assert!(opted.reading_depth.unwrap().is_empty());
    assert!(legacy.reading_depth.is_none());
}

#[test]
fn a_post_that_has_not_opted_in_renders_its_markers_as_ordinary_quotes() {
    let rendered = render(ARTICLE, RenderOptions::default());
    assert!(!rendered.html.contains("ob-supplement"));
    assert!(rendered
        .html
        .contains("[!supplement kind=definition level=guided] Aporia"));
    assert!(rendered.capabilities.is_empty());
}

#[test]
fn supplements_are_labelled_groups_in_document_order_with_no_javascript() {
    let html = render(ARTICLE, on()).html;
    let first = html.find("id=\"ob-supplement-1\"").unwrap();
    let second = html.find("id=\"ob-supplement-2\"").unwrap();
    let third = html.find("id=\"ob-supplement-3\"").unwrap();
    assert!(first < second && second < third);
    // Complete without JavaScript: every supplement is visible static
    // content, with no `hidden` attribute written by the build.
    assert!(!html.contains("hidden"));
    assert!(html.contains("A state of puzzlement."));
    assert!(html.contains("Three witnesses agree."));
    assert!(html.contains("Read the edition."));
    assert!(html.contains("role=\"group\" aria-labelledby=\"ob-supplement-1-label\""));
    assert!(html.contains("<strong class=\"ob-supplement-kind\">Definition</strong> <span class=\"ob-supplement-level\">guided supplement</span> <span class=\"ob-supplement-title\">Aporia</span>"));
    assert!(html.contains("data-ob-kind=\"further-reading\" data-ob-level=\"deep-dive\""));
    // The marker text is replaced by the label, never shown twice.
    assert!(!html.contains("[!supplement"));
    // The ordinary quote is untouched.
    assert!(html.contains("<blockquote>\n<p>An ordinary quote stays a quote.</p>\n</blockquote>"));
    assert_eq!(html.matches("<div").count(), html.matches("</div>").count());
}

#[test]
fn the_canonical_argument_is_the_same_whatever_the_supplements() {
    let with = render(ARTICLE, on());
    let without = "# Title\n\nThe argument begins here.[^n]\n\nThe argument goes on.\n\n\
> An ordinary quote stays a quote.\n\n[^n]: A footnote.\n";
    let bare = render(without, on());
    // Supplements are not the post's own words.
    assert_eq!(with.prose, bare.prose);
    assert_eq!(with.word_count, bare.word_count);
    // Search still sees them.
    assert!(with.text.contains("A state of puzzlement."));
    assert_eq!(with.headings, bare.headings);
}

#[test]
fn headings_inside_supplements_are_real_headings_outside_the_outline() {
    let rendered = render(
        "## Plato\n\n> [!supplement kind=context]\n> ## Plato\n> text\n\n## Plato\n",
        on(),
    );
    // Not in the outline, and the post's own slugs are what they would be
    // without the supplement: the second "Plato" is `plato-2`, not `plato-3`.
    let ids: Vec<_> = rendered.headings.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(ids, ["plato", "plato-2"]);
    // Inside it stays a real heading with an anchor of its own.
    assert!(
        rendered
            .html
            .contains("<h2 id=\"ob-supplement-1-h1\">Plato</h2>"),
        "{}",
        rendered.html
    );
    assert!(!rendered.html.contains("ob-supplement-heading"));
    // A heading the author gave an id keeps it.
    let written = render("> [!supplement kind=context]\n> ### Deep {#mine}\n", on());
    assert!(written.html.contains("<h3 id=\"mine\">Deep</h3>"));
    assert!(written.headings.is_empty());
}

#[test]
fn hostile_titles_and_bodies_are_escaped() {
    let rendered = render(
        "> [!supplement kind=context] \\<img src=x onerror=alert(1)\\> \"q\" & \\<script\\>\n> body\n",
        on(),
    );
    assert!(!rendered.html.contains("<img"));
    assert!(!rendered.html.contains("<script"));
    assert!(rendered.html.contains("&lt;img src=x onerror=alert(1)&gt;"));
    assert!(rendered.html.contains("&amp;"));
}

#[test]
fn output_is_deterministic() {
    let a = render(ARTICLE, on());
    let b = render(ARTICLE, on());
    assert_eq!(a.html, b.html);
    assert_eq!(a.reading_depth, b.reading_depth);
    assert_eq!(scan(ARTICLE), scan(ARTICLE));
}

#[test]
fn a_post_opts_in_with_a_front_matter_key_and_reports_the_capability() {
    let config = config();
    let plain =
        model::load_post(&post_source("", ARTICLE), &config, config.render_options()).unwrap();
    assert!(plain.reading_depth().is_none());
    assert!(plain.capabilities.is_empty());
    assert!(!plain.html.contains("ob-supplement"));

    for key in ["readingModes: true\n", "reading_modes: yes\n"] {
        let post =
            model::load_post(&post_source(key, ARTICLE), &config, config.render_options()).unwrap();
        assert_eq!(post.reading_depth().unwrap().supplements.len(), 3);
        assert!(post
            .capabilities
            .iter()
            .any(|c| c.id == "guided-reading-supplements" && c.has_portable_fallback()));
        assert!(post.html.contains("id=\"ob-supplement-1\""));
    }
    // Opted in with no markers: the same HTML as a post that never opted in.
    let body = "Just words.\n\n> A quote.\n";
    let off = model::load_post(&post_source("", body), &config, config.render_options()).unwrap();
    let empty = model::load_post(
        &post_source("readingModes: true\n", body),
        &config,
        config.render_options(),
    )
    .unwrap();
    assert_eq!(off.html, empty.html);
    assert!(empty.capabilities.is_empty());
}

#[test]
fn portable_copies_keep_every_supplement_labelled_and_in_place() {
    let config = config();
    let post = model::load_post(
        &post_source("readingModes: true\n", ARTICLE),
        &config,
        config.render_options(),
    )
    .unwrap();
    let projection = PortableProjection::from_post(&post, &config).unwrap();
    let html = projection.portable_html().unwrap().html;
    for words in [
        "A state of puzzlement.",
        "Three witnesses agree.",
        "Read the edition.",
    ] {
        assert!(html.contains(words), "{words}: {html}");
    }
    assert!(html.contains("Definition"), "{html}");
    assert!(!html.contains("hidden"));
    assert!(!html.contains("Guided explanations"), "{html}");
    let markdown = projection.portable_markdown().unwrap();
    // The marker line is a readable quote in any Markdown reader.
    assert!(
        markdown.contains("[!supplement kind=definition level=guided]"),
        "{markdown}"
    );
    assert!(markdown.contains("A state of puzzlement."));
    let text = projection.portable_text().unwrap();
    assert!(text.contains("A state of puzzlement."));
}

#[test]
fn citations_inside_supplements_keep_the_posts_one_reference_list() {
    let library = SourceLibrary::parse(
        r#"{"version": 1, "sources": [
            {"id": "plato", "kind": "work", "title": "Politeia", "creators": [{"name": "Plato", "role": "author"}]},
            {"id": "slings", "kind": "work", "title": "Slings"}]}"#,
        &BTreeMap::new(),
    )
    .unwrap();
    let config = config();
    let with = post_source(
        "readingModes: true\ncitations: notes\n",
        "Argument [@plato].\n\n> [!supplement kind=evidence]\n> More in [@slings].\n",
    );
    let post =
        model::load_post_cited(&with, &config, config.render_options(), Some(&library)).unwrap();
    // Both references are published whatever the mode, in citation order.
    let summary = post.citations().unwrap();
    assert_eq!(summary.references.len(), 2);
    assert!(post.html.contains("Politeia") && post.html.contains("Slings"));
}

#[test]
fn a_heading_slug_never_takes_the_supplements_reserved_names() {
    let rendered = render(
        "## Ob supplement 1\n\n> [!supplement kind=context]\n> x\n",
        on(),
    );
    assert_eq!(rendered.headings[0].id, "section-ob-supplement-1");
    assert_eq!(rendered.html.matches("id=\"ob-supplement-1\"").count(), 1);
}

const PLATO_LIBRARY: &str = r#"{"version": 1, "sources": [
    {"id": "plato", "kind": "work", "title": "Politeia", "creators": [{"name": "Plato", "role": "author"}]},
    {"id": "slings", "kind": "work", "title": "Slings"}]}"#;

fn cited(body: &str) -> openblog_core::Post {
    let library = SourceLibrary::parse(PLATO_LIBRARY, &BTreeMap::new()).unwrap();
    let config = config();
    model::load_post_cited(
        &post_source("readingModes: true\ncitations: notes\n", body),
        &config,
        config.render_options(),
        Some(&library),
    )
    .unwrap()
}

#[test]
fn a_citation_marker_trimmed_inside_a_supplement_does_not_break_the_posts_own_text() {
    // The panic: the marker's gap is trimmed from the text, so byte ranges
    // recorded before the trim no longer fell on character boundaries.
    for quoted in [
        "> As he wrote, \u{201c}justice [@plato]\u{201d} matters.",
        "> As he wrote, \"justice [@plato]\" matters.",
        "> As he wrote, justice [@plato], matters.",
        "> As he wrote, caf\u{e9} \u{2014} justice [@plato]. Matters.",
    ] {
        let post = cited(&format!(
            "Before.\n\n> [!supplement kind=evidence]\n{quoted}\n\nAfter [@slings].\n"
        ));
        let bare = cited("Before.\n\nAfter [@slings].\n");
        // The supplement is not the post's own words, whatever it holds.
        assert_eq!(post.word_count, bare.word_count, "{quoted}");
        assert_eq!(post.description, bare.description, "{quoted}");
        assert!(post.description.starts_with("Before. After"), "{quoted}");
        assert!(!post.description.contains("justice"), "{quoted}");
        // Search still sees them, with the marker gap trimmed as everywhere.
        assert!(post.text.contains("As he wrote"), "{quoted}");
        assert!(
            !post.text.contains(" ,") && !post.text.contains(" \u{201d}"),
            "{quoted}: {}",
            post.text
        );
    }
}

#[test]
fn supplement_words_stay_aligned_when_a_citation_precedes_and_follows_one() {
    let post = cited(
        "Claim [@plato]. More.\n\n> [!supplement kind=context]\n> Inside [@slings], and \u{201c}more\u{201d} [@plato].\n\nEnd [@plato].\n",
    );
    assert_eq!(post.description, "Claim. More. End.");
    assert_eq!(post.word_count, 3);
}

#[test]
fn lists_inside_a_supplement_are_not_the_recipes_ingredients_or_steps() {
    let markdown = "## Ingredients\n\n- 1 cup flour\n- 2 eggs\n\n\
> [!supplement kind=context] Notes\n> - a list in a supplement\n> - another\n>\n> 1. numbered in a supplement\n\n\
## Steps\n\n1. Mix.\n2. Bake.\n\n\
> [!supplement kind=evidence]\n> 1. A history of baking.\n";
    let rendered = render(
        markdown,
        RenderOptions {
            recipe: true,
            supplements: true,
            ..RenderOptions::default()
        },
    );
    assert_eq!(rendered.recipe_ingredients, ["1 cup flour", "2 eggs"]);
    assert_eq!(rendered.recipe_steps, ["Mix.", "Bake."]);
    // The supplements are still there, whole, and balanced with the sections.
    assert!(rendered.html.contains("a list in a supplement"));
    assert!(rendered.html.contains("A history of baking."));
    assert_eq!(
        rendered.html.matches("<section").count(),
        rendered.html.matches("</section>").count()
    );
}

#[test]
fn a_supplement_has_a_visible_boundary_in_every_representation() {
    let html = render(ARTICLE, on()).html;
    // A quote inside the labelled group, then an end marker that needs no CSS.
    assert!(
        html.contains("</p>\n<blockquote>\n<p>A state of puzzlement.</p>\n</blockquote>\n<p class=\"ob-supplement-end\"><strong>End of definition supplement.</strong></p>\n</div>"),
        "{html}"
    );
    assert!(html.contains("End of further reading supplement."));
    assert!(html.contains("End of evidence supplement."));
    let config = config();
    let post = model::load_post(
        &post_source("readingModes: true\n", ARTICLE),
        &config,
        config.render_options(),
    )
    .unwrap();
    // The text view (search, plain text, JSON Feed `content_text`).
    let start = post
        .text
        .find("Definition supplement (guided): Aporia.")
        .unwrap();
    let words = post.text.find("A state of puzzlement.").unwrap();
    let end = post.text.find("End of definition supplement.").unwrap();
    assert!(start < words && words < end, "{}", post.text);
    let projection = PortableProjection::from_post(&post, &config).unwrap();
    let text = projection.portable_text().unwrap();
    assert!(text.contains("End of definition supplement."), "{text}");
    let portable = projection.portable_html().unwrap().html;
    assert!(portable.contains("<strong>End of definition supplement.</strong>"));
    assert!(portable.contains("<blockquote>"));
    // Titles are searchable but are not the post's prose.
    assert!(post.text.contains("Aporia"));
    assert!(!post.description.contains("Aporia"));
}

#[test]
fn findings_are_surfaced_with_the_post_path_in_the_sites_warnings() {
    let load = |body: &str| {
        model::Site::load(
            config(),
            openblog_core::Sources {
                posts: vec![post_source("readingModes: true\n", body)],
                ..Default::default()
            },
            openblog_core::LoadOptions::default(),
        )
        .unwrap()
    };
    let site = load("> [!supplement kind=Bad_Kind]\n> x\n\n> [!supplement kind=context]\n> fine\n");
    let warning = site
        .warnings
        .iter()
        .find(|warning| warning.contains("reading modes"))
        .unwrap_or_else(|| panic!("{:?}", site.warnings));
    assert!(warning.starts_with("posts/p.md: "), "{warning}");
    assert!(warning.contains("[!supplement kind=Bad_Kind]"), "{warning}");
    assert!(warning.contains("shown as a block quote"), "{warning}");
    // Nothing of the quote's body is in the warning.
    assert!(!warning.contains("fine"));
    // A site with nothing to report has no such warning.
    let quiet = load("> [!supplement kind=context]\n> fine\n");
    assert!(!quiet.warnings.iter().any(|w| w.contains("reading modes")));
}

#[test]
fn an_over_long_title_or_kind_is_reported_with_its_own_message_and_stays_a_quote() {
    let title = format!("> [!supplement kind=context] {}\n> body\n", "t".repeat(121));
    let depth = scan(&title);
    assert!(depth.supplements.is_empty());
    assert_eq!(depth.findings.len(), 1);
    assert!(depth.findings[0]
        .message
        .contains("title is longer than 120"));
    assert!(render(&title, on()).html.starts_with("<blockquote>"));
    // The full title is allowed at the limit.
    let at_limit = scan(&format!(
        "> [!supplement kind=context] {}\n> body\n",
        "t".repeat(120)
    ));
    assert_eq!(at_limit.supplements[0].title.as_deref().unwrap().len(), 120);
    let kind = scan(&format!(
        "> [!supplement kind={}]\n> body\n",
        "k".repeat(33)
    ));
    assert!(kind.findings[0].message.contains("kind is longer than 32"));
    let bad = scan("> [!supplement kind=Bad_Kind]\n> body\n");
    assert!(bad.findings[0].message.contains("lowercase word"));
}

#[test]
fn only_a_written_level_that_a_parent_overrides_is_reported() {
    let written = scan(
        "> [!supplement kind=evidence level=deep-dive]\n> a\n>\n> > [!supplement kind=definition level=guided]\n> > b\n",
    );
    assert_eq!(written.findings.len(), 1);
    let defaulted = scan(
        "> [!supplement kind=evidence level=deep-dive]\n> a\n>\n> > [!supplement kind=definition]\n> > b\n",
    );
    assert!(defaulted.findings.is_empty(), "{:?}", defaulted.findings);
    assert_eq!(defaulted.supplements[1].effective_depth, Depth::DeepDive);
}

#[test]
fn an_escaped_marker_is_an_ordinary_quote() {
    let slash = char::from(92u8);
    for escaped in [
        format!("> {slash}[!supplement kind=context] Title\n> body\n"),
        format!("> {slash}[!SUPPLEMENT]\n> body\n"),
    ] {
        let depth = scan(&escaped);
        assert!(
            depth.supplements.is_empty() && depth.findings.is_empty(),
            "{escaped}"
        );
        let html = render(&escaped, on()).html;
        assert!(html.starts_with("<blockquote>"), "{html}");
        assert!(
            html.contains("[!"),
            "the author's literal text stays: {html}"
        );
        assert!(!html.contains("ob-supplement"));
    }
    // Unescaped still reads.
    assert_eq!(
        scan("> [!supplement kind=context]\n> body\n")
            .supplements
            .len(),
        1
    );
}

#[test]
fn a_warning_inside_a_supplement_keeps_it_shown_in_every_mode_and_is_reported() {
    let markdown = "> [!supplement kind=evidence level=deep-dive] Handling\n> Notes.\n>\n> > [!WARNING]\n> > Do not heat the mixture.\n\n\
> [!supplement kind=context]\n> Fine.\n>\n> > [!CAUTION]\n> > Sharp.\n\n\
> [!supplement kind=definition level=deep-dive]\n> > [!NOTE]\n> > An ordinary note.\n";
    let depth = scan(markdown);
    let [warned, cautioned, noted] = &depth.supplements[..] else {
        panic!("{:?}", depth.supplements)
    };
    assert!(warned.always && cautioned.always && !noted.always);
    assert_eq!(depth.findings.len(), 2, "{:?}", depth.findings);
    assert!(depth.findings[0].message.contains("every reading mode"));
    // Standard mode shows them anyway; it hides only the note-only one.
    let shown = |mode| {
        depth
            .visible(mode)
            .iter()
            .map(|s| s.id.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        shown(ReadingMode::Standard),
        ["ob-supplement-1", "ob-supplement-2"]
    );
    let html = render(markdown, on()).html;
    assert_eq!(html.matches("data-ob-always").count(), 2);
    assert!(html.contains("role=\"note\""));
    assert!(html.contains("Do not heat the mixture."));
    // A warning in a nested supplement keeps its parent shown too.
    let nested = scan(
        "> [!supplement kind=evidence]\n> a\n>\n> > [!supplement kind=context]\n> > b\n> >\n> > > [!WARNING]\n> > > careful\n",
    );
    assert!(nested.supplements.iter().all(|s| s.always));
    // A warning outside any supplement is not this rule's business.
    assert!(
        scan("> [!WARNING]\n> hot\n\n> [!supplement kind=context]\n> x\n")
            .supplements
            .iter()
            .all(|s| !s.always)
    );
}

#[test]
fn the_front_matter_key_is_read_tolerantly_and_a_map_never_switches_the_post_off() {
    use openblog_core::reading_depth::setting;
    assert!(!setting(None).enabled);
    for yes in ["true", "True", "yes", "on", " true "] {
        let read = setting(Some(yes));
        assert!(
            read.enabled && read.default_mode == ReadingMode::Standard && read.warning.is_none()
        );
    }
    for no in ["false", "no", "off"] {
        let read = setting(Some(no));
        assert!(!read.enabled && read.warning.is_none(), "{no}");
    }
    for (value, mode) in [
        ("{default: guided}", ReadingMode::Guided),
        ("{ default: deep-dive }", ReadingMode::DeepDive),
        ("{\"default\": \"standard\"}", ReadingMode::Standard),
        ("{enabled: true, default: guided}", ReadingMode::Guided),
        ("{}", ReadingMode::Standard),
        ("guided", ReadingMode::Guided),
    ] {
        let read = setting(Some(value));
        assert!(read.enabled, "{value}");
        assert_eq!(read.default_mode, mode, "{value}");
        assert!(read.warning.is_none(), "{value}");
    }
    // `{enabled: false}` is off, like `false`.
    for off in ["{enabled: false}", "{enabled: off, default: guided}"] {
        let read = setting(Some(off));
        assert!(!read.enabled && read.warning.is_none(), "{off}");
    }
    // An unknown key is reported and ignored; the post stays opted in.
    let unknown = setting(Some("{default: guided, other: 1}"));
    assert!(unknown.enabled && unknown.default_mode == ReadingMode::Guided);
    assert!(unknown.warning.unwrap().contains("`other`"));
    let odd = setting(Some("{enabled: maybe}"));
    assert!(odd.enabled && odd.warning.unwrap().contains("maybe"));
    let bad_default = setting(Some("{default: expert}"));
    assert!(bad_default.enabled && bad_default.default_mode == ReadingMode::Standard);
    assert!(bad_default.warning.unwrap().contains("expert"));
    let typo = setting(Some("maybe"));
    assert!(!typo.enabled && typo.warning.unwrap().contains("maybe"));
    // End to end.
    let config = config();
    let post = model::load_post(
        &post_source("readingModes: {default: guided}\n", ARTICLE),
        &config,
        config.render_options(),
    )
    .unwrap();
    let depth = post.reading_depth().unwrap();
    assert_eq!(depth.supplements.len(), 3);
    assert_eq!(depth.default_mode, ReadingMode::Guided);
}

#[test]
fn a_note_cited_only_inside_a_supplement_names_the_supplement() {
    let post = cited(
        "Argument [@plato].\n\n> [!supplement kind=evidence]\n> More in [@slings].\n\n> [!supplement kind=context]\n> Again [@slings] and [@plato].\n",
    );
    let html = &post.html;
    // `slings` is cited only in supplements; `plato` is cited by the article.
    assert!(
        html.contains("data-ob-supplement=\"ob-supplement-1 ob-supplement-2\""),
        "{html}"
    );
    assert_eq!(
        html.matches("data-ob-supplement=\"ob-supplement-").count(),
        1,
        "{html}"
    );
}

#[test]
fn legacy_pages_without_supplements_do_not_change_when_a_post_opts_in() {
    let body = "# T\n\n## One\n\ntext[^a]\n\n> quote\n\n[^a]: note\n";
    let plain = render(body, RenderOptions::default());
    let opted = render(body, on());
    assert_eq!(plain.html, opted.html);
    assert_eq!(plain.text, opted.text);
    assert_eq!(plain.prose, opted.prose);
    assert_eq!(plain.headings, opted.headings);
}

fn shared_contract() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/reading-modes.json")).unwrap()
}

#[test]
fn the_modes_agree_with_the_contract_file_the_browser_component_reads() {
    let contract = shared_contract();
    let names: Vec<_> = ReadingMode::ALL.iter().map(|mode| mode.as_str()).collect();
    assert_eq!(
        names,
        contract["modes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| name.as_str().unwrap())
            .collect::<Vec<_>>()
    );
    let levels = [Depth::Guided, Depth::DeepDive];
    for mode in ReadingMode::ALL {
        for level in levels {
            assert_eq!(
                mode.shows(level),
                contract["shows"][mode.as_str()][level.as_str()]
                    .as_bool()
                    .unwrap(),
                "{} {}",
                mode.as_str(),
                level.as_str()
            );
        }
    }
    // The author's default is read exactly as the component reads it: a mode
    // name is a default, anything else is not.
    for row in contract["resolve"].as_array().unwrap() {
        if let Some(default) = row["default"].as_str() {
            let setting =
                openblog_core::reading_depth::setting(Some(&format!("{{default: {default}}}")));
            let expected = ReadingMode::parse(default).unwrap_or(ReadingMode::Standard);
            assert_eq!(setting.default_mode, expected, "{default}");
            assert_eq!(
                setting.warning.is_some(),
                ReadingMode::parse(default).is_none()
            );
        }
    }
}

#[test]
fn the_post_page_carries_the_hooks_the_component_reads_and_only_when_there_are_supplements() {
    use openblog_core::{generate, LoadOptions, Site, Sources, ThemeSet};
    let contract = shared_contract();
    let build = |front: &str, body: &str| {
        let site = Site::load(
            config(),
            Sources {
                posts: vec![post_source(front, body)],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        generate(&site, &ThemeSet::new())
            .unwrap()
            .into_iter()
            .find(|file| file.path == "posts/p/index.html" || file.path.ends_with("p/index.html"))
            .unwrap()
            .contents
    };
    let page = build("readingModes: {default: guided}\n", ARTICLE);
    assert!(
        page.contains("<ob-reading-modes default=\"guided\"><ob-code"),
        "{page}"
    );
    assert!(page.contains("</ob-code>\n</ob-reading-modes>"));
    // Every supplement is written out visible: nothing for the page to hide.
    for (at, _) in page.match_indices("<div class=\"ob-supplement\"") {
        let tag = &page[at..at + page[at..].find('>').unwrap()];
        assert!(!tag.contains("hidden"), "{tag}");
    }
    for level in page.match_indices("data-ob-level=\"").map(|(at, found)| {
        let rest = &page[at + found.len()..];
        &rest[..rest.find('"').unwrap()]
    }) {
        assert!(contract["levels"]
            .as_array()
            .unwrap()
            .iter()
            .any(|known| known == level));
    }
    let standard = build("readingModes: true\n", ARTICLE);
    assert!(standard.contains("<ob-reading-modes default=\"standard\">"));
    // Opted in with no supplement, or not opted in: no element at all.
    assert!(!build("readingModes: true\n", "Just words.\n").contains("ob-reading-modes"));
    assert!(!build("", ARTICLE).contains("ob-reading-modes"));
}

#[test]
fn a_supplement_written_inside_a_warning_or_caution_callout_is_never_hidden() {
    let markdown = "> [!WARNING]\n> Read first.\n>\n> > [!supplement kind=context level=deep-dive] Why\n> > Because.\n\n\
> [!CAUTION]\n> > [!supplement kind=evidence]\n> > Sharp.\n\n\
> [!NOTE]\n> > [!supplement kind=context level=deep-dive]\n> > Fine to hide.\n";
    let depth = scan(markdown);
    let [warned, cautioned, noted] = &depth.supplements[..] else {
        panic!("{:?}", depth.supplements)
    };
    assert!(warned.always && cautioned.always && !noted.always);
    let shown = depth
        .visible(ReadingMode::Standard)
        .iter()
        .map(|s| s.id.clone())
        .collect::<Vec<_>>();
    assert_eq!(shown, ["ob-supplement-1", "ob-supplement-2"]);
    let html = render(markdown, on()).html;
    assert_eq!(html.matches("data-ob-always").count(), 2, "{html}");
}

#[test]
fn heading_slugs_are_unchanged_when_the_feature_is_off() {
    let markdown = "## OB Supplement 1\n\nText.\n\n## Other {#ob-supplement-x}\n\nMore.\n";
    let off = render(markdown, RenderOptions::default()).html;
    assert!(off.contains("id=\"ob-supplement-1\""), "{off}");
    assert!(off.contains("id=\"ob-supplement-x\""), "{off}");
    assert!(!off.contains("section-ob-supplement"), "{off}");
    // With it on the reserved prefix is avoided and reported.
    let rendered = render(markdown, on());
    assert!(
        rendered.html.contains("id=\"section-ob-supplement-1\""),
        "{}",
        rendered.html
    );
    assert!(
        rendered.html.contains("id=\"section-ob-supplement-x\""),
        "{}",
        rendered.html
    );
    assert!(!rendered.html.contains("id=\"ob-supplement-x\""));
    let findings = rendered.reading_depth.unwrap().findings;
    assert!(
        findings.iter().any(|f| f.marker == "{#ob-supplement-x}"),
        "{findings:?}"
    );
}

#[test]
fn ids_the_author_wrote_with_the_supplement_prefix_are_renamed_and_reported() {
    let markdown = "Cited.[^ob-supplement-9]\n\n[^ob-supplement-9]: A note.\n\n\
<div id=\"ob-supplement-1\">raw</div>\n\n\
<span\nid=\"ob-supplement-2\">split</span>\n\n\
> [!supplement kind=context]\n> Inside.\n";
    let rendered = render(markdown, on());
    let html = &rendered.html;
    // Only the supplement itself owns the reserved id.
    assert_eq!(html.matches("id=\"ob-supplement-1\"").count(), 1, "{html}");
    assert!(
        html.contains("<div id=\"section-ob-supplement-1\">raw</div>"),
        "{html}"
    );
    assert!(html.contains("id=\"section-ob-supplement-2\""), "{html}");
    assert!(html.contains("id=\"section-ob-supplement-9\""), "{html}");
    assert!(html.contains("href=\"#section-ob-supplement-9\""), "{html}");
    let findings = rendered.reading_depth.unwrap().findings;
    assert_eq!(findings.len(), 3, "{findings:?}");
    assert!(findings
        .iter()
        .all(|f| f.message.contains("reserved for supplements")));
    // The same Markdown without the feature is exactly as it was.
    let off = render(markdown, RenderOptions::default()).html;
    assert!(
        off.contains("id=\"ob-supplement-1\"") && off.contains("id=\"ob-supplement-9\""),
        "{off}"
    );
}

#[test]
fn a_nul_in_a_post_with_supplements_is_read_as_the_replacement_character() {
    let markdown =
        "> \u{0}ob-supplement-1\n\n> [!supplement kind=context]\n> Real.\n\nAfter \u{0} text.\n";
    let html = render(markdown, on()).html;
    assert!(!html.contains('\u{0}'), "{html:?}");
    assert!(html.contains("\u{FFFD}ob-supplement-1"), "{html:?}");
    assert!(html.contains("After \u{FFFD} text."), "{html:?}");
    // The real supplement is still wrapped, and the quote that held the
    // would-be tag stays an ordinary quote.
    assert_eq!(
        html.matches("class=\"ob-supplement\"").count(),
        1,
        "{html:?}"
    );
}

#[test]
fn a_site_under_a_folder_names_its_base_path_so_its_saved_choice_is_its_own() {
    use openblog_core::{generate, LoadOptions, Site, Sources, ThemeSet};
    let page_for = |url: &str| {
        let config = SiteConfig::from_json(&format!(
            r#"{{"title": "T", "url": "{url}", "author": {{"name": "A"}}}}"#
        ))
        .unwrap();
        let site = Site::load(
            config,
            Sources {
                posts: vec![post_source("readingModes: true\n", ARTICLE)],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        generate(&site, &ThemeSet::new())
            .unwrap()
            .into_iter()
            .find(|file| file.path.ends_with("p/index.html"))
            .unwrap()
            .contents
    };
    assert!(page_for("https://user.github.io/blog")
        .contains("<ob-reading-modes default=\"standard\" data-ob-base=\"/blog\">"));
    // A site at the root keeps the markup it had.
    let root = page_for("https://example.test");
    assert!(root.contains("<ob-reading-modes default=\"standard\">"));
    assert!(!root.contains("data-ob-base"));
}

fn rendered_heading_ids(html: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut rest = html;
    while let Some(at) = rest.find("<h") {
        rest = &rest[at + 2..];
        let end = rest.find('>').unwrap();
        let tag = &rest[..end];
        if tag.starts_with(|c: char| c.is_ascii_digit()) {
            if let Some(id) = tag.split("id=\"").nth(1) {
                ids.push(id.split('"').next().unwrap().to_string());
            }
        }
    }
    ids
}

#[test]
fn passage_anchors_equal_the_rendered_heading_ids_for_an_opted_in_post() {
    let body = "## OB Supplement notes\n\nFirst.\n\n\
## Early {#ob-supplement-x}\n\nSecond.\n\n\
> [!supplement kind=context]\n> ## Notes\n> Inside.\n\n\
## Notes\n\nThird.\n";
    let config = config();
    let post = model::load_post(
        &post_source("readingModes: true\n", body),
        &config,
        config.render_options(),
    )
    .unwrap();
    assert!(post.reading_depth().is_some());
    let document = openblog_core::passage_target::PassageDocument::of_post(&post, &config);
    let anchors: Vec<String> = document
        .sections
        .iter()
        .filter_map(|section| section.anchor.clone())
        .collect();
    let html = &post.html;
    // Supplement headings carry the supplement's own ids, which are not the
    // article's passages; every anchor is a rendered id, in the same order.
    let rendered = rendered_heading_ids(html);
    let article: Vec<String> = rendered
        .iter()
        .filter(|id| !id.starts_with("ob-supplement-"))
        .cloned()
        .collect();
    let own: Vec<String> = anchors
        .iter()
        .filter(|id| !id.starts_with("ob-supplement-"))
        .cloned()
        .collect();
    assert_eq!(own, article, "{html}");
    assert!(
        anchors.iter().all(|a| rendered.contains(a)),
        "{anchors:?} {rendered:?}"
    );
    assert!(article.contains(&"notes".to_string()), "{article:?}");
    assert!(
        article.contains(&"section-ob-supplement-x".to_string()),
        "{article:?}"
    );
}

#[test]
fn a_renamed_id_is_renamed_by_its_value_and_links_to_it_follow() {
    let markdown = "<div title=\"ob-supplement-1\" data-x='ob-supplement-1' id=\"ob-supplement-1\">raw</div>\n\n\
<p ID = ob-supplement-2 title=\"ob-supplement-2\">two</p>\n\n\
## Written {#ob-supplement-x}\n\nSee [the heading](#ob-supplement-x) and [elsewhere](#other).\n\n\
> [!supplement kind=context]\n> Inside.\n";
    let html = render(markdown, on()).html;
    assert!(
        html.contains(
            "title=\"ob-supplement-1\" data-x='ob-supplement-1' id=\"section-ob-supplement-1\""
        ),
        "{html}"
    );
    assert!(html.contains("title=\"ob-supplement-2\""), "{html}");
    assert!(html.contains("ID = section-ob-supplement-2"), "{html}");
    assert!(html.contains("id=\"section-ob-supplement-x\""), "{html}");
    assert!(html.contains("href=\"#section-ob-supplement-x\""), "{html}");
    assert!(html.contains("href=\"#other\""), "{html}");
}

/// A CSS source without its comments, so a hook that is only mentioned in one is not "found".
fn without_css_comments(css: &str) -> String {
    let mut out = String::new();
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        rest = match rest[start + 2..].find("*/") {
            Some(end) => &rest[start + 2 + end + 2..],
            None => "",
        };
    }
    out.push_str(rest);
    out
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// The whole-token names in `text`: `ob-reading-note` is not found in `ob-reading-notes`.
fn name_tokens(text: &str) -> HashSet<&str> {
    text.split(|c: char| !is_name_char(c))
        .filter(|token| !token.is_empty())
        .collect()
}

/// The text of every double-quoted string literal in a script.
fn string_literals(script: &str) -> Vec<&str> {
    script.split('"').skip(1).step_by(2).collect()
}

#[derive(Default)]
struct Markup {
    tags: HashSet<String>,
    attributes: HashSet<String>,
    classes: HashSet<String>,
}

/// The tag names, attribute names and class names written in `html`; each attribute value is
/// skipped whole, so a word inside one is not taken for a name.
fn markup_names(html: &str) -> Markup {
    let mut found = Markup::default();
    let mut rest = html;
    while let Some(open) = rest.find('<') {
        rest = &rest[open + 1..];
        let end = rest.find('>').unwrap_or(rest.len());
        let tag = &rest[..end];
        let name_end = tag.find(char::is_whitespace).unwrap_or(tag.len());
        found
            .tags
            .insert(tag[..name_end].trim_start_matches('/').to_string());
        let mut cursor = tag[name_end..].trim_start();
        while !cursor.is_empty() {
            let name: String = cursor.chars().take_while(|c| is_name_char(*c)).collect();
            if name.is_empty() {
                // Something that is not a name (a stray quote or slash): step over one character.
                let width = cursor.chars().next().map_or(1, char::len_utf8);
                cursor = cursor[width..].trim_start();
                continue;
            }
            cursor = &cursor[name.len()..];
            if let Some(value) = cursor.trim_start().strip_prefix('=') {
                let value = value.trim_start();
                let (text, used) = match value.strip_prefix('"') {
                    Some(quoted) => {
                        let close = quoted.find('"').unwrap_or(quoted.len());
                        (&quoted[..close], close + 2)
                    }
                    None => {
                        let close = value.find(char::is_whitespace).unwrap_or(value.len());
                        (&value[..close], close)
                    }
                };
                if name == "class" {
                    found
                        .classes
                        .extend(text.split_whitespace().map(str::to_string));
                }
                cursor = value[used.min(value.len())..].trim_start();
            } else {
                cursor = cursor.trim_start();
            }
            found.attributes.insert(name);
        }
        rest = &rest[end..];
    }
    found
}

#[test]
fn name_scanning_helpers_match_whole_tokens_and_ignore_comments() {
    assert!(name_tokens("a.ob-reading-notes {}").contains("ob-reading-notes"));
    assert!(!name_tokens("a.ob-reading-notes {}").contains("ob-reading-note"));
    assert_eq!(
        without_css_comments("a {} /* .ob-gone { } */ b {}"),
        "a {}  b {}"
    );
    let found =
        markup_names("<ob-x default=\"a b\" data-y class=\"one two\"><p class=three data-z=\"c\">");
    assert!(found.tags.contains("ob-x") && found.tags.contains("p"));
    for name in ["default", "data-y", "class", "data-z"] {
        assert!(found.attributes.contains(name), "{name}");
    }
    assert!(!found.attributes.contains("b"));
    for class in ["one", "two", "three"] {
        assert!(found.classes.contains(class), "{class}");
    }
}

/// `data-ready` is `dataset.ready` in a script.
fn dataset_reference(attribute: &str) -> Option<String> {
    let name = attribute.strip_prefix("data-")?;
    let mut camel = String::new();
    let mut upper = false;
    for c in name.chars() {
        if c == '-' {
            upper = true;
        } else if upper {
            camel.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            camel.push(c);
        }
    }
    Some(format!("dataset.{camel}"))
}

#[test]
fn every_documented_theme_hook_exists_as_its_kind_in_the_page_or_the_script() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let read = |path: &str| {
        std::fs::read_to_string(root.join(path))
            .unwrap()
            .replace("\r\n", "\n")
    };
    let spec = read("docs/specs/reading-modes.md");
    let table = spec
        .split("<!-- hooks:start -->")
        .nth(1)
        .and_then(|rest| rest.split("<!-- hooks:end -->").next())
        .expect("the hooks table");
    // `| `hook` | kind | what it is |`
    let hooks: Vec<(&str, &str)> = table
        .lines()
        .filter_map(|line| line.strip_prefix("| `"))
        .filter_map(|line| {
            let (hook, rest) = line.split_once("` | ")?;
            Some((hook, rest.split(" | ").next()?))
        })
        .collect();
    assert!(hooks.len() >= 25, "{hooks:?}");
    for want in [
        "default",
        "data-ob-base",
        "data-ready",
        "data-ob-kind",
        "data-ob-level",
    ] {
        assert!(
            hooks.contains(&(want, "attribute")),
            "`{want}` has no attribute row in the hooks table"
        );
    }
    let css = without_css_comments(&read("web/base.css"));
    let script = read("web/components/ob-reading-modes.js");
    let literals = string_literals(&script);
    let css_tokens = name_tokens(&css);
    // A page with a warning supplement, so every attribute the build writes is present.
    let markdown = format!(
        "{ARTICLE}\n> [!supplement kind=context level=deep-dive] Careful\n> > [!WARNING]\n> > Mind this.\n"
    );
    // The whole page of a post, for the element the build wraps the article in.
    let mut page = markup_names(&render(&markdown, on()).html);
    let whole = markup_names(&page_with_site_default(
        "",
        "readingModes: true
",
    ));
    page.tags.extend(whole.tags);
    page.attributes.extend(whole.attributes);
    for (hook, kind) in hooks {
        let found = match kind {
            "element" => {
                // The page writes the element and the script defines it.
                let define = format!("customElements.define(\"{hook}\"");
                page.tags.contains(hook) && script.contains(&define)
            }
            "class" => {
                // The page or the script writes it: a name only the stylesheet knows is dead.
                let written = page.classes.contains(hook)
                    || literals
                        .iter()
                        .any(|text| text.split_whitespace().any(|name| name == hook));
                written && css_tokens.contains(hook)
            }
            "attribute" => {
                page.attributes.contains(hook)
                    || literals.contains(&hook)
                    || dataset_reference(hook).is_some_and(|reference| script.contains(&reference))
            }
            "property" => css.contains(&format!("{hook}:")),
            other => panic!("unknown hook kind `{other}` for `{hook}`"),
        };
        assert!(
            found,
            "documented {kind} hook `{hook}` does not exist as one"
        );
    }
}

#[test]
fn a_caveat_at_any_depth_makes_every_supplement_around_it_always_shown() {
    let markdown = "> [!supplement kind=context level=deep-dive] Outer\n> Words.\n>\n\
> > [!supplement kind=evidence level=deep-dive] Middle\n> > More.\n> >\n\
> > > [!supplement kind=uncertainty level=deep-dive] Inner\n> > > - a list\n> > >\n\
> > > > [!CAUTION]\n> > > > Do not skip this.\n\n\
> [!supplement kind=context level=deep-dive] Sibling\n> Fine to hide.\n\n\
> [!supplement kind=context level=deep-dive] Escaped\n> ```\n> [!WARNING]\n> ```\n";
    let depth = scan(markdown);
    let always: Vec<bool> = depth.supplements.iter().map(|s| s.always).collect();
    assert_eq!(
        always,
        [true, true, true, false, false],
        "{:?}",
        depth.supplements
    );
    let html = render(markdown, on()).html;
    assert_eq!(html.matches("data-ob-always").count(), 3, "{html}");
    // The caveat itself is in the page whatever the mode, and the build hides nothing.
    assert!(html.contains("Do not skip this."), "{html}");
    assert!(!html.contains(" hidden"), "{html}");
}

fn page_with_site_default(site_json: &str, front: &str) -> String {
    use openblog_core::{generate, LoadOptions, Site, Sources, ThemeSet};
    let config = SiteConfig::from_json(&format!(
        r#"{{"title": "T", "url": "https://example.test", "author": {{"name": "A"}}{site_json}}}"#
    ))
    .unwrap();
    let site = Site::load(
        config,
        Sources {
            posts: vec![post_source(front, ARTICLE)],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();
    generate(&site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .find(|file| file.path.ends_with("p/index.html"))
        .unwrap()
        .contents
}

#[test]
fn the_site_default_applies_only_when_the_post_opts_in_and_names_no_default() {
    let site = r#", "readingModes": {"default": "guided"}"#;
    // Opted in with no default of its own: the site's.
    assert!(page_with_site_default(site, "readingModes: true\n")
        .contains("<ob-reading-modes default=\"guided\">"));
    // The post's own default wins, including an explicit standard.
    assert!(
        page_with_site_default(site, "readingModes: {default: deep-dive}\n")
            .contains("<ob-reading-modes default=\"deep-dive\">")
    );
    assert!(
        page_with_site_default(site, "readingModes: {default: standard}\n")
            .contains("<ob-reading-modes default=\"standard\">")
    );
    // A bad post default is read as standard, not as the site's (the author wrote one).
    assert!(
        page_with_site_default(site, "readingModes: {enabled: true}\n")
            .contains("<ob-reading-modes default=\"guided\">")
    );
    // The site default never opts a post in.
    assert!(!page_with_site_default(site, "").contains("ob-reading-modes"));
    // No site key: standard, as before.
    assert!(page_with_site_default("", "readingModes: true\n")
        .contains("<ob-reading-modes default=\"standard\">"));
}

#[test]
fn the_site_default_is_read_tolerantly_and_never_fails_the_configuration() {
    for (json, expected) in [
        (r#", "readingModes": {"default": "deep-dive"}"#, "deep-dive"),
        (r#", "readingModes": "Guided""#, "guided"),
        (r#", "readingModes": {"default": "nonsense"}"#, "standard"),
        (r#", "readingModes": {"default": 3}"#, "standard"),
        (r#", "readingModes": 7"#, "standard"),
        (r#", "readingModes": null"#, "standard"),
        (r#", "readingModes": {"later": "key"}"#, "standard"),
    ] {
        let page = page_with_site_default(json, "readingModes: true\n");
        assert!(
            page.contains(&format!("<ob-reading-modes default=\"{expected}\">")),
            "{json}"
        );
    }
    // Written back only while it says something, so existing configurations are unchanged.
    let plain = SiteConfig::from_json(r#"{"title": "T"}"#).unwrap();
    assert!(!plain.to_json().contains("readingModes"));
    let set =
        SiteConfig::from_json(r#"{"title": "T", "readingModes": {"default": "guided"}}"#).unwrap();
    assert!(set.to_json().contains("\"default\": \"guided\""));
}

#[test]
fn a_reserved_id_written_with_character_references_is_renamed_by_its_written_value() {
    let markdown = "<div id=\"ob&#45;supplement-1\">one</div>\n\n\
<p id='&#111;b-supplement-2' title=\"ob&#45;supplement-2\">two</p>\n\n\
See [one](#ob-supplement-1).\n\n> [!supplement kind=context]\n> Inside.\n";
    let html = render(markdown, on()).html;
    // The written value is prefixed as written (the character references stay), and the id the
    // browser reads is no longer a reserved one; the title next to it is untouched.
    assert!(
        html.contains("<div id=\"section-ob&#45;supplement-1\">"),
        "{html}"
    );
    assert!(
        html.contains("<p id='section-&#111;b-supplement-2' title=\"ob&#45;supplement-2\">"),
        "{html}"
    );
    // A link to the decoded id follows it, and the only reserved ids left are the supplement's own.
    assert!(html.contains("href=\"#section-ob-supplement-1\""), "{html}");
    assert_eq!(html.matches("id=\"ob-supplement-1\"").count(), 1, "{html}");
}
