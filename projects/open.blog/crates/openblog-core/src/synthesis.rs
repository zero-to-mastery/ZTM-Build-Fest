//! Shared synthesis items: optional, attributed statements a shared reflection's authors make
//! about what their separate drafts add up to.
//!
//! An item has a kind (agreement, difference, question, application or uncertainty), untrusted
//! Markdown, and an ordered list of the authors it speaks for: one, some or all of them. Nothing
//! is required: an empty synthesis is valid, no kind has to appear, and the model never compares
//! items, so authors who disagree simply write a difference (or two overlapping ones) and
//! nothing is ever rejected for it (ADR 0024).
//!
//! The set is private collaboration state. It stores prose, so it never reaches a Post, page,
//! feed or export until a later assembly step publishes it, and [`SynthesisSet::binding_frame`]
//! hands approval a prose-free digest (never the Markdown) so an approval covers the exact items,
//! order and attribution (ADR 0020). Every change names the set revision the caller read, so a
//! concurrent change is refused as [`SynthesisError::Stale`] and a failed call changes nothing.
//! Refusals about items the requester may not touch are the same [`SynthesisError::Denied`].

use std::collections::HashSet;
use std::fmt;

use blake2::{Blake2s256, Digest};
use serde::{Deserialize, Serialize};

use crate::collaboration::{valid_id, MAX_PARTICIPANTS};

pub const SYNTHESIS_SET_VERSION: u8 = 1;
pub const MAX_SYNTHESIS_ITEMS: usize = 100;
pub const MAX_SYNTHESIS_MARKDOWN_BYTES: usize = 8 * 1024;
pub const MAX_SYNTHESIS_SET_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SynthesisError {
    /// The requester is not an author, or the item is not theirs to touch or does not exist.
    Denied,
    /// The caller's view of the set is no longer the current set.
    Stale,
    /// The input is malformed or exceeds a limit.
    Invalid,
    /// The item's Markdown breaks a structural rule publishing would refuse it for.
    Rule(ItemRule),
}

impl fmt::Display for SynthesisError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Denied => "synthesis access denied",
            Self::Stale => "the synthesis changed since it was read",
            Self::Invalid => "invalid synthesis",
            Self::Rule(_) => "synthesis item breaks a publishing rule",
        })
    }
}

impl std::error::Error for SynthesisError {}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SynthesisKind {
    Agreement,
    Difference,
    Question,
    Application,
    Uncertainty,
}

impl SynthesisKind {
    fn tag(self) -> &'static str {
        match self {
            Self::Agreement => "agreement",
            Self::Difference => "difference",
            Self::Question => "question",
            Self::Application => "application",
            Self::Uncertainty => "uncertainty",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SynthesisItem {
    id: String,
    kind: SynthesisKind,
    markdown: String,
    contributors: Vec<String>,
    revision: u64,
    #[serde(default)]
    approvals: Vec<ItemApproval>,
}

/// One author's approval of one item, bound to the item revision and digest they approved.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ItemApproval {
    author: String,
    revision: u64,
    digest: String,
}

/// Where one item stands: who has approved its current revision and who is still awaited.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemApprovalStatus {
    pub item_id: String,
    pub revision: u64,
    pub approved: Vec<String>,
    pub awaiting: Vec<String>,
}

impl ItemApprovalStatus {
    /// True when every attributed author has approved the current revision.
    pub fn is_approved(&self) -> bool {
        self.awaiting.is_empty()
    }
}

