//! Approved Third Perspectives as the site publishes them (#222, ADR 0115).
//!
//! When a moderator approves a Third Perspective, Admin copies the parts the
//! one public projection reads ([`crate::third_perspective::ApprovedResponse`],
//! ADR 0111) into `third-perspectives.json` in the content folder, beside the
//! posts and `reader-feedback.json`. The file is versioned with the site, so
//! a static build, a CI build and a site that left its hosted service keep
//! showing what was approved, and nothing needs the service to read a page.
//!
//! The file holds only what may be public, because a site's repository can
//! be: the work and the post it is about, the passage revision and target
//! the reader wrote about, the optional prompt category, the text, the day it
//! was received and the day it was approved, and the reader's name only
//! while both the approved and the current consent showed it and it matched
//! no credited name. Never the receipt or its digest, the consent records,
//! the reader's clock, a time of day, the channel, a private name, a
//! moderator, a reason or anything about a copy that is not approved.
//!
//! A post shows its Third Perspectives through [`project_post`], which
//! re-applies the projection against the post as published now: only where
//! RD12's published mode shows approved items, never with a name the work
//! credits now, and with a section target's standing in the current text.
//! Only the canonical page shows them; portable copies, feeds and `llms`
//! files carry a labelled link to it instead (P6.2).
//!
//! An approved author response (#224, ADR 0137) is published in the same
//! file, as an `answer` on the reflection it answers, so the file is version
//! 2 only while it holds one. It holds only public fields, and the page shows
//! it only where [`crate::attributed_perspective::response_shown`] says so:
//! under its parent, about its own responder's section, in the kinds' shown
//! modes.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::SiteConfig;
use crate::date::DateTime;
use crate::escape::{attr, text};
use crate::feedback_publication::{is_day, is_post_source};
use crate::model::Post;
use crate::participation::ParticipationMode;
use crate::passage_target::{is_passage_revision, normalize_passage_text, PassageDocument};
use crate::scholarly_feedback::is_uuid;
use crate::third_perspective::{
    is_work_path, normalize_body, project, About, ApprovedResponse, HostedPerspective,
    ModerationFacts, PerspectiveTarget, PublicParts, PublishedWork, ResponseCategory, TargetStatus,
    MAX_READER_NAME_CHARS,
};

/// The file's name, in the content folder.
pub const THIRD_PERSPECTIVES_FILE: &str = "third-perspectives.json";
/// The version of the file format while no reflection has an answer, so a
/// site that never turns answers on keeps its file byte for byte.
pub const THIRD_PERSPECTIVES_VERSION: u64 = 1;
/// The version of the file once a reflection has a published `answer`; a
/// reader refuses a higher one.
pub const THIRD_PERSPECTIVES_ANSWERS_VERSION: u64 = 2;
/// The id of the section of a post's canonical page that lists them.
pub const THIRD_PERSPECTIVES_ANCHOR: &str = "ob-third-perspectives";
/// The capability a post with Third Perspectives carries, so portable copies
/// and feeds link to the canonical page (P6.2).
pub const THIRD_PERSPECTIVES_CAPABILITY: &str = "third-perspectives";
/// The most reflections the file holds.
pub const MAX_PUBLISHED_PERSPECTIVES: usize = 2_000;
/// The largest file accepted, before it is parsed.
pub const MAX_THIRD_PERSPECTIVES_BYTES: usize = 8 * 1024 * 1024;

/// One approved Third Perspective as the file stores it: exactly the parts
/// the public projection reads, and the ids that keep it in place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedPerspective {
    /// The hosted row's id, so the same reflection is never published twice.
    pub id: String,
    /// The post's source path in the content folder.
    pub post: String,
    /// The address the reader wrote about.
    pub work: String,
    /// The passage revision the reader saw.
    pub revision: String,
    pub target: PerspectiveTarget,
    pub category: Option<ResponseCategory>,
    pub body: String,
    /// The day the site received it, `YYYY-MM-DD`.
    pub received: String,
    /// The day it was approved, `YYYY-MM-DD`.
    pub approved: String,
    /// The reader's name, present only while the approved and the current
    /// consent showed it and it matched no name the work credited.
    pub name: Option<String>,
    /// The author's approved answer, when the reflection is about that
    /// author's own section.
    pub answer: Option<PublishedAnswer>,
}

/// One approved author response as the file stores it: only what is public.
/// Never the responder's participant, Admin account, the moderator, a reason
/// or a time of day.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedAnswer {
    /// The hosted row's id, which an abuse report names and Admin takes off by.
    pub id: String,
    /// The public contributor registry key the section is credited to.
    pub contributor: String,
    /// The name the section was published under when it was answered.
    pub author: String,
    pub body: String,
    /// The day the site received it, `YYYY-MM-DD`.
    pub received: String,
    /// The day it was approved, `YYYY-MM-DD`.
    pub approved: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireAnswer {
    id: String,
    contributor: String,
    author: String,
    body: String,
    received: String,
    approved: String,
}

