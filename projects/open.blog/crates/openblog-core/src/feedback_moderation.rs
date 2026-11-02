//! Moderating passage feedback (ADR 0083).
//!
//! A reader's submission starts pending. A moderator approves it, or rejects
//! it with a reason; an approved item can later be removed with a reason.
//! Every change names the state it expects and the item's version, so two
//! moderators can never both act on the same item, and the hosted function
//! records an audit event for each one (`openblog_feedback_events`).
//!
//! The states, actions, reasons and refusal codes are the participation and
//! moderation policy's ([`crate::moderation`], ADR 0102), re-exported here:
//! there is one set. This module uses the subset B5 needs: it reads every
//! state, so an item another tool moved is shown rather than misread, but
//! offers only approve, reject and remove. The unified moderation inbox
//! (#225) can replace this subset without a data migration.
//!
//! A moderator always sees where the reader's passage is now
//! ([`PassageReview`]): current, re-anchored after the page changed, or
//! stale, so nobody approves feedback about words that silently moved or are
//! gone. Approval never edits the post: accepting a suggestion is a separate
//! author edit, and a revision note is the author's own words (ADR 0075).

use serde_json::{json, Value};

use crate::model::{Post, Site};
use crate::participation::ParticipationKind;
use crate::passage_target::{PassageDocument, PassageSelector, Resolution, StaleReason};
use crate::scholarly_feedback::ScholarlyFeedback;

pub use crate::moderation::{ModerationAction, ModerationState, PolicyError, ReasonCode};

/// The actions Admin's B5 view offers, a subset of the policy's (ADR 0083):
/// approve, reject and remove.
pub const FEEDBACK_ACTIONS: [ModerationAction; 3] = [
    ModerationAction::Approve,
    ModerationAction::Reject,
    ModerationAction::Remove,
];

/// The states `action` may start from, by the one state machine.
pub fn from_states(action: ModerationAction) -> Vec<ModerationState> {
    ModerationState::ALL
        .into_iter()
        .filter(|state| crate::moderation::next_state(action, *state).is_some())
        .collect()
}

/// The reasons `action` takes on passage feedback; empty means none. Every
/// passage feedback kind has the same list, so `question` stands for all.
pub fn reasons(action: ModerationAction) -> &'static [ReasonCode] {
    crate::moderation::allowed_reasons(action, ParticipationKind::Question)
}

/// The B5 actions open to an item in `state`, in a fixed order.
pub fn available(state: ModerationState) -> Vec<ModerationAction> {
    FEEDBACK_ACTIONS
        .into_iter()
        .filter(|action| crate::moderation::next_state(*action, state).is_some())
        .collect()
}

/// A checked change: from the state the moderator saw to the next one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModerationChange {
    pub action: ModerationAction,
    pub from: ModerationState,
    pub to: ModerationState,
    pub reason: Option<ReasonCode>,
}

/// Check one requested change against the item's current state, with the
/// policy's codes (ADR 0102): an action outside B5's subset, or one that
/// does not apply from this state, is `notAllowed`; a reason the action does
/// not take, including one no version defines, is `reasonNotAllowed`.
pub fn plan(
    current: ModerationState,
    action: &str,
    reason: Option<&str>,
) -> Result<ModerationChange, PolicyError> {
    let action = ModerationAction::from_id(action)
        .filter(|action| FEEDBACK_ACTIONS.contains(action))
        .ok_or(PolicyError::NotAllowed)?;
    let to = crate::moderation::next_state(action, current).ok_or(PolicyError::NotAllowed)?;
    let allowed = reasons(action);
    let reason = match reason.filter(|reason| !reason.is_empty()) {
        None if allowed.is_empty() => None,
        None => return Err(PolicyError::ReasonRequired),
        Some(id) => Some(
            ReasonCode::from_id(id)
                .filter(|code| allowed.contains(code))
                .ok_or(PolicyError::ReasonNotAllowed)?,
        ),
    };
    Ok(ModerationChange {
        action,
        from: current,
        to,
        reason,
    })
}