impl SynthesisItem {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn kind(&self) -> SynthesisKind {
        self.kind
    }
    /// Untrusted Markdown: clients render it as text or through the sanitizing renderer.
    pub fn markdown(&self) -> &str {
        &self.markdown
    }
    /// The authors this item speaks for, in the order they were attributed.
    pub fn contributors(&self) -> &[String] {
        &self.contributors
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// The attributed authors who approved this exact revision, in attribution order.
    pub fn approved_by(&self) -> Vec<&str> {
        let digest = self.digest();
        self.contributors
            .iter()
            .filter(|author| {
                self.approvals.iter().any(|a| {
                    a.author == **author && a.revision == self.revision && a.digest == digest
                })
            })
            .map(String::as_str)
            .collect()
    }

    /// The attributed authors who have not approved this exact revision.
    pub fn awaiting(&self) -> Vec<&str> {
        let approved = self.approved_by();
        self.contributors
            .iter()
            .map(String::as_str)
            .filter(|author| !approved.contains(author))
            .collect()
    }

    /// Approved only when every attributed author approved the current revision.
    pub fn is_approved(&self) -> bool {
        self.awaiting().is_empty()
    }

    fn status(&self) -> ItemApprovalStatus {
        ItemApprovalStatus {
            item_id: self.id.clone(),
            revision: self.revision,
            approved: self.approved_by().into_iter().map(str::to_owned).collect(),
            awaiting: self.awaiting().into_iter().map(str::to_owned).collect(),
        }
    }

    fn approvals_are_valid(&self) -> bool {
        let mut seen = HashSet::new();
        self.approvals.len() <= MAX_PARTICIPANTS
            && self
                .approvals
                .iter()
                .all(|a| self.contributors.contains(&a.author) && seen.insert(a.author.as_str()))
    }

    fn digest(&self) -> String {
        let mut hasher = Blake2s256::new();
        hasher.update(b"openblog-synthesis-item-v1\0");
        for part in [self.id.as_str(), self.kind.tag(), self.markdown.as_str()] {
            hasher.update((part.len() as u64).to_be_bytes());
            hasher.update(part.as_bytes());
        }
        hasher.update((self.contributors.len() as u64).to_be_bytes());
        for contributor in &self.contributors {
            hasher.update((contributor.len() as u64).to_be_bytes());
            hasher.update(contributor.as_bytes());
        }
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

/// A new item. The requester is always attributed first, then `others` in order.
#[derive(Clone, Copy, Debug)]
pub struct NewSynthesisItem<'a> {
    pub kind: SynthesisKind,
    pub markdown: &'a str,
    pub others: &'a [&'a str],
}

/// A change to an item. Attribution can only grow here: nobody can remove another author, and
/// each author takes themselves off through [`SynthesisSet::withdraw`].
#[derive(Clone, Copy, Debug, Default)]
pub struct SynthesisEdit<'a> {
    pub kind: Option<SynthesisKind>,
    pub markdown: Option<&'a str>,
    pub add_contributors: &'a [&'a str],
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SynthesisSet {
    version: u8,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    next_id: u64,
    #[serde(default)]
    items: Vec<SynthesisItem>,
}

impl Default for SynthesisSet {
    fn default() -> Self {
        Self::new()
    }
}

/// The anchor of the heading above the whole conversation. Generated, so authors may not claim it.
pub const CONVERSATION_ANCHOR: &str = "continuing-the-conversation";
/// The category part of every generated category and item anchor (`conversation-<category>`).
const CONVERSATION_CATEGORIES: [&str; 5] = [
    "agreement",
    "difference",
    "question",
    "application",
    "uncertainty",
];

/// Whether an anchor is exactly one a generated block produces: the conversation's
/// `continuing-the-conversation`, `conversation-<category>` or `conversation-<category>-<n>`, or
/// the published moments' `moments-in-the-sources` or `moments-in-the-sources-<n>` (ADR 0066).
/// Nothing else is reserved, so a heading such as "Conversation starters" is fine.
pub fn is_reserved_anchor(id: &str) -> bool {
    let id = id.trim().to_ascii_lowercase();
    if crate::published_moment::is_reserved_anchor(&id) {
        return true;
    }
    if id == CONVERSATION_ANCHOR {
        return true;
    }
    let Some(rest) = id.strip_prefix("conversation-") else {
        return false;
    };
    CONVERSATION_CATEGORIES.iter().any(|category| {
        rest.strip_prefix(category).is_some_and(|tail| {
            tail.is_empty()
                || tail
                    .strip_prefix('-')
                    .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
    })
}

/// The rule an item's Markdown breaks, named so a refusal can say which.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemRule {
    /// Raw HTML, an active link or image address, heading attributes beyond an id and classes,
    /// or Markdown that reaches into a neighbouring item.
    Markup,
    /// Headings must start at level 5 and may go one level deeper at a time, so the page outline
    /// under the generated levels 2 to 4 never skips or repeats them.
    Outline,
    /// A heading id or text that would claim a generated anchor.
    ReservedAnchor,
}

impl ItemRule {
    /// A sentence fragment naming the rule, safe to show (it holds no author text).
    pub fn describe(self) -> &'static str {
        match self {
            Self::Markup => "raw HTML, an unsafe link or image address, or Markdown that reaches another item",
            Self::Outline => "a heading above level 5, or one that skips a level (items may only use headings from level 5, one level deeper at a time)",
            Self::ReservedAnchor => "a heading whose anchor is reserved for the generated conversation (`continuing-the-conversation` or `conversation-<category>[-<n>]`) or the published moments (`moments-in-the-sources[-<n>]`)",
        }
    }
}

