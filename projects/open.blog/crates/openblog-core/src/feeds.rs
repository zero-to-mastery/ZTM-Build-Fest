//! RSS 2.0, JSON Feed 1.1, sitemap, robots.txt, text-first discovery feeds, the
//! latest-posts snapshot, and the search index. All are plain string builders
//! over the site model.

use crate::contributor::CreditProvenance;
use crate::escape;
use crate::model::Site;
use crate::portability::{PortableProjection, RepresentationFormat};
use crate::search::{Index, IndexEntry, INDEX_VERSION};

/// RSS 2.0 with the `content:encoded`, `dc:creator`, and `atom:link` extensions
/// most readers and cross-posting tools expect.
pub fn rss(site: &Site) -> Result<String, String> {
    let c = &site.config;
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str("<rss version=\"2.0\" xmlns:atom=\"http://www.w3.org/2005/Atom\" xmlns:content=\"http://purl.org/rss/1.0/modules/content/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n");
    out.push_str("<channel>\n");
    out.push_str(&format!("<title>{}</title>\n", escape::xml(&c.title)));
    out.push_str(&format!("<link>{}</link>\n", escape::xml(&c.absolute("/"))));
    out.push_str(&format!(
        "<description>{}</description>\n",
        escape::xml(&c.description)
    ));
    out.push_str(&format!(
        "<language>{}</language>\n",
        escape::xml(&c.language)
    ));
    out.push_str(&format!(
        "<atom:link href=\"{}\" rel=\"self\" type=\"application/rss+xml\"/>\n",
        escape::xml(&c.absolute("/rss.xml"))
    ));
    out.push_str("<generator>open.blog</generator>\n");
    if let Some(latest) = site.latest_update() {
        out.push_str(&format!(
            "<lastBuildDate>{}</lastBuildDate>\n",
            latest.rfc2822()
        ));
    }
    for post in site
        .posts
        .iter()
        .filter(|post| !post.draft)
        .take(c.feeds.limit.max(1))
    {
        let projection = PortableProjection::for_site(site, post)?;
        let link = projection.canonical_url().to_string();
        out.push_str("<item>\n");
        out.push_str(&format!("<title>{}</title>\n", escape::xml(&post.title)));
        out.push_str(&format!("<link>{}</link>\n", escape::xml(&link)));
        out.push_str(&format!(
            "<guid isPermaLink=\"true\">{}</guid>\n",
            escape::xml(&link)
        ));
        out.push_str(&format!("<pubDate>{}</pubDate>\n", post.date.rfc2822()));
        match projection.credit_provenance() {
            CreditProvenance::LegacySiteAuthor if !c.author.name.is_empty() => {
                out.push_str(&format!(
                    "<dc:creator>{}</dc:creator>\n",
                    escape::xml(&c.author.name)
                ));
            }
            CreditProvenance::ExplicitSidecar => {
                for author in projection.authors() {
                    out.push_str(&format!(
                        "<dc:creator>{}</dc:creator>\n",
                        escape::xml(&author.contributor.name)
                    ));
                }
            }
            CreditProvenance::LegacySiteAuthor => {}
        }
        for tag in &post.tags {
            out.push_str(&format!(
                "<category>{}</category>\n",
                escape::xml(&tag.name)
            ));
        }
        // A part of a collaborative series names its series as a category in the site's series
        // taxonomy, whose domain is the series index (ADR 0041). RSS 2.0's `domain` identifies the
        // taxonomy and is not a link, so the series page itself, the part's place and its authors
        // are only in the full content.
        if let Some(series) = projection.series() {
            out.push_str(&format!(
                "<category domain=\"{}\">{}</category>\n",
                escape::xml(&projection.resolve_link("/series/")?),
                escape::xml(&series.name)
            ));
        }
        out.push_str(&format!(
            "<description>{}</description>\n",
            escape::xml(&post.description)
        ));
        if let Some(cover) = &post.cover {
            out.push_str(&format!(
                "<enclosure url=\"{}\" length=\"0\" type=\"{}\"/>\n",
                escape::xml(&projection.resolve_link(cover)?),
                mime_for(cover)
            ));
        }
        // Where the post's research context is on the canonical page, whether or
        // not the feed carries the post's words (ADR 0202). A related link, which
        // readers that do not know it ignore.
        if let Some(context) = projection.curated_context_summary() {
            if let Some(url) = context["url"].as_str() {
                out.push_str(&format!(
                    "<atom:link rel=\"related\" type=\"text/html\" title=\"Research context\" href=\"{}\"/>\n",
                    escape::xml(url)
                ));
            }
        }
        if c.feeds.full_content {
            let portable_html = projection.portable_html()?.html;
            out.push_str(&format!(
                "<content:encoded>{}</content:encoded>\n",
                escape::cdata(&absolutize_html(&portable_html, projection.base_url()))
            ));
        }
        out.push_str("</item>\n");
    }
    out.push_str("</channel>\n</rss>\n");
    Ok(out)
}

