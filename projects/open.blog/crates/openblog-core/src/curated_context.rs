//! The public research-context projection for Reader Discovery (#197,
//! ADR 0197 to ADR 0201).
//!
//! [`CuratedContext`] is a bounded, deterministic reading of the one public
//! curated value ([`PublicCuration`], ADR 0185) shaped to be fetched and
//! reused: every published selection with its attribution, uncertainty,
//! evidence and the revision that was selected, the context each one needs,
//! and, for each published post, the items it is offered in the author's
//! order with the canonical anchor of each on that post's page. It is derived
//! from that value and from nothing else, so it can never reach a private
//! object: it takes no selections file, notebook, library or atlas. Adding a
//! field to a selection publishes nothing here until the selection projection
//! publishes it.
//!
//! The same value renders the static section of each post's page
//! ([`CuratedContext::post_section_html`]), so the page is complete without
//! JavaScript and the data file and the page can never disagree. Nothing in
//! either says a relationship is true, agreed or authoritative: attribution,
//! doubt, dissent and evidence travel with every item, and a detail the
//! source lacks is listed as not recorded, never invented.
//!
//! The file is bounded ([`MAX_BYTES`], [`MAX_LISTED_POSTS`]) and a projection
//! over a bound, or one that does not agree with itself, is refused as a
//! whole, naming the limit and ids and never an item's text. The posts'
//! pages are unaffected: the page section is bounded by the selections file
//! itself and stays the complete fallback.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::Value;

use crate::atlas_publication::escaped_json;
pub use crate::atlas_query::RefusalKind;
use crate::curated_selection::{
    ContextItem, ContextKind, CuratedItem, PublicCuration, SelectionKind, CURATED_FORMAT_VERSION,
};
use crate::escape::{attr, text};

/// The `format` of the artifact. It is not the public curated value's own
/// format ([`crate::curated_selection::CURATED_FORMAT`]): the file is a projection of that value (the
/// selected items plus the posts' anchors), not the value itself, so a reader
/// told one is never handed the other (ADR 0197).
pub const FILE_FORMAT: &str = "openblog-curated-context-file";
/// The artifact, relative to the site root.
pub const CURATED_CONTEXT_JSON_FILE: &str = "curated-context.json";
/// The prefix of the anchor each curated item has on a post's page, followed
/// by the selection id. A selection id is a lowercase slug, so the anchor is
/// a valid, stable fragment. It is in the reserved `ob-` family: no heading id
/// of the post can have it (ADR 0197).
pub const ANCHOR_PREFIX: &str = "ob-curated-";
/// The id of the section on a post's page that holds the curated context.
pub const SECTION_ID: &str = "ob-research-context";
/// Largest serialized artifact, in bytes, after the base path.
pub const MAX_BYTES: usize = 1024 * 1024;
/// Most posts the artifact lists.
pub const MAX_LISTED_POSTS: usize = 2_000;
/// Most items one post's page section shows. A post offered more has the rest
/// in the data file, and its page says so (ADR 0198): the page stays bounded
/// however large the selections file is.
pub const MAX_PAGE_ITEMS: usize = 1_000;
/// Deepest nesting of a field value shown on a page.
const MAX_DEPTH: usize = 4;

/// A refused projection: which kind, and a message naming limits and ids
/// only, never an item's text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextRefusal {
    pub kind: RefusalKind,
    pub message: String,
}

impl std::fmt::Display for ContextRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// A published post, by what the artifact needs of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PostRef<'a> {
    pub slug: &'a str,
    /// Its canonical root-relative address.
    pub url: &'a str,
}

/// One item as one post offers it: the selection and where it sits on the page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRef {
    pub id: String,
    /// The canonical anchor: the post's address and the item's fragment.
    pub url: String,
}

/// A piece of context one post's items need.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRef {
    pub kind: ContextKind,
    pub id: String,
}

/// What one published post offers its readers, in the author's order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostContext {
    pub post: String,
    pub url: String,
    pub items: Vec<ItemRef>,
    pub context: Vec<ContextRef>,
}

/// The public research-context projection.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuratedContext {
    pub format: &'static str,
    pub format_version: u64,
    /// The root-relative address of the section on a post's page and the
    /// prefix of each item's fragment, so a consumer never guesses either.
    pub section: &'static str,
    pub anchor_prefix: &'static str,
    /// Every published selection, whole-site first, then by first post and
    /// the author's order there.
    pub items: Vec<CuratedItem>,
    /// Sorted by kind then id; never holds a selected item twice.
    pub context: Vec<ContextItem>,
    /// Sorted by post slug; only posts that offer at least one item.
    pub posts: Vec<PostContext>,
    /// Lookups by id and by (kind, id or target), so rendering a post never
    /// scans the whole file for each reference.
    #[serde(skip)]
    index: Index,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Index {
    items: BTreeMap<String, usize>,
    context: BTreeMap<(ContextKind, String), usize>,
    /// The first selected item of each (kind, target).
    targets: BTreeMap<(SelectionKind, String), usize>,
}

impl Index {
    fn of(items: &[CuratedItem], context: &[ContextItem]) -> Self {
        let mut index = Self::default();
        for (at, item) in items.iter().enumerate() {
            index.items.entry(item.id.clone()).or_insert(at);
            index
                .targets
                .entry((item.kind, item.target.clone()))
                .or_insert(at);
        }
        for (at, item) in context.iter().enumerate() {
            index
                .context
                .entry((item.kind, item.id.clone()))
                .or_insert(at);
        }
        index
    }
}

fn refuse(kind: RefusalKind, message: String) -> ContextRefusal {
    ContextRefusal { kind, message }
}

