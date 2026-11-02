//! The piece library: small structured things an author adds to a post or to
//! the landing page with a form (ADR 0253, #331).
//!
//! A piece is validated data, never markup. The same nine pieces serve both
//! places and share one form schema ([`schema`], [`schema_json`]) and one set
//! of renderers (`render::piece`):
//!
//! - **Button, Image with caption, Video, Map, Opening hours, Contact, Social
//!   links, FAQ and Call-out.**
//! - On the landing page a piece is a section ([`Piece::section_kind`]); its
//!   fields are exactly the section's fields.
//! - In a post a piece is **Markdown**. A call-out is the existing
//!   `> [!NOTE]` call-out. Every other piece is a fenced directive:
//!
//!   ````text
//!   ```piece hours
//!   note: Closed on public holidays.
//!   days: Monday to Friday
//!   hours: 9am to 5pm
//!   ```
//!   ````
//!
//!   One `field: value` per line; a value continues on following lines that
//!   start with two spaces; a list piece repeats its first list field to start
//!   each item. Anything else that reads this Markdown (GitHub, another
//!   engine) shows an ordinary code block, so the source is never lost and
//!   never broken.
//!
//! Values go through the landing validators, so a hostile or malformed value
//! is refused with a message, and the renderers escape whatever is left.

use serde_json::{json, Value};

use crate::landing::{
    self, Button, ButtonStyle, Callout, CalloutTone, Contact, Faq, FaqItem, HoursRow, ImageSection,
    MapProvider, MapSection, OpeningHours, Section, SectionKind, SocialLink, SocialLinks, Video,
    VideoProvider,
};

/// The kinds, in the order a menu lists them.
pub const KINDS: &[&str] = &[
    "button", "image", "video", "map", "hours", "contact", "social", "faq", "callout",
];

/// How a field is asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    Text,
    Textarea,
    Url,
    Email,
    Phone,
    Number,
    Choice(&'static [(&'static str, &'static str)]),
}

impl Input {
    fn name(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Textarea => "textarea",
            Self::Url => "url",
            Self::Email => "email",
            Self::Phone => "tel",
            Self::Number => "number",
            Self::Choice(_) => "choice",
        }
    }
}

/// One field of a form: what it is called, what helps, and its limits.
#[derive(Clone, Copy, Debug)]
pub struct Field {
    pub name: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    pub input: Input,
    pub required: bool,
    /// Most characters; 0 for a choice.
    pub max: usize,
}

/// A repeated group of fields (opening-hours rows, links, questions).
#[derive(Clone, Copy, Debug)]
pub struct List {
    pub item: &'static str,
    pub label: &'static str,
    pub min: usize,
    pub max: usize,
    pub fields: &'static [Field],
}

/// The form for one kind of piece.
#[derive(Clone, Copy, Debug)]
pub struct Schema {
    pub kind: &'static str,
    /// The landing section type that holds this piece.
    pub section: &'static str,
    /// Plain-words name for a menu.
    pub label: &'static str,
    /// One plain sentence for a menu.
    pub summary: &'static str,
    pub fields: &'static [Field],
    pub list: Option<List>,
}

const fn field(
    name: &'static str,
    label: &'static str,
    hint: &'static str,
    input: Input,
    required: bool,
    max: usize,
) -> Field {
    Field {
        name,
        label,
        hint,
        input,
        required,
        max,
    }
}

const STYLES: Input = Input::Choice(&[("primary", "Filled"), ("secondary", "Outlined")]);
const VIDEO_PROVIDERS: Input = Input::Choice(&[("youtube", "YouTube"), ("vimeo", "Vimeo")]);
const MAP_PROVIDERS: Input = Input::Choice(&[("openstreetmap", "OpenStreetMap")]);
const TONES: Input = Input::Choice(&[("info", "Note"), ("success", "Tip"), ("warning", "Warning")]);

