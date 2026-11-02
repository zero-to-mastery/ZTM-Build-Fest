//! Curated public-research selection: the author's explicit, revision-aware
//! choice of which already-publishable research context readers are given
//! (#192, ADR 0185-0190).
//!
//! A selection is one more projection under the publication boundary, never
//! a second one. It adds no approval of its own to research the other
//! projections withhold: it can only select what [`PublicAtlas`],
//! [`PublicComparisons`] and the source library's public description
//! ([`public_reference`]) already publish, and from the selected item only
//! the fields the author lists. The two things a selection can add are
//! text the author writes for it (a source annotation or an explanation,
//! attributed to a named person) and the choice itself. Private notes,
//! rights notes, notebook passages and every unapproved field have no place
//! in these types, so curation cannot publish them.
//!
//! Provenance is only ever copied: a relationship keeps who asserts it, on
//! what evidence, with what confidence and who disputes it; a selection
//! records where imported metadata came from only when the author said so
//! (`unrecorded` otherwise). A missing detail is listed as missing, never
//! filled in.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::atlas_publication::{OwnerType, PublicAtlas, PublicEvidence, PublicParty, PublicSource};
use crate::citations::{format_reference, public_identifier, public_reference, public_url_problem};
use crate::comparison_publication::{
    PublicComparison, PublicComparisons, MAX_PUBLIC_EXCERPT_CHARS,
};
use crate::knowledge_atlas::Atlas;
use crate::source_library::SourceLibrary;

/// The private file's version.
pub const SELECTIONS_VERSION: u64 = 1;
/// Names the public artifact; it has no `version` key, so it is never
/// mistaken for the private selections file.
pub const CURATED_FORMAT: &str = "openblog-curated-context";
/// The only public curated-context format version this release writes.
pub const CURATED_FORMAT_VERSION: u64 = 1;
/// The private file, relative to the project root.
pub const SELECTIONS_FILE: &str = ".openblog/private/research/selections.json";
/// The longest annotation or explanation, in characters: a comment, never a
/// republished stretch of a source.
pub const MAX_TEXT_CHARS: usize = MAX_PUBLIC_EXCERPT_CHARS;
/// The most selections one file holds.
pub const MAX_SELECTIONS: usize = 5_000;
/// The largest selections file, in bytes: the library's limit.
pub const MAX_SELECTIONS_BYTES: usize = 4 * 1024 * 1024;

/// The most selections one selection may require. A cap keeps resolving a
/// hostile file linear in its size.
pub const MAX_REQUIRES: usize = 32;
/// The most posts one selection may be scoped to.
pub const MAX_POSTS: usize = 50;
/// The most posts one selection may be ordered in.
pub const MAX_POSITIONS: usize = 500;

const CREDIT_FIELDS: &[&str] = &["credit", "credits", "contributor", "contributors"];
const MAX_ID: usize = 64;
const MAX_POST: usize = 200;
const MAX_TARGET: usize = 120;
const MAX_SHORT: usize = 200;

// ---------------------------------------------------------------- the records

/// What a selection selects. The distinctions of the research model survive:
/// a reference is a source's public description, never a citation of it; an
/// annotation is attributed commentary on a source, never a note; an
/// explanation is attributed prose about a contextual entry, never a claim.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SelectionKind {
    /// A source of the library, by its public description.
    Reference,
    /// An approved, published atlas entry.
    ContextualEntry,
    /// A published atlas relationship, with its endpoints and evidence.
    Relationship,
    /// One published dating, with who dates it and on what evidence.
    Timeline,
    /// A published passage comparison.
    Comparison,
    /// The author's attributed text about a source.
    SourceAnnotation,
    /// The author's attributed text about a published entry.
    Explanation,
}

/// The fields a kind of selection may list.
struct Spec {
    /// Always part of the published item; not listed in `fields`.
    identity: &'static [&'static str],
    /// Listed in every selection of the kind: attribution, uncertainty and
    /// evidence cannot be left out of what readers are given.
    required: &'static [&'static str],
    /// Listed only when the author chooses them.
    optional: &'static [&'static str],
}

impl SelectionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reference => "reference",
            Self::ContextualEntry => "contextual-entry",
            Self::Relationship => "relationship",
            Self::Timeline => "timeline",
            Self::Comparison => "comparison",
            Self::SourceAnnotation => "source-annotation",
            Self::Explanation => "explanation",
        }
    }

    fn spec(self) -> Spec {
        match self {
            Self::Reference => Spec {
                identity: &["key", "kind"],
                required: &["creators", "title"],
                optional: &["csl", "identifiers", "issued", "language"],
            },
            Self::ContextualEntry => Spec {
                identity: &["id", "kind", "label", "url"],
                required: &[],
                optional: &["aliases", "source", "summary"],
            },
            Self::Relationship => Spec {
                identity: &["id", "kind", "from", "to", "label", "inverseLabel"],
                required: &[
                    "assertedBy",
                    "confidence",
                    "contestedBy",
                    "evidence",
                    "standing",
                    "uncertainty",
                ],
                optional: &[],
            },
            Self::Timeline => Spec {
                identity: &["id", "owner", "ownerType", "aspect"],
                required: &[
                    "assertedBy",
                    "confidence",
                    "date",
                    "evidence",
                    "note",
                    "placement",
                    "text",
                ],
                optional: &["endYear", "startYear"],
            },
            Self::Comparison => Spec {
                identity: &["id", "label", "url"],
                required: &[
                    "confidence",
                    "correspondence",
                    "correspondenceLabel",
                    "evidence",
                    "rationale",
                    "recordedBy",
                    "uncertainty",
                    "versions",
                ],
                optional: &["wording"],
            },
            Self::SourceAnnotation | Self::Explanation => Spec {
                identity: &[],
                required: &["by", "text"],
                optional: &["locator"],
            },
        }
    }

    fn has_text(self) -> bool {
        matches!(self, Self::SourceAnnotation | Self::Explanation)
    }
}

/// Whether a selection is live. Withdrawing keeps the record, so the author
/// sees what they withdrew and can select it again.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SelectionState {
    #[default]
    Selected,
    Withdrawn,
}

/// Where the selected metadata came from, as the author states it. Nothing
/// is inferred: a selection with no statement says `unrecorded`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "origin")]
pub enum Provenance {
    Authored,
    Imported {
        from: String,
    },
    #[default]
    Unrecorded,
}

/// One stored selection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    /// Stable identity of the selection, a lowercase slug.
    pub id: String,
    pub kind: SelectionKind,
    /// The id of what is selected: a source key, entry, relationship,
    /// dating or comparison id; for an annotation the source, for an
    /// explanation the entry.
    pub target: String,
    /// The fingerprint of the selected item and its dependencies as the
    /// author saw them when they selected it. It no longer matching makes
    /// the selection stale; it is then withheld until selected again.
    pub revision: String,
    /// The public fields the author selected: every required field of the
    /// kind, and the optional ones chosen.
    pub fields: Vec<String>,
    #[serde(default, skip_serializing_if = "is_default")]
    pub state: SelectionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withdrawn_reason: Option<String>,
    /// For an annotation or explanation: the words the author approves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Who the text is attributed to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    /// Where in the source the annotation applies, as the author words it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locator: Option<String>,
    #[serde(default, skip_serializing_if = "is_default")]
    pub provenance: Provenance,
    /// Selections that must be published with this one. A cycle, an
    /// unknown id or a withheld requirement withholds this selection.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
    /// The posts this selection is for, by slug. Absent means the whole site,
    /// which is also what a record written without the field means: it is
    /// offered to every post, exactly as it was before posts were named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posts: Option<Vec<String>>,
    /// Where the selection sits among the items of each post, lowest first,
    /// by post slug. A post's order is its own: ordering one post's items
    /// never changes where an item sits for another post, even a whole-site
    /// item both are offered. A post with no entry sorts the item after every
    /// positioned one; ties break by id. Order is presentation, not content,
    /// so it is not part of the revision a selection records.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub positions: BTreeMap<String, u32>,
    /// Fields this release does not understand, preserved verbatim and
    /// never published.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn is_default<T: Default + PartialEq>(value: &T) -> bool {
    *value == T::default()
}

/// The private selections file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectionSet {
    pub version: u64,
    pub selections: Vec<Selection>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for SelectionSet {
    fn default() -> Self {
        Self {
            version: SELECTIONS_VERSION,
            selections: Vec::new(),
            extra: BTreeMap::new(),
        }
    }
}

// ---------------------------------------------------------------- diagnostics of the file

/// What is wrong with a selection record or an attempt to select.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Code {
    InvalidJson,
    UnsupportedVersion,
    TooLarge,
    TooMany,
    BadId,
    DuplicateId,
    BadTarget,
    BadRevision,
    FieldNotAllowed,
    RequiredFieldMissing,
    TextRequired,
    TextNotAllowed,
    TextTooLong,
    UnsafeText,
    AttributionRequired,
    BadProvenance,
    BadRequires,
    BadPosts,
    /// Changing where a stale selection appears; select it again first.
    StaleSelection,
    /// A contributor credit belongs in a `.credits.json` sidecar.
    ContributorCredit,
    /// An attempt to select something the projections do not publish.
    TargetNotPublished,
    /// An attempt to select a selection that does not exist.
    UnknownSelection,
}

