//! Featuring an approved reflection on its work's canonical page, with the
//! reader's separate consent (#214, ADRs 0176 to 0181).
//!
//! A *feature* is an editor's choice to show one already-published Third
//! Perspective again in a community section of the page it is about, with a
//! short editorial note. It is the same reflection, never a new one, so it
//! runs on the one participation policy (RD12): nothing can be featured that
//! is not approved, shown and consented to, and no new moderation state or
//! hosted column exists.
//!
//! The site keeps its selections in `community-perspectives.json`, beside
//! `third-perspectives.json` and under the same rules (versioned, public
//! fields only, read strictly, canonical text). A selection holds a
//! *reference*, never the reader's words: the id of the published reflection,
//! the text revision the reader agreed to feature, a digest of the text that
//! was agreed, the day it was featured and the editor's note. The words and
//! the name come from the published reflection, so a withdrawal or a deletion
//! that takes the reflection off takes its feature off too, and a name the
//! reader hides is hidden by republishing that one reflection (ADR 0177): a
//! feature keeps no second copy of the name to forget.
//!
//! Everything here is pure and answers three questions:
//!
//! - *May this be featured?* [`FeatureRecord::new`].
//! - *Does a feature still stand against the hosted copy?*
//!   [`FeatureRecord::hosted_standing`]: Admin's inbox asks it, and the
//!   answer is either [`HostedStanding::Covered`] or the [`FeatureOff`]
//!   reason it must come off.
//! - *What does the page show?* [`resolve_post`] and [`project_post`]: the
//!   public [`FeaturedPerspective`] only while every condition still holds,
//!   else the reason it is hidden.
//!
//! Nothing counts, ranks or orders by popularity: a section lists features
//! by the day they were featured, a feature has no number, score or weight,
//! and an editor's note that claims popularity or agreement is refused.

use std::collections::BTreeSet;

use blake2::{Blake2s256, Digest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::SiteConfig;
use crate::date::DateTime;
use crate::escape::{attr, text};
use crate::feedback_publication::{is_day, is_post_source};
use crate::model::Post;
use crate::participation::ParticipationMode;
use crate::perspective_publication::{
    project_post as project_perspectives, PublicPerspective, PublishedPerspective,
    ThirdPerspectivesFile,
};
use crate::scholarly_feedback::is_uuid;
use crate::third_perspective::{ApprovedResponse, HostedPerspective, ModerationFacts};

/// The file's name, in the content folder.
pub const COMMUNITY_FEATURES_FILE: &str = "community-perspectives.json";
/// The version of the file format. A reader refuses a higher one.
pub const COMMUNITY_FEATURES_VERSION: u64 = 1;
/// The id of the section of a post's canonical page that shows features.
pub const COMMUNITY_FEATURES_ANCHOR: &str = "ob-community-perspectives";
/// The most features the file holds.
pub const MAX_FEATURED: usize = 500;
/// The largest file accepted, before it is parsed.
pub const MAX_COMMUNITY_FEATURES_BYTES: usize = 2 * 1024 * 1024;
/// The longest editorial note, in characters.
pub const MAX_CONTEXT_CHARS: usize = 280;

/// What a section says about why a reflection is there, always shown with it
/// and never replaceable by an editor's note.
pub const NON_CONSENSUS_NOTICE: &str = "The editors chose these reflections to feature. Each is one reader's view: featuring a reflection is an editorial choice, not a vote, and it does not mean the authors, the editors or the community agree with it.";

/// The id of the element that shows one feature. It is not the reflection's
/// own `ob-perspective-<id>` in the Third Perspectives section, which keeps
/// that id because a reflection stays listed there (ADR 0182), so one page
/// never repeats an id.
pub fn feature_anchor(id: &str) -> String {
    format!("ob-feature-{id}")
}

/// The honest provenance line of one feature.
fn provenance(response: &ApprovedResponse, featured: &str) -> String {
    let who = match &response.name {
        Some(name) => format!("{name}, a reader"),
        None => "a reader".to_string(),
    };
    let mut line = format!(
        "A Third Perspective from {who}, received {} and approved by the editors. It is featured here from {featured}, with the reader's separate permission.",
        response.received
    );
    if response.earlier_revision {
        line.push_str(" The reader read an earlier version of this article.");
    }
    if response.stale {
        line.push_str(" The part of the article it is about has changed since.");
    }
    line
}

// ---------------------------------------------------------------------------
// Why a feature is refused, and why it comes off

/// Why a reflection may not be featured, or a note is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeatureError {
    /// The one projection does not show the reflection now.
    NotShownNow,
    /// The reader has not agreed to feature it.
    ConsentMissing,
    /// The reader agreed to feature another revision of their text.
    ConsentForOtherRevision,
    /// The published reflection is not the hosted text or name: a name the
    /// reader has hidden since is republished first.
    PublishedDiffers,
    /// Only a site Admin user may choose what to feature.
    InvalidEditor,
    /// The note is not 1 to [`MAX_CONTEXT_CHARS`] characters of plain text.
    InvalidContext,
    /// The note looks like a claim of popularity, a count or agreement, to the
    /// lint of [`normalize_context`].
    PopularityClaim,
    /// The reflection already has its one placement.
    AlreadyFeatured,
    /// The file holds [`MAX_FEATURED`] features.
    Full,
}

