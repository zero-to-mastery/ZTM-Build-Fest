//! Stable targets at one author's section of a shared reflection, and who may
//! answer a Third Perspective about it (ADRs 0126 to 0130).
//!
//! A shared reflection publishes each author's text under that author's name
//! (ADR 0030, 0033). A reader's Third Perspective (RD10) may be about one of
//! those sections. This module answers three questions without a new storage
//! format and without a parallel policy:
//!
//! - *What does the reader point at?* An [`AttributedTarget`]: the author's
//!   public contributor id (the registry key the committed credits sidecar
//!   names), the section's place among that author's sections, and the digest
//!   of the text the reader read. It is written as an ordinary RD10
//!   section target (`ob-by-{contribution}-{nth}` plus a digest under its own label), so every
//!   stored copy and every reader of one already understands it. Nothing in it
//!   is visual: no side, lane, column or position in the layout.
//! - *Is it still the same section?* [`AttributedSections::resolve`] looks the
//!   target up in the sections as published now, by the author and the text,
//!   and reports [`Standing::Current`] (even if the section moved) or a
//!   [`Standing::Stale`] with the honest reason. It never points at another
//!   author's or another passage's text.
//! - *Who may answer as that author?* [`admit_response`]: only the participant
//!   whose binding names that public contributor id, as a contributor of the
//!   publication, signed in as the account bound to them. A contributor
//!   registry key alone, a coordinator, a site owner, an editor or the
//!   moderation token never can. The answer is then admitted by RD12's one
//!   policy as a pending `author-response`, and only this function can obtain
//!   the sealed [`AuthorGrant`] the policy demands for an attributed parent.
//!
//! Which author wrote a section is read from committed, public content only:
//! the post's arranged body and its credits sidecar (ADR 0127). The private
//! shared-publication record decides one thing, who may answer, and is never
//! needed to resolve, render or build a target. Everything here is pure.

use crate::arrangement::Arrangement;
use crate::collaboration::{
    valid_contributor_id, AuthorizationAction, AuthorizationTarget, SharedPublication,
};
use crate::date::DateTime;
use crate::invitation::Identities;
use crate::moderation::{
    is_public, Admission, AuthorGrant, ItemFacts, ModerationPolicy, PolicyError, Principal,
    SharedWorks, Submission,
};
use crate::participation::{ParticipationKind, ParticipationMode};
use crate::passage_target::{attributed_section_digest, normalize_passage_text, PassageSelector};
use crate::reflection::MAX_TOTAL_TURNS;
use crate::third_perspective::{PerspectiveTarget, TargetStatus};

/// The reserved start of an attributed section's anchor.
pub const ANCHOR_PREFIX: &str = "ob-by-";

/// The most attributed sections one work holds (a shared reflection's turn limit).
pub const MAX_SECTIONS: usize = MAX_TOTAL_TURNS;

/// The longest excerpt an [`AttributedSection`] carries, in characters.
pub const EXCERPT_CHARS: usize = 60;

/// The first words of `text` (already normalized), for a list.
fn excerpt_of(text: &str) -> String {
    if text.chars().count() <= EXCERPT_CHARS {
        return text.to_string();
    }
    let cut: String = text.chars().take(EXCERPT_CHARS).collect();
    let words = match cut.rfind(' ') {
        Some(space) if space > 0 && text.chars().nth(EXCERPT_CHARS) != Some(' ') => &cut[..space],
        _ => cut.as_str(),
    };
    format!("{}…", words.trim_end())
}

/// Why a target or an anchor is refused. It names the rule, never the value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetError {
    /// The anchor starts with the reserved prefix but is not written exactly
    /// as [`anchor`] writes one.
    Malformed,
    /// An attributed target must carry the digest of the text read, because
    /// the author and place alone could point at different words later.
    DigestRequired,
    /// A quotation or the whole work is not an attributed section.
    NotASection,
}

