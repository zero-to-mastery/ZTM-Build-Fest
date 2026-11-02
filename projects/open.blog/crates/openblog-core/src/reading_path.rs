//! Author-curated reading paths (ADR 0207, #76).
//!
//! A reading path is an author's ordered list of published steps, each after
//! the first carrying an author-written transition that says why it follows
//! and how it relates to the step before it. It is its own content type, not
//! a series: a series is one post's single, automatic membership ordered by
//! date, and a path is many-to-many, may point at Knowledge Atlas entries,
//! and carries editorial rationale. A path never changes a post, a series or
//! the atlas, and nothing else reads one.
//!
//! The stored file is `content/paths/<slug>.json` (`openblog-reading-path`,
//! version 1). It is public, author-written plain text. [`ReadingPath::parse`]
//! checks it and [`ReadingPath::to_canonical_json`] writes it back byte for
//! byte the same for the same path, so an Admin save and a hand edit agree.
//! Fields this release does not define are kept as written and written back
//! (the atlas and notebook idiom), so an older release still reads a newer
//! file's known fields and a round trip never loses anything. A repeated key,
//! a defined field of the wrong type and another version are refused.
//!
//! [`PublicPaths::resolve`] reads paths against [`PublishedTargets`] (the
//! posts a build publishes and the public atlas) and nothing else. A step
//! whose target is not published is left out of the public value and named
//! in an author-facing [`Diagnostic`]; the public value never says that
//! anything was left out, and never carries an unpublished item's title,
//! text or an author-chosen step id. A transition never claims more than the
//! author wrote and never loses the step it follows: when a left-out step
//! would leave a transition behind, or an `influenced` claim has no published,
//! uncontested relationship from the step it follows to this one, the whole
//! path is withheld rather than shown with a gap.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::atlas_publication::{entry_url, escaped_json, kind_label, PublicAtlas};
use crate::knowledge_atlas::{valid_id, RelationshipKind, Standing};
use crate::model::{Site, SourceFile};

/// Names the stored file.
pub const READING_PATH_FORMAT: &str = "openblog-reading-path";
/// The only stored version this release reads and writes.
pub const READING_PATH_VERSION: u64 = 1;
/// Names the public projection.
pub const PUBLIC_PATHS_FORMAT: &str = "openblog-reading-paths";
/// The only public projection version this release writes.
pub const PUBLIC_PATHS_FORMAT_VERSION: u64 = 1;
/// Where path files live, relative to the content folder.
pub const PATHS_DIR: &str = "paths";
/// Where a path's page will live on the site (`/paths/<slug>/`).
pub const PATHS_URL: &str = "/paths/";
/// The data file listing the published, listed paths (ADR 0216).
pub const PATHS_JSON_FILE: &str = "paths.json";
/// The first segment of that address. Reserved only while
/// `readingPaths.publish` is on.
pub const PATHS_SEGMENT: &str = "paths";

/// Most steps in one path.
pub const MAX_STEPS: usize = 100;
/// Most path files a site reads.
pub const MAX_PATHS: usize = 200;
/// Largest path file, in bytes.
pub const MAX_FILE_BYTES: usize = 256 * 1024;
/// Longest slug or step id, in bytes.
pub const MAX_ID_BYTES: usize = 64;
/// Longest title, in characters.
pub const MAX_TITLE_CHARS: usize = 120;
/// Longest summary, step rationale or transition, in characters.
pub const MAX_TEXT_CHARS: usize = 600;
/// Longest prerequisite note, in characters.
pub const MAX_PREREQUISITE_CHARS: usize = 400;

/// Whether a path is public. Absent means a draft: nothing is published by
/// leaving a field out.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    #[default]
    Draft,
    Published,
}

impl Status {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "draft" => Some(Self::Draft),
            "published" => Some(Self::Published),
            _ => None,
        }
    }
}

/// The author's own judgement of how demanding a step is. Never computed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Difficulty {
    Introductory,
    Intermediate,
    Advanced,
}

impl Difficulty {
    /// Every difficulty, in the order an editor lists them.
    pub const ALL: [Self; 3] = [Self::Introductory, Self::Intermediate, Self::Advanced];

    /// The value as the file writes it.
    pub fn value(self) -> &'static str {
        match self {
            Self::Introductory => "introductory",
            Self::Intermediate => "intermediate",
            Self::Advanced => "advanced",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "introductory" => Some(Self::Introductory),
            "intermediate" => Some(Self::Intermediate),
            "advanced" => Some(Self::Advanced),
            _ => None,
        }
    }
}

/// How a step relates to the step it follows, as the author states it. There
/// is no default: a transition without one is refused. `Next` claims only
/// order, and `Influenced` needs a published, uncontested atlas relationship
/// between two atlas entries behind it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Relationship {
    Next,
    Background,
    BuildsOn,
    ContrastsWith,
    RespondsTo,
    Applies,
    Influenced,
}

impl Relationship {
    /// Every relationship, in the order an editor lists them. `Next` first:
    /// it is the neutral one.
    pub const ALL: [Self; 7] = [
        Self::Next,
        Self::Background,
        Self::BuildsOn,
        Self::ContrastsWith,
        Self::RespondsTo,
        Self::Applies,
        Self::Influenced,
    ];

