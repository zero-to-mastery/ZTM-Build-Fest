//! HTML page generation. Pages are semantic HTML (`header`, `nav`, `main`,
//! `article`, `time`, `details`, ...) enhanced by autonomous custom elements.
//! Published content has static HTML fallbacks; optional interactions may
//! require JavaScript.
//!
//! Appearance comes entirely from CSS custom properties (`--ob-*`) written by
//! the theme, so the same markup can look like any theme.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use blake2::{Blake2s256, Digest};

use crate::atlas_publication::{
    self, DatedAspect, OwnerType, Placement, PublicAtlas, PublicDating, PublicEntry,
    PublicEvidence, PublicRelationship,
};
use crate::comparison_publication::{
    self, PublicComparison, PublicComparisons, PublicPlace, PublicText, PublicVersion, VersionKind,
};
use crate::config::SiteConfig;
use crate::contributor::{CreditProvenance, ResolvedCredit};
use crate::escape::{attr, cdata, text};
use crate::feeds;
use crate::knowledge_atlas::{EntryKind, Standing};
use crate::markdown::{self, RenderOptions};
use crate::model::{Post, Series, Site};
use crate::participation::{self, ParticipationKind, ParticipationMode};
use crate::reader_references::ReaderReferences;
use crate::theme::{Theme, ThemeSet};

pub(crate) mod interpretations;
mod landing;
pub(crate) mod piece;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputFile {
    /// Path relative to the output directory, always with forward slashes.
    pub path: String,
    pub contents: String,
}

/// Social metadata after site-level fallbacks and URL resolution are applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SocialMetadata {
    pub site_name: String,
    pub title: String,
    pub description: String,
    pub url: String,
    pub image: Option<String>,
    pub image_alt: Option<String>,
    pub kind: String,
    pub card: String,
}

/// Paths reserved by the generator. Pages and posts may not use them.
const RESERVED: &[&str] = &[
    "series", "tags", "archive", "search", "page", "themes", "assets", "api",
];
/// Reserved, too, while the site publishes its Knowledge Atlas.
const ATLAS_SEGMENT: &str = "atlas";
/// Reserved, too, while the site publishes passage comparisons.
const COMPARISONS_SEGMENT: &str = comparison_publication::COMPARISONS_SEGMENT;

struct Meta<'a> {
    title: String,
    description: String,
    path: String,
    canonical: Option<String>,
    kind: &'static str,
    image: Option<String>,
    image_alt: Option<String>,
    json_ld: Option<String>,
    /// The reader reference data of a post that publishes citations, as its
    /// `<script type="application/json">` element (ADR 0059); `None` on every
    /// other page, which is then written exactly as before.
    reader_references: Option<String>,
    /// The `<ob-citation-previews>` element that enhances the markers with
    /// previews from that data (ADR 0061), present exactly when the data is.
    citation_previews: Option<String>,
    /// Whether the page's concept links (ADR 0172) are enhanced with
    /// previews (ADR 0174): it loads `<ob-concept-previews>` and its element.
    /// `false` on every other page, which is then written exactly as before.
    /// The address of the query file the previews read, with its content
    /// version (`atlas-query.json?v=...`), when the page is enhanced.
    concept_previews: Option<String>,
    /// The published passage text of a post that offers passage feedback or
    /// Third Perspectives, as its `<script type="application/json">` element
    /// (ADRs 0082, 0114); `None` on every other page, which is then written
    /// exactly as before.
    passage_data: Option<String>,
    /// The participation forms' module scripts the page loads with its
    /// passage data, in the order their regions appear.
    participation_scripts: Vec<&'static str>,
    /// Whether the page carries the atlas timeline (ADR 0100), so it loads
    /// the `<ob-atlas-timeline>` component; `false` on every other page,
    /// which is then written exactly as before.
    atlas_timeline: bool,
    /// The page has a relationship trail (ADR 0175) whose filters
    /// `<ob-atlas-trail>` adds.
    atlas_trail: bool,
    /// The page is a reading path (#78), so it loads `<ob-reading-path>`,
    /// which adds optional progress kept in the reader's own browser.
    reading_path: bool,
    /// The page is an interpretation comparison with explanation levels, so it
    /// loads `<ob-explanation-levels>` (ADR 0232, #90).
    interpretation_levels: bool,
    theme: &'a Theme,
    published: Option<String>,
    modified: Option<String>,
    tags: Vec<String>,
    highwire: Vec<(&'static str, String)>,
    noindex: bool,
}

/// The query projection of the published atlas, projected once per build: its
/// JSON as written (base path applied, within its bound) and the model the
/// relationship trails (ADR 0175) are read from, so a page and the file agree.
struct QueryProjection {
    query: crate::atlas_query::AtlasQuery,
    json: String,
}

/// The curated research context, projected once per build: the model the pages
/// are rendered from and the JSON as written (base path applied, within its
/// bound), so a page and the file agree.
struct CuratedProjection {
    context: crate::curated_context::CuratedContext,
    json: String,
}

struct Renderer<'a> {
    site: &'a Site,
    themes: &'a HashMap<String, Theme>,
    /// What the site publishes about sources, read once on first use, for every post's evidence
    /// choices (ADR 0116).
    site_references: std::cell::OnceCell<crate::evidence_submission::SiteReferenceIndex>,
    /// The `atlas-query.json` the build writes, projected once on first use
    /// (`None` when the site publishes no atlas or the projection is refused
    /// or over its bound): the concept previews read that file and nothing
    /// else, and the file written is these bytes.
    atlas_query: std::cell::OnceCell<Option<QueryProjection>>,
    /// The curated research context the pages and `curated-context.json` are
    /// rendered from, projected once on first use (`None` when the site
    /// publishes none, or the projection is refused or over its bound: the
    /// pages' own sections then still render, the file is left out).
    curated: std::cell::OnceCell<Option<CuratedProjection>>,
    /// How many steps out every entry page's trail goes, decided once for the
    /// whole site against [`TRAIL_BUDGET_BYTES`] (ADR 0175).
    trail_depth: std::cell::OnceCell<TrailDepth>,
    trail_budget: usize,
}

/// The most trail markup the whole site may carry (ADR 0175). A site over it
/// shows every trail one step deep and says so in the build log.
pub const TRAIL_BUDGET_BYTES: usize = 20 * 1024 * 1024;

/// The build log's line for a site whose relationship trails together would
/// take more than [`TRAIL_BUDGET_BYTES`], so every entry page shows its trail
/// one step deep (ADR 0175); `None` when every trail keeps its full depth or
/// the site publishes no atlas.
pub fn atlas_trail_warning(site: &Site) -> Option<String> {
    atlas_trail_warning_with_budget(site, TRAIL_BUDGET_BYTES)
}

#[doc(hidden)]
pub fn atlas_trail_warning_with_budget(site: &Site, trail_budget: usize) -> Option<String> {
    let themes = HashMap::new();
    let renderer = Renderer {
        site,
        themes: &themes,
        site_references: Default::default(),
        atlas_query: Default::default(),
        curated: Default::default(),
        trail_depth: Default::default(),
        trail_budget,
    };
    let bytes = renderer.atlas_trail_depth().over_budget?;
    Some(format!(
        "knowledge atlas: relationship trails would add more than {} MB of markup (the site budget is {} MB), so every entry page shows its trail one step deep; each relationship's own page is unchanged",
        bytes.div_ceil(1024 * 1024),
        trail_budget.div_ceil(1024 * 1024)
    ))
}

/// How far the trails of a site go, and what that cost.
#[derive(Clone, Copy)]
struct TrailDepth {
    depth: usize,
    /// The bytes every trail would take at full depth, when that is over the budget.
    over_budget: Option<usize>,
}

struct Output {
    files: Vec<OutputFile>,
    seen: HashSet<String>,
}

struct SocialMetadataInput<'a> {
    title: &'a str,
    description: &'a str,
    path: &'a str,
    canonical: Option<&'a str>,
    kind: &'a str,
    image: Option<&'a str>,
    image_alt: Option<&'a str>,
}

fn resolve_social_metadata(config: &SiteConfig, input: SocialMetadataInput<'_>) -> SocialMetadata {
    let image = input
        .image
        .or((!config.og_image.is_empty()).then_some(config.og_image.as_str()))
        .map(|value| config.absolute(value));
    SocialMetadata {
        site_name: config.title.clone(),
        title: if input.title.is_empty() {
            config.title.clone()
        } else {
            input.title.to_string()
        },
        description: input.description.to_string(),
        url: input
            .canonical
            .map(str::to_string)
            .unwrap_or_else(|| config.absolute(input.path)),
        image_alt: input
            .image_alt
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        kind: input.kind.to_string(),
        card: if image.is_some() {
            "summary_large_image".to_string()
        } else {
            "summary".to_string()
        },
        image,
    }
}

/// The id of a post's feedback region, which the no-JavaScript text and any
/// participation link can target.
const FEEDBACK_ANCHOR: &str = "ob-feedback";
/// The id of a post's Third Perspective region (ADR 0114).
pub(crate) const THIRD_PERSPECTIVE_ANCHOR: &str = "ob-third-perspective";
/// The id of a post's suggestion region (RD13).
pub(crate) const FUTURE_SUGGESTION_ANCHOR: &str = "ob-future-suggestion";
/// The id of the page data element that holds a post's passage text.
pub const PASSAGE_DATA_ELEMENT_ID: &str = "ob-passages";
/// A post's region for the reader's own highlights and notes (ADR 0241). It
/// holds only text: the saved annotations never leave the reader's browser.
const READER_ANNOTATIONS_REGION: &str = "<section id=\"ob-annotations\" class=\"ob-annotations\" aria-labelledby=\"ob-annotations-title\">
<h2 id=\"ob-annotations-title\">Your highlights and notes</h2>
<ob-annotations>
<p class=\"ob-annotations-static\">Highlights and private notes need JavaScript. With it, you can mark words in this post and add notes that stay in this browser only; nothing is sent to anyone. Without it, the post reads as usual.</p>
</ob-annotations>
</section>
";
/// A post's region for the reader's own saved sources and reading trails
/// (ADR 0242), beside the highlights. It holds only text: a trail is built by
/// hand in the reader's browser and nothing is recorded as they read. The same
/// panel exports, imports, turns off and erases that data (ADR 0243).
const READER_TRAIL_REGION: &str = "<section id=\"ob-reading-trail\" class=\"ob-reading-trail\" aria-labelledby=\"ob-reading-trail-title\">
<h2 id=\"ob-reading-trail-title\">Your reading trails and saved sources</h2>
<ob-reading-trail>
<p class=\"ob-reading-trail-static\">Saved sources and reading trails need JavaScript. With it, you can save this post or a reference it cites and build a trail by hand. Nothing is recorded as you read, what you keep stays in this browser only, and nothing is sent to anyone. Without it, the post reads as usual.</p>
</ob-reading-trail>
</section>
";
/// A post's region for the reader's private interpretation history (ADR 0244),
/// after the highlights and notes. It holds only text: readings are kept and
/// compared in the reader's browser and never leave it.
const READER_REFLECTION_HISTORY_REGION: &str = "<section id=\"ob-reflection-history\" class=\"ob-reflection-history\" aria-labelledby=\"ob-reflection-history-title\">
<h2 id=\"ob-reflection-history-title\">Your readings over time</h2>
<ob-reflection-history>
<p class=\"ob-reflection-history-static\">Keeping and comparing your own readings of this post needs JavaScript. With it, you can save how you read the post now, and later put an earlier reading beside a later one. Readings stay in this browser only, are never judged, and nothing is sent to anyone. Without it, the post reads as usual.</p>
</ob-reflection-history>
</section>
";
/// The page data element holding what a reader may name in an evidence
/// offer (ADR 0116): only what the site publishes.
pub const EVIDENCE_DATA_ELEMENT_ID: &str = "ob-evidence-references";

/// A post's passage text as the feedback form reads it (ADRs 0076, 0082):
/// the work's path, the passage revision and each section's index, anchor,
/// heading title, text and digest, all computed here by the build. The JSON
/// is escaped so no text in it can end or confuse the script element.
fn passage_data_element(post: &Post, document: &crate::passage_target::PassageDocument) -> String {
    // Heading titles label the form's section choices; ids can repeat, so
    // each anchor takes the titles of its headings in order.
    let mut titles: HashMap<&str, std::collections::VecDeque<&str>> = HashMap::new();
    for heading in &post.headings {
        titles
            .entry(heading.id.as_str())
            .or_default()
            .push_back(heading.text.as_str());
    }
    let sections: Vec<serde_json::Value> = document
        .sections
        .iter()
        .enumerate()
        .map(|(index, section)| {
            let mut value = serde_json::json!({ "index": index });
            if let Some(anchor) = &section.anchor {
                value["anchor"] = serde_json::json!(anchor);
                if let Some(title) = titles
                    .get_mut(anchor.as_str())
                    .and_then(|queue| queue.pop_front())
                {
                    value["title"] = serde_json::json!(title);
                }
            }
            value["text"] = serde_json::json!(section.text);
            value["digest"] = serde_json::json!(section.digest);
            value
        })
        .collect();
    let data = serde_json::json!({
        "version": 1,
        "work": post.url,
        "revision": document.revision,
        "sections": sections,
    });
    format!(
        "<script type=\"application/json\" id=\"{PASSAGE_DATA_ELEMENT_ID}\">{}</script>",
        script_json(&data)
    )
}

/// JSON for a data element: `<`, `>`, `&` and the line separators written
/// as escapes, so no published text can end or confuse the element.
fn script_json(data: &serde_json::Value) -> String {
    let mut json = String::new();
    for character in data.to_string().chars() {
        match character {
            '<' | '>' | '&' | '\u{2028}' | '\u{2029}' => {
                json.push_str(&format!("\\u{:04x}", character as u32));
            }
            _ => json.push(character),
        }
    }
    json
}

/// The id of the page data element that lists a post's attributed sections
/// for the Third Perspective form (ADR 0131).
pub const ATTRIBUTED_DATA_ELEMENT_ID: &str = "ob-attributed-sections";

/// A shared reflection's attributed sections as the Third Perspective form
/// reads them: each author's section by its anchor, author's published name,
/// place, first words and digest, all computed here by the build from the
/// committed body and credits. Empty when the post attributes nothing.
fn attributed_sections_element(
    post: &Post,
    sections: &crate::attributed_perspective::AttributedSections,
) -> String {
    if sections.sections().is_empty() {
        return String::new();
    }
    let entries: Vec<serde_json::Value> = sections
        .sections()
        .iter()
        .map(|section| {
            serde_json::json!({
                "anchor": section.anchor(),
                "contributor": section.contribution,
                "nth": section.nth,
                "author": section.author,
                "excerpt": section.excerpt,
                "digest": section.digest,
            })
        })
        .collect();
    let data = serde_json::json!({ "version": 1, "work": post.url, "sections": entries });
    format!(
        "<script type=\"application/json\" id=\"{ATTRIBUTED_DATA_ELEMENT_ID}\">{}</script>\n",
        script_json(&data)
    )
}

/// Give each attributed section of a rendered reflection its `ob-by-` anchor
/// and put the conversation about it at the end of its own turn. `None`
/// unless the body's turns are exactly the attributed sections, in order.
fn anchor_sections(
    html: &str,
    sections: &crate::attributed_perspective::AttributedSections,
    conversations: &[(
        String,
        Vec<&crate::perspective_publication::PublicPerspective>,
    )],
    reports: Option<&str>,
) -> Option<String> {
    const OPEN: &str = "<section class=\"ob-turn ob-lane-";
    let starts: Vec<usize> = html.match_indices(OPEN).map(|(at, _)| at).collect();
    if starts.len() != sections.sections().len() {
        return None;
    }
    let mut out = String::with_capacity(html.len() + 512);
    let mut at = 0;
    for (start, section) in starts.iter().zip(sections.sections()) {
        let tag_end = start + html[*start..].find('>')?;
        let close = start + matching_section_close(&html[*start..])?;
        let anchor = section.anchor();
        out.push_str(&html[at..tag_end]);
        out.push_str(&format!(" id=\"{}\"", attr(&anchor)));
        out.push_str(&html[tag_end..close]);
        if let Some((_, items)) = conversations.iter().find(|(held, _)| *held == anchor) {
            out.push_str(&crate::perspective_publication::render_conversation(
                &anchor, items, reports,
            ));
        }
        at = close;
    }
    out.push_str(&html[at..]);
    Some(out)
}

/// The offset of the `</section>` that closes the `<section ...>` whose open
/// tag starts `html`, counting nested sections (a knowledge check, a recipe
/// part, citation notes) so the first close tag is not taken for the turn's.
fn matching_section_close(html: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut at = 0;
    while let Some(found) = html[at..].find("<") {
        let tag = at + found;
        let rest = &html[tag..];
        if rest.starts_with("</section>") {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(tag);
            }
        } else if rest.starts_with("<section")
            && rest[8..]
                .chars()
                .next()
                .is_some_and(|c| c == '>' || c.is_ascii_whitespace())
        {
            depth += 1;
        }
        at = tag + 1;
    }
    None
}

fn resolved_post_canonical(config: &SiteConfig, post: &Post) -> Option<String> {
    match (&post.research, &post.canonical) {
        (Some(_), Some(url)) => Some(config.absolute(url)),
        _ => post.canonical.clone(),
    }
}

/// Resolve exactly the social metadata emitted for one authored document.
pub fn social_metadata(site: &Site, source: &str) -> Result<SocialMetadata, String> {
    if let Some(post) = site.posts.iter().find(|post| post.source == source) {
        let canonical = resolved_post_canonical(&site.config, post);
        return Ok(resolve_social_metadata(
            &site.config,
            SocialMetadataInput {
                title: &post.title,
                description: &post.description,
                path: &post.url,
                canonical: canonical.as_deref(),
                kind: "article",
                image: post.cover.as_deref(),
                image_alt: Some(&post.cover_alt),
            },
        ));
    }
    if let Some(page) = site.pages.iter().find(|page| page.source == source) {
        let description = if page.description.is_empty() {
            &site.config.description
        } else {
            &page.description
        };
        return Ok(resolve_social_metadata(
            &site.config,
            SocialMetadataInput {
                title: &page.title,
                description,
                path: &page.url,
                canonical: None,
                kind: "website",
                image: None,
                image_alt: None,
            },
        ));
    }
    if let Some(series) = site
        .series
        .iter()
        .find(|series| series.source.as_deref() == Some(source))
    {
        let description = if series.description_text.is_empty() {
            &site.config.description
        } else {
            &series.description_text
        };
        return Ok(resolve_social_metadata(
            &site.config,
            SocialMetadataInput {
                title: &series.name,
                description,
                path: &series.url,
                canonical: None,
                kind: "website",
                image: None,
                image_alt: None,
            },
        ));
    }
    Err(format!("no post, page, or series uses source `{source}`"))
}

impl Output {
    fn add(&mut self, path: String, contents: String) -> Result<(), String> {
        if !self.seen.insert(path.clone()) {
            return Err(format!(
                "two pieces of content would both be written to `{path}`; rename a slug or page"
            ));
        }
        self.files.push(OutputFile { path, contents });
        Ok(())
    }
}

/// A `_redirects` file (Netlify and Cloudflare Pages format) with a permanent redirect for
/// every published `aliases:` address of a post, page or series.
fn redirects_file(site: &Site) -> String {
    let base = site.config.base_path();
    let mut out = String::from("# Generated by openblog from `aliases:` in front matter.\n");
    let mut line = |from: &str, to: &str| {
        out.push_str(&format!("{base}{from} {base}{to} 301\n"));
    };
    for post in &site.posts {
        for alias in &post.aliases {
            line(alias, &post.url);
        }
    }
    for series in site.series.iter().filter(|s| !s.posts.is_empty()) {
        for alias in &series.aliases {
            line(alias, &series.url);
        }
    }
    for page in &site.pages {
        for alias in &page.aliases {
            line(alias, &page.url);
        }
    }
    out
}

fn url_to_file(url: &str) -> String {
    let trimmed = url.trim_start_matches('/');
    if trimmed.is_empty() {
        "index.html".to_string()
    } else if trimmed.ends_with('/') {
        format!("{trimmed}index.html")
    } else if trimmed.ends_with(".html") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/index.html")
    }
}

/// Render the whole site to files. `themes` supplies every registered theme;
/// the ones the site uses must resolve, others are emitted when they do.
pub fn generate(site: &Site, themes: &ThemeSet) -> Result<Vec<OutputFile>, String> {
    generate_with_trail_budget(site, themes, TRAIL_BUDGET_BYTES)
}

/// [`generate`] with the site-wide trail budget (ADR 0175) set by the caller,
/// so a test can cross it without a site of tens of megabytes.
#[doc(hidden)]
pub fn generate_with_trail_budget(
    site: &Site,
    themes: &ThemeSet,
    trail_budget: usize,
) -> Result<Vec<OutputFile>, String> {
    validate_output_paths(site)?;
    let resolved = resolve_themes(site, themes)?;

    let r = Renderer {
        site,
        themes: &resolved,
        site_references: Default::default(),
        atlas_query: Default::default(),
        curated: Default::default(),
        trail_depth: Default::default(),
        trail_budget,
    };
    let c = &site.config;
    let mut out = Output {
        files: Vec::new(),
        seen: HashSet::new(),
    };
    let default_theme = &resolved[&c.theme];

    // Home and pagination.
    let per_page = if c.posts_per_page == 0 {
        site.posts.len().max(1)
    } else {
        c.posts_per_page
    };
    let page_count = site.posts.len().div_ceil(per_page).max(1);
    for page_number in 1..=page_count {
        let path = if page_number == 1 {
            "index.html".to_string()
        } else {
            format!("page/{page_number}/index.html")
        };
        out.add(
            path,
            r.home(default_theme, page_number, page_count, per_page),
        )?;
    }

    for (index, post) in site.posts.iter().enumerate() {
        out.add(url_to_file(&post.url), r.post(index, post)?)?;
        for alias in &post.aliases {
            out.add(url_to_file(alias), r.alias_page(&post.url, &post.title))?;
        }
    }

    out.add("series/index.html".into(), r.series_index(default_theme))?;
    for series in site.series.iter().filter(|s| !s.posts.is_empty()) {
        out.add(url_to_file(&series.url), r.series_page(series))?;
        for alias in &series.aliases {
            out.add(url_to_file(alias), r.alias_page(&series.url, &series.name))?;
        }
    }

    out.add("tags/index.html".into(), r.tags_index(default_theme))?;
    for tag in &site.tags {
        out.add(url_to_file(&tag.url), r.tag_page(default_theme, tag))?;
    }

    let job_plan = crate::job_archive::plan(site);
    for archive in &job_plan {
        for page_number in 1..=archive.page_count(c.posts_per_page) {
            out.add(
                url_to_file(&archive.page_url(page_number)),
                r.job_archive_page(
                    default_theme,
                    &job_plan,
                    archive,
                    page_number,
                    c.posts_per_page,
                ),
            )?;
        }
    }

    out.add("archive/index.html".into(), r.archive(default_theme))?;
    out.add("search/index.html".into(), r.search_page(default_theme))?;
    // The services collection (ADR 0312): an index and one page each, only
    // when the site has services.
    if !site.services.is_empty() {
        out.add(
            url_to_file(crate::service::SERVICES_URL),
            r.service_index(default_theme, &job_plan),
        )?;
        for service in &site.services {
            out.add(
                url_to_file(&service.url),
                r.service_page(service, &job_plan),
            )?;
        }
    }
    // Service areas (ADR 0315): an index and one page per area, only when the
    // site lists areas.
    if !c.service_areas.is_default() {
        out.add(
            url_to_file(crate::service_area::AREAS_URL),
            r.area_index(default_theme, &job_plan),
        )?;
        for planned in c.service_areas.plan() {
            out.add(url_to_file(&planned.url), r.area_page(&planned, &job_plan))?;
        }
    }
    for page in &site.pages {
        out.add(url_to_file(&page.url), r.page(page))?;
        for alias in &page.aliases {
            out.add(url_to_file(alias), r.alias_page(&page.url, &page.title))?;
        }
    }
    // The Knowledge Atlas, only when the site publishes it (ADR 0058): its
    // pages and its JSON artifact are both rendered from the one projection.
    if let Some(atlas) = &site.atlas {
        out.add(
            url_to_file(atlas_publication::ATLAS_URL),
            r.atlas_index(default_theme, atlas),
        )?;
        for entry in &atlas.entries {
            out.add(
                url_to_file(&entry.url),
                r.atlas_entry(default_theme, atlas, entry),
            )?;
        }
        out.add(
            atlas_publication::ATLAS_JSON_FILE.into(),
            c.apply_base_path(&atlas.to_json()),
        )?;
        // The query projection (ADR 0168), derived from the projection above.
        // A projection that is refused (over a bound, or not consistent) is
        // left out and the pages and atlas.json stay the complete fallback;
        // the build warns (`boundary:`) and the boundary preview says so.
        if let Some(json) = r.atlas_query_json() {
            out.add(
                crate::atlas_query::ATLAS_QUERY_JSON_FILE.into(),
                json.to_string(),
            )?;
        }
    }
    // Reading paths, only when the site publishes them (ADR 0212, #78): every
    // page is rendered from the one public paths value and is complete HTML.
    if let Some(paths) = &site.reading_paths {
        if paths.paths.iter().any(|path| path.listed) {
            out.add(
                url_to_file(crate::reading_path::PATHS_URL),
                r.paths_index(default_theme, paths),
            )?;
        }
        for path in &paths.paths {
            out.add(
                url_to_file(&path.url),
                r.path_page(default_theme, paths, path),
            )?;
        }
        // The data file lists only what discovery may list (ADR 0216); it is
        // written from the same value the pages are, and only if one is listed.
        let listed = paths.listed_only();
        if !listed.paths.is_empty() {
            out.add(
                crate::reading_path::PATHS_JSON_FILE.into(),
                c.apply_base_path(&listed.to_json()),
            )?;
        }
    }
    // Interpretation comparisons, only when the site publishes them (ADR
    // 0232, #90): every page is rendered from the one public value and is
    // complete HTML, with or without JavaScript.
    if let Some(public) = &site.interpretations {
        if !public.comparisons.is_empty() {
            out.add(
                url_to_file(crate::interpretation_publication::INTERPRETATIONS_URL),
                r.interpretations_index(default_theme, public),
            )?;
        }
        for published in &public.comparisons {
            out.add(
                url_to_file(&published.url),
                r.interpretation_page(default_theme, public, published),
            )?;
            // A comparison with explanation levels also gets static copies
            // (ADR 0236, #220) beside its page, for readers and tools that
            // cannot run the level selector. A copy that fails its own
            // portability check stops the build.
            if !published.comparison.explanations.is_empty() {
                let copy =
                    crate::comparison_portable::portable_comparison(public, published, &c.url);
                if !copy.is_sound() {
                    let problems: Vec<String> =
                        copy.diagnostics.iter().map(|d| d.message.clone()).collect();
                    return Err(format!(
                        "the portable copies of interpretation comparison `{}` are not sound: {}",
                        published.comparison.slug,
                        problems.join("; ")
                    ));
                }
                let dir = url_to_file(&published.url);
                let dir = dir.trim_end_matches("index.html");
                out.add(format!("{dir}portable.html"), copy.html)?;
                out.add(format!("{dir}portable.md"), copy.markdown)?;
                out.add(format!("{dir}portable.txt"), copy.text)?;
            }
        }
    }
    // The curated research context (ADR 0197): the data file readers' tools
    // fetch, projected from the one public curated value the pages' sections
    // are rendered from. A projection that is refused (over a bound, or not
    // consistent) is left out whole; the pages stay the complete fallback and
    // the build warns (`boundary:`).
    if let Some(projection) = r.curated_projection() {
        out.add(
            crate::curated_context::CURATED_CONTEXT_JSON_FILE.into(),
            projection.json.clone(),
        )?;
    }
    // Passage comparisons, only when the site publishes them (ADR 0092): the
    // pages and the JSON artifact are both rendered from the one projection.
    if let Some(comparisons) = &site.comparisons {
        out.add(
            url_to_file(comparison_publication::COMPARISONS_URL),
            r.comparison_index(default_theme, comparisons),
        )?;
        for comparison in &comparisons.comparisons {
            out.add(
                url_to_file(&comparison.url),
                r.comparison_page(default_theme, comparisons, comparison),
            )?;
        }
        out.add(
            comparison_publication::COMPARISONS_JSON_FILE.into(),
            c.apply_base_path(&comparisons.to_json()),
        )?;
    }
    // Claim evidence as data, only while the site publishes it (ADR 0075):
    // the same values each post's section was written from.
    if c.claim_evidence.publish {
        out.add(
            crate::claim_publication::CLAIM_EVIDENCE_JSON_FILE.into(),
            c.apply_base_path(
                &crate::claim_publication::PublicClaimEvidence::of(&site.posts).to_json(),
            ),
        )?;
    }
    // GitHub Pages skips Jekyll processing when this file exists.
    out.add(".nojekyll".into(), String::new())?;
    if c.redirects_file {
        out.add("_redirects".into(), redirects_file(site))?;
    }
    out.add("404.html".into(), r.not_found(default_theme))?;

    // Per-theme generated assets.
    let mut theme_names: Vec<&String> = resolved.keys().collect();
    theme_names.sort();
    for name in theme_names {
        let theme = &resolved[name];
        out.add(
            format!("themes/{name}/tokens.css"),
            c.apply_base_path(&c.cdn.apply(&theme.tokens_css())),
        )?;
        out.add(
            format!("themes/{name}/resolved.json"),
            theme.manifest_json(),
        )?;
    }

    if c.feeds.rss {
        out.add("rss.xml".into(), feeds::rss(site)?)?;
    }
    if c.feeds.json {
        out.add("feed.json".into(), feeds::json_feed(site)?)?;
    }
    if c.feeds.sitemap {
        let mut extra = vec!["/search/".to_string(), "/archive/".to_string()];
        if let Some(atlas) = &site.atlas {
            extra.push(atlas_publication::ATLAS_URL.to_string());
            extra.extend(atlas.entries.iter().map(|entry| entry.url.clone()));
        }
        if let Some(paths) = &site.reading_paths {
            // Discovery follows `listed`: an unlisted path is published but
            // not advertised to crawlers.
            if paths.paths.iter().any(|path| path.listed) {
                extra.push(crate::reading_path::PATHS_URL.to_string());
            }
            extra.extend(
                paths
                    .paths
                    .iter()
                    .filter(|path| path.listed)
                    .map(|path| path.url.clone()),
            );
        }
        if let Some(public) = &site.interpretations {
            if !public.comparisons.is_empty() {
                extra.push(crate::interpretation_publication::INTERPRETATIONS_URL.to_string());
            }
            extra.extend(public.comparisons.iter().map(|c| c.url.clone()));
        }
        if let Some(comparisons) = &site.comparisons {
            extra.push(comparison_publication::COMPARISONS_URL.to_string());
            extra.extend(comparisons.comparisons.iter().map(|c| c.url.clone()));
        }
        extra.extend(job_plan.iter().map(|archive| archive.url.clone()));
        if !site.services.is_empty() {
            extra.push(crate::service::SERVICES_URL.to_string());
            extra.extend(site.services.iter().map(|service| service.url.clone()));
        }
        if !c.service_areas.is_default() {
            extra.push(crate::service_area::AREAS_URL.to_string());
            extra.extend(
                c.service_areas
                    .plan()
                    .into_iter()
                    .map(|planned| planned.url),
            );
        }
        out.add("sitemap.xml".into(), feeds::sitemap(site, &extra))?;
        out.add("robots.txt".into(), feeds::robots(site))?;
    }
    if c.feeds.llms {
        out.add("llms.txt".into(), feeds::llms_index(site)?)?;
        out.add("llms-full.txt".into(), feeds::llms_full(site)?)?;
    }
    if c.feeds.portfolio_snapshot {
        out.add("api/blog.json".into(), feeds::portfolio_snapshot(site, 4)?)?;
    }
    if c.analytics.bake_counts && !site.view_counts.is_empty() {
        // Counts as of this build, for static hosts and for scripts.
        let counts: serde_json::Map<String, serde_json::Value> = site
            .view_counts
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::from(*v)))
            .collect();
        out.add(
            "api/views.json".into(),
            serde_json::Value::Object(counts).to_string(),
        )?;
    }
    out.add(
        "search.json".into(),
        c.apply_base_path(&feeds::search_index(site)),
    )?;
    // Comments keep their own manifest, unchanged; it is the comment row of
    // the one participation policy (ADR 0101).
    let comment_policies: BTreeMap<&str, &str> = site
        .posts
        .iter()
        .map(|post| {
            let mode = participation::effective_mode(c, post, ParticipationKind::Comment);
            (post.url.as_str(), mode.id())
        })
        .collect();
    out.add(
        "openblog-comments.json".into(),
        serde_json::to_string(&comment_policies).expect("comment policy map is serializable"),
    )?;
    // Published only once a kind beyond comments is switched on, so every
    // other site's output is unchanged.
    if let Some(manifest) = participation::manifest(site) {
        out.add("openblog-participation.json".into(), manifest)?;
    }
    // B5's passage feedback manifest (ADR 0081), kept for a hosted function
    // deployed before the participation manifest: derived from the policy,
    // never more open than any of B5's four kinds (ADR 0101).
    if let Some(manifest) = participation::legacy_feedback_manifest(site) {
        out.add("openblog-feedback.json".into(), manifest)?;
    }

    Ok(out.files)
}

