//! Contributor-aware series navigation (ADR 0040): a series that holds a collaborative work names
//! each part's authors, from its approved work credits, on the series page and in every part's
//! series navigation. A series without one renders byte for byte as before.

use openblog_core::contributor::Contributor;
use openblog_core::render;
use openblog_core::{DateTime, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};

const AUTHOR: &str = r#"{"vocabulary":"crossref","role":"author"}"#;
const EDITOR: &str = r#"{"vocabulary":"crossref","role":"editor"}"#;
/// Quotes and an ampersand in a contributor name, which must stay text.
const HOSTILE: &str = "Eve \"Q\" & O'Brien";
/// Markup and Markdown in a contributor name, which must stay escaped, unlinked text everywhere.
const MARKUP: &str = "<img src=x onerror=alert(1)> [Mal](javascript:alert(1)) **bold**";

fn config(site_author: &str) -> SiteConfig {
    let mut config = SiteConfig::from_json(&format!(
        r#"{{"title":"T","url":"https://example.test","postPath":"/{{slug}}/","author":{{"name":"{site_author}","url":"https://example.test/about/"}}}}"#,
    ))
    .unwrap();
    for (id, name, url) in [
        ("ann", "Ann", "https://example.org/ann"),
        ("bo", "Bo", "https://example.org/bo"),
        // No profile link of any kind.
        ("cy", "Cy", ""),
        ("dee", "Dee", "https://example.org/dee"),
        ("eve", HOSTILE, "https://example.org/eve"),
        ("mal", MARKUP, ""),
        // Names a portable Markdown copy would misread as an autolink, an entity or raw HTML.
        ("kim", "Kim <https://kim.example>", ""),
        ("att", "AT&amp;T", ""),
        ("img", "<img src=x>", ""),
        // The site owner in the registry, as a shared reflection credits them, with the site
        // author's own profile link, with none, and a namesake with another link.
        ("owner", "Site Owner", "https://example.test/about/"),
        ("owner-bare", "Site Owner", ""),
        ("namesake", "Site Owner", "https://elsewhere.example/"),
        // A second registry entry with Ann's name and link: still a separate registry entry.
        ("ann-again", "Ann", "https://example.org/ann"),
    ] {
        config.contributors.insert(
            id.into(),
            Contributor {
                name: name.into(),
                url: url.into(),
                ..Contributor::default()
            },
        );
    }
    config
}

fn file(path: &str, contents: &str) -> SourceFile {
    SourceFile {
        path: path.into(),
        contents: contents.into(),
    }
}

/// A post in `series`, optionally ordered, with extra front matter lines.
fn post(slug: &str, series: &str, date: &str, order: Option<u32>, extra: &str) -> SourceFile {
    let order = order
        .map(|order| format!("seriesOrder: {order}\n"))
        .unwrap_or_default();
    file(
        &format!("posts/{slug}.md"),
        &format!(
            "---\ntitle: Part {slug}\ndate: {date}\ndescription: About {slug}.\nseries: {series}\n{order}{extra}---\nBody of {slug}.\n"
        ),
    )
}