impl CuratedContext {
    /// Project the one public curated value over the posts this build
    /// publishes. `base_path` is put in front of every root-relative address
    /// when the file is written, so it counts toward the size bound.
    pub fn project(
        curation: &PublicCuration,
        posts: &[PostRef<'_>],
        base_path: &str,
    ) -> Result<Self, ContextRefusal> {
        let published: BTreeMap<&str, &str> =
            posts.iter().map(|post| (post.slug, post.url)).collect();
        let mut seen = BTreeSet::new();
        for item in &curation.items {
            if !seen.insert(item.id.as_str()) {
                return Err(refuse(
                    RefusalKind::Inconsistent,
                    format!(
                        "the curated item `{}` is published twice, so the curated context file is not written",
                        item.id
                    ),
                ));
            }
        }
        for item in &curation.items {
            if let Some(missing) = item.requires.iter().find(|id| !seen.contains(id.as_str())) {
                return Err(refuse(
                    RefusalKind::Inconsistent,
                    format!(
                        "the curated item `{}` requires `{missing}`, which is not published",
                        item.id
                    ),
                ));
            }
            if let Some(post) = item
                .posts
                .iter()
                .find(|p| !published.contains_key(p.as_str()))
            {
                return Err(refuse(
                    RefusalKind::Inconsistent,
                    format!(
                        "the curated item `{}` names the post `{post}`, which this build does not publish",
                        item.id
                    ),
                ));
            }
        }
        for context in &curation.context {
            if let Some(via) = context.via.iter().find(|id| !seen.contains(id.as_str())) {
                return Err(refuse(
                    RefusalKind::Inconsistent,
                    format!(
                        "the {} `{}` is context for `{via}`, which is not published",
                        context_noun(context.kind),
                        context.id
                    ),
                ));
            }
        }
        let mut listed = Vec::new();
        for post in posts {
            let view = curation.view_for(Some(post.slug));
            if view.items.is_empty() {
                continue;
            }
            listed.push(PostContext {
                post: post.slug.to_string(),
                url: post.url.to_string(),
                items: view
                    .items
                    .iter()
                    .map(|item| ItemRef {
                        id: item.id.clone(),
                        url: format!("{}#{ANCHOR_PREFIX}{}", post.url, item.id),
                    })
                    .collect(),
                context: view
                    .context
                    .iter()
                    .map(|context| ContextRef {
                        kind: context.kind,
                        id: context.id.clone(),
                    })
                    .collect(),
            });
        }
        listed.sort_by(|a, b| a.post.cmp(&b.post));
        listed.dedup_by(|a, b| a.post == b.post);
        if listed.len() > MAX_LISTED_POSTS {
            return Err(refuse(
                RefusalKind::OverLimit,
                format!(
                    "{} posts offer curated context, over the limit of {MAX_LISTED_POSTS}",
                    listed.len()
                ),
            ));
        }
        let file = Self {
            format: FILE_FORMAT,
            format_version: CURATED_FORMAT_VERSION,
            section: SECTION_ID,
            anchor_prefix: ANCHOR_PREFIX,
            index: Index::of(&curation.items, &curation.context),
            items: curation.items.clone(),
            context: curation.context.clone(),
            posts: listed,
        };
        let json = file.to_json();
        let size = json.len() + json.matches("\"url\":\"/").count() * base_path.len();
        if size > MAX_BYTES {
            return Err(refuse(
                RefusalKind::OverLimit,
                format!(
                    "the curated context projection is {size} bytes as published, over the limit of {MAX_BYTES}"
                ),
            ));
        }
        Ok(file)
    }

    /// The file as the build writes it: compact, deterministic, and safe to
    /// embed (`<`, `>` and `&` are escaped).
    pub fn to_json(&self) -> String {
        escaped_json(self)
    }

    pub fn item(&self, id: &str) -> Option<&CuratedItem> {
        self.index.items.get(id).map(|at| &self.items[*at])
    }

    /// What one post offers, when it offers anything.
    pub fn for_post(&self, slug: &str) -> Option<&PostContext> {
        self.posts
            .binary_search_by(|post| post.post.as_str().cmp(slug))
            .ok()
            .map(|at| &self.posts[at])
    }

    fn context_item(&self, kind: ContextKind, id: &str) -> Option<&ContextItem> {
        self.index
            .context
            .get(&(kind, id.to_string()))
            .map(|at| &self.context[*at])
    }

    /// The first selected item of a kind about a target.
    fn selected(&self, kind: SelectionKind, target: &str) -> Option<&CuratedItem> {
        self.index
            .targets
            .get(&(kind, target.to_string()))
            .map(|at| &self.items[*at])
    }

    /// The projection for one post alone, when the whole file is not written
    /// (a bound, or an inconsistency): the page still carries what its post
    /// is offered, from the same public value.
    pub fn for_one_post(curation: &PublicCuration, post: PostRef<'_>) -> Option<Self> {
        let view = curation.view_for(Some(post.slug));
        if view.items.is_empty() {
            return None;
        }
        Some(Self {
            format: FILE_FORMAT,
            format_version: CURATED_FORMAT_VERSION,
            section: SECTION_ID,
            anchor_prefix: ANCHOR_PREFIX,
            index: Index::of(&curation.items, &curation.context),
            items: curation.items.clone(),
            context: curation.context.clone(),
            posts: vec![PostContext {
                post: post.slug.to_string(),
                url: post.url.to_string(),
                items: view
                    .items
                    .iter()
                    .map(|item| ItemRef {
                        id: item.id.clone(),
                        url: format!("{}#{ANCHOR_PREFIX}{}", post.url, item.id),
                    })
                    .collect(),
                context: view
                    .context
                    .iter()
                    .map(|context| ContextRef {
                        kind: context.kind,
                        id: context.id.clone(),
                    })
                    .collect(),
            }],
        })
    }
}

fn context_noun(kind: ContextKind) -> &'static str {
    match kind {
        ContextKind::Entry => "entry",
        ContextKind::Relationship => "relationship",
        ContextKind::Source => "source",
    }
}

// ---------------------------------------------------------------- the page

/// The words for what a selection is, as the page names it.
fn kind_noun(kind: SelectionKind) -> &'static str {
    match kind {
        SelectionKind::Reference => "Source reference",
        SelectionKind::ContextualEntry => "Atlas entry",
        SelectionKind::Relationship => "Relationship",
        SelectionKind::Timeline => "Dating",
        SelectionKind::Comparison => "Comparison",
        SelectionKind::SourceAnnotation => "The author's comment on a source",
        SelectionKind::Explanation => "The author's explanation of an entry",
    }
}