/// A problem with one record, naming its id and field, never its text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    pub code: Code,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub message: String,
}

fn diag(code: Code, id: Option<&str>, field: Option<&str>, message: String) -> Diagnostic {
    Diagnostic {
        code,
        id: id.map(str::to_string),
        field: field.map(str::to_string),
        message,
    }
}

fn safe_slug(text: &str, max: usize) -> bool {
    !text.is_empty()
        && text.len() <= max
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !text.starts_with('-')
}

fn safe_target(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= MAX_TARGET
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'~' | b'-'))
}

/// A post slug as `slug::slugify` writes one: letters and digits of any
/// script, joined by single hyphens.
fn safe_post(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= MAX_POST
        && text.chars().all(|c| c.is_alphanumeric() || c == '-')
        && !text.starts_with('-')
}

fn is_revision(text: &str) -> bool {
    text.len() == 16 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Control and bidirectional-override characters never belong in text a
/// reader is given; plain newlines do.
fn unsafe_char(c: char) -> bool {
    (c.is_control() && c != '\n')
        || matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

fn check_short(
    code: Code,
    id: &str,
    field: &str,
    text: &str,
    max: usize,
    out: &mut Vec<Diagnostic>,
) {
    if text.trim().is_empty() || text.chars().count() > max || text.chars().any(unsafe_char) {
        out.push(diag(
            code,
            Some(id),
            Some(field),
            format!("Selection `{id}`: `{field}` must be 1 to {max} characters with no control or direction-override characters."),
        ));
    }
}

/// Every problem with one record on its own, against the rules of its kind.
pub fn validate(selection: &Selection) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    let id = selection.id.as_str();
    if !safe_slug(id, MAX_ID) {
        out.push(diag(
            Code::BadId,
            None,
            Some("id"),
            "A selection id must be a lowercase slug of at most 64 characters.".into(),
        ));
        return out;
    }
    let kind = selection.kind;
    if !safe_target(&selection.target) {
        out.push(diag(
            Code::BadTarget,
            Some(id),
            Some("target"),
            format!("Selection `{id}`: `target` must be 1 to {MAX_TARGET} letters, digits or `. _ : ~ -`."),
        ));
    }
    if !is_revision(&selection.revision) {
        out.push(diag(
            Code::BadRevision,
            Some(id),
            Some("revision"),
            format!("Selection `{id}`: `revision` must be a 16-digit hex fingerprint recorded when the item was selected."),
        ));
    }
    let spec = kind.spec();
    let allowed: BTreeSet<&str> = spec.required.iter().chain(spec.optional).copied().collect();
    let listed: BTreeSet<&str> = selection.fields.iter().map(String::as_str).collect();
    for field in &listed {
        if !allowed.contains(field) {
            out.push(diag(
                Code::FieldNotAllowed,
                Some(id),
                Some(field),
                format!(
                    "Selection `{id}`: `{field}` is not a field a {} selection can publish.",
                    kind.as_str()
                ),
            ));
        }
    }
    for field in spec.required {
        if !listed.contains(field) {
            out.push(diag(
                Code::RequiredFieldMissing,
                Some(id),
                Some(field),
                format!("Selection `{id}`: a {} selection always publishes `{field}`, so it must be listed.", kind.as_str()),
            ));
        }
    }
    match (&selection.text, kind.has_text()) {
        (Some(text), true) => {
            check_short(Code::UnsafeText, id, "text", text, MAX_TEXT_CHARS, &mut out);
            if text.chars().count() > MAX_TEXT_CHARS {
                out.push(diag(
                    Code::TextTooLong,
                    Some(id),
                    Some("text"),
                    format!("Selection `{id}`: `text` is longer than {MAX_TEXT_CHARS} characters; a source's own words belong in a rights-gated comparison."),
                ));
            }
        }
        (None, true) => out.push(diag(
            Code::TextRequired,
            Some(id),
            Some("text"),
            format!("Selection `{id}`: a {} needs the words the author approves.", kind.as_str()),
        )),
        (Some(_), false) => out.push(diag(
            Code::TextNotAllowed,
            Some(id),
            Some("text"),
            format!("Selection `{id}`: only an annotation or an explanation carries text; other kinds publish the approved item's own fields."),
        )),
        (None, false) => {}
    }
    if kind.has_text() {
        match &selection.by {
            Some(by) => check_short(Code::AttributionRequired, id, "by", by, MAX_SHORT, &mut out),
            None => out.push(diag(
                Code::AttributionRequired,
                Some(id),
                Some("by"),
                format!("Selection `{id}`: text is always attributed; `by` names who wrote it."),
            )),
        }
        if let Some(locator) = &selection.locator {
            check_short(
                Code::UnsafeText,
                id,
                "locator",
                locator,
                MAX_SHORT,
                &mut out,
            );
        }
    } else if selection.by.is_some() || selection.locator.is_some() {
        out.push(diag(
            Code::TextNotAllowed,
            Some(id),
            Some("by"),
            format!(
                "Selection `{id}`: `by` and `locator` belong only to an annotation or explanation."
            ),
        ));
    }
    if let Provenance::Imported { from } = &selection.provenance {
        check_short(
            Code::BadProvenance,
            id,
            "provenance.from",
            from,
            MAX_SHORT,
            &mut out,
        );
    }
    if let Some(reason) = &selection.withdrawn_reason {
        check_short(
            Code::UnsafeText,
            id,
            "withdrawnReason",
            reason,
            500,
            &mut out,
        );
    }
    if selection.requires.len() > MAX_REQUIRES {
        out.push(diag(
            Code::BadRequires,
            Some(id),
            Some("requires"),
            format!("Selection `{id}`: `requires` names at most {MAX_REQUIRES} other selections."),
        ));
    }
    for required in selection.requires.iter().take(MAX_REQUIRES + 1) {
        if required == id || !safe_slug(required, MAX_ID) {
            out.push(diag(
                Code::BadRequires,
                Some(id),
                Some("requires"),
                format!("Selection `{id}`: `requires` names other selections by id, never itself."),
            ));
            break;
        }
    }
    if let Some(posts) = &selection.posts {
        let mut seen = BTreeSet::new();
        let bad = posts.is_empty()
            || posts.len() > MAX_POSTS
            || posts
                .iter()
                .any(|post| !safe_post(post) || !seen.insert(post));
        if bad {
            out.push(diag(
                Code::BadPosts,
                Some(id),
                Some("posts"),
                format!("Selection `{id}`: `posts` names 1 to {MAX_POSTS} different posts by slug; leave it out to offer the selection to the whole site."),
            ));
        }
    }
    let scoped_outside = |post: &String| {
        selection
            .posts
            .as_ref()
            .is_some_and(|posts| !posts.contains(post))
    };
    if selection.positions.len() > MAX_POSITIONS
        || selection
            .positions
            .keys()
            .any(|post| !safe_post(post) || scoped_outside(post))
    {
        out.push(diag(
            Code::BadPosts,
            Some(id),
            Some("positions"),
            format!("Selection `{id}`: `positions` orders the selection among the items of posts it is offered to, by slug, at most {MAX_POSITIONS} of them."),
        ));
    }
    for key in selection
        .extra
        .keys()
        .filter(|k| CREDIT_FIELDS.contains(&k.as_str()))
    {
        out.push(diag(
            Code::ContributorCredit,
            Some(id),
            Some(key),
            "contributor credits stay in `.credits.json` sidecars".into(),
        ));
    }
    out
}

impl SelectionSet {
    /// Read the private file. Every record is checked; the first problems
    /// are returned together, each naming its record.
    pub fn parse(text: &str) -> Result<Self, Vec<Diagnostic>> {
        if text.len() > MAX_SELECTIONS_BYTES {
            return Err(vec![diag(
                Code::TooLarge,
                None,
                None,
                format!("The selections file is larger than {MAX_SELECTIONS_BYTES} bytes."),
            )]);
        }
        let mut set: SelectionSet = serde_json::from_str(text).map_err(|error| {
            vec![diag(
                Code::InvalidJson,
                None,
                None,
                format!(
                    "The selections file is not valid: {}.",
                    first_words(&error.to_string())
                ),
            )]
        })?;
        if set.version != SELECTIONS_VERSION {
            return Err(vec![diag(
                Code::UnsupportedVersion,
                None,
                Some("version"),
                format!("The selections file is version {}; this release reads version {SELECTIONS_VERSION}.", set.version),
            )]);
        }
        if set.selections.len() > MAX_SELECTIONS {
            return Err(vec![diag(
                Code::TooMany,
                None,
                Some("selections"),
                format!("The selections file holds more than {MAX_SELECTIONS} selections."),
            )]);
        }
        let mut out = Vec::new();
        for key in set
            .extra
            .keys()
            .filter(|k| CREDIT_FIELDS.contains(&k.as_str()))
        {
            out.push(diag(
                Code::ContributorCredit,
                None,
                Some(key),
                "contributor credits stay in `.credits.json` sidecars".into(),
            ));
        }
        let mut seen = BTreeSet::new();
        for selection in &mut set.selections {
            selection.fields.sort();
            selection.fields.dedup();
            out.extend(validate(selection));
            if !seen.insert(selection.id.clone()) && safe_slug(&selection.id, MAX_ID) {
                out.push(diag(
                    Code::DuplicateId,
                    Some(&selection.id),
                    Some("id"),
                    format!("Selection id `{}` is used more than once.", selection.id),
                ));
            }
        }
        if out.is_empty() {
            set.selections.sort_by(|a, b| a.id.cmp(&b.id));
            Ok(set)
        } else {
            Err(out)
        }
    }

    /// The file as written: records in id order, so saving never reorders
    /// for nothing.
    pub fn to_json(&self) -> String {
        let mut copy = self.clone();
        copy.selections.sort_by(|a, b| a.id.cmp(&b.id));
        let mut text = serde_json::to_string_pretty(&copy).unwrap_or_default();
        text.push('\n');
        text
    }

    pub fn get(&self, id: &str) -> Option<&Selection> {
        self.selections.iter().find(|s| s.id == id)
    }
}

/// Whether a parsed JSON object has the shape of a selections file, judged by
/// structure only (a version number and a non-empty `selections` array of
/// objects that each carry `id`, `kind`, `target` and `revision`), so a copy
/// saved into a public folder can be refused.
pub fn looks_like_selections(root: &Map<String, Value>) -> bool {
    if root.get("version").and_then(Value::as_u64).is_none() {
        return false;
    }
    let Some(selections) = root.get("selections").and_then(Value::as_array) else {
        return false;
    };
    let selection_like = |item: &Value| {
        ["id", "kind", "target", "revision"]
            .iter()
            .all(|key| item.get(key).is_some_and(Value::is_string))
    };
    !selections.is_empty() && selections.iter().all(selection_like)
}

fn first_words(text: &str) -> String {
    // serde_json's message may quote input; keep only the part before it.
    text.split(" at line")
        .next()
        .unwrap_or("")
        .chars()
        .take(80)
        .collect()
}

// ---------------------------------------------------------------- what is publishable

/// The ids of private items that exist, approved or not, so a deleted item
/// is told apart from one that is simply not approved. Each store is tracked
/// on its own: a store that was not read (`None`) says nothing about what it
/// holds, so an item of it is reported as not published, never as missing.
#[derive(Clone, Debug, Default)]
pub struct Existing {
    pub entries: Option<BTreeSet<String>>,
    pub relationships: Option<BTreeSet<String>>,
    pub datings: Option<BTreeSet<String>>,
    pub comparisons: Option<BTreeSet<String>>,
}

impl Existing {
    pub fn of(atlas: Option<&Atlas>, alignments: Option<&crate::alignment::AlignmentSet>) -> Self {
        Self {
            entries: atlas.map(|a| a.entries.iter().map(|e| e.id.clone()).collect()),
            relationships: atlas.map(|a| a.relationships.iter().map(|r| r.id.clone()).collect()),
            datings: atlas.map(|a| {
                a.all_datings()
                    .into_iter()
                    .map(|(_, dating)| dating.id.clone())
                    .collect()
            }),
            comparisons: alignments
                .map(|set| set.alignments.iter().map(|a| a.id.clone()).collect()),
        }
    }
}

/// What selections are resolved against: the values the build already
/// renders, and nothing private.
#[derive(Clone, Copy, Default)]
pub struct Basis<'a> {
    pub atlas: Option<&'a PublicAtlas>,
    pub comparisons: Option<&'a PublicComparisons>,
    pub library: Option<&'a SourceLibrary>,
    pub existing: Option<&'a Existing>,
    /// The ids of the sources that are already public: cited by a published
    /// post, or published by the atlas or a comparison. A reference or a
    /// source annotation may select only these (selecting never approves).
    /// `None` means no source is known to be public.
    pub public_sources: Option<&'a BTreeSet<String>>,
    /// The slugs of the posts the build publishes. A selection scoped to
    /// posts is offered only to those, and never names any other, so a draft
    /// is not disclosed. `None` means no post is known to be published.
    pub posts: Option<&'a BTreeSet<String>>,
}