impl PublishedAnswer {
    /// The public part of an approved answer: refused unless it is approved
    /// at its current text and still stored.
    pub fn from_hosted(
        hosted: &crate::author_response::HostedAuthorResponse,
        approved: DateTime,
    ) -> Result<Self, String> {
        if hosted.state != crate::moderation::ModerationState::Approved
            || hosted.approved_revision != Some(hosted.item_revision)
        {
            return Err("Only an approved author response is published".into());
        }
        let received = hosted.received_at.ymd();
        let answer = Self {
            id: hosted.id.to_ascii_lowercase(),
            contributor: hosted.responder.contributor.clone(),
            author: hosted.responder.author.clone(),
            body: hosted.body.clone(),
            approved: approved.ymd().max(received.clone()),
            received,
        };
        answer.validate()?;
        Ok(answer)
    }

    fn validate(&self) -> Result<(), String> {
        if !is_uuid(&self.id) || self.id != self.id.to_ascii_lowercase() {
            return Err("`answer.id` must be a lowercase UUID".into());
        }
        if !crate::collaboration::valid_contributor_id(&self.contributor) {
            return Err("`answer.contributor` must be a contributor registry key".into());
        }
        let count = self.author.chars().count();
        if count == 0
            || count > MAX_READER_NAME_CHARS
            || normalize_passage_text(&self.author) != self.author
            || self
                .author
                .chars()
                .any(|c| c.is_control() || crate::research_notes::bidi_override(c))
        {
            return Err(format!(
                "`answer.author` must be 1 to {MAX_READER_NAME_CHARS} characters of plain text"
            ));
        }
        if normalize_body(&self.body).as_deref() != Some(self.body.as_str()) {
            return Err("`answer.body` must be 1 to 4000 characters of plain text, trimmed".into());
        }
        if !is_day(&self.received) || !is_day(&self.approved) || self.approved < self.received {
            return Err("`answer.received` and `answer.approved` must be days written YYYY-MM-DD, approved not before received".into());
        }
        Ok(())
    }

    fn from_wire(wire: WireAnswer) -> Result<Self, String> {
        let answer = Self {
            id: wire.id,
            contributor: wire.contributor,
            author: wire.author,
            body: wire.body,
            received: wire.received,
            approved: wire.approved,
        };
        answer.validate()?;
        Ok(answer)
    }

