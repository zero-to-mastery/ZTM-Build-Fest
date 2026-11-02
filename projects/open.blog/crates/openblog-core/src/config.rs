//! Site configuration, read from `openblog.json`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::business::BusinessConfig;
use crate::contributor::{self, Contributor};
use crate::look::LookSettings;
use crate::participation::ParticipationConfig;
use crate::reading_depth::ReadingMode;
use crate::service_area::ServiceAreasConfig;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SiteConfig {
    /// Blog title, shown in the header and feeds.
    pub title: String,
    /// One or two sentences for `<meta name="description">` and the feeds.
    pub description: String,
    /// The public address, e.g. `https://blog.example.com` (a path is allowed: `https://user.github.io/blog`).
    pub url: String,
    /// BCP 47 language tag.
    pub language: String,
    pub author: Author,
    /// Reusable person identities referenced by per-work credit sidecars.
    pub contributors: BTreeMap<String, Contributor>,
    /// Site logo shown beside the title (a site path or URL). Optional.
    pub logo: String,
    /// Favicon path or URL. Optional.
    pub favicon: String,
    /// Default social-card image used when a post has no cover.
    pub og_image: String,
    /// Default theme name (a directory under `themes/`). Series and posts can override it.
    pub theme: String,
    /// Override the theme's light/dark button. None follows each page's theme.
    pub color_scheme_toggle: Option<bool>,
    /// The owner's look: typed presets compiled into allowlisted tokens (ADR 0248). Absent means the
    /// theme as it is.
    #[serde(skip_serializing_if = "LookSettings::is_default")]
    pub appearance: LookSettings,
    /// URL pattern for posts. `{slug}` is replaced. `/{slug}/` keeps Hashnode-style URLs.
    pub post_path: String,
    /// Posts per listing page. `0` disables pagination.
    pub posts_per_page: usize,
    /// Header navigation. Pages with `nav: true` in their front matter are appended.
    pub nav: Vec<Link>,
    /// Footer links (GitHub, Mastodon, a personal site, ...).
    pub social: Vec<Link>,
    /// Footer text. `{year}` and `{author}` are replaced.
    pub footer: String,
    /// Show a small "Powered by open.blog" link in the footer.
    pub powered_by: bool,
    pub home: HomeConfig,
    pub share: ShareConfig,
    pub analytics: AnalyticsConfig,
    /// Optional hosted comments and analytics endpoint for static deployments.
    pub engagement: EngagementConfig,
    /// Raw HTML the owner wants on every page: third-party analytics, comments, forms.
    pub snippets: Snippets,
    /// How many related posts to show under each post. `0` disables the section.
    pub related_posts: usize,
    /// Optional CDN for static assets.
    pub cdn: CdnConfig,
    pub feeds: FeedsConfig,
    /// Discoverability and crawler controls.
    pub seo: SeoConfig,
    pub markdown: MarkdownConfig,
    /// Code blocks: colours, line numbers, copy buttons.
    pub code: CodeConfig,
    /// Optional public gateway for executing explicitly opted-in code lessons.
    pub code_runner: CodeRunnerConfig,
    /// Site-hosted libraries that `web runnable` lessons may opt into with `libs=`.
    pub web_sandbox: WebSandboxConfig,
    /// Interactive extras on posts with `recipe: true`.
    pub recipes: RecipesConfig,
    /// Optional author-time generation for interactive knowledge checks.
    pub knowledge_checks: KnowledgeChecksConfig,
    pub paths: PathsConfig,
    pub admin: AdminConfig,
    pub publish: PublishConfig,
    /// Optional server-side cross-posting destinations. Credentials are read from
    /// environment variables and are never serialized here.
    pub syndication: SyndicationConfig,
    /// Also write a Netlify/Cloudflare-style `_redirects` file with a real 301 for every
    /// `aliases:` address. The meta-refresh pages are always written; this adds the
    /// server-side redirect on hosts that read the file. Do not also keep your own
    /// `static/_redirects`.
    pub redirects_file: bool,
    /// Opt-in publication of the approved part of the private Knowledge Atlas.
    /// Omitted from the written file while it is off, so existing projects
    /// keep their configuration unchanged.
    #[serde(skip_serializing_if = "KnowledgeAtlasConfig::is_off")]
    pub knowledge_atlas: KnowledgeAtlasConfig,
    /// Which participation kinds beyond comments the site accepts, and how
    /// long moderation keeps what it does not publish (ADRs 0101 and 0104).
    /// Every kind is off by default, and the object is omitted from the
    /// written file while it has its defaults.
    #[serde(skip_serializing_if = "ParticipationConfig::is_default")]
    pub participation: ParticipationConfig,
    /// Opt-in publication of approved claims and evidence links with the
    /// posts they are about. Omitted from the written file while it is off.
    #[serde(skip_serializing_if = "ClaimEvidenceConfig::is_off")]
    pub claim_evidence: ClaimEvidenceConfig,
    /// Opt-in publication of approved passage comparisons. Omitted from the
    /// written file while it is off.
    #[serde(skip_serializing_if = "ComparisonsConfig::is_off")]
    pub comparisons: ComparisonsConfig,
    /// Opt-in publication of reading paths. Omitted from the written file
    /// while it is off.
    #[serde(skip_serializing_if = "ReadingPathsConfig::is_off")]
    pub reading_paths: ReadingPathsConfig,
    /// Opt-in publication of interpretation comparisons. Omitted from the
    /// written file while it is off.
    #[serde(skip_serializing_if = "InterpretationsConfig::is_off")]
    pub interpretations: InterpretationsConfig,
    /// Opt-in publication of the author's curated selection of research
    /// context for readers (ADR 0185). Omitted from the written file while
    /// it is off.
    #[serde(skip_serializing_if = "CuratedContextConfig::is_off")]
    pub curated_context: CuratedContextConfig,
    /// The reading mode a post with supplements opens in when the post does
    /// not say (ADR 0142). Omitted from the written file while it is standard.
    #[serde(
        deserialize_with = "ReadingModesConfig::tolerant",
        skip_serializing_if = "ReadingModesConfig::is_default"
    )]
    pub reading_modes: ReadingModesConfig,
    /// Opt-in local highlights and private notes for readers (ADR 0241).
    /// Omitted from the written file while it is off.
    #[serde(skip_serializing_if = "ReaderAnnotationsConfig::is_off")]
    pub reader_annotations: ReaderAnnotationsConfig,
    /// Trades a site adds to the bundled list for the job profile (ADR
    /// 0285). Omitted from the written file while empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub extra_trades: Vec<String>,
    /// The business facts stated once for every page (ADR 0305). Omitted from the
    /// written file while nothing is stated, so a site that never sets it builds
    /// exactly as before.
    #[serde(skip_serializing_if = "BusinessConfig::is_default")]
    pub business: BusinessConfig,
    /// The towns the business serves (ADR 0314). Omitted from the written file
    /// while none are stated, so a site that never sets it builds exactly as before.
    #[serde(skip_serializing_if = "ServiceAreasConfig::is_default")]
    pub service_areas: ServiceAreasConfig,
}