/// Why a selection publishes nothing. Each is a rule, never a judgement.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Why {
    /// The author withdrew it.
    Withdrawn,
    /// What it selects no longer exists.
    TargetMissing,
    /// What it selects exists but its own projection does not publish it
    /// (not approved, or the projection is off).
    NotApproved,
    /// Cannot be told whether it is missing or not approved.
    NotPublished,
    /// What was selected, or something it depends on, changed since.
    Stale,
    /// A reference or annotation of a source that is not already public.
    SourcePrivate,
    /// It is scoped to posts and none of them is published.
    PostNotPublished,
    /// A source, endpoint or required selection it needs is not there.
    DependencyMissing,
    /// A required selection is itself withheld.
    DependencyWithheld,
    /// Its `requires` lead back to it.
    Cycle,
}

/// One selection that publishes nothing, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WithheldSelection {
    pub id: String,
    pub kind: SelectionKind,
    pub target: String,
    pub why: Why,
    /// One sentence naming ids and fields only.
    pub message: String,
}

/// A caveat on a published selection: nothing is blocked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoticeCode {
    /// The selected wording is withheld by its version's rights statement
    /// or length, as the comparison's own projection withholds it.
    RightsRestricted,
    /// A web address or identifier of a reference is not published.
    UnsafeUrl,
    PrivateIdentifier,
    /// The author did not say where imported metadata came from.
    ProvenanceUnrecorded,
    /// A selected field the source does not have; it is not invented.
    MissingDetail,
    /// Another dating of the same aspect is published but not selected.
    CompetingUnselected,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: String,
    pub code: NoticeCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub message: String,
}

// ---------------------------------------------------------------- the public projection

/// One published selection, with only the selected fields.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuratedItem {
    /// The selection's stable id: the anchor readers and links use.
    pub id: String,
    pub kind: SelectionKind,
    pub target: String,
    /// The revision that was selected, which is the one published.
    pub revision: String,
    /// The item's identity fields and the fields the author selected, as the
    /// projection that publishes it names them.
    pub content: BTreeMap<String, Value>,
    pub provenance: Provenance,
    /// Fields selected that the source lacks. Never filled in.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
    /// The published posts the item is scoped to; empty means the whole site.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub posts: Vec<String>,
    /// Its place among the items of each published post that orders it.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub positions: BTreeMap<String, u32>,
    /// What a reader or an author should know of the item that is not in its
    /// fields: a competing dating that is not selected, a detail the source
    /// lacks, metadata whose origin is not recorded.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<ItemNotice>,
}

/// A caveat carried by a published item. Names ids and fields only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemNotice {
    pub code: NoticeCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub message: String,
}

impl NoticeCode {
    /// Whether the caveat travels with the published item (and shows in the
    /// preview). The others are already a withheld field of the item.
    pub fn travels_with_item(self) -> bool {
        matches!(
            self,
            Self::CompetingUnselected | Self::MissingDetail | Self::ProvenanceUnrecorded
        )
    }
}

impl PublicCuration {
    /// The items a post is offered, in the order readers get them: the
    /// whole-site items and those scoped to this post, by this post's own
    /// position then id (an item this post has not ordered goes last).
    pub fn for_post(&self, post: &str) -> Vec<&CuratedItem> {
        let mut items: Vec<&CuratedItem> = self
            .items
            .iter()
            .filter(|item| item.posts.is_empty() || item.posts.iter().any(|p| p == post))
            .collect();
        items.sort_by(|a, b| {
            item_order(a, Some(post))
                .cmp(&item_order(b, Some(post)))
                .then(a.id.cmp(&b.id))
        });
        items
    }
}

/// An item's place for one post, or the unordered rest.
fn item_order(item: &CuratedItem, post: Option<&str>) -> u32 {
    post.and_then(|post| item.positions.get(post))
        .copied()
        .unwrap_or(u32::MAX)
}

/// What a context item is: the minimum a reader needs to understand an
/// item, never more than the projection that approved it publishes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContextKind {
    Entry,
    Relationship,
    Source,
}

/// An approved dependency of a selected item, included with it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub kind: ContextKind,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// For a source, its public description and plain-text rendering.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<PublicSource>,
    /// The selections that need it.
    pub via: Vec<String>,
}

/// The curated projection every public representation of curated context
/// reads (#197 renders it).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicCuration {
    pub format: &'static str,
    pub format_version: u64,
    /// Sorted by (first post, that post's position, id): whole-site items
    /// first, then each post's, each in the order its author set. [`Self::for_post`] gives
    /// one post's order.
    pub items: Vec<CuratedItem>,
    /// Sorted by kind then id; never holds a selected item twice.
    pub context: Vec<ContextItem>,
}

/// The outcome of resolving the selections against what is published.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolution {
    pub curation: PublicCuration,
    pub withheld: Vec<WithheldSelection>,
    pub notices: Vec<Notice>,
}

// ---------------------------------------------------------------- evaluation

#[derive(Default)]
struct Deps {
    entries: BTreeSet<String>,
    relationships: BTreeSet<String>,
    sources: BTreeSet<String>,
}

struct Evaluated {
    value: Value,
    deps: Deps,
    revision: String,
    notices: Vec<(NoticeCode, Option<String>, String)>,
    missing: Vec<String>,
}