    /// The value as the file writes it.
    pub fn value(self) -> &'static str {
        match self {
            Self::Next => "next",
            Self::Background => "background",
            Self::BuildsOn => "builds-on",
            Self::ContrastsWith => "contrasts-with",
            Self::RespondsTo => "responds-to",
            Self::Applies => "applies",
            Self::Influenced => "influenced",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "next" => Some(Self::Next),
            "background" => Some(Self::Background),
            "builds-on" => Some(Self::BuildsOn),
            "contrasts-with" => Some(Self::ContrastsWith),
            "responds-to" => Some(Self::RespondsTo),
            "applies" => Some(Self::Applies),
            "influenced" => Some(Self::Influenced),
            _ => None,
        }
    }

    /// The relationship in words, about this step and the step it follows
    /// (the nearest required step before it).
    pub fn label(self) -> &'static str {
        match self {
            Self::Next => "Comes next, with no further relationship claimed",
            Self::Background => "Gives background for the step it follows",
            Self::BuildsOn => "Builds on the step it follows",
            Self::ContrastsWith => "Contrasts with the step it follows",
            Self::RespondsTo => "Responds to the step it follows",
            Self::Applies => "Applies the step it follows",
            Self::Influenced => {
                "Was influenced by the step it follows, which a published relationship states"
            }
        }
    }
}

/// Fields the file holds that this release does not define, kept as written
/// and written back (ADR 0208). Never read, never shown.
pub type Extra = BTreeMap<String, Value>;

/// What a step points at. Only these two kinds exist: a path cannot contain
/// a path, so paths cannot cycle through one another.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Target {
    /// A published post, by slug.
    Post {
        slug: String,
        #[serde(flatten)]
        extra: Extra,
    },
    /// A published Knowledge Atlas entry, by id.
    Atlas {
        id: String,
        #[serde(flatten)]
        extra: Extra,
    },
}

impl Target {
    pub fn post(slug: impl Into<String>) -> Self {
        Self::Post {
            slug: slug.into(),
            extra: Extra::new(),
        }
    }

    pub fn atlas(id: impl Into<String>) -> Self {
        Self::Atlas {
            id: id.into(),
            extra: Extra::new(),
        }
    }

    fn noun(&self) -> &'static str {
        match self {
            Self::Post { .. } => "post",
            Self::Atlas { .. } => "atlas entry",
        }
    }

    fn key(&self) -> String {
        match self {
            Self::Post { slug, .. } => format!("post `{slug}`"),
            Self::Atlas { id, .. } => format!("atlas entry `{id}`"),
        }
    }
}

/// Why a step follows the step before it, written by the author.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub relationship: Relationship,
    /// The author's explanation. Required.
    pub why: String,
    /// The id of a published atlas relationship this transition rests on.
    /// Required for `influenced` and refused on any other label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub basis: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Transition {
    pub fn new(relationship: Relationship, why: impl Into<String>) -> Self {
        Self {
            relationship,
            why: why.into(),
            basis: None,
            extra: Extra::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// Stable within the path, so a reorder keeps a step's identity. For the
    /// author only: the public value never carries it (ADR 0211).
    pub id: String,
    pub target: Target,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prerequisites: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub difficulty: Option<Difficulty>,
    /// A side step a reader may skip. It never changes the order, and the
    /// first step is never optional.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
    /// Absent on the first step and required on every other one of a path
    /// that is published. It relates this step to the nearest earlier step
    /// that is not optional (ADR 0210).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition: Option<Transition>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Step {
    pub fn new(id: impl Into<String>, target: Target) -> Self {
        Self {
            id: id.into(),
            target,
            rationale: None,
            prerequisites: None,
            difficulty: None,
            optional: false,
            transition: None,
            extra: Extra::new(),
        }
    }
}

/// One path as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadingPath {
    /// From the file name; never stored in the file.
    pub slug: String,
    pub title: String,
    pub summary: Option<String>,
    pub status: Status,
    /// Whether discovery (the index, search, #79) may list a published path.
    /// A path that is not listed is still published at its address. Listed
    /// unless the file says otherwise.
    pub listed: bool,
    pub steps: Vec<Step>,
    /// Top-level fields this release does not define, kept for the round trip.
    pub extra: Extra,
}

impl ReadingPath {
    /// An empty draft with the given slug and title.
    pub fn draft(slug: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            slug: slug.into(),
            title: title.into(),
            summary: None,
            status: Status::Draft,
            listed: true,
            steps: Vec::new(),
            extra: Extra::new(),
        }
    }
}

/// One refusal, scoped to a file and, where it has one, a step. It names
/// ids and limits, never a step's text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathProblem {
    pub file: String,
    pub step: Option<String>,
    pub message: String,
}

impl std::fmt::Display for PathProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.step {
            Some(step) => write!(f, "{}: step `{}`: {}", self.file, step, self.message),
            None => write!(f, "{}: {}", self.file, self.message),
        }
    }
}

/// Whether `value` is a path slug or step id: lowercase ASCII letters, digits
/// and single hyphens, at most [`MAX_ID_BYTES`] bytes.
pub fn valid_slug(value: &str) -> bool {
    is_ascii_slug(value)
}

/// Whether `value` can name a path file: a slug that is not a name Windows
/// reserves for a device (`con`, `prn`, `aux`, `nul`, `com1` to `com9`, `lpt1`
/// to `lpt9`), which no file there can be created or read under. Step ids are
/// never file names and keep the plain [`valid_slug`].
pub fn valid_path_slug(value: &str) -> bool {
    const DEVICES: [&str; 4] = ["con", "prn", "aux", "nul"];
    let device = DEVICES.contains(&value)
        || ((value.starts_with("com") || value.starts_with("lpt"))
            && value.len() == 4
            && value.as_bytes()[3].is_ascii_digit()
            && value.as_bytes()[3] != b'0');
    is_ascii_slug(value) && !device
}