impl TargetError {
    pub fn code(self) -> &'static str {
        match self {
            TargetError::Malformed => "malformed",
            TargetError::DigestRequired => "digest-required",
            TargetError::NotASection => "not-a-section",
        }
    }
}

impl std::fmt::Display for TargetError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            TargetError::Malformed => "not a valid attributed section anchor",
            TargetError::DigestRequired => {
                "an attributed section target needs the digest of its text"
            }
            TargetError::NotASection => "not a section target",
        })
    }
}

impl std::error::Error for TargetError {}

/// The anchor of the `nth` section (zero-based) written by `contribution`.
pub fn anchor(contribution: &str, nth: usize) -> String {
    format!("{ANCHOR_PREFIX}{contribution}-{nth}")
}

/// Split an anchor written by [`anchor`]. `None` when it does not start with
/// the reserved prefix (an ordinary heading id); an error when it does but is
/// not exactly canonical, so a look-alike is never half-read.
fn split_anchor(text: &str) -> Result<Option<(String, usize)>, TargetError> {
    let Some(rest) = text.strip_prefix(ANCHOR_PREFIX) else {
        return Ok(None);
    };
    let (contribution, nth) = rest.rsplit_once('-').ok_or(TargetError::Malformed)?;
    let canonical = !nth.is_empty()
        && nth.len() <= 3
        && nth.bytes().all(|byte| byte.is_ascii_digit())
        && (nth == "0" || !nth.starts_with('0'));
    // The contributor id is a registry key: lowercase only, so one section
    // has one spelling and no look-alike casing is read as the same author.
    if !canonical || !valid_contributor_id(contribution) {
        return Err(TargetError::Malformed);
    }
    let nth: usize = nth.parse().map_err(|_| TargetError::Malformed)?;
    if nth >= MAX_SECTIONS {
        return Err(TargetError::Malformed);
    }
    Ok(Some((contribution.to_string(), nth)))
}

/// One author's section as the work publishes it now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttributedSection {
    /// The author's public contributor id, the registry key the post's
    /// committed credits sidecar names. Never a participant id, a name or an
    /// account, so it says nothing about how many people the work had.
    pub contribution: String,
    /// Zero-based place among that author's sections in reading order. A
    /// hint only: the text, not the place, decides what a target means.
    pub nth: usize,
    /// The name the section is published under.
    pub author: String,
    /// The first words of the section's text, to tell it apart in a list: at
    /// most [`EXCERPT_CHARS`] characters of its normalized Markdown, cut at a
    /// word, with an ellipsis when it is longer. Plain text; never part of a
    /// target.
    pub excerpt: String,
    /// The digest of the section's normalized Markdown text, under its own
    /// label ([`attributed_section_digest`]), not B5's heading-section label.
    pub digest: String,
}

impl AttributedSection {
    /// The anchor a page gives this section.
    pub fn anchor(&self) -> String {
        anchor(&self.contribution, self.nth)
    }

    /// The target a reader's Third Perspective about this section stores.
    pub fn target(&self) -> AttributedTarget {
        AttributedTarget {
            contribution: self.contribution.clone(),
            nth: self.nth,
            digest: self.digest.clone(),
        }
    }
}

/// What a reader pointed at: an author's section, bound to the text read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttributedTarget {
    pub contribution: String,
    pub nth: usize,
    pub digest: String,
}

impl AttributedTarget {
    /// Read an RD10 target. `Ok(None)` for the whole work and for any section
    /// whose anchor is an ordinary heading id: those keep RD10's meaning.
    pub fn from_perspective(target: &PerspectiveTarget) -> Result<Option<Self>, TargetError> {
        Self::from_passage(target.passage_target())
    }