/// The approved work credits the publish gate writes: authors in order, then any editors.
fn credits(slug: &str, authors: &[&str], editors: &[&str]) -> SourceFile {
    let entries: Vec<String> = authors
        .iter()
        .map(|id| format!(r#"{{"contributor":"{id}","roles":[{AUTHOR}]}}"#))
        .chain(
            editors
                .iter()
                .map(|id| format!(r#"{{"contributor":"{id}","roles":[{EDITOR}]}}"#)),
        )
        .collect();
    file(
        &format!("posts/{slug}.credits.json"),
        &format!(r#"{{"version":1,"credits":[{}]}}"#, entries.join(",")),
    )
}

fn series_file(slug: &str, name: &str) -> SourceFile {
    file(
        &format!("series/{slug}.md"),
        &format!("---\nname: {name}\n---\nA recurring premise for {name}.\n"),
    )
}

/// The ordinary "guides" series: site-author posts, one with an explicit single author, plus a
/// draft and a scheduled multi-author work that are not public.
fn guides() -> (Vec<SourceFile>, Vec<SourceFile>) {
    (
        vec![
            post("g1", "guides", "2026-01-01", Some(1), ""),
            post("g2", "guides", "2026-02-01", Some(2), ""),
            post("g3", "guides", "2026-03-01", None, ""),
            post("g-draft", "guides", "2026-03-05", Some(3), "draft: true\n"),
            post("g-later", "guides", "2099-01-01", Some(4), ""),
        ],
        vec![
            credits("g2", &["cy"], &[]),
            credits("g-draft", &["ann", "bo"], &[]),
            credits("g-later", &["ann", "bo"], &[]),
        ],
    )
}

/// The "letters" series mixes ordinary posts and collaborative works, one with three authors.
fn letters() -> (Vec<SourceFile>, Vec<SourceFile>) {
    (
        vec![
            post("l1", "letters", "2026-04-01", Some(1), ""),
            post("l2", "letters", "2026-05-01", Some(2), ""),
            post("l3", "letters", "2026-06-01", Some(3), ""),
            post("l4", "letters", "2026-07-01", None, ""),
            post("l-draft", "letters", "2026-07-05", Some(5), "draft: true\n"),
            post("l-later", "letters", "2099-01-01", Some(6), ""),
        ],
        vec![
            credits("l2", &["ann", "bo", "cy"], &["dee"]),
            credits("l3", &["dee"], &[]),
            credits("l-draft", &["eve", "ann"], &[]),
            credits("l-later", &["eve", "bo"], &[]),
        ],
    )
}

type Fixture = (Vec<SourceFile>, Vec<SourceFile>);

fn build(parts: &[Fixture]) -> Vec<render::OutputFile> {
    build_as("Site Owner", parts)
}

fn build_as(site_author: &str, parts: &[Fixture]) -> Vec<render::OutputFile> {
    try_build_as(site_author, parts).unwrap()
}

fn try_build_as(site_author: &str, parts: &[Fixture]) -> Result<Vec<render::OutputFile>, String> {
    let mut posts = Vec::new();
    let mut sidecars = Vec::new();
    for (p, c) in parts {
        posts.extend(p.iter().cloned());
        sidecars.extend(c.iter().cloned());
    }
    let site = Site::load(
        config(site_author),
        Sources {
            posts,
            credits: sidecars,
            series: vec![
                series_file("guides", "Guides"),
                series_file("letters", "Letters"),
            ],
            pages: vec![],
            ..Default::default()
        },
        LoadOptions {
            now: DateTime::parse("2030-01-01T00:00:00Z"),
            ..LoadOptions::default()
        },
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"));
    render::generate(&site, &ThemeSet::new())
}

fn page<'a>(files: &'a [render::OutputFile], path: &str) -> &'a str {
    &files
        .iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("no {path}"))
        .contents
}

fn between<'a>(html: &'a str, start: &str, end: &str) -> &'a str {
    let from = html
        .find(start)
        .unwrap_or_else(|| panic!("no `{start}` in page"));
    let to = from + html[from..].find(end).expect("end marker") + end.len();
    &html[from..to]
}

/// The in-post series navigation of a post page.
fn series_box(html: &str) -> &str {
    between(html, "<aside class=\"ob-series-box\"", "</aside>\n")
}

/// The body of a series page.
fn series_body(html: &str) -> &str {
    between(
        html,
        "<div class=\"ob-container ob-container-reading\">",
        "</section>\n</div>",
    )
}

fn fixture(name: &str) -> String {
    let path = format!(
        "{}/tests/fixtures/legacy_series/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{path}: {error}"))
        .replace("\r\n", "\n")
}

/// The series fragments of every published "guides" page must equal the output captured before
/// contributor-aware navigation existed.
fn assert_guides_unchanged(files: &[render::OutputFile]) {
    assert_eq!(
        series_body(page(files, "series/guides/index.html")),
        fixture("series-page.html"),
        "the guides series page changed"
    );
    for slug in ["g1", "g2", "g3"] {
        assert_eq!(
            series_box(page(files, &format!("{slug}/index.html"))),
            fixture(&format!("{slug}-series-box.html")),
            "{slug}'s series navigation changed"
        );
    }
}

/// The hrefs of a fragment, in document order.
fn hrefs(html: &str) -> Vec<&str> {
    html.split("href=\"")
        .skip(1)
        .map(|rest| &rest[..rest.find('"').unwrap()])
        .collect()
}

#[test]
fn a_series_without_a_collaborative_work_renders_byte_for_byte_as_before() {
    // Site-author posts, an explicit single author, a draft and a scheduled multi-author work.
    assert_guides_unchanged(&build(&[guides()]));
    // A collaborative work in another series changes nothing here.
    assert_guides_unchanged(&build(&[guides(), letters()]));
}