/// Render one content document through the same page shell used by [`generate`].
/// This keeps the admin preview faithful without generating feeds, indexes, and
/// every unrelated page after each edit.
pub fn generate_document(
    site: &Site,
    themes: &ThemeSet,
    source: &str,
) -> Result<OutputFile, String> {
    validate_output_paths(site)?;
    let resolved = resolve_themes(site, themes)?;
    let renderer = Renderer {
        site,
        themes: &resolved,
        site_references: Default::default(),
        atlas_query: Default::default(),
        curated: Default::default(),
        trail_depth: Default::default(),
        trail_budget: TRAIL_BUDGET_BYTES,
    };
    let (url, contents) = if let Some((index, post)) = site
        .posts
        .iter()
        .enumerate()
        .find(|(_, post)| post.source == source)
    {
        (post.url.as_str(), renderer.post(index, post)?)
    } else if let Some(series) = site
        .series
        .iter()
        .find(|series| series.source.as_deref() == Some(source))
    {
        (series.url.as_str(), renderer.series_page(series))
    } else if let Some(page) = site.pages.iter().find(|page| page.source == source) {
        (page.url.as_str(), renderer.page(page))
    } else if let Some(service) = site
        .services
        .iter()
        .find(|service| service.source == source)
    {
        (
            service.url.as_str(),
            renderer.service_page(service, &crate::job_archive::plan(site)),
        )
    } else {
        return Err(format!("no content document came from `{source}`"));
    };
    Ok(OutputFile {
        path: url_to_file(url),
        contents,
    })
}

/// Render the first page of the home page through the same shell as [`generate`], without any
/// other page. Admin uses it to preview the landing page from unsaved sections (ADR 0250).
pub fn generate_home(site: &Site, themes: &ThemeSet) -> Result<OutputFile, String> {
    validate_output_paths(site)?;
    let resolved = resolve_themes(site, themes)?;
    let renderer = Renderer {
        site,
        themes: &resolved,
        site_references: Default::default(),
        atlas_query: Default::default(),
        curated: Default::default(),
        trail_depth: Default::default(),
        trail_budget: TRAIL_BUDGET_BYTES,
    };
    let c = &site.config;
    let per_page = if c.posts_per_page == 0 {
        site.posts.len().max(1)
    } else {
        c.posts_per_page
    };
    let page_count = site.posts.len().div_ceil(per_page).max(1);
    Ok(OutputFile {
        path: "index.html".to_string(),
        contents: renderer.home(&resolved[&c.theme], 1, page_count, per_page),
    })
}

/// What stops `readingPaths.publish` from being switched on: a page or a post
/// whose address is under `/paths/`. `None` when nothing collides. The build
/// refuses the same collision while the switch is on; `check` uses this to
/// warn before it is.
pub fn reading_paths_address_conflict(site: &Site) -> Option<String> {
    let segment = crate::reading_path::PATHS_SEGMENT;
    if let Some(page) = site.pages.iter().find(|page| page.slug == segment) {
        return Some(format!(
            "{}: the page slug `{segment}` would collide with `/paths/`; rename the page before switching on `readingPaths.publish`",
            page.source
        ));
    }
    site.posts
        .iter()
        .find(|post| post.url.trim_start_matches('/').split('/').next() == Some(segment))
        .map(|post| {
            format!(
                "{}: the post URL `{}` would collide with `/paths/`; adjust `postPath` or the slug before switching on `readingPaths.publish`",
                post.source, post.url
            )
        })
}

/// A page or post whose address is under `/interpretations/`, which the
/// comparison pages reserve once `interpretations.publish` is on (ADR 0232).
/// `None` when nothing collides. The build refuses the same collision while the
/// switch is on; `check` uses this to warn before it is.
pub fn interpretations_address_conflict(site: &Site) -> Option<String> {
    let segment = crate::interpretation_publication::INTERPRETATIONS_SEGMENT;
    if let Some(page) = site.pages.iter().find(|page| page.slug == segment) {
        return Some(format!(
            "{}: the page slug `{segment}` would collide with `/interpretations/`; rename the page before switching on `interpretations.publish`",
            page.source
        ));
    }
    site.posts
        .iter()
        .find(|post| post.url.trim_start_matches('/').split('/').next() == Some(segment))
        .map(|post| {
            format!(
                "{}: the post URL `{}` would collide with `/interpretations/`; adjust `postPath` or the slug before switching on `interpretations.publish`",
                post.source, post.url
            )
        })
}

fn validate_output_paths(site: &Site) -> Result<(), String> {
    // `atlas` is reserved only while the site publishes its atlas, so an
    // existing page or post at `/atlas/` keeps working until then. The switch,
    // not a loaded projection, decides: Admin validates a save against a site
    // that never reads the atlas, and must refuse what the next build would.
    let publishes_atlas = site.config.knowledge_atlas.publish;
    let publishes_comparisons = site.config.comparisons.publish;
    // Like the atlas: reading paths reserve `/paths/` only behind their own
    // switch (ADR 0212), so a site that has not opted in is unaffected.
    let publishes_paths = site.config.reading_paths.publish;
    // Interpretation comparisons reserve `/interpretations/` the same way
    // (ADR 0232); `/comparisons/` stays with passage comparisons.
    let publishes_interpretations = site.config.interpretations.publish;
    // `/services/` is reserved only once the site has services (ADR 0312).
    let has_services = !site.services.is_empty();
    let has_areas = !site.config.service_areas.is_default();
    let reserved = |segment: &str| {
        RESERVED.contains(&segment)
            || (has_services && segment == crate::service::SERVICES_DIR)
            || (has_areas && segment == crate::service_area::AREAS_DIR)
            || (publishes_atlas && segment == ATLAS_SEGMENT)
            || (publishes_comparisons && segment == COMPARISONS_SEGMENT)
            || (publishes_paths && segment == crate::reading_path::PATHS_SEGMENT)
            || (publishes_interpretations
                && segment == crate::interpretation_publication::INTERPRETATIONS_SEGMENT)
    };
    for page in &site.pages {
        if reserved(page.slug.as_str()) {
            return Err(format!(
                "{}: the page slug `{}` is reserved by open.blog; choose another",
                page.source, page.slug
            ));
        }
    }
    for post in &site.posts {
        let first = post
            .url
            .trim_start_matches('/')
            .split('/')
            .next()
            .unwrap_or("");
        if reserved(first) {
            return Err(format!(
                "{}: the post URL `{}` collides with a reserved path; adjust `postPath` or the slug",
                post.source, post.url
            ));
        }
    }
    Ok(())
}

/// Layer the owner's look (if any) over a resolved theme.
fn with_look(theme: Theme, site: &Site) -> Theme {
    if site.config.appearance.is_neutral() {
        theme
    } else {
        theme.with_look(&site.config.appearance)
    }
}

fn resolve_themes(site: &Site, themes: &ThemeSet) -> Result<HashMap<String, Theme>, String> {
    let mut resolved = HashMap::new();
    for name in site.used_themes() {
        resolved.insert(name.clone(), with_look(themes.resolve(&name)?, site));
    }
    for name in themes.names() {
        if let std::collections::hash_map::Entry::Vacant(slot) = resolved.entry(name.clone()) {
            if let Ok(theme) = themes.resolve(&name) {
                slot.insert(with_look(theme, site));
            }
        }
    }
    Ok(resolved)
}