/// Whether posts offer readers local highlights and private notes. Off by
/// default: pages are then exactly what they were. On, each post gains a
/// region and a script that keep a reader's annotations in that reader's own
/// browser; the build never sees them.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ReaderAnnotationsConfig {
    pub enabled: bool,
}

impl ReaderAnnotationsConfig {
    fn is_off(&self) -> bool {
        !self.enabled
    }
}

/// The site-wide default reading mode (ADR 0142). It only decides where a
/// post that opted in with `readingModes` opens; it never opts a post in. A
/// post's own `readingModes.default` wins, then this, then standard. Read
/// tolerantly: `"readingModes": {"default": "guided"}` or the bare mode
/// name; anything unreadable leaves the default at standard instead of
/// failing the whole configuration.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingModesConfig {
    pub default: ReadingMode,
}

impl ReadingModesConfig {
    fn is_default(&self) -> bool {
        self.default == ReadingMode::Standard
    }

    fn tolerant<'de, D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let name = match &value {
            serde_json::Value::String(name) => Some(name.as_str()),
            serde_json::Value::Object(map) => map.get("default").and_then(|v| v.as_str()),
            _ => None,
        };
        Ok(Self {
            default: name
                .and_then(|name| ReadingMode::parse(&name.trim().to_ascii_lowercase()))
                .unwrap_or_default(),
        })
    }
}

/// Whether builds publish approved passage comparisons (ADR 0092). Off by
/// default: the build then never reads the private alignments file. On, it
/// publishes `/comparisons/` pages and `/comparisons.json` holding only
/// approved alignments, with each place's wording only where the author
/// states the version's text may be displayed.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ComparisonsConfig {
    pub publish: bool,
}

impl ComparisonsConfig {
    fn is_off(&self) -> bool {
        !self.publish
    }
}

/// Whether the site publishes reading paths (ADR 0212). Off by default: the
/// address `/paths/` is then not reserved, so an existing page or post there
/// keeps working, and `content/paths` is only edited, never published. Turning
/// it on reserves `/paths/`, and a page or post URL that collides is refused.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ReadingPathsConfig {
    pub publish: bool,
}

impl ReadingPathsConfig {
    fn is_off(&self) -> bool {
        !self.publish
    }
}

/// Whether the site publishes interpretation comparisons (ADR 0232). Off by
/// default: `/interpretations/` is then not reserved and `content/comparisons`
/// is only edited, never published. Turning it on reserves `/interpretations/`,
/// and a page or post URL that collides is refused. Evidence a comparison cites
/// is shown only while `claimEvidence.publish` is on as well.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct InterpretationsConfig {
    pub publish: bool,
}

impl InterpretationsConfig {
    fn is_off(&self) -> bool {
        !self.publish
    }
}

/// Whether builds publish the author's curated research context (ADR 0185).
/// Off by default: nothing is curated and every output is exactly what it
/// was. On, the Admin preview and the build's boundary manifest list what the
/// private selections publish and why the rest is withheld. A selection only ever picks what the atlas, comparison
/// and citation projections already publish.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct CuratedContextConfig {
    pub publish: bool,
}

impl CuratedContextConfig {
    fn is_off(&self) -> bool {
        !self.publish
    }
}

/// Whether builds publish approved claim evidence (ADR 0075). Off by default:
/// the build then never reads the private claims file and every post is
/// published as before. On, each post with approved claims or revision notes
/// gains a "Claims and evidence" section, and the site gains
/// `/claim-evidence.json`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaimEvidenceConfig {
    pub publish: bool,
}

impl ClaimEvidenceConfig {
    fn is_off(&self) -> bool {
        !self.publish
    }
}

/// Whether builds publish the Knowledge Atlas projection (ADR 0058). Off by
/// default: the build then never reads the private atlas. On, it publishes
/// `/atlas/` pages and `/atlas.json` holding only approved entries and the
/// relationships whose entries are all approved.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct KnowledgeAtlasConfig {
    pub publish: bool,
}

impl KnowledgeAtlasConfig {
    fn is_off(&self) -> bool {
        !self.publish
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Author {
    pub name: String,
    pub url: String,
    pub email: String,
    /// Public profile URLs that identify the same author for structured data.
    pub same_as: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Link {
    pub label: String,
    pub href: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HomeConfig {
    /// Heading above the post list.
    pub heading: String,
    /// Markdown shown above the post list. Leave empty to hide.
    pub intro: String,
    /// Show the series overview on the home page.
    pub show_series: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FeedsConfig {
    /// Write `/rss.xml`.
    pub rss: bool,
    /// Write `/feed.json` (JSON Feed 1.1).
    pub json: bool,
    /// Write `/sitemap.xml` and `/robots.txt`.
    pub sitemap: bool,
    /// Write `/llms.txt` and `/llms-full.txt`, text-first discovery files for
    /// answer engines and other automated readers.
    pub llms: bool,
    /// Write `/api/blog.json`: the four newest posts as `{ schemaVersion, posts: [{ title, date, link }] }`,
    /// for embedding a "latest posts" list on another site.
    pub portfolio_snapshot: bool,
    /// Maximum items in RSS and JSON feeds.
    pub limit: usize,
    /// Include the full post HTML in feeds (otherwise only the summary).
    pub full_content: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MarkdownConfig {
    pub smart_punctuation: bool,
    pub heading_anchors: bool,
    /// Turn a CodePen link that stands alone in its paragraph into an embedded pen.
    pub embeds: bool,
    /// Headings at or below this level appear in the table of contents (2 = h2 only).
    pub toc_depth: u8,
    /// Minimum number of headings before a table of contents is shown.
    pub toc_min_headings: usize,
}

/// Code-block behaviour for the whole site. `highlight` and `lineNumbers`
/// override the theme when set; leave them out (or `null`) to follow the theme.
/// A post's front matter and a fence's options override these in turn.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CodeConfig {
    pub highlight: Option<bool>,
    pub line_numbers: Option<bool>,
    /// A "Copy" button on every code block.
    pub copy_button: bool,
    /// An "Open in Rust Playground" link beside Rust examples. A fence can override it with
    /// `playgroundLink=true` or `playgroundLink=false`.
    pub playground_link: bool,
}

/// Browser-facing code execution gateway. The endpoint is public configuration;
/// provider credentials belong only on the independently hosted runner.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CodeRunnerConfig {
    pub endpoint: String,
    /// Additional runnable fence languages. Rust is always enabled when an
    /// endpoint is configured; `web` keeps its dedicated local sandbox.
    pub languages: Vec<String>,
}

/// Settings for `web runnable` lessons. Libraries are files the site itself serves;
/// the page inlines them into the preview, so lessons never fetch from a CDN.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WebSandboxConfig {
    /// Library name (as written in `libs=`) to root-relative script paths, in load order.
    pub libraries: BTreeMap<String, Vec<String>>,
}

/// Normalize one code-runner language identifier shared by configuration and
/// authoring tools. Returns `None` for identifiers that cannot safely appear
/// in a Markdown fence or the browser runner protocol.
pub fn normalize_code_runner_language(value: &str) -> Option<String> {
    let value = value
        .trim_matches(|character: char| character.is_ascii_whitespace())
        .to_ascii_lowercase();
    let valid = (1..=32).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'_' | b'+' | b'#' | b'.' | b'-')
        });
    valid.then_some(value)
}