/// A short fingerprint of a canonical list of explicit name/value pairs.
/// Every pair is length-prefixed, so no two lists feed the hash the same
/// bytes. A fingerprint is only ever compared with another made by this same
/// engine: an upgrade that changes how an item is projected may make
/// selections stale, and the author selects them again (ADR 0186).
fn fingerprint(pairs: &[(String, String)]) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash = (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3);
        }
    };
    for (name, value) in pairs {
        feed(name.as_bytes());
        feed(&[0x1f]);
        feed(value.len().to_string().as_bytes());
        feed(&[0x1e]);
        feed(value.as_bytes());
        feed(&[0xff]);
    }
    format!("{hash:016x}")
}

fn json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn party_source(party: &PublicParty, deps: &mut Deps) {
    if let Some(source) = &party.source {
        deps.sources.insert(source.clone());
    }
}

fn evidence_sources(evidence: &[PublicEvidence], deps: &mut Deps) {
    for item in evidence {
        deps.sources.insert(item.source.clone());
    }
}

fn source_public(basis: &Basis<'_>, id: &str) -> Option<PublicSource> {
    let record = basis.library?.get(id)?;
    let reference = public_reference(record);
    let text = format_reference(&reference);
    Some(PublicSource { reference, text })
}

type Failure = (Why, String);

fn not_published(basis: &Basis<'_>, kind: SelectionKind, sel: &Selection) -> Failure {
    let (id, kind_name) = (&sel.target, kind.as_str());
    // `None` when the store was not read: nothing is known of what it holds.
    let existing = match kind {
        SelectionKind::ContextualEntry | SelectionKind::Explanation => basis
            .existing
            .and_then(|e| e.entries.as_ref())
            .map(|set| set.contains(id)),
        SelectionKind::Relationship => basis
            .existing
            .and_then(|e| e.relationships.as_ref())
            .map(|set| set.contains(id)),
        SelectionKind::Timeline => basis
            .existing
            .and_then(|e| e.datings.as_ref())
            .map(|set| set.contains(id)),
        SelectionKind::Comparison => basis
            .existing
            .and_then(|e| e.comparisons.as_ref())
            .map(|set| set.contains(id)),
        SelectionKind::Reference | SelectionKind::SourceAnnotation => {
            basis.library.map(|library| library.get(id).is_some())
        }
    };
    match existing {
        Some(false) => (
            Why::TargetMissing,
            format!("Selection `{}`: the {kind_name} `{id}` no longer exists.", sel.id),
        ),
        Some(true) => (
            Why::NotApproved,
            format!("Selection `{}`: the {kind_name} `{id}` is not published (not approved, or its projection is off), so it stays private.", sel.id),
        ),
        None => (
            Why::NotPublished,
            format!("Selection `{}`: the {kind_name} `{id}` is not in what the build publishes.", sel.id),
        ),
    }
}

/// A source that exists but is not already public.
fn private_source(sel: &Selection) -> Failure {
    (
        Why::SourcePrivate,
        format!(
            "Selection `{}`: the source `{}` is not cited by a published post or published by the atlas or a comparison, so it stays private; selecting never approves it.",
            sel.id, sel.target
        ),
    )
}

fn evaluate(sel: &Selection, basis: &Basis<'_>) -> Result<Evaluated, Failure> {
    let kind = sel.kind;
    let mut deps = Deps::default();
    let mut notices = Vec::new();
    let mut missing = Vec::new();
    let target = sel.target.as_str();
    let miss = || not_published(basis, kind, sel);
    let entry = |id: &str| {
        basis
            .atlas
            .and_then(|a| a.entries.iter().find(|e| e.id == id))
    };
    let source_is_public = || basis.public_sources.is_some_and(|set| set.contains(target));
    let mut value = match kind {
        SelectionKind::Reference => {
            let record = basis.library.and_then(|l| l.get(target)).ok_or_else(miss)?;
            if !source_is_public() {
                return Err(private_source(sel));
            }
            let reference = public_reference(record);
            for identifier in &record.identifiers {
                let field = format!("identifiers.{}", identifier.scheme);
                if !public_identifier(&identifier.scheme, &identifier.value) {
                    notices.push((
                        NoticeCode::PrivateIdentifier,
                        Some(field),
                        format!("Selection `{}`: the `{}` identifier of source `{target}` is not in a public scheme or form, so it is not published.", sel.id, identifier.scheme),
                    ));
                } else if identifier.scheme == "url"
                    && public_url_problem(&identifier.value).is_some()
                {
                    notices.push((
                        NoticeCode::UnsafeUrl,
                        Some(field),
                        format!("Selection `{}`: the web address of source `{target}` is not a public address, so it is not published.", sel.id),
                    ));
                }
            }
            json(&reference)
        }
        SelectionKind::ContextualEntry | SelectionKind::Explanation => {
            let found = entry(target).ok_or_else(miss)?;
            if let Some(source) = &found.source {
                deps.sources.insert(source.clone());
            }
            deps.entries.insert(found.id.clone());
            json(found)
        }
        SelectionKind::Relationship => {
            let found = basis
                .atlas
                .and_then(|a| a.relationship(target))
                .ok_or_else(miss)?;
            deps.entries.insert(found.from.clone());
            deps.entries.insert(found.to.clone());
            party_source(&found.asserted_by, &mut deps);
            evidence_sources(&found.evidence, &mut deps);
            for dissent in &found.contested_by {
                party_source(&dissent.by, &mut deps);
                evidence_sources(&dissent.evidence, &mut deps);
            }
            json(found)
        }
        SelectionKind::Timeline => {
            let found = basis
                .atlas
                .and_then(|a| a.datings.iter().find(|d| d.id == target))
                .ok_or_else(miss)?;
            // The dating says what it dates; an entry and a relationship may
            // share an id, so the id alone never decides.
            match found.owner_type {
                OwnerType::Relationship => {
                    deps.relationships.insert(found.owner.clone());
                    if let Some(owner) = basis.atlas.and_then(|a| a.relationship(&found.owner)) {
                        deps.entries.insert(owner.from.clone());
                        deps.entries.insert(owner.to.clone());
                    }
                }
                OwnerType::Entry => {
                    deps.entries.insert(found.owner.clone());
                }
            }
            if let Some(relative) = &found.date.relative {
                deps.entries.insert(relative.entry.clone());
            }
            party_source(&found.asserted_by, &mut deps);
            evidence_sources(&found.evidence, &mut deps);
            json(found)
        }
        SelectionKind::Comparison => {
            let found: &PublicComparison = basis
                .comparisons
                .and_then(|c| c.comparisons.iter().find(|c| c.id == target))
                .ok_or_else(miss)?;
            party_source(&found.recorded_by, &mut deps);
            evidence_sources(&found.evidence, &mut deps);
            for version in &found.versions {
                deps.sources.insert(version.source.clone());
            }
            json(found)
        }
        SelectionKind::SourceAnnotation => {
            let record = basis.library.and_then(|l| l.get(target)).ok_or_else(miss)?;
            if !source_is_public() {
                return Err(private_source(sel));
            }
            deps.sources.insert(record.id.clone());
            json(&public_reference(record))
        }
    };
    // The text the author approved is part of the item for its revision. A
    // locator is the author's wording like the rest, but only when listed.
    let subject_json = value.to_string();
    let listed: BTreeSet<&str> = sel.fields.iter().map(String::as_str).collect();
    let authored: Vec<(&str, &String)> = if kind.has_text() {
        [
            ("text", sel.text.as_ref()),
            ("by", sel.by.as_ref()),
            (
                "locator",
                sel.locator.as_ref().filter(|_| listed.contains("locator")),
            ),
        ]
        .into_iter()
        .filter_map(|(name, text)| text.map(|text| (name, text)))
        .collect()
    } else {
        Vec::new()
    };
    if kind.has_text() {
        let mut map = Map::new();
        map.insert("subject".into(), Value::String(sel.target.clone()));
        for (name, text) in &authored {
            map.insert((*name).into(), Value::String((*text).clone()));
        }
        value = Value::Object(map);
    }
    // The revision: a canonical list of explicit name/value pairs. Everything
    // the author chose and everything the item depends on is in it.
    let mut pairs: Vec<(String, String)> = vec![
        ("kind".into(), kind.as_str().into()),
        ("target".into(), sel.target.clone()),
        ("subject".into(), subject_json),
        (
            "fields".into(),
            listed.iter().copied().collect::<Vec<_>>().join(","),
        ),
        ("provenance".into(), json(&sel.provenance).to_string()),
    ];
    for (name, text) in &authored {
        pairs.push(((*name).into(), (*text).clone()));
    }
    let sorted = |items: &[String]| {
        let mut items = items.to_vec();
        items.sort();
        items.dedup();
        items.join(",")
    };
    pairs.push(("requires".into(), sorted(&sel.requires)));
    if let Some(posts) = &sel.posts {
        pairs.push(("posts".into(), sorted(posts)));
    }
    // Order is presentation, not content: it is deliberately not part of the
    // revision, so ordering one post never makes a selection stale and a
    // stale selection can keep its place.
    // Dependencies, each checked against what is published.
    for id in &deps.entries {
        let found = entry(id).ok_or_else(|| {
            (
                Why::DependencyMissing,
                format!(
                    "Selection `{}`: the entry `{id}` it needs is not published.",
                    sel.id
                ),
            )
        })?;
        pairs.push((format!("entry:{id}"), json(found).to_string()));
    }
    for id in &deps.relationships {
        let found = basis
            .atlas
            .and_then(|a| a.relationship(id))
            .ok_or_else(|| {
                (
                    Why::DependencyMissing,
                    format!(
                        "Selection `{}`: the relationship `{id}` it needs is not published.",
                        sel.id
                    ),
                )
            })?;
        pairs.push((format!("relationship:{id}"), json(found).to_string()));
    }
    for id in &deps.sources {
        let found = source_public(basis, id).ok_or_else(|| {
            (
                Why::DependencyMissing,
                format!(
                    "Selection `{}`: the source `{id}` it needs is not in the source library.",
                    sel.id
                ),
            )
        })?;
        pairs.push((format!("source:{id}"), json(&found).to_string()));
    }
    let revision = fingerprint(&pairs);
    // Keep identity and the selected fields; list what the source lacks.
    let spec = kind.spec();
    if let Value::Object(map) = &mut value {
        let selected: BTreeSet<&str> = sel.fields.iter().map(String::as_str).collect();
        if !kind.has_text() {
            // A reference or entry that lacks a selected field is told so;
            // for the other kinds an absent list (no dissent, no doubt) is
            // an answer, not a gap.
            if matches!(
                kind,
                SelectionKind::Reference | SelectionKind::ContextualEntry
            ) {
                for field in &sel.fields {
                    if !map.contains_key(field.as_str()) {
                        missing.push(field.clone());
                    }
                }
            }
            map.retain(|name, _| {
                spec.identity.contains(&name.as_str()) || selected.contains(name.as_str())
            });
        }
        if kind == SelectionKind::Comparison && !selected.contains("wording") {
            strip_wording(map);
        }
        if kind == SelectionKind::Comparison && selected.contains("wording") {
            note_withheld_wording(sel, map, &mut notices);
        }
    }
    if sel.provenance == Provenance::Unrecorded && kind == SelectionKind::Reference {
        notices.push((
            NoticeCode::ProvenanceUnrecorded,
            Some("provenance".into()),
            format!("Selection `{}`: where this metadata came from is not recorded, and is published as unrecorded.", sel.id),
        ));
    }
    for field in &missing {
        notices.push((
            NoticeCode::MissingDetail,
            Some(field.clone()),
            format!("Selection `{}`: `{field}` is selected but the source has none; it is left out, not invented.", sel.id),
        ));
    }
    Ok(Evaluated {
        value,
        deps,
        revision,
        notices,
        missing,
    })
}