impl FeatureError {
    pub fn code(self) -> &'static str {
        match self {
            FeatureError::NotShownNow => "notShownNow",
            FeatureError::ConsentMissing => "consentMissing",
            FeatureError::ConsentForOtherRevision => "consentForOtherRevision",
            FeatureError::PublishedDiffers => "publishedDiffers",
            FeatureError::InvalidEditor => "invalidEditor",
            FeatureError::InvalidContext => "invalidContext",
            FeatureError::PopularityClaim => "popularityClaim",
            FeatureError::AlreadyFeatured => "alreadyFeatured",
            FeatureError::Full => "full",
        }
    }

    pub fn message(self) -> String {
        match self {
            FeatureError::NotShownNow => "this reflection is not shown on the page now, so it cannot be featured".into(),
            FeatureError::ConsentMissing => "the reader has not agreed to have this reflection featured".into(),
            FeatureError::ConsentForOtherRevision => "the reader agreed to feature an earlier text, not the text that was approved".into(),
            FeatureError::PublishedDiffers => "the published reflection differs from the approved copy; publish it again first".into(),
            FeatureError::InvalidEditor => "only a site Admin user may feature a reflection".into(),
            FeatureError::InvalidContext => format!("an editor's note is 1 to {MAX_CONTEXT_CHARS} characters of plain text"),
            FeatureError::PopularityClaim => "an editor's note is checked by a simple lint for claims of popularity, a count or agreement, and this one looks like such a claim (the lint can refuse an honest note); say why the reflection is worth reading in other words".into(),
            FeatureError::AlreadyFeatured => "this reflection is already featured; it has one placement, on the page it is about".into(),
            FeatureError::Full => format!("the site already features {MAX_FEATURED} reflections"),
        }
    }
}

/// Why a feature comes off, or is hidden. The same reasons serve Admin's
/// check against the hosted copy and the page's check against the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeatureOff {
    /// The reader withdrew the reflection.
    Withdrawn,
    /// Retention purged the text, or the copy is gone.
    Deleted,
    /// The reflection is no longer approved, shown and about this work.
    NotApproved,
    /// The reader no longer agrees to feature it.
    ConsentDeclined,
    /// The text is not the text the reader agreed to feature.
    TextChanged,
    /// The day it was featured is earlier than the day the reflection was
    /// approved, which no honest feature has (a hand-edited file).
    Misdated,
}

impl FeatureOff {
    pub fn id(self) -> &'static str {
        match self {
            FeatureOff::Withdrawn => "withdrawn",
            FeatureOff::Deleted => "deleted",
            FeatureOff::NotApproved => "not-approved",
            FeatureOff::ConsentDeclined => "consent-declined",
            FeatureOff::TextChanged => "text-changed",
            FeatureOff::Misdated => "misdated",
        }
    }

    /// What Admin says to an editor, never a reader's words.
    pub fn explanation(self) -> &'static str {
        match self {
            FeatureOff::Withdrawn => "the reader withdrew this reflection",
            FeatureOff::Deleted => "the reflection's text has been deleted",
            FeatureOff::NotApproved => "the reflection is no longer approved and shown",
            FeatureOff::ConsentDeclined => "the reader no longer agrees to have it featured",
            FeatureOff::TextChanged => {
                "the text is not the text the reader agreed to have featured"
            }
            FeatureOff::Misdated => "it is dated as featured before the reflection was approved",
        }
    }
}

/// Why a feature is hidden for now but need not come off: nothing the reader
/// did or the editors decided has changed, so restoring what is missing
/// restores the feature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HiddenReason {
    /// The article it is about is not published now. The record stays, so
    /// publishing the article again at the same address restores the section;
    /// Admin may still take it off.
    SourceGone,
}