    fn to_wire(&self) -> WireAnswer {
        WireAnswer {
            id: self.id.clone(),
            contributor: self.contributor.clone(),
            author: self.author.clone(),
            body: self.body.clone(),
            received: self.received.clone(),
            approved: self.approved.clone(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireItem {
    id: String,
    post: String,
    work: String,
    revision: String,
    target: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    body: String,
    received: String,
    approved: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    answer: Option<WireAnswer>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireFile {
    #[allow(dead_code)]
    version: u64,
    items: Vec<Value>,
}

impl PublishedPerspective {
    /// The public part of a hosted copy approved now, for `post` (its source
    /// path is `source`). Refused unless the one projection shows it now:
    /// approved at its current text revision, under an approved and a current
    /// consent that both allow publication, about this work. The name kept is
    /// the one the projection shows.
    pub fn from_hosted(
        source: &str,
        hosted: &HostedPerspective,
        post: &Post,
        config: &SiteConfig,
        approved: DateTime,
    ) -> Result<Self, String> {
        let copy = &hosted.copy;
        let response = Self::response_of(hosted, post, config).ok_or_else(|| {
            "This reflection may not be shown now: it is not approved at its current text under a consent that allows publication, or it is about another work.".to_string()
        })?;
        let item = Self {
            id: hosted.id.to_ascii_lowercase(),
            post: source.to_string(),
            work: copy.provenance.work.clone(),
            revision: copy.provenance.revision.clone(),
            target: PerspectiveTarget::try_from(copy.provenance.target.clone())
                .map_err(|error| error.message)?,
            category: copy.category,
            body: copy.body.clone(),
            received: response.received.clone(),
            approved: approved.ymd().max(response.received.clone()),
            name: response.name,
            answer: None,
        };
        item.validate()?;
        Ok(item)
    }

    /// Whether the one projection shows a hosted copy on `post` now: the
    /// check a publication and Admin's "must it come off" both make. `None`
    /// post (the work is gone) shows nothing.
    pub fn shown_now(hosted: &HostedPerspective, post: Option<&Post>, config: &SiteConfig) -> bool {
        post.is_some_and(|post| Self::response_of(hosted, post, config).is_some())
    }

    /// Whether the published file still shows the reader's name as the hosted
    /// copy shows it now. A reader may hide their name after approval (ADR
    /// 0110), and the committed file keeps the name it was published with until
    /// the reflection is published again, so Admin asks this on every inbox
    /// load: [`NameStanding::Narrowed`] means `publish` it again from the hosted
    /// copy, which is the one step that drops the name from the file. A copy
    /// the projection no longer shows is [`NameStanding::Current`] here: taking
    /// it off is the other check (`shown_now`).
    pub fn name_standing(
        &self,
        hosted: &HostedPerspective,
        post: Option<&Post>,
        config: &SiteConfig,
    ) -> NameStanding {
        let shown = post.and_then(|post| Self::response_of(hosted, post, config));
        match (shown, &self.name) {
            (Some(response), Some(name)) if response.name.as_ref() != Some(name) => {
                NameStanding::Narrowed
            }
            _ => NameStanding::Current,
        }
    }

    pub(crate) fn response_of(
        hosted: &HostedPerspective,
        post: &Post,
        config: &SiteConfig,
    ) -> Option<crate::third_perspective::ApprovedResponse> {
        Self::response_in(hosted, post, config, ParticipationMode::Open)
    }

    /// The one projection of a hosted copy in `mode`: what a publication, a
    /// feature and Admin's standing check all ask, so none can differ from
    /// another about what is shown.
    pub(crate) fn response_in(
        hosted: &HostedPerspective,
        post: &Post,
        config: &SiteConfig,
        mode: ParticipationMode,
    ) -> Option<crate::third_perspective::ApprovedResponse> {
        let copy = &hosted.copy;
        let work = PublishedWork::of_post(post, config);
        let document = PassageDocument::of_post(post, config);
        let target = TargetStatus::from(
            &document.resolve(&copy.provenance.target, Some(&copy.provenance.revision)),
        );
        let facts = ModerationFacts {
            state: hosted.state,
            revision: copy.revision,
            approved_revision: hosted.approved_revision,
            approved_consent: hosted.approved_consent,
            clarification_asked: hosted.clarification_asked,
            content_retained: true,
        };
        copy.approved_response(&facts, mode, &work, &target)
    }

    fn validate(&self) -> Result<(), String> {
        if !is_uuid(&self.id) || self.id != self.id.to_ascii_lowercase() {
            return Err("`id` must be a lowercase UUID".into());
        }
        if !is_post_source(&self.post) {
            return Err(
                "`post` must be a post's source path in the content folder, such as posts/tides.md"
                    .into(),
            );
        }
        if !is_work_path(&self.work) {
            return Err("`work` must be the site path the reader wrote about".into());
        }
        if !is_passage_revision(&self.revision) {
            return Err("`revision` must be a passage revision".into());
        }
        self.target
            .validate()
            .map_err(|error| format!("`target`: {}", error.message))?;
        if normalize_body(&self.body).as_deref() != Some(self.body.as_str()) {
            return Err("`body` must be 1 to 4000 characters of plain text, trimmed".into());
        }
        if !is_day(&self.received) || !is_day(&self.approved) {
            return Err("`received` and `approved` must be days written YYYY-MM-DD".into());
        }
        if self.approved < self.received {
            return Err("`approved` is earlier than `received`".into());
        }
        if let Some(name) = &self.name {
            let count = name.chars().count();
            if count == 0
                || count > MAX_READER_NAME_CHARS
                || normalize_passage_text(name) != *name
                || name
                    .chars()
                    .any(|c| c.is_control() || crate::research_notes::bidi_override(c))
            {
                return Err(format!(
                    "`name` must be 1 to {MAX_READER_NAME_CHARS} characters of plain text"
                ));
            }
        }
        Ok(())
    }

    fn from_value(value: &Value) -> Result<Self, String> {
        let wire: WireItem = serde_json::from_value(value.clone()).map_err(|_| {
            "has a field this version does not define, or a field of the wrong type".to_string()
        })?;
        let category = wire
            .category
            .map(|id| {
                ResponseCategory::from_id(&id)
                    .ok_or_else(|| "`category` is not a response category".to_string())
            })
            .transpose()?;
        let target = PerspectiveTarget::from_value(&wire.target)
            .map_err(|error| format!("`target`: {}", error.message))?;
        let mut item = Self {
            id: wire.id,
            post: wire.post,
            work: wire.work,
            revision: wire.revision,
            target,
            category,
            body: wire.body,
            received: wire.received,
            approved: wire.approved,
            name: wire.name,
            answer: None,
        };
        item.validate()?;
        if let Some(answer) = wire.answer {
            let answer =
                PublishedAnswer::from_wire(answer).map_err(|error| format!("`answer`: {error}"))?;
            item.check_answer(&answer)?;
            item.answer = Some(answer);
        }
        Ok(item)
    }

    fn to_wire(&self) -> WireItem {
        WireItem {
            id: self.id.clone(),
            post: self.post.clone(),
            work: self.work.clone(),
            revision: self.revision.clone(),
            target: self.target.to_value(),
            category: self.category.map(|category| category.id().to_string()),
            body: self.body.clone(),
            received: self.received.clone(),
            approved: self.approved.clone(),
            name: self.name.clone(),
            answer: self.answer.as_ref().map(PublishedAnswer::to_wire),
        }
    }

    /// An answer belongs only to a reflection about an attributed section of
    /// the very contributor who answered.
    fn check_answer(&self, answer: &PublishedAnswer) -> Result<(), String> {
        match crate::attributed_perspective::AttributedTarget::from_perspective(&self.target) {
            Ok(Some(target)) if target.contribution == answer.contributor => Ok(()),
            _ => Err("an answer must be to a reflection about its own author's section".into()),
        }
    }

    /// Its public form on `work` as published now, through the one
    /// projection, or `None` where it may not be shown.
    pub fn response(
        &self,
        mode: ParticipationMode,
        work: &PublishedWork,
        target: &TargetStatus,
    ) -> Option<ApprovedResponse> {
        project(
            PublicParts {
                work: &self.work,
                revision: &self.revision,
                target: self.target.passage_target(),
                category: self.category,
                body: &self.body,
                name: self.name.as_deref(),
                received: self.received.clone(),
            },
            mode,
            work,
            target,
        )
    }
}

/// Whether a published reflection names the reader as the hosted copy does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameStanding {
    /// The file shows no name, or the name the copy shows now.
    Current,
    /// The file shows a name the copy no longer shows (the reader hid it, or
    /// the stored name is not the file's): publish the reflection again.
    Narrowed,
}

/// Every approved Third Perspective the site publishes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ThirdPerspectivesFile {
    pub items: Vec<PublishedPerspective>,
}

impl ThirdPerspectivesFile {
    /// Read the file, refusing a newer version, an unknown field or any
    /// broken rule, naming the item and never what it holds. Nothing is
    /// repaired or dropped.
    pub fn from_json(text: &str) -> Result<Self, String> {
        if text.len() > MAX_THIRD_PERSPECTIVES_BYTES {
            return Err(format!(
                "is larger than {MAX_THIRD_PERSPECTIVES_BYTES} bytes"
            ));
        }
        let value: Value =
            serde_json::from_str(text).map_err(|_| "is not valid JSON".to_string())?;
        let version = match value.get("version").and_then(Value::as_u64) {
            Some(version @ (THIRD_PERSPECTIVES_VERSION | THIRD_PERSPECTIVES_ANSWERS_VERSION)) => {
                version
            }
            Some(version) if version > THIRD_PERSPECTIVES_ANSWERS_VERSION => {
                return Err(format!(
                    "is version {version}, newer than the version {THIRD_PERSPECTIVES_ANSWERS_VERSION} this open.blog reads"
                ))
            }
            _ => return Err("needs `version` 1 or 2".into()),
        };
        let wire: WireFile = serde_json::from_value(value)
            .map_err(|_| "needs only `version` and an `items` list".to_string())?;
        if wire.items.len() > MAX_PUBLISHED_PERSPECTIVES {
            return Err(format!(
                "has {} items; keep at most {MAX_PUBLISHED_PERSPECTIVES}",
                wire.items.len()
            ));
        }
        let mut items = Vec::with_capacity(wire.items.len());
        let mut ids = std::collections::BTreeSet::new();
        for (index, value) in wire.items.iter().enumerate() {
            let item = PublishedPerspective::from_value(value)
                .map_err(|error| format!("item {}: {error}", index + 1))?;
            if !ids.insert(item.id.clone()) {
                return Err(format!(
                    "item {}: repeats the id of an earlier item",
                    index + 1
                ));
            }
            if let Some(answer) = &item.answer {
                if version < THIRD_PERSPECTIVES_ANSWERS_VERSION {
                    return Err(format!(
                        "item {}: an `answer` needs `version` {THIRD_PERSPECTIVES_ANSWERS_VERSION}",
                        index + 1
                    ));
                }
                if !ids.insert(answer.id.clone()) {
                    return Err(format!(
                        "item {}: its answer repeats the id of an earlier item",
                        index + 1
                    ));
                }
            }
            items.push(item);
        }
        Ok(Self { items })
    }

    /// Canonical text: items sorted by post, day received and id, two-space
    /// indentation and a final line break, so a change shows as a small diff.
    pub fn to_json(&self) -> String {
        let mut items: Vec<&PublishedPerspective> = self.items.iter().collect();
        items.sort_by(|a, b| {
            (a.post.as_str(), a.received.as_str(), a.id.as_str()).cmp(&(
                b.post.as_str(),
                b.received.as_str(),
                b.id.as_str(),
            ))
        });
        let version = if items.iter().any(|item| item.answer.is_some()) {
            THIRD_PERSPECTIVES_ANSWERS_VERSION
        } else {
            THIRD_PERSPECTIVES_VERSION
        };
        let value = json!({
            "version": version,
            "items": items.iter().map(|item| item.to_wire()).collect::<Vec<_>>(),
        });
        let mut out = serde_json::to_string_pretty(&value).expect("Third Perspectives serialize");
        out.push('\n');
        out
    }

    pub fn get(&self, id: &str) -> Option<&PublishedPerspective> {
        self.items.iter().find(|item| item.id == id)
    }

    /// Add a reflection, or replace one already published. A reflection that
    /// is published again keeps the answer it already has.
    pub fn publish(&mut self, mut item: PublishedPerspective) -> Result<(), String> {
        if let Some(existing) = self
            .items
            .iter_mut()
            .find(|existing| existing.id == item.id)
        {
            if item.answer.is_none() {
                item.answer = existing.answer.take();
            }
            *existing = item;
            return Ok(());
        }
        if self.items.len() >= MAX_PUBLISHED_PERSPECTIVES {
            return Err(format!(
                "the site already publishes {MAX_PUBLISHED_PERSPECTIVES} Third Perspectives"
            ));
        }
        self.items.push(item);
        Ok(())
    }

    /// Publish an approved answer under the reflection it answers, which must
    /// already be published and be about its own author's section. The same
    /// answer is replaced in place; a different answer already on it is
    /// refused (a reflection shows one, and the author takes the first off).
    pub fn set_answer(&mut self, parent: &str, answer: PublishedAnswer) -> Result<(), String> {
        if self.items.iter().any(|item| {
            item.id != parent && item.answer.as_ref().is_some_and(|a| a.id == answer.id)
        }) || self.items.iter().any(|item| item.id == answer.id)
        {
            return Err("that answer is already published under another reflection".into());
        }
        let item = self
            .items
            .iter_mut()
            .find(|item| item.id == parent)
            .ok_or_else(|| "The reflection this answers is not published".to_string())?;
        if item
            .answer
            .as_ref()
            .is_some_and(|held| held.id != answer.id)
        {
            return Err(
                "this reflection already shows a different answer; take that one off first".into(),
            );
        }
        item.check_answer(&answer)?;
        item.answer = Some(answer);
        Ok(())
    }

    /// The reflection whose published answer has this hosted id.
    pub fn parent_of_answer(&self, answer: &str) -> Option<&PublishedPerspective> {
        self.items
            .iter()
            .find(|item| item.answer.as_ref().is_some_and(|a| a.id == answer))
    }

    /// Take an answer off its reflection; whether it was there.
    pub fn unpublish_answer(&mut self, answer: &str) -> bool {
        let mut removed = false;
        for item in &mut self.items {
            if item.answer.as_ref().is_some_and(|a| a.id == answer) {
                item.answer = None;
                removed = true;
            }
        }
        removed
    }

    /// Take a reflection off the site; whether it was there.
    pub fn unpublish(&mut self, id: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|item| item.id != id);
        self.items.len() != before
    }

    /// The reflections about one post, oldest first. Nothing orders them by
    /// popularity: there is nothing to count.
    pub fn for_post(&self, source: &str) -> Vec<&PublishedPerspective> {
        let mut items: Vec<&PublishedPerspective> = self
            .items
            .iter()
            .filter(|item| item.post == source)
            .collect();
        items.sort_by(|a, b| (&a.received, &a.id).cmp(&(&b.received, &b.id)));
        items
    }
}

/// One Third Perspective as a post's canonical page shows it: the one public
/// projection, plus the hosted id an abuse report names (a random UUID, the
/// same public handle published notes and comments carry) and the title of
/// the section it is about now. Neither joins the projection itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicPerspective {
    pub id: String,
    pub response: ApprovedResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_title: Option<String>,
    /// The author's approved answer, only where [`response_shown`] says it is
    /// shown now (ADR 0137).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<PublicAnswer>,
}

/// An author's answer as a post's canonical page shows it: always the
/// author's, named as the section is published now, never a reader's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicAnswer {
    /// The hosted id an abuse report names.
    pub id: String,
    pub author: String,
    pub body: String,
    pub received: String,
    pub approved: String,
}