#[test]
fn a_mixed_series_names_every_parts_authors_from_its_approved_credits() {
    let files = build(&[guides(), letters()]);
    let series = series_body(page(&files, "series/letters/index.html"));
    // Authors once each, in order of first appearance from the first part; the editor of l2 is
    // credited on the post but is not an author here.
    assert!(
        series.contains(
            "<p class=\"ob-meta ob-series-contributors\">Contributors: Site Owner, Ann, Bo, Cy, and Dee</p>\n<ol class=\"ob-series-parts ob-series-parts-full\">"
        ),
        "{series}"
    );
    for (slug, by) in [
        ("l1", "By Site Owner"),
        ("l2", "By Ann, Bo, and Cy"),
        ("l3", "By Dee"),
        ("l4", "By Site Owner"),
    ] {
        let item = between(series, &format!("href=\"/{slug}/\""), "</li>");
        assert!(
            item.contains(&format!(
                "<span class=\"ob-meta\"><span class=\"ob-part-credit\">{by}</span> · <time"
            )),
            "{item}"
        );
    }
    // Ordinary posts read as ordinary posts: no collaborative markers, only who wrote them.
    let l1 = between(series, "href=\"/l1/\"", "</li>");
    assert!(!l1.contains("Ann") && !l1.contains("Dee"), "{l1}");

    // In-post navigation: the neighbours and every part carry their own authors.
    let nav = series_box(page(&files, "l2/index.html"));
    assert!(nav.contains("<a class=\"ob-series-prev\" rel=\"prev\" href=\"/l1/\"><span class=\"ob-meta\">Previous part</span><span>Part l1</span><span class=\"ob-meta ob-part-credit\">By Site Owner</span></a>"), "{nav}");
    assert!(nav.contains("<a class=\"ob-series-next\" rel=\"next\" href=\"/l3/\"><span class=\"ob-meta\">Next part</span><span>Part l3</span><span class=\"ob-meta ob-part-credit\">By Dee</span></a>"), "{nav}");
    assert!(nav.contains("<li><a href=\"/l2/\" aria-current=\"page\">Part l2</a> <span class=\"ob-meta ob-part-credit\">By Ann, Bo, and Cy</span></li>"), "{nav}");
    assert!(nav.contains("<li><a href=\"/l4/\">Part l4</a> <span class=\"ob-meta ob-part-credit\">By Site Owner</span></li>"), "{nav}");
    // An ordinary part of the same series shows the collaborative neighbour's authors too.
    let l1_nav = series_box(page(&files, "l1/index.html"));
    assert!(l1_nav.contains("<span>Part l2</span><span class=\"ob-meta ob-part-credit\">By Ann, Bo, and Cy</span></a>"), "{l1_nav}");
}

#[test]
fn names_are_plain_text_whatever_the_profile() {
    let files = build(&[letters()]);
    let series = series_body(page(&files, "series/letters/index.html"));
    let nav = series_box(page(&files, "l3/index.html"));
    for html in [series, nav] {
        // Cy has no profile link and Ann has one; neither is linked or marked up as a post author.
        assert!(html.contains("Ann, Bo, and Cy"));
        assert!(!html.contains("example.org"), "{html}");
        assert!(
            !html.contains("h-card") && !html.contains("rel=\"author\""),
            "{html}"
        );
    }
    // A site with no site-author name shows nothing for the ordinary parts, never an empty "By".
    let files = build_as("", &[letters()]);
    let series = series_body(page(&files, "series/letters/index.html"));
    assert!(
        series.contains("Contributors: Ann, Bo, Cy, and Dee</p>"),
        "{series}"
    );
    let l1 = between(series, "href=\"/l1/\"", "</li>");
    assert!(!l1.contains("ob-part-credit"), "{l1}");
    assert!(
        !series.contains("By </span>") && !series.contains("By  "),
        "{series}"
    );
    let nav = series_box(page(&files, "l2/index.html"));
    assert!(nav.contains("<span>Part l1</span></a>"), "{nav}");
    assert!(
        nav.contains("<li><a href=\"/l1/\">Part l1</a></li>"),
        "{nav}"
    );
}

