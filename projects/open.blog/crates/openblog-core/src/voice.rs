//! Voice samples: the author's own writing, captured so Assistant tools can learn how they sound
//! (ADR 0266, ADR 0267).
//!
//! A sample is a Markdown file: front matter, a blank line, then the author's text. This module
//! parses, validates and serializes that file deterministically, with no I/O. Where the file
//! lives, and the rule that a rough draft is never rewritten, belong to the store in the CLI.
//!
//! The front matter is the repository's flat subset, so the `voice` block is written as dotted
//! keys (`voice.stage: rough`), which the post parser also ignores as unknown keys. Keys this
//! release does not know are preserved and written back in a fixed order.

pub mod catalog;
pub mod draw;
pub mod exchange;
pub mod gaps;
pub mod guide;
pub mod merge;

use std::collections::BTreeMap;
use std::fmt;

use crate::frontmatter::{self, Value};
use crate::DateTime;

/// The sample file format this release writes and the newest it reads.
pub const FORMAT_VERSION: u32 = 1;
/// The newest prompt catalog version this release understands.
pub const CATALOG_VERSION: u32 = 1;
/// The largest sample file, in bytes.
pub const MAX_FILE_BYTES: usize = 64 * 1024;

const MAX_TITLE: usize = 200;
const MAX_DESCRIPTION: usize = 500;
const MAX_TAGS: usize = 20;
const MAX_TAG: usize = 50;
const MAX_ID: usize = 100;
const MAX_TIME_LIMIT_SECONDS: u32 = 3600;

/// Which stage of a voice sample a file holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum VoiceStage {
    Rough,
    Polished,
}

impl VoiceStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rough => "rough",
            Self::Polished => "polished",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "rough" => Some(Self::Rough),
            "polished" => Some(Self::Polished),
            _ => None,
        }
    }
}

impl fmt::Display for VoiceStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The `voice` block of a sample's front matter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoiceMeta {
    /// The catalog version the prompt came from.
    pub catalog: u32,
    pub pack: String,
    pub prompt: String,
    pub stage: VoiceStage,
    /// The writing window in seconds; 0 for an untimed polished draft.
    pub time_limit_seconds: u32,
    /// Whitespace-separated words in the body, as counted when the file was written.
    pub words: u32,
    /// For a polished draft, the file name of its rough draft.
    pub rough_of: Option<String>,
}

/// One voice sample.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoiceSample {
    pub title: String,
    pub subtitle: Option<String>,
    pub slug: String,
    /// RFC 3339 with a time, for example `2026-10-28T09:30:00Z`.
    pub date: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub voice: VoiceMeta,
    /// The author's text, exactly as written (line endings are LF).
    pub body: String,
    /// Front matter keys this release does not know, kept for a newer one.
    pub extra: BTreeMap<String, Value>,
}

/// A post draft made from a polished sample.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PostDraft {
    pub slug: String,
    /// A suggested file name under `content/posts/`.
    pub file_name: String,
    /// Front matter and body, ready to write.
    pub markdown: String,
}

const KNOWN_KEYS: &[&str] = &[
    "title",
    "subtitle",
    "slug",
    "date",
    "description",
    "tags",
    "voice.format",
    "voice.catalog",
    "voice.pack",
    "voice.prompt",
    "voice.stage",
    "voice.timeLimitSeconds",
    "voice.words",
    "voice.roughOf",
];

/// The number of whitespace-separated words in `text`.
pub fn count_words(text: &str) -> u32 {
    u32::try_from(text.split_whitespace().count()).unwrap_or(u32::MAX)
}