pub(crate) fn is_ascii_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A post slug as the site makes one: letters and digits (any script) and
/// single hyphens.
fn is_post_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value.chars().all(|c| c == '-' || c.is_alphanumeric())
}

fn text_problem(value: &str, max_chars: usize) -> Option<String> {
    if value.chars().count() > max_chars {
        return Some(format!("is over {max_chars} characters"));
    }
    let bad = |c: char| {
        c.is_control()
            || matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    };
    if value.chars().any(bad) {
        return Some("holds a control or direction character; it is plain text on one line".into());
    }
    if value.contains("](atlas:") {
        return Some(
            "holds an `atlas:` link, which a reading path does not resolve: write the words".into(),
        );
    }
    None
}

// ---------------------------------------------------------------------------
// Reading the file. Nothing here echoes a value: a message names a field,
// never what it held.
// ---------------------------------------------------------------------------

pub(crate) type Obj = serde_json::Map<String, Value>;

const DUPLICATE_MARK: char = '\u{1}';

/// A JSON value that refuses a repeated key instead of keeping the last one,
/// so a hand edit that pastes a field twice is told, not silently changed.
struct Strict(Value);

impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visit;
        impl<'de> serde::de::Visitor<'de> for Visit {
            type Value = Value;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_bool<E>(self, v: bool) -> Result<Value, E> {
                Ok(Value::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Value, E> {
                Ok(Value::from(v))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Value, E> {
                Ok(Value::from(v))
            }
            fn visit_f64<E>(self, v: f64) -> Result<Value, E> {
                Ok(serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number))
            }
            fn visit_str<E>(self, v: &str) -> Result<Value, E> {
                Ok(Value::String(v.to_string()))
            }
            fn visit_string<E>(self, v: String) -> Result<Value, E> {
                Ok(Value::String(v))
            }
            fn visit_unit<E>(self) -> Result<Value, E> {
                Ok(Value::Null)
            }
            fn visit_none<E>(self) -> Result<Value, E> {
                Ok(Value::Null)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Value, A::Error> {
                let mut items = Vec::new();
                while let Some(Strict(item)) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Value::Array(items))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Value, A::Error> {
                let mut out = Obj::new();
                while let Some((key, Strict(value))) = map.next_entry::<String, Strict>()? {
                    if out.contains_key(&key) {
                        return Err(serde::de::Error::custom(format!(
                            "{DUPLICATE_MARK}{key}{DUPLICATE_MARK}"
                        )));
                    }
                    out.insert(key, value);
                }
                Ok(Value::Object(out))
            }
        }
        deserializer.deserialize_any(Visit).map(Strict)
    }
}

/// A field name safe to quote: short, plain, and so not hostile text.
fn quotable(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Reads JSON text into a value. A repeated key or invalid JSON is a message
/// that never quotes the text.
pub(crate) fn read_json(text: &str) -> Result<Value, String> {
    match serde_json::from_str::<Strict>(text) {
        Ok(Strict(value)) => Ok(value),
        Err(e) => {
            let message = e.to_string();
            let mut marks = message.split(DUPLICATE_MARK);
            if let (Some(_), Some(key)) = (marks.next(), marks.next()) {
                return Err(if quotable(key) {
                    format!("repeats the field `{key}`; a field is written once")
                } else {
                    "repeats a field; a field is written once".into()
                });
            }
            let at = if e.is_eof() {
                "ends too early".to_string()
            } else {
                format!(
                    "is not valid JSON (line {}, column {})",
                    e.line(),
                    e.column()
                )
            };
            Err(at)
        }
    }
}

pub(crate) fn take_text(
    obj: &mut Obj,
    name: &str,
    scope: &str,
    required: bool,
    errs: &mut Vec<String>,
) -> Option<String> {
    match obj.remove(name) {
        None => {
            if required {
                errs.push(format!("`{scope}{name}` is required"));
            }
            None
        }
        Some(Value::String(text)) => Some(text),
        Some(_) => {
            errs.push(format!("`{scope}{name}` must be text"));
            None
        }
    }
}

pub(crate) fn take_flag(
    obj: &mut Obj,
    name: &str,
    scope: &str,
    default: bool,
    errs: &mut Vec<String>,
) -> bool {
    match obj.remove(name) {
        None => default,
        Some(Value::Bool(flag)) => flag,
        Some(_) => {
            errs.push(format!("`{scope}{name}` must be true or false"));
            default
        }
    }
}

pub(crate) fn take_choice<T>(
    obj: &mut Obj,
    name: &str,
    scope: &str,
    required: bool,
    parse: fn(&str) -> Option<T>,
    allowed: &str,
    errs: &mut Vec<String>,
) -> Option<T> {
    let text = take_text(obj, name, scope, required, errs)?;
    let parsed = parse(&text);
    if parsed.is_none() {
        errs.push(format!("`{scope}{name}` must be {allowed}"));
    }
    parsed
}

pub(crate) fn take_object(
    obj: &mut Obj,
    name: &str,
    required: bool,
    errs: &mut Vec<String>,
) -> Option<Obj> {
    match obj.remove(name) {
        None => {
            if required {
                errs.push(format!("`{name}` is required"));
            }
            None
        }
        Some(Value::Object(inner)) => Some(inner),
        Some(_) => {
            errs.push(format!("`{name}` must be an object"));
            None
        }
    }
}

fn read_target(obj: &mut Obj, errs: &mut Vec<String>) -> Option<Target> {
    let mut target = take_object(obj, "target", true, errs)?;
    let kind = take_text(&mut target, "kind", "target.", true, errs)?;
    let made = match kind.as_str() {
        "post" => take_text(&mut target, "slug", "target.", true, errs).map(|slug| Target::Post {
            slug,
            extra: Extra::new(),
        }),
        "atlas" => take_text(&mut target, "id", "target.", true, errs).map(|id| Target::Atlas {
            id,
            extra: Extra::new(),
        }),
        _ => {
            errs.push("`target.kind` must be `post` or `atlas`".into());
            None
        }
    }?;
    let rest: Extra = target.into_iter().collect();
    Some(match made {
        Target::Post { slug, .. } => Target::Post { slug, extra: rest },
        Target::Atlas { id, .. } => Target::Atlas { id, extra: rest },
    })
}

fn read_transition(obj: &mut Obj, errs: &mut Vec<String>) -> Option<Transition> {
    let mut t = take_object(obj, "transition", false, errs)?;
    let before = errs.len();
    let relationship = take_choice(
        &mut t,
        "relationship",
        "transition.",
        true,
        Relationship::parse,
        "one of `next`, `background`, `builds-on`, `contrasts-with`, `responds-to`, `applies`, `influenced`",
        errs,
    );
    let why = take_text(&mut t, "why", "transition.", true, errs);
    let basis = take_text(&mut t, "basis", "transition.", false, errs);
    if errs.len() > before {
        return None;
    }
    Some(Transition {
        relationship: relationship?,
        why: why?,
        basis,
        extra: t.into_iter().collect(),
    })
}

fn read_step(value: Value, errs: &mut Vec<String>) -> Option<Step> {
    let Value::Object(mut obj) = value else {
        errs.push("must be an object".into());
        return None;
    };
    let before = errs.len();
    let id = take_text(&mut obj, "id", "", true, errs);
    let target = read_target(&mut obj, errs);
    let rationale = take_text(&mut obj, "rationale", "", false, errs);
    let prerequisites = take_text(&mut obj, "prerequisites", "", false, errs);
    let difficulty = take_choice(
        &mut obj,
        "difficulty",
        "",
        false,
        Difficulty::parse,
        "`introductory`, `intermediate` or `advanced`",
        errs,
    );
    let optional = take_flag(&mut obj, "optional", "", false, errs);
    let transition = read_transition(&mut obj, errs);
    if errs.len() > before {
        return None;
    }
    Some(Step {
        id: id?,
        target: target?,
        rationale,
        prerequisites,
        difficulty,
        optional,
        transition,
        extra: obj.into_iter().collect(),
    })
}

/// The index of the step that step `index` follows: the nearest earlier step
/// that is not optional. A reader who skips every optional step still reads
/// each shown step after the step its transition describes (ADR 0210).
pub fn followed_index(steps: &[Step], index: usize) -> Option<usize> {
    (0..index).rev().find(|&i| !steps[i].optional)
}

impl ReadingPath {
    /// Reads and checks one file. `file` is its path under the content
    /// folder (`paths/<slug>.json`), which names the path. Every refusal
    /// found is returned, and a refused file is never partly read.
    pub fn parse(file: &str, text: &str) -> Result<Self, Vec<PathProblem>> {
        let mut problems: Vec<PathProblem> = Vec::new();
        let add = |problems: &mut Vec<PathProblem>, step: Option<&str>, message: String| {
            problems.push(PathProblem {
                file: file.to_string(),
                step: step.map(str::to_string),
                message,
            });
        };
        let stem = file
            .strip_prefix("paths/")
            .and_then(|rest| rest.strip_suffix(".json"))
            .filter(|stem| valid_path_slug(stem));
        let Some(slug) = stem else {
            add(
                &mut problems,
                None,
                format!(
                    "a path file is `{PATHS_DIR}/<slug>.json` with a lowercase slug of at most {MAX_ID_BYTES} characters"
                ),
            );
            return Err(problems);
        };
        if text.len() > MAX_FILE_BYTES {
            add(
                &mut problems,
                None,
                format!("is over {MAX_FILE_BYTES} bytes"),
            );
            return Err(problems);
        }
        let root = match read_json(text) {
            Ok(Value::Object(root)) => root,
            Ok(_) => {
                add(&mut problems, None, "must be a JSON object".into());
                return Err(problems);
            }
            Err(message) => {
                add(&mut problems, None, message);
                return Err(problems);
            }
        };
        let mut root = root;
        if root.get("format").and_then(Value::as_str) != Some(READING_PATH_FORMAT) {
            add(
                &mut problems,
                None,
                format!("`format` must be `{READING_PATH_FORMAT}`"),
            );
            return Err(problems);
        }
        match root.get("version").and_then(Value::as_u64) {
            Some(READING_PATH_VERSION) => {}
            Some(other) => {
                add(
                    &mut problems,
                    None,
                    format!(
                        "is version {other}; this release reads version {READING_PATH_VERSION} only"
                    ),
                );
                return Err(problems);
            }
            None => {
                add(&mut problems, None, "`version` must be a number".into());
                return Err(problems);
            }
        }
        root.remove("format");
        root.remove("version");
        let mut errs: Vec<String> = Vec::new();
        let title = take_text(&mut root, "title", "", true, &mut errs);
        let summary = take_text(&mut root, "summary", "", false, &mut errs);
        let status = take_choice(
            &mut root,
            "status",
            "",
            false,
            Status::parse,
            "`draft` or `published`",
            &mut errs,
        )
        .unwrap_or_default();
        let listed = take_flag(&mut root, "listed", "", true, &mut errs);
        let raw_steps = match root.remove("steps") {
            None => Vec::new(),
            Some(Value::Array(items)) => items,
            Some(_) => {
                errs.push("`steps` must be a list".into());
                Vec::new()
            }
        };
        for message in errs {
            add(&mut problems, None, message);
        }
        let title = title.unwrap_or_default();
        if title.trim().is_empty() {
            if !problems.iter().any(|p| p.message.contains("`title`")) {
                add(&mut problems, None, "`title` is required".into());
            }
        } else if let Some(p) = text_problem(&title, MAX_TITLE_CHARS) {
            add(&mut problems, None, format!("`title` {p}"));
        }
        if let Some(p) = summary
            .as_deref()
            .and_then(|s| text_problem(s, MAX_TEXT_CHARS))
        {
            add(&mut problems, None, format!("`summary` {p}"));
        }
        if raw_steps.len() > MAX_STEPS {
            add(
                &mut problems,
                None,
                format!(
                    "has {} steps; a path holds at most {MAX_STEPS}",
                    raw_steps.len()
                ),
            );
            return Err(problems);
        }
        let mut steps = Vec::new();
        for (index, value) in raw_steps.into_iter().enumerate() {
            let label = value
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_ascii_slug(id))
                .map_or_else(|| format!("#{}", index + 1), str::to_string);
            let mut step_errs = Vec::new();
            match read_step(value, &mut step_errs) {
                Some(step) => steps.push(step),
                None => {
                    for message in step_errs {
                        add(&mut problems, Some(&label), message);
                    }
                }
            }
        }
        let published = status == Status::Published;
        check_steps(&steps, published, file, &mut problems);
        if published && steps.len() < 2 {
            add(
                &mut problems,
                None,
                "a published path has at least two steps".into(),
            );
        }
        if !problems.is_empty() {
            return Err(problems);
        }
        Ok(Self {
            slug: slug.to_string(),
            title,
            summary,
            status,
            listed,
            steps,
            extra: root.into_iter().collect(),
        })
    }

    /// Checks a path built in memory (an Admin edit) by the rules `parse`
    /// applies to a file, without writing anything.
    pub fn validate(&self) -> Vec<PathProblem> {
        match Self::parse(
            &format!("{PATHS_DIR}/{}.json", self.slug),
            &self.to_canonical_json(),
        ) {
            Ok(_) => Vec::new(),
            Err(problems) => problems,
        }
    }

    /// The file's bytes: two-space JSON, fixed field order, `\n` line ends and
    /// a final newline. `parse` of this text gives the same path, and this of
    /// that path gives the same text. Fields this release does not define
    /// follow the defined ones in name order.
    pub fn to_canonical_json(&self) -> String {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Out<'a> {
            format: &'a str,
            version: u64,
            title: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            summary: &'a Option<String>,
            status: Status,
            #[serde(skip_serializing_if = "is_true")]
            listed: bool,
            steps: &'a [Step],
            #[serde(flatten)]
            extra: &'a Extra,
        }
        fn is_true(value: &bool) -> bool {
            *value
        }
        let mut text = serde_json::to_string_pretty(&Out {
            format: READING_PATH_FORMAT,
            version: READING_PATH_VERSION,
            title: &self.title,
            summary: &self.summary,
            status: self.status,
            listed: self.listed,
            steps: &self.steps,
            extra: &self.extra,
        })
        .expect("a path is serializable");
        text.push('\n');
        text
    }
}