fn strip_wording(map: &mut Map<String, Value>) {
    if let Some(Value::Array(versions)) = map.get_mut("versions") {
        for version in versions {
            if let Some(Value::Array(places)) = version.get_mut("places") {
                for place in places {
                    if let Value::Object(place) = place {
                        place.remove("text");
                        place.remove("normalized");
                        place.remove("withheld");
                    }
                }
            }
        }
    }
}

fn note_withheld_wording(
    sel: &Selection,
    map: &Map<String, Value>,
    notices: &mut Vec<(NoticeCode, Option<String>, String)>,
) {
    let Some(Value::Array(versions)) = map.get("versions") else {
        return;
    };
    for (v, version) in versions.iter().enumerate() {
        let Some(Value::Array(places)) = version.get("places") else {
            continue;
        };
        for (p, place) in places.iter().enumerate() {
            if place.get("withheld").is_some() {
                notices.push((
                    NoticeCode::RightsRestricted,
                    Some(format!("versions[{v}].places[{p}].text")),
                    format!("Selection `{}`: the wording of versions[{v}].places[{p}] is identified and located but not shown, as its version's rights statement and the excerpt limit require.", sel.id),
                ));
            }
        }
    }
}

// ---------------------------------------------------------------- resolution

/// Resolve every selection against what the build publishes. Each failure
/// is scoped to its selection: the others are resolved on their own, and
/// nothing is changed. Output is deterministic (selection id order), and the
/// work is linear in the size of the file: one strongly-connected-components
/// pass finds every cycle and a worklist carries a withheld selection to
/// those that require it.
pub fn resolve(set: &SelectionSet, basis: &Basis<'_>) -> Resolution {
    let mut evaluated: BTreeMap<&str, Evaluated> = BTreeMap::new();
    let mut failed: BTreeMap<&str, Failure> = BTreeMap::new();
    // The published posts of each post-scoped selection.
    let mut scoped: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for sel in &set.selections {
        if sel.state == SelectionState::Withdrawn {
            failed.insert(
                &sel.id,
                (
                    Why::Withdrawn,
                    format!(
                        "Selection `{}` is withdrawn, so it publishes nothing.",
                        sel.id
                    ),
                ),
            );
            continue;
        }
        let done = match evaluate(sel, basis) {
            Ok(done) => done,
            Err(failure) => {
                failed.insert(&sel.id, failure);
                continue;
            }
        };
        if done.revision != sel.revision {
            failed.insert(
                &sel.id,
                (
                    Why::Stale,
                    format!("Selection `{}` was selected before the {} `{}` or something it depends on changed. Check it, then select it again to publish it as it now stands.", sel.id, sel.kind.as_str(), sel.target),
                ),
            );
            continue;
        }
        if let Some(posts) = &sel.posts {
            // Only a published post is ever named: a draft is not disclosed.
            let kept: BTreeSet<String> = posts
                .iter()
                .filter(|post| {
                    basis
                        .posts
                        .is_some_and(|published| published.contains(*post))
                })
                .cloned()
                .collect();
            if kept.is_empty() {
                failed.insert(
                    &sel.id,
                    (
                        Why::PostNotPublished,
                        format!("Selection `{}` is scoped to posts and this build publishes none of them.", sel.id),
                    ),
                );
                continue;
            }
            scoped.insert(&sel.id, kept.into_iter().collect());
        }
        evaluated.insert(&sel.id, done);
    }
    // Requirements: cycles first, then a withheld or missing requirement.
    let ids: BTreeSet<&str> = set.selections.iter().map(|s| s.id.as_str()).collect();
    let by_id: BTreeMap<&str, &Selection> =
        set.selections.iter().map(|s| (s.id.as_str(), s)).collect();
    for id in cycle_members(set) {
        if let Some(sel) = by_id.get(id.as_str()) {
            evaluated.remove(sel.id.as_str());
            failed.entry(&sel.id).or_insert((
                Why::Cycle,
                format!(
                    "Selection `{}` requires selections that lead back to it.",
                    sel.id
                ),
            ));
        }
    }
    propagate_withheld(set, &ids, &mut evaluated, &mut failed);

    let mut items = Vec::new();
    let mut notices = Vec::new();
    let mut context: BTreeMap<(ContextKind, String), BTreeSet<String>> = BTreeMap::new();
    for sel in &set.selections {
        let Some(done) = evaluated.get(sel.id.as_str()) else {
            continue;
        };
        let Value::Object(map) = &done.value else {
            continue;
        };
        items.push(CuratedItem {
            id: sel.id.clone(),
            kind: sel.kind,
            target: sel.target.clone(),
            revision: sel.revision.clone(),
            content: map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            provenance: sel.provenance.clone(),
            missing: done.missing.clone(),
            requires: sel.requires.clone(),
            posts: scoped.get(sel.id.as_str()).cloned().unwrap_or_default(),
            positions: sel
                .positions
                .iter()
                .filter(|(post, _)| {
                    basis
                        .posts
                        .is_some_and(|published| published.contains(*post))
                })
                .map(|(post, at)| (post.clone(), *at))
                .collect(),
            notices: Vec::new(),
        });
        for (code, field, message) in &done.notices {
            notices.push(Notice {
                id: sel.id.clone(),
                code: *code,
                field: field.clone(),
                message: message.clone(),
            });
        }
        for (kind, found) in [
            (ContextKind::Entry, &done.deps.entries),
            (ContextKind::Relationship, &done.deps.relationships),
            (ContextKind::Source, &done.deps.sources),
        ] {
            for id in found {
                context
                    .entry((kind, id.clone()))
                    .or_default()
                    .insert(sel.id.clone());
            }
        }
    }
    competing_notices(set, basis, &evaluated, &mut notices);
    // A target selected on its own is not repeated as context.
    let selected_targets: BTreeSet<(ContextKind, &str)> = set
        .selections
        .iter()
        .filter(|s| evaluated.contains_key(s.id.as_str()))
        .filter_map(|s| match s.kind {
            SelectionKind::Reference => Some((ContextKind::Source, s.target.as_str())),
            SelectionKind::ContextualEntry => Some((ContextKind::Entry, s.target.as_str())),
            SelectionKind::Relationship => Some((ContextKind::Relationship, s.target.as_str())),
            _ => None,
        })
        .collect();
    let context = context
        .into_iter()
        .filter(|((kind, id), _)| !selected_targets.contains(&(*kind, id.as_str())))
        .filter_map(|((kind, id), via)| context_item(basis, kind, id, via))
        .collect();
    let mut withheld = set
        .selections
        .iter()
        .filter_map(|sel| {
            failed
                .get(sel.id.as_str())
                .map(|(why, message)| WithheldSelection {
                    id: sel.id.clone(),
                    kind: sel.kind,
                    target: sel.target.clone(),
                    why: *why,
                    message: message.clone(),
                })
        })
        .collect::<Vec<_>>();
    withheld.sort_by(|a, b| a.id.cmp(&b.id));
    notices.sort_by(|a, b| (&a.id, a.code, &a.field).cmp(&(&b.id, b.code, &b.field)));
    // The caveats that are not already a withheld field travel with the item.
    let mut carried: BTreeMap<&str, Vec<ItemNotice>> = BTreeMap::new();
    for notice in notices.iter().filter(|n| n.code.travels_with_item()) {
        carried
            .entry(notice.id.as_str())
            .or_default()
            .push(ItemNotice {
                code: notice.code,
                field: notice.field.clone(),
                message: notice.message.clone(),
            });
    }
    for item in &mut items {
        item.notices = carried.remove(item.id.as_str()).unwrap_or_default();
    }
    items.sort_by(|a: &CuratedItem, b| {
        let first = |item: &CuratedItem| item.posts.first().cloned();
        (first(a), item_order(a, first(a).as_deref()), &a.id).cmp(&(
            first(b),
            item_order(b, first(b).as_deref()),
            &b.id,
        ))
    });
    Resolution {
        curation: PublicCuration {
            format: CURATED_FORMAT,
            format_version: CURATED_FORMAT_VERSION,
            items,
            context,
        },
        withheld,
        notices,
    }
}

