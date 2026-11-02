//! The landing page as an ordered list of typed sections (ADR 0245, #322).
//!
//! A site owner arranges the home page from a closed set of sections: a
//! welcome banner, rich text, the latest posts, the series, a featured post
//! and structured pieces (buttons, an image, a video, a map, opening hours,
//! contact details, social links, an FAQ and a call-out). Every section is
//! **data**: validated fields the engine renders and escapes. There is no
//! HTML section type and no field that is read as markup; rich text is
//! Markdown that the landing renderer reads with raw HTML disabled
//! ([`render_inert_markdown`]).
//!
//! The stored file is `<content>/landing.json` (`openblog-landing`, version
//! 1, or 2 for a page that holds a Business facts section: ADR 0306). The
//! format is a one-way door, so it is versioned and conservative:
//!
//! - [`LandingPage::parse`] refuses another version, and a newer one with a
//!   message that says the file was not changed, so a release that does not
//!   understand a file never rewrites it.
//! - Fields this release does not define, on the file or on a section, are
//!   kept as written and written back, so a round trip never loses anything.
//! - A section type this release does not define is refused rather than
//!   guessed at: a new type means a new version.
//! - [`LandingPage::to_canonical_json`] writes the same bytes for the same
//!   page, so an Admin save and a hand edit agree.
//!
//! [`LandingPage::from_legacy`] maps `home.heading`, `home.intro` and
//! `home.showSeries` to the equivalent default layout, and
//! [`LandingPage::legacy_home`] maps it back, so nothing the old settings said
//! is lost. A site with no `landing.json` keeps rendering from those settings
//! exactly as before.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use pulldown_cmark::{CowStr, Event, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config::HomeConfig;

/// Names the stored file.
pub const LANDING_FORMAT: &str = "openblog-landing";
/// The version every page is written as unless it uses a type that needs a newer one.
pub const LANDING_VERSION: u64 = 1;
/// The version a page that holds a Business facts section is written as (ADR 0306). A page
/// without one is still written as version 1, byte for byte as before.
pub const LANDING_VERSION_BUSINESS: u64 = 2;
/// The newest version this release reads.
pub const LANDING_VERSION_MAX: u64 = LANDING_VERSION_BUSINESS;

/// The version a stored page object needs: [`LANDING_VERSION_BUSINESS`] when any section is a
/// Business facts section, otherwise [`LANDING_VERSION`].
pub fn version_for_page(page: &Map<String, Value>) -> u64 {
    let needs_business = page
        .get("sections")
        .and_then(Value::as_array)
        .is_some_and(|sections| {
            sections
                .iter()
                .any(|s| s.get("type").and_then(Value::as_str) == Some("business-facts"))
        });
    if needs_business {
        LANDING_VERSION_BUSINESS
    } else {
        LANDING_VERSION
    }
}
/// The stored file, relative to the content folder.
pub const LANDING_FILE: &str = "landing.json";

/// Most sections on the page.
pub const MAX_SECTIONS: usize = 40;
/// Largest stored file, in bytes.
pub const MAX_FILE_BYTES: usize = 256 * 1024;
/// Longest section id, in bytes.
pub const MAX_ID_BYTES: usize = 64;
/// Longest heading, in characters.
pub const MAX_HEADING_CHARS: usize = 120;
/// Longest subheading, in characters.
pub const MAX_SUBHEADING_CHARS: usize = 300;
/// Longest rich text section, in characters.
pub const MAX_MARKDOWN_CHARS: usize = 20_000;
/// Longest button, link or small label, in characters.
pub const MAX_LABEL_CHARS: usize = 60;
/// Longest address, in bytes.
pub const MAX_URL_BYTES: usize = 2048;
/// Longest image description, in characters.
pub const MAX_ALT_CHARS: usize = 250;
/// Longest caption, note or short line, in characters.
pub const MAX_LINE_CHARS: usize = 200;
/// Most posts one latest-posts section lists.
pub const MAX_LATEST_COUNT: u32 = 50;
/// Most buttons in one buttons section.
pub const MAX_BUTTONS: usize = 6;
/// Most rows in an opening hours section.
pub const MAX_HOURS_ROWS: usize = 14;
/// Most links in a social links section.
pub const MAX_SOCIAL_LINKS: usize = 12;
/// Most questions in an FAQ section.
pub const MAX_FAQ_ITEMS: usize = 30;
/// Longest FAQ answer or call-out body, in characters.
pub const MAX_ANSWER_CHARS: usize = 2000;

/// Where the file holds a value this release does not define.
pub type Extra = BTreeMap<String, Value>;

/// One thing wrong with the page, in words an owner can act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LandingProblem {
    /// The section it is about, when it is about one.
    pub section: Option<String>,
    pub message: String,
}

impl LandingProblem {
    fn page(message: impl Into<String>) -> Self {
        Self {
            section: None,
            message: message.into(),
        }
    }

    fn in_section(id: &str, message: impl Into<String>) -> Self {
        Self {
            section: Some(id.to_string()),
            message: message.into(),
        }
    }
}

impl fmt::Display for LandingProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.section {
            Some(id) => write!(f, "section `{id}`: {}", self.message),
            None => write!(f, "{LANDING_FILE}: {}", self.message),
        }
    }
}

/// The whole landing page.
#[derive(Clone, Debug, PartialEq)]
pub struct LandingPage {
    pub sections: Vec<Section>,
    /// Fields of the file this release does not define, kept as written.
    pub extra: Extra,
}

/// One section: a stable id, a hidden flag and its typed content.
#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub id: String,
    /// A hidden section is kept and never rendered.
    pub hidden: bool,
    pub kind: SectionKind,
    /// Fields of this section this release does not define, kept as written.
    pub extra: Extra,
}

/// The closed set of section types. There is deliberately no HTML variant.
#[derive(Clone, Debug, PartialEq)]
pub enum SectionKind {
    Welcome(Welcome),
    RichText(RichText),
    LatestPosts(LatestPosts),
    Series(SeriesSection),
    FeaturedPost(FeaturedPost),
    Buttons(Buttons),
    Image(ImageSection),
    Video(Video),
    Map(MapSection),
    OpeningHours(OpeningHours),
    Contact(Contact),
    SocialLinks(SocialLinks),
    Faq(Faq),
    Callout(Callout),
    /// The business facts from `openblog.json`, placed on the page (ADR 0306). Needs landing
    /// version 2.
    BusinessFacts(BusinessFacts),
}

impl SectionKind {
    /// The type name as the file writes it.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Welcome(_) => "welcome",
            Self::RichText(_) => "rich-text",
            Self::LatestPosts(_) => "latest-posts",
            Self::Series(_) => "series",
            Self::FeaturedPost(_) => "featured-post",
            Self::Buttons(_) => "buttons",
            Self::Image(_) => "image",
            Self::Video(_) => "video",
            Self::Map(_) => "map",
            Self::OpeningHours(_) => "opening-hours",
            Self::Contact(_) => "contact",
            Self::SocialLinks(_) => "social-links",
            Self::Faq(_) => "faq",
            Self::Callout(_) => "callout",
            Self::BusinessFacts(_) => "business-facts",
        }
    }
}

/// Every type name this release defines.
pub const SECTION_TYPES: [&str; 15] = [
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
];