    /// The same reading of a checked B5 passage target.
    pub fn from_passage(
        passage: &crate::passage_target::PassageTarget,
    ) -> Result<Option<Self>, TargetError> {
        let Some(section) = passage.section.as_deref() else {
            return Ok(None);
        };
        let Some((contribution, nth)) = split_anchor(section)? else {
            return Ok(None);
        };
        let PassageSelector::Section { digest } = &passage.selector else {
            return Err(TargetError::NotASection);
        };
        let digest = digest.clone().ok_or(TargetError::DigestRequired)?;
        Ok(Some(Self {
            contribution,
            nth,
            digest,
        }))
    }

    /// The same target as an ordinary RD10 section target, which is how it is
    /// stored, submitted and projected.
    pub fn perspective_target(&self) -> PerspectiveTarget {
        PerspectiveTarget::section(
            Some(anchor(&self.contribution, self.nth)),
            Some(self.digest.clone()),
        )
    }
}

/// Why an attributed target no longer points at what the reader read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StaleReason {
    /// The author still publishes sections, but none has the text the reader
    /// read. Whether it was edited or removed cannot be told from the
    /// published work alone, so it is never claimed to be either.
    SectionChangedOrRemoved,
    /// No section by that author is published now.
    AuthorAbsent,
    /// Two of the author's sections hold the same text and neither is at the
    /// place the reader saw, so which one was meant cannot be told.
    Ambiguous,
}

impl StaleReason {
    pub fn id(self) -> &'static str {
        match self {
            StaleReason::SectionChangedOrRemoved => "section-changed-or-removed",
            StaleReason::AuthorAbsent => "author-absent",
            StaleReason::Ambiguous => "ambiguous",
        }
    }
}

/// Where an attributed target stands in the work as published now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Standing {
    /// The author's section with the text the reader read is there.
    Current {
        /// Where it is now.
        nth: usize,
        /// Whether it is somewhere else than the reader saw it.
        moved: bool,
        /// The name it is published under.
        author: String,
    },
    /// The text the reader read is not there. The reader's words keep the
    /// context they were written in; nothing is pointed at instead.
    Stale {
        reason: StaleReason,
        /// The name the author's remaining sections are published under, when
        /// there are any, for honest context ("Mina's section has changed").
        author: Option<String>,
    },
}

impl Standing {
    pub fn is_current(&self) -> bool {
        matches!(self, Standing::Current { .. })
    }

    /// The same standing in RD10's terms, so the one projection and the one
    /// page treatment of a Third Perspective's section apply unchanged.
    pub fn target_status(&self, contribution: &str) -> TargetStatus {
        match self {
            Standing::Current { nth, .. } => TargetStatus::Current {
                section: Some(anchor(contribution, *nth)),
            },
            Standing::Stale { author, .. } => TargetStatus::Stale {
                section_present: author.is_some(),
            },
        }
    }
}

/// The contributor keys a body's `ob-turn-by-` classes state, in document
/// order. Only compose writes them (ADR 0136), so a manual edit that changes
/// this sequence is a forged or broken binding.
pub fn turn_binding_sequence(body: &str) -> Vec<String> {
    let prefix = crate::reflection::CONTRIBUTOR_CLASS_PREFIX;
    let mut keys = Vec::new();
    let mut rest = body;
    while let Some(at) = rest.find(prefix) {
        let after = &rest[at + prefix.len()..];
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .unwrap_or(after.len());
        keys.push(after[..end].to_string());
        rest = &after[end..];
    }
    keys
}

/// Every attributed section of one work as it is published now.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AttributedSections {
    sections: Vec<AttributedSection>,
    unattributed: usize,
}