/// Withhold every selection that requires an unknown selection or one that
/// is withheld, however far back the chain goes. Each selection is removed
/// at most once and each `requires` edge is looked at at most twice.
fn propagate_withheld<'a>(
    set: &'a SelectionSet,
    ids: &BTreeSet<&str>,
    evaluated: &mut BTreeMap<&'a str, Evaluated>,
    failed: &mut BTreeMap<&'a str, Failure>,
) {
    let mut dependents: BTreeMap<&str, Vec<&Selection>> = BTreeMap::new();
    for sel in &set.selections {
        for required in &sel.requires {
            dependents.entry(required.as_str()).or_default().push(sel);
        }
    }
    let mut queue: VecDeque<&str> = VecDeque::new();
    for sel in &set.selections {
        if !evaluated.contains_key(sel.id.as_str()) {
            queue.push_back(&sel.id);
        } else if let Some(required) = sel.requires.iter().find(|r| !ids.contains(r.as_str())) {
            evaluated.remove(sel.id.as_str());
            failed.insert(
                &sel.id,
                (
                    Why::DependencyMissing,
                    format!(
                        "Selection `{}` requires `{required}`, which is not a selection.",
                        sel.id
                    ),
                ),
            );
            queue.push_back(&sel.id);
        }
    }
    while let Some(gone) = queue.pop_front() {
        for dependent in dependents.get(gone).map(Vec::as_slice).unwrap_or_default() {
            if !evaluated.contains_key(dependent.id.as_str()) {
                continue;
            }
            evaluated.remove(dependent.id.as_str());
            let required = dependent
                .requires
                .iter()
                .find(|r| !evaluated.contains_key(r.as_str()))
                .map_or(gone, String::as_str);
            failed.insert(
                &dependent.id,
                (
                    Why::DependencyWithheld,
                    format!(
                        "Selection `{}` requires `{required}`, which is withheld.",
                        dependent.id
                    ),
                ),
            );
            queue.push_back(&dependent.id);
        }
    }
}

fn context_item(
    basis: &Basis<'_>,
    kind: ContextKind,
    id: String,
    via: BTreeSet<String>,
) -> Option<ContextItem> {
    let via: Vec<String> = via.into_iter().collect();
    match kind {
        ContextKind::Entry => {
            let entry = basis.atlas?.entries.iter().find(|e| e.id == id)?;
            Some(ContextItem {
                kind,
                label: Some(entry.label.clone()),
                url: Some(entry.url.clone()),
                id,
                source: None,
                via,
            })
        }
        ContextKind::Relationship => {
            let relationship = basis.atlas?.relationship(&id)?;
            Some(ContextItem {
                kind,
                label: Some(format!(
                    "{} {} {}",
                    relationship.from, relationship.label, relationship.to
                )),
                url: None,
                id,
                source: None,
                via,
            })
        }
        ContextKind::Source => {
            let source = source_public(basis, &id)?;
            Some(ContextItem {
                kind,
                label: source.reference.title.clone(),
                url: None,
                id,
                source: Some(source),
                via,
            })
        }
    }
}

/// Other published datings of a selected dating's aspect that are not
/// themselves selected: the reader would see one side of a disagreement.
fn competing_notices(
    set: &SelectionSet,
    basis: &Basis<'_>,
    evaluated: &BTreeMap<&str, Evaluated>,
    notices: &mut Vec<Notice>,
) {
    let Some(atlas) = basis.atlas else { return };
    let selected: BTreeSet<&str> = set
        .selections
        .iter()
        .filter(|s| s.kind == SelectionKind::Timeline && evaluated.contains_key(s.id.as_str()))
        .map(|s| s.target.as_str())
        .collect();
    for sel in set
        .selections
        .iter()
        .filter(|s| s.kind == SelectionKind::Timeline && evaluated.contains_key(s.id.as_str()))
    {
        let Some(own) = atlas.datings.iter().find(|d| d.id == sel.target) else {
            continue;
        };
        let rivals: Vec<&str> = atlas
            .datings
            .iter()
            .filter(|d| {
                d.owner == own.owner
                    && d.owner_type == own.owner_type
                    && d.aspect == own.aspect
                    && d.id != own.id
            })
            .map(|d| d.id.as_str())
            .filter(|id| !selected.contains(id))
            .collect();
        if !rivals.is_empty() {
            notices.push(Notice {
                id: sel.id.clone(),
                code: NoticeCode::CompetingUnselected,
                field: None,
                message: format!(
                    "Selection `{}`: competing datings of the same aspect are published but not selected: {}.",
                    sel.id,
                    rivals.join(", ")
                ),
            });
        }
    }
}

/// The ids of every selection that is on a cycle of `requires`: the members
/// of each strongly connected component of more than one selection, and any
/// selection that requires itself. One iterative Tarjan pass, so it is linear
/// in the size of the file and cannot overflow the stack however long a
/// chain of requirements is.
fn cycle_members(set: &SelectionSet) -> BTreeSet<String> {
    let count = set.selections.len();
    let index_of: BTreeMap<&str, usize> = set
        .selections
        .iter()
        .enumerate()
        .map(|(index, s)| (s.id.as_str(), index))
        .collect();
    let edges: Vec<Vec<usize>> = set
        .selections
        .iter()
        .map(|s| {
            s.requires
                .iter()
                .filter_map(|required| index_of.get(required.as_str()).copied())
                .collect()
        })
        .collect();
    const UNSEEN: usize = usize::MAX;
    let mut number = vec![UNSEEN; count];
    let mut low = vec![0usize; count];
    let mut on_stack = vec![false; count];
    let mut stack: Vec<usize> = Vec::new();
    let mut next_number = 0;
    let mut members = BTreeSet::new();
    for root in 0..count {
        if number[root] != UNSEEN {
            continue;
        }
        // (node, next edge to look at)
        let mut work: Vec<(usize, usize)> = vec![(root, 0)];
        number[root] = next_number;
        low[root] = next_number;
        next_number += 1;
        stack.push(root);
        on_stack[root] = true;
        while let Some(&(node, edge)) = work.last() {
            if let Some(&next) = edges[node].get(edge) {
                if let Some(top) = work.last_mut() {
                    top.1 += 1;
                }
                if next == node {
                    members.insert(set.selections[node].id.clone());
                }
                if number[next] == UNSEEN {
                    number[next] = next_number;
                    low[next] = next_number;
                    next_number += 1;
                    stack.push(next);
                    on_stack[next] = true;
                    work.push((next, 0));
                } else if on_stack[next] {
                    low[node] = low[node].min(number[next]);
                }
                continue;
            }
            work.pop();
            if let Some(&(parent, _)) = work.last() {
                low[parent] = low[parent].min(low[node]);
            }
            if low[node] == number[node] {
                let mut component = Vec::new();
                while let Some(member) = stack.pop() {
                    on_stack[member] = false;
                    component.push(member);
                    if member == node {
                        break;
                    }
                }
                if component.len() > 1 {
                    members.extend(component.iter().map(|&m| set.selections[m].id.clone()));
                }
            }
        }
    }
    members
}

// ---------------------------------------------------------------- select and unselect

/// What the author chooses when they select something.
#[derive(Clone, Debug, Default)]
pub struct NewSelection {
    /// The selection's id; derived from the kind and target when absent.
    pub id: Option<String>,
    pub kind: Option<SelectionKind>,
    pub target: String,
    /// The optional fields chosen; every required field is always listed.
    pub optional_fields: Vec<String>,
    pub text: Option<String>,
    pub by: Option<String>,
    pub locator: Option<String>,
    pub provenance: Provenance,
    pub requires: Vec<String>,
    /// The posts it is for; absent means the whole site.
    pub posts: Option<Vec<String>>,
    /// Its place among the items of each post, by slug.
    pub positions: BTreeMap<String, u32>,
}

/// An id derived from the kind and target. The readable part is lossy (a
/// target's punctuation becomes `-`, and a long one is cut), so a short hash
/// of the exact kind and target is appended: two different targets never
/// derive the same id.
fn derived_id(kind: SelectionKind, target: &str) -> String {
    let hash = fingerprint(&[
        ("kind".into(), kind.as_str().into()),
        ("target".into(), target.into()),
    ]);
    let readable: String = format!("{}-{}", kind.as_str(), target.to_ascii_lowercase())
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let suffix = &hash[..8];
    let mut id: String = readable.chars().take(MAX_ID - suffix.len() - 1).collect();
    id = id.trim_end_matches('-').to_string();
    format!("{id}-{suffix}")
}