/// The moderation rules as data: every state, and for each action the states
/// it starts from, the state it leads to and the reasons it takes. The hosted
/// function holds the same table; both are checked against
/// `tests/fixtures/feedback-moderation.json`.
pub fn rules() -> Value {
    let actions: serde_json::Map<String, Value> = FEEDBACK_ACTIONS
        .into_iter()
        .map(|action| {
            let from = from_states(action);
            let to = from
                .first()
                .and_then(|state| crate::moderation::next_state(action, *state))
                .expect("every feedback action applies from some state");
            (
                action.id().to_string(),
                json!({
                    "from": from.iter().map(|state| state.id()).collect::<Vec<_>>(),
                    "to": to.id(),
                    "reasons": reasons(action).iter().map(|reason| reason.id()).collect::<Vec<_>>(),
                }),
            )
        })
        .collect();
    json!({
        "states": ModerationState::ALL.iter().map(|state| state.id()).collect::<Vec<_>>(),
        "actions": actions,
    })
}

/// What a moderator learns about the reader's passage before acting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PassageCheck {
    /// Seen on the revision now published, and the words are where they were.
    Current,
    /// The page changed; the same words were found again, once.
    Reanchored,
    /// The words the reader meant cannot be found as the same passage.
    Stale(StaleReason),
    /// No loaded post has the feedback's address, so nothing can be checked.
    UnknownWork,
}

impl PassageCheck {
    pub fn id(self) -> &'static str {
        match self {
            PassageCheck::Current => "current",
            PassageCheck::Reanchored => "reanchored",
            PassageCheck::Stale(_) => "stale",
            PassageCheck::UnknownWork => "unknown-work",
        }
    }

    /// Whether approving needs the moderator to confirm they read the
    /// passage as it is now: anything but a current passage does.
    pub fn needs_acknowledgement(self) -> bool {
        self != PassageCheck::Current
    }
}

pub(crate) fn stale_reason_id(reason: StaleReason) -> &'static str {
    match reason {
        StaleReason::QuoteNotFound => "quoteNotFound",
        StaleReason::ContextChanged => "contextChanged",
        StaleReason::Ambiguous => "ambiguous",
        StaleReason::SectionRemoved => "sectionRemoved",
        StaleReason::SectionChanged => "sectionChanged",
        StaleReason::Unverified => "unverified",
    }
}

/// The heading title of each section of a post's passage document, by
/// section index. Anchors can repeat, so each anchor takes the titles of its
/// headings in order, as the feedback form does (ADR 0082).
pub fn section_titles(post: &Post, document: &PassageDocument) -> Vec<Option<String>> {
    let mut titles: std::collections::HashMap<&str, std::collections::VecDeque<&str>> =
        std::collections::HashMap::new();
    for heading in &post.headings {
        titles
            .entry(heading.id.as_str())
            .or_default()
            .push_back(heading.text.as_str());
    }
    document
        .sections
        .iter()
        .map(|section| {
            section.anchor.as_deref().and_then(|anchor| {
                titles
                    .get_mut(anchor)
                    .and_then(|queue| queue.pop_front())
                    .map(str::to_string)
            })
        })
        .collect()
}

/// The passage of one item, read against the post as it is now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PassageReview {
    pub check: PassageCheck,
    /// The passage revision now published, when the post is known.
    pub revision_now: Option<String>,
    /// The section the passage is in now (its title, or its anchor), when
    /// the passage still resolves.
    pub section_now: Option<String>,
    /// A plain explanation for the moderator.
    pub explanation: String,
}