static SCHEMAS: &[Schema] = &[
    Schema {
        kind: "button",
        section: "buttons",
        label: "Button",
        summary: "A button that goes to a page, an email address or a phone number.",
        fields: &[
            field(
                "label",
                "Button text",
                "What the button says.",
                Input::Text,
                true,
                landing::MAX_LABEL_CHARS,
            ),
            field(
                "href",
                "Where it goes",
                "An https:// address, a page on this site such as /about/, mailto: or tel:.",
                Input::Text,
                true,
                landing::MAX_URL_BYTES,
            ),
            field("style", "Look", "", STYLES, false, 0),
        ],
        list: None,
    },
    Schema {
        kind: "image",
        section: "image",
        label: "Image with caption",
        summary: "A picture with a description for people who cannot see it.",
        fields: &[
            field(
                "src",
                "Image address",
                "An https:// address or a file on this site such as /images/shop.jpg.",
                Input::Text,
                true,
                landing::MAX_URL_BYTES,
            ),
            field(
                "alt",
                "Description",
                "Describe the picture for someone who cannot see it. Required.",
                Input::Text,
                true,
                landing::MAX_ALT_CHARS,
            ),
            field(
                "caption",
                "Caption",
                "Optional text under the picture.",
                Input::Text,
                false,
                landing::MAX_LINE_CHARS,
            ),
        ],
        list: None,
    },
    Schema {
        kind: "video",
        section: "video",
        label: "Video",
        summary: "A YouTube or Vimeo video, loaded only when the page is read.",
        fields: &[
            field("provider", "Where it is", "", VIDEO_PROVIDERS, true, 0),
            field(
                "video",
                "Video",
                "Paste the video's address or its code.",
                Input::Text,
                true,
                landing::MAX_URL_BYTES,
            ),
            field(
                "title",
                "Title",
                "What the video is. Screen readers announce it.",
                Input::Text,
                true,
                landing::MAX_LINE_CHARS,
            ),
        ],
        list: None,
    },
    Schema {
        kind: "map",
        section: "map",
        label: "Map",
        summary: "A map of one place.",
        fields: &[
            field("provider", "Map from", "", MAP_PROVIDERS, true, 0),
            field(
                "label",
                "Place",
                "A name or address shown beside the map.",
                Input::Text,
                true,
                landing::MAX_LINE_CHARS,
            ),
            field(
                "lat",
                "Latitude",
                "A number from -90 to 90, such as 51.5007.",
                Input::Number,
                true,
                12,
            ),
            field(
                "lon",
                "Longitude",
                "A number from -180 to 180, such as -0.1246.",
                Input::Number,
                true,
                12,
            ),
        ],
        list: None,
    },
    Schema {
        kind: "hours",
        section: "opening-hours",
        label: "Opening hours",
        summary: "Days and the hours you are open.",
        fields: &[field(
            "note",
            "Note",
            "Optional, such as \"Closed on public holidays\".",
            Input::Text,
            false,
            landing::MAX_LINE_CHARS,
        )],
        list: Some(List {
            item: "row",
            label: "Opening times",
            min: 1,
            max: landing::MAX_HOURS_ROWS,
            fields: &[
                field(
                    "days",
                    "Days",
                    "Such as Monday to Friday.",
                    Input::Text,
                    true,
                    landing::MAX_LABEL_CHARS,
                ),
                field(
                    "hours",
                    "Hours",
                    "Such as 9am to 5pm, or Closed.",
                    Input::Text,
                    true,
                    landing::MAX_LABEL_CHARS,
                ),
            ],
        }),
    },
    Schema {
        kind: "contact",
        section: "contact",
        label: "Contact details",
        summary: "An email address, a phone number and an address.",
        fields: &[
            field(
                "email",
                "Email",
                "",
                Input::Email,
                false,
                landing::MAX_LINE_CHARS,
            ),
            field(
                "phone",
                "Phone",
                "Digits, spaces and + - . ( ) only.",
                Input::Phone,
                false,
                landing::MAX_LABEL_CHARS,
            ),
            field(
                "address",
                "Address",
                "Shown as written.",
                Input::Text,
                false,
                landing::MAX_LINE_CHARS,
            ),
        ],
        list: None,
    },
    Schema {
        kind: "social",
        section: "social-links",
        label: "Social links",
        summary: "Links to your profiles elsewhere.",
        fields: &[],
        list: Some(List {
            item: "link",
            label: "Links",
            min: 1,
            max: landing::MAX_SOCIAL_LINKS,
            fields: &[
                field(
                    "label",
                    "Name",
                    "Such as Mastodon.",
                    Input::Text,
                    true,
                    landing::MAX_LABEL_CHARS,
                ),
                field(
                    "href",
                    "Address",
                    "Starts with https://.",
                    Input::Url,
                    true,
                    landing::MAX_URL_BYTES,
                ),
            ],
        }),
    },
    Schema {
        kind: "faq",
        section: "faq",
        label: "Questions and answers",
        summary: "Questions that open to show their answers.",
        fields: &[],
        list: Some(List {
            item: "question",
            label: "Questions",
            min: 1,
            max: landing::MAX_FAQ_ITEMS,
            fields: &[
                field(
                    "question",
                    "Question",
                    "",
                    Input::Text,
                    true,
                    landing::MAX_LINE_CHARS,
                ),
                field(
                    "answer",
                    "Answer",
                    "Plain text or Markdown. HTML tags are not allowed.",
                    Input::Textarea,
                    true,
                    landing::MAX_ANSWER_CHARS,
                ),
            ],
        }),
    },
    Schema {
        kind: "callout",
        section: "callout",
        label: "Call-out",
        summary: "A highlighted note, tip or warning.",
        fields: &[
            field("tone", "Kind", "", TONES, false, 0),
            field(
                "title",
                "Heading",
                "Optional.",
                Input::Text,
                false,
                landing::MAX_LABEL_CHARS,
            ),
            field(
                "body",
                "Text",
                "Plain text or Markdown. HTML tags are not allowed.",
                Input::Textarea,
                true,
                landing::MAX_ANSWER_CHARS,
            ),
        ],
        list: None,
    },
];