impl SelectionSet {
    /// Select an item the build publishes. Refuses, naming the id, anything
    /// the projections do not publish: selecting never approves. The new
    /// record carries the revision as it stands now.
    pub fn select(
        &mut self,
        new: NewSelection,
        basis: &Basis<'_>,
    ) -> Result<String, Vec<Diagnostic>> {
        let kind = new.kind.ok_or_else(|| {
            vec![diag(
                Code::BadTarget,
                None,
                Some("kind"),
                "A selection needs a kind.".into(),
            )]
        })?;
        let id = new
            .id
            .clone()
            .unwrap_or_else(|| derived_id(kind, &new.target));
        if self.get(&id).is_some() {
            return Err(vec![diag(
                Code::DuplicateId,
                Some(&id),
                Some("id"),
                format!("Selection `{id}` already exists; select it again to refresh it, or unselect it first."),
            )]);
        }
        let spec = kind.spec();
        let mut fields: Vec<String> = spec.required.iter().map(|f| f.to_string()).collect();
        fields.extend(new.optional_fields);
        fields.sort();
        fields.dedup();
        let mut selection = Selection {
            id: id.clone(),
            kind,
            target: new.target,
            revision: "0".repeat(16),
            fields,
            state: SelectionState::Selected,
            withdrawn_reason: None,
            text: new.text,
            by: new.by,
            locator: new.locator,
            provenance: new.provenance,
            requires: new.requires,
            posts: new.posts,
            positions: new.positions,
            extra: BTreeMap::new(),
        };
        let problems = validate(&selection);
        if !problems.is_empty() {
            return Err(problems);
        }
        match evaluate(&selection, basis) {
            Ok(done) => selection.revision = done.revision,
            Err((_, message)) => {
                return Err(vec![diag(
                    Code::TargetNotPublished,
                    Some(&id),
                    Some("target"),
                    message,
                )])
            }
        }
        if self.selections.len() >= MAX_SELECTIONS {
            return Err(vec![diag(
                Code::TooMany,
                None,
                None,
                format!("A selections file holds at most {MAX_SELECTIONS} selections."),
            )]);
        }
        self.selections.push(selection);
        self.selections.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(id)
    }

    /// Record the revision as it stands now and make the selection live
    /// again: the author's "checked, publish it as it is now".
    pub fn reselect(&mut self, id: &str, basis: &Basis<'_>) -> Result<(), Vec<Diagnostic>> {
        let selection = self
            .selections
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| {
                vec![diag(
                    Code::UnknownSelection,
                    Some(id),
                    None,
                    format!("There is no selection `{id}`."),
                )]
            })?;
        match evaluate(selection, basis) {
            Ok(done) => {
                selection.revision = done.revision;
                selection.state = SelectionState::Selected;
                selection.withdrawn_reason = None;
                Ok(())
            }
            Err((_, message)) => Err(vec![diag(
                Code::TargetNotPublished,
                Some(id),
                Some("target"),
                message,
            )]),
        }
    }

    /// Change the posts a selection is for. Refused while the selection is
    /// stale: changing the scope is not the author's "checked, publish it as
    /// it now stands", so it never refreshes a revision that no longer
    /// matches. Otherwise the revision is recomputed, because the scope is
    /// part of what was selected. A place it held for a post it is no longer
    /// offered to is dropped.
    pub fn rescope(
        &mut self,
        id: &str,
        posts: Option<Vec<String>>,
        basis: &Basis<'_>,
    ) -> Result<(), Vec<Diagnostic>> {
        let selection = self
            .selections
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| {
                vec![diag(
                    Code::UnknownSelection,
                    Some(id),
                    None,
                    format!("There is no selection `{id}`."),
                )]
            })?;
        let current = evaluate(selection, basis).map_err(|(_, message)| {
            vec![diag(
                Code::TargetNotPublished,
                Some(id),
                Some("target"),
                message,
            )]
        })?;
        if current.revision != selection.revision {
            return Err(vec![diag(
                Code::StaleSelection,
                Some(id),
                Some("revision"),
                format!("Selection `{id}` is stale: check what it selects and select it again before changing where it appears."),
            )]);
        }
        let mut changed = selection.clone();
        changed.posts = posts;
        if let Some(kept) = &changed.posts {
            changed.positions.retain(|post, _| kept.contains(post));
        }
        let problems = validate(&changed);
        if !problems.is_empty() {
            return Err(problems);
        }
        changed.revision = evaluate(&changed, basis)
            .map_err(|(_, message)| {
                vec![diag(
                    Code::TargetNotPublished,
                    Some(id),
                    Some("target"),
                    message,
                )]
            })?
            .revision;
        *selection = changed;
        Ok(())
    }

    /// Put the listed selections in this order among the items of one post,
    /// taking places 1..n for that post and no other. Another post's order is
    /// never touched, even for a whole-site selection both are offered. A
    /// selection this post has placed that is not listed (withheld, say) keeps
    /// its relative place after the listed ones, so its place stays unique and
    /// consistent. All or nothing: an unknown, stale or not-offered selection
    /// refuses the whole ordering, and order is no part of a revision.
    pub fn order_for_post(
        &mut self,
        post: &str,
        ids: &[String],
        basis: &Basis<'_>,
    ) -> Result<(), Vec<Diagnostic>> {
        let offered = |selection: &Selection| {
            selection
                .posts
                .as_ref()
                .is_none_or(|posts| posts.iter().any(|p| p == post))
        };
        for id in ids {
            let selection = self.get(id).ok_or_else(|| {
                vec![diag(
                    Code::UnknownSelection,
                    Some(id),
                    None,
                    format!("There is no selection `{id}`."),
                )]
            })?;
            if !offered(selection) {
                return Err(vec![diag(
                    Code::BadPosts,
                    Some(id),
                    Some("posts"),
                    format!("Selection `{id}` is not offered to this post, so it has no place among its items."),
                )]);
            }
            let current = evaluate(selection, basis).map_err(|(_, message)| {
                vec![diag(
                    Code::TargetNotPublished,
                    Some(id),
                    Some("target"),
                    message,
                )]
            })?;
            if current.revision != selection.revision {
                return Err(vec![diag(
                    Code::StaleSelection,
                    Some(id),
                    Some("revision"),
                    format!("Selection `{id}` is stale: check what it selects and select it again before changing where it appears."),
                )]);
            }
        }
        let listed: BTreeSet<&String> = ids.iter().collect();
        let mut rest: Vec<(u32, String)> = self
            .selections
            .iter()
            .filter(|s| offered(s) && !listed.contains(&s.id))
            .filter_map(|s| s.positions.get(post).map(|at| (*at, s.id.clone())))
            .collect();
        rest.sort();
        let mut next = self.clone();
        let place = |at: usize| u32::try_from(at + 1).unwrap_or(u32::MAX);
        // Giving a place to one more post can take a selection over the bound
        // on how many posts it orders. Places for posts that are no longer
        // published are the first to go, so a bound reached only through
        // stale entries never refuses an ordering; a selection that really
        // orders that many posts still does.
        let give = |selection: &mut Selection, at: usize| {
            selection.positions.insert(post.to_string(), place(at));
            if selection.positions.len() > MAX_POSITIONS {
                if let Some(published) = basis.posts {
                    selection
                        .positions
                        .retain(|slug, _| slug == post || published.contains(slug));
                }
            }
        };
        for (index, id) in ids.iter().enumerate() {
            if let Some(selection) = next.selections.iter_mut().find(|s| &s.id == id) {
                give(selection, index);
            }
        }
        for (index, (_, id)) in rest.iter().enumerate() {
            if let Some(selection) = next.selections.iter_mut().find(|s| &s.id == id) {
                give(selection, ids.len() + index);
            }
        }
        let problems: Vec<Diagnostic> = next.selections.iter().flat_map(validate).collect();
        if !problems.is_empty() {
            return Err(problems);
        }
        *self = next;
        Ok(())
    }

    /// Withdraw a selection, keeping the record. Returns whether it exists.
    pub fn withdraw(&mut self, id: &str, reason: Option<String>) -> bool {
        match self.selections.iter_mut().find(|s| s.id == id) {
            Some(selection) => {
                selection.state = SelectionState::Withdrawn;
                selection.withdrawn_reason = reason.filter(|r| !r.trim().is_empty());
                true
            }
            None => false,
        }
    }

    /// Remove a selection. The research it selected is untouched. Returns
    /// whether it existed.
    pub fn unselect(&mut self, id: &str) -> bool {
        let before = self.selections.len();
        self.selections.retain(|s| s.id != id);
        self.selections.len() != before
    }
}

// ---------------------------------------------------------------- the author's view

/// What readers of one post are given: the whole-site items and those scoped
/// to the post, in the post's order, with the context only they need. The
/// same value the public renderers read (#197), so a preview is not a second
/// rendering of it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostCuration<'a> {
    pub format: &'static str,
    pub format_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post: Option<String>,
    pub items: Vec<&'a CuratedItem>,
    pub context: Vec<&'a ContextItem>,
}