/// Whether `value` is a stable kebab-case id: lowercase ASCII letters and digits in groups joined by
/// single hyphens.
pub fn is_kebab(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The file name of a sample: `<YYYY-MM-DD>-<prompt-id>-<stage>.md`.
pub fn file_name(date: &str, prompt: &str, stage: VoiceStage) -> Option<String> {
    let day = date.get(..10)?;
    DateTime::parse(day)?;
    is_kebab(prompt).then(|| format!("{day}-{prompt}-{}.md", stage.as_str()))
}

/// Split a sample file name into its day, prompt id and stage, or `None` if it is not one.
pub fn parse_file_name(name: &str) -> Option<(&str, &str, VoiceStage)> {
    let stem = name.strip_suffix(".md")?;
    let (rest, stage) = if let Some(rest) = stem.strip_suffix("-rough") {
        (rest, VoiceStage::Rough)
    } else {
        (stem.strip_suffix("-polished")?, VoiceStage::Polished)
    };
    let day = rest.get(..10)?;
    DateTime::parse(day)?;
    let prompt = rest.get(11..)?;
    (rest.as_bytes().get(10) == Some(&b'-') && is_kebab(prompt)).then_some((day, prompt, stage))
}

/// The file name of the polished draft of the rough draft named `rough`.
pub fn polished_file_name(rough: &str) -> Option<String> {
    match parse_file_name(rough)? {
        (day, prompt, VoiceStage::Rough) => Some(format!("{day}-{prompt}-polished.md")),
        _ => None,
    }
}

fn no_control(label: &str, value: &str) -> Result<(), String> {
    if value.chars().any(char::is_control) {
        Err(format!(
            "The {label} cannot contain line breaks or control characters."
        ))
    } else {
        Ok(())
    }
}

fn scalar(fields: &BTreeMap<String, Value>, key: &str) -> Result<Option<String>, String> {
    match fields.get(key) {
        None => Ok(None),
        Some(Value::Scalar(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::Scalar(s)) => Ok(Some(s.clone())),
        Some(Value::List(_)) => Err(format!(
            "The field `{key}` must be a single value, not a list."
        )),
    }
}

fn required(fields: &BTreeMap<String, Value>, key: &str) -> Result<String, String> {
    scalar(fields, key)?.ok_or_else(|| format!("The field `{key}` is missing."))
}

fn number(fields: &BTreeMap<String, Value>, key: &str) -> Result<u32, String> {
    required(fields, key)?
        .trim()
        .parse()
        .map_err(|_| format!("The field `{key}` must be a whole number."))
}

impl VoiceSample {
    /// Read a sample from bytes, refusing anything that is not UTF-8.
    pub fn parse_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_FILE_BYTES {
            return Err(format!(
                "The sample is larger than the {} KiB limit.",
                MAX_FILE_BYTES / 1024
            ));
        }
        let text = std::str::from_utf8(bytes)
            .map_err(|_| "The sample is not valid UTF-8 text.".to_string())?;
        Self::parse(text)
    }

    /// Read a sample from text. CRLF line endings are read as LF.
    pub fn parse(source: &str) -> Result<Self, String> {
        if source.len() > MAX_FILE_BYTES {
            return Err(format!(
                "The sample is larger than the {} KiB limit.",
                MAX_FILE_BYTES / 1024
            ));
        }
        let text = source.strip_prefix('\u{feff}').unwrap_or(source);
        let text = text.replace("\r\n", "\n");
        let (header, body) = split_front_matter(&text)?;
        let document = frontmatter::parse(header)?;
        let mut fields = document.front_matter.fields;

        let format = number(&fields, "voice.format")?;
        if format == 0 {
            return Err("The field `voice.format` must be 1 or more.".into());
        }
        if format > FORMAT_VERSION {
            return Err(format!(
                "This sample was written in format {format}, which is newer than this release understands ({FORMAT_VERSION}). Update open.blog to read it."
            ));
        }
        let stage_text = required(&fields, "voice.stage")?;
        let stage = VoiceStage::parse(stage_text.trim())
            .ok_or_else(|| "The field `voice.stage` must be `rough` or `polished`.".to_string())?;
        let voice = VoiceMeta {
            catalog: number(&fields, "voice.catalog")?,
            pack: required(&fields, "voice.pack")?,
            prompt: required(&fields, "voice.prompt")?,
            stage,
            time_limit_seconds: number(&fields, "voice.timeLimitSeconds")?,
            words: number(&fields, "voice.words")?,
            rough_of: scalar(&fields, "voice.roughOf")?,
        };
        let tags = match fields.get("tags") {
            None => Vec::new(),
            Some(Value::List(items)) => items.clone(),
            Some(Value::Scalar(s)) if s.trim().is_empty() => Vec::new(),
            Some(Value::Scalar(_)) => {
                return Err("The field `tags` must be a list.".into());
            }
        };
        let title = required(&fields, "title")?;
        let subtitle = scalar(&fields, "subtitle")?;
        let slug = required(&fields, "slug")?;
        let date = required(&fields, "date")?;
        let description = scalar(&fields, "description")?;
        for key in KNOWN_KEYS {
            fields.remove(*key);
        }
        let sample = Self {
            title,
            subtitle,
            slug,
            date,
            description,
            tags,
            voice,
            body,
            extra: fields,
        };
        sample.validate()?;
        Ok(sample)
    }

    /// Check every field's domain, in plain sentences naming the field.
    pub fn validate(&self) -> Result<(), String> {
        if self.title.trim().is_empty() {
            return Err("The field `title` is empty.".into());
        }
        if self.title.chars().count() > MAX_TITLE {
            return Err(format!(
                "The field `title` is longer than {MAX_TITLE} characters."
            ));
        }
        no_control("field `title`", &self.title)?;
        if let Some(subtitle) = &self.subtitle {
            if subtitle.chars().count() > MAX_TITLE {
                return Err(format!(
                    "The field `subtitle` is longer than {MAX_TITLE} characters."
                ));
            }
            no_control("field `subtitle`", subtitle)?;
        }
        if !is_kebab(&self.slug) {
            return Err(
                "The field `slug` must be lowercase letters, digits and single hyphens.".into(),
            );
        }
        let date_ok =
            DateTime::parse(&self.date).is_some() && self.date.as_bytes().get(10) == Some(&b'T');
        if !date_ok {
            return Err(
                "The field `date` must be an RFC 3339 date and time such as 2026-10-28T09:30:00Z."
                    .into(),
            );
        }
        if let Some(description) = &self.description {
            if description.chars().count() > MAX_DESCRIPTION {
                return Err(format!(
                    "The field `description` is longer than {MAX_DESCRIPTION} characters."
                ));
            }
            no_control("field `description`", description)?;
        }
        if self.tags.len() > MAX_TAGS {
            return Err(format!("The field `tags` has more than {MAX_TAGS} tags."));
        }
        for tag in &self.tags {
            if tag.trim().is_empty()
                || tag.chars().count() > MAX_TAG
                || tag.contains(',')
                || tag.chars().any(char::is_control)
            {
                return Err(format!(
                    "Each tag must be 1 to {MAX_TAG} characters with no commas or line breaks."
                ));
            }
        }
        let voice = &self.voice;
        if voice.catalog == 0 {
            return Err("The field `voice.catalog` must be 1 or more.".into());
        }
        if voice.catalog > CATALOG_VERSION {
            return Err(format!(
                "This sample uses prompt catalog {}, which is newer than this release understands ({CATALOG_VERSION}). Update open.blog to read it.",
                voice.catalog
            ));
        }
        if !is_kebab(&voice.pack) {
            return Err("The field `voice.pack` must be a lowercase kebab-case id.".into());
        }
        if !is_kebab(&voice.prompt) {
            return Err("The field `voice.prompt` must be a lowercase kebab-case id.".into());
        }
        if voice.time_limit_seconds > MAX_TIME_LIMIT_SECONDS {
            return Err(format!(
                "The field `voice.timeLimitSeconds` cannot be more than {MAX_TIME_LIMIT_SECONDS}."
            ));
        }
        match (voice.stage, &voice.rough_of) {
            (VoiceStage::Polished, None) => {
                return Err(
                    "A polished draft must name its rough draft in `voice.roughOf`.".into(),
                );
            }
            (VoiceStage::Rough, Some(_)) => {
                return Err("A rough draft cannot have `voice.roughOf`; only a polished draft names a rough one.".into());
            }
            (VoiceStage::Rough, None) if voice.time_limit_seconds == 0 => {
                return Err(
                    "A rough draft needs a writing window in `voice.timeLimitSeconds`.".into(),
                );
            }
            _ => {}
        }
        if let Some(rough) = &voice.rough_of {
            match parse_file_name(rough) {
                Some((_, prompt, VoiceStage::Rough)) if prompt == voice.prompt => {}
                _ => {
                    // The value is not echoed: it is input text.
                    return Err("The field `voice.roughOf` must be the file name of this prompt's rough draft.".into());
                }
            }
        }
        if self.body.trim().is_empty() {
            return Err("The sample has no text.".into());
        }
        if self.body.contains('\0') || self.body.contains('\r') {
            return Err(
                "The sample text cannot contain null or carriage-return characters.".into(),
            );
        }
        for key in self.extra.keys() {
            // A known field's name is ours to repeat; any other name came from the file.
            if KNOWN_KEYS.contains(&key.as_str()) {
                return Err(format!(
                    "The extra field `{key}` has a name that cannot be saved."
                ));
            }
            if key.is_empty()
                || key
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control() || c == ':')
            {
                return Err("An extra field has a name that cannot be saved.".into());
            }
        }
        Ok(())
    }

    /// The file text, deterministic for equal samples. Fails if the sample is not valid.
    pub fn serialize(&self) -> Result<String, String> {
        self.validate()?;
        let text = |s: &str| Value::Scalar(s.to_string());
        let number = |n: u32| Value::Scalar(n.to_string());
        let mut fields: Vec<(&str, Value)> = vec![("title", text(&self.title))];
        if let Some(subtitle) = &self.subtitle {
            fields.push(("subtitle", text(subtitle)));
        }
        fields.push(("slug", text(&self.slug)));
        fields.push(("date", text(&self.date)));
        if let Some(description) = &self.description {
            fields.push(("description", text(description)));
        }
        if !self.tags.is_empty() {
            fields.push(("tags", Value::List(self.tags.clone())));
        }
        fields.push(("voice.format", number(FORMAT_VERSION)));
        fields.push(("voice.catalog", number(self.voice.catalog)));
        fields.push(("voice.pack", text(&self.voice.pack)));
        fields.push(("voice.prompt", text(&self.voice.prompt)));
        fields.push(("voice.stage", text(self.voice.stage.as_str())));
        fields.push((
            "voice.timeLimitSeconds",
            number(self.voice.time_limit_seconds),
        ));
        fields.push(("voice.words", number(self.voice.words)));
        if let Some(rough) = &self.voice.rough_of {
            fields.push(("voice.roughOf", text(rough)));
        }
        for (key, value) in &self.extra {
            fields.push((key.as_str(), value.clone()));
        }
        let mut out = frontmatter::serialize(&fields);
        out.push('\n');
        out.push_str(&self.body);
        out.push('\n');
        if out.len() > MAX_FILE_BYTES {
            return Err(format!(
                "The sample is larger than the {} KiB limit.",
                MAX_FILE_BYTES / 1024
            ));
        }
        Ok(out)
    }

    /// This sample's file name.
    pub fn file_name(&self) -> Result<String, String> {
        file_name(&self.date, &self.voice.prompt, self.voice.stage)
            .ok_or_else(|| "The sample's date or prompt id cannot make a file name.".to_string())
    }

    /// A post draft made from this sample, with the `voice` block dropped and `draft: true` so the
    /// site does not publish it. Only a polished draft can become a post; a rough draft stays
    /// untouched, and the draft is a copy. `existing_slugs` are the slugs already used by posts: a
    /// collision is reported, never resolved silently.
    pub fn to_post_draft(&self, existing_slugs: &[&str]) -> Result<PostDraft, String> {
        self.validate()?;
        if self.voice.stage != VoiceStage::Polished {
            return Err("Only a polished draft can become a post draft. Polish this rough draft first; the rough text is never edited.".into());
        }
        if existing_slugs.contains(&self.slug.as_str()) {
            return Err(format!(
                "A post with the slug `{}` already exists. Choose a different slug before making a post draft.",
                self.slug
            ));
        }
        let mut fields: BTreeMap<String, Value> = BTreeMap::new();
        fields.insert("title".into(), Value::Scalar(self.title.clone()));
        if let Some(subtitle) = &self.subtitle {
            fields.insert("subtitle".into(), Value::Scalar(subtitle.clone()));
        }
        fields.insert("slug".into(), Value::Scalar(self.slug.clone()));
        fields.insert("date".into(), Value::Scalar(self.date.clone()));
        if let Some(description) = &self.description {
            fields.insert("description".into(), Value::Scalar(description.clone()));
        }
        if !self.tags.is_empty() {
            fields.insert("tags".into(), Value::List(self.tags.clone()));
        }
        fields.insert("draft".into(), Value::Scalar("true".into()));
        let day = &self.date[..10];
        Ok(PostDraft {
            slug: self.slug.clone(),
            file_name: format!("{day}-{}.md", self.slug),
            markdown: frontmatter::compose(&fields, &self.body),
        })
    }
}

/// Split `---` front matter from the rest. Returns the header including both fences and the body
/// with the one separating blank line and the one final newline removed.
fn split_front_matter(text: &str) -> Result<(&str, String), String> {
    if !text.starts_with("---\n") {
        return Err("The sample must start with a `---` front matter block.".into());
    }
    let mut offset = 4;
    for line in text[4..].split_inclusive('\n') {
        offset += line.len();
        if line.trim_end_matches('\n') == "---" {
            let header = &text[..offset];
            let rest = &text[offset..];
            let rest = rest.strip_prefix('\n').unwrap_or(rest);
            let rest = rest.strip_suffix('\n').unwrap_or(rest);
            return Ok((header, rest.to_string()));
        }
    }
    Err("The front matter block opened with --- but never closed.".into())
}

#[cfg(test)]
mod tests;