impl HiddenReason {
    pub fn id(self) -> &'static str {
        match self {
            HiddenReason::SourceGone => "source-gone",
        }
    }

    /// What Admin says to an editor, never a reader's words.
    pub fn explanation(self) -> &'static str {
        match self {
            HiddenReason::SourceGone => "the article it is about is no longer published",
        }
    }
}

/// Whether a feature still stands against its hosted copy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostedStanding {
    Covered,
    /// Not shown now, and nothing is wrong with the feature itself: it is not
    /// a take-off.
    Hidden(HiddenReason),
    /// It must come off for the stated reason.
    MustComeOff(FeatureOff),
}

/// Why a feature is not on the page now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotShown {
    Hidden(HiddenReason),
    Off(FeatureOff),
}

impl From<FeatureOff> for NotShown {
    fn from(off: FeatureOff) -> Self {
        NotShown::Off(off)
    }
}

// ---------------------------------------------------------------------------
// The editor's note

/// Unicode format characters (category Cf): invisible, and able to hide a word
/// from a lint or reorder text. Refused in a note along with controls and the
/// other default-ignorable characters.
fn is_format_character(character: char) -> bool {
    matches!(
        u32::from(character),
        0x00AD
            | 0x0600..=0x0605
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x0890..=0x0891
            | 0x08E2
            | 0x180E
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0001
            | 0xE0020..=0xE007F
    )
}

pub(crate) fn forbidden_in_context(character: char) -> bool {
    character.is_control()
        || is_format_character(character)
        || crate::collaboration::is_invisible(character)
        || crate::research_notes::bidi_override(character)
}

/// Whole words or phrases that make selection look like a vote, a rank, a
/// popularity or a consensus. Matched on whole words after the note is
/// lower-cased and split at anything that is not a letter or a digit, so
/// "most-agreed" is "most agreed" and "devoted" is not "voted".
const POPULARITY_PHRASES: &[&str] = &[
    "most agreed",
    "most popular",
    "most liked",
    "most upvoted",
    "most read",
    "most shared",
    "most loved",
    "most discussed",
    "most viewed",
    "most commented",
    "top reflection",
    "top rated",
    "top voted",
    "highest rated",
    "best reflection",
    "best rated",
    "widely shared",
    "widely read",
    "widely liked",
    "widely agreed",
    "widely loved",
    "well liked",
    "well loved",
    "well received",
    "crowd favourite",
    "crowd favorite",
    "fan favourite",
    "fan favorite",
    "readers agree",
    "people agree",
    "everyone agrees",
    "everybody agrees",
    "community agrees",
    "community consensus",
    "community favourite",
    "community favorite",
    "majority of readers",
    "most readers",
    "most people",
    "many readers",
    "many people",
    "several readers",
    "several people",
    "few readers",
    "other readers agree",
    "readers loved",
    "readers liked",
];

/// Single words that are a claim of popularity, rank or a vote on their own.
const POPULARITY_WORDS: &[&str] = &[
    "popular",
    "popularity",
    "favourite",
    "favourites",
    "favorite",
    "favorites",
    "upvote",
    "upvotes",
    "upvoted",
    "downvote",
    "downvotes",
    "downvoted",
    "vote",
    "votes",
    "voted",
    "voting",
    "ranked",
    "ranking",
    "rankings",
    "trending",
    "viral",
    "bestseller",
    "acclaimed",
];

/// Nouns that, beside a number, count readers or their reactions.
const COUNTED_NOUNS: &[&str] = &[
    "reader",
    "readers",
    "people",
    "person",
    "persons",
    "like",
    "likes",
    "vote",
    "votes",
    "agree",
    "agrees",
    "agreed",
    "agreement",
    "agreements",
    "share",
    "shares",
    "reaction",
    "reactions",
    "view",
    "views",
    "reflection",
    "reflections",
    "response",
    "responses",
    "perspective",
    "perspectives",
    "comment",
    "comments",
    "supporter",
    "supporters",
];

/// Words for a number that count when beside a counted noun.
const NUMBER_WORDS: &[&str] = &[
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "dozen",
    "dozens",
    "hundred",
    "hundreds",
    "thousand",
    "thousands",
    "million",
    "millions",
    "percent",
];

/// Words that may stand between a number and what it counts: "90% of readers",
/// "12 more people".
const NUMBER_FILLERS: &[&str] = &["of", "more", "other", "different", "fellow", "total"];