/// The form for `kind`, if there is one.
pub fn schema(kind: &str) -> Option<&'static Schema> {
    SCHEMAS.iter().find(|s| s.kind == kind)
}

/// Every form, in menu order.
pub fn schemas() -> impl Iterator<Item = &'static Schema> {
    KINDS.iter().filter_map(|k| schema(k))
}

fn field_json(f: &Field) -> Value {
    let mut v = json!({
        "name": f.name, "label": f.label, "hint": f.hint,
        "input": f.input.name(), "required": f.required, "max": f.max,
    });
    if let Input::Choice(options) = f.input {
        v["options"] = options
            .iter()
            .map(|(value, label)| json!({ "value": value, "label": label }))
            .collect();
    }
    v
}

/// The forms as JSON, for the Admin: one schema for the post editor and the
/// landing page workspace.
pub fn schema_json() -> Value {
    schemas()
        .map(|s| {
            let mut v = json!({
                "kind": s.kind, "section": s.section, "label": s.label,
                "summary": s.summary,
                "fields": s.fields.iter().map(field_json).collect::<Vec<_>>(),
                // A call-out in a post is the `> [!NOTE]` call-out, not a fence.
                "markdown": if s.kind == "callout" { "callout" } else { "directive" },
            });
            if let Some(list) = &s.list {
                v["list"] = json!({
                    "item": list.item, "label": list.label, "min": list.min, "max": list.max,
                    "fields": list.fields.iter().map(field_json).collect::<Vec<_>>(),
                });
            }
            v
        })
        .collect()
}

/// Ordered `(field, value)` pairs, as a form or a directive holds them.
pub type Values = Vec<(String, String)>;

/// A validated piece.
#[derive(Clone, Debug, PartialEq)]
pub enum Piece {
    Button(Button),
    Image(ImageSection),
    Video(Video),
    Map(MapSection),
    Hours(OpeningHours),
    Contact(Contact),
    Social(SocialLinks),
    Faq(Faq),
    Callout(Callout),
}