impl<'a> Renderer<'a> {
    fn theme(&self, name: &str) -> &'a Theme {
        &self.themes[name]
    }

    // ----- page shells ---------------------------------------------------

    fn document(&self, meta: &Meta, body: &str) -> String {
        let c = &self.site.config;
        let theme = meta.theme;
        let full_title = if meta.title.is_empty() || meta.title == c.title {
            c.title.clone()
        } else {
            format!("{} · {}", meta.title, c.title)
        };
        let social = resolve_social_metadata(
            c,
            SocialMetadataInput {
                title: &meta.title,
                description: &meta.description,
                path: &meta.path,
                canonical: meta.canonical.as_deref(),
                kind: meta.kind,
                image: meta.image.as_deref(),
                image_alt: meta.image_alt.as_deref(),
            },
        );

        let mut h = String::with_capacity(body.len() + 4096);
        h.push_str("<!doctype html>\n");
        h.push_str(&format!(
            "<html lang=\"{}\" data-ob-theme=\"{}\">\n<head>\n<meta charset=\"utf-8\">\n",
            attr(&c.language),
            attr(&theme.name)
        ));
        h.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
        h.push_str(&format!("<title>{}</title>\n", text(&full_title)));
        if !social.description.is_empty() {
            h.push_str(&format!(
                "<meta name=\"description\" content=\"{}\">\n",
                attr(&social.description)
            ));
        }
        if meta.noindex {
            h.push_str("<meta name=\"robots\" content=\"noindex\">\n");
        }
        h.push_str(&format!(
            "<link rel=\"canonical\" href=\"{}\">\n",
            attr(&social.url)
        ));
        h.push_str("<meta name=\"generator\" content=\"open.blog\">\n");
        if let Some(page) = theme.colors.get("light").and_then(|m| m.get("page")) {
            h.push_str(&format!("<meta name=\"theme-color\" content=\"{}\" media=\"(prefers-color-scheme: light)\">\n", attr(page)));
        }
        if let Some(page) = theme.colors.get("dark").and_then(|m| m.get("page")) {
            h.push_str(&format!("<meta name=\"theme-color\" content=\"{}\" media=\"(prefers-color-scheme: dark)\">\n", attr(page)));
        }
        // Social cards.
        h.push_str(&format!(
            "<meta property=\"og:site_name\" content=\"{}\">\n",
            attr(&social.site_name)
        ));
        h.push_str(&format!(
            "<meta property=\"og:type\" content=\"{}\">\n",
            social.kind
        ));
        h.push_str(&format!(
            "<meta property=\"og:title\" content=\"{}\">\n",
            attr(&social.title)
        ));
        h.push_str(&format!(
            "<meta name=\"twitter:title\" content=\"{}\">\n",
            attr(&social.title)
        ));
        if !social.description.is_empty() {
            h.push_str(&format!(
                "<meta property=\"og:description\" content=\"{}\">\n",
                attr(&social.description)
            ));
            h.push_str(&format!(
                "<meta name=\"twitter:description\" content=\"{}\">\n",
                attr(&social.description)
            ));
        }
        h.push_str(&format!(
            "<meta property=\"og:url\" content=\"{}\">\n",
            attr(&social.url)
        ));
        if let Some(image) = &social.image {
            h.push_str(&format!(
                "<meta property=\"og:image\" content=\"{}\">\n",
                attr(image)
            ));
            h.push_str(&format!(
                "<meta name=\"twitter:image\" content=\"{}\">\n",
                attr(image)
            ));
            if let Some(alt_text) = social.image_alt.as_deref() {
                h.push_str(&format!(
                    "<meta property=\"og:image:alt\" content=\"{}\">\n<meta name=\"twitter:image:alt\" content=\"{}\">\n",
                    attr(alt_text),
                    attr(alt_text)
                ));
            }
        }
        h.push_str(&format!(
            "<meta name=\"twitter:card\" content=\"{}\">\n",
            social.card
        ));
        if let Some(p) = &meta.published {
            h.push_str(&format!(
                "<meta property=\"article:published_time\" content=\"{}\">\n",
                attr(p)
            ));
        }
        if let Some(m) = &meta.modified {
            h.push_str(&format!(
                "<meta property=\"article:modified_time\" content=\"{}\">\n",
                attr(m)
            ));
        }
        for tag in &meta.tags {
            h.push_str(&format!(
                "<meta property=\"article:tag\" content=\"{}\">\n",
                attr(tag)
            ));
        }
        for (name, value) in &meta.highwire {
            h.push_str(&format!(
                "<meta name=\"{}\" content=\"{}\">\n",
                name,
                attr(value)
            ));
        }
        // Feeds.
        if c.feeds.rss {
            h.push_str(&format!("<link rel=\"alternate\" type=\"application/rss+xml\" title=\"{}\" href=\"/rss.xml\">\n", attr(&c.title)));
        }
        if c.feeds.json {
            h.push_str(&format!("<link rel=\"alternate\" type=\"application/feed+json\" title=\"{}\" href=\"/feed.json\">\n", attr(&c.title)));
        }
        if c.feeds.llms {
            h.push_str("<link rel=\"alternate\" type=\"text/plain\" title=\"Content index for automated readers\" href=\"/llms.txt\">\n");
        }
        if !c.favicon.is_empty() {
            h.push_str(&format!(
                "<link rel=\"icon\" href=\"{}\">\n",
                attr(&c.favicon)
            ));
        }
        // Restore a visitor's saved color scheme before first paint.
        if c.color_scheme_toggle.unwrap_or(theme.color_scheme_toggle) {
            h.push_str("<script>try{var s=localStorage.getItem(\"ob-scheme\");if(s===\"light\"||s===\"dark\")document.documentElement.dataset.theme=s}catch(e){}</script>\n");
        }
        // Order matters: structure, then tokens, then the theme's own rules.
        h.push_str("<link rel=\"stylesheet\" href=\"/assets/base.css\">\n");
        h.push_str(&format!(
            "<link rel=\"stylesheet\" href=\"{}\">\n",
            attr(&theme.tokens_url())
        ));
        for sheet in &theme.stylesheets {
            h.push_str(&format!(
                "<link rel=\"stylesheet\" href=\"{}\">\n",
                attr(sheet)
            ));
        }
        h.push_str("<script type=\"module\" src=\"/assets/openblog.js\"></script>\n");
        for script in &theme.scripts {
            h.push_str(&format!(
                "<script type=\"module\" src=\"{}\"></script>\n",
                attr(script)
            ));
        }
        if let Some(ld) = &meta.json_ld {
            h.push_str(&format!(
                "<script type=\"application/ld+json\">{}</script>\n",
                // JSON allows these escapes, and without `<` no text from a post
                // (`</script>`, `<!--<script>`) can end or confuse the element.
                ld.replace('<', "\\u003c")
                    .replace('>', "\\u003e")
                    .replace('&', "\\u0026")
            ));
        }
        if meta.path == "/" && c.business.has_public_facts() {
            let mut business = c.business.local_business_json_ld(
                &c.absolute("/#business"),
                &c.absolute("/"),
                &c.title,
            );
            if let Some(served) = c.service_areas.area_served() {
                business["areaServed"] = served;
            }
            h.push_str(&format!(
                "<script type=\"application/ld+json\">{}</script>\n",
                business
                    .to_string()
                    .replace('<', "\\u003c")
                    .replace('>', "\\u003e")
                    .replace('&', "\\u0026")
            ));
        }
        if let Some(element) = &meta.reader_references {
            h.push_str(element);
            h.push('\n');
            // The preview component is loaded only by pages that carry its data.
            h.push_str("<script type=\"module\" src=\"/assets/components/ob-citation-previews.js\"></script>\n");
        }
        if let Some(element) = &meta.passage_data {
            h.push_str(element);
            h.push('\n');
        }
        // Each form's script is loaded only by pages that offer it.
        for script in &meta.participation_scripts {
            h.push_str(&format!(
                "<script type=\"module\" src=\"/assets/components/{script}\"></script>\n"
            ));
        }
        if meta.concept_previews.is_some() {
            // The preview component is loaded only by a page that has a concept link.
            h.push_str("<script type=\"module\" src=\"/assets/components/ob-concept-previews.js\"></script>\n");
        }
        if meta.atlas_timeline {
            // The timeline's enhancement is loaded only by the page that has one.
            h.push_str("<script type=\"module\" src=\"/assets/components/ob-atlas-timeline.js\"></script>\n");
        }
        if meta.atlas_trail {
            // The trail's filters are loaded only by an entry page that has a trail.
            h.push_str(
                "<script type=\"module\" src=\"/assets/components/ob-atlas-trail.js\"></script>\n",
            );
        }
        if meta.reading_path {
            // Optional local progress, loaded only by a reading path's page.
            h.push_str(
                "<script type=\"module\" src=\"/assets/components/ob-reading-path.js\"></script>\n",
            );
        }
        if meta.interpretation_levels {
            // The level selector, loaded only by a comparison that has explanations.
            h.push_str(
                "<script type=\"module\" src=\"/assets/components/ob-explanation-levels.js\"></script>\n",
            );
        }
        // Owner-supplied raw HTML (third-party analytics, verification tags).
        if !c.snippets.head.trim().is_empty() {
            h.push_str(c.snippets.head.trim());
            h.push('\n');
        }
        h.push_str("</head>\n<body>\n");
        h.push_str("<a class=\"ob-skip\" href=\"#main\">Skip to content</a>\n");
        h.push_str(&self.site_header(theme, &meta.path));
        h.push_str("<main id=\"main\" tabindex=\"-1\">\n");
        h.push_str(body);
        if let Some(element) = &meta.citation_previews {
            h.push('\n');
            h.push_str(element);
        }
        if let Some(source) = &meta.concept_previews {
            h.push('\n');
            // The file's size in bytes lets a touch screen decide whether it
            // may be fetched ahead of the first tap (ADR 0174).
            let bytes = self.atlas_query_json().map_or(0, str::len);
            h.push_str(&format!(
                "<ob-concept-previews src=\"/{}\" data-bytes=\"{bytes}\"></ob-concept-previews>",
                attr(source)
            ));
        }
        h.push_str("\n</main>\n");
        h.push_str(&self.site_footer());
        h.push_str("<ob-back-to-top></ob-back-to-top>\n");
        if !c.snippets.body_end.trim().is_empty() {
            h.push_str(c.snippets.body_end.trim());
            h.push('\n');
        }
        h.push_str("</body>\n</html>\n");
        // CDN first (it matches site-relative asset paths), then the base path for everything else.
        c.apply_base_path(&c.cdn.apply(&h))
    }

    /// The query projection as the build writes it: projected once, and
    /// `None` when the site publishes no atlas or the projection is refused
    /// or over its bound.
    fn atlas_query_projection(&self) -> Option<&QueryProjection> {
        self.atlas_query
            .get_or_init(|| {
                let c = &self.site.config;
                let atlas = self.site.atlas.as_ref()?;
                let query =
                    crate::atlas_query::AtlasQuery::project(atlas, &c.author.name, &c.base_path())
                        .ok()?;
                let json = c.apply_base_path(&query.to_json());
                (json.len() <= crate::atlas_query::MAX_BYTES)
                    .then_some(QueryProjection { query, json })
            })
            .as_ref()
    }

    /// The curated context as the build writes it, projected once. `None`
    /// when the site publishes no curated context at all, or the projection
    /// is refused (over a bound, or not consistent); a post's section is
    /// then rendered from the public value directly (see
    /// [`Self::curated_section`]) and only the data file is left out.
    fn curated_projection(&self) -> Option<&CuratedProjection> {
        self.curated
            .get_or_init(|| {
                let c = &self.site.config;
                let curation = self.site.curation.as_ref()?;
                let base = c.base_path();
                let posts: Vec<crate::curated_context::PostRef<'_>> = self
                    .site
                    .posts
                    .iter()
                    .map(|post| crate::curated_context::PostRef {
                        slug: post.slug.as_str(),
                        url: post.url.as_str(),
                    })
                    .collect();
                let context =
                    crate::curated_context::CuratedContext::project(curation, &posts, &base)
                        .ok()?;
                // Nothing published, nothing written: a site that curates but
                // currently publishes no selection is built exactly as before.
                if context.items.is_empty() {
                    return None;
                }
                let json = c.apply_base_path(&context.to_json());
                (json.len() <= crate::curated_context::MAX_BYTES)
                    .then_some(CuratedProjection { context, json })
            })
            .as_ref()
    }

    /// The static research-context section of one post's page, rendered from
    /// the public curated value alone; `None` when the post offers nothing,
    /// so its page is exactly what it was.
    fn curated_section(&self, post: &Post) -> Option<String> {
        self.site.curation.as_ref()?;
        if let Some(projection) = self.curated_projection() {
            let data = format!("/{}", crate::curated_context::CURATED_CONTEXT_JSON_FILE);
            return projection
                .context
                .post_section_html(&post.slug, Some(&data));
        }
        // The data file is not written (a bound, or an inconsistency): the
        // page still carries what its post is offered, without a link to it.
        let curation = self.site.curation.as_ref()?;
        crate::curated_context::CuratedContext::for_one_post(
            curation,
            crate::curated_context::PostRef {
                slug: &post.slug,
                url: &post.url,
            },
        )?
        .post_section_html(&post.slug, None)
    }

    /// The query file as the build writes it, when it is written.
    fn atlas_query_json(&self) -> Option<&str> {
        self.atlas_query_projection()
            .map(|projection| projection.json.as_str())
    }

    /// Where the post's concept links read their previews (ADR 0174), when
    /// they are enhanced: it has a resolved link and the build writes the one
    /// file the previews read, so a link never leads to a preview that cannot
    /// load. The address carries the file's content hash, so a browser never
    /// reads a stale file after the atlas changes, and the same atlas always
    /// makes the same address.
    fn concept_previews(&self, post: &Post) -> Option<String> {
        if !post.has_concept_links() || !post.html.contains(crate::concept_links::LINK_CLASS) {
            return None;
        }
        let json = self.atlas_query_json()?;
        let mut hasher = Blake2s256::new();
        hasher.update(json.as_bytes());
        let version: String = hasher
            .finalize()
            .iter()
            .take(8)
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Some(format!(
            "{}?v={version}",
            crate::atlas_query::ATLAS_QUERY_JSON_FILE
        ))
    }

    /// Passage feedback on one post (ADR 0082): the feedback region, whose
    /// static text is the no-JavaScript path, and the post's passage text as
    /// page data for the form. Only a post where at least one of B5's kinds
    /// is `open` has them (ADR 0101), and the form offers exactly those; every
    /// other page is unchanged.
    fn passage_feedback(&self, post: &Post) -> Option<(String, String)> {
        let c = &self.site.config;
        let endpoint = c.engagement.endpoint.trim().trim_end_matches('/');
        let offered = participation::offered_passage_kinds(c, post);
        if offered.is_empty() {
            return None;
        }
        // Named only when the form offers some of the kinds, so a page that
        // offers all four is what it was before the policy.
        let (kinds_attr, invitation) = if offered.len() == ParticipationKind::PASSAGE_FEEDBACK.len()
        {
            (
                String::new(),
                "Ask a question about a passage, suggest a source or a correction, or offer another interpretation.".to_string(),
            )
        } else {
            let ids: Vec<&str> = offered.iter().map(|kind| kind.id()).collect();
            let labels: Vec<&str> = offered.iter().map(|kind| kind.label()).collect();
            (
                format!(" kinds=\"{}\"", attr(&ids.join(" "))),
                format!(
                    "Send the author a note about a passage: {}.",
                    text(&labels.join(", ").to_lowercase())
                ),
            )
        };
        let document = crate::passage_target::PassageDocument::of_post(post, c);
        let contact = c.engagement.feedback_contact.as_str();
        let (contact_attr, contact_words) = if contact.is_empty() {
            (String::new(), String::new())
        } else if let Some(address) = contact.strip_prefix("mailto:") {
            (
                format!(" contact=\"{}\"", attr(contact)),
                format!(" at <a href=\"{}\">{}</a>", attr(contact), text(address)),
            )
        } else {
            (
                format!(" contact=\"{}\"", attr(contact)),
                format!(
                    " through <a href=\"{}\">the contact page</a>",
                    attr(contact)
                ),
            )
        };
        // Readers can use their receipts on the page once the site says the
        // hosted service issues them (ADR 0107).
        let receipts_attr = if c.engagement.receipts {
            " receipts"
        } else {
            ""
        };
        // The evidence offer (ADR 0116), once the site says the hosted
        // service stores it, on a post open to a suggested source or
        // correction: the form lists only what the site publishes.
        let evidence = c.engagement.evidence
            && offered
                .iter()
                .any(|kind| crate::evidence_submission::is_evidence_kind(*kind));
        let evidence_attr = if evidence { " evidence" } else { "" };
        let region = format!(
            "<section id=\"{FEEDBACK_ANCHOR}\" class=\"ob-feedback\" aria-labelledby=\"{FEEDBACK_ANCHOR}-title\">\n<h2 id=\"{FEEDBACK_ANCHOR}-title\">Questions and corrections</h2>\n<ob-passage-feedback endpoint=\"{}\" page=\"{}\"{kinds_attr}{contact_attr}{receipts_attr}{evidence_attr}>\n<p>{invitation} The author reviews every note, and nothing is published without their approval.</p>\n<p class=\"ob-passage-feedback-static\">The feedback form needs JavaScript. Without it, you can send your note to the author{contact_words}: name the section by its link, quote the words you mean, and give this page’s passage revision, <code>{}</code>, so the author can find the text you read.</p>\n</ob-passage-feedback>\n</section>\n",
            attr(endpoint),
            attr(&c.absolute(&post.url)),
            text(&document.revision),
        );
        let mut data = passage_data_element(post, &document);
        if evidence {
            let index = self
                .site_references
                .get_or_init(|| crate::evidence_submission::SiteReferenceIndex::of_site(self.site));
            let choices = crate::evidence_submission::reference_choices(post, index);
            data.push_str(&format!(
                "\n<script type=\"application/json\" id=\"{EVIDENCE_DATA_ELEMENT_ID}\">{}</script>",
                script_json(&choices)
            ));
        }
        Some((region, data))
    }

    /// The Third Perspective region of one post (ADR 0114): only a post where
    /// the kind is `open` (`participation.kinds`, the post's own mode and a
    /// hosted transport, ADR 0101) has it. Its static text is the
    /// no-JavaScript path, with the site's feedback contact; the form sends
    /// through the hosted service only where it issues receipts, and
    /// otherwise prepares the reflection to copy and send.
    fn third_perspective(&self, post: &Post) -> Option<String> {
        let c = &self.site.config;
        if participation::effective_mode(c, post, ParticipationKind::ThirdPerspective)
            != ParticipationMode::Open
        {
            return None;
        }
        let endpoint = c.engagement.endpoint.trim().trim_end_matches('/');
        let document = crate::passage_target::PassageDocument::of_post(post, c);
        let contact = c.engagement.feedback_contact.as_str();
        let (contact_attr, contact_words) = if contact.is_empty() {
            (String::new(), String::new())
        } else if let Some(address) = contact.strip_prefix("mailto:") {
            (
                format!(" contact=\"{}\"", attr(contact)),
                format!(" at <a href=\"{}\">{}</a>", attr(contact), text(address)),
            )
        } else {
            (
                format!(" contact=\"{}\"", attr(contact)),
                format!(
                    " through <a href=\"{}\">the contact page</a>",
                    attr(contact)
                ),
            )
        };
        let receipts_attr = if c.engagement.receipts {
            " receipts"
        } else {
            ""
        };
        // Where the site opens author responses on this post, a shared
        // reflection's author sections can be written about by author and
        // place (ADR 0131). Everywhere else the region is as it was.
        let attributed =
            if participation::effective_mode(c, post, ParticipationKind::AuthorResponse)
                == ParticipationMode::Hidden
            {
                crate::attributed_perspective::AttributedSections::default()
            } else {
                crate::attributed_perspective::AttributedSections::of_post(post)
            };
        // The example names the first real section, never a made-up author.
        let attributed_words = match attributed.sections().first() {
            None => String::new(),
            Some(first) => format!(
                " To write about one author’s section, name it by its author and its place among that author’s sections, such as “{}, section 1”.",
                text(&first.author)
            ),
        };
        let attributed_element = attributed_sections_element(post, &attributed);
        Some(format!(
            "<section id=\"{THIRD_PERSPECTIVE_ANCHOR}\" class=\"ob-third-perspective\" aria-labelledby=\"{THIRD_PERSPECTIVE_ANCHOR}-title\">\n<h2 id=\"{THIRD_PERSPECTIVE_ANCHOR}-title\">Offer a Third Perspective</h2>\n<ob-third-perspective endpoint=\"{}\" page=\"{}\"{contact_attr}{receipts_attr}>\n<p>Share your own reading of this work, or of one section of it. If a moderator approves it, it is shown here as a reader’s reflection, never as one of the authors’, and only as you agree: published or not, with your name or without. There are no scores and no votes.</p>\n<p class=\"ob-third-perspective-static\">The form needs JavaScript. Without it, you can write your reflection to the author{contact_words}: say which section it is about, whether it may be published, whether your name may be shown and whether you may be asked to clarify it, and give this page’s passage revision, <code>{}</code>.{attributed_words}</p>\n</ob-third-perspective>\n{attributed_element}</section>\n",
            attr(endpoint),
            attr(&c.absolute(&post.url)),
            text(&document.revision),
        ))
    }

    /// The suggestion region of one post (ADRs 0152 to 0157): only a post where
    /// the site has switched `future-suggestion` on and the post's mode is
    /// `open` has it. Its static text is the no-JavaScript path, naming the
    /// site's feedback contact; where the site has a hosted transport it also
    /// carries `<ob-future-suggestion>`, which sends through the hosted
    /// service only where it issues receipts and otherwise prepares the
    /// suggestion to copy and send. A site with no transport shows only the
    /// contact, and shows nothing at all when it has none, so its pages read as
    /// before. Nothing here is a vote, a count or a list of other readers'
    /// suggestions: they are private to the editors.
    fn future_suggestion(&self, post: &Post) -> Option<String> {
        let c = &self.site.config;
        if participation::configured_mode(c, post, ParticipationKind::FutureSuggestion)
            != ParticipationMode::Open
        {
            return None;
        }
        let transport = participation::transport_available(c);
        let contact = c.engagement.feedback_contact.as_str();
        if !transport && contact.is_empty() {
            return None;
        }
        let (contact_attr, contact_words) = if contact.is_empty() {
            (String::new(), String::new())
        } else if let Some(address) = contact.strip_prefix("mailto:") {
            (
                format!(" contact=\"{}\"", attr(contact)),
                format!(" at <a href=\"{}\">{}</a>", attr(contact), text(address)),
            )
        } else {
            (
                format!(" contact=\"{}\"", attr(contact)),
                format!(
                    " through <a href=\"{}\">the contact page</a>",
                    attr(contact)
                ),
            )
        };
        let intro = "<p>Suggest a question, text, video, audio or other source for the author to consider for future work. It goes to the site’s editors, never to this page; accepting one only means they are interested, not that they agree with it, have checked it or may use it. There are no votes and no counts.</p>";
        let words = format!(
            "<p class=\"ob-future-suggestion-static\">{} you can write your suggestion to the author{contact_words}: say whether it is a question, text, video, audio or other source, give a link if you have one, and say whether you may be contacted about it.</p>",
            if transport {
                "The form needs JavaScript. Without it,"
            } else {
                "This site does not take suggestions through a form, but"
            }
        );
        let heading = format!(
            "<h2 id=\"{FUTURE_SUGGESTION_ANCHOR}-title\">Suggest something for future work</h2>\n"
        );
        let inner = if transport {
            let endpoint = c.engagement.endpoint.trim().trim_end_matches('/');
            let receipts = if c.engagement.receipts {
                " receipts"
            } else {
                ""
            };
            format!(
                "<ob-future-suggestion endpoint=\"{}\" page=\"{}\" work=\"{}\"{contact_attr}{receipts}>\n{intro}\n{words}\n</ob-future-suggestion>\n",
                attr(endpoint),
                attr(&c.absolute(&post.url)),
                attr(&post.url),
            )
        } else {
            format!("{intro}\n{words}\n")
        };
        Some(format!(
            "<section id=\"{FUTURE_SUGGESTION_ANCHOR}\" class=\"ob-future-suggestion\" aria-labelledby=\"{FUTURE_SUGGESTION_ANCHOR}-title\">\n{heading}{inner}</section>\n"
        ))
    }

    /// The post's body HTML. For a shared reflection whose author responses
    /// are not hidden, each author's section gets its `ob-by-` anchor and the
    /// reflections about its current text, with the author's answer, follow
    /// the author's words inside that section's own turn (ADR 0138). Anything
    /// that does not line up (a body that is not a reflection, a section
    /// count that differs from the attributed sections) is left exactly as it
    /// is, so a page without answers is byte for byte what it was.
    fn prose_with_conversations<'p>(&self, post: &'p Post) -> std::borrow::Cow<'p, str> {
        use std::borrow::Cow;
        let c = &self.site.config;
        if participation::published_mode(c, post, ParticipationKind::AuthorResponse)
            == ParticipationMode::Hidden
        {
            return Cow::Borrowed(&post.html);
        }
        let sections = crate::attributed_perspective::AttributedSections::of_post(post);
        if sections.sections().is_empty() {
            return Cow::Borrowed(&post.html);
        }
        let reports = (participation::effective_mode(c, post, ParticipationKind::AbuseReport)
            == ParticipationMode::Open)
            .then(|| c.engagement.endpoint.trim().trim_end_matches('/'));
        let (in_section, _) =
            crate::perspective_publication::split_by_section(post.third_perspectives());
        match anchor_sections(&post.html, &sections, &in_section, reports) {
            Some(html) => Cow::Owned(html),
            None => Cow::Borrowed(&post.html),
        }
    }

    fn site_header(&self, theme: &Theme, current: &str) -> String {
        let c = &self.site.config;
        let mut links: Vec<(String, String)> = c
            .nav
            .iter()
            .map(|l| (l.label.clone(), l.href.clone()))
            .collect();
        for page in self.site.pages.iter().filter(|p| p.nav) {
            links.push((page.title.clone(), page.url.clone()));
        }
        // A site with services gets a link to them, unless its own navigation has one (ADR 0312).
        if !self.site.services.is_empty()
            && !links
                .iter()
                .any(|(_, href)| href.trim_end_matches('/') == "/services")
        {
            links.push((
                "Services".to_string(),
                crate::service::SERVICES_URL.to_string(),
            ));
        }
        // Likewise a link to the towns served, only when areas are listed.
        if !c.service_areas.is_default()
            && !links
                .iter()
                .any(|(_, href)| href.trim_end_matches('/') == "/areas")
        {
            links.push((
                "Areas".to_string(),
                crate::service_area::AREAS_URL.to_string(),
            ));
        }
        let mut h = String::new();
        h.push_str("<header class=\"ob-header\">\n<div class=\"ob-header-inner\">\n");
        let brand_inner = if c.logo.is_empty() {
            format!("<span class=\"ob-brand-name\">{}</span>", text(&c.title))
        } else {
            format!(
                "<img class=\"ob-brand-logo\" src=\"{}\" alt=\"\" width=\"54\" height=\"40\"><span class=\"ob-brand-name\">{}</span>",
                attr(&c.logo),
                text(&c.title)
            )
        };
        h.push_str(&format!(
            "<a class=\"ob-brand\" href=\"/\" aria-label=\"{} home\">{}</a>\n",
            attr(&c.title),
            brand_inner
        ));
        h.push_str("<nav class=\"ob-nav\" aria-label=\"Main navigation\">\n<ul>\n");
        for (i, (label, href)) in links.iter().enumerate() {
            let visible = match &theme.nav_label {
                Some(template) => template
                    .replace("{index}", &format!("{:02}", i + 1))
                    .replace("{label}", label),
                None => label.clone(),
            };
            let current_attr = if href == current {
                " aria-current=\"page\""
            } else {
                ""
            };
            h.push_str(&format!(
                "<li><a class=\"ob-nav-link\" href=\"{}\" aria-label=\"{}\"{}>{}</a></li>\n",
                attr(href),
                attr(label),
                current_attr,
                text(&visible)
            ));
        }
        h.push_str("</ul>\n</nav>\n");
        if c.color_scheme_toggle.unwrap_or(theme.color_scheme_toggle) {
            h.push_str("<ob-theme-toggle hidden><button type=\"button\" class=\"ob-icon-button\" aria-label=\"Toggle light and dark mode\"><span aria-hidden=\"true\">◐</span></button></ob-theme-toggle>\n");
        }
        h.push_str("</div>\n</header>\n");
        h
    }

    fn site_footer(&self) -> String {
        let c = &self.site.config;
        let year = self.site.latest_update().map(|d| d.year()).unwrap_or(2026);
        let mut h = String::from("<footer class=\"ob-footer\">\n<div class=\"ob-footer-inner\">\n");
        let business = c.business.block_html();
        if !business.is_empty() {
            h.push_str(&format!(
                "<section class=\"ob-footer-business\" aria-label=\"Business details\">\n{business}</section>\n"
            ));
        }
        h.push_str(&format!("<p>{}</p>\n", text(&c.footer_text(year))));
        let mut links: Vec<(String, String)> = c
            .social
            .iter()
            .map(|l| (l.label.clone(), l.href.clone()))
            .collect();
        if c.feeds.rss {
            links.push(("RSS".into(), "/rss.xml".into()));
        }
        if !links.is_empty() {
            h.push_str("<nav aria-label=\"Elsewhere\"><ul class=\"ob-footer-links\">\n");
            for (label, href) in links {
                let external = href.starts_with("http");
                let rel = if external { " rel=\"me noopener\"" } else { "" };
                h.push_str(&format!(
                    "<li><a href=\"{}\"{}>{}</a></li>\n",
                    attr(&href),
                    rel,
                    text(&label)
                ));
            }
            h.push_str("</ul></nav>\n");
        }
        if c.powered_by {
            h.push_str("<p class=\"ob-powered\">Powered by <a href=\"https://github.com/journey-to-code-org/open.blog\" rel=\"noopener\">open.blog</a></p>\n");
        }
        h.push_str("</div>\n</footer>\n");
        h
    }

    // ----- building blocks ----------------------------------------------

    fn heading(&self, theme: &Theme, level: u8, label: &str, extra_class: &str) -> String {
        let tag = format!("h{level}");
        // The wrapper name was validated as a custom element name when the theme resolved.
        let inner = match &theme.heading_wrapper {
            Some(tag) => format!("<{tag}>{}</{tag}>", text(label)),
            None => text(label),
        };
        if theme.heading_code_labels {
            format!(
                "<div class=\"ob-heading {extra_class}\"><span class=\"ob-code-label\" aria-hidden=\"true\">&lt;{tag}&gt;</span><{tag} class=\"ob-title\">{inner}</{tag}><span class=\"ob-code-label\" aria-hidden=\"true\">&lt;/{tag}&gt;</span></div>"
            )
        } else {
            format!("<div class=\"ob-heading {extra_class}\"><{tag} class=\"ob-title\">{inner}</{tag}></div>")
        }
    }

    fn time(&self, post: &Post) -> String {
        format!(
            "<time datetime=\"{}\">{}</time>",
            post.date.rfc3339(),
            text(&post.date.short())
        )
    }

    fn post_list(&self, theme: &Theme, indices: &[usize]) -> String {
        if indices.is_empty() {
            return "<p class=\"ob-empty\">Nothing here yet.</p>".to_string();
        }
        let cards = theme.list_style == "cards";
        let mut h = format!(
            "<ul class=\"ob-list {}\">\n",
            if cards {
                "ob-list-cards"
            } else {
                "ob-list-rows"
            }
        );
        for &i in indices {
            let post = &self.site.posts[i];
            if cards {
                h.push_str("<li class=\"ob-card\"><a class=\"ob-card-link\" href=\"");
                h.push_str(&attr(&post.url));
                h.push_str("\">");
                if let Some(cover) = &post.cover {
                    h.push_str(&format!(
                        "<img class=\"ob-card-cover\" src=\"{}\" alt=\"{}\" loading=\"lazy\" decoding=\"async\">",
                        attr(cover),
                        attr(&post.cover_alt)
                    ));
                }
                h.push_str("<span class=\"ob-card-body\"><span class=\"ob-meta\">");
                h.push_str(&self.time(post));
                h.push_str(&format!(" · {} min read</span>", post.reading_minutes));
                h.push_str(&format!(
                    "<h3 class=\"ob-card-title\">{}</h3>",
                    text(&post.title)
                ));
                h.push_str(&format!(
                    "<span class=\"ob-card-summary\">{}</span>",
                    text(&post.description)
                ));
                h.push_str("</span></a></li>\n");
            } else {
                h.push_str(&format!(
                    "<li class=\"ob-row-item\"><a class=\"ob-row\" href=\"{}\"><span class=\"ob-row-body\"><h3 class=\"ob-row-title\">{}</h3><span class=\"ob-meta\">{}</span></span><span class=\"ob-row-arrow\" aria-hidden=\"true\">→</span></a></li>\n",
                    attr(&post.url),
                    text(&post.title),
                    self.time(post)
                ));
            }
        }
        h.push_str("</ul>");
        h
    }

    fn series_cards(&self, theme: &Theme) -> String {
        let mut h = String::from("<ul class=\"ob-list ob-list-cards ob-series-list\">\n");
        for s in self.site.series.iter().filter(|s| !s.posts.is_empty()) {
            let own = self.theme(self.site.theme_for_series(s));
            let _ = theme;
            h.push_str(&format!(
                "<li class=\"ob-card\" data-ob-theme=\"{}\"><a class=\"ob-card-link\" href=\"{}\">",
                attr(&own.name),
                attr(&s.url)
            ));
            if let Some(cover) = &s.cover {
                h.push_str(&format!("<img class=\"ob-card-cover\" src=\"{}\" alt=\"\" loading=\"lazy\" decoding=\"async\">", attr(cover)));
            }
            h.push_str("<span class=\"ob-card-body\">");
            h.push_str(&format!(
                "<span class=\"ob-meta\">{} {}</span>",
                s.posts.len(),
                if s.posts.len() == 1 { "part" } else { "parts" }
            ));
            h.push_str(&format!(
                "<h3 class=\"ob-card-title\">{}</h3>",
                text(&s.name)
            ));
            h.push_str(&format!(
                "<span class=\"ob-card-summary\">{}</span>",
                text(&s.description_text)
            ));
            h.push_str("</span></a></li>\n");
        }
        h.push_str("</ul>");
        h
    }

    fn pager(&self, page_number: usize, page_count: usize) -> String {
        self.pager_with(page_number, page_count, |n| {
            if n == 1 {
                "/".to_string()
            } else {
                format!("/page/{n}/")
            }
        })
    }

    fn pager_with(
        &self,
        page_number: usize,
        page_count: usize,
        url: impl Fn(usize) -> String,
    ) -> String {
        if page_count <= 1 {
            return String::new();
        }
        let mut h = String::from("<nav class=\"ob-pager\" aria-label=\"Pagination\">");
        if page_number > 1 {
            h.push_str(&format!(
                "<a rel=\"prev\" href=\"{}\">← Newer</a>",
                url(page_number - 1)
            ));
        } else {
            h.push_str("<span></span>");
        }
        h.push_str(&format!(
            "<span class=\"ob-pager-status\">Page {page_number} of {page_count}</span>"
        ));
        if page_number < page_count {
            h.push_str(&format!(
                "<a rel=\"next\" href=\"{}\">Older →</a>",
                url(page_number + 1)
            ));
        } else {
            h.push_str("<span></span>");
        }
        h.push_str("</nav>");
        h
    }

    // ----- pages ---------------------------------------------------------

    fn home(
        &self,
        theme: &Theme,
        page_number: usize,
        page_count: usize,
        per_page: usize,
    ) -> String {
        let c = &self.site.config;
        let start = (page_number - 1) * per_page;
        let indices: Vec<usize> = (start..self.site.posts.len().min(start + per_page)).collect();
        let mut body = String::from("<div class=\"ob-container\">\n");
        // A landing page with a visible section replaces the home settings'
        // layout on the first page; every other page, and every site without
        // one, is built exactly as before (ADR 0247).
        let landing = self
            .site
            .landing
            .as_ref()
            .filter(|landing| page_number == 1 && landing.has_visible_sections());
        if let Some(landing) = landing {
            body.push_str(&self.landing_sections(theme, landing, per_page, page_count));
        } else {
            if page_number == 1 && !c.home.intro.trim().is_empty() {
                let intro = markdown::render(
                    &c.home.intro,
                    RenderOptions {
                        heading_anchors: false,
                        concept_links: true,
                        ..Default::default()
                    },
                );
                // An `atlas:` link is only its label here (ADR 0172).
                let intro = if intro.html.contains(crate::concept_links::MARK_PREFIX) {
                    crate::concept_links::link_html(&intro.html, None).html
                } else {
                    intro.html
                };
                body.push_str(&format!(
                    "<section class=\"ob-intro ob-prose\">{intro}</section>\n"
                ));
            }
            body.push_str("<section class=\"ob-section\" aria-labelledby=\"latest\">\n");
            body.push_str(
                &self
                    .heading(theme, 1, &c.home.heading, "ob-section-heading")
                    .replace(
                        "<h1 class=\"ob-title\"",
                        "<h1 id=\"latest\" class=\"ob-title\"",
                    ),
            );
            body.push_str(&self.post_list(theme, &indices));
            body.push_str(&self.pager(page_number, page_count));
            body.push_str("\n</section>\n");
            if page_number == 1
                && c.home.show_series
                && self.site.series.iter().any(|s| !s.posts.is_empty())
            {
                body.push_str("<section class=\"ob-section\" aria-labelledby=\"series\">\n");
                body.push_str(
                    &self
                        .heading(theme, 2, "Series", "ob-section-heading")
                        .replace(
                            "<h2 class=\"ob-title\"",
                            "<h2 id=\"series\" class=\"ob-title\"",
                        ),
                );
                body.push_str(&self.series_cards(theme));
                body.push_str("\n</section>\n");
            }
        }
        body.push_str("</div>");
        let path = if page_number == 1 {
            "/".to_string()
        } else {
            format!("/page/{page_number}/")
        };
        let meta = Meta {
            title: if page_number == 1 {
                c.title.clone()
            } else {
                format!("Page {page_number}")
            },
            description: c.description.clone(),
            path,
            canonical: None,
            kind: "website",
            image: None,
            image_alt: None,
            json_ld: Some({
                let mut blog = serde_json::json!({
                    "@context": "https://schema.org",
                    "@type": "Blog",
                    "name": c.title,
                    "description": c.description,
                    "url": c.absolute("/"),
                    "inLanguage": c.language,
                });
                if let Some(author) = author_json_ld(c) {
                    blog["author"] = author.clone();
                    blog["publisher"] = author;
                }
                blog.to_string()
            }),
            reader_references: None,
            citation_previews: None,
            concept_previews: None,
            passage_data: None,
            participation_scripts: Vec::new(),
            atlas_timeline: false,
            atlas_trail: false,
            reading_path: false,
            interpretation_levels: false,
            theme,
            published: None,
            modified: None,
            tags: Vec::new(),
            highwire: Vec::new(),
            noindex: false,
        };
        self.document(&meta, &body)
    }

    /// A post's page. A post that publishes citations carries its reader
    /// reference data, and the page must hold every marker and note that data
    /// names, each marker linking to its note and back; otherwise the build
    /// stops with a diagnostic naming the post, rather than publish a citation
    /// that leads nowhere.
    fn post(&self, index: usize, post: &Post) -> Result<String, String> {
        let references = post
            .citations()
            .map(ReaderReferences::from_summary)
            .transpose()
            .map_err(|error| format!("{}: citation reference data: {error}", post.source))?;
        let page = self.post_page(index, post, references.as_ref());
        if let Some(references) = &references {
            references.check_page(&page).map_err(|error| {
                format!(
                    "{}: the page's citation anchors do not match its reference data: {error}",
                    post.source
                )
            })?;
        }
        Ok(page)
    }

    fn post_page(
        &self,
        index: usize,
        post: &Post,
        references: Option<&ReaderReferences>,
    ) -> String {
        let c = &self.site.config;
        let theme = self.theme(self.site.theme_for_post(post));
        let series = post
            .series
            .as_deref()
            .and_then(|s| self.site.series_by_slug(s));
        let canonical = resolved_post_canonical(c, post);
        let entity_url = if post.research.is_some() {
            canonical.clone().unwrap_or_else(|| c.absolute(&post.url))
        } else {
            c.absolute(&post.url)
        };

        let mut body = String::from("<div class=\"ob-container ob-container-reading\">\n");
        body.push_str("<article class=\"ob-post h-entry\">\n<header class=\"ob-post-header\">\n");
        if let Some(s) = series {
            body.push_str(&format!(
                "<p class=\"ob-eyebrow\"><a href=\"{}\">{}</a></p>\n",
                attr(&s.url),
                text(&s.name)
            ));
        }
        body.push_str(
            &self
                .heading(theme, 1, &post.title, "ob-post-title")
                .replace("class=\"ob-title\"", "class=\"ob-title p-name\""),
        );
        if let Some(subtitle) = &post.subtitle {
            body.push_str(&format!(
                "\n<p class=\"ob-post-subtitle\">{}</p>",
                text(subtitle)
            ));
        }
        body.push_str("\n<p class=\"ob-meta\">");
        body.push_str(&format!(
            "<time class=\"dt-published\" datetime=\"{}\">{}</time>",
            post.date.rfc3339(),
            text(&post.date.long())
        ));
        match post.credit_provenance {
            CreditProvenance::LegacySiteAuthor if !c.author.name.trim().is_empty() => {
                if c.author.url.trim().is_empty() {
                    body.push_str(&format!(
                        " · By <span class=\"p-author h-card\">{}</span>",
                        text(&c.author.name)
                    ));
                } else {
                    body.push_str(&format!(
                        " · By <a class=\"p-author h-card\" rel=\"author\" href=\"{}\">{}</a>",
                        attr(&c.author.url),
                        text(&c.author.name)
                    ));
                }
            }
            CreditProvenance::ExplicitSidecar => {
                let authors = post.authors().map(author_html).collect::<Vec<_>>();
                if !authors.is_empty() {
                    body.push_str(" · By ");
                    body.push_str(&human_list(&authors));
                }
            }
            CreditProvenance::LegacySiteAuthor => {}
        }
        if let Some(updated) = post.updated {
            if updated.ymd() != post.date.ymd() {
                body.push_str(&format!(
                    " · Updated <time class=\"dt-updated\" datetime=\"{}\">{}</time>",
                    updated.rfc3339(),
                    text(&updated.short())
                ));
            }
        }
        body.push_str(&format!(" · {} min read", post.reading_minutes));
        let hosted_engagement_endpoint = c
            .engagement
            .enabled
            .then_some(c.engagement.endpoint.trim())
            .filter(|endpoint| c.engagement.analytics && !endpoint.is_empty());
        let analytics_endpoint = if c.analytics.endpoint.trim().is_empty() {
            hosted_engagement_endpoint.unwrap_or("")
        } else {
            c.analytics.endpoint.trim()
        };
        if c.analytics.show_views && (c.analytics.builtin || !analytics_endpoint.is_empty()) {
            // A live counter updates this; a baked count shows until then, or forever on a static host.
            let baked = site_views_text(self.site, &post.url);
            body.push_str(&format!(
                "<ob-views path=\"{}\" endpoint=\"{}\">{}</ob-views>",
                attr(&post.url),
                attr(analytics_endpoint.trim_end_matches('/')),
                text(&baked)
            ));
        }
        body.push_str("</p>\n");
        if !post.tags.is_empty() {
            body.push_str("<ul class=\"ob-tags\" aria-label=\"Tags\">");
            for t in &post.tags {
                body.push_str(&format!(
                    "<li><a class=\"p-category\" href=\"/tags/{}/\">{}</a></li>",
                    attr(&t.slug),
                    text(&t.name)
                ));
            }
            body.push_str("</ul>\n");
        }
        body.push_str("</header>\n");
        if post.credit_provenance == CreditProvenance::ExplicitSidecar && !post.credits.is_empty() {
            body.push_str(&contributions_html(post));
        }
        if let Some(research) = &post.research {
            body.push_str(&research.work_meta_html());
        }
        if let Some(shared) = &post.shared_attribution {
            body.push_str(&shared.html());
        }
        if let Some(journal) = &post.field_journal {
            body.push_str(&self.field_journal_card(journal));
        }
        if let Some(video) = &post.video {
            body.push_str(&self.video_production_card(video));
        }
        if c.markdown.embeds {
            if let Some(video) = &post.video {
                if let Some(url) = &video.url {
                    if let Some(mut embed) = crate::embed::detect(url) {
                        embed.title = format!("{} on YouTube", post.title);
                        if !post.html.contains(&embed.frame_src) {
                            body.push_str(&crate::embed::html(&embed));
                        }
                    }
                }
            }
        }
        if theme.post_covers {
            if let Some(cover) = &post.cover {
                body.push_str(&format!(
                    "<figure class=\"ob-cover\"><img class=\"u-photo\" src=\"{}\" alt=\"{}\" decoding=\"async\"></figure>\n",
                    attr(cover),
                    attr(&post.cover_alt)
                ));
            }
        }
        if let Some(recipe) = &post.recipe {
            body.push_str(&self.recipe_open_tag(post, recipe));
            body.push_str(&self.recipe_card(recipe));
        }
        // Table of contents.
        let toc: Vec<_> = post
            .headings
            .iter()
            .filter(|h| h.level >= 2 && h.level <= c.markdown.toc_depth)
            .collect();
        if toc.len() >= c.markdown.toc_min_headings {
            body.push_str("<nav class=\"ob-toc\" aria-label=\"Table of contents\"><details><summary>On this page</summary><ol>");
            for h in toc {
                body.push_str(&format!(
                    "<li class=\"ob-toc-l{}\"><a href=\"#{}\">{}</a></li>",
                    h.level,
                    attr(&h.id),
                    text(&h.text)
                ));
            }
            body.push_str("</ol></details></nav>\n");
        }
        // A post with supplements is enhanced by `<ob-reading-modes>` (ADR
        // 0142): the page is complete without it, so the element carries only
        // the author's default mode and the control is built by script.
        let reading_modes = post
            .reading_depth()
            .filter(|depth| !depth.is_empty())
            .map(|depth| depth.default_mode.as_str());
        if let Some(default_mode) = reading_modes {
            // A site under a folder (GitHub Pages project sites) shares its
            // origin's storage with its siblings, so the choice is kept under
            // the base path (ADR 0144).
            let base = self.site.config.base_path();
            let scope = if base.is_empty() {
                String::new()
            } else {
                format!(" data-ob-base=\"{}\"", attr(&base))
            };
            body.push_str(&format!(
                "<ob-reading-modes default=\"{default_mode}\"{scope}>"
            ));
        }
        body.push_str(&format!(
            "<ob-code{}><div class=\"ob-prose e-content\">{}</div></ob-code>\n",
            self.code_attr(theme, Some(post)),
            self.prose_with_conversations(post)
        ));
        if reading_modes.is_some() {
            body.push_str("</ob-reading-modes>\n");
        }
        if post.recipe.is_some() {
            body.push_str("</ob-recipe>\n");
        }

        if let Some(source) = post.source_notice_html() {
            body.push_str(&source);
        }
        // The author's curated research context for this post (#197): static,
        // complete without JavaScript, from the public curated value only.
        if let Some(section) = self.curated_section(post) {
            body.push_str(&section);
        }
        body.push_str(&self.in_paths_section("post", &post.slug));
        if c.share.enabled {
            body.push_str(&self.share_block(post));
        }
        if let Some(s) = series {
            body.push_str(&self.series_box(index, post, s));
        }
        let related = self.site.related(index, c.related_posts);
        if !related.is_empty() {
            body.push_str("<section class=\"ob-related\" aria-labelledby=\"related\">\n<h2 id=\"related\" class=\"ob-related-title\">Related posts</h2>\n");
            body.push_str(&self.post_list(theme, &related));
            body.push_str("\n</section>\n");
        }
        body.push_str(&self.chronological_nav(index));
        // Approved reader notes, with the author's responses, are shown on
        // the canonical page only (ADR 0083), before the form that asks for
        // more.
        // Abuse reports (ADR 0107): offered under each public comment and
        // published note while the site has them open.
        let reports_endpoint =
            (participation::effective_mode(c, post, ParticipationKind::AbuseReport)
                == ParticipationMode::Open)
                .then(|| c.engagement.endpoint.trim().trim_end_matches('/'));
        body.push_str(&crate::feedback_publication::render_section(
            post.reader_feedback(),
            reports_endpoint,
        ));
        let passage_feedback = self.passage_feedback(post);
        if let Some((region, _)) = &passage_feedback {
            body.push_str(region);
        }
        // A reader's own highlights and private notes (ADR 0241), kept in
        // that reader's browser; the region's static text is the no-JavaScript path.
        let reader_annotations = c.reader_annotations.enabled;
        if reader_annotations {
            body.push_str(READER_ANNOTATIONS_REGION);
            body.push_str(READER_REFLECTION_HISTORY_REGION);
            body.push_str(READER_TRAIL_REGION);
        }
        // Approved Third Perspectives, each a reader's and never an author's,
        // are shown on the canonical page only (ADRs 0111 and 0115), apart
        // from the authors' text and before the form that asks for more.
        body.push_str(&crate::perspective_publication::render_section(
            post.third_perspectives(),
            reports_endpoint,
        ));
        // Reflections the editors chose to feature, after the reflections they
        // come from and framed as an editorial choice (ADR 0184).
        body.push_str(&crate::community_feature::render_section(
            post.community_features(),
        ));
        // Where earlier questions went and what this post continues: plain
        // links on the canonical page, never a count or a form (ADR 0218).
        let continued = post.continuations();
        body.push_str(&crate::continuation::render_section(
            crate::continuation::Direction::Later,
            &continued.later,
            &continued.titles,
        ));
        body.push_str(&crate::continuation::render_section(
            crate::continuation::Direction::Earlier,
            &continued.earlier,
            &continued.titles,
        ));
        let third_perspective = self.third_perspective(post);
        if let Some(region) = &third_perspective {
            body.push_str(region);
        }
        let future_suggestion = self.future_suggestion(post);
        if let Some(region) = &future_suggestion {
            body.push_str(region);
        }
        let comment_mode = participation::effective_mode(c, post, ParticipationKind::Comment);
        if comment_mode != ParticipationMode::Hidden {
            let mode = if comment_mode == ParticipationMode::Locked {
                " mode=\"locked\""
            } else {
                ""
            };
            let reports = if reports_endpoint.is_some() {
                " reports"
            } else {
                ""
            };
            let captcha =
                if c.engagement.captcha.enabled() && comment_mode != ParticipationMode::Locked {
                    format!(
                        " captcha-provider=\"{}\" captcha-site-key=\"{}\" captcha-scope=\"{}\"",
                        attr(&c.engagement.captcha.provider),
                        attr(&c.engagement.captcha.site_key),
                        attr(&c.engagement.captcha.scope)
                    )
                } else {
                    String::new()
                };
            body.push_str(&format!(
                "<section id=\"{}\" aria-label=\"Discussion\"><ob-comments path=\"{}\" endpoint=\"{}\"{}{}{}><p>Comments require JavaScript.</p></ob-comments></section>\n",
                crate::model::DISCUSSION_ANCHOR,
                attr(&post.url),
                attr(c.engagement.endpoint.trim().trim_end_matches('/')),
                mode,
                reports,
                captcha,
            ));
        }
        if !c.snippets.post_footer.trim().is_empty() {
            body.push_str("<div class=\"ob-post-extra\">\n");
            body.push_str(c.snippets.post_footer.trim());
            body.push_str("\n</div>\n");
        }
        body.push_str("</article>\n</div>");

        let meta = Meta {
            title: post.title.clone(),
            description: post.description.clone(),
            path: post.url.clone(),
            canonical,
            kind: "article",
            image: post.cover.clone().or_else(|| {
                post.video
                    .as_ref()
                    .and_then(|video| video.thumbnail.clone())
            }),
            image_alt: (!post.cover_alt.is_empty()).then(|| post.cover_alt.clone()),
            json_ld: Some({
                let mut posting = serde_json::json!({
                    "@context": "https://schema.org",
                    "@type": "BlogPosting",
                    "headline": post.title,
                    "description": post.description,
                    "datePublished": post.date.rfc3339(),
                    "dateModified": post.updated.unwrap_or(post.date).rfc3339(),
                    "mainEntityOfPage": entity_url,
                    "url": entity_url,
                    "image": post.cover.as_ref().map(|i| c.absolute(i)),
                    "keywords": post.tags.iter().map(|t| t.name.clone()).collect::<Vec<_>>().join(", "),
                    "wordCount": post.word_count,
                    "isPartOf": series.map(|s| serde_json::json!({ "@type": "CreativeWorkSeries", "name": s.name, "url": c.absolute(&s.url) })),
                });
                if let Some(subtitle) = &post.subtitle {
                    posting["alternativeHeadline"] = serde_json::json!(subtitle);
                }
                match post.credit_provenance {
                    CreditProvenance::LegacySiteAuthor => {
                        if let Some(author) = author_json_ld(c) {
                            posting["author"] = author.clone();
                            posting["publisher"] = author;
                        }
                    }
                    CreditProvenance::ExplicitSidecar => {
                        let authors = post
                            .authors()
                            .map(|credit| contributor_json_ld(c, credit, &entity_url))
                            .collect::<Vec<_>>();
                        if !authors.is_empty() {
                            posting["author"] = serde_json::Value::Array(authors);
                        }
                        let contributors = post
                            .credits
                            .iter()
                            .filter(|credit| !credit.roles.iter().any(|role| role.is_author()))
                            .map(|credit| contributor_json_ld(c, credit, &entity_url))
                            .collect::<Vec<_>>();
                        if !contributors.is_empty() {
                            posting["contributor"] = serde_json::Value::Array(contributors);
                        }
                        if let Some(publisher) = author_json_ld(c) {
                            posting["publisher"] = publisher;
                        }
                    }
                }
                if let Some((video, embed_url, thumbnail)) = post.video.as_ref().and_then(|video| {
                    Some((
                        video,
                        video.embed_url()?,
                        video.thumbnail.as_ref().or(post.cover.as_ref())?,
                    ))
                }) {
                    posting["@type"] = serde_json::json!("VideoObject");
                    posting["name"] = serde_json::json!(post.title);
                    posting["uploadDate"] = serde_json::json!(post.date.rfc3339());
                    if let Some(object) = posting.as_object_mut() {
                        object.remove("headline");
                        object.remove("wordCount");
                    }
                    posting["thumbnailUrl"] = serde_json::json!(c.absolute(thumbnail));
                    posting["embedUrl"] = serde_json::json!(embed_url);
                    if let Some(duration) = video.iso_duration() {
                        posting["duration"] = serde_json::json!(duration);
                    }
                    if let Some(disclosure) = &video.ai_disclosure {
                        posting["creditText"] = serde_json::json!(disclosure);
                    }
                }
                if let Some(research) = &post.research {
                    posting["@type"] = serde_json::json!("ScholarlyArticle");
                    if let Some(object) = posting.as_object_mut() {
                        object.remove("publisher");
                    }
                    if let Some(doi_url) = &research.doi_url {
                        posting["identifier"] = serde_json::json!(doi_url);
                    }
                    if let Some(license_url) = &research.license_url {
                        posting["license"] = serde_json::json!(license_url);
                    }
                    if !research.references.is_empty() {
                        posting["citation"] = serde_json::json!(research
                            .references
                            .iter()
                            .map(|reference| &reference.url)
                            .collect::<Vec<_>>());
                    }
                }
                if let Some(journal) = &post.field_journal {
                    posting["about"] = serde_json::json!({
                        "@type": "Thing",
                        "name": journal.activity,
                    });
                    if let Some(location) = &journal.location {
                        posting["contentLocation"] = serde_json::json!({
                            "@type": "Place",
                            "name": location,
                        });
                    }
                }
                match &post.recipe {
                    // A recipe page describes both the article and the recipe.
                    Some(recipe) => {
                        let mut posting = posting;
                        if let Some(o) = posting.as_object_mut() {
                            o.remove("@context");
                        }
                        serde_json::json!({
                            "@context": "https://schema.org",
                            "@graph": [posting, self.recipe_json_ld(post, recipe)],
                        })
                        .to_string()
                    }
                    None => posting.to_string(),
                }
            }),
            reader_references: references.map(ReaderReferences::to_script_element),
            participation_scripts: [
                passage_feedback.as_ref().map(|_| "ob-passage-feedback.js"),
                reader_annotations.then_some("ob-annotations.js"),
                reader_annotations.then_some("ob-reflection-history.js"),
                reader_annotations.then_some("ob-reading-trail.js"),
                third_perspective
                    .as_ref()
                    .map(|_| "ob-third-perspective.js"),
                // Only where there is a hosted service to send to; a site with
                // none keeps the static text alone and loads nothing.
                future_suggestion
                    .as_ref()
                    .filter(|_| participation::transport_available(c))
                    .map(|_| "ob-future-suggestion.js"),
            ]
            .into_iter()
            .flatten()
            .collect(),
            passage_data: passage_feedback.map(|(_, data)| data).or_else(|| {
                (third_perspective.is_some() || reader_annotations).then(|| {
                    passage_data_element(
                        post,
                        &crate::passage_target::PassageDocument::of_post(post, c),
                    )
                })
            }),
            atlas_timeline: false,
            atlas_trail: false,
            reading_path: false,
            interpretation_levels: false,
            citation_previews: references.and(post.citations()).map(|summary| {
                format!(
                    "<ob-citation-previews note-label=\"{}\"></ob-citation-previews>",
                    attr(summary.locale.go_to_words(summary.style))
                )
            }),
            concept_previews: self.concept_previews(post),
            theme,
            published: Some(post.date.rfc3339()),
            modified: post.updated.map(|u| u.rfc3339()),
            tags: post.tags.iter().map(|t| t.name.clone()).collect(),
            highwire: if post.research.is_some()
                && post
                    .authors()
                    .any(|credit| !credit.contributor.name.trim().is_empty())
            {
                let date = post.date.civil();
                let mut highwire = vec![("citation_title", post.title.clone())];
                highwire.extend(
                    post.authors()
                        .filter(|credit| !credit.contributor.name.trim().is_empty())
                        .map(|credit| {
                            (
                                "citation_author",
                                credit.contributor.name.trim().to_string(),
                            )
                        }),
                );
                highwire.push((
                    "citation_publication_date",
                    format!("{}/{}/{}", date.year, date.month, date.day),
                ));
                highwire
            } else {
                Vec::new()
            },
            noindex: false,
        };
        self.document(&meta, &body)
    }

    /// Share links. Plain anchors, so they work without JavaScript; the
    /// `<ob-share>` element adds the native share sheet and a copy button.
    fn share_block(&self, post: &Post) -> String {
        let c = &self.site.config;
        let url = c.absolute(&post.url);
        let u = crate::escape::url_component(&url);
        let t = crate::escape::url_component(&post.title);
        let mut links: Vec<(&str, String, bool)> = Vec::new();
        for network in &c.share.networks {
            let (label, href, external) = match network.trim().to_ascii_lowercase().as_str() {
                "x" | "twitter" => (
                    "X",
                    format!("https://twitter.com/intent/tweet?text={t}&url={u}"),
                    true,
                ),
                "bluesky" => (
                    "Bluesky",
                    format!("https://bsky.app/intent/compose?text={t}%20{u}"),
                    true,
                ),
                "mastodon" => (
                    "Mastodon",
                    format!("https://mastodonshare.com/?text={t}&url={u}"),
                    true,
                ),
                "linkedin" => (
                    "LinkedIn",
                    format!("https://www.linkedin.com/sharing/share-offsite/?url={u}"),
                    true,
                ),
                "facebook" => (
                    "Facebook",
                    format!("https://www.facebook.com/sharer/sharer.php?u={u}"),
                    true,
                ),
                "reddit" => (
                    "Reddit",
                    format!("https://www.reddit.com/submit?url={u}&title={t}"),
                    true,
                ),
                "hackernews" | "hn" => (
                    "Hacker News",
                    format!("https://news.ycombinator.com/submitlink?u={u}&t={t}"),
                    true,
                ),
                "email" => ("Email", format!("mailto:?subject={t}&body={u}"), false),
                _ => continue,
            };
            links.push((label, href, external));
        }
        let mut h = format!(
            "<ob-share url=\"{}\" title=\"{}\">\n<nav class=\"ob-share\" aria-label=\"Share this post\">\n<span class=\"ob-share-label\">Share</span>\n<ul>\n",
            attr(&url),
            attr(&post.title)
        );
        for (label, href, external) in links {
            let extra = if external {
                " target=\"_blank\" rel=\"noopener noreferrer\""
            } else {
                ""
            };
            h.push_str(&format!(
                "<li><a href=\"{}\"{extra}>{}</a></li>\n",
                attr(&href),
                text(label)
            ));
        }
        h.push_str("</ul>\n</nav>\n</ob-share>\n");
        h
    }

    /// A tiny page at an old address that sends readers (and search engines,
    /// via the canonical link) to the post's current address.
    fn alias_page(&self, target: &str, title: &str) -> String {
        let c = &self.site.config;
        let absolute = c.absolute(target);
        let html = format!(
            "<!doctype html>\n<html lang=\"{lang}\">\n<head>\n<meta charset=\"utf-8\">\n<title>{title}</title>\n<meta name=\"robots\" content=\"noindex\">\n<link rel=\"canonical\" href=\"{abs}\">\n<meta http-equiv=\"refresh\" content=\"0; url={target}\">\n</head>\n<body>\n<p>This page has moved to <a href=\"{target}\">{abs}</a>.</p>\n</body>\n</html>\n",
            lang = attr(&c.language),
            title = text(title),
            abs = attr(&absolute),
            target = attr(target),
        );
        c.apply_base_path(&html)
    }

    /// Attributes for `<ob-code>`: what the component does to code blocks.
    /// A post's front matter beats the site's `code` settings, which beat the
    /// theme. (A fence's own options are read by the component itself.)
    fn code_attr(&self, theme: &Theme, post: Option<&Post>) -> String {
        let code = &self.site.config.code;
        let highlight = post
            .and_then(|p| p.code_highlight)
            .or(code.highlight)
            .unwrap_or(theme.code_highlighting);
        let line_numbers = post
            .and_then(|p| p.code_line_numbers)
            .or(code.line_numbers)
            .unwrap_or(theme.code_line_numbers);
        let mut attrs = String::new();
        if highlight {
            attrs.push_str(" highlight");
        }
        if line_numbers {
            attrs.push_str(" line-numbers");
        }
        if !code.copy_button {
            attrs.push_str(" no-copy");
        }
        attrs
    }

    /// The summary card at the top of a recipe: times, servings, and the
    /// "Jump to recipe" link. `<ob-recipe>` adds the interactive controls.
    fn field_journal_card(&self, journal: &crate::field_journal::FieldJournalMetadata) -> String {
        let mut facts = Vec::new();
        let mut fact = |label: &str, value: String| {
            facts.push(format!(
                "<div><dt>{}</dt><dd>{}</dd></div>",
                text(label),
                text(&value)
            ));
        };
        fact("Activity", journal.activity.clone());
        if let Some(location) = &journal.location {
            fact("Area", location.clone());
        }
        if let Some(distance) = &journal.distance_km {
            fact("Distance", format!("{distance} km"));
        }
        if let Some(gain) = journal.elevation_gain_m {
            fact("Elevation gain", format!("{gain} m"));
        }
        if let Some(seconds) = journal.duration_seconds {
            let hours = seconds / 3600;
            let minutes = seconds % 3600 / 60;
            let value = if hours > 0 {
                format!("{hours} hr {minutes} min")
            } else {
                format!("{minutes} min")
            };
            fact("Duration", value);
        }
        fact("Location privacy", journal.privacy.label().to_string());

        let mut out = String::from(
            "<aside class=\"ob-field-journal\" aria-label=\"Field journal summary\">\n<h2>Field notes</h2>\n",
        );
        out.push_str(&format!("<dl>{}</dl>\n", facts.join("")));
        if let Some(conditions) = &journal.conditions {
            out.push_str(&format!(
                "<p><strong>Conditions:</strong> {}</p>\n",
                text(conditions)
            ));
        }
        if let Some(points) = &journal.route_shape {
            let lines = points
                .split('|')
                .map(|segment| format!("<polyline points=\"{}\"></polyline>", attr(segment.trim())))
                .collect::<String>();
            out.push_str(&format!(
                "<figure><svg class=\"ob-field-route\" viewBox=\"0 0 1000 100\" role=\"img\" aria-label=\"Privacy-filtered route outline\">{}</svg><figcaption>{}</figcaption></figure>\n",
                lines,
                text(journal.privacy.label())
            ));
        }
        if let Some(points) = &journal.elevation_profile {
            let lines = points
                .split('|')
                .map(|segment| format!("<polyline points=\"{}\"></polyline>", attr(segment.trim())))
                .collect::<String>();
            out.push_str(&format!(
                "<figure><svg class=\"ob-field-elevation\" viewBox=\"0 0 1000 100\" role=\"img\" aria-label=\"Elevation profile\">{}</svg><figcaption>Elevation profile</figcaption></figure>\n",
                lines
            ));
        }
        if let Some(route) = &journal.route_url {
            out.push_str(&format!(
                "<p><a href=\"{}\" download>Download GPX track</a></p>\n",
                attr(route)
            ));
        }
        out.push_str("</aside>\n");
        out
    }

    fn video_production_card(&self, video: &crate::video::VideoMetadata) -> String {
        video.production_notes_html()
    }

    fn recipe_card(&self, recipe: &crate::recipe::Recipe) -> String {
        let rc = &self.site.config.recipes;
        let facts = recipe.facts_html(true);
        let mut h =
            String::from("<section class=\"ob-recipe-card\" aria-label=\"Recipe summary\">\n");
        if !facts.is_empty() {
            h.push_str(&format!("<dl class=\"ob-recipe-facts\">{facts}</dl>\n"));
        }
        h.push_str("<div class=\"ob-recipe-actions\">");
        if rc.jump_link {
            if let Some(anchor) = &recipe.anchor {
                h.push_str(&format!(
                    "<a class=\"ob-recipe-jump\" href=\"#{}\">Jump to recipe</a>",
                    attr(anchor)
                ));
            }
        }
        h.push_str("</div>\n</section>\n");
        h
    }

    /// `<ob-recipe>` with one attribute per enabled feature.
    fn recipe_open_tag(&self, post: &Post, recipe: &crate::recipe::Recipe) -> String {
        let rc = &self.site.config.recipes;
        let mut tag = format!("<ob-recipe key=\"{}\"", attr(&post.url));
        if rc.scaling {
            if let Some(n) = recipe.servings {
                tag.push_str(&format!(" servings=\"{n}\" scaling"));
            }
        }
        for (on, name) in [
            (rc.checklists, "checklists"),
            (rc.timers, "timers"),
            (rc.cook_mode, "cook-mode"),
            (rc.print, "print"),
        ] {
            if on {
                tag.push(' ');
                tag.push_str(name);
            }
        }
        tag.push_str(">\n");
        tag
    }

    /// schema.org `Recipe` for search engines' recipe results.
    fn recipe_json_ld(&self, post: &Post, recipe: &crate::recipe::Recipe) -> serde_json::Value {
        use crate::recipe::iso_duration;
        let c = &self.site.config;
        let mut r = serde_json::json!({
            "@type": "Recipe",
            "name": post.title,
            "description": post.description,
            "datePublished": post.date.rfc3339(),
            "url": c.absolute(&post.url),
            "mainEntityOfPage": c.absolute(&post.url),
            "recipeIngredient": recipe.ingredients,
            "recipeInstructions": recipe.steps.iter().enumerate().map(|(i, s)| serde_json::json!({
                "@type": "HowToStep",
                "position": i + 1,
                "text": s,
            })).collect::<Vec<_>>(),
            "keywords": post.tags.iter().map(|t| t.name.clone()).collect::<Vec<_>>().join(", "),
        });
        let obj = r.as_object_mut().expect("json object");
        if let Some(author) = author_json_ld(c) {
            obj.insert("author".into(), author);
        }
        if let Some(image) = &post.cover {
            obj.insert("image".into(), serde_json::json!([c.absolute(image)]));
        }
        for (key, minutes) in [
            ("prepTime", recipe.prep),
            ("cookTime", recipe.cook),
            ("totalTime", recipe.total),
        ] {
            if let Some(m) = minutes {
                obj.insert(key.into(), serde_json::json!(iso_duration(m)));
            }
        }
        let yields: Vec<String> = recipe
            .servings_text
            .iter()
            .map(|s| {
                if recipe.servings.is_some_and(|n| s.parse::<u32>() == Ok(n)) {
                    format!("{s} servings")
                } else {
                    s.clone()
                }
            })
            .chain(recipe.yield_text.clone())
            .collect();
        if !yields.is_empty() {
            obj.insert("recipeYield".into(), serde_json::json!(yields));
        }
        if let Some(v) = &recipe.cuisine {
            obj.insert("recipeCuisine".into(), serde_json::json!(v));
        }
        if let Some(v) = &recipe.category {
            obj.insert("recipeCategory".into(), serde_json::json!(v));
        }
        if let Some(v) = &recipe.calories {
            obj.insert(
                "nutrition".into(),
                serde_json::json!({ "@type": "NutritionInformation", "calories": v }),
            );
        }
        r
    }

    fn series_box(&self, index: usize, post: &Post, series: &Series) -> String {
        let position = series.posts.iter().position(|&i| i == index).unwrap_or(0);
        let (prev, next) = self.site.series_neighbors(index);
        // Only a series holding a collaborative work names its parts' authors (ADR 0040); every
        // other series keeps exactly the markup it always had.
        let credited = self.site.series_is_collaborative(series);
        let credit = |part: &Post, lead: &str| match credited.then(|| part_credit(part)).flatten() {
            Some(by) => format!("{lead}<span class=\"ob-meta ob-part-credit\">{by}</span>"),
            None => String::new(),
        };
        let mut h =
            String::from("<aside class=\"ob-series-box\" aria-label=\"Series navigation\">\n");
        h.push_str(&format!(
            "<p class=\"ob-eyebrow\">Part {} of {} in <a href=\"{}\">{}</a></p>\n",
            position + 1,
            series.posts.len(),
            attr(&series.url),
            text(&series.name)
        ));
        // One cell per part, decorative: the position is already spoken in the eyebrow and the
        // list below. A theme script may mark cells the reader has completed.
        h.push_str("<ol class=\"ob-series-path\" aria-hidden=\"true\">");
        for n in 0..series.posts.len() {
            let here = if n == position { " data-current" } else { "" };
            h.push_str(&format!("<li{here}></li>"));
        }
        h.push_str(
            "</ol>
<div class=\"ob-series-nav\">",
        );
        // Both slots are always links, so the control looks and behaves the same on every
        // part. The first part's "previous" is the series overview; the last part's "next"
        // is the way back to it.
        match prev {
            Some(p) => h.push_str(&format!(
                "<a class=\"ob-series-prev\" rel=\"prev\" href=\"{}\"><span class=\"ob-meta\">Previous part</span><span>{}</span>{}</a>",
                attr(&p.url),
                text(&p.title),
                credit(p, "")
            )),
            None => h.push_str(&format!(
                "<a class=\"ob-series-prev ob-series-edge\" href=\"{}\"><span class=\"ob-meta\">Start of series</span><span>Series overview</span></a>",
                attr(&series.url)
            )),
        }
        match next {
            Some(n) => h.push_str(&format!(
                "<a class=\"ob-series-next\" rel=\"next\" href=\"{}\"><span class=\"ob-meta\">Next part</span><span>{}</span>{}</a>",
                attr(&n.url),
                text(&n.title),
                credit(n, "")
            )),
            None => h.push_str(&format!(
                "<a class=\"ob-series-next ob-series-edge\" href=\"{}\"><span class=\"ob-meta\">End of series</span><span>Back to {}</span></a>",
                attr(&series.url),
                text(&series.name)
            )),
        }
        h.push_str("</div>\n<details class=\"ob-series-parts-details\"><summary>All parts</summary><ol class=\"ob-series-parts\">");
        for &i in &series.posts {
            let part = &self.site.posts[i];
            let current = if part.slug == post.slug {
                " aria-current=\"page\""
            } else {
                ""
            };
            h.push_str(&format!(
                "<li><a href=\"{}\"{}>{}</a>{}</li>",
                attr(&part.url),
                current,
                text(&part.title),
                credit(part, " ")
            ));
        }
        h.push_str("</ol></details>\n</aside>\n");
        h
    }

    fn chronological_nav(&self, index: usize) -> String {
        // `posts` is newest first, so the "older" post is at index + 1.
        let newer = index.checked_sub(1).map(|i| &self.site.posts[i]);
        let older = self.site.posts.get(index + 1);
        if newer.is_none() && older.is_none() {
            return String::new();
        }
        let mut h =
            String::from("<nav class=\"ob-pager ob-post-pager\" aria-label=\"More posts\">");
        match older {
            Some(p) => h.push_str(&format!(
                "<a rel=\"prev\" href=\"{}\">← {}</a>",
                attr(&p.url),
                text(&p.title)
            )),
            None => h.push_str("<span></span>"),
        }
        match newer {
            Some(p) => h.push_str(&format!(
                "<a rel=\"next\" href=\"{}\">{} →</a>",
                attr(&p.url),
                text(&p.title)
            )),
            None => h.push_str("<span></span>"),
        }
        h.push_str("</nav>\n");
        h
    }

    fn series_index(&self, theme: &Theme) -> String {
        let mut body =
            String::from("<div class=\"ob-container\">\n<section class=\"ob-section\">\n");
        body.push_str(&self.heading(theme, 1, "Series", "ob-section-heading"));
        body.push_str("\n<p class=\"ob-lede\">Multi-part guides, in reading order.</p>\n");
        if self.site.series.iter().any(|s| !s.posts.is_empty()) {
            body.push_str(&self.series_cards(theme));
        } else {
            body.push_str("<p class=\"ob-empty\">No series yet. Add <code>series: my-series</code> to a post's front matter.</p>");
        }
        body.push_str("\n</section>\n</div>");
        self.simple(
            theme,
            "Series",
            "Multi-part guides and tutorials.",
            "/series/",
            &body,
        )
    }

    fn series_page(&self, series: &Series) -> String {
        let theme = self.theme(self.site.theme_for_series(series));
        let mut body = String::from(
            "<div class=\"ob-container ob-container-reading\">\n<section class=\"ob-section\">\n",
        );
        body.push_str("<p class=\"ob-eyebrow\"><a href=\"/series/\">Series</a></p>\n");
        body.push_str(&self.heading(theme, 1, &series.name, "ob-section-heading"));
        if let Some(cover) = &series.cover {
            body.push_str(&format!("<figure class=\"ob-cover\"><img src=\"{}\" alt=\"\" decoding=\"async\"></figure>\n", attr(cover)));
        }
        if !series.description_html.trim().is_empty() {
            body.push_str(&format!(
                "<div class=\"ob-prose\">{}</div>\n",
                series.description_html
            ));
        }
        // Only a series holding a collaborative work names its contributors and each part's
        // authors (ADR 0040); every other series keeps exactly the markup it always had.
        let credited = self.site.series_is_collaborative(series);
        if credited {
            let names = credit_names(self.site.series_contributors(series));
            if !names.is_empty() {
                body.push_str(&format!(
                    "<p class=\"ob-meta ob-series-contributors\">Contributors: {}</p>\n",
                    human_list(&names)
                ));
            }
        }
        body.push_str("<ol class=\"ob-series-parts ob-series-parts-full\">\n");
        for (n, &i) in series.posts.iter().enumerate() {
            let post = &self.site.posts[i];
            let by = match credited.then(|| part_credit(post)).flatten() {
                Some(by) => format!("<span class=\"ob-part-credit\">{by}</span> · "),
                None => String::new(),
            };
            body.push_str(&format!(
                "<li><a class=\"ob-part\" href=\"{}\"><span class=\"ob-part-number\" aria-hidden=\"true\">{:02}</span><span class=\"ob-part-body\"><span class=\"ob-part-title\">{}</span><span class=\"ob-part-summary\">{}</span><span class=\"ob-meta\">{}{} · {} min read</span></span></a></li>\n",
                attr(&post.url),
                n + 1,
                text(&post.title),
                text(&post.description),
                by,
                self.time(post),
                post.reading_minutes
            ));
        }
        body.push_str("</ol>\n</section>\n</div>");
        self.simple(
            theme,
            &series.name,
            &series.description_text,
            &series.url,
            &body,
        )
    }

    fn tags_index(&self, theme: &Theme) -> String {
        let mut body =
            String::from("<div class=\"ob-container\">\n<section class=\"ob-section\">\n");
        body.push_str(&self.heading(theme, 1, "Tags", "ob-section-heading"));
        body.push_str("\n<ul class=\"ob-tags ob-tag-cloud\">");
        for t in &self.site.tags {
            body.push_str(&format!(
                "<li><a href=\"{}\">{} <span class=\"ob-count\">{}</span></a></li>",
                attr(&t.url),
                text(&t.name),
                t.posts.len()
            ));
        }
        body.push_str("</ul>\n</section>\n</div>");
        self.simple(theme, "Tags", "Browse posts by topic.", "/tags/", &body)
    }

    fn tag_page(&self, theme: &Theme, tag: &crate::model::Tag) -> String {
        let mut body =
            String::from("<div class=\"ob-container\">\n<section class=\"ob-section\">\n");
        body.push_str("<p class=\"ob-eyebrow\"><a href=\"/tags/\">Tag</a></p>\n");
        body.push_str(&self.heading(theme, 1, &tag.name, "ob-section-heading"));
        body.push('\n');
        body.push_str(&self.post_list(theme, &tag.posts));
        body.push_str("\n</section>\n</div>");
        self.simple(
            theme,
            &tag.name,
            &format!("Posts tagged {}.", tag.name),
            &tag.url,
            &body,
        )
    }

    fn job_archive_page(
        &self,
        theme: &Theme,
        plan: &[crate::job_archive::JobArchive],
        archive: &crate::job_archive::JobArchive,
        page_number: usize,
        per_page: usize,
    ) -> String {
        use crate::job_archive::{JobArchiveKind, JOBS_URL};
        let page_count = archive.page_count(per_page);
        let start = if per_page == 0 {
            0
        } else {
            (page_number - 1) * per_page
        };
        let end = if per_page == 0 {
            archive.posts.len()
        } else {
            archive.posts.len().min(start + per_page)
        };
        let mut body =
            String::from("<div class=\"ob-container\">\n<section class=\"ob-section\">\n");
        let eyebrow = match archive.kind {
            JobArchiveKind::All => format!("<a href=\"{JOBS_URL}\">Jobs</a>"),
            JobArchiveKind::Trade => {
                format!("<a href=\"{JOBS_URL}\">Jobs</a> · {}", text(&archive.title))
            }
            JobArchiveKind::Service => {
                let trade = plan.iter().find(|other| {
                    other.kind == JobArchiveKind::Trade && other.trade == archive.trade
                });
                match trade {
                    Some(trade) => format!(
                        "<a href=\"{JOBS_URL}\">Jobs</a> · <a href=\"{}\">{}</a>",
                        attr(&trade.url),
                        text(&trade.title)
                    ),
                    None => format!("<a href=\"{JOBS_URL}\">Jobs</a>"),
                }
            }
        };
        body.push_str(&format!("<p class=\"ob-eyebrow\">{eyebrow}</p>\n"));
        body.push_str(&self.heading(theme, 1, &archive.title, "ob-section-heading"));
        body.push('\n');
        if page_number == 1 {
            let children: Vec<&crate::job_archive::JobArchive> = plan
                .iter()
                .filter(|child| match archive.kind {
                    JobArchiveKind::All => child.kind == JobArchiveKind::Trade,
                    JobArchiveKind::Trade => {
                        child.kind == JobArchiveKind::Service && child.trade == archive.trade
                    }
                    JobArchiveKind::Service => false,
                })
                .collect();
            if !children.is_empty() {
                body.push_str("<ul class=\"ob-tags ob-tag-cloud\">");
                for child in children {
                    body.push_str(&format!(
                        "<li><a href=\"{}\">{} <span class=\"ob-count\">{}</span></a></li>",
                        attr(&child.url),
                        text(&child.title),
                        child.posts.len()
                    ));
                }
                body.push_str("</ul>\n");
            }
        }
        body.push_str(&self.post_list(theme, &archive.posts[start..end]));
        body.push_str(&self.pager_with(page_number, page_count, |n| archive.page_url(n)));
        body.push_str("\n</section>\n</div>");
        let title = if page_number == 1 {
            archive.title.clone()
        } else {
            format!("{} · Page {page_number}", archive.title)
        };
        self.simple(
            theme,
            &title,
            &archive.description,
            &archive.page_url(page_number),
            &body,
        )
    }

    fn archive(&self, theme: &Theme) -> String {
        let mut body =
            String::from("<div class=\"ob-container\">\n<section class=\"ob-section\">\n");
        body.push_str(&self.heading(theme, 1, "Archive", "ob-section-heading"));
        let mut year = i64::MIN;
        for (i, post) in self.site.posts.iter().enumerate() {
            let y = post.date.year();
            if y != year {
                if year != i64::MIN {
                    body.push_str("</ul>\n");
                }
                body.push_str(&format!(
                    "<h2 class=\"ob-archive-year\">{y}</h2>\n<ul class=\"ob-archive\">\n"
                ));
                year = y;
            }
            let _ = i;
            body.push_str(&format!(
                "<li><a href=\"{}\">{}</a> <span class=\"ob-meta\">{}</span></li>\n",
                attr(&post.url),
                text(&post.title),
                self.time(post)
            ));
        }
        if year != i64::MIN {
            body.push_str("</ul>\n");
        } else {
            body.push_str("<p class=\"ob-empty\">Nothing here yet.</p>");
        }
        body.push_str("</section>\n</div>");
        self.simple(
            theme,
            "Archive",
            "Every post, newest first.",
            "/archive/",
            &body,
        )
    }

    fn search_page(&self, theme: &Theme) -> String {
        let mut body =
            String::from("<div class=\"ob-container\">\n<section class=\"ob-section\">\n");
        body.push_str(&self.heading(theme, 1, "Search", "ob-section-heading"));
        body.push_str(
            "\n<ob-search index=\"/search.json\" wasm=\"/assets/wasm/openblog_wasm.js\">\n<form class=\"ob-search-form\" role=\"search\" action=\"/search/\" method=\"get\"><label for=\"q\">Search posts</label><input id=\"q\" name=\"q\" type=\"search\" autocomplete=\"off\" placeholder=\"Rust, web components, …\"></form>\n<p class=\"ob-search-status\" role=\"status\" aria-live=\"polite\"></p>\n<ol class=\"ob-search-results\"></ol>\n</ob-search>\n<noscript><p>Search needs JavaScript. You can also browse the <a href=\"/archive/\">archive</a> or <a href=\"/tags/\">tags</a>.</p></noscript>\n",
        );
        body.push_str("</section>\n</div>");
        let mut meta = self.meta_simple(theme, "Search", "Search every post.", "/search/");
        meta.noindex = true;
        self.document(&meta, &body)
    }

    fn page(&self, page: &crate::model::Page) -> String {
        let theme = self.theme(self.site.theme_for_page(page));
        let mut body = String::from(
            "<div class=\"ob-container ob-container-reading\">\n<article class=\"ob-page\">\n",
        );
        body.push_str(&self.heading(theme, 1, &page.title, "ob-post-title"));
        body.push_str(&format!(
            "\n<ob-code{}><div class=\"ob-prose\">{}</div></ob-code>\n</article>\n</div>",
            self.code_attr(theme, None),
            page.html
        ));
        self.simple(theme, &page.title, &page.description, &page.url, &body)
    }

    fn service_index(&self, theme: &Theme, plan: &[crate::job_archive::JobArchive]) -> String {
        let mut body = String::from(
            "<div class=\"ob-container\">\n<section class=\"ob-section ob-services\">\n",
        );
        body.push_str(&self.heading(theme, 1, "Services", "ob-section-heading"));
        body.push_str("\n<ul class=\"ob-list ob-list-rows ob-service-list\">\n");
        for service in &self.site.services {
            body.push_str(&format!(
                "<li class=\"ob-service\">\n<h2 class=\"ob-row-title\"><a href=\"{}\">{}</a></h2>\n<p>{}</p>\n",
                attr(&service.url),
                text(&service.name),
                text(&service.summary)
            ));
            let facts = service_facts(service);
            if !facts.is_empty() {
                body.push_str(&format!("<p class=\"ob-meta\">{}</p>\n", facts.join(" · ")));
            }
            let recent = crate::service::recent_jobs(plan, &service.id, SERVICE_INDEX_JOBS);
            if !recent.is_empty() {
                body.push_str("<p class=\"ob-meta\">Recent jobs</p>\n<ul class=\"ob-archive\">\n");
                for index in recent {
                    let post = &self.site.posts[index];
                    body.push_str(&format!(
                        "<li><a href=\"{}\">{}</a> <span class=\"ob-meta\">{}</span></li>\n",
                        attr(&post.url),
                        text(&post.title),
                        self.time(post)
                    ));
                }
                body.push_str("</ul>\n");
            }
            body.push_str("</li>\n");
        }
        body.push_str("</ul>\n</section>\n</div>");
        self.simple(
            theme,
            "Services",
            "What we do, what each service includes, and what it usually takes.",
            crate::service::SERVICES_URL,
            &body,
        )
    }

    fn service_page(
        &self,
        service: &crate::model::Service,
        plan: &[crate::job_archive::JobArchive],
    ) -> String {
        let theme = self.theme(&self.site.config.theme);
        let mut body = String::from(
            "<div class=\"ob-container ob-container-reading\">\n<article class=\"ob-page ob-service\">\n",
        );
        body.push_str(&format!(
            "<p class=\"ob-eyebrow\"><a href=\"{}\">Services</a></p>\n",
            crate::service::SERVICES_URL
        ));
        body.push_str(&self.heading(theme, 1, &service.name, "ob-post-title"));
        body.push_str(&format!(
            "\n<p class=\"ob-lede\">{}</p>\n",
            text(&service.summary)
        ));
        let facts = service_facts(service);
        if !facts.is_empty() {
            body.push_str(&format!("<p class=\"ob-meta\">{}</p>\n", facts.join(" · ")));
            if service.price_band.is_some() {
                body.push_str(
                    "<p class=\"ob-meta\">A price band is a guide, not a quote. Ask us about your job.</p>\n",
                );
            }
        }
        if !service.includes.is_empty() {
            body.push_str("<h2>What is included</h2>\n<ul class=\"ob-service-includes\">\n");
            for item in &service.includes {
                body.push_str(&format!("<li>{}</li>\n", text(item)));
            }
            body.push_str("</ul>\n");
        }
        if !service.html.trim().is_empty() {
            body.push_str(&format!(
                "<ob-code{}><div class=\"ob-prose\">{}</div></ob-code>\n",
                self.code_attr(theme, None),
                service.html
            ));
        }
        if !service.faq.is_empty() {
            body.push_str("<section class=\"ob-faq\" aria-labelledby=\"ob-faq-title\">\n<h2 id=\"ob-faq-title\">Frequently asked questions</h2>\n");
            for entry in &service.faq {
                body.push_str(&format!(
                    "<h3>{}</h3>\n<p>{}</p>\n",
                    text(&entry.question),
                    text(&entry.answer)
                ));
            }
            body.push_str("</section>\n");
        }
        let recent = crate::service::recent_jobs(plan, &service.id, SERVICE_PAGE_JOBS);
        if !recent.is_empty() {
            body.push_str("<section class=\"ob-service-jobs\" aria-labelledby=\"ob-service-jobs-title\">\n<h2 id=\"ob-service-jobs-title\">Recent jobs</h2>\n");
            body.push_str(&self.post_list(theme, &recent));
            body.push_str("\n<ul class=\"ob-archive\">\n");
            for archive in crate::service::job_archives(plan, &service.id) {
                body.push_str(&format!(
                    "<li><a href=\"{}\">All {}</a> <span class=\"ob-meta\">{}</span></li>\n",
                    attr(&archive.url),
                    text(&archive.title),
                    plural_text(archive.posts.len(), "job", "jobs")
                ));
            }
            body.push_str("</ul>\n</section>\n");
        }
        body.push_str("</article>\n</div>");
        let mut meta = self.meta_simple(theme, &service.name, &service.summary, &service.url);
        meta.json_ld = Some(crate::service::json_ld(self.site, service));
        self.document(&meta, &body)
    }

    fn area_index(&self, theme: &Theme, plan: &[crate::job_archive::JobArchive]) -> String {
        let mut body =
            String::from("<div class=\"ob-container\">\n<section class=\"ob-section ob-areas\">\n");
        body.push_str(&self.heading(theme, 1, "Areas we serve", "ob-section-heading"));
        body.push_str("\n<ul class=\"ob-list ob-list-rows ob-area-list\">\n");
        for planned in self.site.config.service_areas.plan() {
            let jobs = crate::service_area::recent_jobs(plan, self.site, planned.area, usize::MAX);
            body.push_str(&format!(
                "<li class=\"ob-area\">\n<h2 class=\"ob-row-title\"><a href=\"{}\">{}</a></h2>\n",
                attr(&planned.url),
                text(&planned.area.label())
            ));
            if !planned.area.note.is_empty() {
                body.push_str(&format!("<p>{}</p>\n", text(&planned.area.note)));
            }
            body.push_str(&format!(
                "<p class=\"ob-meta\">{}</p>\n</li>\n",
                if jobs.is_empty() {
                    "Work here is not yet posted".to_string()
                } else {
                    plural_text(jobs.len(), "job posted", "jobs posted")
                }
            ));
        }
        body.push_str("</ul>\n</section>\n</div>");
        self.simple(
            theme,
            "Areas we serve",
            "The towns we work in, with the services we offer and recent jobs there.",
            crate::service_area::AREAS_URL,
            &body,
        )
    }

    fn area_page(
        &self,
        planned: &crate::service_area::PlannedArea<'_>,
        plan: &[crate::job_archive::JobArchive],
    ) -> String {
        let theme = self.theme(&self.site.config.theme);
        let area = planned.area;
        let label = area.label();
        let mut body = String::from(
            "<div class=\"ob-container ob-container-reading\">\n<article class=\"ob-page ob-area-page\">\n",
        );
        body.push_str(&format!(
            "<p class=\"ob-eyebrow\"><a href=\"{}\">Areas we serve</a></p>\n",
            crate::service_area::AREAS_URL
        ));
        body.push_str(&self.heading(theme, 1, &label, "ob-post-title"));
        body.push_str(&format!(
            "\n<p class=\"ob-lede\">Serving {}.</p>\n",
            text(&label)
        ));
        if !area.note.is_empty() {
            body.push_str(&format!("<p class=\"ob-meta\">{}</p>\n", text(&area.note)));
        }
        if !self.site.services.is_empty() {
            body.push_str("<section class=\"ob-area-services\" aria-labelledby=\"ob-area-services-title\">\n<h2 id=\"ob-area-services-title\">Services we offer</h2>\n<ul class=\"ob-list ob-list-rows\">\n");
            for service in &self.site.services {
                body.push_str(&format!(
                    "<li><a href=\"{}\">{}</a> <span class=\"ob-meta\">{}</span></li>\n",
                    attr(&service.url),
                    text(&service.name),
                    text(&service.summary)
                ));
            }
            body.push_str("</ul>\n</section>\n");
        }
        let recent = crate::service_area::recent_jobs(plan, self.site, area, AREA_PAGE_JOBS);
        body.push_str(&format!(
            "<section class=\"ob-area-jobs\" aria-labelledby=\"ob-area-jobs-title\">\n<h2 id=\"ob-area-jobs-title\">Recent jobs in {}</h2>\n",
            text(&label)
        ));
        if recent.is_empty() {
            body.push_str(&format!(
                "<p class=\"ob-empty\">Work in {} is not yet posted. A finished job there will appear on this page.</p>\n",
                text(&label)
            ));
        } else {
            // Title and date only: a card's summary is text from the job's body.
            body.push_str("<ul class=\"ob-archive\">\n");
            for index in recent {
                let post = &self.site.posts[index];
                body.push_str(&format!(
                    "<li><a href=\"{}\">{}</a> <span class=\"ob-meta\">{}</span></li>\n",
                    attr(&post.url),
                    text(&post.title),
                    self.time(post)
                ));
            }
            body.push_str("</ul>\n");
        }
        body.push_str("</section>\n");
        let business = self.site.config.business.block_html();
        if !business.is_empty() {
            body.push_str(&format!(
                "<section class=\"ob-area-business\" aria-label=\"Business details\">\n{business}</section>\n"
            ));
        }
        body.push_str("</article>\n</div>");
        let description = format!("Services we offer in {label}, and recent jobs there.");
        let mut meta = self.meta_simple(
            theme,
            &format!("Serving {label}"),
            &description,
            &planned.url,
        );
        meta.json_ld = Some(crate::service_area::json_ld(self.site, area));
        self.document(&meta, &body)
    }

    fn not_found(&self, theme: &Theme) -> String {
        let body = format!(
            "<div class=\"ob-container ob-container-reading\"><section class=\"ob-section\">{}<p class=\"ob-lede\">That page does not exist. Try the <a href=\"/\">latest posts</a>, the <a href=\"/archive/\">archive</a>, or <a href=\"/search/\">search</a>.</p></section></div>",
            self.heading(theme, 1, "Page not found", "ob-section-heading")
        );
        let mut meta = self.meta_simple(theme, "Page not found", "", "/404.html");
        meta.noindex = true;
        self.document(&meta, &body)
    }

    fn atlas_index(&self, theme: &Theme, atlas: &PublicAtlas) -> String {
        let mut body =
            String::from("<div class=\"ob-container\">\n<section class=\"ob-section ob-atlas\">\n");
        body.push_str(&self.heading(theme, 1, "Knowledge Atlas", "ob-section-heading"));
        body.push_str(&format!(
            "\n<p class=\"ob-lede\">{}</p>\n",
            text(ATLAS_LEDE)
        ));
        if atlas.entries.is_empty() {
            body.push_str("<p class=\"ob-empty\">No entries have been published yet.</p>\n");
        }
        let timeline = !atlas.datings.is_empty();
        if timeline {
            body.push_str(&format!(
                "<p class=\"ob-meta\">The <a href=\"#atlas-timeline\">timeline</a> lists {} in time order.</p>\n",
                plural_text(atlas.datings.len(), "published dating", "published datings")
            ));
        }
        for kind in EntryKind::ALL {
            let entries: Vec<&PublicEntry> =
                atlas.entries.iter().filter(|e| e.kind == kind).collect();
            if entries.is_empty() {
                continue;
            }
            let id = format!("atlas-{}", kind.as_str());
            body.push_str(&format!(
                "<section aria-labelledby=\"{id}\">\n<h2 id=\"{id}\">{}</h2>\n<ul class=\"ob-archive\">\n",
                atlas_publication::kind_heading(kind)
            ));
            for entry in entries {
                let (outgoing, incoming) = atlas.relationships_of(&entry.id);
                let count = outgoing.len() + incoming.len();
                body.push_str(&format!(
                    "<li><a href=\"{}\">{}</a> <span class=\"ob-meta\">{count} relationship{}</span></li>\n",
                    attr(&entry.url),
                    text(&entry.label),
                    if count == 1 { "" } else { "s" }
                ));
            }
            body.push_str("</ul>\n</section>\n");
        }
        if timeline {
            body.push_str(&self.atlas_timeline(atlas));
        }
        body.push_str(&format!(
            "<p class=\"ob-meta\">The same atlas as data: <a href=\"/{file}\" type=\"application/json\">{file}</a>.</p>\n</section>\n</div>",
            file = atlas_publication::ATLAS_JSON_FILE
        ));
        let mut meta = self.meta_simple(
            theme,
            "Knowledge Atlas",
            "People, works, concepts, movements and events, with attributed, sourced relationships.",
            atlas_publication::ATLAS_URL,
        );
        meta.atlas_timeline = timeline;
        self.document(&meta, &body)
    }

    /// The public timeline (ADR 0100): every published dating, in the
    /// chronology's one order, as an ordered list of periods holding dated
    /// aspects, each with all its competing datings side by side and their
    /// attribution, evidence and notes. It reads completely without
    /// JavaScript; `<ob-atlas-timeline>` only adds filters and a way to jump
    /// to a period. Aspects that cannot be placed in time are listed apart,
    /// and relative datings are listed again as steps of a trail.
    fn atlas_timeline(&self, atlas: &PublicAtlas) -> String {
        let groups = atlas.dated_aspects();
        let mut out = String::from(
            "<ob-atlas-timeline>\n<section class=\"ob-atlas-timeline\" aria-labelledby=\"atlas-timeline\">\n<h2 id=\"atlas-timeline\">Timeline</h2>\n",
        );
        out.push_str(&format!(
            "<p class=\"ob-meta\">{}</p>\n",
            text(ATLAS_TIMELINE_NOTE)
        ));
        let placed: Vec<&DatedAspect> = groups.iter().filter(|g| g.placed).collect();
        if !placed.is_empty() {
            out.push_str("<ol class=\"ob-atlas-periods\">\n");
            let mut open: Option<String> = None;
            for group in placed {
                let id = atlas_publication::period_id(group.start_year);
                if open.as_deref() != Some(id.as_str()) {
                    if open.is_some() {
                        out.push_str("</ol>\n</li>\n");
                    }
                    out.push_str(&format!(
                        "<li class=\"ob-atlas-period\">\n<h3 id=\"{}\" tabindex=\"-1\">{}</h3>\n<ol class=\"ob-atlas-aspects\">\n",
                        attr(&id),
                        text(&atlas_publication::period_label(group.start_year))
                    ));
                    open = Some(id);
                }
                out.push_str(&self.atlas_timeline_row(atlas, group));
            }
            out.push_str("</ol>\n</li>\n</ol>\n");
        }
        let unplaced: Vec<&DatedAspect> = groups.iter().filter(|g| !g.placed).collect();
        if !unplaced.is_empty() {
            out.push_str("<section class=\"ob-atlas-unplaced\" aria-labelledby=\"atlas-timeline-unplaced\">\n<h3 id=\"atlas-timeline-unplaced\" tabindex=\"-1\">Not placed in time</h3>\n<p class=\"ob-meta\">Aspects dated only relative to another entry, or that the dating party says are of unknown date.</p>\n<ul class=\"ob-atlas-aspects\">\n");
            for group in unplaced {
                out.push_str(&self.atlas_timeline_row(atlas, group));
            }
            out.push_str("</ul>\n</section>\n");
        }
        let relative: Vec<&PublicDating> = atlas
            .datings
            .iter()
            .filter(|d| d.date.relative.is_some())
            .collect();
        if !relative.is_empty() {
            out.push_str("<section class=\"ob-atlas-trails\" aria-labelledby=\"atlas-timeline-relative\">\n<h3 id=\"atlas-timeline-relative\" tabindex=\"-1\">Relative chronology</h3>\n<p class=\"ob-meta\">Each line is one party's recorded order between two entries, to be followed one step at a time. Nothing here is worked out from dates, and none of these is a relationship between the entries.</p>\n<ul class=\"ob-atlas-trail\">\n");
            let author = &self.site.config.author.name;
            for dating in relative {
                out.push_str(&format!(
                    "<li data-aspect=\"{}\">{} {}. <span class=\"ob-meta\">Dated by {}; {}. <a href=\"#atlas-d-{}\">Evidence and notes</a></span></li>\n",
                    dating.aspect.as_str(),
                    self.atlas_aspect_of(atlas, dating, None),
                    self.atlas_date_html(atlas, dating, None),
                    text(&atlas.party_text(&dating.asserted_by, author)),
                    atlas_publication::confidence_text(dating.confidence).to_lowercase(),
                    attr(&dating.id)
                ));
            }
            out.push_str("</ul>\n</section>\n");
        }
        out.push_str("</section>\n</ob-atlas-timeline>\n");
        out
    }

    /// One dated aspect on the timeline: what is dated, then every one of
    /// its datings together.
    fn atlas_timeline_row(&self, atlas: &PublicAtlas, group: &DatedAspect) -> String {
        let count = group.datings.len();
        let mut out = format!(
            "<li class=\"ob-atlas-aspect\" data-aspect=\"{}\" data-datings=\"{count}\">\n<p class=\"ob-atlas-aspect-name\">{}</p>\n<p class=\"ob-meta\">{}</p>\n<ul class=\"ob-atlas-datings\">\n",
            group.aspect.as_str(),
            self.atlas_aspect_of(atlas, group.datings[0], None),
            competing_text(count)
        );
        for dating in &group.datings {
            out.push_str(&self.atlas_dating(atlas, dating, None, true, None));
        }
        out.push_str("</ul>\n</li>\n");
        out
    }

    /// "Birth of <a>Plato</a>": the dated aspect of an item, linked to where
    /// its datings are shown in full, or in bold on that item's own page.
    fn atlas_aspect_of(
        &self,
        atlas: &PublicAtlas,
        dating: &PublicDating,
        here: Option<&str>,
    ) -> String {
        let name = text(&atlas.owner_text(&dating.owner, dating.owner_type));
        let owner = if here == Some(dating.owner.as_str()) {
            format!("<strong>{name}</strong>")
        } else {
            let href = match dating.owner_type {
                OwnerType::Entry => format!(
                    "{}#atlas-dates-{}",
                    atlas_publication::entry_url(&dating.owner),
                    dating.aspect.as_str()
                ),
                OwnerType::Relationship => atlas.owner_url(&dating.owner, dating.owner_type),
            };
            format!("<a href=\"{}\">{name}</a>", attr(&href))
        };
        format!(
            "{} of {owner}",
            capitalized(atlas_publication::aspect_noun(dating.aspect))
        )
    }

    /// A dating's date as stated. A relative dating names the other entry
    /// and links to its datings: one step of a trail, as someone asserted it.
    fn atlas_date_html(
        &self,
        atlas: &PublicAtlas,
        dating: &PublicDating,
        here: Option<&str>,
    ) -> String {
        let Some(relative) = &dating.date.relative else {
            return if dating.placement == Placement::Unknown {
                "unknown, as the dating party states".to_string()
            } else {
                text(&dating.text)
            };
        };
        let label = atlas
            .entry(&relative.entry)
            .map_or(relative.entry.as_str(), |entry| entry.label.as_str());
        let target = if here == Some(relative.entry.as_str()) {
            format!("<strong>{}</strong>", text(label))
        } else {
            let has_aspect = atlas
                .datings
                .iter()
                .any(|d| d.owner == relative.entry && d.aspect == relative.aspect);
            let anchor = if has_aspect {
                format!("atlas-dates-{}", relative.aspect.as_str())
            } else {
                "atlas-section-dates".to_string()
            };
            format!(
                "<a href=\"{}#{anchor}\">{}</a>",
                attr(&atlas_publication::entry_url(&relative.entry)),
                text(label)
            )
        };
        format!(
            "{} the {} of {target}",
            relative.order.as_str(),
            atlas_publication::aspect_noun(relative.aspect)
        )
    }

    /// One dating with who dates it, how firmly, on what evidence and with
    /// what note. `anchored` gives it its fragment id (once per page);
    /// `lead` replaces the plain date line with a sentence that names what
    /// is dated.
    fn atlas_dating(
        &self,
        atlas: &PublicAtlas,
        dating: &PublicDating,
        here: Option<&str>,
        anchored: bool,
        lead: Option<String>,
    ) -> String {
        let author = &self.site.config.author.name;
        let id = if anchored {
            format!(" id=\"atlas-d-{}\"", attr(&dating.id))
        } else {
            String::new()
        };
        let placement = match dating.placement {
            Placement::Dated => "dated",
            Placement::Relative => "relative",
            Placement::Unknown => "unknown",
        };
        let date = self.atlas_date_html(atlas, dating, here);
        let line = match lead {
            Some(lead) => format!("{lead}: {date}"),
            None => date,
        };
        let mut out = format!(
            "<li{id} class=\"ob-atlas-dating\" data-placement=\"{placement}\">\n<p class=\"ob-atlas-date\">{line}</p>\n<dl>\n"
        );
        out.push_str(&format!(
            "<dt>Dated by</dt><dd>{}</dd>\n",
            text(&atlas.party_text(&dating.asserted_by, author))
        ));
        out.push_str(&format!(
            "<dt>Confidence</dt><dd>{}: how firmly the dating party holds it, not how widely it is accepted.</dd>\n",
            atlas_publication::confidence_text(dating.confidence)
        ));
        out.push_str("<dt>Evidence</dt><dd><ul>");
        for item in &dating.evidence {
            out.push_str(&format!(
                "<li><cite>{}</cite></li>",
                text(&atlas.evidence_text(item))
            ));
        }
        out.push_str("</ul></dd>\n");
        if let Some(note) = &dating.note {
            out.push_str(&format!("<dt>Note</dt><dd>{}</dd>\n", text(note)));
        }
        out.push_str("</dl>\n</li>\n");
        out
    }

    /// An entry's own datings, by aspect with competing datings side by
    /// side, then the relative datings of other items that point at it.
    /// Empty when it has neither, so its page is written as before.
    fn atlas_entry_dates(&self, atlas: &PublicAtlas, entry: &PublicEntry) -> String {
        let groups = atlas.dated_aspects_of(&entry.id);
        let pointing = atlas.relative_to(&entry.id);
        if groups.is_empty() && pointing.is_empty() {
            return String::new();
        }
        let mut out = String::from(
            "<section aria-labelledby=\"atlas-section-dates\">\n<h2 id=\"atlas-section-dates\">Dates</h2>\n",
        );
        out.push_str(&format!(
            "<p class=\"ob-meta\">{} All published datings are also on the <a href=\"{}#atlas-timeline\">timeline</a>.</p>\n",
            text(ATLAS_DATES_NOTE),
            atlas_publication::ATLAS_URL
        ));
        for group in &groups {
            out.push_str(&format!(
                "<h3 id=\"atlas-dates-{}\">{}</h3>\n<p class=\"ob-meta\">{}</p>\n<ul class=\"ob-atlas-datings\">\n",
                group.aspect.as_str(),
                atlas_publication::aspect_heading(group.aspect),
                competing_text(group.datings.len())
            ));
            for dating in &group.datings {
                out.push_str(&self.atlas_dating(atlas, dating, Some(&entry.id), true, None));
            }
            out.push_str("</ul>\n");
        }
        if !pointing.is_empty() {
            out.push_str("<h3 id=\"atlas-dates-relative-to\">Dated relative to this entry</h3>\n<p class=\"ob-meta\">Other items that someone dated before, after or during this entry. Each is that party's recorded order, not one worked out from dates; follow a link to continue the trail.</p>\n<ul class=\"ob-atlas-datings\">\n");
            for dating in pointing {
                // The step back: the dating in full on the page that owns it.
                let href = match dating.owner_type {
                    OwnerType::Entry => atlas_publication::entry_url(&dating.owner),
                    OwnerType::Relationship => match atlas.relationship(&dating.owner) {
                        Some(r) => atlas_publication::entry_url(&r.from),
                        None => atlas_publication::ATLAS_URL.to_string(),
                    },
                };
                let lead = format!(
                    "{} of <a href=\"{}#atlas-d-{}\">{}</a>",
                    capitalized(atlas_publication::aspect_noun(dating.aspect)),
                    attr(&href),
                    attr(&dating.id),
                    text(&atlas.owner_text(&dating.owner, dating.owner_type))
                );
                out.push_str(&self.atlas_dating(atlas, dating, Some(&entry.id), false, Some(lead)));
            }
            out.push_str("</ul>\n");
        }
        out.push_str("</section>\n");
        out
    }

    fn atlas_entry(&self, theme: &Theme, atlas: &PublicAtlas, entry: &PublicEntry) -> String {
        let mut body = String::from(
            "<div class=\"ob-container ob-container-reading\">\n<article class=\"ob-page ob-atlas-entry\">\n",
        );
        body.push_str(&format!(
            "<p class=\"ob-eyebrow\"><a href=\"{}\">Knowledge Atlas</a> · {}</p>\n",
            atlas_publication::ATLAS_URL,
            atlas_publication::kind_label(entry.kind)
        ));
        body.push_str(&self.heading(theme, 1, &entry.label, "ob-post-title"));
        body.push('\n');
        if !entry.aliases.is_empty() {
            let aliases: Vec<String> = entry.aliases.iter().map(|alias| text(alias)).collect();
            body.push_str(&format!(
                "<p class=\"ob-meta\">Also known as {}</p>\n",
                aliases.join(", ")
            ));
        }
        body.push_str("<div class=\"ob-prose\">\n");
        if let Some(summary) = &entry.summary {
            for paragraph in summary
                .split("\n\n")
                .map(str::trim)
                .filter(|p| !p.is_empty())
            {
                body.push_str(&format!(
                    "<p>{}</p>\n",
                    text(paragraph).replace('\n', "<br>")
                ));
            }
        }
        if let Some(source) = entry.source.as_deref().and_then(|id| atlas.source(id)) {
            body.push_str(&format!(
                "<p>As recorded in the author's sources: <cite>{}</cite></p>\n",
                text(&source.text)
            ));
        }
        body.push_str(&self.atlas_entry_dates(atlas, entry));
        let (outgoing, incoming) = atlas.relationships_of(&entry.id);
        for (id, title, list) in [
            // Section ids and relationship ids (`atlas-r-<id>`) live in
            // separate namespaces, so a relationship named `from` or `to`
            // cannot collide with a section.
            (
                "atlas-section-from",
                "Relationships from this entry",
                outgoing,
            ),
            ("atlas-section-to", "Relationships to this entry", incoming),
        ] {
            body.push_str(&format!(
                "<section aria-labelledby=\"{id}\">\n<h2 id=\"{id}\">{title}</h2>\n"
            ));
            if list.is_empty() {
                body.push_str("<p class=\"ob-empty\">None published.</p>\n");
            } else {
                body.push_str("<ul class=\"ob-atlas-relationships\">\n");
                for relationship in list {
                    body.push_str(&self.atlas_relationship(atlas, entry, relationship));
                }
                body.push_str("</ul>\n");
            }
            body.push_str("</section>\n");
        }
        let trail = self.atlas_trail(entry);
        if let Some(trail) = &trail {
            body.push_str(trail);
        }
        body.push_str(&self.in_paths_section("atlas", &entry.id));
        body.push_str(&format!(
            "<p class=\"ob-meta\">{}</p>\n</div>\n</article>\n</div>",
            text(ATLAS_NOTE)
        ));
        let mut meta = self.meta_simple(
            theme,
            &entry.label,
            &format!(
                "{} in the Knowledge Atlas, with its attributed, sourced relationships.",
                atlas_publication::kind_label(entry.kind)
            ),
            &entry.url,
        );
        meta.atlas_trail = trail.is_some();
        self.document(&meta, &body)
    }

    /// The relationship trail from an entry (ADR 0175): the bounded walk of
    /// [`crate::atlas_query::AtlasQuery::trail`] over published relationships,
    /// as an ordered list of steps grouped by how far they are from the entry.
    /// It is complete without JavaScript; `<ob-atlas-trail>` only adds
    /// filters. Each step is one published relationship in the direction it
    /// was stated, with its type, who asserts it, how firmly, its standing,
    /// its evidence and its stated uncertainty, and says which way the walk
    /// crossed it. A step that arrives at an entry already on the trail says
    /// so and is not followed again, so a cycle is a sentence and never a trap.
    /// `None` when the entry has no published relationship or the query
    /// projection is not written.
    fn atlas_trail(&self, entry: &PublicEntry) -> Option<String> {
        self.atlas_trail_to(entry, self.atlas_trail_depth().depth)
    }

    /// How far every trail of the site goes: full depth, unless the trails of
    /// all entries together would take more than [`TRAIL_BUDGET_BYTES`], in
    /// which case one step, site-wide, so no entry's page differs in kind.
    fn atlas_trail_depth(&self) -> TrailDepth {
        use crate::atlas_query::MAX_TRAIL_DEPTH;
        *self.trail_depth.get_or_init(|| {
            let full = TrailDepth {
                depth: MAX_TRAIL_DEPTH,
                over_budget: None,
            };
            let Some(atlas) = self.site.atlas.as_ref() else {
                return full;
            };
            let mut total = 0usize;
            for entry in &atlas.entries {
                total += self
                    .atlas_trail_to(entry, MAX_TRAIL_DEPTH)
                    .map_or(0, |trail| trail.len());
                if total > self.trail_budget {
                    return TrailDepth {
                        depth: 1,
                        over_budget: Some(total),
                    };
                }
            }
            full
        })
    }

    /// [`Self::atlas_trail`] for a trail that goes `max_depth` steps out.
    fn atlas_trail_to(&self, entry: &PublicEntry, max_depth: usize) -> Option<String> {
        use crate::atlas_query::{Direction, MAX_TRAIL_STEPS};
        let query = &self.atlas_query_projection()?.query;
        let trail = query.trail(&entry.id, max_depth);
        if trail.steps.is_empty() {
            return None;
        }
        let name = |id: &str| query.entry(id).map_or_else(|| text(id), |e| text(&e.label));
        let link = |id: &str| match query.entry(id) {
            Some(e) => format!("<a href=\"{}\">{}</a>", attr(&e.url), text(&e.label)),
            None => text(id),
        };
        let mut reached: BTreeSet<&str> = BTreeSet::new();
        reached.insert(entry.id.as_str());
        let mut entries_on_trail: BTreeSet<&str> = reached.clone();
        for step in &trail.steps {
            entries_on_trail.insert(step.reached);
        }
        let mut out = format!(
            "<ob-atlas-trail>\n<section class=\"ob-atlas-trail-section\" aria-labelledby=\"atlas-section-trail\">\n<h2 id=\"atlas-section-trail\">Relationship trail</h2>\n<p class=\"ob-meta\">{}</p>\n<p class=\"ob-meta\">This trail has {} across {} (including this one), up to {} relationships away. <a href=\"#atlas-trail-end\">Skip the trail</a>.</p>\n",
            text(ATLAS_TRAIL_NOTE),
            plural_text(trail.steps.len(), "relationship", "relationships"),
            plural_text(entries_on_trail.len(), "entry", "entries"),
            max_depth
        );
        let mut open: Option<usize> = None;
        for step in &trail.steps {
            let edge = step.edge;
            if open != Some(step.depth) {
                if open.is_some() {
                    out.push_str("</ol>\n</li>\n");
                } else {
                    out.push_str("<ol class=\"ob-trail-depths\">\n");
                }
                out.push_str(&format!(
                    "<li class=\"ob-trail-depth\" data-depth=\"{d}\">
<h3 id=\"atlas-trail-depth-{d}\">{} from {}</h3>
<p class=\"ob-meta\">{}</p>
<ol class=\"ob-trail-steps\">
",
                    steps_label(step.depth),
                    name(&entry.id),
                    if step.depth == 1 {
                        "Relationships that touch this entry."
                    } else {
                        "Relationships that touch an entry reached in the step before."
                    },
                    d = step.depth
                ));
                open = Some(step.depth);
            }
            let again = reached.contains(step.reached);
            reached.insert(step.reached);
            let (from, to) = (name(&edge.from), name(&edge.to));
            // The sentence is escaped once, as a whole, from the raw labels.
            let raw = |id: &str| {
                query
                    .entry(id)
                    .map_or_else(|| id.to_string(), |e| e.label.clone())
            };
            let (from_raw, to_raw) = (raw(&edge.from), raw(&edge.to));
            let symmetric = edge.kind.is_symmetric();
            let direction = match (step.direction, symmetric) {
                (_, true) => format!(
                    "Stated between {from_raw} and {to_raw}; this kind of relationship reads the same in both directions."
                ),
                (Direction::Forward, false) => format!(
                    "Stated from {from_raw} to {to_raw}. This step follows it forward, in the direction it was stated, from {from_raw} to {to_raw}."
                ),
                (Direction::Backward, false) => format!(
                    "Stated from {from_raw} to {to_raw}. This step follows it backward, against the direction it was stated, from {to_raw} to {from_raw}."
                ),
            };
            let compact_direction = match (step.direction, symmetric) {
                (_, true) => "Reads the same in both directions.",
                (Direction::Forward, false) => "Followed in the direction it was stated.",
                (Direction::Backward, false) => "Followed against the direction it was stated.",
            };
            let standing = match edge.standing {
                Standing::Asserted => "asserted",
                Standing::Contested => "contested",
            };
            let uncertainty_note = match &edge.uncertainty {
                Some(note) => format!(
                    "{}{} <a href=\"{}\">Read it in full</a>.",
                    text(note),
                    if edge.uncertainty_clipped {
                        " \u{2026}"
                    } else {
                        ""
                    },
                    attr(&edge.url)
                ),
                None => "None stated. That is not a claim that it is certain.".to_string(),
            };
            let evidence: String = edge
                .evidence
                .iter()
                .map(|item| format!("<li><cite>{}</cite></li>", text(&item.text)))
                .collect();
            out.push_str(&format!(
                "<li id=\"atlas-trail-{id}\" class=\"ob-trail-step\" data-depth=\"{depth}\" data-kind=\"{kind}\" data-kind-label=\"{kind_label}\" data-direction=\"{dir}\" data-standing=\"{standing}\" data-uncertain=\"{uncertain}\" data-again=\"{again}\">\n",
                id = attr(&edge.id),
                depth = step.depth,
                kind = edge.kind.as_str(),
                kind_label = attr(edge.label),
                dir = match (step.direction, symmetric) {
                    (_, true) => "symmetric",
                    (Direction::Forward, false) => "forward",
                    (Direction::Backward, false) => "backward",
                },
                uncertain = edge.uncertainty.is_some(),
            ));
            // Facts are written in full on the first step only; a step further
            // out is its sentence, which way it was followed and a link, so a
            // hub's trail stays small. Its data attributes still feed the
            // filters, and the relationship's own page has everything.
            let full = step.depth == 1;
            out.push_str(&format!(
                "<p class=\"ob-trail-statement\">{}{} {} {}.</p>\n{}",
                if edge.standing == Standing::Contested {
                    "<strong>Contested:</strong> "
                } else {
                    ""
                },
                if edge.from == entry.id {
                    format!("<strong>{from}</strong>")
                } else {
                    link(&edge.from)
                },
                text(edge.label),
                if edge.to == entry.id {
                    format!("<strong>{to}</strong>")
                } else {
                    link(&edge.to)
                },
                if full {
                    "<dl class=\"ob-trail-facts\">\n"
                } else {
                    ""
                },
            ));
            if full {
                out.push_str(&format!(
                    "<dt>Type</dt><dd>{}</dd>\n<dt>Direction</dt><dd>{}</dd>\n<dt>Asserted by</dt><dd>{}</dd>\n<dt>Confidence</dt><dd>{}: how firmly the asserting party holds it, not how widely it is accepted.</dd>\n<dt>Standing</dt><dd>{}</dd>\n<dt>Evidence</dt><dd><ul>{}</ul></dd>\n<dt>Uncertainty</dt><dd>{}</dd>\n</dl>\n",
                    text(edge.label),
                    text(&direction),
                    text(&edge.asserted_by_text),
                    edge.confidence_text,
                    text(&edge.standing_text),
                    evidence,
                    uncertainty_note,
                ));
            }
            let again_note = if again {
                " That entry is already on this trail, so the trail does not continue from it again."
            } else {
                ""
            };
            if full {
                out.push_str(&format!(
                    "<p class=\"ob-meta\">This step reaches {}.{} <a href=\"{}\">The relationship in full</a>.</p>\n</li>\n",
                    link(step.reached),
                    again_note,
                    attr(&edge.url),
                ));
            } else {
                out.push_str(&format!(
                    "<p class=\"ob-meta\">{}{} <a href=\"{}\">The relationship in full</a>.</p>\n</li>\n",
                    compact_direction, again_note,
                    attr(&edge.url),
                ));
            }
        }
        out.push_str("</ol>\n</li>\n</ol>\n");
        if trail.truncated {
            out.push_str(&format!(
                "<p class=\"ob-meta ob-trail-truncated\">The trail stops after {MAX_TRAIL_STEPS} relationships; more exist. Each entry's own page lists all of its relationships and continues the trail from there.</p>\n"
            ));
        } else {
            out.push_str("<p class=\"ob-meta\">To go further, follow an entry's link: its own page continues the trail from there.</p>\n");
        }
        out.push_str("<p id=\"atlas-trail-end\" class=\"ob-meta\" tabindex=\"-1\">End of the relationship trail.</p>\n</section>\n</ob-atlas-trail>\n");
        Some(out)
    }

    /// One relationship, always read in its stored direction, with who
    /// asserts it, its standing, confidence, evidence, doubt and dissent.
    fn atlas_relationship(
        &self,
        atlas: &PublicAtlas,
        here: &PublicEntry,
        r: &PublicRelationship,
    ) -> String {
        let author = &self.site.config.author.name;
        let end = |id: &str| match atlas.entry(id) {
            Some(entry) if entry.id == here.id => {
                format!("<strong>{}</strong>", text(&entry.label))
            }
            Some(entry) => format!(
                "<a href=\"{}\">{}</a>",
                attr(&entry.url),
                text(&entry.label)
            ),
            None => text(id),
        };
        let evidence_list = |items: &[PublicEvidence]| {
            let mut list = String::from("<ul>");
            for item in items {
                list.push_str(&format!(
                    "<li><cite>{}</cite></li>",
                    text(&atlas.evidence_text(item))
                ));
            }
            list.push_str("</ul>");
            list
        };
        let standing = match r.standing {
            Standing::Asserted => "asserted",
            Standing::Contested => "contested",
        };
        let standing_text = atlas_publication::standing_text(r.standing, r.contested_by.len());
        let mut out = format!(
            "<li id=\"atlas-r-{}\" class=\"ob-atlas-relationship\" data-standing=\"{standing}\">\n<p>{}{} {} {}.</p>\n<dl>\n",
            attr(&r.id),
            if r.contested_by.is_empty() {
                ""
            } else {
                "<strong>Contested:</strong> "
            },
            end(&r.from),
            text(r.label),
            end(&r.to)
        );
        out.push_str(&format!(
            "<dt>Standing</dt><dd>{}</dd>\n",
            text(&standing_text)
        ));
        out.push_str(&format!(
            "<dt>Asserted by</dt><dd>{}</dd>\n",
            text(&atlas.party_text(&r.asserted_by, author))
        ));
        out.push_str(&format!(
            "<dt>Confidence</dt><dd>{}: how firmly the asserting party holds it, not how widely it is accepted.</dd>\n",
            atlas_publication::confidence_text(r.confidence)
        ));
        out.push_str(&format!(
            "<dt>Evidence</dt><dd>{}</dd>\n",
            evidence_list(&r.evidence)
        ));
        if let Some(uncertainty) = &r.uncertainty {
            out.push_str(&format!(
                "<dt>Uncertain</dt><dd>{}</dd>\n",
                text(uncertainty)
            ));
        }
        // When it held: the relationship's own datings, never evidence for it.
        for group in atlas.dated_aspects_of(&r.id) {
            out.push_str(&format!(
                "<dt>When it held</dt><dd><p>{}</p><ul class=\"ob-atlas-datings\">\n",
                competing_text(group.datings.len())
            ));
            for dating in &group.datings {
                out.push_str(&self.atlas_dating(atlas, dating, Some(&here.id), true, None));
            }
            out.push_str("</ul></dd>\n");
        }
        if !r.contested_by.is_empty() {
            out.push_str("<dt>Disputed by</dt><dd><ul>");
            for dissent in &r.contested_by {
                out.push_str(&format!(
                    "<li>{}",
                    text(&atlas.party_text(&dissent.by, author))
                ));
                if let Some(note) = &dissent.note {
                    out.push_str(&format!(": {}", text(note)));
                }
                if !dissent.evidence.is_empty() {
                    out.push_str(&evidence_list(&dissent.evidence));
                }
                out.push_str("</li>");
            }
            out.push_str("</ul></dd>\n");
        }
        out.push_str("</dl>\n</li>\n");
        out
    }

    fn meta_simple<'t>(
        &self,
        theme: &'t Theme,
        title: &str,
        description: &str,
        path: &str,
    ) -> Meta<'t> {
        Meta {
            title: title.to_string(),
            description: if description.is_empty() {
                self.site.config.description.clone()
            } else {
                description.to_string()
            },
            path: path.to_string(),
            canonical: None,
            kind: "website",
            image: None,
            image_alt: None,
            json_ld: None,
            reader_references: None,
            citation_previews: None,
            concept_previews: None,
            passage_data: None,
            participation_scripts: Vec::new(),
            atlas_timeline: false,
            atlas_trail: false,
            reading_path: false,
            interpretation_levels: false,
            theme,
            published: None,
            modified: None,
            tags: Vec::new(),
            highwire: Vec::new(),
            noindex: false,
        }
    }

    fn comparison_index(&self, theme: &Theme, comparisons: &PublicComparisons) -> String {
        let mut body = String::from(
            "<div class=\"ob-container ob-container-reading\">\n<section class=\"ob-section ob-comparisons\">\n",
        );
        body.push_str(&self.heading(theme, 1, "Comparisons", "ob-section-heading"));
        body.push_str(&format!(
            "\n<p class=\"ob-lede\">{}</p>\n<p>{}</p>\n",
            text(COMPARISONS_LEDE),
            text(comparisons.notice)
        ));
        if comparisons.comparisons.is_empty() {
            body.push_str("<p class=\"ob-empty\">No comparisons have been published yet.</p>\n");
        } else {
            body.push_str("<ul class=\"ob-archive\">\n");
            for comparison in &comparisons.comparisons {
                let count = comparison.versions.len();
                body.push_str(&format!(
                    "<li><a href=\"{}\"><bdi>{}</bdi></a> <span class=\"ob-meta\">{count} version{} · {}</span></li>\n",
                    attr(&comparison.url),
                    text(&comparison_title(comparisons, comparison)),
                    if count == 1 { "" } else { "s" },
                    text(comparison.correspondence_label)
                ));
            }
            body.push_str("</ul>\n");
        }
        body.push_str(&format!(
            "<p class=\"ob-meta\">The same comparisons as data: <a href=\"/{file}\" type=\"application/json\">{file}</a>.</p>\n</section>\n</div>",
            file = comparison_publication::COMPARISONS_JSON_FILE
        ));
        self.simple(
            theme,
            "Comparisons",
            "Passages compared across editions, translations, manuscripts and interpretations, each version identified.",
            comparison_publication::COMPARISONS_URL,
            &body,
        )
    }

    fn comparison_page(
        &self,
        theme: &Theme,
        comparisons: &PublicComparisons,
        comparison: &PublicComparison,
    ) -> String {
        let title = comparison_title(comparisons, comparison);
        let mut body = String::from(
            "<div class=\"ob-container ob-container-reading\">\n<article class=\"ob-page ob-comparison\">\n",
        );
        body.push_str(&format!(
            "<p class=\"ob-eyebrow\"><a href=\"{}\">Comparisons</a></p>\n",
            comparison_publication::COMPARISONS_URL
        ));
        body.push_str(&self.heading(theme, 1, &title, "ob-post-title"));
        body.push_str("\n<div class=\"ob-prose\">\n");
        body.push_str(&format!(
            "<p class=\"ob-comparison-correspondence\"><strong>{}.</strong> {}</p>\n<dl class=\"ob-comparison-facts\">\n",
            text(comparison.correspondence_label),
            text(comparisons.notice)
        ));
        body.push_str(&format!(
            "<dt>Aligned by</dt><dd>{}</dd>\n",
            text(&comparisons.party_text(&comparison.recorded_by, &self.site.config.author.name))
        ));
        body.push_str(&format!(
            "<dt>Confidence</dt><dd>{}: how firmly the aligner holds this reading, not how widely it is accepted.</dd>\n",
            atlas_publication::confidence_text(comparison.confidence)
        ));
        if let Some(rationale) = &comparison.rationale {
            body.push_str(&format!(
                "<dt>Why these places are aligned</dt><dd>{}</dd>\n",
                text(rationale).replace('\n', "<br>")
            ));
        }
        if !comparison.evidence.is_empty() {
            body.push_str("<dt>Evidence</dt><dd><ul>");
            for item in &comparison.evidence {
                body.push_str(&format!(
                    "<li><cite>{}</cite></li>",
                    text(&comparisons.evidence_text(item))
                ));
            }
            body.push_str("</ul></dd>\n");
        }
        if let Some(uncertainty) = &comparison.uncertainty {
            body.push_str(&format!(
                "<dt>Uncertain</dt><dd>{}</dd>\n",
                text(uncertainty).replace('\n', "<br>")
            ));
        }
        body.push_str("</dl>\n");
        for (position, version) in comparison.versions.iter().enumerate() {
            body.push_str(&comparison_version(comparisons, version, position + 1));
        }
        body.push_str(&format!(
            "<p class=\"ob-meta\">{}</p>\n</div>\n</article>\n</div>",
            text(COMPARISONS_NOTE)
        ));
        self.simple(
            theme,
            &title,
            &format!(
                "{} compared across {} versions, each identified, with wording only where the author states its rights allow.",
                title,
                comparison.versions.len()
            ),
            &comparison.url,
            &body,
        )
    }

    /// "Part of a reading path": a link from a post or an atlas entry to each
    /// listed path that has it as a step (ADR 0216). Empty unless the site
    /// publishes paths and one lists this target. It is a link and a position
    /// only: it claims nothing about the item and moves nothing.
    fn in_paths_section(&self, kind: &str, target: &str) -> String {
        let Some(paths) = &self.site.reading_paths else {
            return String::new();
        };
        let found = paths.memberships(kind, target);
        if found.is_empty() {
            return String::new();
        }
        let mut html = String::from(
            "<section class=\"ob-in-paths\" aria-labelledby=\"in-reading-paths\">
<h2 id=\"in-reading-paths\" class=\"ob-related-title\">Part of a reading path</h2>
<ul>
",
        );
        for found in found {
            html.push_str(&format!(
                "<li><a href=\"{}#step-{}\"><bdi>{}</bdi></a> <span class=\"ob-meta\">step {} of {}</span></li>
",
                attr(&found.path.url),
                found.position,
                text(&found.path.title),
                found.position,
                found.total
            ));
        }
        html.push_str(
            "</ul>
</section>
",
        );
        html
    }

    fn paths_index(&self, theme: &Theme, paths: &crate::reading_path::PublicPaths) -> String {
        let mut body = String::from(
            "<div class=\"ob-container ob-container-reading\">\n<section class=\"ob-section ob-reading-paths\">\n",
        );
        body.push_str(&self.heading(theme, 1, "Reading paths", "ob-section-heading"));
        body.push_str(&format!(
            "\n<p class=\"ob-lede\">{}</p>\n",
            text(PATHS_LEDE)
        ));
        body.push_str("<ul class=\"ob-archive\">\n");
        for path in paths.paths.iter().filter(|path| path.listed) {
            let count = path.steps.len();
            body.push_str(&format!(
                "<li><a href=\"{}\"><bdi>{}</bdi></a> <span class=\"ob-meta\">{count} step{}</span>",
                attr(&path.url),
                text(&path.title),
                if count == 1 { "" } else { "s" }
            ));
            if let Some(summary) = &path.summary {
                body.push_str(&format!("<br>{}", text(summary)));
            }
            body.push_str("</li>\n");
        }
        body.push_str("</ul>\n</section>\n</div>");
        self.simple(
            theme,
            "Reading paths",
            "Routes through the author's work, in an order they chose, with their reasons.",
            crate::reading_path::PATHS_URL,
            &body,
        )
    }

    fn path_page(
        &self,
        theme: &Theme,
        paths: &crate::reading_path::PublicPaths,
        path: &crate::reading_path::PublicPath,
    ) -> String {
        let listed = paths.paths.iter().any(|path| path.listed);
        let mut body = String::from(
            "<div class=\"ob-container ob-container-reading\">\n<article class=\"ob-page ob-reading-path\">\n",
        );
        if listed {
            body.push_str(&format!(
                "<p class=\"ob-eyebrow\"><a href=\"{}\">Reading paths</a></p>\n",
                crate::reading_path::PATHS_URL
            ));
        }
        body.push_str(&self.heading(theme, 1, &path.title, "ob-post-title"));
        body.push_str("\n<div class=\"ob-prose\">\n");
        if let Some(summary) = &path.summary {
            body.push_str(&format!("<p class=\"ob-lede\">{}</p>\n", text(summary)));
        }
        let optional = path.steps.iter().filter(|step| step.optional).count();
        let mut facts = format!(
            "{} step{} in the order the author chose",
            path.steps.len(),
            if path.steps.len() == 1 { "" } else { "s" }
        );
        if optional > 0 {
            facts.push_str(&format!(", {optional} of them optional"));
        }
        body.push_str(&format!(
            "<p class=\"ob-meta\">{facts}. {}</p>\n",
            text(PATHS_NOTE)
        ));
        body.push_str(&format!(
            "<ob-reading-path data-slug=\"{}\">\n<ol class=\"ob-path-steps\">\n",
            attr(&path.slug)
        ));
        let last = path.steps.len();
        for (index, step) in path.steps.iter().enumerate() {
            let position = step.position;
            body.push_str(&format!(
                "<li id=\"step-{position}\" class=\"ob-path-step\" data-key=\"{}:{}\" data-optional=\"{}\">\n",
                step.kind,
                attr(&step.target),
                step.optional
            ));
            body.push_str(&format!(
                "<h2 class=\"ob-path-step-title\"><span class=\"ob-path-step-number\">Step {position}.</span> <a href=\"{}\"><bdi>{}</bdi></a></h2>\n",
                attr(&step.url),
                text(&step.title)
            ));
            let mut facts = vec![step.kind_label.to_string()];
            if let Some(difficulty) = step.difficulty {
                facts.push(format!("{} (the author's judgement)", difficulty.value()));
            }
            if step.optional {
                facts.push("optional: you can skip it and keep reading".to_string());
            }
            body.push_str(&format!(
                "<p class=\"ob-meta\">{}</p>\n",
                text(&facts.join(" · "))
            ));
            if let Some(transition) = &step.transition {
                let about = path
                    .steps
                    .iter()
                    .find(|other| other.position == transition.follows)
                    .map(|other| {
                        format!(
                            "(step <a href=\"#step-{0}\">{0}, {1}</a>)",
                            other.position,
                            text(&other.title)
                        )
                    })
                    .unwrap_or_default();
                body.push_str(&format!(
                    "<p class=\"ob-path-relation\"><strong>{}</strong> {about}</p>\n<p class=\"ob-path-why\">{}</p>\n",
                    text(transition.label),
                    text(&transition.why)
                ));
            }
            if let Some(rationale) = &step.rationale {
                body.push_str(&format!(
                    "<p class=\"ob-path-rationale\"><em>Why it is in the path:</em> {}</p>\n",
                    text(rationale)
                ));
            }
            if let Some(prerequisites) = &step.prerequisites {
                body.push_str(&format!(
                    "<p class=\"ob-path-prerequisites\"><em>Before this step:</em> {} (a note, not a requirement)</p>\n",
                    text(prerequisites)
                ));
            }
            body.push_str("<p class=\"ob-path-nav\">");
            if index > 0 {
                let before = &path.steps[index - 1];
                body.push_str(&format!(
                    "<a href=\"#step-{0}\" rel=\"prev\">Previous: step {0}, {1}</a>",
                    before.position,
                    text(&before.title)
                ));
            } else {
                body.push_str("<span>First step</span>");
            }
            body.push_str(" · ");
            if index + 1 < last {
                let after = &path.steps[index + 1];
                body.push_str(&format!(
                    "<a href=\"#step-{0}\" rel=\"next\">Next: step {0}, {1}</a>",
                    after.position,
                    text(&after.title)
                ));
            } else {
                body.push_str("<span>End of the path</span>");
            }
            body.push_str("</p>\n</li>\n");
        }
        body.push_str("</ol>\n</ob-reading-path>\n</div>\n</article>\n</div>");
        let description = path
            .summary
            .clone()
            .unwrap_or_else(|| format!("A reading path of {last} steps."));
        let mut meta = self.meta_simple(theme, &path.title, &description, &path.url);
        meta.reading_path = true;
        self.document(&meta, &body)
    }

    fn simple(
        &self,
        theme: &Theme,
        title: &str,
        description: &str,
        path: &str,
        body: &str,
    ) -> String {
        let meta = self.meta_simple(theme, title, description, path);
        self.document(&meta, body)
    }
}