impl PublicPerspective {
    /// The attributed section this reflection follows on the page, when the
    /// page gives that section an anchor and the reflection is about its
    /// current text. Only such a reflection is shown after its section.
    pub fn attributed_anchor(&self) -> Option<&str> {
        self.response
            .section
            .as_deref()
            .filter(|anchor| anchor.starts_with(crate::attributed_perspective::ANCHOR_PREFIX))
    }
}

/// The public form of a post's approved Third Perspectives, read against the
/// post as it is published now under RD12's published `mode` for the kind.
/// A record about another address (the post moved) is not shown. With
/// `answer_mode`, RD12's published mode for author responses: while it is not
/// `hidden`, an attributed section is given its `ob-by-` anchor (so a
/// reflection about its current text links to it) and an approved answer is
/// shown where [`crate::attributed_perspective::response_shown`] says so;
/// while it is, the projection is exactly what it was before answers.
pub fn project_post(
    items: &[&PublishedPerspective],
    post: &Post,
    config: &SiteConfig,
    mode: ParticipationMode,
    answer_mode: ParticipationMode,
) -> Vec<PublicPerspective> {
    let work = PublishedWork::of_post(post, config);
    let document = PassageDocument::of_post(post, config);
    let titles = crate::feedback_moderation::section_titles(post, &document);
    let attributed = crate::attributed_perspective::AttributedSections::of_post(post);
    let anchored = answer_mode != ParticipationMode::Hidden && !attributed.sections().is_empty();
    items
        .iter()
        .filter_map(|item| {
            // A reflection about one author's section is checked against that
            // author's published sections, never B5's heading sections (ADR
            // 0127): the page says whose section it is about and, when the
            // text there differs, only that it was changed or removed. The
            // section has no anchor of its own to link to yet, so none is
            // given.
            let attributed_target = crate::attributed_perspective::AttributedTarget::from_passage(
                item.target.passage_target(),
            )
            .ok()
            .flatten();
            let by_author = attributed_target
                .as_ref()
                .map(|target| attributed.resolve(target));
            let target = match &by_author {
                Some(crate::attributed_perspective::Standing::Current { nth, .. }) => {
                    TargetStatus::Current {
                        section: attributed_target
                            .as_ref()
                            .filter(|_| anchored)
                            .map(|target| {
                                crate::attributed_perspective::anchor(&target.contribution, *nth)
                            }),
                    }
                }
                Some(crate::attributed_perspective::Standing::Stale { .. }) => {
                    TargetStatus::Stale {
                        section_present: false,
                    }
                }
                None => TargetStatus::from(
                    &document.resolve(item.target.passage_target(), Some(&item.revision)),
                ),
            };
            let response = item.response(mode, &work, &target)?;
            let section_title = match &by_author {
                Some(standing) => {
                    let author = match standing {
                        crate::attributed_perspective::Standing::Current { author, .. } => {
                            Some(author)
                        }
                        crate::attributed_perspective::Standing::Stale { author, .. } => {
                            author.as_ref()
                        }
                    };
                    Some(match author {
                        Some(author) => format!("a section by {author}"),
                        None => "one author’s section".to_string(),
                    })
                }
                None => response.section.as_deref().and_then(|anchor| {
                    document
                        .sections
                        .iter()
                        .position(|section| section.anchor.as_deref() == Some(anchor))
                        .and_then(|index| titles.get(index).cloned().flatten())
                }),
            };
            let author_now = by_author.as_ref().and_then(|standing| match standing {
                crate::attributed_perspective::Standing::Current { author, .. } => Some(author),
                crate::attributed_perspective::Standing::Stale { author, .. } => author.as_ref(),
            });
            let answer = shown_answer(item, mode, answer_mode, author_now.map(String::as_str));
            Some(PublicPerspective {
                id: item.id.clone(),
                response,
                section_title,
                answer,
            })
        })
        .collect()
}