/// Where the `_openblog` JSON Feed extension is documented.
pub const JSON_FEED_EXTENSION_ABOUT: &str =
    "https://github.com/journey-to-code-org/open.blog/blob/main/docs/integrations.md#series-in-feeds";

/// JSON Feed 1.1: <https://jsonfeed.org/version/1.1>
pub fn json_feed(site: &Site) -> Result<String, String> {
    let c = &site.config;
    let items: Vec<serde_json::Value> = site
        .posts
        .iter()
        .filter(|post| !post.draft)
        .take(c.feeds.limit.max(1))
        .map(|post| {
            let projection = PortableProjection::for_site(site, post)?;
            let url = projection.canonical_url();
            let mut item = serde_json::json!({
                "id": url,
                "url": url,
                "title": post.title,
                "summary": post.description,
                "date_published": post.date.rfc3339(),
                "tags": post.tags.iter().map(|t| t.name.clone()).collect::<Vec<_>>(),
            });
            if let Some(updated) = post.updated {
                item["date_modified"] = serde_json::Value::String(updated.rfc3339());
            }
            if let Some(cover) = &post.cover {
                item["image"] = serde_json::Value::String(projection.resolve_link(cover)?);
            }
            if c.feeds.full_content {
                let portable_html = projection.portable_html()?.html;
                item["content_html"] = serde_json::Value::String(absolutize_html(
                    &portable_html,
                    projection.base_url(),
                ));
                item["content_text"] = serde_json::Value::String(projection.portable_text()?);
            } else {
                // JSON Feed requires a content field even for summary-only items.
                item["content_text"] = serde_json::Value::String(post.description.clone());
            }
            if let Some(canonical) = &post.canonical {
                item["external_url"] =
                    serde_json::Value::String(projection.resolve_link(canonical)?);
            }
            if projection.credit_provenance() == CreditProvenance::ExplicitSidecar {
                let authors = projection
                    .authors()
                    .map(|credit| {
                        let mut author = serde_json::json!({
                            "name": credit.contributor.name,
                        });
                        if !credit.contributor.url.trim().is_empty() {
                            author["url"] = serde_json::Value::String(
                                projection.resolve_link(credit.contributor.url.trim())?,
                            );
                        }
                        Ok(author)
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                if !authors.is_empty() {
                    item["authors"] = serde_json::Value::Array(authors);
                }
            }
            // A part of a collaborative series carries its series as a JSON Feed extension
            // object, which readers that do not know it ignore (ADR 0041). `about` points to its
            // documentation, as JSON Feed recommends for extensions.
            if let Some(series) = projection.series() {
                item["_openblog"] = serde_json::json!({
                    "about": JSON_FEED_EXTENSION_ABOUT,
                    "series": {
                        "title": series.name,
                        "url": projection.resolve_link(&series.url)?,
                        "part": series.part,
                        "parts": series.parts,
                        "authors": series.part_authors,
                        "contributors": series.contributors,
                    }
                });
            }
            // A post with a research context says where it is on the canonical page
            // and which items it holds, by id, kind and anchor, even when the feed
            // carries no full content (ADR 0202). The words are in `content_*`.
            if let Some(context) = projection.curated_context_summary() {
                if item.get("_openblog").is_none() {
                    item["_openblog"] = serde_json::json!({ "about": JSON_FEED_EXTENSION_ABOUT });
                }
                item["_openblog"]["researchContext"] = context;
            }
            Ok(item)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut feed = serde_json::json!({
        "version": "https://jsonfeed.org/version/1.1",
        "title": c.title,
        "home_page_url": c.absolute("/"),
        "feed_url": c.absolute("/feed.json"),
        "description": c.description,
        "language": c.language,
        "items": items,
    });
    if !c.author.name.is_empty() {
        let mut author = serde_json::json!({ "name": c.author.name });
        if !c.author.url.is_empty() {
            author["url"] = serde_json::Value::String(c.author.url.clone());
        }
        feed["authors"] = serde_json::Value::Array(vec![author]);
    }
    serde_json::to_string_pretty(&feed).map_err(|error| error.to_string())
}

/// A small list of the newest posts for other sites to embed:
/// `{ "schemaVersion": 1, "posts": [{ "title", "date", "link" }] }` with at most four posts.
pub fn portfolio_snapshot(site: &Site, limit: usize) -> Result<String, String> {
    let c = &site.config;
    let posts: Vec<serde_json::Value> = site
        .posts
        .iter()
        .filter(|post| !post.draft)
        .take(limit)
        .map(|post| {
            let projection = PortableProjection::from_post(post, c)?;
            Ok(serde_json::json!({
                "title": post.title,
                "date": post.date.rfc3339(),
                "link": projection.canonical_url()
            }))
        })
        .collect::<Result<_, String>>()?;
    serde_json::to_string_pretty(&serde_json::json!({ "schemaVersion": 1, "posts": posts }))
        .map_err(|error| error.to_string())
}

/// Every public URL, for `/sitemap.xml`.
pub fn sitemap(site: &Site, extra_paths: &[String]) -> String {
    let c = &site.config;
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n");
    let mut push = |path: &str, lastmod: Option<String>| {
        out.push_str("<url><loc>");
        out.push_str(&escape::xml(&c.absolute(path)));
        out.push_str("</loc>");
        if let Some(l) = lastmod {
            out.push_str(&format!("<lastmod>{l}</lastmod>"));
        }
        out.push_str("</url>\n");
    };
    push("/", site.latest_update().map(|d| d.ymd()));
    for post in site.posts.iter().filter(|post| !post.draft) {
        push(&post.url, Some(post.updated.unwrap_or(post.date).ymd()));
    }
    for series in site.series.iter().filter(|s| !s.posts.is_empty()) {
        let lastmod = series
            .posts
            .iter()
            .map(|&i| site.posts[i].updated.unwrap_or(site.posts[i].date))
            .max();
        push(&series.url, lastmod.map(|d| d.ymd()));
    }
    for tag in &site.tags {
        push(&tag.url, None);
    }
    for page in &site.pages {
        push(&page.url, None);
    }
    for path in extra_paths {
        push(path, None);
    }
    out.push_str("</urlset>\n");
    out
}

pub fn robots(site: &Site) -> String {
    let directive = |allowed| if allowed { "Allow: /" } else { "Disallow: /" };
    let mut out = String::new();
    for agent in ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"] {
        out.push_str(&format!(
            "User-agent: {agent}\n{}\n\n",
            directive(site.config.seo.ai_search)
        ));
    }
    for agent in ["GPTBot", "ClaudeBot", "Google-Extended"] {
        out.push_str(&format!(
            "User-agent: {agent}\n{}\n\n",
            directive(site.config.seo.ai_training)
        ));
    }
    out.push_str("User-agent: *\nAllow: /\n\n");
    out.push_str(&format!(
        "Sitemap: {}\n",
        site.config.absolute("/sitemap.xml")
    ));
    out
}

/// A concise, Markdown-shaped index for automated readers. `llms.txt` is an
/// emerging convention rather than a search standard, so the ordinary HTML,
/// feeds, and sitemap remain the authoritative discovery surfaces.
pub fn llms_index(site: &Site) -> Result<String, String> {
    let c = &site.config;
    let mut out = format!(
        "# {}\n\n> {}\n\n",
        markdown_text(&c.title),
        markdown_text(&c.description)
    );
    out.push_str("## Posts\n\n");
    for post in site.posts.iter().filter(|post| !post.draft) {
        let projection = PortableProjection::from_post(post, c)?;
        out.push_str(&format!(
            "- [{}]({}): {}\n",
            markdown_text(&post.title),
            projection.canonical_url(),
            markdown_text(&post.description)
        ));
    }
    if !site.pages.is_empty() {
        out.push_str("\n## Pages\n\n");
        for page in &site.pages {
            out.push_str(&format!(
                "- [{}]({}): {}\n",
                markdown_text(&page.title),
                c.absolute(&page.url),
                markdown_text(&page.description)
            ));
        }
    }
    if !site.services.is_empty() {
        out.push_str("\n## Services\n\n");
        for service in &site.services {
            out.push_str(&format!(
                "- [{}]({}): {}\n",
                markdown_text(&service.name),
                c.absolute(&service.url),
                markdown_text(&service.summary)
            ));
        }
    }
    if !c.service_areas.is_default() {
        out.push_str("\n## Service areas\n\n");
        for planned in c.service_areas.plan() {
            out.push_str(&format!(
                "- [{}]({})\n",
                markdown_text(&planned.area.label()),
                c.absolute(&planned.url)
            ));
        }
    }
    let mut feed_links = Vec::new();
    if c.feeds.rss {
        feed_links.push(("RSS", "/rss.xml"));
    }
    if c.feeds.json {
        feed_links.push(("JSON Feed", "/feed.json"));
    }
    if c.feeds.sitemap {
        feed_links.push(("Sitemap", "/sitemap.xml"));
    }
    if !feed_links.is_empty() {
        out.push_str("\n## Feeds\n\n");
        for (label, path) in feed_links {
            out.push_str(&format!("- [{label}]({})\n", c.absolute(path)));
        }
    }
    Ok(out)
}

/// Public article text in one retrieval-friendly document. This intentionally
/// contains only content already visible in the generated site.
pub fn llms_full(site: &Site) -> Result<String, String> {
    let c = &site.config;
    let mut out = format!(
        "# {}\n\n> {}\n",
        markdown_text(&c.title),
        markdown_text(&c.description)
    );
    for post in site.posts.iter().filter(|post| !post.draft) {
        let projection = PortableProjection::for_site(site, post)?;
        out.push_str(&format!(
            "\n---\n\n## {}\n\n- URL: {}\n- Published: {}\n",
            markdown_text(&post.title),
            projection.canonical_url(),
            post.date.ymd()
        ));
        if let Some(updated) = post.updated {
            out.push_str(&format!("- Updated: {}\n", updated.ymd()));
        }
        if !post.tags.is_empty() {
            out.push_str(&format!(
                "- Topics: {}\n",
                post.tags
                    .iter()
                    .map(|tag| markdown_text(&tag.name))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if let Some(series) = projection.series() {
            let names = |names: &[String]| {
                crate::render::human_list(
                    &names
                        .iter()
                        .map(|name| inert_markdown_text(name))
                        .collect::<Vec<_>>(),
                )
            };
            out.push_str(&format!(
                "- Series: Part {} of {} in [{}](<{}>)\n",
                series.part,
                series.parts,
                inert_markdown_text(&series.name),
                projection.resolve_link(&series.url)?
            ));
            if !series.part_authors.is_empty() {
                out.push_str(&format!(
                    "- Part authors: {}\n",
                    names(&series.part_authors)
                ));
            }
            if !series.contributors.is_empty() {
                out.push_str(&format!(
                    "- Series contributors: {}\n",
                    names(&series.contributors)
                ));
            }
        }
        if let Some(shared) = &post.shared_attribution {
            if let Some(question) = &shared.question {
                out.push_str(&format!(
                    "- Guiding question: {}\n",
                    markdown_text(question).replace('<', r"\<")
                ));
            }
            if let Some(source) = &shared.source {
                let title = markdown_text(&source.title).replace('<', r"\<");
                let name = match &source.url {
                    Some(url) => format!("[{title}](<{url}>)"),
                    None => title,
                };
                out.push_str(&format!("- Source ({}): {name}\n", source.kind.label()));
            }
        }
        // Readers' Third Perspectives stay on the canonical page: only a link to them, never
        // their words (ADR 0115, P6.2).
        if post.capabilities.iter().any(|capability| {
            capability.id == crate::perspective_publication::THIRD_PERSPECTIVES_CAPABILITY
        }) {
            out.push_str(&format!(
                "- Third Perspectives: on the canonical page, <{}>\n",
                projection.canonical_url()
            ));
        }
        // A shared reflection keeps each round prompt and each author's name and label with the
        // words they belong to; the page's search text is the words alone (ADR 0033).
        let body = match projection.reflection_text()? {
            Some(text) => text,
            None => projection
                .representation(RepresentationFormat::Text)
                .to_string(),
        };
        out.push_str(&format!("\n{}\n", body.trim()));
        // The research context the post is offered, in the same words as every
        // other portable copy, with its links back to the canonical page (ADR 0202).
        if let Some(context) = projection.curated_context_markdown() {
            out.push_str(&format!("\n{}\n", context.trim()));
        }
    }
    Ok(out)
}

fn plain_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn markdown_text(value: &str) -> String {
    plain_line(value)
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

/// `markdown_text` that also keeps `<` and `&` literal, so a name cannot become an autolink, raw
/// HTML or an entity.
fn inert_markdown_text(value: &str) -> String {
    markdown_text(value).replace('<', "\\<").replace('&', "\\&")
}

/// The client-side search index. Body text is lower-cased and truncated to keep
/// the file small; titles, tags, and descriptions carry most of the signal.
pub fn search_index(site: &Site) -> String {
    let mut entries: Vec<IndexEntry> = site
        .posts
        .iter()
        .map(|post| IndexEntry {
            title: post.title.clone(),
            url: post.url.clone(),
            date: post.date.ymd(),
            tags: post.tags.iter().map(|t| t.name.clone()).collect(),
            series: post
                .series
                .as_deref()
                .and_then(|s| site.series_by_slug(s))
                .map(|s| s.name.clone()),
            description: post.description.clone(),
            text: {
                let lower = post.text.to_lowercase();
                lower.chars().take(4000).collect()
            },
        })
        .collect();
    // Listed reading paths are found by search after the posts (ADR 0216):
    // from the public value only, so an unlisted path, a draft or a step
    // that is not published never appears. They are not feed items.
    if let Some(paths) = &site.reading_paths {
        entries.extend(paths.listed_only().paths.iter().map(path_index_entry));
    }
    // Published interpretation comparisons are found by search the same way
    // (ADR 0232), from the public projection only: approved text, never a
    // draft or an unapproved AI draft. They are not feed items.
    if let Some(public) = &site.interpretations {
        entries.extend(
            public
                .comparisons
                .iter()
                .map(|published| interpretation_index_entry(&published.url, &published.comparison)),
        );
    }
    serde_json::to_string(&Index {
        version: INDEX_VERSION,
        entries,
    })
    .unwrap_or_default()
}

fn interpretation_index_entry(
    url: &str,
    comparison: &crate::scholarly_comparison::PublicComparison,
) -> IndexEntry {
    use crate::scholarly_comparison::PublicAttribution;
    let mut text = String::new();
    for interpretation in &comparison.interpretations {
        match &interpretation.attribution {
            PublicAttribution::Named { name, .. } => text.push_str(name),
            PublicAttribution::Anonymous { description, .. } => text.push_str(description),
            PublicAttribution::Source { .. } => {}
        }
        text.push(' ');
        text.push_str(&interpretation.statement);
        text.push(' ');
    }
    IndexEntry {
        title: comparison.title.clone(),
        url: url.to_string(),
        date: String::new(),
        tags: vec!["interpretations".to_string()],
        series: None,
        description: comparison.subject.clone(),
        text: text.to_lowercase().chars().take(4000).collect(),
    }
}

fn path_index_entry(path: &crate::reading_path::PublicPath) -> IndexEntry {
    let mut text = String::new();
    for step in &path.steps {
        for part in [
            Some(step.title.as_str()),
            step.rationale.as_deref(),
            step.transition.as_ref().map(|t| t.why.as_str()),
        ]
        .into_iter()
        .flatten()
        {
            text.push_str(part);
            text.push(' ');
        }
    }
    IndexEntry {
        title: path.title.clone(),
        url: path.url.clone(),
        // A path has no date, and the search page shows it as a path.
        date: String::new(),
        tags: vec!["reading path".to_string()],
        series: None,
        description: path.summary.clone().unwrap_or_default(),
        text: text.to_lowercase().chars().take(4000).collect(),
    }
}

/// Feed readers need absolute URLs. Rewrite root-relative `src`/`href` values.
fn absolutize_html(html: &str, origin: &str) -> String {
    html.replace("src=\"/", &format!("src=\"{origin}/"))
        .replace("href=\"/", &format!("href=\"{origin}/"))
}

fn mime_for(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "image/*",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SiteConfig;
    use crate::model::{LoadOptions, SourceFile, Sources};

    fn site() -> Site {
        let config = SiteConfig::from_json(
            r#"{"title":"Journey","url":"https://j.io","postPath":"/{slug}/","author":{"name":"Alex"}}"#,
        )
        .unwrap();
        Site::load(
            config,
            Sources {
                posts: vec![
                    SourceFile { path: "posts/a.md".into(), contents: "---\ntitle: A & B\ndate: 2026-10-21T04:15:10Z\ntags: [rust]\ncover: /img/a.png\n---\nHello ![x](/img/x.png)".into() },
                    SourceFile { path: "posts/b.md".into(), contents: "---\ntitle: B\ndate: 2026-10-01\n---\nOlder".into() },
                ],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap()
    }

    fn credited_site() -> Site {
        let config = SiteConfig::from_json(
            r#"{
              "title":"Journey","url":"https://j.io","postPath":"/{slug}/",
              "author":{"name":"Legacy"},
              "contributors":{
                "editor":{"name":"Editor"},
                "ada":{"name":"Ada & Co.","url":"https://ada.example"},
                "grace":{"name":"Grace"}
              }
            }"#,
        )
        .unwrap();
        Site::load(
            config,
            Sources {
                posts: vec![SourceFile {
                    path: "posts/work.md".into(),
                    contents: "---\ntitle: Work\ndate: 2026-10-23\n---\nBody".into(),
                }],
                credits: vec![SourceFile {
                    path: "posts/work.credits.json".into(),
                    contents: r#"{"version":1,"credits":[
                      {"contributor":"editor","roles":[{"vocabulary":"crossref","role":"editor"}]},
                      {"contributor":"ada","roles":[{"vocabulary":"crossref","role":"author"}]},
                      {"contributor":"grace","roles":[{"vocabulary":"crossref","role":"author"}]}
                    ]}"#
                    .into(),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap()
    }

    #[test]
    fn summary_only_feeds_keep_required_content_and_identity_without_exporting_the_body() {
        let mut site = site();
        let original = site.posts[0].html.clone();
        let full: serde_json::Value = serde_json::from_str(&json_feed(&site).unwrap()).unwrap();
        site.config.feeds.full_content = false;
        let summary: serde_json::Value = serde_json::from_str(&json_feed(&site).unwrap()).unwrap();
        for (index, post) in site.posts.iter().enumerate() {
            assert_eq!(summary["items"][index]["id"], full["items"][index]["id"]);
            assert_eq!(summary["items"][index]["content_text"], post.description);
            assert!(summary["items"][index].get("content_html").is_none());
        }
        let xml = rss(&site).unwrap();
        assert!(!xml.contains("<content:encoded>"));
        assert!(xml.contains("<description>Hello x</description>"));
        assert!(xml.contains("<guid isPermaLink=\"true\">https://j.io/a/</guid>"));
        assert_eq!(site.posts[0].html, original);
        site.posts[0].title = "An updated title".into();
        let updated: serde_json::Value = serde_json::from_str(&json_feed(&site).unwrap()).unwrap();
        assert_eq!(updated["items"][0]["id"], full["items"][0]["id"]);
    }

    #[test]
    fn rss_has_what_feed_readers_and_widgets_need() {
        let xml = rss(&site()).unwrap();
        assert!(xml.contains("<title>A &amp; B</title>"));
        assert!(xml.contains("<link>https://j.io/a/</link>"));
        assert!(xml.contains("<pubDate>Wed, 21 Oct 2026 04:15:10 GMT</pubDate>"));
        assert!(xml.contains("<category>rust</category>"));
        assert!(xml.contains("<enclosure url=\"https://j.io/img/a.png\""));
        assert!(xml.contains("src=\"https://j.io/img/x.png\""));
        assert!(!xml.contains("<!DOCTYPE"));
    }

    #[test]
    fn explicit_post_authors_are_ordered_in_rss_and_json_feed_items() {
        let site = credited_site();
        let xml = rss(&site).unwrap();
        let ada = xml.find("<dc:creator>Ada &amp; Co.</dc:creator>").unwrap();
        let grace = xml.find("<dc:creator>Grace</dc:creator>").unwrap();
        assert!(ada < grace);
        assert!(!xml.contains("<dc:creator>Editor</dc:creator>"));
        assert!(!xml.contains("<dc:creator>Legacy</dc:creator>"));

        let feed: serde_json::Value = serde_json::from_str(&json_feed(&site).unwrap()).unwrap();
        assert_eq!(feed["authors"][0]["name"], "Legacy");
        assert_eq!(feed["items"][0]["authors"][0]["name"], "Ada & Co.");
        assert_eq!(feed["items"][0]["authors"][0]["url"], "https://ada.example");
        assert_eq!(feed["items"][0]["authors"][1]["name"], "Grace");
        assert_eq!(feed["items"][0]["authors"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn snapshot_json_and_sitemap() {
        let snap: serde_json::Value =
            serde_json::from_str(&portfolio_snapshot(&site(), 4).unwrap()).unwrap();
        assert_eq!(snap["schemaVersion"], 1);
        assert_eq!(snap["posts"][0]["link"], "https://j.io/a/");
        assert_eq!(snap["posts"][0]["date"], "2026-10-21T04:15:10Z");
        let map = sitemap(&site(), &["/search/".into()]);
        assert!(map.contains("<loc>https://j.io/tags/rust/</loc>"));
        assert!(map.contains("<loc>https://j.io/search/</loc>"));
        let feed: serde_json::Value = serde_json::from_str(&json_feed(&site()).unwrap()).unwrap();
        assert_eq!(feed["items"][1]["title"], "B");
        assert!(feed["items"][0].get("authors").is_none());
        assert!(search_index(&site()).contains("\"version\":1"));
        let index = llms_index(&site()).unwrap();
        assert!(index.contains("[A & B](https://j.io/a/): Hello x"));
        assert!(index.contains("[Sitemap](https://j.io/sitemap.xml)"));
        let full = llms_full(&site()).unwrap();
        assert!(full.contains("## A & B"));
        assert!(full.contains("- Published: 2026-10-21"));
        assert!(full.contains("Hello x"));
    }

    #[test]
    fn public_portable_feeds_omit_preview_drafts() {
        let mut site = site();
        site.posts[0].draft = true;

        assert!(!rss(&site).unwrap().contains("A &amp; B"));
        assert!(!json_feed(&site).unwrap().contains("A & B"));
        assert!(!portfolio_snapshot(&site, 4).unwrap().contains("A & B"));
        assert!(!llms_index(&site).unwrap().contains("A & B"));
        assert!(!llms_full(&site).unwrap().contains("A & B"));
    }

    #[test]
    fn robots_separates_ai_search_from_training_policy() {
        let mut site = site();
        site.config.seo.ai_search = true;
        site.config.seo.ai_training = false;
        let text = robots(&site);
        assert!(text.contains("User-agent: OAI-SearchBot\nAllow: /"));
        assert!(text.contains("User-agent: PerplexityBot\nAllow: /"));
        assert!(text.contains("User-agent: GPTBot\nDisallow: /"));
        assert!(text.contains("User-agent: Google-Extended\nDisallow: /"));
        assert!(text.contains("User-agent: *\nAllow: /"));
    }

    #[test]
    fn llms_index_escapes_markdown_control_characters_in_labels() {
        let mut site = site();
        site.posts[0].title = "A ](https://wrong.example)[ title".into();
        let text = llms_index(&site).unwrap();
        assert!(text.contains("[A \\](https://wrong.example)\\[ title](https://j.io/a/)"));
    }
}