/// How many recent jobs the services index lists per service, and a service page lists.
const SERVICE_INDEX_JOBS: usize = 3;
const SERVICE_PAGE_JOBS: usize = 5;
/// How many recent jobs a service-area page lists.
const AREA_PAGE_JOBS: usize = 10;

/// The price band and timeline of a service as escaped text, in a fixed order.
fn service_facts(service: &crate::model::Service) -> Vec<String> {
    let mut facts = Vec::new();
    if let Some(band) = service.price_band {
        facts.push(format!("Price band: {}", text(band.label())));
    }
    if let Some(timeline) = &service.typical_timeline {
        facts.push(format!("Typical timeline: {}", text(timeline)));
    }
    facts
}

/// What the reading paths index says before any path.
const PATHS_LEDE: &str = "Routes through this site's posts and Knowledge Atlas entries, in an order the author chose, each with a reason for the step that follows.";
/// What a path page says about its transitions.
const PATHS_NOTE: &str = "Each step says in the author's words how it relates to the step it follows. Order alone never means that one thing influenced another, and no step is required reading.";

/// What the atlas index says before any entry.
const ATLAS_LEDE: &str = "People, works, concepts, movements and events, and the relationships between them that the author has chosen to publish. Each relationship is one party's assertion on cited evidence; contested ones name who disagrees.";
/// What the atlas timeline says before it lists anything (ADR 0100).
const ATLAS_TIMELINE_NOTE: &str = "Every published dating in time order, grouped by the century in which each dated aspect's earliest dating begins. Each dating is one party's claim on cited evidence, at the precision it states. Competing datings of the same thing stand side by side; none is preferred, and nothing here resolves them. The order is for reading only: it never means that one thing caused or influenced another.";
/// What an entry page says above its relationship trail (ADR 0175).
const ATLAS_TRAIL_NOTE: &str = "Each step below is one relationship that someone published, in the direction it was stated, with who asserts it, how firmly, and the evidence and doubt they gave. A trail follows published relationships outward from this entry, in either direction, one step at a time. It is not a line of influence: nothing here infers a relationship that was not published, joins steps into a new claim, or treats being near as being important.";
/// What an entry page says above its datings.
const ATLAS_DATES_NOTE: &str = "Each dating is one party's claim on cited evidence, at the precision it states. Competing datings stand side by side; none is preferred, and nothing here resolves them.";