fn check_steps(steps: &[Step], published: bool, file: &str, problems: &mut Vec<PathProblem>) {
    let mut ids = BTreeSet::new();
    let mut targets: BTreeMap<String, String> = BTreeMap::new();
    for (index, step) in steps.iter().enumerate() {
        let id = step.id.as_str();
        // A step is named by its id only when that is a plain slug, so a
        // hostile id is never echoed in a message.
        let label = if is_ascii_slug(id) {
            id.to_string()
        } else {
            format!("#{}", index + 1)
        };
        let mut at = |message: String| {
            problems.push(PathProblem {
                file: file.to_string(),
                step: Some(label.clone()),
                message,
            })
        };
        if !is_ascii_slug(id) {
            at(format!(
                "`id` is a lowercase slug of at most {MAX_ID_BYTES} characters"
            ));
        } else if !ids.insert(id.to_string()) {
            at("`id` is used by an earlier step".into());
        }
        match &step.target {
            Target::Post { slug, .. } if !is_post_slug(slug) => {
                at("`slug` is not a post slug".into())
            }
            Target::Atlas { id, .. } if !valid_id(id) => {
                at("`id` is not an atlas entry id".into());
            }
            _ => {}
        }
        if let Some(first) = targets.insert(step.target.key(), label.clone()) {
            at(format!(
                "points at the same {} as step `{first}`; a path never returns to a step",
                step.target.noun()
            ));
        }
        for (name, value, max) in [
            ("rationale", &step.rationale, MAX_TEXT_CHARS),
            ("prerequisites", &step.prerequisites, MAX_PREREQUISITE_CHARS),
        ] {
            if let Some(p) = value.as_deref().and_then(|v| text_problem(v, max)) {
                at(format!("`{name}` {p}"));
            }
        }
        if index == 0 && step.optional {
            at("the first step is where every reader starts, so it cannot be optional".into());
        }
        match (&step.transition, index) {
            (Some(_), 0) => {
                at("the first step has no earlier step to follow, so it has no transition".into())
            }
            (None, i) if i > 0 && published => {
                at("a published path explains every step after the first: add a transition".into());
            }
            _ => {}
        }
        if let Some(t) = &step.transition {
            if t.why.trim().is_empty() {
                at("`transition.why` is required: say why this step follows".into());
            } else if let Some(p) = text_problem(&t.why, MAX_TEXT_CHARS) {
                at(format!("`transition.why` {p}"));
            }
            if t.basis.as_deref().is_some_and(|basis| !valid_id(basis)) {
                at("`transition.basis` is not an atlas relationship id".into());
            }
            match t.relationship {
                Relationship::Influenced => {
                    if t.basis.is_none() {
                        at("`influenced` needs `basis`, a published atlas relationship that states it; order and chronology never imply influence".into());
                    }
                    let followed = followed_index(steps, index).map(|i| &steps[i].target);
                    let between_entries = matches!(followed, Some(Target::Atlas { .. }))
                        && matches!(step.target, Target::Atlas { .. });
                    if index > 0 && !between_entries {
                        at("`influenced` joins two atlas entries, because only the atlas states influence; use another label between posts".into());
                    }
                }
                _ => {
                    if t.basis.is_some() {
                        at("`transition.basis` belongs to `influenced` only".into());
                    }
                }
            }
        }
    }
}