/// The names of the fields a page shows, in the order it shows them. A field
/// not listed follows, by name; the heading carries the ones left out.
const FIELD_ORDER: &[(&str, &str)] = &[
    ("summary", "Summary"),
    ("aliases", "Other names"),
    ("kind", "Kind"),
    ("creators", "Creators"),
    ("issued", "Date issued"),
    ("language", "Language"),
    ("identifiers", "Public identifiers"),
    ("source", "The work it stands for"),
    ("from", "From"),
    ("to", "To"),
    ("inverseLabel", "Read the other way"),
    ("subject", "About"),
    ("owner", "Dates"),
    ("aspect", "Aspect"),
    ("text", "The words"),
    ("by", "Who wrote it"),
    ("locator", "Where in the source it applies"),
    ("assertedBy", "Who asserts it"),
    ("confidence", "How firmly"),
    ("standing", "Whether it is contested"),
    ("uncertainty", "What is doubtful"),
    ("contestedBy", "Who disputes it"),
    ("evidence", "The evidence"),
    ("date", "The date as its party states it"),
    ("placement", "How it is placed in time"),
    ("startYear", "First year"),
    ("endYear", "Last year"),
    ("note", "The party's note"),
    ("correspondenceLabel", "How the passages correspond"),
    ("correspondence", "The correspondence"),
    ("rationale", "The reasoning"),
    ("recordedBy", "Who recorded it"),
    ("versions", "The versions compared"),
    ("wording", "The compared wording"),
    ("csl", "Full citation data"),
];

/// Fields shown by the heading, the link or the context list, never as a row.
const HIDDEN_FIELDS: &[&str] = &["id", "key", "label", "title", "url", "ownerType"];

fn label_of(name: &str) -> String {
    FIELD_ORDER
        .iter()
        .find(|(field, _)| *field == name)
        .map_or_else(|| name.to_string(), |(_, label)| (*label).to_string())
}

fn str_of<'a>(item: &'a CuratedItem, field: &str) -> Option<&'a str> {
    item.content.get(field).and_then(Value::as_str)
}

/// A root-relative address of a page of this site, or an absolute `https`
/// address: nothing else is ever made a link.
fn safe_href(url: &str) -> bool {
    // No whitespace, control character or backslash: a browser reads `/\evil`
    // as `//evil`, and a control character can be stripped to something else.
    let plain = !url.contains(|c: char| c.is_whitespace() || c.is_control() || c == '\\');
    plain && ((url.starts_with('/') && !url.starts_with("//")) || url.starts_with("https://"))
}

/// What a reference on the page points at: its public name, and the anchor on
/// this page it can link to when the page holds it.
struct Named {
    label: String,
    anchor: Option<String>,
}

/// How the section is written: as the page's HTML, as a portable copy's HTML,
/// or as a portable copy's Markdown. The words, the order and the escaping
/// rules are the same in every one; only the links and the list markup differ.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Syntax {
    Html,
    Markdown,
}

/// Where a copy that has left the site links back to (ADR 0202): the canonical
/// address of the post, whose page holds every anchor the copy names, and how
/// a root-relative address of this site is made absolute.
pub struct CopyLinks<'a> {
    pub canonical: &'a str,
    pub absolute: &'a dyn Fn(&str) -> Result<String, String>,
}

struct Page<'a> {
    context: &'a CuratedContext,
    /// The ids of the items this post offers, and the context it lists.
    offered: BTreeSet<&'a str>,
    listed: BTreeSet<(ContextKind, &'a str)>,
    syntax: Syntax,
    /// `Some` for a copy that has left the site: nothing links to an anchor of
    /// a page it is not on, and a root-relative address is made absolute.
    copy: Option<&'a CopyLinks<'a>>,
    /// How many addresses were shown as text because they cannot be links.
    unlinked: Cell<usize>,
}

/// Markdown text for a public value: punctuation that could become markup is
/// escaped, so a value is never a link, emphasis or raw HTML when read back.
fn md_text(value: &str) -> String {
    crate::portability::markdown_text(value)
}

impl<'a> Page<'a> {
    fn new(
        context: &'a CuratedContext,
        post: &'a PostContext,
        syntax: Syntax,
        copy: Option<&'a CopyLinks<'a>>,
    ) -> Self {
        Self {
            context,
            offered: post.items.iter().map(|item| item.id.as_str()).collect(),
            listed: post
                .context
                .iter()
                .map(|context| (context.kind, context.id.as_str()))
                .collect(),
            syntax,
            copy,
            unlinked: Cell::new(0),
        }
    }

    /// A value as text in this syntax.
    fn t(&self, value: &str) -> String {
        match self.syntax {
            Syntax::Html => text(value),
            Syntax::Markdown => md_text(value),
        }
    }

    /// A link to an anchor of this post's page. On the page it is a fragment;
    /// in a copy it is the canonical address and the fragment; a copy in
    /// Markdown or HTML always has somewhere to point, so it is never dead.
    fn in_page(&self, anchor: &str, inner: &str, class: &str) -> String {
        let class = if class.is_empty() || self.copy.is_some() {
            String::new()
        } else {
            format!(" class=\"{class}\"")
        };
        match (self.syntax, self.copy) {
            (Syntax::Html, None) => format!("<a{class} href=\"#{}\">{inner}</a>", attr(anchor)),
            (Syntax::Html, Some(copy)) => format!(
                "<a href=\"{}\">{inner}</a>",
                attr(&format!("{}#{anchor}", copy.canonical))
            ),
            (Syntax::Markdown, Some(copy)) => format!(
                "[{inner}]({})",
                crate::portability::markdown_destination(&format!("{}#{anchor}", copy.canonical))
            ),
            (Syntax::Markdown, None) => inner.to_string(),
        }
    }

    /// A link to an address that is already safe: a page of this site or an
    /// `https` address. A copy makes a root-relative one absolute.
    fn to(&self, href: &str, inner: &str) -> String {
        let href = match self.copy {
            Some(copy) => (copy.absolute)(href).unwrap_or_else(|_| href.to_string()),
            None => href.to_string(),
        };
        match self.syntax {
            Syntax::Html => format!("<a href=\"{}\">{inner}</a>", attr(&href)),
            Syntax::Markdown => format!(
                "[{inner}]({})",
                crate::portability::markdown_destination(&href)
            ),
        }
    }

    fn cite(&self, inner: &str) -> String {
        match self.syntax {
            Syntax::Html => format!("<cite>{inner}</cite>"),
            Syntax::Markdown => format!("*{inner}*"),
        }
    }

    fn list(&self, parts: &[String]) -> String {
        match self.syntax {
            Syntax::Html => format!(
                "<ul class=\"ob-curated-list\">{}</ul>",
                parts
                    .iter()
                    .map(|part| format!("<li>{part}</li>"))
                    .collect::<String>()
            ),
            Syntax::Markdown => parts.join("; "),
        }
    }

    /// An address that cannot be a link is shown as it is, and counted.
    fn note_unlinked(&self) {
        self.unlinked.set(self.unlinked.get() + 1);
    }