impl Piece {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Button(_) => "button",
            Self::Image(_) => "image",
            Self::Video(_) => "video",
            Self::Map(_) => "map",
            Self::Hours(_) => "hours",
            Self::Contact(_) => "contact",
            Self::Social(_) => "social",
            Self::Faq(_) => "faq",
            Self::Callout(_) => "callout",
        }
    }

    /// The landing section content that holds this piece.
    pub fn section_kind(&self) -> SectionKind {
        match self.clone() {
            Self::Button(v) => SectionKind::Buttons(landing::Buttons { items: vec![v] }),
            Self::Image(v) => SectionKind::Image(v),
            Self::Video(v) => SectionKind::Video(v),
            Self::Map(v) => SectionKind::Map(v),
            Self::Hours(v) => SectionKind::OpeningHours(v),
            Self::Contact(v) => SectionKind::Contact(v),
            Self::Social(v) => SectionKind::SocialLinks(v),
            Self::Faq(v) => SectionKind::Faq(v),
            Self::Callout(v) => SectionKind::Callout(v),
        }
    }

    /// What is wrong with the piece, in words an author can act on. Empty
    /// when it can be saved and rendered.
    pub fn problems(&self) -> Vec<String> {
        let section = Section {
            id: "piece".into(),
            hidden: false,
            kind: self.section_kind(),
            extra: Default::default(),
        };
        let mut problems = Vec::new();
        landing::validate_section(&section, &mut problems);
        problems.into_iter().map(|p| p.message).collect()
    }

    /// Build a piece from form values and validate it. Every problem is
    /// reported, not just the first.
    pub fn from_values(kind: &str, values: &[(String, String)]) -> Result<Self, Vec<String>> {
        let Some(spec) = schema(kind) else {
            return Err(vec![format!("`{kind}` is not a piece this release knows")]);
        };
        let mut problems = Vec::new();
        let list_fields: &[Field] = spec.list.as_ref().map_or(&[], |l| l.fields);
        for (name, _) in values {
            let known = spec
                .fields
                .iter()
                .chain(list_fields)
                .any(|f| f.name == name);
            if !known {
                problems.push(format!("`{name}` is not a field of this piece"));
            }
        }
        // A call-out is written into the post as plain Markdown, which the post renderer lets
        // raw HTML through; every other piece is a fence the renderer shows as escaped text.
        for (name, value) in values.iter().filter(|_| kind == "callout") {
            if has_html_tag(value) {
                problems.push(format!("`{name}`: HTML tags are not allowed"));
            }
        }
        for f in spec.fields {
            if values.iter().filter(|(n, _)| n == f.name).count() > 1 {
                problems.push(format!("`{}` is given more than once", f.name));
            }
        }
        let top = |name: &str| -> Option<&str> {
            if spec.fields.iter().all(|f| f.name != name) {
                return None;
            }
            values
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.trim())
        };
        // List items: a new item starts at each repeat of the first list field.
        let mut items: Vec<Vec<(&str, String)>> = Vec::new();
        if let Some(first) = list_fields.first() {
            for (name, value) in values {
                if !list_fields.iter().any(|f| f.name == name) {
                    continue;
                }
                if name == first.name || items.is_empty() {
                    items.push(Vec::new());
                }
                if let Some(item) = items.last_mut() {
                    if item.iter().any(|(n, _)| *n == name.as_str()) {
                        problems.push(format!("`{name}` is given twice in one item"));
                    }
                    item.push((name.as_str(), value.trim().to_string()));
                }
            }
        }
        let item_get = |item: &[(&str, String)], name: &str| {
            item.iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        let text = |name: &str| top(name).unwrap_or("").to_string();
        let choice = |name: &str, problems: &mut Vec<String>| -> Option<String> {
            let value = top(name).filter(|v| !v.is_empty())?;
            let Some(Input::Choice(options)) =
                spec.fields.iter().find(|f| f.name == name).map(|f| f.input)
            else {
                return None;
            };
            if options.iter().any(|(v, _)| *v == value) {
                Some(value.to_string())
            } else {
                let allowed: Vec<&str> = options.iter().map(|(v, _)| *v).collect();
                problems.push(format!(
                    "`{name}` must be one of {}; it is `{}`",
                    allowed.join(", "),
                    printable(value)
                ));
                None
            }
        };
        let piece = match kind {
            "button" => {
                let style = match choice("style", &mut problems).as_deref() {
                    Some("secondary") => ButtonStyle::Secondary,
                    _ => ButtonStyle::Primary,
                };
                Self::Button(Button {
                    label: text("label"),
                    href: text("href"),
                    style,
                })
            }
            "image" => Self::Image(ImageSection {
                src: text("src"),
                alt: text("alt"),
                caption: text("caption"),
            }),
            "video" => {
                let provider = match choice("provider", &mut problems).as_deref() {
                    Some("vimeo") => VideoProvider::Vimeo,
                    Some("youtube") => VideoProvider::Youtube,
                    _ => {
                        if top("provider").unwrap_or("").is_empty() {
                            problems.push("`provider` is required".into());
                        }
                        VideoProvider::Youtube
                    }
                };
                Self::Video(Video {
                    provider,
                    video: video_id(provider, &text("video")),
                    title: text("title"),
                })
            }
            "map" => {
                choice("provider", &mut problems);
                let number = |name: &str, problems: &mut Vec<String>| {
                    text(name).parse::<f64>().unwrap_or_else(|_| {
                        problems.push(format!("`{name}` must be a number"));
                        f64::NAN
                    })
                };
                let lat = number("lat", &mut problems);
                let lon = number("lon", &mut problems);
                Self::Map(MapSection {
                    provider: MapProvider::Openstreetmap,
                    label: text("label"),
                    lat,
                    lon,
                })
            }
            "hours" => Self::Hours(OpeningHours {
                rows: items
                    .iter()
                    .map(|i| HoursRow {
                        days: item_get(i, "days"),
                        hours: item_get(i, "hours"),
                    })
                    .collect(),
                note: text("note"),
            }),
            "contact" => Self::Contact(Contact {
                email: text("email"),
                phone: text("phone"),
                address: text("address"),
            }),
            "social" => Self::Social(SocialLinks {
                items: items
                    .iter()
                    .map(|i| SocialLink {
                        label: item_get(i, "label"),
                        href: item_get(i, "href"),
                    })
                    .collect(),
            }),
            "faq" => Self::Faq(Faq {
                items: items
                    .iter()
                    .map(|i| FaqItem {
                        question: item_get(i, "question"),
                        answer: item_get(i, "answer"),
                    })
                    .collect(),
            }),
            _ => {
                let tone = match choice("tone", &mut problems).as_deref() {
                    Some("success") => CalloutTone::Success,
                    Some("warning") => CalloutTone::Warning,
                    _ => CalloutTone::Info,
                };
                Self::Callout(Callout {
                    tone,
                    title: text("title"),
                    body: text("body"),
                })
            }
        };
        if problems.is_empty() {
            problems = piece.problems();
        }
        if problems.is_empty() {
            Ok(piece)
        } else {
            Err(problems)
        }
    }

    /// The piece as form values, omitting empty optional fields.
    pub fn to_values(&self) -> Values {
        let mut out = Values::new();
        let mut put = |name: &str, value: &str| {
            if !value.is_empty() {
                out.push((name.to_string(), value.to_string()));
            }
        };
        match self {
            Self::Button(v) => {
                put("label", &v.label);
                put("href", &v.href);
                if v.style == ButtonStyle::Secondary {
                    put("style", "secondary");
                }
            }
            Self::Image(v) => {
                put("src", &v.src);
                put("alt", &v.alt);
                put("caption", &v.caption);
            }
            Self::Video(v) => {
                put(
                    "provider",
                    match v.provider {
                        VideoProvider::Youtube => "youtube",
                        VideoProvider::Vimeo => "vimeo",
                    },
                );
                put("video", &v.video);
                put("title", &v.title);
            }
            Self::Map(v) => {
                put("provider", "openstreetmap");
                put("label", &v.label);
                put("lat", &v.lat.to_string());
                put("lon", &v.lon.to_string());
            }
            Self::Hours(v) => {
                put("note", &v.note);
                for row in &v.rows {
                    put("days", &row.days);
                    put("hours", &row.hours);
                }
            }
            Self::Contact(v) => {
                put("email", &v.email);
                put("phone", &v.phone);
                put("address", &v.address);
            }
            Self::Social(v) => {
                for link in &v.items {
                    put("label", &link.label);
                    put("href", &link.href);
                }
            }
            Self::Faq(v) => {
                for item in &v.items {
                    put("question", &item.question);
                    put("answer", &item.answer);
                }
            }
            Self::Callout(v) => {
                put("tone", v.tone.value());
                put("title", &v.title);
                put("body", &v.body);
            }
        }
        out
    }

    /// Short plain strings a reader sees as written (titles, labels, days,
    /// hours, questions), which a portable export must keep.
    pub fn visible_text(&self) -> Vec<String> {
        let mut out: Vec<String> = match self {
            Self::Button(v) => vec![v.label.clone()],
            Self::Image(v) => vec![v.caption.clone()],
            Self::Video(v) => vec![v.title.clone()],
            Self::Map(v) => vec![v.label.clone()],
            Self::Hours(v) => v
                .rows
                .iter()
                .flat_map(|r| [r.days.clone(), r.hours.clone()])
                .chain([v.note.clone()])
                .collect(),
            Self::Contact(v) => vec![v.email.clone(), v.address.clone()],
            Self::Social(v) => v.items.iter().map(|l| l.label.clone()).collect(),
            Self::Faq(v) => v.items.iter().map(|i| i.question.clone()).collect(),
            Self::Callout(v) => vec![v.title.clone()],
        };
        out.retain(|s| !s.trim().is_empty());
        out
    }

    /// The Markdown that holds the piece in a post. A call-out is the
    /// `> [!NOTE]` call-out; every other piece is a `piece` fence.
    pub fn to_markdown(&self) -> String {
        if let Self::Callout(v) = self {
            let marker = match v.tone {
                CalloutTone::Info => "NOTE",
                CalloutTone::Success => "TIP",
                CalloutTone::Warning => "WARNING",
            };
            let mut out = format!("> [!{marker}]\n");
            if !v.title.is_empty() {
                out.push_str(&format!("> **{}**\n>\n", v.title));
            }
            for line in v.body.lines() {
                if line.is_empty() {
                    out.push_str(">\n");
                } else {
                    out.push_str(&format!("> {line}\n"));
                }
            }
            return out;
        }
        let mut body = String::new();
        for (name, value) in self.to_values() {
            let mut lines = value.split('\n');
            body.push_str(&format!("{name}: {}\n", lines.next().unwrap_or("")));
            for line in lines {
                body.push_str(&format!("  {line}\n"));
            }
        }
        // A fence longer than any run of backticks in the values.
        let mut longest = 2;
        let mut run = 0;
        for c in body.chars() {
            run = if c == '`' { run + 1 } else { 0 };
            longest = longest.max(run);
        }
        let fence = "`".repeat(longest + 1);
        format!("{fence}piece {}\n{body}{fence}\n", self.kind())
    }

    /// Read the body of a `piece` fence. Returns every problem found.
    pub fn from_directive(kind: &str, source: &str) -> Result<Self, Vec<String>> {
        if kind == "callout" {
            return Err(vec![
                "write a call-out as `> [!NOTE]`, not as a piece fence".into(),
            ]);
        }
        let mut values: Values = Vec::new();
        let mut problems = Vec::new();
        for (number, line) in source.lines().enumerate() {
            let number = number + 1;
            if let Some(rest) = line.strip_prefix("  ") {
                match values.last_mut() {
                    Some((_, value)) => {
                        value.push('\n');
                        value.push_str(rest);
                    }
                    None => problems.push(format!("line {number} continues nothing")),
                }
            } else if line.trim().is_empty() {
                if let Some((_, value)) = values.last_mut() {
                    value.push('\n');
                }
            } else if let Some((name, value)) = line.split_once(':') {
                if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase()) {
                    problems.push(format!("line {number} is not `field: value`"));
                } else {
                    values.push((
                        name.to_string(),
                        value.strip_prefix(' ').unwrap_or(value).to_string(),
                    ));
                }
            } else {
                problems.push(format!("line {number} is not `field: value`"));
            }
        }
        if !problems.is_empty() {
            return Err(problems);
        }
        for (_, value) in &mut values {
            *value = value.trim_end_matches('\n').to_string();
        }
        Self::from_values(kind, &values)
    }
}