/// Every path a site holds, and every file that was refused.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LoadedPaths {
    /// Sorted by slug.
    pub paths: Vec<ReadingPath>,
    /// In file order; one file's refusal never affects another.
    pub problems: Vec<PathProblem>,
}

/// Reads the `paths/*.json` files among `files`. Other files are ignored.
/// A site with none gives an empty value, and nothing else changes.
pub fn load_paths(files: &[SourceFile]) -> LoadedPaths {
    let mut files: Vec<&SourceFile> = files
        .iter()
        .filter(|f| f.path.starts_with("paths/") && f.path.ends_with(".json"))
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let mut loaded = LoadedPaths::default();
    if files.len() > MAX_PATHS {
        loaded.problems.push(PathProblem {
            file: PATHS_DIR.to_string(),
            step: None,
            message: format!(
                "holds {} path files; a site reads at most {MAX_PATHS}",
                files.len()
            ),
        });
        files.truncate(MAX_PATHS);
    }
    for file in files {
        match ReadingPath::parse(&file.path, &file.contents) {
            Ok(path) => loaded.paths.push(path),
            Err(mut problems) => loaded.problems.append(&mut problems),
        }
    }
    loaded
}

/// What a path may point at: only what this build publishes.
#[derive(Clone, Debug, Default)]
pub struct PublishedTargets {
    posts: BTreeMap<String, (String, String)>,
    entries: BTreeMap<String, (String, String, &'static str)>,
    /// Published `influenced` relationships: id to (from, to, contested).
    influences: BTreeMap<String, (String, String, bool)>,
}

impl PublishedTargets {
    /// The posts `site` publishes in production and its public atlas, if it
    /// publishes one. A post that is a draft or is dated after the time the
    /// site was loaded for is left out even when a preview or Admin load
    /// included it (`Site::is_published`): a path never names what production
    /// would not show. A site loaded without a time cannot tell scheduled
    /// posts from published ones; callers that need that load it with one.
    pub fn from_site(site: &Site) -> Self {
        let mut targets = Self::default();
        for post in site.posts.iter().filter(|post| site.is_published(post)) {
            targets.add_post(&post.slug, &post.title, &post.url);
        }
        if let Some(atlas) = &site.atlas {
            targets.add_atlas(atlas);
        }
        targets
    }