impl AttributedSections {
    /// The sections as the work's committed content publishes them: the
    /// Markdown body read back as an arranged reflection (ADR 0033), its
    /// credits sidecar, which lists each contributor once, in the order they
    /// first appear (ADR 0030), and the committed contributor registry the
    /// credits name. The k-th distinct author name in the body is the k-th
    /// credit, and only when that credit's public registry name is the name
    /// the body prints (ADR 0136): credits reordered in the post editor, a
    /// changed registry name or a hand-edited body therefore attribute nothing
    /// instead of putting one person's words under another's id. Nothing
    /// private is read and no participant record is consulted, so a static or
    /// CI build, a later invitation of someone with the same name, or a
    /// look-alike name changes nothing. A body that is not an arranged
    /// reflection has no sections; credits that do not pair one to one with
    /// the body's distinct names (two authors sharing a name, a missing or
    /// unreadable sidecar, an id missing from the registry) attribute nothing
    /// and count every turn as unattributed, so it fails closed instead of
    /// guessing an author.
    pub fn from_published(
        body: &str,
        credits: Option<&str>,
        registry: &std::collections::BTreeMap<String, crate::contributor::Contributor>,
    ) -> Self {
        let pairs = credits
            .and_then(crate::contributor::credited_ids)
            .and_then(|ids| {
                ids.into_iter()
                    .map(|id| {
                        let name = registry.get(&id)?.name.clone();
                        Some((id, name))
                    })
                    .collect::<Option<Vec<_>>>()
            });
        Self::from_published_credits(body, pairs)
    }

    /// [`AttributedSections::from_published`] from the credited contributor
    /// ids and their registry names a loaded post already holds, in the
    /// sidecar's order. `None` is no readable sidecar.
    pub fn from_published_credits(body: &str, credits: Option<Vec<(String, String)>>) -> Self {
        let Some(arrangement) = Arrangement::parse(body) else {
            return Self::default();
        };
        let turns: Vec<_> = arrangement.turns().collect();
        let mut names: Vec<&str> = Vec::new();
        for turn in &turns {
            if !names.contains(&turn.author.as_str()) {
                names.push(&turn.author);
            }
        }
        // A body that states each turn's contributor (ADR 0136) is paired by
        // that; an older body that states none, by the registry's public name.
        // A body that states some turns' and not others', or states two keys
        // for one name, is not trusted at all.
        let bound = turns
            .iter()
            .filter(|turn| turn.contributor.is_some())
            .count();
        let name_keys: Option<Vec<&str>> = if bound == 0 {
            None
        } else if bound == turns.len() {
            let mut keys: Vec<Option<&str>> = vec![None; names.len()];
            let mut consistent = true;
            for turn in &turns {
                let index = names
                    .iter()
                    .position(|name| *name == turn.author)
                    .unwrap_or(0);
                let key = turn.contributor.as_deref();
                match keys[index] {
                    None => keys[index] = key,
                    Some(known) => consistent &= Some(known) == key,
                }
            }
            Some(if consistent {
                keys.into_iter().flatten().collect()
            } else {
                Vec::new()
            })
        } else {
            Some(Vec::new())
        };
        let paired = credits.filter(|credits| {
            credits.len() == names.len()
                && credits.iter().all(|(id, _)| valid_contributor_id(id))
                && credits
                    .iter()
                    .enumerate()
                    .all(|(index, (id, _))| !credits[..index].iter().any(|(other, _)| other == id))
                && match &name_keys {
                    None => credits
                        .iter()
                        .zip(&names)
                        .all(|((_, registry_name), name)| registry_name.trim() == name.trim()),
                    Some(keys) => {
                        keys.len() == credits.len()
                            && keys.iter().zip(credits).all(|(key, (id, _))| key == id)
                    }
                }
        });
        let Some(ids) = paired else {
            return Self {
                sections: Vec::new(),
                unattributed: turns.len(),
            };
        };
        let mut sections: Vec<AttributedSection> = Vec::new();
        let mut unattributed = 0;
        for turn in &turns {
            let index = names
                .iter()
                .position(|name| *name == turn.author)
                .unwrap_or_default();
            if sections.len() >= MAX_SECTIONS {
                unattributed += 1;
                continue;
            }
            let contribution = &ids[index].0;
            let nth = sections
                .iter()
                .filter(|section| &section.contribution == contribution)
                .count();
            let normalized = normalize_passage_text(&turn.body);
            sections.push(AttributedSection {
                contribution: contribution.clone(),
                nth,
                author: turn.author.clone(),
                excerpt: excerpt_of(&normalized),
                digest: attributed_section_digest(&normalized),
            });
        }
        Self {
            sections,
            unattributed,
        }
    }