#[test]
fn an_unknown_contributor_fails_the_load_instead_of_publishing_a_guess() {
    let (posts, mut sidecars) = letters();
    sidecars.push(credits("l4", &["ann", "nobody"], &[]));
    let result = Site::load(
        config("Site Owner"),
        Sources {
            posts,
            credits: sidecars,
            series: vec![series_file("letters", "Letters")],
            pages: vec![],
            ..Default::default()
        },
        LoadOptions::default(),
    );
    let Err(errors) = result else {
        panic!("an unknown contributor is refused")
    };
    assert!(
        errors.iter().any(|error| error.contains("nobody")),
        "{errors:?}"
    );
}

#[test]
fn ordering_and_canonical_links_stay_as_they_were() {
    let credited = build(&[letters()]);
    let (posts, _) = letters();
    let plain = build(&[(posts, Vec::new())]);
    let series = |files: &[render::OutputFile]| {
        hrefs(series_body(page(files, "series/letters/index.html")))
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        series(&credited),
        ["/series/", "/l1/", "/l2/", "/l3/", "/l4/"]
    );
    assert_eq!(series(&credited), series(&plain));
    for slug in ["l1", "l2", "l3", "l4"] {
        let path = format!("{slug}/index.html");
        assert_eq!(
            hrefs(series_box(page(&credited, &path))),
            hrefs(series_box(page(&plain, &path))),
            "{slug}"
        );
        let canonical = |files: &[render::OutputFile]| {
            between(page(files, &path), "<link rel=\"canonical\"", ">").to_string()
        };
        assert_eq!(canonical(&credited), canonical(&plain));
    }
}

#[test]
fn removed_withdrawn_draft_and_scheduled_works_disappear_cleanly() {
    let files = build(&[letters()]);
    for path in [
        "series/letters/index.html",
        "l1/index.html",
        "l2/index.html",
        "l4/index.html",
    ] {
        let html = page(&files, path);
        let fragment = if path.starts_with("series/") {
            series_body(html)
        } else {
            series_box(html)
        };
        // The draft and the scheduled work, and Eve who is credited only on them, are absent.
        for hidden in ["l-draft", "l-later", "Part l-", "onerror", "Eve"] {
            assert!(!fragment.contains(hidden), "{path} shows {hidden}");
        }
    }
    assert!(series_box(page(&files, "l1/index.html")).contains("Part 1 of 4 in"));

    // A withdrawn author leaves the work's credits and the contributor list.
    let (posts, mut sidecars) = letters();
    sidecars.retain(|sidecar| sidecar.path != "posts/l2.credits.json");
    sidecars.push(credits("l2", &["ann", "bo"], &[]));
    let files = build(&[(posts.clone(), sidecars.clone())]);
    let series = series_body(page(&files, "series/letters/index.html"));
    assert!(
        series.contains("Contributors: Site Owner, Ann, Bo, and Dee</p>"),
        "{series}"
    );
    assert!(!series.contains("Cy"), "{series}");

    // When no collaborative work is left, the series is an ordinary series again, byte for byte.
    sidecars.retain(|sidecar| sidecar.path != "posts/l2.credits.json");
    sidecars.push(credits("l2", &["ann"], &[]));
    let reverted = build(&[(posts.clone(), sidecars)]);
    let ordinary = build(&[(posts, Vec::new())]);
    assert_eq!(
        series_body(page(&reverted, "series/letters/index.html")),
        series_body(page(&ordinary, "series/letters/index.html"))
    );
    for slug in ["l1", "l2", "l3", "l4"] {
        let path = format!("{slug}/index.html");
        assert_eq!(
            series_box(page(&reverted, &path)),
            series_box(page(&ordinary, &path))
        );
    }
}