/// True when the text has `<` followed by an ASCII letter, `/`, `!` or `?`,
/// which a post renderer would pass through as live markup.
pub fn has_html_tag(value: &str) -> bool {
    value
        .as_bytes()
        .windows(2)
        .any(|w| w[0] == b'<' && (w[1].is_ascii_alphabetic() || matches!(w[1], b'/' | b'!' | b'?')))
}

fn printable(value: &str) -> String {
    value.chars().filter(|c| !c.is_control()).take(40).collect()
}

/// A video's own code from a pasted address or a bare code.
fn video_id(provider: VideoProvider, raw: &str) -> String {
    let raw = raw.trim();
    if !raw.starts_with("https://") && !raw.starts_with("http://") {
        return raw.to_string();
    }
    match provider {
        VideoProvider::Youtube => crate::embed::youtube_video_id(raw),
        VideoProvider::Vimeo => raw
            .split_once("vimeo.com/")
            .map(|(_, rest)| {
                rest.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
            })
            .filter(|id| !id.is_empty()),
    }
    .unwrap_or_else(|| raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(pairs: &[(&str, &str)]) -> Values {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn html_tags_are_refused_in_every_text_field() {
        assert!(has_html_tag("a <b>x"));
        assert!(has_html_tag("</p>"));
        assert!(has_html_tag("<!-- x"));
        assert!(has_html_tag("<?php"));
        assert!(!has_html_tag("1 < 2 and a<3 <"));
        let err = Piece::from_values(
            "callout",
            &v(&[("tone", "info"), ("title", "<img src=x>"), ("body", "hi")]),
        )
        .unwrap_err();
        assert!(err.iter().any(|p| p.contains("HTML tags are not allowed")));
        // Other pieces are fences the renderer escapes, so they stay writable.
        assert!(Piece::from_values("faq", &v(&[("question", "<i>q"), ("answer", "a")])).is_ok());
        assert!(Piece::from_values("callout", &v(&[("body", "2 < 3")])).is_ok());
    }

    #[test]
    fn every_kind_has_a_schema_and_the_json_names_it() {
        for kind in KINDS {
            assert!(schema(kind).is_some(), "{kind}");
        }
        let json = schema_json();
        assert_eq!(json.as_array().unwrap().len(), KINDS.len());
        assert_eq!(json[0]["kind"], "button");
        assert_eq!(json[0]["fields"][2]["options"][0]["value"], "primary");
    }

    #[test]
    fn directives_round_trip_for_every_piece() {
        let cases = [
            ("button", v(&[("label", "Read"), ("href", "/about/")])),
            (
                "image",
                v(&[("src", "/a.png"), ("alt", "A door"), ("caption", "Front")]),
            ),
            (
                "video",
                v(&[("provider", "vimeo"), ("video", "12345"), ("title", "Tour")]),
            ),
            (
                "map",
                v(&[
                    ("provider", "openstreetmap"),
                    ("label", "Shop"),
                    ("lat", "51.5"),
                    ("lon", "-0.12"),
                ]),
            ),
            (
                "hours",
                v(&[
                    ("note", "Bank holidays closed"),
                    ("days", "Mon"),
                    ("hours", "9 to 5"),
                    ("days", "Tue"),
                    ("hours", "Closed"),
                ]),
            ),
            (
                "contact",
                v(&[("email", "me@example.com"), ("phone", "+1 555 0100")]),
            ),
            (
                "social",
                v(&[
                    ("label", "Mastodon"),
                    ("href", "https://example.social/@me"),
                ]),
            ),
            (
                "faq",
                v(&[
                    ("question", "Why?"),
                    ("answer", "Because.\n\nReally."),
                    ("question", "Who?"),
                    ("answer", "Me"),
                ]),
            ),
        ];
        for (kind, values) in cases {
            let piece =
                Piece::from_values(kind, &values).unwrap_or_else(|e| panic!("{kind}: {e:?}"));
            let markdown = piece.to_markdown();
            assert!(
                markdown.starts_with(&format!("```piece {kind}\n")),
                "{markdown}"
            );
            let body = markdown
                .lines()
                .skip(1)
                .take_while(|l| *l != "```")
                .collect::<Vec<_>>()
                .join("\n");
            let again =
                Piece::from_directive(kind, &body).unwrap_or_else(|e| panic!("{kind}: {e:?}"));
            assert_eq!(again, piece, "{kind}");
            assert_eq!(again.to_markdown(), markdown, "{kind} is byte stable");
        }
    }

    #[test]
    fn a_callout_is_the_existing_callout_syntax() {
        let piece = Piece::from_values(
            "callout",
            &v(&[
                ("tone", "warning"),
                ("title", "Careful"),
                ("body", "Hot.\nReally hot."),
            ]),
        )
        .unwrap();
        assert_eq!(
            piece.to_markdown(),
            "> [!WARNING]\n> **Careful**\n>\n> Hot.\n> Really hot.\n"
        );
        assert!(Piece::from_directive("callout", "body: x").is_err());
    }

    #[test]
    fn a_pasted_video_address_becomes_its_code() {
        let piece = Piece::from_values(
            "video",
            &v(&[
                ("provider", "youtube"),
                ("video", "https://youtu.be/dQw4w9WgXcQ?t=4"),
                ("title", "T"),
            ]),
        )
        .unwrap();
        assert_eq!(piece.to_values()[1].1, "dQw4w9WgXcQ");
        let vimeo = Piece::from_values(
            "video",
            &v(&[
                ("provider", "vimeo"),
                ("video", "https://vimeo.com/76979871"),
                ("title", "T"),
            ]),
        )
        .unwrap();
        assert_eq!(vimeo.to_values()[1].1, "76979871");
    }

    #[test]
    fn hostile_and_missing_values_are_refused_with_words() {
        let bad = |kind: &str, pairs: &[(&str, &str)]| {
            Piece::from_values(kind, &v(pairs))
                .expect_err(kind)
                .join(" | ")
        };
        assert!(
            bad("button", &[("label", "x"), ("href", "javascript:alert(1)")])
                .contains("not allowed")
        );
        assert!(bad("button", &[("label", "x"), ("href", "http://example.com")]).contains("https"));
        assert!(bad("image", &[("src", "/a.png")]).contains("alt"));
        assert!(bad(
            "video",
            &[
                ("provider", "youtube"),
                ("video", "\"><script>"),
                ("title", "t")
            ]
        )
        .contains("video id"));
        assert!(bad(
            "video",
            &[
                ("provider", "evil"),
                ("video", "dQw4w9WgXcQ"),
                ("title", "t")
            ]
        )
        .contains("one of"));
        assert!(bad(
            "map",
            &[
                ("provider", "openstreetmap"),
                ("label", "x"),
                ("lat", "99"),
                ("lon", "0")
            ]
        )
        .contains("lat"));
        assert!(bad(
            "map",
            &[
                ("provider", "openstreetmap"),
                ("label", "x"),
                ("lat", "a"),
                ("lon", "0")
            ]
        )
        .contains("number"));
        assert!(bad("hours", &[("note", "n")]).contains("at least one"));
        assert!(bad("social", &[("label", "x"), ("href", "http://a.example")]).contains("https"));
        assert!(bad(
            "button",
            &[("label", "x"), ("href", "/a/"), ("onclick", "y")]
        )
        .contains("not a field"));
        assert!(bad("marquee", &[]).contains("not a piece"));
        assert!(Piece::from_directive("button", "label: x\nthis is not a field").is_err());
    }

    #[test]
    fn a_fence_inside_a_value_cannot_close_the_directive() {
        let piece = Piece::from_values(
            "faq",
            &v(&[("question", "Code?"), ("answer", "```\nlet x = 1;\n```")]),
        )
        .unwrap();
        let markdown = piece.to_markdown();
        assert!(markdown.starts_with("````piece faq\n"), "{markdown}");
        assert!(markdown.ends_with("\n````\n"));
    }
}
