//! Import a Hashnode blog into Markdown files.
//!
//! Two sources, same output:
//!
//! - **public** (default, free): reads the pages your readers already see.
//!   The sitemap lists every post, and each post page carries schema.org
//!   JSON-LD (title, dates, cover, keywords) plus the rendered article body,
//!   which is converted back to Markdown. No account or token is needed.
//! - **graphql**: Hashnode's GraphQL API returns the original Markdown exactly.
//!   Since May 2026 it requires a Pro plan on the publication and a personal
//!   access token (`--token` or `HASHNODE_TOKEN`).

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use openblog_core::frontmatter::{self, Value};
use openblog_core::slug::slugify;
use openblog_core::DateTime;
use serde_json::{json, Value as Json};

use crate::fsutil;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Public,
    GraphQl,
}

pub struct ImportOptions {
    pub host: String,
    pub source: Source,
    pub token: Option<String>,
    pub content_dir: PathBuf,
    pub static_dir: PathBuf,
    pub download_images: bool,
    /// Replace post files that exist and differ (edited since the last import).
    pub overwrite: bool,
    pub limit: Option<usize>,
    pub delay_ms: u64,
    /// The site's `postPath`; when it is not `/{slug}/`, imported posts get an alias.
    pub post_path: String,
}

#[derive(Debug, Default, Clone)]
struct ImportedPost {
    slug: String,
    title: String,
    subtitle: Option<String>,
    date: String,
    updated: Option<String>,
    description: String,
    tags: Vec<String>,
    series: Option<String>,
    series_order: Option<u32>,
    cover: Option<String>,
    markdown: String,
    source_url: String,
    /// Remote image URLs found in the body, to download and rewrite.
    images: Vec<String>,
    /// The original `/slug/` address, kept as a redirect when `postPath` moves posts.
    alias: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct ImportedSeries {
    slug: String,
    name: String,
    description: String,
    cover: Option<String>,
    /// Post URLs in reading order.
    post_urls: Vec<String>,
}

#[derive(Default)]
pub struct ImportReport {
    pub posts_written: usize,
    pub posts_unchanged: usize,
    pub series_written: usize,
    pub images_downloaded: usize,
    pub skipped: Vec<String>,
    pub image_failures: Vec<String>,
}

pub fn run(options: &ImportOptions) -> Result<ImportReport, String> {
    let base = normalize_host(&options.host)?;
    let agent = http_agent();
    let (mut posts, series) = match options.source {
        Source::Public => import_public(&agent, &base, options)?,
        Source::GraphQl => import_graphql(&agent, &base, options)?,
    };
    if posts.is_empty() {
        return Err("no posts were found to import".into());
    }

    // Series order from the series pages (public source).
    let order: HashMap<String, (String, u32)> = series
        .iter()
        .flat_map(|s| {
            s.post_urls
                .iter()
                .enumerate()
                .map(move |(i, u)| (u.clone(), (s.slug.clone(), i as u32 + 1)))
        })
        .collect();
    for post in &mut posts {
        if let Some((series_slug, n)) = order.get(&post.source_url) {
            if post.series.as_deref() == Some(series_slug.as_str()) {
                post.series_order = Some(*n);
            }
        }
    }

    let mut report = ImportReport::default();
    let mut downloaded: HashMap<String, String> = HashMap::new();

    for post in &mut posts {
        if options.post_path != "/{slug}/" {
            post.alias = Some(format!("/{}/", post.slug));
        }
        let (kept, dropped) = clean_tags(std::mem::take(&mut post.tags));
        post.tags = kept;
        for tag in dropped {
            let shown: String = tag.chars().take(60).collect();
            report.skipped.push(format!(
                "dropped tag on `{}`: \"{shown}{}\"",
                post.slug,
                if tag.chars().count() > 60 { "..." } else { "" }
            ));
        }
        if options.download_images {
            localize_images(&agent, post, options, &mut downloaded, &mut report);
        }
        let file =
            options
                .content_dir
                .join("posts")
                .join(format!("{}-{}.md", ymd(&post.date), post.slug));
        let text = render_post_file(post);
        let existing = fs::read_to_string(&file).ok();
        if existing.as_deref() == Some(text.as_str()) {
            report.posts_unchanged += 1;
        } else if existing.is_some() && !options.overwrite {
            report.skipped.push(format!(
                "posts/{}-{}.md differs from the import (edited?); kept your version. Use --overwrite to replace it",
                ymd(&post.date),
                post.slug
            ));
            report.posts_unchanged += 1;
        } else {
            fsutil::write_file(&file, text.as_bytes())?;
            report.posts_written += 1;
        }
    }

    for s in &series {
        if !posts
            .iter()
            .any(|p| p.series.as_deref() == Some(s.slug.as_str()))
        {
            continue;
        }
        let mut cover = s.cover.clone();
        if options.download_images {
            if let Some(url) = &s.cover {
                if let Some(local) = fetch_image(
                    &agent,
                    url,
                    options,
                    &format!("series-{}", s.slug),
                    "cover",
                    &mut downloaded,
                    &mut report,
                ) {
                    cover = Some(local);
                }
            }
        }
        let mut fields: Vec<(&str, Value)> = vec![("name", Value::Scalar(s.name.clone()))];
        if let Some(c) = &cover {
            fields.push(("cover", Value::Scalar(c.clone())));
        }
        if !s.description.is_empty() {
            fields.push(("description", Value::Scalar(s.description.clone())));
        }
        let mut text = frontmatter::serialize(&fields);
        text.push('\n');
        if !s.description.is_empty() {
            text.push_str(&s.description);
            text.push('\n');
        }
        let file = options
            .content_dir
            .join("series")
            .join(format!("{}.md", s.slug));
        // Series files may have been customised (theme!), so never overwrite one.
        if file.exists() {
            report.skipped.push(format!(
                "series/{}.md already exists; kept your version",
                s.slug
            ));
        } else {
            fsutil::write_file(&file, text.as_bytes())?;
            report.series_written += 1;
        }
    }
    Ok(report)
}

// ---------------------------------------------------------------------------
// Public source
// ---------------------------------------------------------------------------

fn import_public(
    agent: &ureq::Agent,
    base: &str,
    options: &ImportOptions,
) -> Result<(Vec<ImportedPost>, Vec<ImportedSeries>), String> {
    println!("Reading {base}/sitemap.xml ...");
    let urls = discover_post_urls(agent, base)?;
    println!("Found {} candidate pages.", urls.len());

    let mut posts = Vec::new();
    let mut series_slugs: BTreeMap<String, ()> = BTreeMap::new();
    let total = options.limit.map_or(urls.len(), |l| l.min(urls.len()));
    for (i, url) in urls.iter().take(total).enumerate() {
        thread::sleep(Duration::from_millis(options.delay_ms));
        match get_text(agent, url).and_then(|html| parse_post_page(url, &html)) {
            Ok(Some(post)) => {
                println!("  [{}/{}] {}", i + 1, total, post.title);
                if let Some(s) = &post.series {
                    series_slugs.insert(s.clone(), ());
                }
                posts.push(post);
            }
            Ok(None) => println!("  [{}/{}] skipped {url} (not a blog post)", i + 1, total),
            Err(e) => eprintln!("  [{}/{}] FAILED {url}: {e}", i + 1, total),
        }
    }

    let mut series = Vec::new();
    for slug in series_slugs.keys() {
        thread::sleep(Duration::from_millis(options.delay_ms));
        let url = format!("{base}/series/{slug}");
        match get_text(agent, &url).and_then(|html| parse_series_page(slug, &html)) {
            Ok(s) => series.push(s),
            Err(e) => eprintln!("  could not read series {slug}: {e}"),
        }
    }
    Ok((posts, series))
}

fn discover_post_urls(agent: &ureq::Agent, base: &str) -> Result<Vec<String>, String> {
    let root = get_text(agent, &format!("{base}/sitemap.xml"))?;
    let mut sitemap_pages: Vec<String> = Vec::new();
    let locs = tag_values(&root, "loc");
    if root.contains("<sitemapindex") || locs.iter().any(|l| l.contains("sitemap.xml?page=")) {
        sitemap_pages.extend(locs.iter().filter(|l| l.contains("sitemap")).cloned());
    } else {
        sitemap_pages.push(format!("{base}/sitemap.xml"));
    }
    let mut urls = Vec::new();
    for page in sitemap_pages {
        let xml = get_text(agent, &page)?;
        for loc in tag_values(&xml, "loc") {
            if let Some(path) = loc.strip_prefix(base) {
                let path = path.trim_matches('/');
                // Posts live at /<slug>. Skip home, /tag/x, /series/x, /archive, and sitemaps.
                if path.is_empty() || path.contains('/') || path.contains('?') || path.contains('.')
                {
                    continue;
                }
                if matches!(
                    path,
                    "archive" | "members" | "series" | "tag" | "newsletter" | "badge"
                ) {
                    continue;
                }
                if !urls.contains(&loc) {
                    urls.push(loc);
                }
            }
        }
    }
    if urls.is_empty() {
        return Err(format!(
            "{base}/sitemap.xml listed no posts; is the host correct?"
        ));
    }
    Ok(urls)
}

fn parse_post_page(url: &str, html: &str) -> Result<Option<ImportedPost>, String> {
    let blocks = json_ld_blocks(html);
    let Some(post) = blocks.iter().find(|b| b["@type"] == "BlogPosting") else {
        return Ok(None);
    };
    let slug = url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string();
    let title = post["headline"].as_str().unwrap_or("").trim().to_string();
    if slug.is_empty() || title.is_empty() {
        return Err("page has no slug or headline".into());
    }
    let date = post["datePublished"]
        .as_str()
        .ok_or("page has no datePublished")?
        .to_string();
    let modified = post["dateModified"].as_str().map(str::to_string);
    let updated = modified.filter(|m| ymd(m) != ymd(&date));

    let description = meta_content(html, "name", "description")
        .or_else(|| meta_content(html, "property", "og:description"))
        .or_else(|| post["description"].as_str().map(str::to_string))
        .unwrap_or_default();

    let cover = meta_content(html, "property", "og:image")
        .or_else(|| post["image"]["url"].as_str().map(str::to_string))
        .or_else(|| post["image"].as_str().map(str::to_string));

    let keyword_tags: Vec<String> = post["keywords"]
        .as_str()
        .map(|k| {
            k.split(',')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let tags = if keyword_tags.is_empty() {
        link_slugs(html, "/tag/")
    } else {
        keyword_tags
    };
    let series = link_slugs(html, "/series/").into_iter().next();

    let body = extract_prose(html)
        .ok_or("could not find the article body; Hashnode's page markup may have changed")?;
    let body = strip_heading_anchors(&body);
    let images = image_urls(&body);
    let markdown = html_to_markdown(&body)?;

    Ok(Some(ImportedPost {
        slug,
        title,
        subtitle: extract_subtitle(html),
        date,
        updated,
        description,
        tags,
        series,
        series_order: None,
        cover,
        markdown,
        source_url: url.to_string(),
        images,
        alias: None,
    }))
}

fn parse_series_page(slug: &str, html: &str) -> Result<ImportedSeries, String> {
    let blocks = json_ld_blocks(html);
    let page = blocks
        .iter()
        .find(|b| b["@type"] == "CollectionPage")
        .ok_or("series page has no CollectionPage data")?;
    Ok(ImportedSeries {
        slug: slug.to_string(),
        name: page["name"].as_str().unwrap_or(slug).trim().to_string(),
        description: page["description"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string(),
        cover: page["image"]["url"].as_str().map(str::to_string),
        post_urls: page["hasPart"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p["url"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

// ---------------------------------------------------------------------------
// GraphQL source (requires a Hashnode Pro plan)
// ---------------------------------------------------------------------------

const GRAPHQL_ENDPOINT: &str = "https://gql.hashnode.com";

const POSTS_QUERY: &str = "query Posts($host: String!, $first: Int!, $after: String) {
  publication(host: $host) {
    posts(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        slug title subtitle brief publishedAt updatedAt url canonicalUrl
        coverImage { url }
        tags { name slug }
        series { name slug }
        content { markdown }
      } }
    }
    seriesList(first: 50) { edges { node { name slug description { markdown } coverImage } } }
  }
}";

fn import_graphql(
    agent: &ureq::Agent,
    base: &str,
    options: &ImportOptions,
) -> Result<(Vec<ImportedPost>, Vec<ImportedSeries>), String> {
    let token = options
        .token
        .clone()
        .or_else(|| std::env::var("HASHNODE_TOKEN").ok())
        .ok_or(
            "the GraphQL source needs a personal access token: pass --token or set HASHNODE_TOKEN",
        )?;
    let host = base
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let mut posts = Vec::new();
    let mut series: Vec<ImportedSeries> = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let body = json!({ "query": POSTS_QUERY, "variables": { "host": host, "first": 20, "after": after } });
        let response = agent
            .post(GRAPHQL_ENDPOINT)
            .header("Content-Type", "application/json")
            .header("Authorization", &token)
            .send(body.to_string().as_str())
            .map_err(|e| format!("GraphQL request failed: {e}"))?
            .body_mut()
            .read_to_vec()
            .map_err(|e| format!("cannot read GraphQL response: {e}"))?;
        let value: Json = serde_json::from_slice(&response).map_err(|_| {
            "Hashnode returned a web page instead of JSON. Its GraphQL API now requires a Pro plan on the publication; \
             use the default public source (omit --source graphql) if you do not have Pro."
                .to_string()
        })?;
        if let Some(message) = value["errors"][0]["message"].as_str() {
            return Err(format!("Hashnode GraphQL error: {message}"));
        }
        let publication = &value["data"]["publication"];
        if publication.is_null() {
            return Err(format!("Hashnode has no publication for host `{host}`"));
        }
        if series.is_empty() {
            for edge in publication["seriesList"]["edges"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let n = &edge["node"];
                series.push(ImportedSeries {
                    slug: n["slug"].as_str().unwrap_or("").to_string(),
                    name: n["name"].as_str().unwrap_or("").to_string(),
                    description: n["description"]["markdown"]
                        .as_str()
                        .unwrap_or("")
                        .trim()
                        .to_string(),
                    cover: n["coverImage"].as_str().map(str::to_string),
                    post_urls: Vec::new(),
                });
            }
        }
        for edge in publication["posts"]["edges"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let n = &edge["node"];
            let markdown = n["content"]["markdown"].as_str().unwrap_or("").to_string();
            let updated = n["updatedAt"].as_str().map(str::to_string);
            let date = n["publishedAt"].as_str().unwrap_or("").to_string();
            posts.push(ImportedPost {
                slug: n["slug"].as_str().unwrap_or("").to_string(),
                title: n["title"].as_str().unwrap_or("").trim().to_string(),
                subtitle: n["subtitle"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                updated: updated.filter(|u| ymd(u) != ymd(&date)),
                date,
                description: n["brief"].as_str().unwrap_or("").to_string(),
                tags: n["tags"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t["name"].as_str().map(str::to_string))
                    .collect(),
                series: n["series"]["slug"].as_str().map(str::to_string),
                series_order: None,
                cover: n["coverImage"]["url"].as_str().map(str::to_string),
                images: markdown_image_urls(&markdown),
                markdown,
                source_url: n["url"].as_str().unwrap_or("").to_string(),
                alias: None,
            });
            if options.limit.is_some_and(|l| posts.len() >= l) {
                return Ok((posts, series));
            }
        }
        let info = &publication["posts"]["pageInfo"];
        if info["hasNextPage"].as_bool() == Some(true) {
            after = info["endCursor"].as_str().map(str::to_string);
            thread::sleep(Duration::from_millis(options.delay_ms));
        } else {
            break;
        }
    }
    Ok((posts, series))
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

fn localize_images(
    agent: &ureq::Agent,
    post: &mut ImportedPost,
    options: &ImportOptions,
    downloaded: &mut HashMap<String, String>,
    report: &mut ImportReport,
) {
    if let Some(cover) = post.cover.clone() {
        if let Some(local) = fetch_image(
            agent, &cover, options, &post.slug, "cover", downloaded, report,
        ) {
            post.cover = Some(local);
        }
    }
    let urls = post.images.clone();
    for (i, url) in urls.iter().enumerate() {
        if let Some(local) = fetch_image(
            agent,
            url,
            options,
            &post.slug,
            &format!("{:02}", i + 1),
            downloaded,
            report,
        ) {
            post.markdown = post.markdown.replace(url.as_str(), &local);
        }
    }
}

/// Download one image to `static/images/<folder>/` and return its site path.
/// Failures are recorded and the remote URL is kept, so one dead image never
/// blocks the import.
fn fetch_image(
    agent: &ureq::Agent,
    url: &str,
    options: &ImportOptions,
    folder: &str,
    stem: &str,
    downloaded: &mut HashMap<String, String>,
    report: &mut ImportReport,
) -> Option<String> {
    if let Some(local) = downloaded.get(url) {
        return Some(local.clone());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return None;
    }
    let result = (|| -> Result<String, String> {
        let mut response = agent.get(url).call().map_err(|e| e.to_string())?;
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = response
            .body_mut()
            .with_config()
            .limit(25 * 1024 * 1024)
            .read_to_vec()
            .map_err(|e| e.to_string())?;
        let ext = extension_for(url, &content_type);
        let name = format!("{stem}.{ext}");
        let dest = options.static_dir.join("images").join(folder).join(&name);
        fsutil::write_file(&dest, &bytes)?;
        Ok(format!("/images/{folder}/{name}"))
    })();
    match result {
        Ok(local) => {
            report.images_downloaded += 1;
            downloaded.insert(url.to_string(), local.clone());
            Some(local)
        }
        Err(e) => {
            report
                .image_failures
                .push(format!("{url} ({e}) used by {folder}"));
            None
        }
    }
}

fn extension_for(url: &str, content_type: &str) -> String {
    let from_type = match content_type.split(';').next().unwrap_or("").trim() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "image/avif" => Some("avif"),
        _ => None,
    };
    if let Some(ext) = from_type {
        return ext.to_string();
    }
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let last = path.rsplit('/').next().unwrap_or("");
    match last.rsplit_once('.') {
        Some((_, ext))
            if (1..=5).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            ext.to_ascii_lowercase()
        }
        _ => "bin".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

fn render_post_file(post: &ImportedPost) -> String {
    let mut fields: Vec<(&str, Value)> = vec![("title", Value::Scalar(post.title.clone()))];
    if let Some(s) = &post.subtitle {
        fields.push(("subtitle", Value::Scalar(s.clone())));
    }
    fields.push(("slug", Value::Scalar(post.slug.clone())));
    fields.push(("date", Value::Scalar(post.date.clone())));
    if let Some(u) = &post.updated {
        fields.push(("updated", Value::Scalar(u.clone())));
    }
    if !post.description.is_empty() {
        fields.push(("description", Value::Scalar(post.description.clone())));
    }
    if !post.tags.is_empty() {
        fields.push(("tags", Value::List(post.tags.clone())));
    }
    if let Some(s) = &post.series {
        fields.push(("series", Value::Scalar(s.clone())));
    }
    if let Some(n) = post.series_order {
        fields.push(("seriesOrder", Value::Scalar(n.to_string())));
    }
    if let Some(c) = &post.cover {
        fields.push(("cover", Value::Scalar(c.clone())));
    }
    if !post.source_url.is_empty() {
        fields.push(("sourceUrl", Value::Scalar(post.source_url.clone())));
    }
    if let Some(alias) = &post.alias {
        fields.push(("aliases", Value::List(vec![alias.clone()])));
    }
    let mut out = frontmatter::serialize(&fields);
    out.push('\n');
    out.push_str(post.markdown.trim());
    out.push('\n');
    out
}

/// Tidy imported tags. Strips a leading `#`, removes case-insensitive
/// duplicates, and drops keyword dumps (over 40 characters, or still holding a
/// `#` after cleaning), which would each become a useless tag page.
/// Returns (kept, dropped).
fn clean_tags(tags: Vec<String>) -> (Vec<String>, Vec<String>) {
    let mut kept: Vec<String> = Vec::new();
    let mut dropped = Vec::new();
    for raw in tags {
        let name = raw.trim().trim_start_matches('#').trim().to_string();
        if name.is_empty() {
            continue;
        }
        if name.chars().count() > 40 || name.contains('#') {
            dropped.push(raw);
            continue;
        }
        if !kept.iter().any(|k| k.eq_ignore_ascii_case(&name)) {
            kept.push(name);
        }
    }
    (kept, dropped)
}

fn ymd(date: &str) -> String {
    DateTime::parse(date)
        .map(|d| d.ymd())
        .unwrap_or_else(|| date.chars().take(10).collect())
}

// ---------------------------------------------------------------------------
// HTML helpers (string scanning; the public pages are machine-generated)
// ---------------------------------------------------------------------------

fn normalize_host(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let host = without_scheme.split('/').next().unwrap_or("");
    if host.is_empty() || !host.contains('.') || host.contains(char::is_whitespace) {
        return Err(format!(
            "`{input}` is not a blog host like `yourname.hashnode.dev` or `blog.example.com`"
        ));
    }
    Ok(format!("https://{host}"))
}

fn tag_values(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else { break };
        out.push(decode_entities(after[..end].trim()));
        rest = &after[end + close.len()..];
    }
    out
}

fn json_ld_blocks(html: &str) -> Vec<Json> {
    let marker = "<script type=\"application/ld+json\">";
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find(marker) {
        let after = &rest[start + marker.len()..];
        let Some(end) = after.find("</script>") else {
            break;
        };
        if let Ok(value) = serde_json::from_str::<Json>(&after[..end]) {
            out.push(value);
        }
        rest = &after[end..];
    }
    out
}

fn meta_content(html: &str, key_attr: &str, key: &str) -> Option<String> {
    let needle = format!("{key_attr}=\"{key}\"");
    let mut rest = html;
    while let Some(start) = rest.find("<meta ") {
        let tag_rest = &rest[start..];
        let end = tag_rest.find('>')?;
        let tag = &tag_rest[..end];
        if tag.contains(&needle) {
            let c = tag.find("content=\"")? + "content=\"".len();
            let value = &tag[c..];
            return Some(decode_entities(&value[..value.find('"')?]));
        }
        rest = &tag_rest[end..];
    }
    None
}

fn link_slugs(html: &str, prefix: &str) -> Vec<String> {
    let needle = format!("href=\"{prefix}");
    let mut out: Vec<String> = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find(&needle) {
        let after = &rest[start + needle.len()..];
        let Some(end) = after.find('"') else { break };
        let slug = &after[..end];
        if !slug.is_empty() && !slug.contains('/') && !out.iter().any(|s| s == slug) {
            out.push(slug.to_string());
        }
        rest = &after[end..];
    }
    out
}

/// The inner HTML of Hashnode's article container.
/// The subheading Hashnode renders in a `text-subtitle` paragraph directly after the post's
/// `<h1>`. It is anchored to the heading so a `.subtitle` in the article body (sample code, a
/// stylesheet) is never mistaken for it.
fn extract_subtitle(html: &str) -> Option<String> {
    let h1 = html.find("<h1")?;
    let after = &html[h1..];
    let close = after.find("</h1>")? + "</h1>".len();
    let next = after[close..].trim_start();
    let paragraph = next.strip_prefix("<p")?;
    let open_end = paragraph.find('>')?;
    if !paragraph[..open_end]
        .split(|c: char| c.is_whitespace() || c == '"' || c == '=')
        .any(|word| word == "text-subtitle")
    {
        return None;
    }
    let inner = &paragraph[open_end + 1..];
    let text = decode_entities(&strip_tags(&inner[..inner.find("</p>")?]));
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn extract_prose(html: &str) -> Option<String> {
    let start = html.find("class=\"prose prose-reading")?;
    let open_end = html[start..].find('>')? + start + 1;
    let mut depth = 1usize;
    let mut pos = open_end;
    loop {
        let next_open = html[pos..].find("<div");
        let next_close = html[pos..].find("</div>");
        match (next_open, next_close) {
            (Some(o), Some(c)) if o < c => {
                depth += 1;
                pos += o + 4;
            }
            (_, Some(c)) => {
                depth -= 1;
                if depth == 0 {
                    return Some(html[open_end..pos + c].to_string());
                }
                pos += c + 6;
            }
            _ => return None,
        }
    }
}

fn strip_heading_anchors(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find("<a class=\"heading-anchor\"") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</a>") {
            Some(end) => rest = &rest[start + end + 4..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

fn image_urls(html: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find("<img") {
        let tag_rest = &rest[start..];
        let end = tag_rest.find('>').unwrap_or(tag_rest.len());
        let tag = &tag_rest[..end];
        if let Some(s) = tag.find(" src=\"") {
            let value = &tag[s + 6..];
            if let Some(e) = value.find('"') {
                let url = decode_entities(&value[..e]);
                if url.starts_with("http") && !out.contains(&url) {
                    out.push(url);
                }
            }
        }
        rest = &tag_rest[end..];
    }
    out
}

fn markdown_image_urls(markdown: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = markdown;
    while let Some(start) = rest.find("![") {
        let after = &rest[start..];
        let Some(open) = after.find("](") else { break };
        let value = &after[open + 2..];
        let Some(close) = value.find(')') else { break };
        let url = value[..close]
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
        if url.starts_with("http") && !out.contains(&url) {
            out.push(url);
        }
        rest = &value[close..];
    }
    out
}

fn html_to_markdown(html: &str) -> Result<String, String> {
    use htmd::options::{BulletListMarker, HrStyle, Options};
    let converter = htmd::HtmlToMarkdown::builder()
        .options(Options {
            hr_style: HrStyle::Dashes,
            bullet_list_marker: BulletListMarker::Dash,
            ..Options::default()
        })
        .build();
    let markdown = converter
        .convert(html)
        .map_err(|e| format!("HTML to Markdown conversion failed: {e}"))?;
    Ok(lift_code_labels(&normalize_rules(markdown.trim())))
}

/// Hashnode shows a language label above each code block, and the HTML
/// conversion glues it onto the first line of code: `bashgit push`,
/// `javascript// note`. Move such a label onto the fence instead, so the code
/// reads right and the highlighter knows its language.
fn lift_code_labels(markdown: &str) -> String {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim_start();
        let Some(marker) = t.chars().next().filter(|c| *c == '`' || *c == '~') else {
            out.push(line.to_string());
            i += 1;
            continue;
        };
        let fence_len = t.chars().take_while(|c| *c == marker).count();
        if fence_len < 3 {
            out.push(line.to_string());
            i += 1;
            continue;
        }
        let fence = &t[..fence_len];
        let info = t[fence_len..].trim();
        out.push(line.to_string());
        i += 1;
        if info.is_empty() && i < lines.len() {
            if let Some((label, code)) = split_code_label(lines[i]) {
                let last = out.len() - 1;
                out[last] = format!("{}{}", line.trim_end(), label);
                out.push(code);
                i += 1;
            }
        }
        // Copy the block through its closing fence untouched.
        while i < lines.len() {
            let l = lines[i];
            out.push(l.to_string());
            i += 1;
            let lt = l.trim_start();
            if lt.starts_with(fence) && lt.trim_start_matches(marker).trim().is_empty() {
                break;
            }
        }
    }
    out.join("\n")
}

/// `bashgit push` -> ("bash", "git push"). Only when the label is clearly
/// glued on: followed by a symbol that starts code, or by a common first word.
fn split_code_label(line: &str) -> Option<(&'static str, String)> {
    const LABELS: &[&str] = &[
        "javascript",
        "typescript",
        "plaintext",
        "powershell",
        "markdown",
        "python",
        "shell",
        "scss",
        "rust",
        "bash",
        "html",
        "json",
        "yaml",
        "text",
        "java",
        "css",
        "sql",
        "xml",
        "jsx",
        "tsx",
        "cpp",
        "go",
        "ts",
        "js",
        "sh",
    ];
    const STARTERS: &[&str] = &[
        "git ",
        "npm ",
        "npx ",
        "yarn ",
        "pnpm ",
        "cargo ",
        "cd ",
        "mkdir ",
        "echo ",
        "curl ",
        "docker ",
        "const ",
        "let ",
        "var ",
        "function ",
        "async ",
        "class ",
        "import ",
        "export ",
        "fn ",
        "use ",
        "pub ",
        "def ",
        "from ",
        "if ",
        "for ",
        "await ",
    ];
    let trimmed = line.trim_start();
    let indent = &line[..line.len() - trimmed.len()];
    LABELS.iter().find_map(|label| {
        let rest = trimmed.strip_prefix(label)?;
        let next = rest.chars().next()?;
        let glued = "#/$<{@[!*".contains(next) || STARTERS.iter().any(|s| rest.starts_with(s));
        glued.then(|| (*label, format!("{indent}{rest}")))
    })
}

/// htmd writes horizontal rules as `- - -`; use the conventional `---`.
/// Lines inside fenced code blocks are left alone.
fn normalize_rules(markdown: &str) -> String {
    let mut in_fence = false;
    let mut out = Vec::new();
    for line in markdown.lines() {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            in_fence = !in_fence;
        }
        if !in_fence && line.trim() == "- - -" {
            out.push("---");
        } else {
            out.push(line);
        }
    }
    out.join(
        "
",
    )
}

fn decode_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        match tail.find(';').filter(|&semi| semi <= 10) {
            Some(semi) => {
                let entity = &tail[1..semi];
                let decoded = match entity {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    e if e.starts_with("#x") || e.starts_with("#X") => {
                        u32::from_str_radix(&e[2..], 16)
                            .ok()
                            .and_then(char::from_u32)
                    }
                    e if e.starts_with('#') => e[1..].parse::<u32>().ok().and_then(char::from_u32),
                    _ => None,
                };
                match decoded {
                    Some(c) => {
                        out.push(c);
                        rest = &tail[semi + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = &tail[1..];
                    }
                }
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .user_agent("open.blog-importer/0.1 (+https://github.com/journey-to-code-org/open.blog)")
        .build()
        .into()
}

fn get_text(agent: &ureq::Agent, url: &str) -> Result<String, String> {
    let mut response = agent
        .get(url)
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?;
    let bytes = response
        .body_mut()
        .with_config()
        .limit(20 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| format!("reading {url}: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Keep `slugify` linked for tag normalisation in callers.
#[allow(dead_code)]
fn tag_slug(name: &str) -> String {
    slugify(name)
}

#[allow(dead_code)]
fn content_posts_dir(content: &Path) -> PathBuf {
    content.join("posts")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r##"<html><head>
<meta name="description" content="Learn &amp; build &#x27;things&#x27;">
<meta property="og:image" content="https://cdn.example.com/c.png">
<script type="application/ld+json">{"@type":"BlogPosting","headline":"Hello &amp; World","datePublished":"2026-10-21T04:15:10.033Z","dateModified":"2026-10-22T01:00:00.000Z","keywords":"rust lang, WebAssembly"}</script>
</head><body>
<h1 class="text-article-title">Hello &amp; World</h1><p class="text-subtitle text-pretty text-muted-foreground">Build <em>things</em> &amp; learn&#x27;s   more</p>
<a href="/series/my-series">Part of series</a><a href="/tag/rust-lang">#rust</a>
<div class="prose prose-reading x"><div><h2 id="a"><a class="heading-anchor" href="#a"><svg><line/></svg></a>Intro</h2>
<p>Text with <code>code</code> and <img src="https://cdn.example.com/i.png?w=1&amp;h=2" alt="pic"></p>
<pre><code class="language-rust">fn main() {}
</code></pre></div></div><footer>after</footer></body></html>"##;

    #[test]
    fn parses_a_public_post_page() {
        let post = parse_post_page("https://blog.example.com/hello", PAGE)
            .unwrap()
            .unwrap();
        assert_eq!(post.slug, "hello");
        assert_eq!(post.title, "Hello &amp; World");
        assert_eq!(post.description, "Learn & build 'things'");
        assert_eq!(
            post.subtitle.as_deref(),
            Some("Build things & learn's more")
        );
        assert_eq!(post.tags, vec!["rust lang", "WebAssembly"]);
        assert_eq!(post.series.as_deref(), Some("my-series"));
        assert_eq!(post.cover.as_deref(), Some("https://cdn.example.com/c.png"));
        assert_eq!(post.updated.as_deref(), Some("2026-10-22T01:00:00.000Z"));
        assert_eq!(post.images, vec!["https://cdn.example.com/i.png?w=1&h=2"]);
        assert!(post.markdown.contains("## Intro"), "{}", post.markdown);
        assert!(!post.markdown.contains("heading-anchor"));
        assert!(
            post.markdown.contains("```rust\nfn main() {}\n```"),
            "{}",
            post.markdown
        );
        assert!(!post.markdown.contains("after"));
    }

    #[test]
    fn subtitle_comes_only_from_the_paragraph_after_the_heading() {
        let page = |after_h1: &str| {
            format!(
                "<h1>T</h1>{after_h1}<div class=\"prose prose-reading\"><p class=\"subtitle\">decoy</p></div>"
            )
        };
        assert_eq!(
            extract_subtitle(&page(
                "
  <p class=\"x text-subtitle y\">  Deck
 line </p>"
            ))
            .as_deref(),
            Some("Deck line")
        );
        assert_eq!(extract_subtitle(&page("")), None, "no subtitle paragraph");
        assert_eq!(
            extract_subtitle(&page("<p class=\"lead\">Not it</p>")),
            None,
            "a paragraph without the subtitle class"
        );
        assert_eq!(
            extract_subtitle(&page("<p class=\"text-subtitle-x\">Near miss</p>")),
            None,
            "a class that only starts with the name"
        );
        assert_eq!(
            extract_subtitle(&page("<p class=\"text-subtitle\">  </p>")),
            None
        );
        assert_eq!(
            extract_subtitle("<p class=\"text-subtitle\">No heading</p>"),
            None
        );
    }

    #[test]
    fn glued_code_labels_move_onto_the_fence() {
        let md = "```\nbashgit merge --no-ff topic\n```\n\n  ```\n  javascript// note\n  const a = 1;\n  ```\n\n```\ngo run main.go\n```\n\n```rust\nbash# kept\n```";
        assert_eq!(
            lift_code_labels(md),
            "```bash\ngit merge --no-ff topic\n```\n\n  ```javascript\n  // note\n  const a = 1;\n  ```\n\n```\ngo run main.go\n```\n\n```rust\nbash# kept\n```"
        );
        assert_eq!(
            split_code_label("bash$ mkdir app"),
            Some(("bash", "$ mkdir app".into()))
        );
        assert_eq!(
            split_code_label("javascriptconst x = 1;"),
            Some(("javascript", "const x = 1;".into()))
        );
        assert_eq!(split_code_label("json.dumps(x)"), None);
        assert_eq!(split_code_label("textContent = 'a'"), None);
    }

    #[test]
    fn rules_are_normalized_outside_code_only() {
        let md = "a

- - -

```
- - -
```
";
        assert_eq!(
            normalize_rules(md),
            "a

---

```
- - -
```"
        );
    }

    #[test]
    fn cleans_tags() {
        let long = format!("#{}", "GitThing ".repeat(20));
        let (kept, dropped) = clean_tags(vec![
            "#Git".into(),
            "git".into(),
            " Rust lang ".into(),
            long.clone(),
            "a #b".into(),
            "".into(),
        ]);
        assert_eq!(kept, vec!["Git", "Rust lang"]);
        assert_eq!(dropped, vec![long, "a #b".to_string()]);
    }

    #[test]
    fn non_posts_are_skipped() {
        let page = r#"<script type="application/ld+json">{"@type":"WebSite"}</script>"#;
        assert!(parse_post_page("https://x.dev/about", page)
            .unwrap()
            .is_none());
    }

    #[test]
    fn parses_series_pages_in_order() {
        let page = r#"<script type="application/ld+json">{"@type":"CollectionPage","name":"Rustbound","description":"Learn Rust\n","image":{"url":"https://c/i.png"},"hasPart":[{"url":"https://x.dev/a"},{"url":"https://x.dev/b"}]}</script>"#;
        let s = parse_series_page("rustbound", page).unwrap();
        assert_eq!(s.name, "Rustbound");
        assert_eq!(s.description, "Learn Rust");
        assert_eq!(s.post_urls, vec!["https://x.dev/a", "https://x.dev/b"]);
    }

    #[test]
    fn normalizes_hosts_and_sitemap_urls() {
        assert_eq!(
            normalize_host("https://blog.example.com/").unwrap(),
            "https://blog.example.com"
        );
        assert_eq!(
            normalize_host("me.hashnode.dev").unwrap(),
            "https://me.hashnode.dev"
        );
        assert!(normalize_host("nope").is_err());
        assert_eq!(
            tag_values(
                "<loc>https://a/b</loc><loc> https://a/c?x=1&amp;y=2 </loc>",
                "loc"
            ),
            vec!["https://a/b", "https://a/c?x=1&y=2"]
        );
    }

    #[test]
    fn extension_detection_and_markdown_images() {
        assert_eq!(extension_for("https://c/u.png?w=1", ""), "png");
        assert_eq!(
            extension_for("https://c/u", "image/webp; charset=x"),
            "webp"
        );
        assert_eq!(extension_for("https://c/u", ""), "bin");
        assert_eq!(
            markdown_image_urls("a ![x](https://c/1.png \"t\") b ![y](/local.png)"),
            vec!["https://c/1.png"]
        );
    }

    #[test]
    fn rendered_file_round_trips_through_the_site_loader() {
        let post = ImportedPost {
            slug: "hello".into(),
            title: "Hello: a `title`".into(),
            subtitle: Some("Why: it matters".into()),
            date: "2026-10-21T04:15:10.033Z".into(),
            description: "Desc".into(),
            tags: vec!["rust lang".into()],
            series: Some("s".into()),
            series_order: Some(2),
            markdown: "Body".into(),
            source_url: "https://x.dev/hello".into(),
            ..Default::default()
        };
        let text = render_post_file(&post);
        assert!(
            text.contains(
                "title: \"Hello: a `title`\"\nsubtitle: \"Why: it matters\"\nslug: hello\n"
            ),
            "{text}"
        );
        let config = openblog_core::SiteConfig::default();
        let loaded = openblog_core::model::load_post(
            &openblog_core::SourceFile {
                path: "posts/2026-10-21-hello.md".into(),
                contents: text,
            },
            &config,
            Default::default(),
        )
        .unwrap();
        assert_eq!(loaded.title, "Hello: a `title`");
        assert_eq!(loaded.subtitle.as_deref(), Some("Why: it matters"));
        assert_eq!(loaded.slug, "hello");
        assert_eq!(loaded.series_order, Some(2));
        assert_eq!(loaded.tags[0].slug, "rust-lang");
        assert_eq!(loaded.source_url.as_deref(), Some("https://x.dev/hello"));
    }
}