    pub fn add_post(&mut self, slug: &str, title: &str, url: &str) {
        self.posts
            .insert(slug.to_string(), (title.to_string(), url.to_string()));
    }

    pub fn add_atlas(&mut self, atlas: &PublicAtlas) {
        for e in &atlas.entries {
            self.entries.insert(
                e.id.clone(),
                (e.label.clone(), entry_url(&e.id), kind_label(e.kind)),
            );
        }
        for r in &atlas.relationships {
            if r.kind == RelationshipKind::Influenced {
                self.influences.insert(
                    r.id.clone(),
                    (
                        r.from.clone(),
                        r.to.clone(),
                        r.standing != Standing::Asserted,
                    ),
                );
            }
        }
    }

    /// Published posts an author may pick as a step: (slug, title).
    pub fn posts(&self) -> impl Iterator<Item = (&str, &str)> {
        self.posts
            .iter()
            .map(|(slug, (title, _))| (slug.as_str(), title.as_str()))
    }

    /// Public atlas entries an author may pick as a step: (id, label, kind label).
    pub fn entries(&self) -> impl Iterator<Item = (&str, &str, &'static str)> {
        self.entries
            .iter()
            .map(|(id, (label, _, kind))| (id.as_str(), label.as_str(), *kind))
    }

    /// The title of a published post, if `slug` is one.
    pub fn post_title(&self, slug: &str) -> Option<&str> {
        self.posts.get(slug).map(|(title, _)| title.as_str())
    }