fn is_number_token(word: &str) -> bool {
    word.chars().all(|c| c.is_ascii_digit()) && !word.is_empty() || NUMBER_WORDS.contains(&word)
}

/// Whether a note, as lower-case words, claims popularity, a count or
/// agreement. A lint: a simple, conservative hint that errs toward refusing,
/// not a judgment of the note and not a guarantee, which is why a refusal says
/// so and an editor can say why a reflection is worth reading in other words.
pub(crate) fn claims_popularity(text: &str) -> bool {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    if words.iter().any(|word| POPULARITY_WORDS.contains(word)) {
        return true;
    }
    let joined = format!(" {} ", words.join(" "));
    if POPULARITY_PHRASES
        .iter()
        .any(|phrase| joined.contains(&format!(" {phrase} ")))
    {
        return true;
    }
    for (index, word) in words.iter().enumerate() {
        if !is_number_token(word) {
            continue;
        }
        // A number then what it counts ("12 readers", "90 of readers"), or what
        // it counts then the number ("readers 12").
        let mut next = index + 1;
        while words.get(next).is_some_and(|w| NUMBER_FILLERS.contains(w)) && next < index + 3 {
            next += 1;
        }
        if words.get(next).is_some_and(|w| COUNTED_NOUNS.contains(w)) {
            return true;
        }
        if index > 0 && COUNTED_NOUNS.contains(&words[index - 1]) {
            return true;
        }
    }
    false
}

/// An editor's note as stored: whitespace collapsed, 1 to
/// [`MAX_CONTEXT_CHARS`] characters of plain text. Blank is no note. The
/// popularity check is a lint (ADR 0180).
pub fn normalize_context(value: &str) -> Result<Option<String>, FeatureError> {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Ok(None);
    }
    if text.chars().count() > MAX_CONTEXT_CHARS || text.chars().any(forbidden_in_context) {
        return Err(FeatureError::InvalidContext);
    }
    if claims_popularity(&text) {
        return Err(FeatureError::PopularityClaim);
    }
    Ok(Some(text))
}

/// The digest of the reflection text a feature was agreed for.
pub fn body_digest(body: &str) -> String {
    let mut hasher = Blake2s256::new();
    hasher.update(b"openblog-featured-reflection-v1\0");
    hasher.update((body.len() as u64).to_be_bytes());
    hasher.update(body.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

// ---------------------------------------------------------------------------
// What the reader agreed to, for Admin's card

/// Where a hosted reflection stands on the reader's feature consent, as the
/// inbox card says it: never the reader's words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeatureConsent {
    /// Approved at its current text, and the reader agreed to feature exactly
    /// that revision: an editor may choose it.
    Agreed,
    /// The reader agreed to feature an earlier text, which does not cover this
    /// one (they clarified since, or it is not the approved text).
    EarlierText,
    /// The reader has not agreed, or declined, or is not in a state that can
    /// be featured.
    NotAgreed,
}

impl FeatureConsent {
    pub fn id(self) -> &'static str {
        match self {
            FeatureConsent::Agreed => "agreed",
            FeatureConsent::EarlierText => "earlier-text",
            FeatureConsent::NotAgreed => "not-agreed",
        }
    }

    /// The card's sentence for an editor.
    pub fn explanation(self) -> &'static str {
        match self {
            FeatureConsent::Agreed => "the reader agreed to have this text featured",
            FeatureConsent::EarlierText => {
                "the reader agreed to feature an earlier text, which does not cover this one"
            }
            FeatureConsent::NotAgreed => "the reader has not agreed to have it featured",
        }
    }

    /// The standing of a hosted copy: only an approved copy, whose approved
    /// revision is its current text, can be `Agreed`.
    pub fn of(hosted: &HostedPerspective) -> Self {
        use crate::moderation::ModerationState;
        let copy = &hosted.copy;
        let consent = copy.consent();
        if !consent.publish || hosted.state != ModerationState::Approved {
            return FeatureConsent::NotAgreed;
        }
        match consent.feature_revision {
            None => FeatureConsent::NotAgreed,
            Some(revision)
                if revision == copy.revision
                    && hosted.approved_revision == Some(copy.revision)
                    && copy.feature_covers(revision) =>
            {
                FeatureConsent::Agreed
            }
            Some(_) => FeatureConsent::EarlierText,
        }
    }
}

// ---------------------------------------------------------------------------
// One feature as the file stores it