/// Check one item's passage against the post that has its address now.
pub fn review_passage(
    feedback: &ScholarlyFeedback,
    post: Option<(&Post, &PassageDocument)>,
) -> PassageReview {
    let Some((post, document)) = post else {
        return PassageReview {
            check: PassageCheck::UnknownWork,
            revision_now: None,
            section_now: None,
            explanation: "No post has this address now: it may have moved, been renamed or been unpublished. The passage cannot be checked, so read the note carefully before acting on it.".into(),
        };
    };
    let titles = section_titles(post, document);
    let resolution = feedback.provenance.resolve(document);
    let section_now = resolution.location().and_then(|location| {
        location
            .index
            .and_then(|index| titles.get(index).cloned().flatten())
            .or_else(|| location.section.clone())
    });
    let whole_post = matches!(feedback.provenance.target.selector, PassageSelector::Work);
    let place = || match &section_now {
        Some(section) => format!("in “{section}”"),
        None if whole_post => "about the whole post".into(),
        None => "before the first heading".into(),
    };
    let (check, explanation) = match &resolution {
        Resolution::Current(_) => (
            PassageCheck::Current,
            format!(
                "Current: the reader saw the revision that is published now, and the passage is {}.",
                place()
            ),
        ),
        Resolution::Reanchored(_) => (
            PassageCheck::Reanchored,
            format!(
                "Re-anchored: the post changed after the reader saw it. The same words were found again, once, {}. Check that they still mean what the reader read before you act.",
                place()
            ),
        ),
        Resolution::Stale(stale) => {
            let why = match stale.reason {
                StaleReason::QuoteNotFound => "the words the reader quoted are no longer in the post",
                StaleReason::ContextChanged => "the words are still there, but none of the text around them is",
                StaleReason::Ambiguous => "the words now appear in more than one place",
                StaleReason::SectionRemoved => "the section the reader meant is gone",
                StaleReason::SectionChanged => "the section the reader meant has different text now",
                StaleReason::Unverified => "the section is there, but nothing shows whether its text changed",
            };
            (
                PassageCheck::Stale(stale.reason),
                format!(
                    "Stale: the post changed after the reader saw it, and {why}. The reader's quotation is shown as they sent it; it will not be quoted on the post."
                ),
            )
        }
    };
    PassageReview {
        check,
        revision_now: Some(document.revision.clone()),
        section_now,
        explanation,
    }
}

/// The loaded post with a work's address, if any.
pub fn post_for_work<'a>(site: &'a Site, work: &str) -> Option<&'a Post> {
    site.posts.iter().find(|post| post.url == work)
}

/// What a moderator sees of one feedback record beside its moderation state
/// (ADR 0083): the passage check with both revisions and the reader's own
/// quotation, the kind's details, and the public form approving would give
/// it. Who sent it is the caller's to show, by the viewer's role (ADR 0103);
/// the reader's own clock is never shown.
pub fn feedback_review(feedback: &ScholarlyFeedback, site: &Site) -> Value {
    let provenance = &feedback.provenance;
    let post = post_for_work(site, &provenance.work);
    let document = post.map(|post| PassageDocument::of_post(post, &site.config));
    let review = review_passage(feedback, post.zip(document.as_ref()));
    let mut passage = json!({
        "check": review.check.id(),
        "explanation": review.explanation,
        "revisionSeen": provenance.revision,
        "acknowledge": review.check.needs_acknowledgement(),
    });
    if let PassageCheck::Stale(reason) = review.check {
        passage["reason"] = json!(stale_reason_id(reason));
    }
    if let Some(section) = &provenance.target.section {
        passage["sectionSeen"] = json!(section);
    }
    if let Some(section) = &review.section_now {
        passage["sectionNow"] = json!(section);
    }
    if let Some(revision) = &review.revision_now {
        passage["revisionNow"] = json!(revision);
    }
    if let PassageSelector::Quote(quote) = &provenance.target.selector {
        passage["quoted"] = json!(quote.exact);
    }
    let mut details = json!({});
    if let Some(url) = &feedback.details.source_url {
        details["sourceUrl"] = json!(url);
    }
    if let Some(text) = &feedback.details.suggested_text {
        details["suggestedText"] = json!(text);
    }
    json!({
        "passage": passage,
        "details": details,
        "publicPreview": document.as_ref().map(|document| serde_json::to_value(provenance.public(document)).expect("public provenance serializes")),
    })
}

/// Whether an approval may go ahead given the passage as it is now: a
/// passage that is not current needs the moderator to name the check they
/// read (`acknowledge`), so a re-anchored or stale passage is never approved
/// unseen.
pub fn approval_acknowledged(
    feedback: &ScholarlyFeedback,
    site: &Site,
    acknowledge: Option<&str>,
) -> bool {
    let post = post_for_work(site, &feedback.provenance.work);
    let document = post.map(|post| PassageDocument::of_post(post, &site.config));
    let review = review_passage(feedback, post.zip(document.as_ref()));
    !review.check.needs_acknowledgement() || acknowledge == Some(review.check.id())
}