    /// The label of a public atlas entry, if `id` is one.
    pub fn entry_label(&self, id: &str) -> Option<&str> {
        self.entries.get(id).map(|(label, _, _)| label.as_str())
    }
}

/// Why something was left out or changed, for the author.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagnosticKind {
    /// A step's target is not published (or does not exist: the two are not told apart).
    StepUnavailable,
    /// A transition could not be shown as written, so the path is withheld
    /// rather than shown with a gap or a weaker claim.
    TransitionDropped,
    /// The path is not published: fewer than two steps are published, or a
    /// transition would be lost.
    PathWithheld,
}

/// An author-facing finding scoped to a path and, where it has one, a step.
/// It names ids only. It is for the author and is never written to a page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub path: String,
    pub step: Option<String>,
    pub kind: DiagnosticKind,
    pub message: String,
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.step {
            Some(step) => write!(
                f,
                "reading path `{}`, step `{}`: {}",
                self.path, step, self.message
            ),
            None => write!(f, "reading path `{}`: {}", self.path, self.message),
        }
    }
}

/// The published reading paths: an allowlist of what a page, a feed or an
/// export may show.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicPaths {
    pub format: &'static str,
    pub format_version: u64,
    /// Sorted by slug.
    pub paths: Vec<PublicPath>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicPath {
    pub slug: String,
    pub url: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Whether discovery may list the path. It is published either way.
    pub listed: bool,
    /// In the author's order, at least two.
    pub steps: Vec<PublicStep>,
}

/// A step as the public sees it. It carries no author-chosen id: ids would
/// show where a step was left out. A step is named by its kind and target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicStep {
    /// One-based, with no gaps.
    pub position: usize,
    /// `post` or `atlas`.
    pub kind: &'static str,
    /// The kind in words ("Post", "Person").
    pub kind_label: &'static str,
    /// The post slug or atlas entry id.
    pub target: String,
    pub title: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prerequisites: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub difficulty: Option<Difficulty>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
    /// Present on every step after the first.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition: Option<PublicTransition>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicTransition {
    pub relationship: Relationship,
    pub label: &'static str,
    pub why: String,
    /// The position of the step this transition describes: the nearest
    /// earlier step that is not optional, which is not always the one just
    /// above when optional steps lie between.
    pub follows: usize,
    /// A published, uncontested atlas relationship id (`influenced` only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub basis: Option<String>,
}

/// The public projection and the author's diagnostics, both deterministic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolution {
    pub paths: PublicPaths,
    pub diagnostics: Vec<Diagnostic>,
}

impl PublicPaths {
    /// Resolves `paths` against `targets`. Draft paths are not published and
    /// are not reported. Never fails: whatever cannot be published is left
    /// out, and a path that cannot be shown without a gap is withheld whole.
    pub fn resolve(paths: &[ReadingPath], targets: &PublishedTargets) -> Resolution {
        let mut sorted: Vec<&ReadingPath> = paths
            .iter()
            .filter(|p| p.status == Status::Published)
            .collect();
        sorted.sort_by(|a, b| a.slug.cmp(&b.slug));
        let mut diagnostics = Vec::new();
        let mut out = Vec::new();
        for path in sorted {
            let (steps, gap) = resolve_steps(path, targets, &mut diagnostics);
            if gap || steps.len() < 2 {
                let message = if gap {
                    "a transition would lose the step it follows, so the whole path is withheld rather than shown with a gap".to_string()
                } else {
                    format!(
                        "only {} of its steps are published and a path needs two, so it is not published",
                        steps.len()
                    )
                };
                diagnostics.push(Diagnostic {
                    path: path.slug.clone(),
                    step: None,
                    kind: DiagnosticKind::PathWithheld,
                    message,
                });
                continue;
            }
            out.push(PublicPath {
                slug: path.slug.clone(),
                url: format!("{PATHS_URL}{}/", path.slug),
                title: path.title.clone(),
                summary: path.summary.clone(),
                listed: path.listed,
                steps,
            });
        }
        Resolution {
            paths: PublicPaths {
                format: PUBLIC_PATHS_FORMAT,
                format_version: PUBLIC_PATHS_FORMAT_VERSION,
                paths: out,
            },
            diagnostics,
        }
    }

    /// The projection as JSON safe to embed in HTML (`<`, `>` and `&` escaped).
    pub fn to_json(&self) -> String {
        escaped_json(self)
    }

    /// Only the paths discovery may list (ADR 0216). An unlisted path is
    /// published at its address and nowhere that advertises it: not the
    /// index, the sitemap, search, `paths.json` or a link from a post.
    pub fn listed_only(&self) -> PublicPaths {
        PublicPaths {
            format: self.format,
            format_version: self.format_version,
            paths: self.paths.iter().filter(|p| p.listed).cloned().collect(),
        }
    }

    /// The listed paths a target is a step of, in slug order, with the
    /// step's position and the number of steps. This is discovery only: it
    /// reads the paths and changes no order anywhere.
    pub fn memberships(&self, kind: &str, target: &str) -> Vec<Membership<'_>> {
        self.paths
            .iter()
            .filter(|path| path.listed)
            .filter_map(|path| {
                path.steps
                    .iter()
                    .find(|step| step.kind == kind && step.target == target)
                    .map(|step| Membership {
                        path,
                        position: step.position,
                        total: path.steps.len(),
                    })
            })
            .collect()
    }
}