/// An editor's request to feature a reflection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeatureRequest {
    /// The site Admin user choosing. Never stored: the file's history in the
    /// site's repository is the record of who changed it.
    pub selected_by: String,
    /// The optional editor's note.
    pub context: String,
    pub at: DateTime,
}

/// One feature: a reference to a published reflection and what the reader
/// agreed to, never the reader's words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeatureRecord {
    /// The published reflection's id (a lowercase UUID). A reflection has at
    /// most one feature.
    pub id: String,
    /// The post's source path, the one the reflection is about.
    pub post: String,
    /// The text revision the reader agreed to have featured.
    pub revision: u32,
    /// The digest of that text.
    pub digest: String,
    /// The day it was featured, `YYYY-MM-DD`.
    pub featured: String,
    /// The editor's note, plain text.
    pub context: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireRecord {
    id: String,
    post: String,
    revision: u32,
    digest: String,
    featured: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context: Option<String>,
}

impl FeatureRecord {
    /// Feature a reflection the hosted copy and the published file both show
    /// now: approved at its current text, under a consent that agrees to
    /// feature exactly that revision, about this post. The editor's note is
    /// checked. Approval alone never features anything.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        source: &str,
        hosted: &HostedPerspective,
        facts: &ModerationFacts,
        published: &PublishedPerspective,
        post: &Post,
        config: &SiteConfig,
        request: &FeatureRequest,
    ) -> Result<Self, FeatureError> {
        if !crate::collaboration::valid_admin_username(&request.selected_by) {
            return Err(FeatureError::InvalidEditor);
        }
        let context = normalize_context(&request.context)?;
        let response = PublishedPerspective::response_of(hosted, post, config)
            .filter(|_| facts.approved_revision == Some(hosted.copy.revision))
            .ok_or(FeatureError::NotShownNow)?;
        let copy = &hosted.copy;
        match copy.consent().feature_revision {
            None => return Err(FeatureError::ConsentMissing),
            Some(revision) if !copy.feature_covers(revision) || revision != copy.revision => {
                return Err(FeatureError::ConsentForOtherRevision)
            }
            Some(_) => {}
        }
        if published.id != hosted.id.to_ascii_lowercase()
            || published.post != source
            || published.body != copy.body
            || published.name != response.name
        {
            return Err(FeatureError::PublishedDiffers);
        }
        let record = Self {
            id: published.id.clone(),
            post: source.to_string(),
            revision: copy.revision,
            digest: body_digest(&copy.body),
            featured: request.at.ymd().max(published.approved.clone()),
            context,
        };
        record
            .validate()
            .map_err(|_| FeatureError::InvalidContext)?;
        Ok(record)
    }

    /// Whether this feature still stands against the hosted copy: the check
    /// Admin makes on every inbox load. `hosted` is `None` for a row that no
    /// longer exists, else the row's moderation facts and its Third Perspective
    /// (`None` once retention purged the text, so a withdrawn row is still
    /// told apart from a gone one). `post` is the post as published now.
    /// Everything the reader or the editors decided is checked before the
    /// article is, so a feature is `Hidden` only when nothing else is wrong and
    /// restoring the article does restore it. Nothing here reads a private
    /// field into the answer: it is a reason, never the reader's words.
    pub fn hosted_standing(
        &self,
        hosted: Option<(Option<&HostedPerspective>, &ModerationFacts)>,
        post: Option<&Post>,
        config: &SiteConfig,
        mode: ParticipationMode,
    ) -> HostedStanding {
        use crate::moderation::ModerationState;
        let off = HostedStanding::MustComeOff;
        let Some((hosted_copy, facts)) = hosted else {
            return off(FeatureOff::Deleted);
        };
        if facts.state == ModerationState::Withdrawn {
            return off(FeatureOff::Withdrawn);
        }
        let hosted = match hosted_copy {
            Some(hosted) if facts.content_retained => hosted,
            _ => return off(FeatureOff::Deleted),
        };
        if facts.state != ModerationState::Approved {
            return off(FeatureOff::NotApproved);
        }
        let copy = &hosted.copy;
        match copy.consent().feature_revision {
            None => return off(FeatureOff::ConsentDeclined),
            Some(_) if !copy.feature_covers(self.revision) => return off(FeatureOff::TextChanged),
            Some(_) => {}
        }
        if copy.revision != self.revision
            || facts.approved_revision != Some(self.revision)
            || body_digest(&copy.body) != self.digest
        {
            return off(FeatureOff::TextChanged);
        }
        let Some(post) = post else {
            return HostedStanding::Hidden(HiddenReason::SourceGone);
        };
        if PublishedPerspective::response_in(hosted, post, config, mode).is_none() {
            return off(FeatureOff::NotApproved);
        }
        HostedStanding::Covered
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
        if self.revision == 0 || self.revision > i32::MAX as u32 {
            return Err("`revision` must be a positive text revision".into());
        }
        if self.digest.len() != 64
            || !self
                .digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("`digest` must be 64 lowercase hexadecimal digits".into());
        }
        if !is_day(&self.featured) {
            return Err("`featured` must be a day written YYYY-MM-DD".into());
        }
        if let Some(context) = &self.context {
            match normalize_context(context) {
                Ok(Some(normal)) if normal == *context => {}
                Err(FeatureError::PopularityClaim) => {
                    return Err("`context` may not claim popularity, a count or agreement".into())
                }
                _ => {
                    return Err(format!(
                        "`context` must be 1 to {MAX_CONTEXT_CHARS} characters of plain text with single spaces"
                    ))
                }
            }
        }
        Ok(())
    }

    fn from_value(value: &Value) -> Result<Self, String> {
        let wire: WireRecord = serde_json::from_value(value.clone()).map_err(|_| {
            "has a field this version does not define, or a field of the wrong type".to_string()
        })?;
        let record = Self {
            id: wire.id,
            post: wire.post,
            revision: wire.revision,
            digest: wire.digest,
            featured: wire.featured,
            context: wire.context,
        };
        record.validate()?;
        Ok(record)
    }

    fn to_wire(&self) -> WireRecord {
        WireRecord {
            id: self.id.clone(),
            post: self.post.clone(),
            revision: self.revision,
            digest: self.digest.clone(),
            featured: self.featured.clone(),
            context: self.context.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// The file

/// Every feature the site publishes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FeaturesFile {
    pub items: Vec<FeatureRecord>,
}

impl FeaturesFile {
    /// Read the file, refusing a newer version, an unknown field or any
    /// broken rule, naming the item and never what it holds. Nothing is
    /// repaired or dropped.
    pub fn from_json(text: &str) -> Result<Self, String> {
        if text.len() > MAX_COMMUNITY_FEATURES_BYTES {
            return Err(format!(
                "is larger than {MAX_COMMUNITY_FEATURES_BYTES} bytes"
            ));
        }
        let value: Value =
            serde_json::from_str(text).map_err(|_| "is not valid JSON".to_string())?;
        match value.get("version").and_then(Value::as_u64) {
            Some(COMMUNITY_FEATURES_VERSION) => {}
            Some(version) if version > COMMUNITY_FEATURES_VERSION => {
                return Err(format!(
                    "is version {version}, newer than the version {COMMUNITY_FEATURES_VERSION} this open.blog reads"
                ))
            }
            _ => return Err("needs `version` 1".into()),
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct WireFile {
            #[allow(dead_code)]
            version: u64,
            items: Vec<Value>,
        }
        let wire: WireFile = serde_json::from_value(value)
            .map_err(|_| "needs only `version` and an `items` list".to_string())?;
        if wire.items.len() > MAX_FEATURED {
            return Err(format!(
                "has {} items; keep at most {MAX_FEATURED}",
                wire.items.len()
            ));
        }
        let mut items = Vec::with_capacity(wire.items.len());
        let mut ids = BTreeSet::new();
        for (index, value) in wire.items.iter().enumerate() {
            let item = FeatureRecord::from_value(value)
                .map_err(|error| format!("item {}: {error}", index + 1))?;
            if !ids.insert(item.id.clone()) {
                return Err(format!(
                    "item {}: repeats the id of an earlier item; a reflection has one placement",
                    index + 1
                ));
            }
            items.push(item);
        }
        Ok(Self { items })
    }

    /// Canonical text: items sorted by post, day featured and id, two-space
    /// indentation and a final line break.
    pub fn to_json(&self) -> String {
        let mut items: Vec<&FeatureRecord> = self.items.iter().collect();
        items.sort_by(|a, b| {
            (a.post.as_str(), a.featured.as_str(), a.id.as_str()).cmp(&(
                b.post.as_str(),
                b.featured.as_str(),
                b.id.as_str(),
            ))
        });
        let value = json!({
            "version": COMMUNITY_FEATURES_VERSION,
            "items": items.iter().map(|item| item.to_wire()).collect::<Vec<_>>(),
        });
        let mut out = serde_json::to_string_pretty(&value).expect("features serialize");
        out.push('\n');
        out
    }

    pub fn get(&self, id: &str) -> Option<&FeatureRecord> {
        self.items.iter().find(|item| item.id == id)
    }

    /// Add a feature. A reflection has one placement, so a second is refused.
    pub fn feature(&mut self, record: FeatureRecord) -> Result<(), FeatureError> {
        if self.get(&record.id).is_some() {
            return Err(FeatureError::AlreadyFeatured);
        }
        if self.items.len() >= MAX_FEATURED {
            return Err(FeatureError::Full);
        }
        self.items.push(record);
        Ok(())
    }

    /// Change a feature's editors' note (blank clears it), under the same
    /// rules as when it was made. A note is the editors' own words, so no
    /// consent from the reader is involved (ADR 0177); the reader's words and
    /// the feature's day are untouched. Whether the feature was there.
    pub fn set_context(&mut self, id: &str, context: &str) -> Result<bool, FeatureError> {
        let context = normalize_context(context)?;
        Ok(match self.items.iter_mut().find(|item| item.id == id) {
            Some(item) => {
                item.context = context;
                true
            }
            None => false,
        })
    }

    /// Take a feature off; whether it was there. Nothing remains: there is
    /// no public tombstone (ADR 0179).
    pub fn unfeature(&mut self, id: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|item| item.id != id);
        self.items.len() != before
    }

    /// Take a reflection off the site together with its feature, in one step:
    /// a reflection that is no longer published is never left featured.
    /// Returns whether the reflection was published and whether it was
    /// featured.
    pub fn unpublish_reflection(
        &mut self,
        published: &mut ThirdPerspectivesFile,
        id: &str,
    ) -> (bool, bool) {
        (published.unpublish(id), self.unfeature(id))
    }

    /// The features about one post, oldest first by the day they were
    /// featured. Nothing orders them by popularity: there is nothing to
    /// count.
    pub fn for_post(&self, source: &str) -> Vec<&FeatureRecord> {
        let mut items: Vec<&FeatureRecord> = self
            .items
            .iter()
            .filter(|item| item.post == source)
            .collect();
        items.sort_by(|a, b| (&a.featured, &a.id).cmp(&(&b.featured, &b.id)));
        items
    }
}

// ---------------------------------------------------------------------------
// What the page shows

/// One featured reflection as the canonical page shows it: the reflection's
/// one public projection, the editor's note, the day it was featured and the
/// honest provenance line. It has no field for a count, rank, score, vote,
/// reaction or the editor who chose it, so no renderer can show one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturedPerspective {
    /// The published reflection's id, which an abuse report names.
    pub id: String,
    pub response: ApprovedResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_title: Option<String>,
    /// The editor's note, labelled as the editors' own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// The day it was featured, `YYYY-MM-DD`.
    pub featured: String,
    /// Where it came from and what agreed to it, always shown with it.
    pub provenance: String,
}