/// Heading levels and anchors in `markdown`: the level, the id the author wrote, and the slug of
/// the text, which is the id the renderer gives a heading without one. Parsed with and without
/// smart punctuation because the site setting is not known here.
pub(crate) fn headings(markdown: &str) -> Vec<(u8, Vec<String>)> {
    use pulldown_cmark::{Event, Parser, Tag, TagEnd};
    let mut found = Vec::new();
    for smart in [false, true] {
        let mut open: Option<(u8, Option<String>, String)> = None;
        for event in Parser::new_ext(markdown, crate::markdown::parser_options(smart)) {
            match event {
                Event::Start(Tag::Heading { level, id, .. }) => {
                    open = Some((level as u8, id.map(|id| id.to_string()), String::new()));
                }
                Event::Text(text) | Event::Code(text) => {
                    if let Some((_, _, title)) = open.as_mut() {
                        title.push_str(&text);
                    }
                }
                Event::SoftBreak | Event::HardBreak => {
                    if let Some((_, _, title)) = open.as_mut() {
                        title.push(' ');
                    }
                }
                Event::End(TagEnd::Heading(_)) => {
                    if let Some((level, explicit, title)) = open.take() {
                        let mut anchors = vec![crate::slug::slugify(&title)];
                        anchors.extend(explicit);
                        found.push((level, anchors));
                    }
                }
                _ => {}
            }
        }
    }
    found
}

/// Whether any heading in `markdown` would claim a generated conversation anchor.
pub(crate) fn claims_reserved_anchor(markdown: &str) -> bool {
    headings(markdown)
        .iter()
        .any(|(_, anchors)| anchors.iter().any(|anchor| is_reserved_anchor(anchor)))
}

/// The structural rules for an item's Markdown that do not depend on anything else in the post.
/// Checked when an item is saved so an author learns early, and again when publishing.
pub fn check_item_markdown(markdown: &str) -> Result<(), ItemRule> {
    if claims_reserved_anchor(markdown) {
        return Err(ItemRule::ReservedAnchor);
    }
    // Under the generated H2 to H4, the first heading is H5 and none jumps more than one deeper.
    let mut previous = 4u8;
    for (level, _) in headings(markdown) {
        if level < 5 || level > previous + 1 {
            return Err(ItemRule::Outline);
        }
        previous = level;
    }
    Ok(())
}