    /// The sections in reading order.
    pub fn sections(&self) -> &[AttributedSection] {
        &self.sections
    }

    /// How many published turns cannot be attributed to one credited author,
    /// so cannot be targeted.
    pub fn unattributed(&self) -> usize {
        self.unattributed
    }

    /// The section a target means now, if it is still there. By the author
    /// and the text read: the place only breaks a tie between identical
    /// sections. Never another author's section, and never a section whose
    /// text differs.
    pub fn resolve(&self, target: &AttributedTarget) -> Standing {
        let own: Vec<&AttributedSection> = self
            .sections
            .iter()
            .filter(|section| section.contribution == target.contribution)
            .collect();
        let Some(first) = own.first() else {
            return Standing::Stale {
                reason: StaleReason::AuthorAbsent,
                author: None,
            };
        };
        let same: Vec<&AttributedSection> = own
            .iter()
            .copied()
            .filter(|section| section.digest == target.digest)
            .collect();
        let found = match same.as_slice() {
            [one] => Some(*one),
            [] => None,
            many => match many.iter().find(|section| section.nth == target.nth) {
                Some(exact) => Some(*exact),
                None => {
                    return Standing::Stale {
                        reason: StaleReason::Ambiguous,
                        author: Some(first.author.clone()),
                    }
                }
            },
        };
        match found {
            Some(section) => Standing::Current {
                nth: section.nth,
                moved: section.nth != target.nth,
                author: section.author.clone(),
            },
            None => Standing::Stale {
                reason: StaleReason::SectionChangedOrRemoved,
                author: Some(first.author.clone()),
            },
        }
    }
}

/// Why an author response was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResponseError {
    /// The target is not an attributed section: the generic author response
    /// of RD12 applies instead, and this module grants nothing.
    NotAttributed,
    /// The requester is not the contributor who wrote that section. The same
    /// answer for a registry key without a binding, an editor, a coordinator,
    /// a site owner, the moderation token, a binding to another participant,
    /// a binding that no longer resolves and a publication that is not the
    /// one that publishes this work.
    Denied,
    /// The requester is that author, but no section by them is published now,
    /// so there is nothing the answer is an answer about.
    AuthorUnconfirmed,
    /// The parent is not a public Third Perspective of this work.
    Unavailable,
    /// RD12's policy refused the response.
    Policy(PolicyError),
}

impl ResponseError {
    pub fn code(self) -> &'static str {
        match self {
            ResponseError::NotAttributed => "not-attributed",
            ResponseError::Denied => "denied",
            ResponseError::AuthorUnconfirmed => "author-unconfirmed",
            ResponseError::Unavailable => "unavailable",
            ResponseError::Policy(error) => error.code(),
        }
    }
}

impl std::fmt::Display for ResponseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "author response refused: {}", self.code())
    }
}

impl std::error::Error for ResponseError {}

/// Who answered, as the store keeps it (ADR 0130). The binding is private:
/// it never leaves the record. The handle, the published name and the
/// standing are what a public page may say.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Responder {
    /// The participant who wrote the section. Private; never public.
    pub participant: String,
    /// The public contributor id the section is credited to. It must equal
    /// the parent's attributed contributor for the answer to be shown.
    pub contributor: String,
    /// The name the section, and so the answer, is published under.
    pub author: String,
    /// Where the section stood when the answer was written.
    pub standing: Standing,
}