impl Default for CodeConfig {
    fn default() -> Self {
        Self {
            highlight: None,
            line_numbers: None,
            copy_button: true,
            playground_link: true,
        }
    }
}

/// Features on recipe posts. Each can be turned off on its own.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RecipesConfig {
    /// Buttons that scale ingredient amounts to more or fewer servings.
    pub scaling: bool,
    /// Tick off ingredients and steps while cooking (remembered on the device).
    pub checklists: bool,
    /// Durations in steps ("bake for 25 minutes") become countdown timers.
    pub timers: bool,
    /// A button that keeps the screen awake while cooking.
    pub cook_mode: bool,
    /// A button that prints just the recipe.
    pub print: bool,
    /// A "Jump to recipe" link at the top of the post.
    pub jump_link: bool,
}

impl Default for RecipesConfig {
    fn default() -> Self {
        Self {
            scaling: true,
            checklists: true,
            timers: true,
            cook_mode: true,
            print: true,
            jump_link: true,
        }
    }
}

/// An owner-supplied service that drafts questions for the admin editor.
/// API keys are stored separately and are never serialized into this configuration.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AssistantProviderKind {
    #[default]
    CustomHttps,
    Anthropic,
    OpenAi,
    Gemini,
    Xai,
    DeepSeek,
    Mistral,
    OpenRouter,
}