/// The answer to a published reflection, when the one rule says it is shown
/// now. The file only ever holds an approved, retained answer under an
/// approved, retained reflection, so those are the facts handed to the rule;
/// what it still decides is that the answer is public itself, that its
/// parent is public in its mode, and that the responder is the contributor
/// the parent's section is credited to. The name shown is the section's
/// author as published now, else the name it was answered under.
fn shown_answer(
    item: &PublishedPerspective,
    mode: ParticipationMode,
    answer_mode: ParticipationMode,
    author_now: Option<&str>,
) -> Option<PublicAnswer> {
    use crate::moderation::{ItemFacts, ModerationState};
    use crate::participation::ParticipationKind;
    let answer = item.answer.as_ref()?;
    let facts = |id, kind, parent| ItemFacts {
        id,
        kind,
        work: Some(&item.work),
        parent,
        state: ModerationState::Approved,
        version: 1,
        revision: 1,
        approved_revision: Some(1),
        clarification_asked: None,
        clarification_consent: false,
        content_retained: true,
        state_since: DateTime::from_unix(0),
    };
    let parent = facts(item.id.as_str(), ParticipationKind::ThirdPerspective, None);
    let response = facts(
        answer.id.as_str(),
        ParticipationKind::AuthorResponse,
        Some(item.id.as_str()),
    );
    crate::attributed_perspective::response_shown(
        &response,
        answer_mode,
        Some(&answer.contributor),
        &parent,
        mode,
        &item.target,
    )
    .then(|| PublicAnswer {
        id: answer.id.clone(),
        author: author_now.unwrap_or(&answer.author).to_string(),
        body: answer.body.clone(),
        received: answer.received.clone(),
        approved: answer.approved.clone(),
    })
}