#[test]
fn hostile_names_stay_escaped_unlinked_text_and_the_build_succeeds() {
    let posts = vec![post("n1", "letters", "2026-04-01", Some(1), "")];
    let files = build(&[(posts.clone(), vec![credits("n1", &["eve", "ann"], &[])])]);
    for html in [
        series_body(page(&files, "series/letters/index.html")),
        series_box(page(&files, "n1/index.html")),
    ] {
        assert!(
            html.contains("By Eve &quot;Q&quot; &amp; O&#39;Brien and Ann"),
            "{html}"
        );
    }
    // Markup, Markdown links and emphasis, autolinks and entities in a name are published as the
    // literal text they are, on the series page and in the navigation, and never as markup or a
    // link. The portable copies carry them faithfully, so the build succeeds.
    for (id, escaped) in [
        (
            "mal",
            "&lt;img src=x onerror=alert(1)&gt; [Mal](javascript:alert(1)) **bold**",
        ),
        ("kim", "Kim &lt;https://kim.example&gt;"),
        ("att", "AT&amp;amp;T"),
        ("img", "&lt;img src=x&gt;"),
    ] {
        let files = try_build_as(
            "Site Owner",
            &[(posts.clone(), vec![credits("n1", &[id, "ann"], &[])])],
        )
        .unwrap_or_else(|error| panic!("{id}: {error}"));
        for html in [
            series_body(page(&files, "series/letters/index.html")),
            series_box(page(&files, "n1/index.html")),
        ] {
            assert!(
                html.contains(&format!("By {escaped} and Ann")),
                "{id}: {html}"
            );
            assert!(
                !html.contains("<img")
                    && !html.contains("<strong")
                    && !html.contains("javascript:alert(1)\"")
                    && !html.contains("href=\"https://kim.example")
                    && !html.contains("href=\"javascript"),
                "{id}: {html}"
            );
        }
    }
}

#[test]
fn a_person_credited_under_two_ids_is_named_once() {
    // The reproduced case: the site author writes an ordinary part, then co-writes a shared
    // reflection under their registry id. The legacy credit and the registry credit are one
    // person, with the same link or with none on the registry side.
    for owner in ["owner", "owner-bare"] {
        let files = build(&[(
            vec![
                post("o1", "letters", "2026-04-01", Some(1), ""),
                post("o2", "letters", "2026-05-01", Some(2), ""),
            ],
            vec![credits("o2", &[owner, "bo"], &[])],
        )]);
        let series = series_body(page(&files, "series/letters/index.html"));
        assert!(
            series.contains("Contributors: Site Owner and Bo</p>"),
            "{owner}: {series}"
        );
    }
    // Two registry ids are two people, even with the same name and link: the registry is where
    // people are told apart, so only the legacy site-author credit is matched by name.
    let files = build(&[(
        vec![
            post("o1", "letters", "2026-04-01", Some(1), ""),
            post("o2", "letters", "2026-05-01", Some(2), ""),
        ],
        vec![
            credits("o1", &["ann", "bo"], &[]),
            credits("o2", &["ann-again", "cy"], &[]),
        ],
    )]);
    let series = series_body(page(&files, "series/letters/index.html"));
    assert!(
        series.contains("Contributors: Ann, Bo, Ann, and Cy</p>"),
        "{series}"
    );
    // A namesake with a different profile link is a different person and keeps their place.
    let files = build(&[(
        vec![
            post("o1", "letters", "2026-04-01", Some(1), ""),
            post("o2", "letters", "2026-05-01", Some(2), ""),
        ],
        vec![credits("o2", &["namesake", "bo"], &[])],
    )]);
    let series = series_body(page(&files, "series/letters/index.html"));
    assert!(
        series.contains("Contributors: Site Owner, Site Owner, and Bo</p>"),
        "{series}"
    );
}

#[test]
fn series_navigation_is_accessible_without_javascript() {
    let files = build(&[letters()]);
    let series = series_body(page(&files, "series/letters/index.html"));
    let nav = series_box(page(&files, "l2/index.html"));
    for html in [series, nav] {
        // Plain server-rendered links and text: nothing to run, nothing hidden from assistive tech.
        assert!(!html.contains("<script") && !html.contains(" on"), "{html}");
        assert!(!html.contains("aria-hidden=\"true\">By"), "{html}");
    }
    // The navigation keeps its landmark name, link relations, current page and native disclosure.
    assert!(nav.starts_with("<aside class=\"ob-series-box\" aria-label=\"Series navigation\">"));
    assert!(nav.contains("rel=\"prev\"") && nav.contains("rel=\"next\""));
    assert!(nav.contains("aria-current=\"page\""));
    assert!(nav.contains("<details class=\"ob-series-parts-details\"><summary>All parts</summary>"));
    // Credits sit inside each link, so a link's accessible name says whose part it is.
    let prev = between(nav, "<a class=\"ob-series-prev\"", "</a>");
    assert!(prev.contains("By Site Owner"), "{prev}");
    let part = between(series, "<a class=\"ob-part\" href=\"/l2/\"", "</a>");
    assert!(part.contains("By Ann, Bo, and Cy"), "{part}");
    // The contributor line is ordinary text before the parts list, in reading order.
    assert!(series.find("Contributors:").unwrap() < series.find("<ol").unwrap());
}