impl FeaturedPerspective {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("a featured perspective always serializes")
    }
}

/// Each feature of `post` and the public form it has now, or the reason it is
/// hidden. `records` are the file's features for `source`; `post` is `None`
/// when the article is gone. Order is the order of `records`.
#[allow(clippy::too_many_arguments)]
pub fn resolve_post(
    records: &[&FeatureRecord],
    published: &ThirdPerspectivesFile,
    post: Option<&Post>,
    config: &SiteConfig,
    mode: ParticipationMode,
    answer_mode: ParticipationMode,
) -> Vec<(String, Result<FeaturedPerspective, NotShown>)> {
    let Some(post) = post else {
        return records
            .iter()
            .map(|record| {
                (
                    record.id.clone(),
                    Err(NotShown::Hidden(HiddenReason::SourceGone)),
                )
            })
            .collect();
    };
    let items: Vec<&PublishedPerspective> = records
        .iter()
        .filter_map(|record| {
            published
                .get(&record.id)
                .filter(|item| item.post == record.post)
        })
        .collect();
    let shown: Vec<PublicPerspective> =
        project_perspectives(&items, post, config, mode, answer_mode);
    records
        .iter()
        .map(|record| {
            let result = (|| {
                let item = published
                    .get(&record.id)
                    .filter(|item| item.post == record.post)
                    .ok_or(FeatureOff::NotApproved)?;
                let public = shown
                    .iter()
                    .find(|public| public.id == record.id)
                    .ok_or(FeatureOff::NotApproved)?;
                if body_digest(&item.body) != record.digest {
                    return Err(FeatureOff::TextChanged);
                }
                // Featured is never before approved (a feature is chosen from an
                // approved reflection), so an earlier day is a hand edit.
                if record.featured < item.approved {
                    return Err(FeatureOff::Misdated);
                }
                Ok(FeaturedPerspective {
                    id: record.id.clone(),
                    provenance: provenance(&public.response, &record.featured),
                    response: public.response.clone(),
                    section_title: public.section_title.clone(),
                    context: record.context.clone(),
                    featured: record.featured.clone(),
                })
            })();
            (record.id.clone(), result.map_err(NotShown::Off))
        })
        .collect()
}