    /// A source, entry or relationship by the name the public value gives it:
    /// the context item that brings it, or, when it was selected on its own
    /// and so is not repeated as context, the selected item itself.
    fn named(&self, kind: ContextKind, id: &str) -> Option<Named> {
        if let Some(item) = self.context.context_item(kind, id) {
            let listed = self.listed.contains(&(kind, id));
            return Some(Named {
                label: item.label.clone().unwrap_or_else(|| id.to_string()),
                anchor: listed.then(|| anchor(context_noun(kind), id)),
            });
        }
        let (selection, field) = match kind {
            ContextKind::Source => (SelectionKind::Reference, "title"),
            ContextKind::Entry => (SelectionKind::ContextualEntry, "label"),
            ContextKind::Relationship => return None,
        };
        let item = self.context.selected(selection, id)?;
        let label = str_of(item, field)?.to_string();
        let offered = self.offered.contains(item.id.as_str());
        Some(Named {
            label,
            anchor: offered.then(|| format!("{ANCHOR_PREFIX}{}", item.id)),
        })
    }

    fn entry_name(&self, id: &str) -> Option<String> {
        self.named(ContextKind::Entry, id).map(|named| named.label)
    }

    /// A reference to a source: its public name, as a link to where this
    /// page holds it, or the id as plain text when it is not held.
    fn source_ref(&self, id: &str) -> String {
        match self.named(ContextKind::Source, id) {
            Some(Named {
                label,
                anchor: Some(anchor),
            }) => self.in_page(&anchor, &self.cite(&self.t(&label)), "ob-curated-source"),
            Some(named) => self.cite(&self.t(&named.label)),
            None => self.cite(&self.t(id)),
        }
    }

    fn entry_ref(&self, id: &str) -> String {
        match self.named(ContextKind::Entry, id) {
            Some(Named {
                label,
                anchor: Some(anchor),
            }) => self.in_page(&anchor, &self.t(&label), ""),
            Some(named) => self.t(&named.label),
            None => self.t(id),
        }
    }