impl AssistantProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CustomHttps => "custom-https",
            Self::Anthropic => "anthropic",
            Self::OpenAi => "open-ai",
            Self::Gemini => "gemini",
            Self::Xai => "xai",
            Self::DeepSeek => "deep-seek",
            Self::Mistral => "mistral",
            Self::OpenRouter => "open-router",
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct KnowledgeChecksConfig {
    /// Missing values preserve the original custom HTTPS behavior.
    pub provider: AssistantProviderKind,
    pub generation_endpoint: String,
    pub model: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PathsConfig {
    pub content: String,
    #[serde(rename = "static")]
    pub static_dir: String,
    pub output: String,
    pub themes: String,
    /// Directory holding `base.css`, the web components, and the WebAssembly build.
    pub web: String,
}

impl Default for SiteConfig {
    fn default() -> Self {
        Self {
            title: "open.blog".to_string(),
            description: "A blog built with open.blog".to_string(),
            url: "https://example.com".to_string(),
            language: "en".to_string(),
            author: Author::default(),
            contributors: BTreeMap::new(),
            logo: String::new(),
            favicon: String::new(),
            og_image: String::new(),
            theme: "base".to_string(),
            color_scheme_toggle: None,
            appearance: LookSettings::default(),
            post_path: "/posts/{slug}/".to_string(),
            posts_per_page: 10,
            nav: vec![
                Link {
                    label: "Home".into(),
                    href: "/".into(),
                },
                Link {
                    label: "Series".into(),
                    href: "/series/".into(),
                },
                Link {
                    label: "Archive".into(),
                    href: "/archive/".into(),
                },
                Link {
                    label: "Search".into(),
                    href: "/search/".into(),
                },
            ],
            social: Vec::new(),
            footer: "© {year} {author}".to_string(),
            powered_by: true,
            home: HomeConfig::default(),
            share: ShareConfig::default(),
            analytics: AnalyticsConfig::default(),
            engagement: EngagementConfig::default(),
            snippets: Snippets::default(),
            related_posts: 3,
            cdn: CdnConfig::default(),
            feeds: FeedsConfig::default(),
            seo: SeoConfig::default(),
            markdown: MarkdownConfig::default(),
            code: CodeConfig::default(),
            code_runner: CodeRunnerConfig::default(),
            web_sandbox: WebSandboxConfig::default(),
            recipes: RecipesConfig::default(),
            knowledge_checks: KnowledgeChecksConfig::default(),
            paths: PathsConfig::default(),
            admin: AdminConfig::default(),
            publish: PublishConfig::default(),
            syndication: SyndicationConfig::default(),
            redirects_file: false,
            knowledge_atlas: KnowledgeAtlasConfig::default(),
            participation: ParticipationConfig::default(),
            claim_evidence: ClaimEvidenceConfig::default(),
            comparisons: ComparisonsConfig::default(),
            reading_paths: ReadingPathsConfig::default(),
            interpretations: InterpretationsConfig::default(),
            curated_context: CuratedContextConfig::default(),
            reading_modes: ReadingModesConfig::default(),
            reader_annotations: ReaderAnnotationsConfig::default(),
            extra_trades: Vec::new(),
            business: BusinessConfig::default(),
            service_areas: ServiceAreasConfig::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SyndicationProvider {
    Dev,
    Hashnode,
    Ghost,
    Wordpress,
    Medium,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SyndicationTargetConfig {
    pub provider: SyndicationProvider,
    pub enabled: bool,
    /// Permit public publication when the CLI also receives `--publish`.
    pub allow_publish: bool,
    /// Provider base URL. Required for Ghost and self-hosted WordPress.
    pub endpoint: String,
    /// Hashnode publication ID or WordPress.com numeric site ID.
    pub publication_id: String,
}

impl Default for SyndicationTargetConfig {
    fn default() -> Self {
        Self {
            provider: SyndicationProvider::Dev,
            enabled: true,
            allow_publish: false,
            endpoint: String::new(),
            publication_id: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SyndicationConfig {
    /// Private state, relative to the project root.
    pub state_file: String,
    /// User-chosen target names permit multiple sites using the same provider.
    pub targets: BTreeMap<String, SyndicationTargetConfig>,
}

impl Default for SyndicationConfig {
    fn default() -> Self {
        Self {
            state_file: ".openblog/syndication.json".into(),
            targets: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SeoConfig {
    /// Permit provider search/index crawlers used by AI answer products.
    pub ai_search: bool,
    /// Permit crawlers whose documented purpose includes foundation-model training.
    pub ai_training: bool,
}

impl Default for SeoConfig {
    fn default() -> Self {
        Self {
            ai_search: true,
            ai_training: true,
        }
    }
}

/// Settings for the login-protected editor (`openblog serve --admin`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AdminConfig {
    /// File holding users and password hashes, relative to the project root.
    /// Keep it out of version control.
    pub users_file: String,
    /// Hours a login stays valid.
    pub session_hours: u32,
    /// Mark the session cookie `Secure`. Turn on when the admin is served over HTTPS.
    pub secure_cookies: bool,
    /// Largest image upload in megabytes.
    pub max_upload_mb: u32,
    /// Addresses of reverse proxies in front of this server. When a connection
    /// comes from one of them, the client address is taken from the last
    /// `X-Forwarded-For` entry (the one that proxy appended), so login limits
    /// apply per real client instead of to everyone behind the proxy.
    pub trusted_proxies: Vec<String>,
}

impl Default for AdminConfig {
    fn default() -> Self {
        Self {
            users_file: ".openblog/users.json".to_string(),
            session_hours: 12,
            secure_cookies: false,
            max_upload_mb: 10,
            trusted_proxies: Vec::new(),
        }
    }
}

/// Share links under each post. Rendered as plain links, so they work without
/// JavaScript; `<ob-share>` adds the device's share sheet and "Copy link".
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ShareConfig {
    pub enabled: bool,
    /// Any of: x, bluesky, mastodon, linkedin, facebook, reddit, hackernews, email.
    pub networks: Vec<String>,
}

impl Default for ShareConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            networks: ["x", "bluesky", "linkedin", "reddit", "hackernews", "email"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        }
    }
}

/// The built-in, cookie-free view counter served by `openblog serve`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AnalyticsConfig {
    /// Record page views in `.openblog/analytics.json` and answer `/api/views`.
    pub builtin: bool,
    /// Show "N views" on posts (needs `builtin` and the server; hidden on static hosts).
    pub show_views: bool,
    /// Days of daily statistics to keep.
    pub retention_days: u32,
    /// Where pages send views: empty means the same origin (`/api/hit`, served by
    /// `openblog serve`). Set to the address of a counter you host elsewhere, such
    /// as the Cloudflare Worker written by `openblog analytics worker`.
    pub endpoint: String,
    /// Git branch that holds `analytics.json` as a backup, written by
    /// `openblog analytics backup` and by the server. Empty disables it.
    pub branch: String,
    /// Bake the counts known at build time into the pages and `/api/views.json`,
    /// so a static host shows them even with no live counter.
    pub bake_counts: bool,
}

impl Default for AnalyticsConfig {
    fn default() -> Self {
        Self {
            builtin: true,
            show_views: true,
            retention_days: 400,
            endpoint: String::new(),
            branch: "analytics".to_string(),
            bake_counts: true,
        }
    }
}

/// Optional captcha for hosted comments. Only public values live here; the
/// provider secret and the pass-signing secret are server environment variables.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct CaptchaConfig {
    /// `off` (default) or `turnstile`.
    pub provider: String,
    pub site_key: String,
    /// `session` (default: one challenge per tab session) or `every-comment`.
    pub scope: String,
}
impl Default for CaptchaConfig {
    fn default() -> Self {
        Self {
            provider: "off".into(),
            site_key: String::new(),
            scope: "session".into(),
        }
    }
}
impl CaptchaConfig {
    fn is_default(&self) -> bool {
        self == &Self::default()
    }
    pub fn enabled(&self) -> bool {
        self.provider != "off"
    }
}

/// Hosted comments and analytics for static deployments such as Netlify.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EngagementConfig {
    #[serde(skip_serializing_if = "CaptchaConfig::is_default")]
    pub captcha: CaptchaConfig,
    pub enabled: bool,
    pub comments: bool,
    pub analytics: bool,
    /// Public function base URL. Secrets are never stored here.
    pub endpoint: String,
    /// Accept typed passage feedback (questions, suggested sources and
    /// corrections, other interpretations) through the hosted function
    /// (ADR 0081). Off by default; the deployer must also run
    /// `supabase/feedback.sql` and set `OPENBLOG_FEEDBACK_ENABLED`.
    pub feedback: bool,
    /// Where a reader can send a copied note when the hosted function cannot
    /// take it (ADR 0082): a `mailto:` address or an `https:` contact page,
    /// shown on pages that offer passage feedback. Empty shows none.
    pub feedback_contact: String,
    /// Offer readers of passage feedback a way to use their private receipt
    /// on the page: check on a note, answer a clarification request, or
    /// withdraw it and have it deleted (ADR 0107). Off by default, and left
    /// out of the written file while off; the deployer must also run
    /// `supabase/protection.sql` and set `OPENBLOG_PROTECTION_ENABLED`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub receipts: bool,
    /// Offer readers an optional evidence block on suggested sources and
    /// corrections: the published claim, evidence link, citation or source
    /// they mean, chosen from what the site publishes (ADR 0116). Off by
    /// default, and left out of the written file while off; the deployer
    /// must also run `supabase/feedback.sql` again and set
    /// `OPENBLOG_CORRECTIONS_ENABLED`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub evidence: bool,
}

impl Default for EngagementConfig {
    fn default() -> Self {
        Self {
            captcha: CaptchaConfig::default(),
            enabled: false,
            comments: true,
            analytics: true,
            endpoint: String::new(),
            feedback: false,
            feedback_contact: String::new(),
            receipts: false,
            evidence: false,
        }
    }
}

/// Publishing: commit and push content with git from the admin or the CLI.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PublishConfig {
    /// Git remote to push to.
    pub remote: String,
    /// Branch that deploys (the Pages workflow watches `main`).
    pub branch: String,
    /// Commit and push after every save in the admin, instead of on request.
    pub auto: bool,
    /// Commit draft posts too. Off by default: a draft in a public repository is public text.
    pub include_drafts: bool,
    /// Paths that publishing commits, relative to the blog root.
    pub paths: Vec<String>,
    /// Run `git pull --rebase` before pushing, so edits made elsewhere are kept.
    pub pull_first: bool,
}

impl Default for PublishConfig {
    fn default() -> Self {
        Self {
            remote: "origin".to_string(),
            branch: "main".to_string(),
            auto: false,
            include_drafts: false,
            paths: ["content", "static", "openblog.json", "themes", ".github"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            pull_first: true,
        }
    }
}

/// Serve static assets from another origin (a CDN or object store that mirrors
/// `dist/`). When `url` is set, asset URLs in the generated pages point there
/// and carry a cache-busting `?v=` query; `openblog serve` also sends long
/// `Cache-Control` headers for those paths so a CDN in front of it caches them.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CdnConfig {
    /// Asset origin, e.g. `https://cdn.example.com`. Empty disables rewriting.
    pub url: String,
    /// Site paths served from the CDN. Page URLs are never rewritten.
    pub paths: Vec<String>,
    /// Appended as `?v=` to rewritten asset URLs. Left empty, the build derives
    /// one from the asset files, so a changed file gets a new URL.
    pub version: String,
    /// `Cache-Control: max-age` in seconds that `openblog serve` sends for asset
    /// paths. `0` sends `no-cache`.
    pub max_age: u32,
}

impl Default for CdnConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            paths: vec!["/assets/".into(), "/themes/".into(), "/images/".into()],
            version: String::new(),
            max_age: 86_400,
        }
    }
}

impl CdnConfig {
    pub fn enabled(&self) -> bool {
        !self.url.trim().is_empty()
    }

    /// Asset path prefixes, each normalised to `/name/`. The site root alone is
    /// never accepted, because that would rewrite every page link.
    pub fn prefixes(&self) -> Vec<String> {
        self.paths
            .iter()
            .map(|p| format!("/{}/", p.trim().trim_matches('/')))
            .filter(|p| p.len() > 2)
            .collect()
    }

    pub fn is_asset_path(&self, path: &str) -> bool {
        self.prefixes().iter().any(|p| path.starts_with(p))
    }

    /// Point static asset URLs in HTML or CSS at the CDN origin and add the
    /// cache-busting version. Only `src="/…"`, `href="/…"` and `url("/…")`
    /// under the configured prefixes change; page links and feeds do not.
    pub fn apply(&self, text: &str) -> String {
        // With a version, asset URLs are always versioned (so browsers can cache
        // them safely); with a CDN URL, they also move to the CDN origin.
        if !self.enabled() && self.version.trim().is_empty() {
            return text.to_string();
        }
        let base = if self.enabled() {
            self.url.trim().trim_end_matches('/')
        } else {
            ""
        };
        let mut out = text.to_string();
        for prefix in self.prefixes() {
            for marker in ["src=\"", "href=\"", "url(\""] {
                out = rewrite_urls(&out, marker, &prefix, base, self.version.trim());
            }
        }
        out
    }
}

fn prefix_root_urls(input: &str, marker: &str, base: &str) -> String {
    let needle = format!("{marker}/");
    let mut out = String::with_capacity(input.len() + 256);
    let mut rest = input;
    while let Some(i) = rest.find(&needle) {
        let after = &rest[i + needle.len()..];
        out.push_str(&rest[..i]);
        out.push_str(marker);
        if after.starts_with('/') {
            // Protocol-relative: leave as is.
            out.push('/');
        } else {
            out.push_str(base);
            out.push('/');
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

fn rewrite_urls(input: &str, marker: &str, prefix: &str, base: &str, version: &str) -> String {
    let needle = format!("{marker}{prefix}");
    let mut out = String::with_capacity(input.len() + 256);
    let mut rest = input;
    while let Some(i) = rest.find(&needle) {
        let after = &rest[i + needle.len()..];
        let end = after.find('"').unwrap_or(after.len());
        let path = &after[..end];
        out.push_str(&rest[..i]);
        out.push_str(marker);
        out.push_str(base);
        out.push_str(prefix);
        out.push_str(path);
        if !version.is_empty() && !path.contains('?') {
            out.push_str("?v=");
            out.push_str(version);
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// Raw HTML inserted verbatim. Only the site owner writes `openblog.json`, so
/// this is the one place where unescaped markup is accepted.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Snippets {
    /// Before `</head>` on every page: analytics tags, fonts, verification metas.
    pub head: String,
    /// After the related posts on every post page: comments (giscus, utterances), a subscribe form.
    pub post_footer: String,
    /// Before `</body>` on every page.
    pub body_end: String,
}

impl Default for HomeConfig {
    fn default() -> Self {
        Self {
            heading: "Latest posts".into(),
            intro: String::new(),
            show_series: true,
        }
    }
}

impl Default for FeedsConfig {
    fn default() -> Self {
        Self {
            rss: true,
            json: true,
            sitemap: true,
            llms: true,
            portfolio_snapshot: true,
            limit: 20,
            full_content: true,
        }
    }
}

impl Default for MarkdownConfig {
    fn default() -> Self {
        Self {
            smart_punctuation: false,
            heading_anchors: true,
            embeds: true,
            toc_depth: 3,
            toc_min_headings: 3,
        }
    }
}

impl Default for PathsConfig {
    fn default() -> Self {
        Self {
            content: "content".into(),
            static_dir: "static".into(),
            output: "dist".into(),
            themes: "themes".into(),
            web: "web".into(),
        }
    }
}

impl SiteConfig {
    /// The Markdown options every published post renders with. `Site::load` and the combined
    /// review preview both use this, so authors review what the site will publish.
    pub fn render_options(&self) -> crate::markdown::RenderOptions<'_> {
        crate::markdown::RenderOptions {
            smart_punctuation: self.markdown.smart_punctuation,
            lazy_images: true,
            heading_anchors: self.markdown.heading_anchors,
            embeds: self.markdown.embeds,
            recipe: false,
            code_runner: (!self.code_runner.endpoint.is_empty()).then_some(
                crate::markdown::CodeRunnerRenderOptions {
                    endpoint: &self.code_runner.endpoint,
                    languages: &self.code_runner.languages,
                },
            ),
            web_libraries: Some(&self.web_sandbox.libraries),
            playground_link: self.code.playground_link,
            citation_notes: None,
            claim_evidence_section: false,
            supplements: false,
            concept_links: false,
        }
    }

    pub fn from_json(json: &str) -> Result<Self, String> {
        let mut config: Self =
            serde_json::from_str(json).map_err(|e| format!("invalid openblog.json: {e}"))?;
        config
            .normalize()
            .map_err(|error| format!("invalid openblog.json: {error}"))?;
        Ok(config)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_default()
    }

    fn normalize(&mut self) -> Result<(), String> {
        while self.url.ends_with('/') {
            self.url.pop();
        }
        if !self.post_path.contains("{slug}") {
            self.post_path = "/posts/{slug}/".to_string();
        }
        if !self.post_path.starts_with('/') {
            self.post_path.insert(0, '/');
        }
        if !self.post_path.ends_with('/') {
            self.post_path.push('/');
        }
        if self.theme.is_empty() {
            self.theme = "base".to_string();
        }
        self.engagement.captcha.provider = self.engagement.captcha.provider.trim().to_lowercase();
        self.engagement.captcha.scope = self.engagement.captcha.scope.trim().to_lowercase();
        self.engagement.captcha.site_key = self.engagement.captcha.site_key.trim().to_string();
        let captcha = &self.engagement.captcha;
        if !matches!(captcha.provider.as_str(), "off" | "turnstile") {
            return Err(format!(
                "engagement.captcha.provider must be \"off\" or \"turnstile\", not \"{}\"",
                captcha.provider
            ));
        }
        if !matches!(captcha.scope.as_str(), "session" | "every-comment") {
            return Err(format!(
                "engagement.captcha.scope must be \"session\" or \"every-comment\", not \"{}\"",
                captcha.scope
            ));
        }
        if captcha.provider == "turnstile" && captcha.site_key.is_empty() {
            return Err("engagement.captcha.siteKey is required when the provider is turnstile (it is the public site key from the Turnstile dashboard)".into());
        }
        if captcha.site_key.len() > 256
            || !captcha
                .site_key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("engagement.captcha.siteKey may only contain letters, numbers, underscore and hyphen (up to 256 characters); never put a secret key here".into());
        }
        if self.engagement.enabled {
            let endpoint = self
                .engagement
                .endpoint
                .parse::<http::Uri>()
                .map_err(|_| "engagement.endpoint must be a valid HTTPS URL")?;
            let authority = endpoint
                .authority()
                .ok_or("engagement.endpoint must include a host")?;
            if endpoint.scheme_str() != Some("https")
                || authority.as_str().contains('@')
                || endpoint.query().is_some()
                || self.engagement.endpoint.contains('#')
            {
                return Err(
                    "engagement.endpoint must be HTTPS without credentials, query, or fragment"
                        .into(),
                );
            }
        }
        self.engagement.feedback_contact = self.engagement.feedback_contact.trim().to_string();
        if !self.engagement.feedback_contact.is_empty()
            && !is_feedback_contact(&self.engagement.feedback_contact)
        {
            return Err("engagement.feedbackContact must be a mailto: address without a query, or an HTTPS URL without credentials".into());
        }
        self.participation.validate()?;
        // B5's opt-in becomes the policy's settings before anything reads
        // them (ADR 0101).
        self.participation.fold_feedback(self.engagement.feedback);
        while self.code_runner.endpoint.ends_with('/') {
            self.code_runner.endpoint.pop();
        }
        if !self.code_runner.endpoint.is_empty() {
            let endpoint = self
                .code_runner
                .endpoint
                .parse::<http::Uri>()
                .map_err(|_| "codeRunner.endpoint must be a valid HTTPS URL")?;
            let authority = endpoint
                .authority()
                .ok_or("codeRunner.endpoint must include a host")?;
            if endpoint.scheme_str() != Some("https")
                || authority.as_str().contains('@')
                || endpoint.query().is_some()
                || self.code_runner.endpoint.contains('#')
            {
                return Err(
                    "codeRunner.endpoint must be HTTPS without credentials, query, or fragment"
                        .into(),
                );
            }
        }
        let mut languages = Vec::new();
        for authored in &self.code_runner.languages {
            let Some(language) = normalize_code_runner_language(authored) else {
                continue;
            };
            if language != "rust" && language != "web" && !languages.contains(&language) {
                languages.push(language);
            }
        }
        self.code_runner.languages = languages;
        for (name, files) in &self.web_sandbox.libraries {
            if name.is_empty()
                || !name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
            {
                return Err(format!(
                    "webSandbox.libraries: `{name}` must use lowercase letters, digits, `-`, or `.`"
                ));
            }
            if files.is_empty()
                || files.iter().any(|file| {
                    !file.starts_with('/')
                        || file.starts_with("//")
                        || file.contains(['"', '<', '>', ' ', '#', '?'])
                })
            {
                return Err(format!(
                    "webSandbox.libraries.{name} must list root-relative files the site serves, like `/vendor/{name}.js`"
                ));
            }
        }
        contributor::normalize_registry(&mut self.contributors)?;
        if !self.business.trade.is_empty() {
            self.business.trade =
                crate::job::normalize_trade(&self.business.trade, &self.extra_trades)
                    .map_err(|error| error.replacen("job.trade", "business.trade", 1))?;
        }
        Ok(())
    }

    /// URL path for a post slug, e.g. `/posts/hello/`.
    pub fn post_url(&self, slug: &str) -> String {
        self.post_path.replace("{slug}", slug)
    }

    /// Absolute URL for a site path.
    pub fn absolute(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            return path.to_string();
        }
        format!(
            "{}{}",
            self.url,
            if path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{path}")
            }
        )
    }

    /// The path part of `url`, for sites hosted under a folder such as
    /// `https://user.github.io/blog`. Empty when the site lives at the root.
    pub fn base_path(&self) -> String {
        let without_scheme = self.url.split("://").nth(1).unwrap_or(&self.url);
        match without_scheme.find('/') {
            Some(i) => {
                let p = without_scheme[i..].trim_matches('/');
                if p.is_empty() {
                    String::new()
                } else {
                    format!("/{p}")
                }
            }
            None => String::new(),
        }
    }

    /// Prefix root-relative URLs in generated HTML, CSS or JSON with the base
    /// path. Protocol-relative (`//`) and absolute URLs are left alone. Every
    /// marker includes a quote, which text escapes, so a title or note that
    /// merely reads like one (`Moved; url=/x`) is never changed; a redirect's
    /// refresh address is matched with its `content="0; ` attribute.
    pub fn apply_base_path(&self, text: &str) -> String {
        let base = self.base_path();
        if base.is_empty() {
            return text.to_string();
        }
        let mut out = text.to_string();
        for marker in [
            "href=\"",
            "src=\"",
            "action=\"",
            "index=\"",
            "wasm=\"",
            "url(\"",
            "content=\"0; url=",
            "\"url\":\"",
        ] {
            out = prefix_root_urls(&out, marker, &base);
        }
        out
    }

    pub fn footer_text(&self, year: i64) -> String {
        self.footer
            .replace("{year}", &year.to_string())
            .replace("{author}", &self.author.name)
    }
}

/// A contact for copied feedback: `mailto:` and one plain address (no query,
/// so a page can add only its own subject and body), or an `https:` page
/// without credentials, at most 500 bytes.
fn is_feedback_contact(value: &str) -> bool {
    if value.len() > 500 || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    if let Some(address) = value.strip_prefix("mailto:") {
        let Some((local, domain)) = address.split_once('@') else {
            return false;
        };
        return !local.is_empty()
            && local
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
            && !domain.is_empty()
            && domain
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
            && !domain.starts_with(['.', '-'])
            && !domain.ends_with(['.', '-']);
    }
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.host_str().is_some_and(|host| !host.is_empty())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appearance_is_validated_with_the_config_and_absent_by_default() {
        let plain = SiteConfig::from_json("{}").unwrap();
        assert!(plain.appearance.is_default());
        assert!(!plain.to_json().contains("appearance"));
        let set =
            SiteConfig::from_json(r##"{"appearance":{"version":1,"accent":"#ABCDEF"}}"##).unwrap();
        assert_eq!(set.appearance.accent.as_deref(), Some("#abcdef"));
        assert!(set.to_json().contains("\"accent\": \"#abcdef\""));
        let bad = SiteConfig::from_json(r##"{"appearance":{"accent":"red;}"}}"##).unwrap_err();
        assert!(
            bad.contains("invalid openblog.json") && bad.contains("accent"),
            "{bad}"
        );
    }

    #[test]
    fn business_is_validated_with_the_config_and_absent_by_default() {
        let plain = SiteConfig::from_json("{}").unwrap();
        assert!(plain.business.is_default());
        assert!(!plain.to_json().contains("business"));
        let set = SiteConfig::from_json(
            r#"{"extraTrades":["fencing"],"business":{"version":1,"displayName":"Acme","phone":"+13605550142","trade":"Fencing","hours":{"sunday":{"closed":true}}}}"#,
        )
        .unwrap();
        assert_eq!(set.business.trade, "fencing");
        let json = set.to_json();
        assert!(json.contains("\"phone\": \"+13605550142\"") && json.contains("\"closed\": true"));
        let bad_phone =
            SiteConfig::from_json(r#"{"business":{"phone":"360-555-0142"}}"#).unwrap_err();
        assert!(
            bad_phone.contains("invalid openblog.json")
                && bad_phone.contains("business: phone must include the country code"),
            "{bad_phone}"
        );
        let bad_hours = SiteConfig::from_json(
            r#"{"business":{"hours":{"monday":{"open":"9","close":"17:00"}}}}"#,
        )
        .unwrap_err();
        assert!(bad_hours.contains("24-hour time like 08:00"), "{bad_hours}");
        let bad_trade = SiteConfig::from_json(r#"{"business":{"trade":"wizardry"}}"#).unwrap_err();
        assert!(bad_trade.contains("business.trade"), "{bad_trade}");
    }

    #[test]
    fn service_areas_are_validated_with_the_config_and_absent_by_default() {
        let plain = SiteConfig::from_json("{}").unwrap();
        assert!(plain.service_areas.is_default());
        assert!(!plain.to_json().contains("serviceAreas"));
        let set = SiteConfig::from_json(
            r#"{"serviceAreas":[{"town":"Bend","region":"Oregon","note":"within 30 miles"}]}"#,
        )
        .unwrap();
        assert_eq!(set.service_areas.areas[0].region, "OR");
        let json = set.to_json();
        assert!(json.contains("\"serviceAreas\"") && json.contains("\"version\": 1"));
        assert_eq!(SiteConfig::from_json(&json).unwrap(), set);
        let duplicate = SiteConfig::from_json(
            r#"{"serviceAreas":[{"town":"Bend","region":"OR"},{"town":"bend","region":"or"}]}"#,
        )
        .unwrap_err();
        assert!(
            duplicate.contains("invalid openblog.json") && duplicate.contains("already listed"),
            "{duplicate}"
        );
    }

    #[test]
    fn base_path_comes_from_the_url_and_prefixes_root_links() {
        let c = SiteConfig::from_json(r#"{"url":"https://user.github.io/blog/"}"#).unwrap();
        assert_eq!(c.base_path(), "/blog");
        assert_eq!(
            c.absolute("/posts/x/"),
            "https://user.github.io/blog/posts/x/"
        );
        let html = r#"<a href="/posts/x/">p</a><link href="/assets/base.css"><img src="//cdn.example/x.png"><a href="https://x.dev/">ext</a><meta content="0; url=/posts/y/"> url("/themes/t/f.woff2") {"url":"/posts/z/"}"#;
        let out = c.apply_base_path(html);
        assert!(out.contains(r#"href="/blog/posts/x/""#));
        assert!(out.contains(r#"href="/blog/assets/base.css""#));
        assert!(
            out.contains(r#"src="//cdn.example/x.png""#),
            "protocol-relative stays"
        );
        assert!(out.contains(r#"href="https://x.dev/""#));
        assert!(out.contains(r#"url=/blog/posts/y/""#));
        assert!(out.contains(r#"url("/blog/themes/t/f.woff2")"#));
        assert!(out.contains(r#"{"url":"/blog/posts/z/"}"#));
        // Text that only reads like a refresh address, in a page or in JSON
        // inside it, is left alone.
        let text =
            r#"<p>Moved; url=/x</p><script type="application/json">{"t":"a; url=/y"}</script>"#;
        assert_eq!(c.apply_base_path(text), text);
        let root = SiteConfig::from_json(r#"{"url":"https://t.dev"}"#).unwrap();
        assert_eq!(root.base_path(), "");
        assert_eq!(root.apply_base_path(html), html);
    }

    #[test]
    fn hosted_engagement_requires_a_public_https_style_endpoint_when_enabled() {
        for endpoint in [
            "http://blog.example/api",
            "https://user:secret@blog.example/api",
            "https://blog.example/api?token=secret",
            "https://blog.example/api#fragment",
        ] {
            let source = serde_json::json!({
                "engagement": { "enabled": true, "endpoint": endpoint }
            });
            assert!(
                SiteConfig::from_json(&source.to_string()).is_err(),
                "{endpoint}"
            );
        }
        assert!(SiteConfig::from_json(
            r#"{"engagement":{"enabled":true,"endpoint":"https://blog.example/api"}}"#
        )
        .is_ok());
    }

    #[test]
    fn a_feedback_contact_is_a_plain_mail_address_or_an_https_page() {
        for contact in [
            "mailto:ada@blog.example",
            " mailto:ada.l+notes@mail.blog-example.org ",
            "https://blog.example/contact/",
        ] {
            let source = serde_json::json!({ "engagement": { "feedbackContact": contact } });
            let config = SiteConfig::from_json(&source.to_string()).unwrap();
            assert_eq!(config.engagement.feedback_contact, contact.trim());
        }
        for contact in [
            "mailto:ada@blog.example?bcc=everyone@example.com",
            "mailto:ada@blog.example&body=x",
            "mailto:<script>@x",
            "mailto:@blog.example",
            "mailto:ada@",
            "http://blog.example/contact/",
            "https://user:secret@blog.example/contact/",
            "javascript:alert(1)",
            "/contact/",
            "https://blog.example/a b",
        ] {
            let source = serde_json::json!({ "engagement": { "feedbackContact": contact } });
            assert!(
                SiteConfig::from_json(&source.to_string()).is_err(),
                "{contact}"
            );
        }
        let long = format!("https://blog.example/{}", "a".repeat(500));
        let source = serde_json::json!({ "engagement": { "feedbackContact": long } });
        assert!(SiteConfig::from_json(&source.to_string()).is_err());
        assert!(SiteConfig::from_json("{}")
            .unwrap()
            .engagement
            .feedback_contact
            .is_empty());
    }

    #[test]
    fn code_runner_requires_a_public_https_endpoint_and_normalizes_languages() {
        for endpoint in [
            "http://runner.example/execute",
            "https://user:secret@runner.example/execute",
            "https://runner.example/execute?token=secret",
            "https://runner.example/execute#secret",
        ] {
            let source =
                format!(r#"{{"codeRunner":{{"endpoint":"{endpoint}","languages":["python"]}}}}"#);
            assert!(
                SiteConfig::from_json(&source).is_err(),
                "accepted {endpoint}"
            );
        }

        let config = SiteConfig::from_json(
            r#"{"codeRunner":{"endpoint":"https://runner.example/execute/","languages":[" Python ","python","go","web","rust","shell script"]}}"#,
        )
        .unwrap();
        assert_eq!(
            config.code_runner.endpoint,
            "https://runner.example/execute"
        );
        assert_eq!(config.code_runner.languages, ["python", "go"]);
    }

    #[test]
    fn web_sandbox_libraries_must_be_named_site_files() {
        let config = SiteConfig::from_json(
            r#"{"webSandbox":{"libraries":{"react":["/vendor/react.min.js","/vendor/react-dom.min.js"]}}}"#,
        )
        .unwrap();
        assert_eq!(config.web_sandbox.libraries["react"].len(), 2);
        for source in [
            r#"{"webSandbox":{"libraries":{"React":["/vendor/react.js"]}}}"#,
            r#"{"webSandbox":{"libraries":{"react":[]}}}"#,
            r#"{"webSandbox":{"libraries":{"react":["https://cdn.example/react.js"]}}}"#,
            r#"{"webSandbox":{"libraries":{"react":["//cdn.example/react.js"]}}}"#,
            r#"{"webSandbox":{"libraries":{"react":["vendor/react.js"]}}}"#,
        ] {
            assert!(SiteConfig::from_json(source).is_err(), "accepted {source}");
        }
    }

    #[test]
    fn code_runner_language_normalizer_owns_the_shared_grammar() {
        let fixtures: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/code-runner-languages.json"
        ))
        .unwrap();
        for fixture in fixtures {
            let authored = fixture["authored"].as_str().unwrap();
            let expected = fixture["normalized"].as_str();
            assert_eq!(
                normalize_code_runner_language(authored).as_deref(),
                expected,
                "{authored:?}"
            );
        }
    }

    #[test]
    fn cdn_rewrites_only_asset_urls() {
        let cdn = CdnConfig {
            url: "https://cdn.example.com/".into(),
            version: "abc".into(),
            ..Default::default()
        };
        let html = r#"<link href="/assets/base.css"><img src="/images/a.png?w=1"><a href="/posts/x/">p</a><a href="/images/">i</a><script src="/themes/t/fx.js"></script>"#;
        let out = cdn.apply(html);
        assert!(out.contains(r#"href="https://cdn.example.com/assets/base.css?v=abc""#));
        assert!(
            out.contains(r#"src="https://cdn.example.com/images/a.png?w=1""#),
            "an existing query is kept as is"
        );
        assert!(
            out.contains(r#"href="/posts/x/""#),
            "page links are untouched"
        );
        assert!(out.contains(r#"src="https://cdn.example.com/themes/t/fx.js?v=abc""#));
        assert_eq!(
            cdn.apply(r#"src: url("/themes/t/fonts/a.woff2")"#),
            r#"src: url("https://cdn.example.com/themes/t/fonts/a.woff2?v=abc")"#
        );
        let off = CdnConfig::default();
        assert_eq!(off.apply(html), html);
        // No CDN but a version: URLs stay on the site and are versioned.
        let versioned = CdnConfig {
            version: "abc".into(),
            ..Default::default()
        };
        let out = versioned.apply(html);
        assert!(out.contains(r#"href="/assets/base.css?v=abc""#));
        assert!(out.contains(r#"src="/themes/t/fx.js?v=abc""#));
        assert!(
            out.contains(r#"href="/posts/x/""#),
            "page links stay unversioned"
        );
        let root_only = CdnConfig {
            url: "https://c.dev".into(),
            paths: vec!["/".into()],
            ..Default::default()
        };
        assert!(
            root_only.prefixes().is_empty(),
            "the root is never an asset prefix"
        );
        assert!(cdn.is_asset_path("/assets/x.js") && !cdn.is_asset_path("/posts/x/"));
    }

    #[test]
    fn defaults_and_normalization() {
        let c =
            SiteConfig::from_json(r#"{"title":"T","url":"https://x.dev/","postPath":"{slug}"}"#)
                .unwrap();
        assert_eq!(c.url, "https://x.dev");
        assert_eq!(c.post_url("a"), "/a/");
        assert_eq!(c.absolute("/rss.xml"), "https://x.dev/rss.xml");
        assert!(c.feeds.rss);
        assert_eq!(c.theme, "base");
        assert!(!c.engagement.enabled);
        assert!(c.engagement.comments && c.engagement.analytics);
        assert_eq!(
            c.knowledge_checks.provider,
            AssistantProviderKind::CustomHttps
        );
        for (name, expected) in [
            ("anthropic", AssistantProviderKind::Anthropic),
            ("open-ai", AssistantProviderKind::OpenAi),
            ("gemini", AssistantProviderKind::Gemini),
            ("xai", AssistantProviderKind::Xai),
            ("deep-seek", AssistantProviderKind::DeepSeek),
            ("mistral", AssistantProviderKind::Mistral),
            ("open-router", AssistantProviderKind::OpenRouter),
        ] {
            let value = format!(r#"{{"knowledgeChecks":{{"provider":"{name}"}}}}"#);
            let parsed = SiteConfig::from_json(&value).unwrap();
            assert_eq!(parsed.knowledge_checks.provider, expected);
            assert_eq!(parsed.knowledge_checks.provider.as_str(), name);
        }
        assert!(
            SiteConfig::from_json(r#"{"knowledgeChecks":{"provider":"unknown-provider"}}"#)
                .is_err()
        );
        let syndication = SiteConfig::from_json(
            r#"{"syndication":{"stateFile":".private/s.json","targets":{"dev":{"provider":"dev","allowPublish":true}}}}"#,
        )
        .unwrap();
        let dev = &syndication.syndication.targets["dev"];
        assert_eq!(dev.provider, SyndicationProvider::Dev);
        assert!(dev.enabled && dev.allow_publish);
        assert_eq!(syndication.syndication.state_file, ".private/s.json");
        assert!(SiteConfig::from_json(
            r#"{"syndication":{"targets":{"future":{"provider":"unknown-provider"}}}}"#
        )
        .is_err());
    }
}

#[cfg(test)]
mod captcha_tests {
    use super::*;
    #[test]
    fn captcha_defaults_and_validation() {
        let base = r#"{"title":"T","url":"https://t.dev"}"#;
        let config = SiteConfig::from_json(base).unwrap();
        assert!(!config.engagement.captcha.enabled());
        assert_eq!(config.engagement.captcha, CaptchaConfig::default());
        assert!(!serde_json::to_string(&config).unwrap().contains("captcha"));
        for (captcha, hint) in [
            (r#"{"provider":"turnstile"}"#, "siteKey is required"),
            (r#"{"provider":"other"}"#, "\"off\" or \"turnstile\""),
            (
                r#"{"provider":"hcaptcha","siteKey":"k"}"#,
                "not \"hcaptcha\"",
            ),
            (r#"{"scope":"always"}"#, "\"session\" or \"every-comment\""),
            (r#"{"siteKey":"<script>"}"#, "never put a secret"),
            (r#"{"enabled":true}"#, "unknown field"),
            (r#"{"secret":"do-not-store"}"#, "unknown field"),
        ] {
            let text = format!(
                r#"{{"title":"T","url":"https://t.dev","engagement":{{"captcha":{captcha}}}}}"#
            );
            let error = SiteConfig::from_json(&text).unwrap_err().to_string();
            assert!(error.contains(hint), "{captcha}: {error}");
            assert!(!error.contains("do-not-store"), "{error}");
        }
        let text = r#"{"title":"T","url":"https://t.dev","engagement":{"captcha":{"provider":" Turnstile ","siteKey":"  public-key  ","scope":"every-comment"}}}"#;
        let config = SiteConfig::from_json(text).unwrap();
        assert!(config.engagement.captcha.enabled());
        assert_eq!(config.engagement.captcha.provider, "turnstile");
        assert_eq!(config.engagement.captcha.site_key, "public-key");
        assert_eq!(config.engagement.captcha.scope, "every-comment");
        let again = SiteConfig::from_json(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!(again.engagement.captcha, config.engagement.captcha);
        let off = SiteConfig::from_json(
            r#"{"title":"T","url":"https://t.dev","engagement":{"captcha":{"provider":"off"}}}"#,
        )
        .unwrap();
        assert!(!off.engagement.captcha.enabled());
    }
}