/// The business facts section: the facts live in `openblog.json`, so the section holds only the
/// heading it is placed under.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusinessFacts {
    pub heading: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Welcome {
    pub heading: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub subheading: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<Picture>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<Button>,
}

/// An image with the description that stands in for it. The description is
/// required: there is no picture without one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Picture {
    pub src: String,
    pub alt: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Button {
    pub label: String,
    pub href: String,
    #[serde(default)]
    pub style: ButtonStyle,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ButtonStyle {
    #[default]
    Primary,
    Secondary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RichText {
    /// Markdown. Read with raw HTML disabled: markup is shown as text.
    #[serde(default)]
    pub markdown: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LatestPosts {
    pub heading: String,
    /// How many posts to list. Absent means the site's posts per page, which
    /// is what the home page lists today.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeriesSection {
    pub heading: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeaturedPost {
    /// The slug of a published post.
    pub post: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub heading: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Buttons {
    pub items: Vec<Button>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageSection {
    pub src: String,
    pub alt: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub caption: String,
}

/// A video by provider and id. Never an address or markup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Video {
    pub provider: VideoProvider,
    /// The provider's own id for the video.
    pub video: String,
    /// What the video is, for the link and for screen readers.
    pub title: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoProvider {
    Youtube,
    Vimeo,
}

impl VideoProvider {
    /// The address of the video on the provider's own site.
    pub fn watch_url(self, id: &str) -> String {
        match self {
            Self::Youtube => format!("https://www.youtube.com/watch?v={id}"),
            Self::Vimeo => format!("https://vimeo.com/{id}"),
        }
    }

    /// The provider as a reader knows it.
    pub fn label(self) -> &'static str {
        match self {
            Self::Youtube => "YouTube",
            Self::Vimeo => "Vimeo",
        }
    }
}

/// A place, by coordinates, shown as a link to the map provider.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapSection {
    pub provider: MapProvider,
    /// The name or address shown beside the map link.
    pub label: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MapProvider {
    Openstreetmap,
}

impl MapSection {
    /// The place on the provider's own site.
    pub fn map_url(&self) -> String {
        match self.provider {
            MapProvider::Openstreetmap => format!(
                "https://www.openstreetmap.org/?mlat={:.6}&mlon={:.6}#map=16/{:.6}/{:.6}",
                self.lat, self.lon, self.lat, self.lon
            ),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpeningHours {
    pub rows: Vec<HoursRow>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HoursRow {
    /// The days, as the owner wants them read: "Monday to Friday".
    pub days: String,
    /// The hours, as the owner wants them read: "9am to 5pm" or "Closed".
    pub hours: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contact {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub email: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub phone: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub address: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SocialLinks {
    pub items: Vec<SocialLink>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SocialLink {
    pub label: String,
    pub href: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Faq {
    pub items: Vec<FaqItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FaqItem {
    pub question: String,
    /// Markdown, read with raw HTML disabled.
    pub answer: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Callout {
    #[serde(default)]
    pub tone: CalloutTone,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    /// Markdown, read with raw HTML disabled.
    pub body: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CalloutTone {
    #[default]
    Info,
    Success,
    Warning,
}

impl CalloutTone {
    pub fn value(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Success => "success",
            Self::Warning => "warning",
        }
    }
}

// ----- parsing ------------------------------------------------------------

fn known_keys(kind: &str) -> &'static [&'static str] {
    match kind {
        "welcome" => &["heading", "subheading", "image", "button"],
        "rich-text" => &["markdown"],
        "latest-posts" => &["heading", "count"],
        "series" | "business-facts" => &["heading"],
        "featured-post" => &["post", "heading"],
        "buttons" | "social-links" | "faq" => &["items"],
        "image" => &["src", "alt", "caption"],
        "video" => &["provider", "video", "title"],
        "map" => &["provider", "label", "lat", "lon"],
        "opening-hours" => &["rows", "note"],
        "contact" => &["email", "phone", "address"],
        "callout" => &["tone", "title", "body"],
        _ => &[],
    }
}

fn from_fields<T: for<'de> Deserialize<'de>>(fields: Map<String, Value>) -> Result<T, String> {
    serde_json::from_value(Value::Object(fields)).map_err(|error| error.to_string())
}

impl Section {
    fn from_value(index: usize, value: Value) -> Result<Self, LandingProblem> {
        let Value::Object(mut object) = value else {
            return Err(LandingProblem::page(format!(
                "section {} must be an object",
                index + 1
            )));
        };
        let id = match object.remove("id") {
            Some(Value::String(id)) => id,
            _ => {
                return Err(LandingProblem::page(format!(
                    "section {} needs an `id` (text)",
                    index + 1
                )))
            }
        };
        let kind_name = match object.remove("type") {
            Some(Value::String(name)) => name,
            _ => return Err(LandingProblem::in_section(&id, "needs a `type` (text)")),
        };
        if !SECTION_TYPES.contains(&kind_name.as_str()) {
            return Err(LandingProblem::in_section(
                &id,
                format!(
                    "the section type `{}` is not one this version of open.blog knows (it knows {})",
                    printable(&kind_name),
                    SECTION_TYPES.join(", ")
                ),
            ));
        }
        let hidden = match object.remove("hidden") {
            None => false,
            Some(Value::Bool(hidden)) => hidden,
            Some(_) => {
                return Err(LandingProblem::in_section(
                    &id,
                    "`hidden` must be true or false",
                ))
            }
        };
        let known = known_keys(&kind_name);
        let mut fields = Map::new();
        let mut extra = Extra::new();
        for (key, value) in object {
            if known.contains(&key.as_str()) {
                fields.insert(key, value);
            } else {
                extra.insert(key, value);
            }
        }
        let wrong = |message: String| {
            LandingProblem::in_section(
                &id,
                format!("is not a valid {kind_name} section: {message}"),
            )
        };
        let kind = match kind_name.as_str() {
            "welcome" => SectionKind::Welcome(from_fields(fields).map_err(wrong)?),
            "rich-text" => SectionKind::RichText(from_fields(fields).map_err(wrong)?),
            "latest-posts" => SectionKind::LatestPosts(from_fields(fields).map_err(wrong)?),
            "series" => SectionKind::Series(from_fields(fields).map_err(wrong)?),
            "featured-post" => SectionKind::FeaturedPost(from_fields(fields).map_err(wrong)?),
            "buttons" => SectionKind::Buttons(from_fields(fields).map_err(wrong)?),
            "image" => SectionKind::Image(from_fields(fields).map_err(wrong)?),
            "video" => SectionKind::Video(from_fields(fields).map_err(wrong)?),
            "map" => SectionKind::Map(from_fields(fields).map_err(wrong)?),
            "opening-hours" => SectionKind::OpeningHours(from_fields(fields).map_err(wrong)?),
            "contact" => SectionKind::Contact(from_fields(fields).map_err(wrong)?),
            "social-links" => SectionKind::SocialLinks(from_fields(fields).map_err(wrong)?),
            "faq" => SectionKind::Faq(from_fields(fields).map_err(wrong)?),
            "business-facts" => SectionKind::BusinessFacts(from_fields(fields).map_err(wrong)?),
            _ => SectionKind::Callout(from_fields(fields).map_err(wrong)?),
        };
        Ok(Self {
            id,
            hidden,
            kind,
            extra,
        })
    }

    fn to_value(&self) -> Value {
        let own = match &self.kind {
            SectionKind::Welcome(v) => serde_json::to_value(v),
            SectionKind::RichText(v) => serde_json::to_value(v),
            SectionKind::LatestPosts(v) => serde_json::to_value(v),
            SectionKind::Series(v) => serde_json::to_value(v),
            SectionKind::FeaturedPost(v) => serde_json::to_value(v),
            SectionKind::Buttons(v) => serde_json::to_value(v),
            SectionKind::Image(v) => serde_json::to_value(v),
            SectionKind::Video(v) => serde_json::to_value(v),
            SectionKind::Map(v) => serde_json::to_value(v),
            SectionKind::OpeningHours(v) => serde_json::to_value(v),
            SectionKind::Contact(v) => serde_json::to_value(v),
            SectionKind::SocialLinks(v) => serde_json::to_value(v),
            SectionKind::Faq(v) => serde_json::to_value(v),
            SectionKind::Callout(v) => serde_json::to_value(v),
            SectionKind::BusinessFacts(v) => serde_json::to_value(v),
        };
        let mut object = Map::new();
        // Unknown fields first so a known field always wins a name clash.
        for (key, value) in &self.extra {
            object.insert(key.clone(), value.clone());
        }
        if let Ok(Value::Object(fields)) = own {
            object.extend(fields);
        }
        object.insert("id".into(), Value::String(self.id.clone()));
        object.insert("type".into(), Value::String(self.kind.name().into()));
        if self.hidden {
            object.insert("hidden".into(), Value::Bool(true));
        }
        Value::Object(object)
    }
}

/// A value from a file, cut short and stripped of anything unprintable before
/// it appears in a message.
fn printable(value: &str) -> String {
    value
        .chars()
        .take(40)
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '?'
            }
        })
        .collect()
}

impl LandingPage {
    /// Reads and checks a stored file. The page is returned only if it is
    /// wholly valid, so nothing invalid is ever rendered or written back.
    pub fn parse(text: &str) -> Result<Self, Vec<LandingProblem>> {
        if text.len() > MAX_FILE_BYTES {
            return Err(vec![LandingProblem::page(format!(
                "is over {MAX_FILE_BYTES} bytes"
            ))]);
        }
        let value: Value = serde_json::from_str(text)
            .map_err(|error| vec![LandingProblem::page(format!("is not valid JSON ({error})"))])?;
        let Value::Object(mut root) = value else {
            return Err(vec![LandingProblem::page("must be a JSON object")]);
        };
        match root.remove("format") {
            Some(Value::String(format)) if format == LANDING_FORMAT => {}
            _ => {
                return Err(vec![LandingProblem::page(format!(
                    "`format` must be \"{LANDING_FORMAT}\""
                ))])
            }
        }
        let version = match root.remove("version").as_ref().and_then(Value::as_u64) {
            Some(version @ LANDING_VERSION..=LANDING_VERSION_MAX) => version,
            Some(newer) if newer > LANDING_VERSION_MAX => {
                return Err(vec![LandingProblem::page(format!(
                    "was written by a newer open.blog (landing page version {newer}); this release reads versions up to {LANDING_VERSION_MAX}. The file has not been changed and will not be overwritten: update open.blog to edit it"
                ))])
            }
            _ => {
                return Err(vec![LandingProblem::page(format!(
                    "`version` must be {LANDING_VERSION} or {LANDING_VERSION_MAX}"
                ))])
            }
        };
        let sections = match root.remove("sections") {
            Some(Value::Array(items)) => items,
            _ => return Err(vec![LandingProblem::page("`sections` must be a list")]),
        };
        if sections.len() > MAX_SECTIONS {
            return Err(vec![LandingProblem::page(format!(
                "has {} sections; a page holds at most {MAX_SECTIONS}",
                sections.len()
            ))]);
        }
        let mut parsed = Vec::new();
        let mut problems = Vec::new();
        for (index, item) in sections.into_iter().enumerate() {
            match Section::from_value(index, item) {
                Ok(section) => {
                    if version < LANDING_VERSION_BUSINESS
                        && matches!(section.kind, SectionKind::BusinessFacts(_))
                    {
                        problems.push(LandingProblem::in_section(
                            &section.id,
                            format!(
                                "the business-facts section needs `version` {LANDING_VERSION_BUSINESS}"
                            ),
                        ));
                    }
                    parsed.push(section)
                }
                Err(problem) => problems.push(problem),
            }
        }
        if !problems.is_empty() {
            return Err(problems);
        }
        let page = Self {
            sections: parsed,
            extra: root.into_iter().collect(),
        };
        let problems = page.validate();
        if problems.is_empty() {
            Ok(page)
        } else {
            Err(problems)
        }
    }

    /// The same page, as bytes: sorted keys, two-space indent, one trailing
    /// newline. The same page always gives the same bytes.
    pub fn to_canonical_json(&self) -> String {
        let mut root = Map::new();
        for (key, value) in &self.extra {
            root.insert(key.clone(), value.clone());
        }
        root.insert("format".into(), Value::String(LANDING_FORMAT.into()));
        root.insert("version".into(), Value::from(self.stored_version()));
        root.insert(
            "sections".into(),
            Value::Array(self.sections.iter().map(Section::to_value).collect()),
        );
        let mut text =
            serde_json::to_string_pretty(&Value::Object(root)).unwrap_or_else(|_| "{}".into());
        text.push('\n');
        text
    }

    /// The stored version this page is written as (ADR 0306).
    pub fn stored_version(&self) -> u64 {
        if self
            .sections
            .iter()
            .any(|s| matches!(s.kind, SectionKind::BusinessFacts(_)))
        {
            LANDING_VERSION_BUSINESS
        } else {
            LANDING_VERSION
        }
    }

    /// Whether any section would be rendered.
    pub fn has_visible_sections(&self) -> bool {
        self.sections.iter().any(|s| !s.hidden)
    }

    /// Every problem with the page, in the order the sections are listed.
    pub fn validate(&self) -> Vec<LandingProblem> {
        let mut problems = Vec::new();
        if self.sections.len() > MAX_SECTIONS {
            problems.push(LandingProblem::page(format!(
                "has {} sections; a page holds at most {MAX_SECTIONS}",
                self.sections.len()
            )));
        }
        let mut seen = BTreeSet::new();
        for section in &self.sections {
            if !valid_id(&section.id) {
                // The bad id is not repeated: it is the one text a request can make arbitrary.
                problems.push(LandingProblem::page(format!(
                    "has a section whose id is not valid (an id is lowercase letters, digits and single hyphens, at most {MAX_ID_BYTES} characters)"
                )));
            } else if !seen.insert(section.id.as_str()) {
                problems.push(LandingProblem::in_section(
                    &section.id,
                    "another section already has this id",
                ));
            }
            validate_section(section, &mut problems);
        }
        problems
    }

    // ----- legacy home settings -------------------------------------------

    /// The default layout the legacy home settings stand for: the intro, the
    /// latest posts under the heading, and the series. Nothing is dropped: an
    /// empty intro or a hidden series stays as a hidden or empty section, so
    /// [`LandingPage::legacy_home`] gives the settings back.
    pub fn from_legacy(home: &HomeConfig) -> Self {
        Self {
            sections: vec![
                Section {
                    id: "intro".into(),
                    hidden: home.intro.trim().is_empty(),
                    kind: SectionKind::RichText(RichText {
                        markdown: home.intro.clone(),
                    }),
                    extra: Extra::new(),
                },
                Section {
                    id: "latest".into(),
                    hidden: false,
                    kind: SectionKind::LatestPosts(LatestPosts {
                        heading: home.heading.clone(),
                        count: None,
                    }),
                    extra: Extra::new(),
                },
                Section {
                    id: "series".into(),
                    hidden: !home.show_series,
                    kind: SectionKind::Series(SeriesSection {
                        heading: "Series".into(),
                    }),
                    extra: Extra::new(),
                },
            ],
            extra: Extra::new(),
        }
    }

    /// The legacy settings a page made by [`LandingPage::from_legacy`] stands
    /// for. `None` for any other layout, which the old settings cannot say.
    pub fn legacy_home(&self) -> Option<HomeConfig> {
        let [intro, latest, series] = self.sections.as_slice() else {
            return None;
        };
        match (&intro.kind, &latest.kind, &series.kind) {
            (
                SectionKind::RichText(intro_text),
                SectionKind::LatestPosts(posts),
                SectionKind::Series(_),
            ) if intro.id == "intro" && latest.id == "latest" && series.id == "series" => {
                Some(HomeConfig {
                    heading: posts.heading.clone(),
                    intro: intro_text.markdown.clone(),
                    show_series: !series.hidden,
                })
            }
            _ => None,
        }
    }
}

/// A section id, and a featured post's slug: lowercase letters, digits and
/// single hyphens.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && !id.starts_with('-')
        && !id.ends_with('-')
        && !id.contains("--")
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

// ----- validation ---------------------------------------------------------

fn chars(value: &str) -> usize {
    value.chars().count()
}

/// A value that is shown as one line of text: bounded, not blank where it is
/// required, and free of control characters.
fn check_line(
    id: &str,
    field: &str,
    value: &str,
    max: usize,
    required: bool,
    problems: &mut Vec<LandingProblem>,
) {
    if required && value.trim().is_empty() {
        problems.push(LandingProblem::in_section(
            id,
            format!("{field} is required"),
        ));
    }
    if chars(value) > max {
        problems.push(LandingProblem::in_section(
            id,
            format!("{field} is {} characters; the most is {max}", chars(value)),
        ));
    }
    if value.chars().any(char::is_control) {
        problems.push(LandingProblem::in_section(
            id,
            format!("{field} must be one line of plain text"),
        ));
    }
}

fn check_markdown(
    id: &str,
    field: &str,
    value: &str,
    max: usize,
    problems: &mut Vec<LandingProblem>,
) {
    if chars(value) > max {
        problems.push(LandingProblem::in_section(
            id,
            format!("{field} is {} characters; the most is {max}", chars(value)),
        ));
    }
    if value.contains('\0') {
        problems.push(LandingProblem::in_section(
            id,
            format!("{field} contains a character that cannot be saved"),
        ));
    }
}

/// Which address schemes a field takes. Relative addresses (starting with
/// `/`, `#`, or a plain path) are always allowed.
#[derive(Clone, Copy)]
enum Schemes {
    /// `https`, `mailto`, `tel` and relative: buttons.
    Links,
    /// `https` and relative: images.
    Pictures,
    /// `https` only: other sites.
    HttpsOnly,
}

fn check_url(value: &str, allow: Schemes) -> Option<String> {
    if value.trim().is_empty() {
        return Some("an address is required".into());
    }
    if value.len() > MAX_URL_BYTES {
        return Some(format!("the address is over {MAX_URL_BYTES} bytes"));
    }
    if value != value.trim() || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Some("the address must not contain spaces or control characters".into());
    }
    if value.contains('\\') {
        return Some("the address must not contain a backslash".into());
    }
    if value.starts_with("//") {
        return Some("start the address with https:// (or a single / for this site)".into());
    }
    if value.starts_with('/') || value.starts_with('#') {
        return if matches!(allow, Schemes::HttpsOnly) {
            Some("this address must start with https://".into())
        } else {
            None
        };
    }
    let scheme_end = value.find([':', '/', '?', '#']);
    let Some(colon) = scheme_end.filter(|&i| value.as_bytes()[i] == b':') else {
        // No scheme: a relative path.
        return if matches!(allow, Schemes::HttpsOnly) {
            Some("this address must start with https://".into())
        } else {
            None
        };
    };
    let scheme = value[..colon].to_ascii_lowercase();
    let rest = &value[colon + 1..];
    match scheme.as_str() {
        "https" => {
            let host = rest.strip_prefix("//").unwrap_or("");
            if host.is_empty() || host.starts_with(['/', '?', '#']) {
                Some("the address needs a site name after https://".into())
            } else {
                None
            }
        }
        "mailto" if matches!(allow, Schemes::Links) => {
            if rest.is_empty() || rest.starts_with('?') {
                Some("the mailto: address needs an email address".into())
            } else {
                None
            }
        }
        "tel" if matches!(allow, Schemes::Links) => {
            if !rest.is_empty()
                && rest
                    .chars()
                    .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | '(' | ')'))
            {
                None
            } else {
                Some("a tel: address holds only a phone number".into())
            }
        }
        "http" => Some("use https:// rather than http://".into()),
        _ => Some(format!(
            "`{}:` addresses are not allowed here",
            printable(&scheme)
        )),
    }
}

fn check_href(
    id: &str,
    field: &str,
    value: &str,
    allow: Schemes,
    problems: &mut Vec<LandingProblem>,
) {
    if let Some(message) = check_url(value, allow) {
        problems.push(LandingProblem::in_section(
            id,
            format!("{field}: {message}"),
        ));
    }
}

fn check_button(id: &str, button: &Button, problems: &mut Vec<LandingProblem>) {
    check_line(
        id,
        "button label",
        &button.label,
        MAX_LABEL_CHARS,
        true,
        problems,
    );
    check_href(id, "button address", &button.href, Schemes::Links, problems);
}

fn check_picture(id: &str, src: &str, alt: &str, problems: &mut Vec<LandingProblem>) {
    check_href(id, "image address", src, Schemes::Pictures, problems);
    check_line(
        id,
        "the image description (alt text)",
        alt,
        MAX_ALT_CHARS,
        true,
        problems,
    );
}

fn check_count(
    id: &str,
    what: &str,
    len: usize,
    max: usize,
    problems: &mut Vec<LandingProblem>,
) -> bool {
    if len == 0 {
        problems.push(LandingProblem::in_section(
            id,
            format!("add at least one {what}"),
        ));
        false
    } else if len > max {
        problems.push(LandingProblem::in_section(
            id,
            format!("has {len} {what}s; the most is {max}"),
        ));
        false
    } else {
        true
    }
}

pub(crate) fn validate_section(section: &Section, problems: &mut Vec<LandingProblem>) {
    let id = section.id.as_str();
    match &section.kind {
        SectionKind::Welcome(v) => {
            check_line(id, "heading", &v.heading, MAX_HEADING_CHARS, true, problems);
            check_line(
                id,
                "subheading",
                &v.subheading,
                MAX_SUBHEADING_CHARS,
                false,
                problems,
            );
            if let Some(image) = &v.image {
                check_picture(id, &image.src, &image.alt, problems);
            }
            if let Some(button) = &v.button {
                check_button(id, button, problems);
            }
        }
        SectionKind::RichText(v) => {
            check_markdown(id, "the text", &v.markdown, MAX_MARKDOWN_CHARS, problems);
        }
        SectionKind::LatestPosts(v) => {
            check_line(id, "heading", &v.heading, MAX_HEADING_CHARS, true, problems);
            if let Some(count) = v.count {
                if count == 0 || count > MAX_LATEST_COUNT {
                    problems.push(LandingProblem::in_section(
                        id,
                        format!("count must be from 1 to {MAX_LATEST_COUNT}"),
                    ));
                }
            }
        }
        SectionKind::Series(v) => {
            check_line(id, "heading", &v.heading, MAX_HEADING_CHARS, true, problems);
        }
        SectionKind::BusinessFacts(v) => {
            check_line(id, "heading", &v.heading, MAX_HEADING_CHARS, true, problems);
        }
        SectionKind::FeaturedPost(v) => {
            if !valid_id(&v.post) {
                problems.push(LandingProblem::in_section(
                    id,
                    "`post` must be the slug of a post (lowercase letters, digits and hyphens)",
                ));
            }
            check_line(
                id,
                "heading",
                &v.heading,
                MAX_HEADING_CHARS,
                false,
                problems,
            );
        }
        SectionKind::Buttons(v) => {
            if check_count(id, "button", v.items.len(), MAX_BUTTONS, problems) {
                for button in &v.items {
                    check_button(id, button, problems);
                }
            }
        }
        SectionKind::Image(v) => {
            check_picture(id, &v.src, &v.alt, problems);
            check_line(id, "caption", &v.caption, MAX_LINE_CHARS, false, problems);
        }
        SectionKind::Video(v) => {
            let ok = match v.provider {
                VideoProvider::Youtube => {
                    v.video.len() == 11
                        && v.video
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                }
                VideoProvider::Vimeo => {
                    (1..=12).contains(&v.video.len()) && v.video.bytes().all(|b| b.is_ascii_digit())
                }
            };
            if !ok {
                problems.push(LandingProblem::in_section(
                    id,
                    format!("the video id is not a {} video id", v.provider.label()),
                ));
            }
            check_line(id, "video title", &v.title, MAX_LINE_CHARS, true, problems);
        }
        SectionKind::Map(v) => {
            check_line(id, "label", &v.label, MAX_LINE_CHARS, true, problems);
            if !(v.lat.is_finite() && (-90.0..=90.0).contains(&v.lat)) {
                problems.push(LandingProblem::in_section(id, "lat must be from -90 to 90"));
            }
            if !(v.lon.is_finite() && (-180.0..=180.0).contains(&v.lon)) {
                problems.push(LandingProblem::in_section(
                    id,
                    "lon must be from -180 to 180",
                ));
            }
        }
        SectionKind::OpeningHours(v) => {
            if check_count(id, "row", v.rows.len(), MAX_HOURS_ROWS, problems) {
                for row in &v.rows {
                    check_line(id, "days", &row.days, MAX_LABEL_CHARS, true, problems);
                    check_line(id, "hours", &row.hours, MAX_LABEL_CHARS, true, problems);
                }
            }
            check_line(id, "note", &v.note, MAX_LINE_CHARS, false, problems);
        }
        SectionKind::Contact(v) => {
            if v.email.is_empty() && v.phone.is_empty() && v.address.is_empty() {
                problems.push(LandingProblem::in_section(
                    id,
                    "add an email, a phone number or an address",
                ));
            }
            if !v.email.is_empty() {
                check_line(id, "email", &v.email, MAX_LINE_CHARS, false, problems);
                let simple = v.email.split_once('@').is_some_and(|(local, domain)| {
                    !local.is_empty()
                        && domain.contains('.')
                        && !domain.starts_with('.')
                        && !domain.ends_with('.')
                        && !v
                            .email
                            .chars()
                            .any(|c| c.is_whitespace() || "<>\"'&,;".contains(c))
                });
                if !simple {
                    problems.push(LandingProblem::in_section(
                        id,
                        "email is not an email address",
                    ));
                }
            }
            if !v.phone.is_empty() {
                check_line(id, "phone", &v.phone, MAX_LABEL_CHARS, false, problems);
                let digits = v.phone.chars().filter(char::is_ascii_digit).count();
                let allowed = v
                    .phone
                    .chars()
                    .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | '(' | ')' | ' '));
                if !allowed || !(3..=20).contains(&digits) {
                    problems.push(LandingProblem::in_section(
                        id,
                        "phone holds only digits, spaces and + - . ( )",
                    ));
                }
            }
            check_line(id, "address", &v.address, MAX_LINE_CHARS, false, problems);
        }
        SectionKind::SocialLinks(v) => {
            if check_count(id, "link", v.items.len(), MAX_SOCIAL_LINKS, problems) {
                for link in &v.items {
                    check_line(
                        id,
                        "link label",
                        &link.label,
                        MAX_LABEL_CHARS,
                        true,
                        problems,
                    );
                    check_href(id, "link address", &link.href, Schemes::HttpsOnly, problems);
                }
            }
        }
        SectionKind::Faq(v) => {
            if check_count(id, "question", v.items.len(), MAX_FAQ_ITEMS, problems) {
                for item in &v.items {
                    check_line(
                        id,
                        "question",
                        &item.question,
                        MAX_LINE_CHARS,
                        true,
                        problems,
                    );
                    if item.answer.trim().is_empty() {
                        problems.push(LandingProblem::in_section(
                            id,
                            "every question needs an answer",
                        ));
                    }
                    check_markdown(id, "an answer", &item.answer, MAX_ANSWER_CHARS, problems);
                }
            }
        }
        SectionKind::Callout(v) => {
            check_line(id, "title", &v.title, MAX_LABEL_CHARS, false, problems);
            if v.body.trim().is_empty() {
                problems.push(LandingProblem::in_section(
                    id,
                    "the call-out needs some text",
                ));
            }
            check_markdown(id, "the text", &v.body, MAX_ANSWER_CHARS, problems);
        }
    }
}

/// Whether `value` is an address the renderer may put in a link or image.
/// The renderer asks again so a page built in code is held to the same rule.
pub fn safe_address(value: &str, pictures: bool) -> bool {
    check_url(
        value,
        if pictures {
            Schemes::Pictures
        } else {
            Schemes::Links
        },
    )
    .is_none()
}

// ----- rich text without raw HTML -----------------------------------------

/// Renders Markdown for a landing section with raw HTML **disabled**: any tag
/// the author typed, block or inline, comes out as escaped text. Links and
/// images keep only `https`, `mailto`, `tel` and relative addresses (anything
/// else shows as its text), headings are all set at `heading_level` so a
/// section never skips a level, and no heading carries an id, class or other
/// attribute from the text. A `heading_level` of 0 sets headings as bold
/// paragraphs instead, for text that sits inside another section.
pub fn render_inert_markdown(markdown: &str, heading_level: u8) -> String {
    use pulldown_cmark::{html, HeadingLevel};

    let level = match heading_level {
        1 => HeadingLevel::H1,
        2 => HeadingLevel::H2,
        3 => HeadingLevel::H3,
        4 => HeadingLevel::H4,
        5 => HeadingLevel::H5,
        _ => HeadingLevel::H6,
    };
    let source = markdown.replace('\0', "\u{FFFD}");
    let mut events: Vec<Event<'_>> = Vec::new();
    // Link and image starts that were dropped, so their ends are too.
    let mut dropped: Vec<bool> = Vec::new();
    for event in pulldown_cmark::Parser::new_ext(
        &source,
        pulldown_cmark::Options::ENABLE_TABLES
            | pulldown_cmark::Options::ENABLE_STRIKETHROUGH
            | pulldown_cmark::Options::ENABLE_TASKLISTS,
    ) {
        match event {
            Event::Html(raw) | Event::InlineHtml(raw) => events.push(Event::Text(raw)),
            Event::Start(Tag::Heading { .. }) if heading_level == 0 => {
                events.push(Event::Start(Tag::Paragraph));
                events.push(Event::Start(Tag::Strong));
            }
            Event::End(TagEnd::Heading(_)) if heading_level == 0 => {
                events.push(Event::End(TagEnd::Strong));
                events.push(Event::End(TagEnd::Paragraph));
            }
            Event::Start(Tag::Heading { .. }) => events.push(Event::Start(Tag::Heading {
                level,
                id: None,
                classes: Vec::new(),
                attrs: Vec::new(),
            })),
            Event::End(TagEnd::Heading(_)) => events.push(Event::End(TagEnd::Heading(level))),
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                if safe_address(&dest_url, false) {
                    dropped.push(false);
                    events.push(Event::Start(Tag::Link {
                        link_type,
                        dest_url,
                        title,
                        id,
                    }));
                } else {
                    dropped.push(true);
                }
            }
            Event::End(TagEnd::Link) => {
                if !dropped.pop().unwrap_or(false) {
                    events.push(Event::End(TagEnd::Link));
                }
            }
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                if safe_address(&dest_url, true) {
                    dropped.push(false);
                    events.push(Event::Start(Tag::Image {
                        link_type,
                        dest_url,
                        title,
                        id,
                    }));
                } else {
                    dropped.push(true);
                }
            }
            Event::End(TagEnd::Image) => {
                if !dropped.pop().unwrap_or(false) {
                    events.push(Event::End(TagEnd::Image));
                }
            }
            Event::FootnoteReference(label) => {
                events.push(Event::Text(CowStr::from(format!("[^{label}]"))));
            }
            other => events.push(other),
        }
    }
    let mut out = String::new();
    html::push_html(&mut out, events.into_iter());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file(sections: Value) -> String {
        let version = if sections.to_string().contains("business-facts") {
            LANDING_VERSION_BUSINESS
        } else {
            LANDING_VERSION
        };
        json!({ "format": LANDING_FORMAT, "version": version, "sections": sections }).to_string()
    }

    fn one(section: Value) -> Result<LandingPage, Vec<LandingProblem>> {
        LandingPage::parse(&file(json!([section])))
    }

    fn message(result: Result<LandingPage, Vec<LandingProblem>>) -> String {
        result
            .expect_err("expected a problem")
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn full() -> Value {
        json!([
            {"id": "hello", "type": "welcome", "heading": "Hi", "subheading": "Welcome",
             "image": {"src": "/me.png", "alt": "Me"}, "button": {"label": "Read", "href": "/posts/", "style": "secondary"}},
            {"id": "about", "type": "rich-text", "markdown": "Some *text*"},
            {"id": "latest", "type": "latest-posts", "heading": "Latest", "count": 5},
            {"id": "series", "type": "series", "heading": "Series", "hidden": true},
            {"id": "pick", "type": "featured-post", "post": "first-post"},
            {"id": "go", "type": "buttons", "items": [{"label": "Mail", "href": "mailto:a@b.co"}, {"label": "Call", "href": "tel:+1-555-0100"}]},
            {"id": "pic", "type": "image", "src": "https://example.com/a.png", "alt": "A cat", "caption": "Cat"},
            {"id": "vid", "type": "video", "provider": "youtube", "video": "dQw4w9WgXcQ", "title": "A video"},
            {"id": "where", "type": "map", "provider": "openstreetmap", "label": "Shop", "lat": 51.5, "lon": -0.12},
            {"id": "hours", "type": "opening-hours", "rows": [{"days": "Mon to Fri", "hours": "9 to 5"}], "note": "Closed holidays"},
            {"id": "contact", "type": "contact", "email": "me@example.com", "phone": "+1 (555) 010-0100", "address": "1 High St"},
            {"id": "social", "type": "social-links", "items": [{"label": "Mastodon", "href": "https://example.social/@me"}]},
            {"id": "faq", "type": "faq", "items": [{"question": "Why?", "answer": "Because."}]},
            {"id": "note", "type": "callout", "tone": "warning", "title": "Heads up", "body": "Careful"},
            {"id": "business", "type": "business-facts", "heading": "Contact and hours"}
        ])
    }

    #[test]
    fn every_section_type_round_trips_without_loss() {
        let page = LandingPage::parse(&file(full())).expect("valid");
        assert_eq!(page.sections.len(), SECTION_TYPES.len());
        let names: Vec<&str> = page.sections.iter().map(|s| s.kind.name()).collect();
        assert_eq!(names, SECTION_TYPES);
        let text = page.to_canonical_json();
        let again = LandingPage::parse(&text).expect("canonical output parses");
        assert_eq!(again, page);
        assert_eq!(again.to_canonical_json(), text, "canonical form is stable");
        assert!(text.ends_with('\n'));
        assert!(!text.contains('\r'));
    }

    #[test]
    fn unknown_future_fields_are_kept_on_the_file_and_on_sections() {
        let text = json!({
            "format": LANDING_FORMAT, "version": 1, "theme-hint": {"a": 1},
            "sections": [{"id": "a", "type": "series", "heading": "S", "futureFlag": [1, 2]}]
        })
        .to_string();
        let page = LandingPage::parse(&text).expect("valid");
        assert_eq!(page.extra["theme-hint"], json!({"a": 1}));
        assert_eq!(page.sections[0].extra["futureFlag"], json!([1, 2]));
        let written: Value = serde_json::from_str(&page.to_canonical_json()).unwrap();
        assert_eq!(written["theme-hint"], json!({"a": 1}));
        assert_eq!(written["sections"][0]["futureFlag"], json!([1, 2]));
    }

    #[test]
    fn a_newer_version_is_refused_with_a_clear_message_and_a_wrong_one_too() {
        let newer = json!({"format": LANDING_FORMAT, "version": 3, "sections": []}).to_string();
        let text = message(LandingPage::parse(&newer));
        assert!(text.contains("newer open.blog"), "{text}");
        assert!(text.contains("will not be overwritten"), "{text}");
        for bad in [json!(0), json!("1"), json!(null)] {
            let text =
                json!({"format": LANDING_FORMAT, "version": bad, "sections": []}).to_string();
            assert!(message(LandingPage::parse(&text)).contains("`version` must be 1 or 2"));
        }
        let no_version = json!({"format": LANDING_FORMAT, "sections": []}).to_string();
        assert!(LandingPage::parse(&no_version).is_err());
        let wrong_format = json!({"format": "other", "version": 1, "sections": []}).to_string();
        assert!(message(LandingPage::parse(&wrong_format)).contains("`format`"));
    }

    #[test]
    fn a_page_is_version_one_until_it_holds_a_business_facts_section() {
        let plain = LandingPage::parse(&file(
            json!([{"id": "a", "type": "series", "heading": "S"}]),
        ))
        .unwrap();
        assert_eq!(plain.stored_version(), 1);
        assert!(plain.to_canonical_json().contains("\"version\": 1"));
        let business = json!([{"id": "b", "type": "business-facts", "heading": "Find us"}]);
        let page = LandingPage::parse(&file(business.clone())).unwrap();
        assert_eq!(page.stored_version(), 2);
        assert!(page.to_canonical_json().contains("\"version\": 2"));
        // A version 1 file cannot hold the new type: an older release would have refused it.
        let old = json!({"format": LANDING_FORMAT, "version": 1, "sections": business}).to_string();
        assert!(message(LandingPage::parse(&old)).contains("needs `version` 2"));
        let heading_missing = file(json!([{"id": "b", "type": "business-facts", "heading": ""}]));
        assert!(LandingPage::parse(&heading_missing).is_err());
    }

    #[test]
    fn there_is_no_html_section_and_an_unknown_type_is_refused() {
        for kind in ["html", "raw", "script", "embed", "iframe", "custom-html"] {
            let text = message(one(json!({"id": "x", "type": kind, "markup": "<b>x</b>"})));
            assert!(text.contains("not one this version"), "{kind}: {text}");
        }
        assert!(!SECTION_TYPES.iter().any(|t| t.contains("html")));
    }

    #[test]
    fn bounds_are_enforced_with_actionable_errors() {
        let many: Vec<Value> = (0..=MAX_SECTIONS)
            .map(|i| json!({"id": format!("s{i}"), "type": "series", "heading": "S"}))
            .collect();
        let text = message(LandingPage::parse(&file(Value::Array(many))));
        assert!(text.contains("at most 40"), "{text}");

        let long = "x".repeat(MAX_MARKDOWN_CHARS + 1);
        let text = message(one(
            json!({"id": "a", "type": "rich-text", "markdown": long}),
        ));
        assert!(text.contains("the most is 20000"), "{text}");
        assert!(text.contains("section `a`"), "{text}");

        let text = message(one(
            json!({"id": "a", "type": "series", "heading": "x".repeat(121)}),
        ));
        assert!(text.contains("heading is 121 characters"), "{text}");

        let text = message(one(
            json!({"id": "a", "type": "latest-posts", "heading": "L", "count": 0}),
        ));
        assert!(text.contains("from 1 to 50"), "{text}");
        let text = message(one(
            json!({"id": "a", "type": "latest-posts", "heading": "L", "count": 51}),
        ));
        assert!(text.contains("from 1 to 50"), "{text}");

        let items: Vec<Value> = (0..=MAX_BUTTONS)
            .map(|_| json!({"label": "L", "href": "/"}))
            .collect();
        let text = message(one(json!({"id": "a", "type": "buttons", "items": items})));
        assert!(text.contains("the most is 6"), "{text}");
        let text = message(one(json!({"id": "a", "type": "buttons", "items": []})));
        assert!(text.contains("add at least one"), "{text}");

        let huge = format!("{{\"pad\":\"{}\"}}", "x".repeat(MAX_FILE_BYTES));
        assert!(message(LandingPage::parse(&huge)).contains("is over"));
    }

    #[test]
    fn ids_must_be_well_formed_and_unique() {
        let dup = file(json!([
            {"id": "a", "type": "series", "heading": "S"},
            {"id": "a", "type": "series", "heading": "T"}
        ]));
        assert!(message(LandingPage::parse(&dup)).contains("already has this id"));
        for bad in ["", "A", "a b", "-a", "a--b", "a/b", "<b>", &"a".repeat(65)] {
            let text = message(one(json!({"id": bad, "type": "series", "heading": "S"})));
            assert!(text.contains("an id is lowercase"), "{bad:?}: {text}");
            assert!(
                !text.contains('<'),
                "an id is never echoed as markup: {text}"
            );
        }
    }

    #[test]
    fn address_schemes_are_https_mailto_tel_and_relative_only() {
        for good in [
            "https://example.com",
            "https://example.com/a?b=1#c",
            "mailto:me@example.com",
            "tel:+1-555-0100",
            "/posts/",
            "#top",
            "about/",
            "../a",
            "HTTPS://example.com",
        ] {
            assert!(check_url(good, Schemes::Links).is_none(), "{good}");
        }
        for bad in [
            "http://example.com",
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            "data:text/html,x",
            "vbscript:x",
            "file:///etc/passwd",
            "ftp://x",
            "//evil.example",
            "https://",
            "https:///x",
            "https:example.com",
            "java\tscript:alert(1)",
            " https://a.co",
            "https://a .co",
            "https://a.co\n",
            "\\\\host\\share",
            "blob:https://x",
            "tel:abc",
            "mailto:",
            "",
        ] {
            assert!(
                check_url(bad, Schemes::Links).is_some(),
                "{bad:?} must be refused"
            );
        }
        assert!(check_url("mailto:me@example.com", Schemes::Pictures).is_some());
        assert!(check_url("tel:1", Schemes::Pictures).is_some());
        assert!(check_url("/a.png", Schemes::Pictures).is_none());
        assert!(check_url("/a", Schemes::HttpsOnly).is_some());
        assert!(check_url("https://a.co", Schemes::HttpsOnly).is_none());
        assert!(check_url(
            &format!("https://a.co/{}", "x".repeat(MAX_URL_BYTES)),
            Schemes::Links
        )
        .is_some());
    }

    #[test]
    fn urls_are_checked_in_every_section_that_takes_one() {
        let bad = "javascript:alert(1)";
        for section in [
            json!({"id": "a", "type": "welcome", "heading": "H", "button": {"label": "L", "href": bad}}),
            json!({"id": "a", "type": "welcome", "heading": "H", "image": {"src": bad, "alt": "x"}}),
            json!({"id": "a", "type": "buttons", "items": [{"label": "L", "href": bad}]}),
            json!({"id": "a", "type": "image", "src": bad, "alt": "x"}),
            json!({"id": "a", "type": "social-links", "items": [{"label": "L", "href": bad}]}),
        ] {
            let text = message(one(section));
            assert!(text.contains("not allowed"), "{text}");
            assert!(
                !text.contains("alert(1)"),
                "a bad address is never repeated verbatim: {text}"
            );
        }
    }

    #[test]
    fn alt_text_is_required_on_every_image() {
        for alt in [json!(""), json!("   ")] {
            let text = message(one(
                json!({"id": "a", "type": "image", "src": "/a.png", "alt": alt}),
            ));
            assert!(text.contains("alt text"), "{text}");
            let text = message(one(
                json!({"id": "a", "type": "welcome", "heading": "H", "image": {"src": "/a.png", "alt": alt}}),
            ));
            assert!(text.contains("alt text"), "{text}");
        }
        let text = message(one(json!({"id": "a", "type": "image", "src": "/a.png"})));
        assert!(text.contains("alt"), "{text}");
    }

    #[test]
    fn video_and_map_providers_are_allowlisted() {
        for provider in ["dailymotion", "evil", "", "YouTube"] {
            let text = message(one(
                json!({"id": "a", "type": "video", "provider": provider, "video": "dQw4w9WgXcQ", "title": "T"}),
            ));
            assert!(
                text.contains("not a valid video section"),
                "{provider}: {text}"
            );
        }
        for id in ["short", "dQw4w9WgXc!", "dQw4w9WgXcQQ", "\"><script>"] {
            let text = message(one(
                json!({"id": "a", "type": "video", "provider": "youtube", "video": id, "title": "T"}),
            ));
            assert!(text.contains("not a YouTube video id"), "{id}: {text}");
        }
        assert!(one(
            json!({"id": "a", "type": "video", "provider": "vimeo", "video": "12345", "title": "T"})
        )
        .is_ok());
        assert!(message(one(
            json!({"id": "a", "type": "video", "provider": "vimeo", "video": "abc", "title": "T"})
        ))
        .contains("Vimeo video id"));
        let text = message(one(
            json!({"id": "a", "type": "map", "provider": "google", "label": "L", "lat": 1, "lon": 1}),
        ));
        assert!(text.contains("not a valid map section"), "{text}");
        let text = message(one(
            json!({"id": "a", "type": "map", "provider": "openstreetmap", "label": "L", "lat": 91, "lon": 181}),
        ));
        assert!(
            text.contains("lat must") && text.contains("lon must"),
            "{text}"
        );
    }

    #[test]
    fn contact_social_faq_and_callout_are_checked() {
        assert!(message(one(json!({"id": "a", "type": "contact"}))).contains("add an email"));
        assert!(message(one(
            json!({"id": "a", "type": "contact", "email": "not an email"})
        ))
        .contains("email"));
        assert!(message(one(
            json!({"id": "a", "type": "contact", "email": "a@b.co", "phone": "call me"})
        ))
        .contains("phone"));
        assert!(message(one(
            json!({"id": "a", "type": "social-links", "items": [{"label": "L", "href": "/me"}]})
        ))
        .contains("https://"));
        assert!(message(one(
            json!({"id": "a", "type": "faq", "items": [{"question": "Q", "answer": " "}]})
        ))
        .contains("needs an answer"));
        assert!(
            message(one(json!({"id": "a", "type": "callout", "body": ""})))
                .contains("needs some text")
        );
        assert!(message(one(
            json!({"id": "a", "type": "callout", "tone": "danger", "body": "x"})
        ))
        .contains("callout"));
        assert!(
            message(one(json!({"id": "a", "type": "series", "heading": "a\nb"})))
                .contains("one line")
        );
        assert!(
            message(one(json!({"id": "a", "type": "series", "heading": " "}))).contains("required")
        );
    }

    #[test]
    fn a_wrongly_typed_field_is_a_problem_not_a_panic() {
        for section in [
            json!({"id": "a", "type": "series", "heading": 5}),
            json!({"id": "a", "type": "series"}),
            json!({"id": "a", "type": "series", "heading": "S", "hidden": "yes"}),
            json!({"type": "series", "heading": "S"}),
            json!({"id": "a", "heading": "S"}),
            json!("a section"),
        ] {
            assert!(one(section).is_err());
        }
        assert!(LandingPage::parse("not json").is_err());
        assert!(LandingPage::parse("[]").is_err());
        assert!(LandingPage::parse("{\"format\":\"openblog-landing\",\"version\":1}").is_err());
    }

    #[test]
    fn legacy_home_settings_map_to_an_equivalent_layout_and_back() {
        for (heading, intro, show_series) in [
            ("Latest", "Hello *there*", true),
            ("Posts", "", false),
            ("Latest", "  \n", true),
            ("Weekly notes", "# A\n\nWelcome", false),
        ] {
            let home = HomeConfig {
                heading: heading.into(),
                intro: intro.into(),
                show_series,
            };
            let page = LandingPage::from_legacy(&home);
            assert!(page.validate().is_empty());
            assert_eq!(page.sections.len(), 3);
            assert_eq!(page.sections[0].hidden, intro.trim().is_empty());
            assert_eq!(page.sections[2].hidden, !show_series);
            assert_eq!(page.legacy_home(), Some(home), "lossless");
            let again = LandingPage::parse(&page.to_canonical_json()).expect("stored form parses");
            assert_eq!(
                again.legacy_home().map(|h| h.heading),
                Some(heading.to_string())
            );
        }
        let mut other = LandingPage::from_legacy(&HomeConfig::default());
        other.sections.pop();
        assert_eq!(other.legacy_home(), None);
    }

    #[test]
    fn inert_markdown_shows_markup_as_text() {
        let html = render_inert_markdown(
            "<script>alert(1)</script>\n\nA <b>bold</b> <img src=x onerror=alert(1)> and <iframe src=//e></iframe>\n\n<div onclick=\"x\">y</div>",
            3,
        );
        for tag in [
            "<script",
            "<b>",
            "<img",
            "<iframe",
            "<div",
            "onerror=alert(1)>",
        ] {
            assert!(!html.contains(tag), "{tag} must not survive: {html}");
        }
        assert!(html.contains("&lt;script&gt;"), "{html}");
        assert!(html.contains("&lt;iframe"), "{html}");
    }

    #[test]
    fn inert_markdown_drops_unsafe_link_and_image_addresses_but_keeps_the_words() {
        let html = render_inert_markdown(
            "[click](javascript:alert(1)) [ok](https://example.com) ![pic](data:image/svg+xml,x) ![fine](/a.png) [m](mailto:a@b.co) [r](/x) <https://auto.example>",
            2,
        );
        assert!(!html.contains("javascript:"), "{html}");
        assert!(!html.contains("data:"), "{html}");
        assert!(html.contains("click"));
        assert!(html.contains("href=\"https://example.com\""));
        assert!(html.contains("src=\"/a.png\""));
        assert!(html.contains("href=\"mailto:a@b.co\""));
        assert!(html.contains("href=\"/x\""));
        assert!(html.contains("href=\"https://auto.example\""));
    }

    #[test]
    fn inert_markdown_sets_every_heading_at_one_level_without_attributes() {
        let html =
            render_inert_markdown("# One {#evil .cls onclick=x}\n\n#### Four\n\n###### Six", 3);
        assert_eq!(html.matches("<h3>").count(), 3, "{html}");
        for other in ["<h1", "<h2", "<h4", "<h5", "<h6", "<h3 ", "id=", "class="] {
            assert!(!html.contains(other), "{other}: {html}");
        }
    }

    #[test]
    fn inert_markdown_handles_footnotes_and_nul_without_markup() {
        let html = render_inert_markdown("text[^1]\u{0}\n\n[^1]: note", 3);
        assert!(!html.contains("<sup"), "{html}");
        assert!(!html.contains('\0'));
    }
}