    fn party(&self, value: &Value) -> Option<String> {
        let object = value.as_object()?;
        // A party states only who it is. A compared version is also tagged as a
        // source, and carries where its passages are and its rights words: it is
        // read as a source with those, never cut down to its name.
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "kind" | "source" | "name"))
        {
            return None;
        }
        match object.get("kind").and_then(Value::as_str)? {
            "author" => Some("the site author".to_string()),
            "named" => object
                .get("name")
                .and_then(Value::as_str)
                .map(|name| self.t(name)),
            "source" => object
                .get("source")
                .and_then(Value::as_str)
                .map(|id| format!("the source {}", self.source_ref(id))),
            _ => None,
        }
    }

    fn locators(&self, value: &Value) -> String {
        value
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|locator| {
                        let kind = locator.get("kind")?.as_str()?;
                        let at = locator.get("value")?.as_str()?;
                        Some(match locator.get("to").and_then(Value::as_str) {
                            Some(to) => {
                                format!("{} {} to {}", self.t(kind), self.t(at), self.t(to))
                            }
                            None => format!("{} {}", self.t(kind), self.t(at)),
                        })
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default()
    }

    /// One field value as inline text in this syntax. Every string is
    /// escaped; the only links are to this site's pages and to a source's own
    /// `https` address.
    fn value(&self, name: &str, value: &Value, depth: usize) -> String {
        match value {
            Value::Null => String::new(),
            Value::Bool(flag) => flag.to_string(),
            Value::Number(number) => number.to_string(),
            Value::String(string) => match name {
                "from" | "to" | "owner" | "source" | "subject"
                    if self.entry_name(string).is_some() =>
                {
                    self.entry_ref(string)
                }
                "source" | "subject" if self.named(ContextKind::Source, string).is_some() => {
                    self.source_ref(string)
                }
                "url" if safe_href(string) => self.to(string, &self.t(string)),
                _ => self.t(string),
            },
            Value::Array(list) => {
                let parts: Vec<String> = list
                    .iter()
                    .map(|item| match item.as_array().map(Vec::as_slice) {
                        // An identifier is a scheme and a value: "doi: 10.1000/x".
                        Some([Value::String(scheme), Value::String(value)])
                            if name == "identifiers" =>
                        {
                            format!("{}: {}", self.t(scheme), self.t(value))
                        }
                        _ => self.value(name, item, depth + 1),
                    })
                    .filter(|html| !html.is_empty())
                    .collect();
                match parts.len() {
                    0 => String::new(),
                    1 => parts.into_iter().next().unwrap_or_default(),
                    _ => self.list(&parts),
                }
            }
            Value::Object(object) => {
                if let Some(party) = self.party(value) {
                    return party;
                }
                if let Some(source) = object.get("source").and_then(Value::as_str) {
                    let at = object
                        .get("locators")
                        .map(|locators| self.locators(locators))
                        .unwrap_or_default();
                    let mut html = self.source_ref(source);
                    if !at.is_empty() {
                        html.push_str(&format!(", {at}"));
                    }
                    // A compared version: where in it the passages are, and the
                    // words the author gave of its rights, which travel with it.
                    if let Some(places) = object.get("places").and_then(Value::as_array) {
                        let places: Vec<String> = places
                            .iter()
                            .filter_map(|place| {
                                let at = self.locators(place.get("locators")?);
                                let words = place
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .map(|words| format!(" “{}”", self.t(words)))
                                    .unwrap_or_default();
                                let shown = format!("{at}{words}");
                                (!shown.trim().is_empty()).then_some(shown)
                            })
                            .collect();
                        if !places.is_empty() {
                            html.push_str(&format!(", {}", places.join("; ")));
                        }
                    }
                    if let Some(rights) = object
                        .get("rights")
                        .and_then(|rights| rights.get("label"))
                        .and_then(Value::as_str)
                    {
                        html.push_str(&format!(" — {}", self.t(rights)));
                    }
                    if let Some(note) = object.get("note").and_then(Value::as_str) {
                        html.push_str(&format!(" ({})", self.t(note)));
                    }
                    return html;
                }
                if let (Some(by), Some(note)) = (object.get("by"), object.get("note")) {
                    // A dissent: who disputes it, on what evidence, and what they say.
                    let mut html = format!(
                        "{}: {}",
                        self.value("by", by, depth + 1),
                        self.value("note", note, depth + 1)
                    );
                    if let Some(evidence) = object.get("evidence") {
                        html.push_str(&format!(
                            " (evidence: {})",
                            self.value("evidence", evidence, depth + 1)
                        ));
                    }
                    return html;
                }
                if let (Some(name), Some(role)) = (
                    object.get("name").and_then(Value::as_str),
                    object.get("role").and_then(Value::as_str),
                ) {
                    return format!("{} ({})", self.t(name), self.t(role));
                }
                if depth >= MAX_DEPTH {
                    return self.t(&Value::Object(object.clone()).to_string());
                }
                // Anything else is read as labelled parts, in name order.
                object
                    .iter()
                    .filter(|(_, inner)| !inner.is_null())
                    .map(|(key, inner)| {
                        format!(
                            "{}: {}",
                            self.t(&label_of(key)),
                            self.value(key, inner, depth + 1)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            }
        }
    }

    /// The heading of one item: what it is and what it is about.
    fn heading(&self, item: &CuratedItem) -> String {
        let noun = kind_noun(item.kind);
        let subject = match item.kind {
            SelectionKind::Reference => str_of(item, "title").map(|title| self.t(title)),
            SelectionKind::ContextualEntry => str_of(item, "label").map(|label| self.t(label)),
            SelectionKind::Comparison => str_of(item, "label").map(|label| self.t(label)),
            SelectionKind::Relationship => {
                let end = |field: &str| {
                    str_of(item, field).map(|id| {
                        self.entry_name(id)
                            .map_or_else(|| self.t(id), |name| self.t(&name))
                    })
                };
                match (end("from"), str_of(item, "label"), end("to")) {
                    (Some(from), Some(label), Some(to)) => {
                        Some(format!("{from} {} {to}", self.t(label)))
                    }
                    _ => None,
                }
            }
            SelectionKind::Timeline => match (str_of(item, "aspect"), str_of(item, "text")) {
                (Some(aspect), Some(when)) => Some(format!("{}: {}", self.t(aspect), self.t(when))),
                (None, Some(when)) => Some(self.t(when)),
                _ => None,
            },
            SelectionKind::SourceAnnotation => self
                .named(ContextKind::Source, &item.target)
                .map(|named| self.t(&named.label)),
            SelectionKind::Explanation => self.entry_name(&item.target).map(|name| self.t(&name)),
        };
        match subject {
            Some(subject) => format!("{}: {subject}", self.t(noun)),
            None => self.t(noun),
        }
    }

    fn origin(&self, item: &CuratedItem) -> String {
        match &item.provenance {
            crate::curated_selection::Provenance::Authored => {
                "Where this metadata came from: written by the author.".to_string()
            }
            crate::curated_selection::Provenance::Imported { from } => format!(
                "Where this metadata came from: imported from {}.",
                self.t(from)
            ),
            crate::curated_selection::Provenance::Unrecorded => {
                "Where this metadata came from: not recorded.".to_string()
            }
        }
    }

    /// The rows of one item, as (label, value) in this syntax, in the order
    /// the page shows them. An address that cannot be a link is a row of its
    /// own, as text: it is the source's public address, never dropped.
    fn rows(&self, item: &CuratedItem) -> Vec<(String, String)> {
        let mut names: Vec<&str> = FIELD_ORDER
            .iter()
            .map(|(name, _)| *name)
            .filter(|name| item.content.contains_key(*name))
            .collect();
        let mut rest: Vec<&str> = item
            .content
            .keys()
            .map(String::as_str)
            .filter(|name| !names.contains(name) && !HIDDEN_FIELDS.contains(name))
            .collect();
        rest.sort_unstable();
        names.extend(rest);
        let dated = item.kind == SelectionKind::Timeline;
        let mut rows: Vec<(String, String)> = names
            .into_iter()
            .filter(|name| !HIDDEN_FIELDS.contains(name))
            // A dating reads as its stated words; the date's own fields are in the data file.
            .filter(|name| !(dated && *name == "date" && item.content.contains_key("text")))
            .filter_map(|name| {
                let raw = item.content.get(name)?;
                let value = match (name, raw.as_str()) {
                    // The entry a dating dates has a page of its own.
                    ("owner", Some(id)) if str_of(item, "ownerType") == Some("entry") => self.to(
                        &crate::atlas_publication::entry_url(id),
                        &self
                            .entry_name(id)
                            .map_or_else(|| self.t(id), |name| self.t(&name)),
                    ),
                    _ => self.value(name, raw, 0),
                };
                let label = if dated && name == "text" {
                    "Stated as".to_string()
                } else {
                    label_of(name)
                };
                (!value.is_empty()).then(|| (self.t(&label), value))
            })
            .collect();
        if let Some(url) = str_of(item, "url").filter(|url| !url.is_empty() && !safe_href(url)) {
            self.note_unlinked();
            rows.push((self.t("Address (not a link)"), self.t(url)));
        }
        rows
    }

    fn missing_line(&self, item: &CuratedItem) -> Option<String> {
        (!item.missing.is_empty()).then(|| {
            format!(
                "Not recorded, so left out and never invented: {}.",
                item.missing
                    .iter()
                    .map(|name| self.t(&label_of(name)))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
    }

    fn item_html(&self, item: &CuratedItem) -> String {
        let mut html = format!(
            "<li class=\"ob-curated-item\" id=\"{}\" data-curated-kind=\"{}\" data-curated-id=\"{}\">\n",
            attr(&format!("{ANCHOR_PREFIX}{}", item.id)),
            attr(item.kind.as_str()),
            attr(&item.id)
        );
        let link = str_of(item, "url").filter(|url| safe_href(url));
        let heading = self.heading(item);
        html.push_str(&match link {
            Some(url) => format!(
                "<h3 class=\"ob-curated-heading\"><a href=\"{}\">{heading}</a></h3>\n",
                attr(url)
            ),
            None => format!("<h3 class=\"ob-curated-heading\">{heading}</h3>\n"),
        });
        let rows: String = self
            .rows(item)
            .into_iter()
            .map(|(label, value)| format!("<dt>{label}</dt>\n<dd>{value}</dd>\n"))
            .collect();
        if !rows.is_empty() {
            html.push_str(&format!("<dl class=\"ob-curated-fields\">\n{rows}</dl>\n"));
        }
        if let Some(missing) = self.missing_line(item) {
            html.push_str(&format!("<p class=\"ob-curated-missing\">{missing}</p>\n"));
        }
        if item.kind == SelectionKind::Reference {
            html.push_str(&format!(
                "<p class=\"ob-curated-origin\">{}</p>\n",
                self.origin(item)
            ));
        }
        if !item.notices.is_empty() {
            html.push_str("<ul class=\"ob-curated-notices\" aria-label=\"Notices\">\n");
            for notice in &item.notices {
                html.push_str(&format!(
                    "<li data-curated-notice=\"{}\">{}</li>\n",
                    attr(
                        serde_json::to_value(notice.code)
                            .ok()
                            .as_ref()
                            .and_then(Value::as_str)
                            .unwrap_or("notice")
                    ),
                    text(&notice_text(notice))
                ));
            }
            html.push_str("</ul>\n");
        }
        html.push_str("</li>\n");
        html
    }

    /// One item of a portable copy's HTML: no ids or data attributes, a
    /// heading that links to the item's own page when it has one, and a link
    /// to the item's anchor on the canonical page.
    fn item_copy_html(&self, item: &CuratedItem) -> String {
        let mut html = String::from("<li>\n");
        let link = str_of(item, "url").filter(|url| safe_href(url));
        let heading = self.heading(item);
        html.push_str(&format!(
            "<h3>{}</h3>\n",
            match link {
                Some(url) => self.to(url, &heading),
                None => heading,
            }
        ));
        let rows: String = self
            .rows(item)
            .into_iter()
            .map(|(label, value)| format!("<dt>{label}</dt>\n<dd>{value}</dd>\n"))
            .collect();
        if !rows.is_empty() {
            html.push_str(&format!("<dl>\n{rows}</dl>\n"));
        }
        if let Some(missing) = self.missing_line(item) {
            html.push_str(&format!("<p>{missing}</p>\n"));
        }
        if item.kind == SelectionKind::Reference {
            html.push_str(&format!("<p>{}</p>\n", self.origin(item)));
        }
        if !item.notices.is_empty() {
            html.push_str("<ul>\n");
            for notice in &item.notices {
                html.push_str(&format!("<li>{}</li>\n", text(&notice_text(notice))));
            }
            html.push_str("</ul>\n");
        }
        html.push_str(&format!(
            "<p>{}</p>\n</li>\n",
            self.in_page(
                &format!("{ANCHOR_PREFIX}{}", item.id),
                "This item on the original article",
                ""
            )
        ));
        html
    }

    /// One item of a portable copy's Markdown: a heading, then one line per
    /// row, the caveats, and the link to the item's anchor on the canonical
    /// page.
    fn item_copy_markdown(&self, item: &CuratedItem) -> String {
        let link = str_of(item, "url").filter(|url| safe_href(url));
        let heading = self.heading(item);
        let mut out = format!(
            "### {}\n\n",
            match link {
                Some(url) => self.to(url, &heading),
                None => heading,
            }
        );
        for (label, value) in self.rows(item) {
            out.push_str(&format!("- {label}: {value}\n"));
        }
        if let Some(missing) = self.missing_line(item) {
            out.push_str(&format!("- {missing}\n"));
        }
        if item.kind == SelectionKind::Reference {
            out.push_str(&format!("- {}\n", self.origin(item)));
        }
        for notice in &item.notices {
            out.push_str(&format!("- Notice: {}\n", md_text(&notice_text(notice))));
        }
        out.push_str(&format!(
            "- {}\n\n",
            self.in_page(
                &format!("{ANCHOR_PREFIX}{}", item.id),
                "This item on the original article",
                ""
            )
        ));
        out
    }

    /// What one reference in the list names, in this syntax: the item's public
    /// name (linked when it has a safe address), what the source says it is,
    /// and an address that cannot be a link as text.
    fn context_entry(&self, item: &ContextItem) -> String {
        let name = item.label.as_deref().unwrap_or(&item.id);
        let named = match (item.url.as_deref().filter(|url| safe_href(url)), item.kind) {
            (Some(url), _) => self.to(url, &self.t(name)),
            (None, ContextKind::Source) => self.cite(&self.t(name)),
            (None, _) => self.t(name),
        };
        let unlinked = item
            .url
            .as_deref()
            .filter(|url| !url.is_empty() && !safe_href(url))
            .map(|url| {
                self.note_unlinked();
                match self.syntax {
                    Syntax::Html if self.copy.is_none() => format!(
                        " <span class=\"ob-curated-address\">(address, not a link: {})</span>",
                        text(url)
                    ),
                    _ => format!(" (address, not a link: {})", self.t(url)),
                }
            })
            .unwrap_or_default();
        let detail = match (&item.source, item.kind) {
            (Some(source), ContextKind::Source) if source.text != name => {
                format!(" — {}", self.t(&source.text))
            }
            _ => String::new(),
        };
        format!("{named}{detail}{unlinked}")
    }

    fn context_html(&self, listed: &[&ContextItem]) -> String {
        let mut html = format!(
            "<h3 class=\"ob-curated-heading\" id=\"{REFS_HEADING_ID}\">What these refer to</h3>\n<ul class=\"ob-curated-context\" role=\"list\">\n",
        );
        for item in listed {
            html.push_str(&format!(
                "<li id=\"{}\" data-curated-context-kind=\"{}\">{} <span class=\"ob-curated-via\">({})</span></li>\n",
                attr(&anchor(context_noun(item.kind), &item.id)),
                attr(context_noun(item.kind)),
                self.context_entry(item),
                text(context_noun(item.kind))
            ));
        }
        html.push_str("</ul>\n");
        html
    }

    /// The items a post's section shows, in the author's order, and how many
    /// more the bound held back; and the context its items need.
    fn chosen(&self, post: &PostContext) -> (Vec<&'a CuratedItem>, usize, Vec<&'a ContextItem>) {
        let mut items: Vec<&CuratedItem> = post
            .items
            .iter()
            .filter_map(|reference| self.context.item(&reference.id))
            .collect();
        let held_back = items.len().saturating_sub(MAX_PAGE_ITEMS);
        items.truncate(MAX_PAGE_ITEMS);
        let listed = post
            .context
            .iter()
            .filter_map(|reference| self.context.context_item(reference.kind, &reference.id))
            .collect();
        (items, held_back, listed)
    }

    /// The whole section, or `None` when the post offers nothing.
    fn section(&self, post: &PostContext, data_url: Option<&str>) -> Option<String> {
        let (items, held_back, listed) = self.chosen(post);
        if items.is_empty() {
            return None;
        }
        let mut html = format!(
            "<section class=\"ob-curated\" id=\"{SECTION_ID}\" aria-labelledby=\"{SECTION_ID}-title\" data-curated-context=\"{}\">\n",
            items.len()
        );
        html.push_str(&format!(
            "<h2 class=\"ob-curated-title\" id=\"{SECTION_ID}-title\">Research context</h2>\n"
        ));
        html.push_str(&format!("<p class=\"ob-curated-note\">{NOTE}"));
        if let Some(url) = data_url {
            html.push_str(&format!(
                " <a class=\"ob-curated-data\" href=\"{}\">The same context as data</a>.",
                attr(url)
            ));
        }
        html.push_str("</p>\n<ol class=\"ob-curated-items\" role=\"list\">\n");
        for item in items {
            html.push_str(&self.item_html(item));
        }
        html.push_str("</ol>\n");
        if held_back > 0 {
            html.push_str(&format!(
                "<p class=\"ob-curated-more\">This page shows the first {MAX_PAGE_ITEMS} items. {held_back} more {} in the data file for this post.</p>\n",
                if held_back == 1 { "is" } else { "are" }
            ));
        }
        if !listed.is_empty() {
            html.push_str(&self.context_html(&listed));
        }
        html.push_str("</section>\n");
        Some(html)
    }

    /// The section of a portable copy (ADR 0202), in this page's syntax.
    fn copy_section(&self, post: &PostContext) -> Option<CopySection> {
        let copy = self.copy?;
        let (items, held_back, listed) = self.chosen(post);
        if items.is_empty() {
            return None;
        }
        let section_link = self.in_page(
            SECTION_ID,
            "Read this research context on the original article",
            "",
        );
        let more = |count: usize| {
            format!(
                "This copy shows the first {MAX_PAGE_ITEMS} items. {count} more {} on the original article.",
                if count == 1 { "is" } else { "are" }
            )
        };
        let mut out = String::new();
        match self.syntax {
            Syntax::Html => {
                out.push_str(
                    "<section aria-label=\"Research context\">\n<h2>Research context</h2>\n",
                );
                out.push_str(&format!("<p>{NOTE} {section_link}.</p>\n<ol>\n"));
                for item in &items {
                    out.push_str(&self.item_copy_html(item));
                }
                out.push_str("</ol>\n");
                if held_back > 0 {
                    out.push_str(&format!("<p>{}</p>\n", more(held_back)));
                }
                if !listed.is_empty() {
                    out.push_str("<h3>What these refer to</h3>\n<ul>\n");
                    for item in &listed {
                        out.push_str(&format!(
                            "<li>{} ({})</li>\n",
                            self.context_entry(item),
                            text(context_noun(item.kind))
                        ));
                    }
                    out.push_str("</ul>\n");
                }
                out.push_str("</section>\n");
            }
            Syntax::Markdown => {
                out.push_str("## Research context\n\n");
                out.push_str(&format!("{} {section_link}.\n\n", md_text(NOTE)));
                for item in &items {
                    out.push_str(&self.item_copy_markdown(item));
                }
                if held_back > 0 {
                    out.push_str(&format!("{}\n\n", md_text(&more(held_back))));
                }
                if !listed.is_empty() {
                    out.push_str("### What these refer to\n\n");
                    for item in &listed {
                        out.push_str(&format!(
                            "- {} ({})\n",
                            self.context_entry(item),
                            md_text(context_noun(item.kind))
                        ));
                    }
                    out.push('\n');
                }
            }
        }
        let mut leaves = Vec::new();
        for item in &items {
            collect_prose(
                &Value::Object(item.content.clone().into_iter().collect()),
                &mut leaves,
            );
        }
        Some(CopySection {
            text: out,
            anchors: items
                .iter()
                .map(|item| format!("{}#{ANCHOR_PREFIX}{}", copy.canonical, item.id))
                .collect(),
            leaves,
            items: items.len(),
            held_back,
            unlinked: self.unlinked.get(),
        })
    }
}

/// The note every section opens with.
const NOTE: &str = "Chosen by the author from their research, in the order they gave. Each item says who holds a view, how firmly and on what evidence; none of it is a verdict, and what a source does not say is listed as not recorded.";

/// The fields whose strings are the item's own words: what a copy must carry
/// whole. The identity fields and ids are not words, and are not in the list.
const PROSE_FIELDS: &[&str] = &[
    "summary",
    "text",
    "by",
    "note",
    "uncertainty",
    "rationale",
    "label",
    "title",
    "inverseLabel",
    "correspondenceLabel",
    "confidence",
    "standing",
    "name",
];

fn collect_prose(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (key, inner) in object {
                match inner {
                    Value::String(words) if PROSE_FIELDS.contains(&key.as_str()) => {
                        if !fold(words).is_empty() {
                            out.push(words.clone());
                        }
                    }
                    Value::Object(_) | Value::Array(_) => collect_prose(inner, out),
                    _ => {}
                }
            }
        }
        Value::Array(list) => {
            for inner in list {
                collect_prose(inner, out);
            }
        }
        _ => {}
    }
}

/// A string reduced to its letters and digits, with the entities the escapers
/// write decoded first, so a value can be found in HTML, Markdown or text
/// whatever each escaped.
fn fold(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// One post's research context as a portable copy writes it (ADR 0202),
/// with what a copy must carry whole and what it could not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CopySection {
    /// The section in the copy's syntax.
    pub text: String,
    /// The canonical address of each item shown, in order.
    anchors: Vec<String>,
    /// The words of the shown items: every one must be in the copy.
    leaves: Vec<String>,
    /// How many items the copy shows.
    pub items: usize,
    /// How many more the bound held back; they are on the canonical page.
    pub held_back: usize,
    /// How many addresses are shown as text because they cannot be links.
    pub unlinked: usize,
}

impl CopySection {
    /// Whether `artifact` carries every shown item's canonical anchor, in
    /// order, and every word the items are made of. Reads the artifact only to
    /// check it, never to build anything.
    pub fn carried_by(&self, artifact: &str) -> bool {
        self.first_missing(artifact).is_none()
    }

    /// What `artifact` lacks first: an item's canonical anchor, or the words of
    /// an item, as a short description naming the field and never more than a
    /// few words of it.
    pub fn first_missing(&self, artifact: &str) -> Option<String> {
        let mut rest = artifact;
        for anchor in &self.anchors {
            match rest.find(anchor.as_str()) {
                Some(at) => rest = &rest[at + anchor.len()..],
                None => return Some(format!("the link to {anchor}")),
            }
        }
        let folded = fold(artifact);
        self.leaves
            .iter()
            .find(|words| !folded.contains(&fold(words)))
            .map(|words| format!("the words `{}`", words.chars().take(40).collect::<String>()))
    }
}

/// The id of the "what these refer to" heading.
const REFS_HEADING_ID: &str = "ob-curated-ref_list";

/// What a notice says to a reader, from its `code` and `field` alone: the
/// author's own message names selection ids and fields in the words of the
/// Admin, which a reader of the page should not see.
fn notice_text(notice: &crate::curated_selection::ItemNotice) -> String {
    use crate::curated_selection::NoticeCode;
    let field = notice
        .field
        .as_deref()
        .map(|field| label_of(field.split(['.', '[']).next().unwrap_or(field)).to_lowercase());
    match (notice.code, field) {
        (NoticeCode::CompetingUnselected, _) => {
            "Other datings of the same aspect exist on this site and were not chosen here."
                .to_string()
        }
        (NoticeCode::MissingDetail, Some(field)) => {
            format!("The source does not record the {field}; it is left out, not invented.")
        }
        (NoticeCode::MissingDetail, None) => {
            "A detail the source does not record is left out, not invented.".to_string()
        }
        (NoticeCode::ProvenanceUnrecorded, _) => {
            "Where this metadata came from is not recorded.".to_string()
        }
        (NoticeCode::RightsRestricted, _) => {
            "Some wording is identified and located but not shown, because of its rights statement or length."
                .to_string()
        }
        (NoticeCode::UnsafeUrl, _) | (NoticeCode::PrivateIdentifier, _) => {
            "An address or identifier is not published.".to_string()
        }
    }
}

/// The anchor of one thing in the "what these refer to" list. It uses an
/// underscore, which a selection id (a lowercase slug) never holds, so it can
/// never be the anchor of a selection.
fn anchor(kind: &str, id: &str) -> String {
    format!("{ANCHOR_PREFIX}ref_{kind}_{id}")
}

impl CuratedContext {
    /// The static section of one post's page: semantic headings, lists and
    /// definitions that read in order without CSS or JavaScript, an anchor on
    /// each item, and the attribution, uncertainty, evidence and origin of
    /// every item as text. `None` when the post offers nothing, so its page
    /// is exactly what it was. `data_url` is the address of the data file,
    /// when the build writes it.
    pub fn post_section_html(&self, slug: &str, data_url: Option<&str>) -> Option<String> {
        let post = self.for_post(slug)?;
        Page::new(self, post, Syntax::Html, None).section(post, data_url)
    }

    /// The same context as one post's portable HTML (ADR 0202): semantic
    /// headings, lists and definitions with no ids, scripts or data
    /// attributes, every link absolute, and a link to each item's anchor and
    /// to the section on the canonical page. `None` when the post offers
    /// nothing, so its copy is exactly what it was.
    pub fn copy_html(&self, slug: &str, links: &CopyLinks<'_>) -> Option<CopySection> {
        let post = self.for_post(slug)?;
        Page::new(self, post, Syntax::Html, Some(links)).copy_section(post)
    }

    /// The same context as one post's portable Markdown (ADR 0202), every
    /// value escaped as inline text. Plain text is derived from this.
    pub fn copy_markdown(&self, slug: &str, links: &CopyLinks<'_>) -> Option<CopySection> {
        let post = self.for_post(slug)?;
        Page::new(self, post, Syntax::Markdown, Some(links)).copy_section(post)
    }

    /// What a bibliography export can carry of one post's curated context
    /// (ADR 0205): the references the author selected for it, as the public
    /// description the exporters already read, in the author's order. Every
    /// other kind of item has no place in a bibliography; each is listed in
    /// `not_carried`, so the export can say what it left out.
    pub fn bibliography_for_post(&self, slug: &str) -> Option<BibliographyContext> {
        let post = self.for_post(slug)?;
        let mut carried = BibliographyContext::default();
        for item in post
            .items
            .iter()
            .filter_map(|reference| self.item(&reference.id))
        {
            match (item.kind, public_reference_of(item)) {
                (SelectionKind::Reference, Some(reference)) => carried.references.push(reference),
                _ => carried
                    .not_carried
                    .push((item.id.clone(), item.kind.as_str())),
            }
        }
        Some(carried)
    }

    /// What a feed that carries no full content says of one post's context:
    /// where it is on the canonical page and which items it holds, by id,
    /// kind and anchor. No words of any item.
    pub fn feed_summary(&self, slug: &str, canonical: &str) -> Option<Value> {
        let post = self.for_post(slug)?;
        let items: Vec<Value> = post
            .items
            .iter()
            .filter_map(|reference| self.item(&reference.id))
            .map(|item| {
                serde_json::json!({
                    "id": item.id,
                    "kind": item.kind.as_str(),
                    "url": format!("{canonical}#{ANCHOR_PREFIX}{}", item.id),
                })
            })
            .collect();
        (!items.is_empty()).then(|| {
            serde_json::json!({
                "url": format!("{canonical}#{SECTION_ID}"),
                "items": items,
            })
        })
    }
}

/// The references a post's curated context holds for a bibliography, and the
/// items it holds that no bibliography format can carry (ADR 0205).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BibliographyContext {
    pub references: Vec<crate::citations::PublicReference>,
    /// (the item's id, what kind of item it is)
    pub not_carried: Vec<(String, &'static str)>,
}

/// A selected reference as the public description the exporters read. Only
/// what the item holds is set: a detail the author did not select, or the
/// source does not have, stays absent and is never filled in.
fn public_reference_of(item: &CuratedItem) -> Option<crate::citations::PublicReference> {
    use crate::citations::{PublicCreator, PublicReference};
    let content = &item.content;
    let key = content.get("key").and_then(Value::as_str)?.to_string();
    let kind = crate::source_library::ResearchSourceKind::parse(
        content.get("kind").and_then(Value::as_str)?,
    )?
    .as_str();
    let string = |name: &str| {
        content
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let creators = content
        .get("creators")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|creator| {
                    Some(PublicCreator {
                        name: creator.get("name")?.as_str()?.to_string(),
                        role: creator
                            .get("role")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let identifiers = content
        .get("identifiers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|pair| {
                    let pair = pair.as_array()?;
                    Some((
                        pair.first()?.as_str()?.to_string(),
                        pair.get(1)?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let csl = content
        .get("csl")
        .and_then(Value::as_object)
        .map(|bag| {
            bag.iter()
                .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    Some(PublicReference {
        key,
        kind,
        title: string("title"),
        creators,
        issued: string("issued"),
        language: string("language"),
        identifiers,
        csl,
    })
}