/// Whether `admin_user` is signed in as the account bound, as a contributor,
/// to `participant` of this publication, with the account, registry key and
/// participant all still current. The one author check, used to create an
/// answer and to withdraw it; it grants no moderation. A registry key alone,
/// any other role and any other participant are all [`ResponseError::Denied`].
pub fn authorize_author(
    record: &SharedPublication,
    identities: &Identities<'_>,
    admin_user: &str,
    participant: &str,
) -> Result<(), ResponseError> {
    let binding = record
        .authorize(
            admin_user,
            identities,
            AuthorizationAction::RespondAsAuthor,
            AuthorizationTarget::Participant(participant),
        )
        .map_err(|_| ResponseError::Denied)?;
    // The action's grant already requires the participant to be the
    // requester's own; checked again so a changed table cannot widen it.
    if binding.participant_id == participant {
        Ok(())
    } else {
        Err(ResponseError::Denied)
    }
}

/// An author's answer to a Third Perspective about their own section.
#[derive(Clone, Copy)]
pub struct ResponseRequest<'a> {
    /// The new item's id, chosen by the receiver.
    pub id: &'a str,
    pub record: &'a SharedPublication,
    pub identities: &'a Identities<'a>,
    /// The signed-in Admin account, from the session. The actor is derived
    /// from it here, never supplied.
    pub admin_user: &'a str,
    /// The loaded works of every shared publication.
    pub works: &'a SharedWorks<'a>,
    /// The published work's path.
    pub work: &'a str,
    /// `author-response`'s mode on that work.
    pub mode: ParticipationMode,
    /// The stored Third Perspective being answered.
    pub parent: &'a ItemFacts<'a>,
    /// `third-perspective`'s mode on that work.
    pub parent_mode: ParticipationMode,
    /// The target the Third Perspective stores.
    pub parent_target: &'a PerspectiveTarget,
    /// The work's published Markdown body, as committed.
    pub body: &'a str,
    /// The work's credits sidecar, as committed.
    pub credits: Option<&'a str>,
    /// The committed contributor registry the credits name (`openblog.json`).
    pub registry: &'a std::collections::BTreeMap<String, crate::contributor::Contributor>,
    pub at: DateTime,
}

/// A created answer: always pending, like every item, and who wrote it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttributedResponse {
    pub admission: Admission,
    pub responder: Responder,
}

/// Admit an author's answer to a Third Perspective about their own section.
///
/// Checks run in a fixed order so a requester who is not that author learns
/// nothing: the target's kind, that this publication publishes this work, the
/// author grant, the parent, the author's standing, then RD12's
/// [`ModerationPolicy::admit`], handed the sealed [`AuthorGrant`] only here.
/// The sections are built here from the published body and credits, never
/// taken from the caller. A section that has since changed still lets its
/// author answer (the page says so); an author with no published section
/// cannot, because there is nothing left to answer about.
pub fn admit_response(
    policy: &ModerationPolicy,
    request: &ResponseRequest<'_>,
) -> Result<AttributedResponse, ResponseError> {
    let target = AttributedTarget::from_perspective(request.parent_target)
        .map_err(|_| ResponseError::NotAttributed)?
        .ok_or(ResponseError::NotAttributed)?;
    // The record must be the publication whose post is this work, so one
    // work's grant is never spent on another's.
    if !request
        .works
        .works(&request.record.publication_id)
        .contains(&request.work)
    {
        return Err(ResponseError::Denied);
    }
    // The participant is found only by the public contributor id the section
    // is credited to; no name is ever compared.
    let binding = request
        .record
        .authorization
        .bindings
        .iter()
        .find(|binding| binding.contributor_id == target.contribution)
        .ok_or(ResponseError::Denied)?;
    authorize_author(
        request.record,
        request.identities,
        request.admin_user,
        &binding.participant_id,
    )?;
    let actor = request.works.actor(
        Principal::AdminSession {
            admin_user: request.admin_user,
        },
        Some(request.work),
        request.identities,
    );
    if actor.admin_user() != Some(request.admin_user) {
        return Err(ResponseError::Denied);
    }
    if request.parent.kind != ParticipationKind::ThirdPerspective
        || request.parent.work != Some(request.work)
        || !is_public(request.parent, request.parent_mode)
    {
        return Err(ResponseError::Unavailable);
    }
    let sections =
        AttributedSections::from_published(request.body, request.credits, request.registry);
    let standing = sections.resolve(&target);
    let author = match &standing {
        Standing::Current { author, .. } => Some(author),
        Standing::Stale { author, .. } => author.as_ref(),
    };
    let Some(author) = author else {
        return Err(ResponseError::AuthorUnconfirmed);
    };
    let admission = policy
        .admit(&Submission {
            id: request.id,
            actor,
            kind: ParticipationKind::AuthorResponse,
            work: Some(request.work),
            mode: request.mode,
            parent: Some((request.parent, request.parent_mode)),
            parent_target: Some(request.parent_target),
            author_grant: Some(AuthorGrant::issue()),
            clarification_consent: false,
            at: request.at,
        })
        .map_err(ResponseError::Policy)?;
    Ok(AttributedResponse {
        admission,
        responder: Responder {
            participant: binding.participant_id.clone(),
            contributor: target.contribution.clone(),
            author: author.clone(),
            standing,
        },
    })
}