/// A listed path a post or atlas entry is a step of.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Membership<'a> {
    pub path: &'a PublicPath,
    pub position: usize,
    pub total: usize,
}

type Found = (&'static str, &'static str, String, String, String);

fn find_target(step: &Step, targets: &PublishedTargets) -> Option<Found> {
    match &step.target {
        Target::Post { slug, .. } => targets
            .posts
            .get(slug)
            .map(|(title, url)| ("post", "Post", slug.clone(), title.clone(), url.clone())),
        Target::Atlas { id, .. } => targets
            .entries
            .get(id)
            .map(|(label, url, kind)| ("atlas", *kind, id.clone(), label.clone(), url.clone())),
    }
}

/// The shown steps and whether the path has a gap: a transition that could
/// not be kept as written. With a gap the steps are not to be published.
///
/// A step that is left out leaves no trace in the shown steps when it is
/// optional and not the one a shown step follows, or when it is last. Any
/// other case would leave a step whose transition describes a step the reader
/// does not see, so the whole path is withheld (ADR 0211).
fn resolve_steps(
    path: &ReadingPath,
    targets: &PublishedTargets,
    diagnostics: &mut Vec<Diagnostic>,
) -> (Vec<PublicStep>, bool) {
    let diag = |step: &Step, kind, message: String| Diagnostic {
        path: path.slug.clone(),
        step: Some(step.id.clone()),
        kind,
        message,
    };
    let found: Vec<Option<Found>> = path
        .steps
        .iter()
        .map(|step| find_target(step, targets))
        .collect();
    // The public position of each step that is shown.
    let mut positions: Vec<Option<usize>> = vec![None; path.steps.len()];
    let mut shown = 0;
    for (i, f) in found.iter().enumerate() {
        if f.is_some() {
            shown += 1;
            positions[i] = Some(shown);
        } else {
            diagnostics.push(diag(
                &path.steps[i],
                DiagnosticKind::StepUnavailable,
                format!(
                    "{} is not published, so the step is left out",
                    path.steps[i].target.key()
                ),
            ));
        }
    }
    let mut gap = false;
    let mut steps: Vec<PublicStep> = Vec::new();
    for (i, (step, found)) in path.steps.iter().zip(found).enumerate() {
        let Some((kind, kind_label, target, title, url)) = found else {
            continue;
        };
        let mut transition = None;
        if i == 0 {
            // The first step of the path has no transition.
        } else {
            let anchor = followed_index(&path.steps, i).filter(|&a| positions[a].is_some());
            match (&step.transition, anchor) {
                (Some(t), Some(a)) => match check_transition(t, &path.steps[a], step, targets) {
                    Ok(basis) => {
                        transition = Some(PublicTransition {
                            relationship: t.relationship,
                            label: t.relationship.label(),
                            why: t.why.clone(),
                            follows: positions[a].expect("a followed step is shown"),
                            basis,
                        });
                    }
                    Err(message) => {
                        gap = true;
                        diagnostics.push(diag(step, DiagnosticKind::TransitionDropped, message));
                    }
                },
                (Some(_), None) => {
                    gap = true;
                    diagnostics.push(diag(
                        step,
                        DiagnosticKind::TransitionDropped,
                        "the step it follows is left out, so its transition would describe a step the reader does not see".into(),
                    ));
                }
                (None, _) => {
                    gap = true;
                    diagnostics.push(diag(
                        step,
                        DiagnosticKind::TransitionDropped,
                        "it has no transition, so the reader would not be told why it follows"
                            .into(),
                    ));
                }
            }
        }
        steps.push(PublicStep {
            position: steps.len() + 1,
            kind,
            kind_label,
            target,
            title,
            url,
            rationale: step.rationale.clone(),
            prerequisites: step.prerequisites.clone(),
            difficulty: step.difficulty,
            optional: step.optional,
            transition,
        });
    }
    // Step 0 left out: the first shown step would start the path in the
    // middle. Its transition (if it has one) follows a step that is gone, so
    // the loop above already marked a gap; a step with none is also a gap.
    if !path.steps.is_empty() && positions[0].is_none() && !steps.is_empty() {
        gap = true;
    }
    (steps, gap)
}

/// Whether the transition holds as written; the basis to show, or why not.
fn check_transition(
    t: &Transition,
    followed: &Step,
    step: &Step,
    targets: &PublishedTargets,
) -> Result<Option<String>, String> {
    if t.relationship != Relationship::Influenced {
        return Ok(None);
    }
    let Some(id) = &t.basis else {
        return Err("`influenced` has no basis, so the path is not published".into());
    };
    let (Target::Atlas { id: from, .. }, Target::Atlas { id: to, .. }) =
        (&followed.target, &step.target)
    else {
        return Err("`influenced` joins two atlas entries, so the path is not published".into());
    };
    match targets.influences.get(id) {
        Some((f, t, false)) if f == from && t == to => Ok(Some(id.clone())),
        Some((_, _, true)) => Err(format!(
            "`influenced` rests on `{id}`, which is contested, so the path is not published; use another label"
        )),
        _ => Err(format!(
            "`influenced` rests on `{id}`, which is not a published influence from the step it follows to this one, so the path is not published"
        )),
    }
}