impl PublicCuration {
    /// The items and context readers of `post` get, or, for `None`, every
    /// published item in the site-wide order.
    pub fn view_for(&self, post: Option<&str>) -> PostCuration<'_> {
        let items: Vec<&CuratedItem> = match post {
            Some(post) => self.for_post(post),
            None => self.items.iter().collect(),
        };
        let shown: BTreeSet<&str> = items.iter().map(|item| item.id.as_str()).collect();
        let context = self
            .context
            .iter()
            .filter(|item| item.via.iter().any(|id| shown.contains(id.as_str())))
            .collect();
        PostCuration {
            format: self.format,
            format_version: self.format_version,
            post: post.map(str::to_string),
            items,
            context,
        }
    }
}

/// One stored selection as its author sees it: what it selects by name, what
/// readers get of it and, when they get nothing, why. The author's own text is
/// included (it is theirs and this view is theirs alone); nothing private
/// that the selection did not copy is.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionView {
    pub id: String,
    pub kind: SelectionKind,
    pub target: String,
    /// What the target is called in the public projections, when it is
    /// published; never a private label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub state: SelectionState,
    /// `published`, or `withheld` with `why` and a `message` naming ids only.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<Why>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Whether readers of the post this view is for are offered it.
    pub applies_to_post: bool,
    pub fields: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locator: Option<String>,
    pub provenance: Provenance,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
    /// The posts it is scoped to; absent means the whole site.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub posts: Option<Vec<String>>,
    /// Its place among the items of each post that orders it.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub positions: BTreeMap<String, u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub withdrawn_reason: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<ItemNotice>,
}

/// A public item that can be selected, by the name its own projection gives it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub label: String,
    /// The public page, when the item has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// For a relationship or a dating, the entry or relationship it is about.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub about: Vec<String>,
}

/// Everything the build publishes that a selection can pick, and nothing else.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidates {
    pub entries: Vec<Candidate>,
    pub relationships: Vec<Candidate>,
    pub datings: Vec<Candidate>,
    pub comparisons: Vec<Candidate>,
    /// Sources that are already public: cited by a published post, or
    /// published by the atlas or a comparison.
    pub sources: Vec<Candidate>,
}

/// What a kind of selection always publishes and what the author may add,
/// so no client restates the rules of ADR 0187.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindView {
    pub kind: SelectionKind,
    /// Always published with the item: attribution, uncertainty, evidence.
    pub required: Vec<&'static str>,
    /// Published only when the author lists them.
    pub optional: Vec<&'static str>,
    /// Whether the author writes the text (a comment or an explanation).
    pub text: bool,
}

impl SelectionKind {
    pub const ALL: [SelectionKind; 7] = [
        Self::Reference,
        Self::ContextualEntry,
        Self::Relationship,
        Self::Timeline,
        Self::Comparison,
        Self::SourceAnnotation,
        Self::Explanation,
    ];

    /// The fields this kind lists and may list.
    pub fn view(self) -> KindView {
        let spec = self.spec();
        KindView {
            kind: self,
            required: spec.required.to_vec(),
            optional: spec.optional.to_vec(),
            text: self.has_text(),
        }
    }
}

/// The author's curation surface for one post, or for the whole site.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurationView<'a> {
    /// The revision of the selections file a change must name.
    pub revision: String,
    pub file: &'static str,
    /// Whether the site publishes curated context (`curatedContext.publish`).
    pub publish: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post: Option<String>,
    /// The post is not published yet (a draft), so the preview is what its
    /// readers get *when this post is published*: the post is added to the
    /// published set for this preview alone, the way Admin's production
    /// preview renders a draft as published. The build's rule is unchanged: it
    /// publishes nothing scoped to a post that is not published.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub when_published: bool,
    pub selections: Vec<SelectionView>,
    /// What readers get, exactly.
    pub preview: PostCuration<'a>,
    pub candidates: Candidates,
    pub kinds: Vec<KindView>,
}

fn candidates_of(basis: &Basis<'_>) -> Candidates {
    let mut found = Candidates::default();
    if let Some(atlas) = basis.atlas {
        let label_of = |id: &str| {
            atlas
                .entries
                .iter()
                .find(|entry| entry.id == id)
                .map_or_else(|| id.to_string(), |entry| entry.label.clone())
        };
        found.entries = atlas
            .entries
            .iter()
            .map(|entry| Candidate {
                id: entry.id.clone(),
                label: entry.label.clone(),
                url: Some(entry.url.clone()),
                about: Vec::new(),
            })
            .collect();
        found.relationships = atlas
            .relationships
            .iter()
            .map(|relationship| Candidate {
                id: relationship.id.clone(),
                label: format!(
                    "{} {} {}",
                    label_of(&relationship.from),
                    relationship.label,
                    label_of(&relationship.to)
                ),
                url: None,
                about: vec![relationship.from.clone(), relationship.to.clone()],
            })
            .collect();
        found.datings = atlas
            .datings
            .iter()
            .map(|dating| Candidate {
                id: dating.id.clone(),
                label: format!("{}: {}", dating.aspect.as_str(), dating.text),
                url: None,
                about: vec![dating.owner.clone()],
            })
            .collect();
    }
    if let Some(comparisons) = basis.comparisons {
        found.comparisons = comparisons
            .comparisons
            .iter()
            .map(|comparison| Candidate {
                id: comparison.id.clone(),
                label: comparison
                    .label
                    .clone()
                    .unwrap_or_else(|| comparison.id.clone()),
                url: Some(comparison.url.clone()),
                about: Vec::new(),
            })
            .collect();
    }
    if let (Some(library), Some(public)) = (basis.library, basis.public_sources) {
        found.sources = public
            .iter()
            .filter_map(|id| library.get(id))
            .map(|record| Candidate {
                id: record.id.clone(),
                label: public_reference(record)
                    .title
                    .unwrap_or_else(|| record.id.clone()),
                url: None,
                about: Vec::new(),
            })
            .collect();
    }
    found
}

/// Build the author's view of the selections: each one with its status and
/// reason, what readers of `post` get, and what can be selected. Pure: the
/// caller reads the stores and holds whatever locks it needs.
pub fn curation_view<'a>(
    set: &SelectionSet,
    resolution: &'a Resolution,
    basis: &Basis<'_>,
    post: Option<&str>,
    revision: &str,
    publish: bool,
    when_published: bool,
) -> CurationView<'a> {
    let candidates = candidates_of(basis);
    let label_of = |sel: &Selection| -> Option<String> {
        let find = |list: &[Candidate]| {
            list.iter()
                .find(|candidate| candidate.id == sel.target)
                .map(|candidate| candidate.label.clone())
        };
        match sel.kind {
            SelectionKind::Reference | SelectionKind::SourceAnnotation => find(&candidates.sources),
            SelectionKind::ContextualEntry | SelectionKind::Explanation => {
                find(&candidates.entries)
            }
            SelectionKind::Relationship => find(&candidates.relationships),
            SelectionKind::Timeline => find(&candidates.datings),
            SelectionKind::Comparison => find(&candidates.comparisons),
        }
    };
    let held: BTreeMap<&str, &WithheldSelection> = resolution
        .withheld
        .iter()
        .map(|held| (held.id.as_str(), held))
        .collect();
    let items: BTreeMap<&str, &CuratedItem> = resolution
        .curation
        .items
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    let mut selections: Vec<SelectionView> = set
        .selections
        .iter()
        .map(|sel| {
            let withheld = held.get(sel.id.as_str());
            let applies = post.is_none_or(|post| {
                sel.posts
                    .as_ref()
                    .is_none_or(|posts| posts.iter().any(|p| p == post))
            });
            SelectionView {
                id: sel.id.clone(),
                kind: sel.kind,
                target: sel.target.clone(),
                label: label_of(sel),
                state: sel.state,
                status: if withheld.is_some() {
                    "withheld"
                } else {
                    "published"
                },
                why: withheld.map(|held| held.why),
                message: withheld.map(|held| held.message.clone()),
                applies_to_post: applies,
                fields: sel.fields.clone(),
                text: sel.text.clone(),
                by: sel.by.clone(),
                locator: sel.locator.clone(),
                provenance: sel.provenance.clone(),
                requires: sel.requires.clone(),
                posts: sel.posts.clone(),
                positions: sel.positions.clone(),
                withdrawn_reason: sel.withdrawn_reason.clone(),
                notices: items
                    .get(sel.id.as_str())
                    .map(|item| item.notices.clone())
                    .unwrap_or_default(),
            }
        })
        .collect();
    // Published ones in the order readers get them, then the withheld, by id.
    let order: BTreeMap<&str, usize> = resolution
        .curation
        .view_for(post)
        .items
        .iter()
        .enumerate()
        .map(|(index, item)| (item.id.as_str(), index))
        .collect();
    selections.sort_by(|a, b| {
        let key = |view: &SelectionView| {
            (
                !view.applies_to_post,
                order.get(view.id.as_str()).copied().unwrap_or(usize::MAX),
                view.id.clone(),
            )
        };
        key(a).cmp(&key(b))
    });
    CurationView {
        revision: revision.to_string(),
        file: SELECTIONS_FILE,
        publish,
        post: post.map(str::to_string),
        when_published,
        selections,
        preview: resolution.curation.view_for(post),
        candidates,
        kinds: SelectionKind::ALL.iter().map(|kind| kind.view()).collect(),
    }
}