fn valid_markdown(markdown: &str) -> bool {
    !markdown.trim().is_empty()
        && markdown.len() <= MAX_SYNTHESIS_MARKDOWN_BYTES
        && !markdown.chars().any(|c| {
            (c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
                || c == '\u{2028}'
                || c == '\u{2029}'
        })
}

fn valid_contributors(contributors: &[String]) -> bool {
    let mut seen = HashSet::new();
    !contributors.is_empty()
        && contributors.len() <= MAX_PARTICIPANTS
        && contributors
            .iter()
            .all(|id| valid_id(id) && seen.insert(id.to_ascii_lowercase()))
}

fn check_author(requester: &str, authors: &[&str]) -> Result<(), SynthesisError> {
    if authors.contains(&requester) {
        Ok(())
    } else {
        Err(SynthesisError::Denied)
    }
}

impl SynthesisSet {
    /// An empty synthesis, which is a complete and valid one.
    pub fn new() -> Self {
        Self {
            version: SYNTHESIS_SET_VERSION,
            revision: 0,
            next_id: 0,
            items: Vec::new(),
        }
    }

    pub fn from_json(source: &str) -> Result<Self, SynthesisError> {
        if source.len() > MAX_SYNTHESIS_SET_BYTES {
            return Err(SynthesisError::Invalid);
        }
        let set: Self = serde_json::from_str(source).map_err(|_| SynthesisError::Invalid)?;
        if !set.is_valid() {
            return Err(SynthesisError::Invalid);
        }
        Ok(set)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("a synthesis set always serializes")
    }

    fn is_valid(&self) -> bool {
        let mut ids = HashSet::new();
        self.version == SYNTHESIS_SET_VERSION
            && self.items.len() <= MAX_SYNTHESIS_ITEMS
            && self.items.iter().all(|item| {
                valid_id(&item.id)
                    && ids.insert(item.id.to_ascii_lowercase())
                    && valid_markdown(&item.markdown)
                    && valid_contributors(&item.contributors)
                    && self.minted_id_in_range(&item.id)
                    && item.approvals_are_valid()
            })
    }

    /// An id this set mints (`syn-N`) must not be ahead of the counter, or the next add could
    /// mint a duplicate.
    fn minted_id_in_range(&self, id: &str) -> bool {
        match id.to_ascii_lowercase().strip_prefix("syn-") {
            Some(number) if number.bytes().all(|b| b.is_ascii_digit()) => number
                .parse::<u64>()
                .is_ok_and(|number| number <= self.next_id),
            _ => true,
        }
    }

    /// The revision callers send back as `expected` so a concurrent change is refused.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// The items in publication order, for callers that have already authorized an author (the
    /// preview and the publish gate). Never hand this to a request that has not.
    pub fn items(&self) -> &[SynthesisItem] {
        &self.items
    }

    /// The items in publication order, for an author only. Anyone else gets `Denied`.
    pub fn view(
        &self,
        requester: &str,
        authors: &[&str],
    ) -> Result<&[SynthesisItem], SynthesisError> {
        check_author(requester, authors)?;
        Ok(&self.items)
    }

    fn guard(
        &self,
        requester: &str,
        authors: &[&str],
        expected: u64,
    ) -> Result<(), SynthesisError> {
        check_author(requester, authors)?;
        if expected != self.revision {
            return Err(SynthesisError::Stale);
        }
        Ok(())
    }

    /// Add an item. Returns its id.
    pub fn add(
        &mut self,
        requester: &str,
        authors: &[&str],
        expected: u64,
        new: NewSynthesisItem<'_>,
    ) -> Result<String, SynthesisError> {
        self.guard(requester, authors, expected)?;
        if !valid_markdown(new.markdown) || self.items.len() >= MAX_SYNTHESIS_ITEMS {
            return Err(SynthesisError::Invalid);
        }
        check_item_markdown(new.markdown).map_err(SynthesisError::Rule)?;
        let mut contributors = vec![requester.to_owned()];
        for other in new.others {
            if !authors.contains(other) {
                return Err(SynthesisError::Invalid);
            }
            contributors.push((*other).to_owned());
        }
        if !valid_contributors(&contributors) {
            return Err(SynthesisError::Invalid);
        }
        let next_id = self.next_id.checked_add(1).ok_or(SynthesisError::Invalid)?;
        let revision = self
            .revision
            .checked_add(1)
            .ok_or(SynthesisError::Invalid)?;
        self.next_id = next_id;
        let id = format!("syn-{next_id}");
        self.revision = revision;
        self.items.push(SynthesisItem {
            id: id.clone(),
            kind: new.kind,
            markdown: new.markdown.to_owned(),
            contributors,
            revision: 1,
            approvals: Vec::new(),
        });
        Ok(id)
    }

    fn position(&self, id: &str, requester: &str) -> Result<usize, SynthesisError> {
        self.items
            .iter()
            .position(|item| item.id == id && item.contributors.iter().any(|c| c == requester))
            .ok_or(SynthesisError::Denied)
    }

    /// Change an item. Only an author the item speaks for may.
    pub fn edit(
        &mut self,
        requester: &str,
        authors: &[&str],
        expected: u64,
        id: &str,
        edit: SynthesisEdit<'_>,
    ) -> Result<(), SynthesisError> {
        self.guard(requester, authors, expected)?;
        let index = self.position(id, requester)?;
        let mut item = self.items[index].clone();
        if let Some(kind) = edit.kind {
            item.kind = kind;
        }
        if let Some(markdown) = edit.markdown {
            if !valid_markdown(markdown) {
                return Err(SynthesisError::Invalid);
            }
            check_item_markdown(markdown).map_err(SynthesisError::Rule)?;
            item.markdown = markdown.to_owned();
        }
        for other in edit.add_contributors {
            if !authors.contains(other) {
                return Err(SynthesisError::Invalid);
            }
            if !item.contributors.iter().any(|c| c == other) {
                item.contributors.push((*other).to_owned());
            }
        }
        if !valid_contributors(&item.contributors) {
            return Err(SynthesisError::Invalid);
        }
        if item == self.items[index] {
            return Ok(());
        }
        // Any change to the item clears its approvals: they were bound to the old revision.
        item.revision = item
            .revision
            .checked_add(1)
            .ok_or(SynthesisError::Invalid)?;
        item.approvals.clear();
        let revision = self
            .revision
            .checked_add(1)
            .ok_or(SynthesisError::Invalid)?;
        self.items[index] = item;
        self.revision = revision;
        Ok(())
    }

    /// Take the requester's own name off an item. An item nobody speaks for any more is dropped.
    pub fn withdraw(
        &mut self,
        requester: &str,
        authors: &[&str],
        expected: u64,
        id: &str,
    ) -> Result<(), SynthesisError> {
        self.guard(requester, authors, expected)?;
        let index = self.position(id, requester)?;
        let revision = self
            .revision
            .checked_add(1)
            .ok_or(SynthesisError::Invalid)?;
        let item_revision = self.items[index]
            .revision
            .checked_add(1)
            .ok_or(SynthesisError::Invalid)?;
        self.items[index].contributors.retain(|c| c != requester);
        if self.items[index].contributors.is_empty() {
            self.items.remove(index);
        } else {
            self.items[index].revision = item_revision;
            self.items[index].approvals.clear();
        }
        self.revision = revision;
        Ok(())
    }

    /// Approve one item at its current revision. Only an author the item speaks for may, and
    /// anyone else gets the uniform `Denied`. Approving again changes nothing.
    pub fn approve_item(
        &mut self,
        requester: &str,
        authors: &[&str],
        expected: u64,
        id: &str,
    ) -> Result<(), SynthesisError> {
        self.guard(requester, authors, expected)?;
        let index = self.position(id, requester)?;
        if self.items[index].approved_by().contains(&requester) {
            return Ok(());
        }
        let revision = self
            .revision
            .checked_add(1)
            .ok_or(SynthesisError::Invalid)?;
        let item = &mut self.items[index];
        let approval = ItemApproval {
            author: requester.to_owned(),
            revision: item.revision,
            digest: item.digest(),
        };
        item.approvals.retain(|a| a.author != requester);
        item.approvals.push(approval);
        self.revision = revision;
        Ok(())
    }

    /// Who has approved each item and who is still awaited, in publication order, for an author
    /// only. Anyone else gets `Denied`.
    pub fn item_approvals(
        &self,
        requester: &str,
        authors: &[&str],
    ) -> Result<Vec<ItemApprovalStatus>, SynthesisError> {
        check_author(requester, authors)?;
        Ok(self.items.iter().map(SynthesisItem::status).collect())
    }

    /// Approval status of every item in publication order, for the gate and for server-side
    /// summaries that have already authorized their audience. Carries no prose.
    pub fn all_item_statuses(&self) -> Vec<ItemApprovalStatus> {
        self.items.iter().map(SynthesisItem::status).collect()
    }

    /// Every author named on any item, in first-appearance order. Whatever the approval policy,
    /// each of them must approve the piece, so no author can be bound to a statement they never
    /// saw.
    pub fn attributed_authors(&self) -> Vec<&str> {
        let mut seen = HashSet::new();
        self.items
            .iter()
            .flat_map(|item| item.contributors.iter().map(String::as_str))
            .filter(|author| seen.insert(*author))
            .collect()
    }

    /// Put the items in a new order. `order` must name every item exactly once.
    pub fn reorder(
        &mut self,
        requester: &str,
        authors: &[&str],
        expected: u64,
        order: &[&str],
    ) -> Result<(), SynthesisError> {
        self.guard(requester, authors, expected)?;
        let mut seen = HashSet::new();
        if order.len() != self.items.len() || !order.iter().all(|id| seen.insert(*id)) {
            return Err(SynthesisError::Invalid);
        }
        let mut next = Vec::with_capacity(order.len());
        for id in order {
            next.push(
                self.items
                    .iter()
                    .find(|item| item.id == *id)
                    .ok_or(SynthesisError::Invalid)?
                    .clone(),
            );
        }
        if next != self.items {
            self.items = next;
            self.revision += 1;
        }
        Ok(())
    }

    /// Drop attribution to anyone who is no longer an author, and any item that leaves with
    /// nobody speaking for it. Routes call this in the same write as an author-set change.
    /// Returns whether anything changed.
    pub fn reconcile(&mut self, authors: &[&str]) -> bool {
        let before = self.items.clone();
        for item in &mut self.items {
            let before_len = item.contributors.len();
            item.contributors.retain(|c| authors.contains(&c.as_str()));
            if item.contributors.len() != before_len {
                item.revision = item.revision.saturating_add(1);
                item.approvals.clear();
            }
        }
        self.items.retain(|item| !item.contributors.is_empty());
        let changed = self.items != before;
        if changed {
            self.revision = self.revision.saturating_add(1);
        }
        changed
    }

    /// Prose-free values to append to the approval subject's metadata, so an approval is bound
    /// to the exact items, their order and their attribution. Empty for an empty synthesis, so a
    /// piece without one binds exactly as before.
    pub fn binding_frame(&self) -> Vec<String> {
        if self.items.is_empty() {
            return Vec::new();
        }
        let mut frame = vec![format!("synthesis:{}", self.items.len())];
        frame.extend(self.items.iter().map(SynthesisItem::digest));
        frame
    }
}