/// The features a post's canonical page shows now, by the day they were
/// featured. A feature that does not stand is simply absent: the page keeps
/// no count of them and no mark of a gap (ADR 0179).
pub fn project_post(
    records: &[&FeatureRecord],
    published: &ThirdPerspectivesFile,
    post: &Post,
    config: &SiteConfig,
    mode: ParticipationMode,
    answer_mode: ParticipationMode,
) -> Vec<FeaturedPerspective> {
    resolve_post(records, published, Some(post), config, mode, answer_mode)
        .into_iter()
        .filter_map(|(_, result)| result.ok())
        .collect()
}

// ---------------------------------------------------------------------------
// The canonical page's section (ADR 0184)

/// The section of a post's canonical page that shows its features, or nothing
/// when there are none. Static HTML that needs no script and no style:
///
/// - a labelled `<section>` with a heading and the fixed
///   [`NON_CONSENSUS_NOTICE`], so the framing is never an editor's to leave out;
/// - a `<ul>` (never an ordered list: an order here is the day each was
///   featured, which the provenance says, and means no rank) of `<article>`s,
///   each with its own `ob-feature-<id>` anchor, headed as a reader's, marked
///   as chosen by the editors, with its provenance, the place it is about, the
///   reader's words whole and the editors' note labelled as theirs;
/// - a link from each to the same reflection among the Third Perspectives,
///   where it stays listed (ADR 0182) with its report form and any answer.
///
/// No count, rank, score or popularity word is written by this function, the
/// notice or the labels; every value is escaped.
pub fn render_section(items: &[FeaturedPerspective]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let anchor = COMMUNITY_FEATURES_ANCHOR;
    let mut html = format!(
        "<section id=\"{anchor}\" class=\"ob-community-perspectives\" aria-labelledby=\"{anchor}-title\">
<h2 id=\"{anchor}-title\">Community perspectives</h2>
<p class=\"ob-community-notice\">{}</p>
<ul class=\"ob-community-perspectives-list\">
",
        text(NON_CONSENSUS_NOTICE)
    );
    for item in items {
        let id = feature_anchor(&attr(&item.id));
        let response = &item.response;
        let mut meta = vec![crate::perspective_publication::place_line(
            response,
            item.section_title.as_deref(),
        )];
        if let Some(category) = response.category {
            meta.push(format!("Prompt: {}", text(category.label())));
        }
        meta.push(format!(
            "received <time datetime=\"{0}\">{0}</time>",
            attr(&response.received)
        ));
        html.push_str(&format!(
            "<li><article class=\"ob-feature\" id=\"{id}\" aria-labelledby=\"{id}-title\">
<h3 id=\"{id}-title\">{}</h3>
<p class=\"ob-feature-status\"><strong>Chosen by the editors</strong> to feature here</p>
<p class=\"ob-feature-provenance\">{}</p>
<p class=\"ob-perspective-meta\">{}</p>
",
            text(&response.heading()),
            text(&item.provenance),
            meta.join(" · ")
        ));
        html.push_str(
            "<div class=\"ob-feature-body\">
",
        );
        html.push_str(&crate::perspective_publication::paragraphs(&response.body));
        html.push_str(
            "
</div>
",
        );
        if let Some(context) = &item.context {
            html.push_str(&format!(
                "<p class=\"ob-feature-note\"><strong>Note from the editors:</strong> {}</p>
",
                text(context)
            ));
        }
        html.push_str(&format!(
            "<p class=\"ob-feature-original\"><a href=\"#ob-perspective-{}\">See this reflection among the Third Perspectives</a></p>
</article></li>
",
            attr(&item.id)
        ));
    }
    html.push_str(
        "</ul>
</section>
",
    );
    html
}