pub(crate) fn paragraphs(value: &str) -> String {
    value
        .split("\n\n")
        .map(str::trim)
        .filter(|paragraph| !paragraph.is_empty())
        .map(|paragraph| {
            format!(
                "<p>{}</p>",
                paragraph
                    .split('\n')
                    .map(text)
                    .collect::<Vec<_>>()
                    .join("<br>\n")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The most reflections shown after one section; any more are listed in the
/// section below, so a long thread never buries the article (ADR 0138).
pub const MAX_IN_SECTION: usize = 5;

/// The reflections shown after their own attributed section, by section
/// anchor in the order each section first has a reflection (the items' own
/// order, oldest first), and the rest, which the list below shows. Each
/// reflection is shown exactly once.
#[allow(clippy::type_complexity)]
pub fn split_by_section(
    items: &[PublicPerspective],
) -> (
    Vec<(String, Vec<&PublicPerspective>)>,
    Vec<&PublicPerspective>,
) {
    let mut in_section: Vec<(String, Vec<&PublicPerspective>)> = Vec::new();
    let mut rest = Vec::new();
    for item in items {
        match item.attributed_anchor() {
            Some(anchor) => {
                let at = match in_section.iter().position(|(held, _)| held == anchor) {
                    Some(at) => at,
                    None => {
                        in_section.push((anchor.to_string(), Vec::new()));
                        in_section.len() - 1
                    }
                };
                let held = &mut in_section[at].1;
                if held.len() < MAX_IN_SECTION {
                    held.push(item);
                } else {
                    rest.push(item);
                }
            }
            None => rest.push(item),
        }
    }
    (in_section, rest)
}

/// What a reflection is about, in words and with a link to the section when
/// the page has one.
fn place_of(item: &PublicPerspective) -> String {
    place_line(&item.response, item.section_title.as_deref())
}

/// [`place_of`] for a reflection shown elsewhere than its own list (a
/// feature, ADR 0184): the same words and the same link.
pub(crate) fn place_line(response: &ApprovedResponse, section_title: Option<&str>) -> String {
    match (response.about, &response.section) {
        (About::Work, _) => "About the whole work".to_string(),
        (About::Section, Some(section)) => format!(
            "About <a href=\"#{}\">{}</a>{}",
            attr(section),
            text(section_title.unwrap_or(section)),
            if response.stale {
                ", since revised"
            } else {
                ""
            }
        ),
        // One author's section the page gives no anchor: named by its author,
        // never linked, and never said to be revised when it may as well have
        // been removed.
        (About::Section, None) if section_title.is_some() => format!(
            "About {}{}",
            text(section_title.unwrap_or_default()),
            if response.stale {
                ", since changed or removed"
            } else {
                ""
            }
        ),
        (About::Section, None) if response.stale => {
            "About a section since revised or removed".to_string()
        }
        (About::Section, None) => "About the opening".to_string(),
    }
}

/// One reflection as an `<article>` headed at level `level`, with the
/// author's answer under it. The answer is its own `<article>`, headed and
/// labelled as the author's, so who wrote what never depends on colour,
/// position or script. `in_place` leaves out the place line, which the
/// section it follows already says.
fn render_item(
    item: &PublicPerspective,
    reports: Option<&str>,
    level: u8,
    in_place: bool,
) -> String {
    let response = &item.response;
    let id = format!("ob-perspective-{}", attr(&item.id));
    let mut meta = Vec::new();
    if !in_place {
        meta.push(place_of(item));
    }
    if let Some(category) = response.category {
        meta.push(format!("Prompt: {}", text(category.label())));
    }
    meta.push(format!(
        "received <time datetime=\"{0}\">{0}</time>",
        attr(&response.received)
    ));
    let mut html = format!(
        "<article class=\"ob-perspective\" id=\"{id}\" aria-labelledby=\"{id}-title\">\n<h{level} id=\"{id}-title\">{}</h{level}>\n<p class=\"ob-perspective-meta\">{}</p>\n",
        text(&response.heading()),
        meta.join(" · ")
    );
    if response.earlier_revision {
        html.push_str("<p class=\"ob-perspective-earlier\">Written about an earlier version of this work.</p>\n");
    }
    html.push_str(&paragraphs(&response.body));
    html.push('\n');
    if let Some(endpoint) = reports {
        html.push_str(&format!(
            "<ob-abuse-report endpoint=\"{}\" source=\"feedback\" item=\"{}\" subject=\"this reflection\"><p class=\"ob-abuse-report-static\">To report this reflection as abusive, write to the author.</p></ob-abuse-report>\n",
            attr(endpoint),
            attr(&item.id)
        ));
    }
    if let Some(answer) = &item.answer {
        let answer_id = format!("ob-answer-{}", attr(&answer.id));
        let next = level + 1;
        html.push_str(&format!(
            "<article class=\"ob-author-response\" id=\"{answer_id}\" aria-labelledby=\"{answer_id}-title\">\n<h{next} id=\"{answer_id}-title\">Author’s response from {}</h{next}>\n<p class=\"ob-perspective-meta\">Written by the author of the section this answers · approved <time datetime=\"{2}\">{2}</time></p>\n{}\n",
            text(&answer.author),
            paragraphs(&answer.body),
            attr(&answer.approved)
        ));
        if let Some(endpoint) = reports {
            html.push_str(&format!(
                "<ob-abuse-report endpoint=\"{}\" source=\"feedback\" item=\"{}\" subject=\"this response\"><p class=\"ob-abuse-report-static\">To report this response as abusive, write to the author.</p></ob-abuse-report>\n",
                attr(endpoint),
                attr(&answer.id)
            ));
        }
        html.push_str("</article>\n");
    }
    html.push_str("</article>");
    html
}

/// What the conversation's landmark names, so each one on a page has its own
/// accessible name: "MINA’s section 2" (the author's name and the place among
/// that author's sections, counted from one), escaped.
fn conversation_name(anchor_id: &str, items: &[&PublicPerspective]) -> String {
    let author = items.iter().find_map(|item| {
        item.section_title
            .as_deref()
            .and_then(|title| title.strip_prefix("a section by "))
    });
    let place = anchor_id
        .rsplit('-')
        .next()
        .and_then(|nth| nth.parse::<usize>().ok())
        .map(|nth| nth + 1);
    match (author, place) {
        (Some(author), Some(place)) => format!("{}’s section {place}", text(author)),
        (Some(author), None) => format!("{}’s section", text(author)),
        _ => "this section".to_string(),
    }
}

/// The conversation after one attributed section: a labelled `<aside>` inside
/// the section's own turn, after the author's words, listing the reflections
/// about it with the author's answer under each. Static HTML that needs no
/// script and no style; `id` is the section's anchor.
pub fn render_conversation(
    anchor_id: &str,
    items: &[&PublicPerspective],
    reports: Option<&str>,
) -> String {
    if items.is_empty() {
        return String::new();
    }
    let id = format!("ob-conversation-{}", attr(anchor_id));
    let answers = items.iter().filter(|item| item.answer.is_some()).count();
    let name = conversation_name(anchor_id, items);
    let mut html = format!(
        "<ob-conversation>\n<aside class=\"ob-conversation\" id=\"{id}\" aria-labelledby=\"{id}-title\">\n<h3 id=\"{id}-title\">Reader reflections on {name}</h3>\n<p class=\"ob-conversation-note\">{} reader {} on this section, each shown as a reader’s{}. Nothing here changes the author’s words above.</p>\n<ol class=\"ob-conversation-list\">\n",
        items.len(),
        if items.len() == 1 {
            "reflection"
        } else {
            "reflections"
        },
        if answers == 0 {
            String::new()
        } else {
            format!(
                ", with {} {} from the author of this section, labelled as the author’s",
                answers,
                if answers == 1 { "response" } else { "responses" }
            )
        }
    );
    for item in items {
        html.push_str("<li>");
        html.push_str(&render_item(item, reports, 4, true));
        html.push_str("</li>\n");
    }
    html.push_str("</ol>\n</aside>\n</ob-conversation>\n");
    html
}

/// The section of a post's canonical page that lists its approved Third
/// Perspectives: static, semantic HTML that needs no script, apart from the
/// authors' text and after it. Each is headed as a reader's, never an
/// author's or the group's; every value is escaped. With `reports`, the
/// hosted endpoint while abuse reports are open (ADR 0107), each carries a
/// progressive report form whose static text works without it. A reflection
/// the page already shows after its own section is not listed again.
pub fn render_section(items: &[PublicPerspective], reports: Option<&str>) -> String {
    let (in_section, rest) = split_by_section(items);
    if rest.is_empty() && in_section.is_empty() {
        return String::new();
    }
    let anchor = THIRD_PERSPECTIVES_ANCHOR;
    let mut html = format!(
        "<section id=\"{anchor}\" class=\"ob-third-perspectives\" aria-labelledby=\"{anchor}-title\">\n<h2 id=\"{anchor}-title\">Third Perspectives</h2>\n<p>Reflections readers offered on this work, each shown as a reader’s, never as one of the authors’. Each was approved by a moderator and is shown only as its reader agreed. Publishing one does not mean the authors agree with it, and nothing here is ranked.</p>\n"
    );
    // Reflections shown after their own section are pointed to, never copied,
    // so this section stays where a link to the reflections lands.
    if !in_section.is_empty() {
        html.push_str("<p>Reflections about one author’s section are shown after that section:</p>\n<ul class=\"ob-third-perspectives-where\">\n");
        for (section, held) in &in_section {
            html.push_str(&format!(
                "<li><a href=\"#ob-conversation-{}\">{} {} {}</a></li>\n",
                attr(section),
                held.len(),
                if held.len() == 1 {
                    "reflection about"
                } else {
                    "reflections about"
                },
                text(
                    held[0]
                        .section_title
                        .as_deref()
                        .unwrap_or("an author’s section")
                )
            ));
        }
        html.push_str("</ul>\n");
    }
    if !rest.is_empty() {
        html.push_str("<ol class=\"ob-third-perspectives-list\">\n");
        for item in rest {
            html.push_str("<li>");
            html.push_str(&render_item(item, reports, 3, false));
            html.push_str("</li>\n");
        }
        html.push_str("</ol>\n");
    }
    html.push_str("</section>\n");
    html
}