/// How far a trail step is from the entry, in words.
fn steps_label(depth: usize) -> String {
    match depth {
        1 => "One step".to_string(),
        2 => "Two steps".to_string(),
        3 => "Three steps".to_string(),
        n => format!("{n} steps"),
    }
}

/// "2 competing datings, side by side", or that only one is published.
fn competing_text(count: usize) -> String {
    if count == 1 {
        "1 dating; no competing dating is published.".to_string()
    } else {
        format!("{count} competing datings, side by side. None is preferred.")
    }
}

/// "1 published dating", "3 published datings".
fn plural_text(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// The first letter in upper case, for a generated word starting a sentence.
fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// What every atlas entry page says under its relationships.
const ATLAS_NOTE: &str = "Every relationship here is one party's assertion on cited evidence, published with the author's approval. A contested relationship lists who disagrees. Nothing here claims that scholars agree.";

/// What the comparisons index says before any comparison.
const COMPARISONS_LEDE: &str = "Passages the author has compared across editions, translations, manuscripts and interpretations. Every version is identified with its locators; its wording is quoted only where the author states that the version's text may be shown.";
/// What every comparison page says at the end.
const COMPARISONS_NOTE: &str = "Rights statements are the author's own declarations, not legal judgements. A version whose rights are unknown or reserved is identified and located but not quoted. Interpretations are attributed to whoever made them and are not the text they interpret.";

fn comparison_title(comparisons: &PublicComparisons, comparison: &PublicComparison) -> String {
    match &comparison.label {
        Some(label) => label.clone(),
        None => {
            let titles: Vec<String> = comparison
                .versions
                .iter()
                .take(3)
                .map(|version| comparisons.title_of(&version.source))
                .collect();
            format!("Comparison of {}", titles.join(", "))
        }
    }
}

/// Wording as a block quotation in its own language and direction. Text is
/// escaped and line breaks kept; nothing else changes.
fn comparison_quote(quoted: &PublicText) -> String {
    let lang = quoted
        .language
        .as_deref()
        .map(|language| format!(" lang=\"{}\"", attr(language)))
        .unwrap_or_default();
    format!(
        "<blockquote{lang} dir=\"{}\"><p>{}</p></blockquote>\n",
        quoted.dir,
        text(&quoted.text).replace('\n', "<br>")
    )
}

/// One version's section: its identification, its rights statement, then
/// each of its places.
fn comparison_version(
    comparisons: &PublicComparisons,
    version: &PublicVersion,
    number: usize,
) -> String {
    let id = format!("comparison-version-{number}");
    let source = comparisons.source(&version.source);
    let title = comparisons.title_of(&version.source);
    let mut out = format!(
        "<section class=\"ob-comparison-version\" aria-labelledby=\"{id}\" data-version-kind=\"{}\">\n",
        match version.kind {
            VersionKind::Source => "source",
            VersionKind::Interpretation => "interpretation",
        }
    );
    match (&version.kind, &version.interpretation) {
        (VersionKind::Interpretation, Some(interpretation)) => {
            out.push_str(&format!(
                "<h2 id=\"{id}\"><bdi>{}</bdi></h2>\n",
                text(&comparison_publication::interpretation_heading(
                    interpretation
                ))
            ));
            out.push_str(&format!(
                "<p class=\"ob-meta\">An interpretation of <cite><bdi>{}</bdi></cite>, attributed to whoever made it. It is not that text.</p>\n",
                text(&title)
            ));
        }
        _ => {
            out.push_str(&format!(
                "<h2 id=\"{id}\"><bdi>{}</bdi></h2>\n",
                text(&title)
            ));
            if let Some(source) = source {
                let mut facts = vec![capitalized(source.reference.kind)];
                if let Some(language) = &source.reference.language {
                    facts.push(format!("language {language}"));
                }
                if version.anonymous {
                    facts.push("anonymous".to_string());
                }
                out.push_str(&format!(
                    "<p class=\"ob-meta\">{}</p>\n",
                    text(&facts.join(", "))
                ));
                // Each maker reads as an interpreter does: the name, then how
                // firmly the author ties it to the version (ADR 0086).
                let mut roles: Vec<(String, Vec<String>)> = Vec::new();
                for maker in &version.makers {
                    let role = capitalized(maker.role.as_deref().unwrap_or("creator"));
                    let name =
                        comparison_publication::attributed_name(&maker.name, maker.attribution);
                    match roles.iter_mut().find(|(known, _)| *known == role) {
                        Some((_, names)) => names.push(name),
                        None => roles.push((role, vec![name])),
                    }
                }
                for (role, names) in roles {
                    out.push_str(&format!(
                        "<p class=\"ob-meta\">{}: <bdi>{}</bdi></p>\n",
                        text(&role),
                        text(&names.join("; "))
                    ));
                }
            }
        }
    }
    if let Some(source) = source {
        out.push_str(&format!(
            "<p class=\"ob-meta\">Source: <cite><bdi>{}</bdi></cite></p>\n",
            text(&source.text)
        ));
    }
    out.push_str(&format!(
        "<p class=\"ob-meta\" data-rights=\"{}\">Rights: <bdi>{}{}</bdi>. This is the author's statement, not a legal judgement.</p>\n",
        version.rights.status.tag(),
        text(version.rights.label),
        version
            .rights
            .license
            .as_deref()
            .map(|license| format!(" ({})", text(license)))
            .unwrap_or_default()
    ));
    out.push_str(&format!(
        "<ol class=\"ob-comparison-places\" aria-label=\"Places in {}\">\n",
        attr(&title)
    ));
    for place in &version.places {
        out.push_str(&comparison_place(version, place));
    }
    out.push_str("</ol>\n</section>\n");
    out
}

fn comparison_place(version: &PublicVersion, place: &PublicPlace) -> String {
    let mut out = String::from("<li class=\"ob-comparison-place\">\n");
    let locators = if place.locators.is_empty() {
        "none recorded".to_string()
    } else {
        crate::bibliography::CitationLocale::En.locators_text(&place.locators)
    };
    out.push_str(&format!(
        "<p class=\"ob-meta\">Where: {}</p>\n",
        text(&locators)
    ));
    if place.absent {
        out.push_str("<p data-place=\"absent\">Absent: this version lacks the passage.</p>\n");
    } else if let Some(quoted) = &place.text {
        out.push_str(&comparison_quote(quoted));
        if let Some(normalized) = &place.normalized {
            out.push_str(&format!(
                "<p class=\"ob-meta\">The author's normalization, not the source text{}:</p>\n",
                normalized
                    .note
                    .as_deref()
                    .map(|note| format!(" ({})", text(note)))
                    .unwrap_or_default()
            ));
            out.push_str(&comparison_quote(&normalized.text));
        }
    } else if let Some(withheld) = place.withheld {
        out.push_str(&format!(
            "<p data-place=\"withheld\">{}</p>\n",
            text(&comparison_publication::withheld_text(
                withheld,
                &version.rights
            ))
        ));
    } else {
        out.push_str("<p data-place=\"unquoted\">No wording is quoted for this place.</p>\n");
    }
    out.push_str("</li>\n");
    out
}

/// ` · N views` for a page with a known count, else empty.
fn site_views_text(site: &Site, path: &str) -> String {
    if !site.config.analytics.bake_counts {
        return String::new();
    }
    match site.view_counts.get(path) {
        Some(&n) if n > 0 => format!(" · {n} {}", if n == 1 { "view" } else { "views" }),
        _ => String::new(),
    }
}

// `cdata` is re-exported for callers that build custom feeds on top of the renderer.
#[allow(dead_code)]
fn _keep_cdata(s: &str) -> String {
    cdata(s)
}

fn author_json_ld(config: &SiteConfig) -> Option<serde_json::Value> {
    let name = config.author.name.trim();
    if name.is_empty() {
        return None;
    }
    let (url, id) = if config.author.url.trim().is_empty() {
        (config.absolute("/"), config.absolute("/#author"))
    } else {
        let url = config.absolute(config.author.url.trim());
        let id = if url.contains('#') {
            url.clone()
        } else {
            format!("{}#person", url.trim_end_matches('/'))
        };
        (url, id)
    };
    let mut author = serde_json::json!({
        "@type": "Person",
        "@id": id,
        "name": name,
        "url": url,
    });
    let same_as: Vec<&str> = config
        .author
        .same_as
        .iter()
        .map(|url| url.trim())
        .filter(|href| href.starts_with("https://") || href.starts_with("http://"))
        .collect();
    if !same_as.is_empty() {
        author["sameAs"] = serde_json::json!(same_as);
    }
    Some(author)
}

fn author_html(credit: &ResolvedCredit) -> String {
    let contributor = &credit.contributor;
    if contributor.url.trim().is_empty() {
        format!(
            "<span class=\"p-author h-card\">{}</span>",
            text(&contributor.name)
        )
    } else {
        format!(
            "<a class=\"p-author h-card\" rel=\"author\" href=\"{}\">{}</a>",
            attr(contributor.url.trim()),
            text(&contributor.name)
        )
    }
}

/// The escaped, non-empty names of `credits`, in order, as plain text: a series names people but
/// never links or marks them up (ADR 0040).
fn credit_names<'a>(credits: impl IntoIterator<Item = &'a ResolvedCredit>) -> Vec<String> {
    credits
        .into_iter()
        .map(|credit| credit.contributor.name.trim())
        .filter(|name| !name.is_empty())
        .map(text)
        .collect()
}