/// Whether a stored response is shown to readers: it is public itself, it
/// answers a Third Perspective that is public now, and, when that perspective
/// is about an attributed section, the response's stored responder is that
/// section's own contributor. A response stored without a responder, or with
/// another's, is never shown under an attributed parent, so a plain author
/// response a coordinator or site owner managed to store cannot speak as the
/// author. A response never outlives its parent's publication, and removing
/// the parent hides it without deleting it.
pub fn response_shown(
    response: &ItemFacts<'_>,
    response_mode: ParticipationMode,
    responder_contributor: Option<&str>,
    parent: &ItemFacts<'_>,
    parent_mode: ParticipationMode,
    parent_target: &PerspectiveTarget,
) -> bool {
    let bound = match AttributedTarget::from_perspective(parent_target) {
        Ok(None) => true,
        Ok(Some(target)) => responder_contributor == Some(target.contribution.as_str()),
        Err(_) => false,
    };
    bound
        && response.kind == ParticipationKind::AuthorResponse
        && response.parent == Some(parent.id)
        && response.work == parent.work
        && is_public(response, response_mode)
        && is_public(parent, parent_mode)
}

/// Whether `decider_admin_user` may take `action` on an author response that
/// `responder_admin_user` wrote. RD12's table already keeps a contributing
/// author from moderating; this closes the one gap left, a coordinator or
/// site owner who is also the section's contributor and so may write the
/// answer: nobody approves their own answer. Removing or rejecting one's own
/// answer stays allowed, because taking words down is never the risk. The
/// submitter is the audit event's account, which the policy's item facts do
/// not carry, so the route that stores responses calls this beside
/// [`ModerationPolicy::decide`].
pub fn may_decide_response(
    responder_admin_user: Option<&str>,
    decider_admin_user: &str,
    action: crate::moderation::ModerationAction,
) -> Result<(), PolicyError> {
    if action == crate::moderation::ModerationAction::Approve
        && responder_admin_user == Some(decider_admin_user)
    {
        return Err(PolicyError::Denied);
    }
    Ok(())
}

impl AttributedSections {
    /// The attributed sections of a loaded post: its authored Markdown body
    /// and, only when an explicit credits sidecar was read, the credited
    /// contributor ids in its order. A legacy post, which synthesizes one
    /// site author from the configuration, has no sidecar and so no sections.
    pub fn of_post(post: &crate::model::Post) -> Self {
        let credits = (post.credit_provenance
            == crate::contributor::CreditProvenance::ExplicitSidecar)
            .then(|| {
                post.credits
                    .iter()
                    .map(|credit| {
                        (
                            credit.contributor_id.clone(),
                            credit.contributor.name.clone(),
                        )
                    })
                    .collect()
            });
        Self::from_published_credits(&post.authored_markdown, credits)
    }
}