/// "By Ann, Bo, and Cy" for one part of a collaborative series, from the post's approved author
/// credits in credit order (ADR 0040), or `None` when no author has a name to show.
fn part_credit(post: &Post) -> Option<String> {
    let names = credit_names(post.authors());
    (!names.is_empty()).then(|| format!("By {}", human_list(&names)))
}

pub(crate) fn human_list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [only] => only.clone(),
        [first, second] => format!("{first} and {second}"),
        _ => {
            let (last, leading) = items.split_last().expect("non-empty list");
            format!("{}, and {last}", leading.join(", "))
        }
    }
}

fn contributions_html(post: &Post) -> String {
    crate::contributor::contributions_html(
        &post.credits,
        |url| Ok::<_, std::convert::Infallible>(url.to_string()),
        Some("/assets/orcid-unauthenticated-id-icons.png"),
    )
    .unwrap_or_else(|never| match never {})
}

fn contributor_json_ld(
    config: &SiteConfig,
    credit: &ResolvedCredit,
    entity_url: &str,
) -> serde_json::Value {
    let contributor = &credit.contributor;
    let explicit_url = contributor.url.trim();
    let id = if explicit_url.is_empty() {
        format!("{entity_url}#contributor-{}", credit.contributor_id)
    } else {
        let url = config.absolute(explicit_url);
        if url.contains('#') {
            url
        } else {
            format!("{}#person", url.trim_end_matches('/'))
        }
    };
    let mut person = serde_json::json!({
        "@type": "Person",
        "@id": id,
        "name": contributor.name,
    });
    if !explicit_url.is_empty() {
        person["url"] = serde_json::json!(config.absolute(explicit_url));
    }
    let same_as = contributor
        .same_as
        .iter()
        .map(|url| url.trim())
        .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
        .collect::<Vec<_>>();
    if !same_as.is_empty() {
        person["sameAs"] = serde_json::json!(same_as);
    }
    if !contributor.orcid.is_empty() {
        person["identifier"] = serde_json::json!(contributor.orcid);
    }
    person
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SiteConfig;
    use crate::model::{LoadOptions, SourceFile, Sources};
    use crate::theme::ThemeFile;

    fn model(config_json: &str, extra_theme: bool) -> (Site, ThemeSet) {
        let config = SiteConfig::from_json(config_json).unwrap();
        let src = |p: &str, c: &str| SourceFile {
            path: p.into(),
            contents: c.into(),
        };
        let site = Site::load(
            config,
            Sources {
                posts: vec![
                    src("posts/one.md", "---\ntitle: One\ndate: 2026-01-01\nseries: s\ntags: [a]\n---\n## A\n\n## B\n\n## C\n\ntext\n"),
                    src("posts/two.md", "---\ntitle: Two\ndate: 2026-02-01\nseries: s\n---\nbody <script>x</script>"),
                    src("posts/solo.md", "---\ntitle: Solo\ndate: 2026-03-01\n---\nbody"),
                ],
                credits: Vec::new(),
                series: vec![src("series/s.md", "---\nname: Series S\ntheme: loud\n---\nAbout S")],
                pages: vec![src("pages/about.md", "---\ntitle: About\nnav: true\n---\nHi")],
                services: Vec::new(),
                source_library: None,
                claim_evidence: None,
                reader_feedback: None,
                third_perspectives: None,
                community_features: None,
                continuations: None,
                landing: None,
            },
            LoadOptions::default(),
        )
        .unwrap();
        let mut themes = ThemeSet::new();
        if extra_theme {
            themes.insert(
                "loud",
                ThemeFile::from_json(r##"{"extends":"base","options":{"headingCodeLabels":true,"headingWrapper":"x-type","navLabel":"//{index}. <{label}/>","listStyle":"cards","codeLineNumbers":false},"scripts":["fx.js"],"colors":{"dark":{"accent":"#ff0"}}}"##).unwrap(),
            );
        }
        (site, themes)
    }

    fn build(config_json: &str, extra_theme: bool) -> Vec<OutputFile> {
        let (site, themes) = model(config_json, extra_theme);
        generate(&site, &themes).unwrap()
    }

    fn file<'a>(files: &'a [OutputFile], path: &str) -> &'a str {
        &files
            .iter()
            .find(|f| f.path == path)
            .unwrap_or_else(|| panic!("missing {path}"))
            .contents
    }

    #[test]
    fn site_color_scheme_toggle_overrides_every_page_theme() {
        for enabled in [false, true] {
            let (site, mut themes) = model(
                &format!(
                    r#"{{"theme":"system","postPath":"/{{slug}}/","colorSchemeToggle":{enabled}}}"#
                ),
                true,
            );
            themes.insert(
                "system",
                ThemeFile::from_json(r#"{"extends":"base","options":{"colorSchemeToggle":false}}"#)
                    .unwrap(),
            );
            let files = generate(&site, &themes).unwrap();
            for path in [
                "index.html",
                "solo/index.html",
                "series/s/index.html",
                "search/index.html",
                "404.html",
            ] {
                let html = file(&files, path);
                assert_eq!(html.contains("<ob-theme-toggle"), enabled, "{path}");
                assert_eq!(
                    html.contains("localStorage.getItem(\"ob-scheme\")"),
                    enabled,
                    "{path}"
                );
            }
        }
    }

    #[test]
    fn system_color_scheme_omits_toggle_and_saved_override_on_every_page() {
        let (site, mut themes) = model(
            r#"{"theme":"system","postsPerPage":2,"postPath":"/{slug}/"}"#,
            true,
        );
        themes.insert(
            "system",
            ThemeFile::from_json(r#"{"extends":"base","options":{"colorSchemeToggle":false}}"#)
                .unwrap(),
        );
        let files = generate(&site, &themes).unwrap();
        for path in [
            "index.html",
            "page/2/index.html",
            "solo/index.html",
            "series/index.html",
            "search/index.html",
            "about/index.html",
            "404.html",
        ] {
            let html = file(&files, path);
            assert!(!html.contains("<ob-theme-toggle"), "{path}");
            assert!(
                !html.contains("localStorage.getItem(\"ob-scheme\")"),
                "{path}"
            );
        }
        // Per-series themes keep their existing manual override by default.
        let series = file(&files, "series/s/index.html");
        assert!(series.contains("<ob-theme-toggle"));
        assert!(series.contains("localStorage.getItem(\"ob-scheme\")"));
    }

    #[test]
    fn home_uses_configured_primary_heading_on_every_page() {
        let files = build(
            r#"{"home":{"heading":"Field Notes"},"postsPerPage":2}"#,
            true,
        );
        for path in ["index.html", "page/2/index.html"] {
            let html = file(&files, path);
            assert!(html.contains("<h1 id=\"latest\" class=\"ob-title\">"));
            assert!(html.contains("Field Notes"));
            assert!(!html.contains("<h2 id=\"latest\""));
            assert_eq!(html.matches("<h1 ").count(), 1);
        }
        assert!(file(&files, "index.html").contains("<h2 id=\"series\""));
    }

    #[test]
    fn generates_every_page_and_feed() {
        let files = build(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","postsPerPage":2}"#,
            true,
        );
        for path in [
            "index.html",
            "page/2/index.html",
            "one/index.html",
            "two/index.html",
            "solo/index.html",
            "series/index.html",
            "series/s/index.html",
            "tags/index.html",
            "tags/a/index.html",
            "archive/index.html",
            "search/index.html",
            "about/index.html",
            "404.html",
            "rss.xml",
            "feed.json",
            "sitemap.xml",
            "robots.txt",
            "llms.txt",
            "llms-full.txt",
            "api/blog.json",
            "search.json",
            "openblog-comments.json",
            "themes/base/tokens.css",
            "themes/loud/tokens.css",
        ] {
            assert!(files.iter().any(|f| f.path == path), "missing {path}");
        }
    }

    #[test]
    fn series_navigation_is_the_same_shape_on_every_part() {
        let files = build(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#,
            true,
        );
        let first = file(&files, "one/index.html");
        let last = file(&files, "two/index.html");
        for page in [first, last] {
            assert!(page.contains("<ol class=\"ob-series-path\" aria-hidden=\"true\">"));
            assert_eq!(page.matches("<li data-current></li>").count(), 1);
            assert_eq!(page.matches("class=\"ob-series-prev").count(), 1);
            assert_eq!(page.matches("class=\"ob-series-next").count(), 1);
            assert!(!page.contains("<div class=\"ob-series-nav\"><span></span>"));
        }
        assert!(first.contains("<li data-current></li><li></li>"));
        assert!(first.contains("Start of series"));
        assert!(first.contains("rel=\"next\""));
        assert!(!first.contains("End of series"));
        assert!(last.contains("<li></li><li data-current></li>"));
        assert!(last.contains("End of series"));
        assert!(last.contains("rel=\"prev\""));
        assert!(last.contains("Back to Series S"));
        assert!(!last.contains("Start of series"));
    }

    #[test]
    fn series_theme_applies_to_its_posts_only() {
        let files = build(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#,
            true,
        );
        let one = file(&files, "one/index.html");
        assert!(one.contains("data-ob-theme=\"loud\""));
        assert!(one.contains("/themes/loud/tokens.css"));
        assert!(one.contains("&lt;h1&gt;"));
        assert!(one.contains("<x-type>One</x-type>"));
        assert!(one.contains("<script type=\"module\" src=\"/themes/loud/fx.js\"></script>"));
        assert!(one.contains("Part 1 of 2 in"));
        assert!(one.contains("//01. &lt;Home/&gt;"));
        assert!(one.contains("On this page"));
        let solo = file(&files, "solo/index.html");
        assert!(solo.contains("data-ob-theme=\"base\""));
        assert!(!solo.contains("x-type"));
        assert!(!solo.contains("fx.js"));
        assert!(file(&files, "series/s/index.html").contains("data-ob-theme=\"loud\""));
    }

    #[test]
    fn one_document_renderer_matches_generated_posts_pages_and_series() {
        let (site, themes) = model(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#,
            true,
        );
        let all = generate(&site, &themes).unwrap();
        for (source, path) in [
            ("posts/one.md", "one/index.html"),
            ("pages/about.md", "about/index.html"),
            ("series/s.md", "series/s/index.html"),
        ] {
            let one = generate_document(&site, &themes, source).unwrap();
            assert_eq!(one.path, path);
            assert_eq!(one.contents, file(&all, path));
        }
        assert!(generate_document(&site, &themes, "posts/missing.md").is_err());
    }

    #[test]
    fn one_document_renderer_applies_production_path_validation() {
        let (site, themes) = model(
            r#"{"title":"T","url":"https://t.dev","postPath":"/assets/{slug}/"}"#,
            false,
        );
        let error = generate_document(&site, &themes, "posts/one.md").unwrap_err();
        assert!(error.contains("reserved path"), "{error}");
    }

    #[test]
    fn social_metadata_is_the_value_emitted_by_the_renderer() {
        let config = SiteConfig::from_json(
            r#"{"title":"T","description":"Site fallback","url":"https://t.dev","postPath":"/{slug}/","ogImage":"/default.png"}"#,
        )
        .unwrap();
        let site = Site::load(
            config,
            Sources {
                posts: vec![
                    SourceFile {
                        path: "posts/blank.md".into(),
                        contents:
                            "---\ntitle: Blank\ndate: 2026-01-01\ncanonical: /original\n---\n"
                                .into(),
                    },
                    SourceFile {
                        path: "posts/study.md".into(),
                        contents: "---\ntitle: Study\ndate: 2026-01-01\nprofile: research\ncanonical: /journal/study\n---\n## Abstract\nSummary.\n\n## References\n1. [Source](https://example.com/source)"
                            .into(),
                    },
                ],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        let social = social_metadata(&site, "posts/blank.md").unwrap();
        let page = generate_document(&site, &ThemeSet::new(), "posts/blank.md")
            .unwrap()
            .contents;
        assert_eq!(social.description, "");
        assert_eq!(social.url, "/original");
        assert_eq!(social.image.as_deref(), Some("https://t.dev/default.png"));
        assert_eq!(social.card, "summary_large_image");
        assert_eq!(
            social_metadata(&site, "posts/study.md").unwrap().url,
            "https://t.dev/journal/study"
        );
        assert!(!page.contains("og:description"));
        assert!(page.contains("<meta property=\"og:url\" content=\"/original\">"));
        assert!(page.contains("<meta property=\"og:image\" content=\"https://t.dev/default.png\">"));
        assert!(page.contains("<meta name=\"twitter:card\" content=\"summary_large_image\">"));
    }

    fn build_posts(config_json: &str, posts: &[(&str, &str)]) -> Vec<OutputFile> {
        let config = SiteConfig::from_json(config_json).unwrap();
        let sources = Sources {
            posts: posts
                .iter()
                .map(|(p, c)| SourceFile {
                    path: (*p).into(),
                    contents: (*c).into(),
                })
                .collect(),
            ..Sources::default()
        };
        let site = Site::load(config, sources, LoadOptions::default()).unwrap();
        generate(&site, &ThemeSet::new()).unwrap()
    }

    fn build_post_with_credits(
        config_json: &str,
        post_contents: &str,
        credits: &str,
    ) -> Vec<OutputFile> {
        let config = SiteConfig::from_json(config_json).unwrap();
        let site = Site::load(
            config,
            Sources {
                posts: vec![SourceFile {
                    path: "posts/credited.md".into(),
                    contents: post_contents.into(),
                }],
                credits: vec![SourceFile {
                    path: "posts/credited.credits.json".into(),
                    contents: credits.into(),
                }],
                ..Sources::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        generate(&site, &ThemeSet::new()).unwrap()
    }

    const RECIPE: &str = "---\ntitle: Lemon Pasta\ndate: 2026-03-02\nrecipe: true\nservings: 4\nprep: 10 min\ncook: 1 hr 5 min\ncuisine: Italian\ncourse: Dinner\ncover: /images/pasta.jpg\ntags: [pasta]\n---\nA story first.\n\n## Ingredients\n\n- 400 g spaghetti\n- 1/2 cup parmesan\n\n## Method\n\n1. Boil for 10 minutes.\n2. Toss with the cheese.\n";

    #[test]
    fn quiz_posts_render_static_accessible_markup() {
        let files = build_posts(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#,
            &[(
                "posts/lesson.md",
                "---\ntitle: Lesson\ndate: 2026-01-01\n---\n```quiz\nWhat stays local?\n- [x] Reader attempts\n- [ ] Published posts\n> Attempts remain in the browser.\n```\n",
            )],
        );
        let page = file(&files, "lesson/index.html");
        assert!(page.contains("<ob-quiz data-key=\""), "{page}");
        assert!(page.contains("<fieldset><legend>What stays local?</legend>"));
        assert!(page.contains("data-correct=\"true\""));
        assert!(page.contains("Attempts remain in the browser."));
    }

    #[test]
    fn recipe_posts_get_a_card_controls_and_recipe_data() {
        let files = build_posts(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","author":{"name":"Cook"}}"#,
            &[("posts/pasta.md", RECIPE)],
        );
        let page = file(&files, "pasta/index.html");
        assert!(page.contains("<ob-recipe key=\"/pasta/\" servings=\"4\" scaling checklists timers cook-mode print>"), "{page}");
        assert!(page
            .contains("<div><dt>Prep</dt><dd><time datetime=\"PT10M\">10 min</time></dd></div>"));
        assert!(page.contains(
            "<div><dt>Cook</dt><dd><time datetime=\"PT1H5M\">1 hr 5 min</time></dd></div>"
        ));
        assert!(page.contains(
            "<div><dt>Total</dt><dd><time datetime=\"PT1H15M\">1 hr 15 min</time></dd></div>"
        ));
        assert!(
            page.contains("<dt>Serves</dt><dd><span class=\"ob-recipe-servings\">4</span></dd>")
        );
        assert!(
            page.contains("<a class=\"ob-recipe-jump\" href=\"#ingredients\">Jump to recipe</a>")
        );
        assert!(page.contains("<ul class=\"ob-recipe-list ob-ingredients\">"));
        assert!(page.contains("</ob-code>\n</ob-recipe>"));
        // schema.org: the article and the recipe, with ISO durations and the lists.
        let start = page.find("application/ld+json\">").unwrap() + "application/ld+json\">".len();
        let end = start + page[start..].find("</script>").unwrap();
        let ld: serde_json::Value = serde_json::from_str(&page[start..end]).unwrap();
        let recipe = &ld["@graph"][1];
        assert_eq!(ld["@graph"][0]["@type"], "BlogPosting");
        assert_eq!(recipe["@type"], "Recipe");
        assert_eq!(
            recipe["recipeIngredient"],
            serde_json::json!(["400 g spaghetti", "1/2 cup parmesan"])
        );
        assert_eq!(
            recipe["recipeInstructions"][0]["text"],
            "Boil for 10 minutes."
        );
        assert_eq!(recipe["totalTime"], "PT1H15M");
        assert_eq!(recipe["recipeYield"], serde_json::json!(["4 servings"]));
        assert_eq!(recipe["recipeCuisine"], "Italian");
        assert_eq!(
            recipe["image"],
            serde_json::json!(["https://t.dev/images/pasta.jpg"])
        );

        // Each feature can be switched off in openblog.json.
        let files = build_posts(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","recipes":{"scaling":false,"timers":false,"jumpLink":false,"cookMode":false}}"#,
            &[("posts/pasta.md", RECIPE)],
        );
        let page = file(&files, "pasta/index.html");
        assert!(
            page.contains("<ob-recipe key=\"/pasta/\" checklists print>"),
            "{page}"
        );
        assert!(!page.contains("Jump to recipe"));
    }

    #[test]
    fn research_posts_render_visible_and_machine_readable_work_metadata() {
        let files = build_posts(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","author":{"name":"Dr. Ada & Co."}}"#,
            &[(
                "posts/study.md",
                "---\ntitle: Study & Results\ndate: 2026-10-23\nprofile: research\ncanonical: https://journal.example/study\ndoi: 10.1234/café/results\nlicense: https://creativecommons.org/licenses/by/4.0/\n---\n## Abstract\nSummary.\n\n## References\n1. [Prior work](https://doi.org/10.1000/prior)\n2. [Dataset](https://data.example/set)",
            )],
        );
        let page = file(&files, "study/index.html");

        assert!(
            page.contains("<aside class=\"ob-work-meta\" aria-label=\"Research work details\">")
        );
        assert!(page.contains(
            "href=\"https://doi.org/10.1234/caf%C3%A9%2Fresults\">10.1234/café/results</a>"
        ));
        assert!(page.contains("href=\"https://creativecommons.org/licenses/by/4.0/\">License</a>"));
        assert!(page.contains("<meta name=\"citation_title\" content=\"Study &amp; Results\">"));
        assert!(page.contains("<meta name=\"citation_author\" content=\"Dr. Ada &amp; Co.\">"));
        assert!(page.contains("<meta name=\"citation_publication_date\" content=\"2026/10/23\">"));
        assert!(!page.contains("citation_doi"));
        assert!(!page.contains("DC."));

        let start = page.find("application/ld+json\">").unwrap() + "application/ld+json\">".len();
        let end = page[start..].find("</script>").unwrap() + start;
        let ld: serde_json::Value = serde_json::from_str(&page[start..end]).unwrap();
        assert_eq!(ld["@type"], "ScholarlyArticle");
        assert_eq!(ld["url"], "https://journal.example/study");
        assert_eq!(ld["mainEntityOfPage"], "https://journal.example/study");
        assert!(ld.get("publisher").is_none());
        assert_eq!(
            ld["identifier"],
            "https://doi.org/10.1234/caf%C3%A9%2Fresults"
        );
        assert_eq!(
            ld["license"],
            "https://creativecommons.org/licenses/by/4.0/"
        );
        assert_eq!(
            ld["citation"],
            serde_json::json!(["https://doi.org/10.1000/prior", "https://data.example/set"])
        );
    }

    #[test]
    fn explicit_credits_publish_ordered_byline_roles_orcid_and_json_ld() {
        let files = build_post_with_credits(
            r#"{
              "title":"T",
              "url":"https://t.dev",
              "postPath":"/{slug}/",
              "author":{"name":"Site Owner","url":"/about/"},
              "contributors":{
                "grace":{"name":"Grace <Hopper>","url":"https://grace.example"},
                "ada":{"name":"Ada & Co.","orcid":"0000-0002-1825-0097"},
                "linus":{"name":"Linus","sameAs":["https://social.example/linus"]}
              }
            }"#,
            "---\ntitle: Credited\ndate: 2026-10-23\n---\n## Contributions\n\nAuthored section.",
            r#"{
              "version":1,
              "credits":[
                {"contributor":"grace","roles":[
                  {"vocabulary":"crossref","role":"author"},
                  {"vocabulary":"credit","role":"software"}
                ]},
                {"contributor":"ada","roles":[
                  {"vocabulary":"crossref","role":"author"},
                  {"vocabulary":"credit","role":"conceptualization"}
                ]},
                {"contributor":"linus","roles":[
                  {"vocabulary":"crossref","role":"editor"}
                ]}
              ]
            }"#,
        );
        let page = file(&files, "credited/index.html");

        assert!(page.contains(
            "By <a class=\"p-author h-card\" rel=\"author\" href=\"https://grace.example\">Grace &lt;Hopper&gt;</a> and <span class=\"p-author h-card\">Ada &amp; Co.</span>"
        ));
        assert!(page.contains(
            "<aside class=\"ob-contributions\" aria-labelledby=\"ob-contributions-title\">"
        ));
        assert_eq!(page.matches("id=\"contributions\"").count(), 1);
        assert_eq!(page.matches("id=\"ob-contributions-title\"").count(), 1);
        let grace = page.find("Grace &lt;Hopper&gt;").unwrap();
        let ada = page.find("Ada &amp; Co.").unwrap();
        let linus = page.find(">Linus<").unwrap();
        assert!(grace < ada && ada < linus, "{page}");
        assert!(page.contains("Author, Software"));
        assert!(page.contains("Author, Conceptualization"));
        assert!(page.contains("Editor"));
        assert!(page.contains("src=\"/assets/orcid-unauthenticated-id-icons.png\""));
        assert!(page.contains(">https://orcid.org/0000-0002-1825-0097</a> (unauthenticated)"));

        let start = page.find("application/ld+json\">").unwrap() + "application/ld+json\">".len();
        let end = start + page[start..].find("</script>").unwrap();
        let ld: serde_json::Value = serde_json::from_str(&page[start..end]).unwrap();
        assert_eq!(ld["author"][0]["name"], "Grace <Hopper>");
        assert_eq!(ld["author"][1]["name"], "Ada & Co.");
        assert_eq!(
            ld["author"][1]["identifier"],
            "https://orcid.org/0000-0002-1825-0097"
        );
        assert_eq!(ld["contributor"][0]["name"], "Linus");
        assert_eq!(
            ld["contributor"][0]["sameAs"],
            serde_json::json!(["https://social.example/linus"])
        );
        assert_eq!(ld["publisher"]["name"], "Site Owner");
    }

    #[test]
    fn explicit_research_credits_repeat_only_actual_authors_in_highwire_order() {
        let files = build_post_with_credits(
            r#"{
              "title":"T","url":"https://t.dev","postPath":"/{slug}/",
              "author":{"name":"Legacy"},
              "contributors":{
                "editor":{"name":"Editor"},
                "one":{"name":"First & Author"},
                "two":{"name":"Second Author"}
              }
            }"#,
            "---\ntitle: Study\ndate: 2026-10-23\nprofile: research\n---\n## Abstract\nSummary.\n\n## References\n1. [Source](https://example.com)",
            r#"{"version":1,"credits":[
              {"contributor":"editor","roles":[{"vocabulary":"crossref","role":"editor"}]},
              {"contributor":"one","roles":[{"vocabulary":"crossref","role":"author"}]},
              {"contributor":"two","roles":[{"vocabulary":"crossref","role":"author"}]}
            ]}"#,
        );
        let page = file(&files, "credited/index.html");
        let first = page
            .find("<meta name=\"citation_author\" content=\"First &amp; Author\">")
            .unwrap();
        let second = page
            .find("<meta name=\"citation_author\" content=\"Second Author\">")
            .unwrap();
        assert!(first < second);
        assert!(!page.contains("<meta name=\"citation_author\" content=\"Editor\">"));
        assert!(!page.contains("<meta name=\"citation_author\" content=\"Legacy\">"));
    }

    #[test]
    fn explicit_empty_credits_suppress_legacy_author_output() {
        let files = build_post_with_credits(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","author":{"name":"Legacy"}}"#,
            "---\ntitle: Credited\ndate: 2026-10-23\n---\nBody",
            r#"{"version":1,"credits":[]}"#,
        );
        let page = file(&files, "credited/index.html");
        assert!(!page.contains(" · By "));
        assert!(!page.contains("class=\"ob-contributions\""));
        let start = page.find("application/ld+json\">").unwrap() + "application/ld+json\">".len();
        let end = start + page[start..].find("</script>").unwrap();
        let ld: serde_json::Value = serde_json::from_str(&page[start..end]).unwrap();
        assert!(ld.get("author").is_none());
        assert_eq!(ld["publisher"]["name"], "Legacy");
    }

    #[test]
    fn internal_contributor_links_and_bundled_orcid_assets_follow_the_site_base_path() {
        let files = build_post_with_credits(
            r#"{
              "title":"T","url":"https://t.dev/blog","postPath":"/{slug}/",
              "contributors":{"ada":{
                "name":"Ada","url":"/people/ada/","orcid":"0000-0002-1825-0097"
              }}
            }"#,
            "---\ntitle: Credited\ndate: 2026-10-23\n---\nBody",
            r#"{"version":1,"credits":[
              {"contributor":"ada","roles":[{"vocabulary":"crossref","role":"author"}]}
            ]}"#,
        );
        let page = file(&files, "credited/index.html");
        assert!(page.contains("href=\"/blog/people/ada/\""));
        assert!(page.contains("src=\"/blog/assets/orcid-unauthenticated-id-icons.png\""));
    }

    #[test]
    fn explicit_recipe_authors_are_attached_to_the_article_in_the_schema_graph() {
        let files = build_post_with_credits(
            r#"{
              "title":"T","url":"https://t.dev","postPath":"/{slug}/",
              "contributors":{"cook":{"name":"The Cook"}}
            }"#,
            RECIPE,
            r#"{"version":1,"credits":[
              {"contributor":"cook","roles":[{"vocabulary":"crossref","role":"author"}]}
            ]}"#,
        );
        let page = file(&files, "credited/index.html");
        let start = page.find("application/ld+json\">").unwrap() + "application/ld+json\">".len();
        let end = start + page[start..].find("</script>").unwrap();
        let ld: serde_json::Value = serde_json::from_str(&page[start..end]).unwrap();
        assert_eq!(ld["@graph"][0]["author"][0]["name"], "The Cook");
        assert_eq!(ld["@graph"][1]["@type"], "Recipe");
    }

    #[test]
    fn research_highwire_metadata_is_omitted_without_an_actual_author() {
        let files = build_posts(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#,
            &[(
                "posts/anonymous.md",
                "---\ntitle: Anonymous study\ndate: 2026-10-23\nprofile: research\n---\n## Abstract\nSummary.\n\n## References\n1. [Source](https://example.com/source)",
            )],
        );
        let page = file(&files, "anonymous/index.html");

        assert!(!page.contains("name=\"citation_title\""));
        assert!(!page.contains("name=\"citation_author\""));
        assert!(!page.contains("name=\"citation_publication_date\""));
    }

    #[test]
    fn recipe_text_cannot_escape_the_json_ld_script() {
        let post = "---\ntitle: Pie <!--<script> x\ndate: 2026-01-01\nrecipe: true\nservings: 0\ncook: overnight\n---\n## Ingredients\n\n- 1 cup sugar (the `<!--<script>` trick) & </script>\n\n## Steps\n\n1. Melt.\n";
        let files = build_posts(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#,
            &[("posts/pie.md", post)],
        );
        let page = file(&files, "pie/index.html");
        let start = page.find("application/ld+json\">").unwrap() + "application/ld+json\">".len();
        let end = start + page[start..].find("</script>").unwrap();
        let json = &page[start..end];
        assert!(
            !json.contains('<') && !json.contains('>') && !json.contains('&'),
            "{json}"
        );
        let ld: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(
            ld["@graph"][1]["recipeIngredient"][0],
            "1 cup sugar (the <!--<script> trick) &"
        );
        assert!(
            ld["@graph"][1].get("cookTime").is_none(),
            "unreadable times stay out of the data"
        );
        assert!(
            page.contains("<dt>Cook</dt><dd>overnight</dd>"),
            "but show as written"
        );
        assert!(
            page.contains("<dt>Serves</dt><dd>0</dd>"),
            "zero is not scalable"
        );
        assert!(ld["@graph"][1].get("recipeYield") == Some(&serde_json::json!(["0"])));
    }

    #[test]
    fn video_posts_emit_video_object_metadata_and_privacy_enhanced_embeds() {
        let post = "---\ntitle: Episode one\ndate: 2026-10-23\nprofile: video\nproductionStatus: editing\nseasonNumber: 2\nepisodeNumber: 4\nproductionCredits: Writing and direction by Mira; animation by Lantern Team\nvideoUrl: https://youtu.be/dQw4w9WgXcQ\nduration: 12 min 34 sec\nthumbnail: /images/episode.jpg\naiDisclosure: AI-assisted animation\n---\n## Transcript\nOpening narration.";
        let files = build_posts(
            r#"{"title":"Studio","url":"https://studio.example","postPath":"/{slug}/"}"#,
            &[("posts/episode.md", post)],
        );
        let page = file(&files, "episode/index.html");
        assert!(page.contains("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"));
        assert!(page.contains("Video production summary"));
        assert!(page.contains("Season 2, episode 4"));
        assert!(page.contains("<dt>Status</dt><dd>editing</dd>"));
        assert!(page.contains("Writing and direction by Mira; animation by Lantern Team"));

        let start = page.find("application/ld+json\">").unwrap() + "application/ld+json\">".len();
        let end = start + page[start..].find("</script>").unwrap();
        let ld: serde_json::Value = serde_json::from_str(&page[start..end]).unwrap();
        assert_eq!(ld["@type"], "VideoObject");
        assert_eq!(ld["name"], "Episode one");
        assert_eq!(
            ld["embedUrl"],
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
        );
        assert_eq!(ld["duration"], "PT12M34S");
        assert_eq!(
            ld["thumbnailUrl"],
            "https://studio.example/images/episode.jpg"
        );
        assert_eq!(ld["creditText"], "AI-assisted animation");
    }

    #[test]
    fn incomplete_video_profiles_fall_back_to_article_metadata() {
        let files = build_posts(
            r#"{"title":"Studio","url":"https://studio.example","postPath":"/{slug}/"}"#,
            &[(
                "posts/episode.md",
                "---\ntitle: Episode one\ndate: 2026-10-23\nprofile: video\n---\nProduction notes.",
            )],
        );
        let page = file(&files, "episode/index.html");
        let start = page.find("application/ld+json\">").unwrap() + "application/ld+json\">".len();
        let end = start + page[start..].find("</script>").unwrap();
        let ld: serde_json::Value = serde_json::from_str(&page[start..end]).unwrap();
        assert_eq!(ld["@type"], "BlogPosting");
        assert!(ld.get("embedUrl").is_none());
    }

    #[test]
    fn recipes_without_lists_warn() {
        let config = SiteConfig::from_json(r#"{"title":"T","url":"https://t.dev"}"#).unwrap();
        let sources = Sources {
            posts: vec![SourceFile {
                path: "posts/c.md".into(),
                contents: "---\ntitle: C\ndate: 2026-01-01\nrecipe: true\n---\n**Ingredients**\n\n- flour\n".into(),
            }],
            ..Sources::default()
        };
        let site = Site::load(config, sources, LoadOptions::default()).unwrap();
        let recipe_warnings: Vec<&String> = site
            .warnings
            .iter()
            .filter(|warning| warning.contains("recipe has no"))
            .collect();
        assert_eq!(recipe_warnings.len(), 2, "{:?}", site.warnings);
        assert!(recipe_warnings
            .iter()
            .any(|warning| warning.contains("## Ingredients")));
    }

    #[test]
    fn code_settings_follow_post_then_site_then_theme() {
        let post =
            |fm: &str| format!("---\ntitle: P\ndate: 2026-01-01\n{fm}---\n```js\na\nb\n```\n");
        let site = r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#;
        let files = build_posts(site, &[("posts/p.md", &post(""))]);
        assert!(file(&files, "p/index.html").contains("<ob-code highlight line-numbers>"));

        let off = r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","code":{"lineNumbers":false,"copyButton":false}}"#;
        let files = build_posts(off, &[("posts/p.md", &post(""))]);
        assert!(file(&files, "p/index.html").contains("<ob-code highlight no-copy>"));

        let files = build_posts(
            off,
            &[("posts/p.md", &post("lineNumbers: true\nhighlight: false\n"))],
        );
        assert!(
            file(&files, "p/index.html").contains("<ob-code line-numbers no-copy>"),
            "the post wins"
        );
    }

    #[test]
    fn code_blocks_get_highlighting_and_line_numbers_per_theme() {
        let files = build(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#,
            true,
        );
        assert!(file(&files, "solo/index.html").contains("<ob-code highlight line-numbers>"));
        let themed = file(&files, "one/index.html");
        assert!(themed.contains("data-ob-theme=\"loud\""));
        assert!(
            themed.contains("<ob-code highlight>"),
            "the series theme turned numbers off"
        );
    }

    #[test]
    fn escapes_and_keeps_raw_html_out_of_titles() {
        let files = build(
            r#"{"title":"T & Co","url":"https://t.dev","postPath":"/{slug}/"}"#,
            true,
        );
        let solo = file(&files, "solo/index.html");
        assert!(solo.contains("<title>Solo · T &amp; Co</title>"));
        assert!(solo.contains("application/ld+json"));
        assert!(solo
            .contains("Powered by <a href=\"https://github.com/journey-to-code-org/open.blog\""));
        let config =
            SiteConfig::from_json(r#"{"title":"T","url":"https://t.dev","poweredBy":false}"#)
                .unwrap();
        let site = Site::load(config, Sources::default(), LoadOptions::default()).unwrap();
        let files = generate(&site, &ThemeSet::new()).unwrap();
        assert!(!file(&files, "index.html").contains("Powered by"));
        assert!(file(&files, "api/blog.json").contains("\"schemaVersion\": 1"));
    }

    #[test]
    fn post_subtitles_render_escaped_between_the_title_and_byline() {
        let config =
            SiteConfig::from_json(r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#)
                .unwrap();
        let sources = Sources {
            posts: vec![
                SourceFile {
                    path: "posts/dek.md".into(),
                    contents: "---\ntitle: Dek\ndate: 2026-10-01\nsubtitle: Why <small> sites & feeds win\n---\nBody".into(),
                },
                SourceFile {
                    path: "posts/plain.md".into(),
                    contents: "---\ntitle: Plain\ndate: 2026-10-02\n---\nBody".into(),
                },
            ],
            ..Sources::default()
        };
        let site = Site::load(config, sources, LoadOptions::default()).unwrap();
        let files = generate(&site, &ThemeSet::new()).unwrap();
        let dek = file(&files, "dek/index.html");
        let title = dek.find("ob-post-title").unwrap();
        let subtitle = dek
            .find("<p class=\"ob-post-subtitle\">Why &lt;small&gt; sites &amp; feeds win</p>")
            .expect("escaped subtitle under the title");
        let byline = dek.find("<p class=\"ob-meta\">").unwrap();
        assert!(title < subtitle && subtitle < byline);
        assert!(dek.contains("\"alternativeHeadline\":\"Why "));
        let plain = file(&files, "plain/index.html");
        assert!(!plain.contains("ob-post-subtitle"));
        assert!(!plain.contains("alternativeHeadline"));
    }

    #[test]
    fn posts_expose_visible_and_structured_author_identity() {
        let files = build(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","author":{"name":"Alex","url":"https://alex.example","sameAs":["https://social.example/@alex"]}}"#,
            true,
        );
        let post = file(&files, "one/index.html");
        assert!(post.contains(
            "By <a class=\"p-author h-card\" rel=\"author\" href=\"https://alex.example\">Alex</a>"
        ));
        assert!(post.contains("\"publisher\":{\"@id\":\"https://alex.example#person\""));
        assert!(post.contains("\"sameAs\":[\"https://social.example/@alex\"]"));
        assert!(file(&files, "index.html").contains("\"publisher\""));

        let config = SiteConfig::from_json(
            r#"{"title":"T","url":"https://t.dev/blog","author":{"name":"Alex","url":"/about/"}}"#,
        )
        .unwrap();
        assert_eq!(
            author_json_ld(&config).unwrap()["url"],
            "https://t.dev/blog/about/"
        );
        let config = SiteConfig::from_json(
            r#"{"title":"T","url":"https://t.dev","author":{"name":"Alex"}}"#,
        )
        .unwrap();
        let author = author_json_ld(&config).unwrap();
        assert_eq!(author["url"], "https://t.dev/");
        assert_eq!(author["@id"], "https://t.dev/#author");
    }

    #[test]
    fn posts_get_share_links_views_related_and_snippets() {
        let files = build(
            r##"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","snippets":{"head":"<meta name=\"x-verify\" content=\"1\">","postFooter":"<div id=\"comments\"></div>","bodyEnd":"<script src=\"/x.js\"></script>"}}"##,
            true,
        );
        let one = file(&files, "one/index.html");
        assert!(one.contains("<ob-share url=\"https://t.dev/one/\" title=\"One\">"));
        assert!(one.contains(
            "https://twitter.com/intent/tweet?text=One&amp;url=https%3A%2F%2Ft.dev%2Fone%2F"
        ));
        assert!(one.contains("href=\"mailto:?subject=One&amp;body=https%3A%2F%2Ft.dev%2Fone%2F\""));
        assert!(one.contains("<ob-views path=\"/one/\" endpoint=\"\"></ob-views>"));
        assert!(
            one.contains("Related posts") && one.contains("href=\"/two/\""),
            "two shares the series"
        );
        assert!(one.contains("<meta name=\"x-verify\" content=\"1\">\n</head>"));
        assert!(one.contains("<div id=\"comments\"></div>"));
        assert!(one.contains("<script src=\"/x.js\"></script>\n</body>"));
        let solo = file(&files, "solo/index.html");
        assert!(
            !solo.contains("Related posts"),
            "nothing overlaps with solo"
        );

        let files = build(
            r#"{"title":"T","url":"https://t.dev","share":{"enabled":false},"analytics":{"showViews":false},"relatedPosts":0}"#,
            true,
        );
        let one = file(&files, "posts/one/index.html");
        assert!(
            !one.contains("ob-share")
                && !one.contains("ob-views")
                && !one.contains("Related posts")
        );
    }

    #[test]
    fn hosted_engagement_renders_comments_and_reuses_the_endpoint_for_views() {
        let protected = build(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","engagement":{"enabled":true,"endpoint":"https://t.dev/api","captcha":{"provider":"turnstile","siteKey":"public-key"}}}"#,
            true,
        );
        let html = file(&protected, "one/index.html");
        assert!(html.contains("<ob-comments path=\"/one/\" endpoint=\"https://t.dev/api\" captcha-provider=\"turnstile\" captcha-site-key=\"public-key\" captcha-scope=\"session\">"));
        assert!(!html.contains("challenges.cloudflare.com"));

        let files = build(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","analytics":{"builtin":false,"showViews":true},"engagement":{"enabled":true,"comments":true,"analytics":true,"endpoint":"https://t.dev/api/"}}"#,
            true,
        );
        let one = file(&files, "one/index.html");
        assert!(one.contains("<ob-views path=\"/one/\" endpoint=\"https://t.dev/api\">"));
        assert!(one.contains("<ob-comments path=\"/one/\" endpoint=\"https://t.dev/api\">"));

        let policies = build_posts(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","engagement":{"enabled":true,"comments":true,"endpoint":"https://t.dev/api"}}"#,
            &[
                (
                    "posts/locked.md",
                    "---\ntitle: Locked\ndate: 2026-01-01\ncomments: locked\n---\nText",
                ),
                (
                    "posts/hidden.md",
                    "---\ntitle: Hidden\ndate: 2026-01-01\ncomments: hidden\n---\nText",
                ),
            ],
        );
        assert!(file(&policies, "locked/index.html").contains("mode=\"locked\""));
        assert!(!file(&policies, "hidden/index.html").contains("<ob-comments"));
        assert_eq!(
            file(&policies, "openblog-comments.json"),
            r#"{"/hidden/":"hidden","/locked/":"locked"}"#
        );

        let disabled = build(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","engagement":{"enabled":false,"endpoint":"https://t.dev/api"}}"#,
            true,
        );
        assert!(!file(&disabled, "one/index.html").contains("<ob-comments"));
        let disabled_policies: serde_json::Value =
            serde_json::from_str(file(&disabled, "openblog-comments.json")).unwrap();
        assert!(disabled_policies
            .as_object()
            .unwrap()
            .values()
            .all(|policy| policy == "hidden"));
    }

    #[test]
    fn captcha_attributes_are_public_scoped_and_absent_when_off_locked_or_hidden() {
        let site = |captcha: &str| {
            format!(
                r#"{{"title":"T","url":"https://t.dev","postPath":"/{{slug}}/","engagement":{{"enabled":true,"endpoint":"https://t.dev/api"{captcha}}}}}"#
            )
        };
        let posts = [
            (
                "posts/open.md",
                "---\ntitle: Open\ndate: 2026-01-01\n---\nText",
            ),
            (
                "posts/locked.md",
                "---\ntitle: Locked\ndate: 2026-01-01\ncomments: locked\n---\nText",
            ),
            (
                "posts/hidden.md",
                "---\ntitle: Hidden\ndate: 2026-01-01\ncomments: hidden\n---\nText",
            ),
        ];
        let off = build_posts(&site(""), &posts);
        let explicit_off = build_posts(
            &site(r#","captcha":{"provider":"off","siteKey":"ignored-key"}"#),
            &posts,
        );
        for page in ["open/index.html", "locked/index.html", "hidden/index.html"] {
            assert!(!file(&off, page).contains("captcha"), "{page}");
            assert!(!file(&explicit_off, page).contains("captcha"), "{page}");
            assert!(!file(&explicit_off, page).contains("ignored-key"), "{page}");
        }
        assert_eq!(
            file(&off, "open/index.html"),
            file(&explicit_off, "open/index.html")
        );

        let on = build_posts(
            &site(
                r#","captcha":{"provider":"turnstile","siteKey":" key_1-2 ","scope":"every-comment"}"#,
            ),
            &posts,
        );
        let open = file(&on, "open/index.html");
        assert!(open.contains("captcha-provider=\"turnstile\" captcha-site-key=\"key_1-2\" captcha-scope=\"every-comment\""));
        assert!(!file(&on, "locked/index.html").contains("captcha"));
        assert!(file(&on, "locked/index.html").contains("mode=\"locked\""));
        assert!(!file(&on, "hidden/index.html").contains("<ob-comments"));
        assert!(!file(&on, "hidden/index.html").contains("captcha"));
        for output in &on {
            if output.path.ends_with(".xml") || output.path == "openblog-comments.json" {
                assert!(!output.contents.contains("captcha"), "{}", output.path);
            }
        }
    }

    #[test]
    fn passage_feedback_publishes_its_policy_only_when_the_site_opts_in() {
        let posts = [
            (
                "posts/locked.md",
                "---
title: Locked
date: 2026-01-01
comments: locked
---
Text",
            ),
            (
                "posts/hidden.md",
                "---
title: Hidden
date: 2026-01-01
comments: hidden
---
Text",
            ),
            (
                "posts/open.md",
                "---
title: Open
date: 2026-01-01
---
Text",
            ),
        ];
        // Comments off does not close feedback: each post's discussion
        // setting decides.
        let enabled = build_posts(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","engagement":{"enabled":true,"comments":false,"feedback":true,"endpoint":"https://t.dev/api"}}"#,
            &posts,
        );
        assert_eq!(
            file(&enabled, "openblog-feedback.json"),
            r#"{"/hidden/":"hidden","/locked/":"locked","/open/":"open"}"#
        );

        // Off by default and off with engagement off:
        // the output is exactly what it was before the feature existed.
        for config in [
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","engagement":{"enabled":true,"endpoint":"https://t.dev/api"}}"#,
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","engagement":{"enabled":false,"feedback":true,"endpoint":"https://t.dev/api"}}"#,
        ] {
            let files = build_posts(config, &posts);
            assert!(
                !files.iter().any(|f| f.path == "openblog-feedback.json"),
                "{config}"
            );
            let without: Vec<_> = build_posts(&config.replace(r#""feedback":true,"#, ""), &posts)
                .into_iter()
                .map(|f| (f.path, f.contents))
                .collect();
            let with: Vec<_> = files.into_iter().map(|f| (f.path, f.contents)).collect();
            assert_eq!(with, without, "{config}");
        }
        let defaults = SiteConfig::from_json(r#"{"title":"T","url":"https://t.dev"}"#).unwrap();
        assert!(!defaults.engagement.feedback);
    }

    #[test]
    fn aliases_redirect_and_stay_out_of_the_sitemap() {
        let config =
            SiteConfig::from_json(r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#)
                .unwrap();
        let src = |p: &str, c: &str| SourceFile {
            path: p.into(),
            contents: c.into(),
        };
        let site = Site::load(
            config,
            Sources {
                posts: vec![src(
                    "posts/new.md",
                    "---\ntitle: New\ndate: 2026-01-01\naliases: [/old/, /2024/old-name]\n---\nx",
                )],
                pages: vec![src(
                    "pages/about.md",
                    "---\ntitle: About\naliases: [/about-me/]\n---\nx",
                )],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        let files = generate(&site, &ThemeSet::new()).unwrap();
        let old = file(&files, "old/index.html");
        assert!(old.contains("<meta http-equiv=\"refresh\" content=\"0; url=/new/\">"));
        assert!(old.contains("<link rel=\"canonical\" href=\"https://t.dev/new/\">"));
        assert!(old.contains("noindex"));
        assert!(files.iter().any(|f| f.path == "2024/old-name/index.html"));
        assert!(files.iter().any(|f| f.path == "about-me/index.html"));
        assert!(files.iter().any(|f| f.path == ".nojekyll"));
        let sitemap = file(&files, "sitemap.xml");
        assert!(!sitemap.contains("/old/") && !sitemap.contains("about-me"));

        // An alias that collides with a real page is an error, not a silent overwrite.
        let config =
            SiteConfig::from_json(r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#)
                .unwrap();
        let site = Site::load(
            config,
            Sources {
                posts: vec![
                    src(
                        "posts/a.md",
                        "---\ntitle: A\ndate: 2026-01-01\naliases: [/b/]\n---\nx",
                    ),
                    src("posts/b.md", "---\ntitle: B\ndate: 2026-01-02\n---\ny"),
                ],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        assert!(generate(&site, &ThemeSet::new())
            .unwrap_err()
            .contains("b/index.html"));
    }

    #[test]
    fn series_aliases_redirect_and_a_redirects_file_carries_real_301s() {
        let src = |p: &str, c: &str| SourceFile {
            path: p.into(),
            contents: c.into(),
        };
        let sources = || Sources {
            posts: vec![src(
                "posts/a.md",
                "---\ntitle: A\ndate: 2026-01-01\nseries: git-two\naliases: [/old-a/]\n---\nx",
            )],
            series: vec![src(
                "series/git-two.md",
                "---\nname: Git Two\naliases: [/series/git-one/]\n---\nabout",
            )],
            ..Default::default()
        };
        let load = |json: &str| {
            let config = SiteConfig::from_json(json).unwrap();
            let site = Site::load(config, sources(), LoadOptions::default()).unwrap();
            generate(&site, &ThemeSet::new()).unwrap()
        };

        let plain = load(r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#);
        let moved = file(&plain, "series/git-one/index.html");
        assert!(moved.contains("<meta http-equiv=\"refresh\" content=\"0; url=/series/git-two/\">"));
        assert!(
            !plain.iter().any(|f| f.path == "_redirects"),
            "off unless asked for"
        );

        let with_file = load(
            r#"{"title":"T","url":"https://t.dev/blog","postPath":"/{slug}/","redirectsFile":true}"#,
        );
        let redirects = file(&with_file, "_redirects");
        assert!(
            redirects.contains("/blog/old-a/ /blog/a/ 301\n"),
            "{redirects}"
        );
        assert!(
            redirects.contains("/blog/series/git-one/ /blog/series/git-two/ 301\n"),
            "{redirects}"
        );
    }

    #[test]
    fn base_path_prefixes_every_root_relative_url() {
        let files = build(
            r#"{"title":"T","url":"https://user.github.io/blog","postPath":"/{slug}/"}"#,
            true,
        );
        let one = file(&files, "one/index.html");
        assert!(one.contains("href=\"/blog/assets/base.css\""));
        assert!(
            one.contains("href=\"/blog/two/\""),
            "post links carry the base path"
        );
        assert!(
            one.contains("href=\"/blog/\" aria-label"),
            "the brand link too"
        );
        assert!(one.contains("<link rel=\"canonical\" href=\"https://user.github.io/blog/one/\">"));
        assert!(file(&files, "search/index.html")
            .contains("index=\"/blog/search.json\" wasm=\"/blog/assets/wasm/"));
        assert!(file(&files, "search.json").contains("\"url\":\"/blog/one/\""));
        assert!(file(&files, "rss.xml").contains("<link>https://user.github.io/blog/one/</link>"));
        assert!(file(&files, "sitemap.xml").contains("<loc>https://user.github.io/blog/</loc>"));
    }

    #[test]
    fn baked_view_counts_and_external_endpoint() {
        let config = SiteConfig::from_json(
            r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","analytics":{"builtin":false,"endpoint":"https://counter.example.workers.dev/"}}"#,
        )
        .unwrap();
        let src = |p: &str, c: &str| SourceFile {
            path: p.into(),
            contents: c.into(),
        };
        let mut site = Site::load(
            config,
            Sources {
                posts: vec![
                    src("posts/a.md", "---\ntitle: A\ndate: 2026-01-01\n---\nx"),
                    src("posts/b.md", "---\ntitle: B\ndate: 2026-01-02\n---\ny"),
                ],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        site.view_counts.insert("/a/".into(), 1234);
        let files = generate(&site, &ThemeSet::new()).unwrap();
        let a = file(&files, "a/index.html");
        assert!(a.contains("<ob-views path=\"/a/\" endpoint=\"https://counter.example.workers.dev\"> · 1234 views</ob-views>"), "{a}");
        assert!(file(&files, "b/index.html").contains(
            "<ob-views path=\"/b/\" endpoint=\"https://counter.example.workers.dev\"></ob-views>"
        ));
        assert_eq!(file(&files, "api/views.json"), "{\"/a/\":1234}");
        // No live counter at all: the element is not emitted.
        site.config.analytics.endpoint.clear();
        let files = generate(&site, &ThemeSet::new()).unwrap();
        assert!(!file(&files, "a/index.html").contains("<ob-views"));
    }

    #[test]
    fn cdn_points_assets_elsewhere_but_not_pages_or_feeds() {
        let files = build(
            r#"{"title":"T","url":"https://t.dev","cdn":{"url":"https://cdn.t.dev","version":"v1"}}"#,
            true,
        );
        let one = file(&files, "posts/one/index.html");
        assert!(one.contains("href=\"https://cdn.t.dev/assets/base.css?v=v1\""));
        assert!(one.contains("src=\"https://cdn.t.dev/assets/openblog.js?v=v1\""));
        assert!(
            one.contains("href=\"https://cdn.t.dev/themes/loud/tokens.css?v=v1\""),
            "the series theme's tokens come from the CDN too"
        );
        assert!(
            one.contains("href=\"/posts/two/\""),
            "page links stay on the site"
        );
        assert!(one.contains("href=\"/rss.xml\""));
        assert!(
            one.contains("wasm=\"/assets/wasm/") || !one.contains("wasm="),
            "the WebAssembly module stays same-origin"
        );
        assert!(
            !file(&files, "rss.xml").contains("cdn.t.dev"),
            "feeds keep canonical site URLs"
        );
        let search = file(&files, "search/index.html");
        assert!(search.contains("wasm=\"/assets/wasm/openblog_wasm.js\""));
    }

    #[test]
    fn unknown_theme_is_an_error_and_reserved_slugs_are_rejected() {
        let config =
            SiteConfig::from_json(r#"{"title":"T","url":"https://t.dev","theme":"nope"}"#).unwrap();
        let site = Site::load(config, Sources::default(), LoadOptions::default()).unwrap();
        assert!(generate(&site, &ThemeSet::new())
            .unwrap_err()
            .contains("not found"));

        let config = SiteConfig::from_json(r#"{"title":"T","url":"https://t.dev"}"#).unwrap();
        let site = Site::load(
            config,
            Sources {
                pages: vec![SourceFile {
                    path: "pages/search.md".into(),
                    contents: "x".into(),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        assert!(generate(&site, &ThemeSet::new())
            .unwrap_err()
            .contains("reserved"));
    }
}
