//! Which kinds of reader participation a site and a post accept (ADR 0101).
//!
//! Every way a reader or an author can add to a published post (a comment, a
//! passage question, a suggested source or correction, another interpretation,
//! a Third Perspective, an author response, an abuse report) is one
//! [`ParticipationKind`] in one closed registry. Each kind has a site setting
//! in `openblog.json` (`participation.kinds`) and may have a per-post mode in
//! front matter (`participation:`), except comments, which keep their existing
//! `engagement.comments` switch and `comments:` front matter unchanged.
//!
//! Everything new is off: a kind the site has not named is `off`, and nothing
//! a post says can turn it on. Moderation of what a kind receives is
//! [`crate::moderation`]; every kind starts pending there.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::config::SiteConfig;
use crate::model::{CommentsPolicy, Post, Site};
use crate::moderation::RetentionPolicy;

/// One way to participate. The set is closed and owned by code: an id this
/// version does not know is refused, never guessed. Adding a kind adds a
/// variant whose site setting defaults to `off`, so no existing site changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ParticipationKind {
    /// A reader's comment on the whole post: the existing hosted comments.
    Comment,
    /// A question about a passage (B5, the `question` of ADR 0079, typed scholarly feedback kinds).
    Question,
    /// A source a reader thinks bears on a passage (`source-suggestion`).
    SourceSuggestion,
    /// Wording a reader thinks is wrong. Never a correction before an author
    /// decides (`correction-suggestion`).
    CorrectionSuggestion,
    /// Another reading of a passage (`alternative-interpretation`).
    AlternativeInterpretation,
    /// A reader's own interpretation of a collaborative work, about the whole
    /// work or one section (RD10).
    ThirdPerspective,
    /// An author's public reply to one approved item (#83, RD11).
    AuthorResponse,
    /// A reader's report that an approved, public item is abusive. Never
    /// public itself.
    AbuseReport,
    /// A question, text, video or source a reader suggests for future work,
    /// kept in the editors' private queue (RD13). Never public.
    FutureSuggestion,
}

/// Who creates a kind's items.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    /// Any reader, through the public submission path, without an account.
    Reader,
    /// An authenticated author of the post (site Admin, coordinator or
    /// contributing author of the work).
    Author,
}

/// What a kind's item points at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetShape {
    /// The whole published work.
    Work,
    /// A passage target (B5, ADR 0076, passage targets): the work, a section or a quotation.
    Passage,
    /// The whole work or one of its sections.
    WorkOrSection,
    /// Another participation item on the same work.
    Item,
}

/// The fixed rules of one kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KindRules {
    pub origin: Origin,
    pub target: TargetShape,
    /// Whether an approved item may be shown to readers. An abuse report never is.
    pub publishable: bool,
    /// Whether a moderator may ask the submitter to clarify (with the
    /// submitter's consent). Authors and reporters are never asked.
    pub clarification: bool,
    /// Whether a post may set this kind's mode in its `participation:` front
    /// matter. Comments use `comments:`; abuse reports are site-wide.
    pub per_post: bool,
    /// Whether approval admits the item to the editors' private queue
    /// instead of publishing it (ADR 0152): such an item is never public,
    /// is kept after approval until an author closes it, and is closed by
    /// the same `remove` an approved public item is.
    pub editorial: bool,
}

impl ParticipationKind {
    pub const ALL: [ParticipationKind; 9] = [
        ParticipationKind::Comment,
        ParticipationKind::Question,
        ParticipationKind::SourceSuggestion,
        ParticipationKind::CorrectionSuggestion,
        ParticipationKind::AlternativeInterpretation,
        ParticipationKind::ThirdPerspective,
        ParticipationKind::AuthorResponse,
        ParticipationKind::AbuseReport,
        ParticipationKind::FutureSuggestion,
    ];

    /// The stored id: lowercase letters, digits and hyphens, at most 40
    /// characters, the shape the `kind` column of ADR 0080 (hosted feedback table) accepts.
    pub fn id(self) -> &'static str {
        match self {
            ParticipationKind::Comment => "comment",
            ParticipationKind::Question => "question",
            ParticipationKind::SourceSuggestion => "source-suggestion",
            ParticipationKind::CorrectionSuggestion => "correction-suggestion",
            ParticipationKind::AlternativeInterpretation => "alternative-interpretation",
            ParticipationKind::ThirdPerspective => "third-perspective",
            ParticipationKind::AuthorResponse => "author-response",
            ParticipationKind::AbuseReport => "abuse-report",
            ParticipationKind::FutureSuggestion => "future-suggestion",
        }
    }

    /// B5's four passage feedback kinds (ADR 0079), in the order its form
    /// offers them. `engagement.feedback` folds into these (ADR 0101).
    pub const PASSAGE_FEEDBACK: [ParticipationKind; 4] = [
        ParticipationKind::Question,
        ParticipationKind::SourceSuggestion,
        ParticipationKind::CorrectionSuggestion,
        ParticipationKind::AlternativeInterpretation,
    ];

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.id() == id)
    }

    /// A label for moderators and forms. It names an intent, never a verdict.
    pub fn label(self) -> &'static str {
        match self {
            ParticipationKind::Comment => "Comment",
            ParticipationKind::Question => "Question",
            ParticipationKind::SourceSuggestion => "Suggested source",
            ParticipationKind::CorrectionSuggestion => "Suggested correction",
            ParticipationKind::AlternativeInterpretation => "Another interpretation",
            ParticipationKind::ThirdPerspective => "Third Perspective",
            ParticipationKind::AuthorResponse => "Author response",
            ParticipationKind::AbuseReport => "Abuse report",
            ParticipationKind::FutureSuggestion => "Suggestion for future work",
        }
    }

    pub fn rules(self) -> KindRules {
        use ParticipationKind::*;
        let reader = |target, clarification| KindRules {
            origin: Origin::Reader,
            target,
            publishable: true,
            clarification,
            per_post: true,
            editorial: false,
        };
        match self {
            Comment => KindRules {
                per_post: false,
                ..reader(TargetShape::Work, false)
            },
            Question | SourceSuggestion | CorrectionSuggestion | AlternativeInterpretation => {
                reader(TargetShape::Passage, true)
            }
            ThirdPerspective => reader(TargetShape::WorkOrSection, true),
            AuthorResponse => KindRules {
                origin: Origin::Author,
                target: TargetShape::Item,
                publishable: true,
                clarification: false,
                per_post: true,
                editorial: false,
            },
            AbuseReport => KindRules {
                origin: Origin::Reader,
                target: TargetShape::Item,
                publishable: false,
                clarification: false,
                per_post: false,
                editorial: false,
            },
            FutureSuggestion => KindRules {
                publishable: false,
                editorial: true,
                ..reader(TargetShape::Work, true)
            },
        }
    }

    /// Whether the site may give this kind `setting`. Comments are not set
    /// here at all; an abuse report is either off or open for the whole site.
    fn accepts_site_setting(self, setting: SiteSetting) -> Result<(), String> {
        match (self, setting) {
            (ParticipationKind::Comment, _) => Err(
                "participation.kinds cannot set `comment`; comments keep `engagement.comments` \
                 and each post's `comments:`"
                    .into(),
            ),
            (ParticipationKind::AbuseReport, SiteSetting::Off | SiteSetting::Open) => Ok(()),
            (ParticipationKind::AbuseReport, _) => {
                Err("participation.kinds.abuse-report must be `off` or `open`".into())
            }
            _ => Ok(()),
        }
    }
}

impl fmt::Display for ParticipationKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.id())
    }
}

impl Serialize for ParticipationKind {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.id())
    }
}

impl<'de> Deserialize<'de> for ParticipationKind {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let id = String::deserialize(deserializer)?;
        ParticipationKind::from_id(&id).ok_or_else(|| {
            serde::de::Error::custom(format!(
                "unknown participation kind `{}`",
                id.escape_debug()
            ))
        })
    }
}

/// How one kind behaves on one post: the existing three comment modes,
/// applied to every kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ParticipationMode {
    /// Nothing is shown and nothing is accepted.
    Hidden,
    /// Approved items are shown; nothing new is accepted.
    Locked,
    /// Approved items are shown and new items are accepted, pending moderation.
    Open,
}

impl ParticipationMode {
    pub const ALL: [ParticipationMode; 3] = [
        ParticipationMode::Hidden,
        ParticipationMode::Locked,
        ParticipationMode::Open,
    ];

    pub fn id(self) -> &'static str {
        match self {
            ParticipationMode::Hidden => "hidden",
            ParticipationMode::Locked => "locked",
            ParticipationMode::Open => "open",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| mode.id() == id)
    }

    /// Whether approved items of the kind may be shown.
    pub fn shows_approved(self) -> bool {
        self != ParticipationMode::Hidden
    }
}

impl From<CommentsPolicy> for ParticipationMode {
    fn from(policy: CommentsPolicy) -> Self {
        match policy {
            CommentsPolicy::Open => ParticipationMode::Open,
            CommentsPolicy::Locked => ParticipationMode::Locked,
            CommentsPolicy::Hidden => ParticipationMode::Hidden,
        }
    }
}

/// A kind's site-wide setting in `openblog.json`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SiteSetting {
    /// The kind does not exist on this site; front matter cannot enable it.
    #[default]
    Off,
    /// Each post's mode is its `comments:` setting unless the post names the
    /// kind. This is B5's interim rule (ADR 0081, hosted feedback transport), kept as an explicit choice.
    FollowComments,
    /// Enabled; posts that do not name the kind are hidden for it.
    Hidden,
    /// Enabled; posts that do not name the kind are locked for it.
    Locked,
    /// Enabled; posts that do not name the kind are open for it.
    Open,
}

/// The `participation` object of `openblog.json`. Omitted from the written
/// file while it has its defaults, so existing projects keep their
/// configuration byte for byte.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ParticipationConfig {
    /// Site settings by kind id. A kind not named is `off`.
    pub kinds: BTreeMap<ParticipationKind, SiteSetting>,
    /// Settings derived at load from `engagement.feedback` (ADR 0101): B5's
    /// four kinds as `follow-comments` where `kinds` does not name them.
    /// Never written back, so the owner's file keeps what the owner wrote.
    #[serde(skip)]
    folded: BTreeMap<ParticipationKind, SiteSetting>,
    /// How long moderation keeps what it does not publish (ADR 0104). Unset,
    /// the default periods apply to every kind except comments, so a site
    /// that never mentions retention keeps its comments as before; set (even
    /// as `{}`), the periods apply to comments too.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retention: Option<RetentionPolicy>,
}

impl ParticipationConfig {
    /// Whether the owner's settings are the defaults, so the object is left
    /// out of the written file. Settings folded from `engagement.feedback`
    /// are not the owner's and do not count.
    pub fn is_default(&self) -> bool {
        self.kinds.is_empty() && self.retention.is_none()
    }

    /// The site setting of a kind other than comments: what
    /// `participation.kinds` names, else what `engagement.feedback` folded in,
    /// else `off`.
    pub fn setting(&self, kind: ParticipationKind) -> SiteSetting {
        self.kinds
            .get(&kind)
            .or_else(|| self.folded.get(&kind))
            .copied()
            .unwrap_or_default()
    }

    /// Whether any kind beyond comments is switched on, folded settings
    /// included.
    pub fn any_enabled(&self) -> bool {
        ParticipationKind::ALL
            .into_iter()
            .any(|kind| self.setting(kind) != SiteSetting::Off)
    }

    /// Whether any of B5's passage feedback kinds is switched on.
    pub fn passage_feedback_enabled(&self) -> bool {
        ParticipationKind::PASSAGE_FEEDBACK
            .into_iter()
            .any(|kind| self.setting(kind) != SiteSetting::Off)
    }

    /// Fold B5's `engagement.feedback` into the policy (ADR 0101): `true`
    /// makes each of its four kinds that `kinds` does not name
    /// `follow-comments`; `false` adds nothing. Run at load, before anything
    /// reads the policy; running it again gives the same result.
    pub(crate) fn fold_feedback(&mut self, feedback: bool) {
        self.folded.clear();
        if feedback {
            for kind in ParticipationKind::PASSAGE_FEEDBACK {
                if !self.kinds.contains_key(&kind) {
                    self.folded.insert(kind, SiteSetting::FollowComments);
                }
            }
        }
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        for (kind, setting) in &self.kinds {
            kind.accepts_site_setting(*setting)?;
        }
        self.retention
            .as_ref()
            .map_or(Ok(()), RetentionPolicy::validate)
    }
}

/// A post's own modes from its `participation:` front matter, by kind.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PostParticipation {
    modes: BTreeMap<ParticipationKind, ParticipationMode>,
}

impl PostParticipation {
    /// Read `participation:` entries written `kind: mode`, as a block or an
    /// inline list. An unknown kind or mode, a repeated kind, `comment` or
    /// `abuse-report` is an error; a kind the site has switched off is
    /// accepted and has no effect.
    pub fn parse(entries: &[String]) -> Result<Self, String> {
        let mut modes = BTreeMap::new();
        for entry in entries {
            let Some((kind, mode)) = entry.split_once(':') else {
                return Err(format!(
                    "participation entries are `kind: mode`, found `{}`",
                    entry.escape_debug()
                ));
            };
            let (kind, mode) = (kind.trim(), mode.trim().to_ascii_lowercase());
            let kind = ParticipationKind::from_id(kind)
                .ok_or_else(|| format!("unknown participation kind `{}`", kind.escape_debug()))?;
            match kind {
                ParticipationKind::Comment => {
                    return Err("set comments with `comments:`, not `participation:`".into())
                }
                ParticipationKind::AbuseReport => {
                    return Err(
                        "abuse reports are set for the whole site in openblog.json, not per post"
                            .into(),
                    )
                }
                _ => {}
            }
            let mode = ParticipationMode::from_id(&mode).ok_or_else(|| {
                format!(
                    "participation `{}` must be `open`, `locked`, or `hidden`",
                    kind.id()
                )
            })?;
            if modes.insert(kind, mode).is_some() {
                return Err(format!("participation names `{}` twice", kind.id()));
            }
        }
        Ok(Self { modes })
    }

    pub fn get(&self, kind: ParticipationKind) -> Option<ParticipationMode> {
        self.modes.get(&kind).copied()
    }

    pub fn is_empty(&self) -> bool {
        self.modes.is_empty()
    }
}

/// Whether the site has a hosted participation transport at all: hosted
/// engagement on with an endpoint. Without it every kind is hidden, and
/// pages read exactly as static pages.
pub fn transport_available(config: &SiteConfig) -> bool {
    config.engagement.enabled && !config.engagement.endpoint.trim().is_empty()
}

/// The one answer to "how does `kind` behave on this post?" that pages, the
/// published manifests and portable output all use.
///
/// - No hosted transport: hidden.
/// - Comments: hidden when `engagement.comments` is off, otherwise the post's
///   `comments:` setting, exactly as before this policy existed.
/// - Any other kind: hidden when its site setting is `off`; otherwise the
///   post's own mode, or the site default, where `follow-comments` means the
///   post's `comments:` setting.
pub fn effective_mode(
    config: &SiteConfig,
    post: &Post,
    kind: ParticipationKind,
) -> ParticipationMode {
    if !transport_available(config) {
        return ParticipationMode::Hidden;
    }
    configured_mode(config, post, kind)
}

/// Where a kind's already published notes show (ADR 0101, ADR 0083): the
/// kind's site and post mode as [`effective_mode`] resolves it, but without
/// the transport step, so a site that leaves its hosted service keeps its
/// published notes on its pages. Without a transport nothing is accepted, so
/// `open` counts as `locked`; a kind switched `off` or `hidden` still shows
/// nothing.
pub fn published_mode(
    config: &SiteConfig,
    post: &Post,
    kind: ParticipationKind,
) -> ParticipationMode {
    let mode = configured_mode(config, post, kind);
    if transport_available(config) {
        mode
    } else {
        mode.min(ParticipationMode::Locked)
    }
}

/// Steps 2 and 3 of [`effective_mode`]: the kind's mode from the site and
/// post settings alone, whether or not there is a hosted transport. A page
/// that offers a static way to take part without one (a contact link) reads
/// this, never [`effective_mode`].
pub fn configured_mode(
    config: &SiteConfig,
    post: &Post,
    kind: ParticipationKind,
) -> ParticipationMode {
    if kind == ParticipationKind::Comment {
        return if config.engagement.comments {
            post.comments.into()
        } else {
            ParticipationMode::Hidden
        };
    }
    let site = config.participation.setting(kind);
    let default = match site {
        SiteSetting::Off => return ParticipationMode::Hidden,
        SiteSetting::FollowComments => post.comments.into(),
        SiteSetting::Hidden => ParticipationMode::Hidden,
        SiteSetting::Locked => ParticipationMode::Locked,
        SiteSetting::Open => ParticipationMode::Open,
    };
    if !kind.rules().per_post {
        return default;
    }
    post.participation.get(kind).unwrap_or(default)
}

/// The public `openblog-participation.json` manifest: for each post, the
/// kinds that are not hidden and their modes. Missing means hidden. `None`
/// unless the site has a transport and switched on a kind beyond comments,
/// so every other site's output is unchanged. It names every kind the site
/// has switched on, `future-suggestion` among them (RD13): the hosted function
/// accepts a suggestion only for a page whose entry says `open`, and the
/// entry is a mode, never the suggestion or anything about a reader.
pub fn manifest(site: &Site) -> Option<String> {
    let config = &site.config;
    if !transport_available(config) || !config.participation.any_enabled() {
        return None;
    }
    let mut posts: BTreeMap<&str, BTreeMap<&str, &str>> = BTreeMap::new();
    for post in &site.posts {
        let modes: BTreeMap<&str, &str> = ParticipationKind::ALL
            .into_iter()
            .map(|kind| (kind, effective_mode(config, post, kind)))
            .filter(|(_, mode)| *mode != ParticipationMode::Hidden)
            .map(|(kind, mode)| (kind.id(), mode.id()))
            .collect();
        if !modes.is_empty() {
            posts.insert(post.url.as_str(), modes);
        }
    }
    Some(serde_json::to_string(&posts).expect("participation manifest is serializable"))
}

/// B5's `openblog-feedback.json` (ADR 0081), kept for a hosted function
/// deployed before it read `openblog-participation.json`: each post's path
/// and the most restrictive mode of B5's four kinds there, so an older
/// function never accepts a kind the policy keeps hidden or locked. `None`
/// unless the site has a transport and switched on one of the four. A site
/// that only set `engagement.feedback` gets the file B5 wrote, byte for byte.
pub fn legacy_feedback_manifest(site: &Site) -> Option<String> {
    let config = &site.config;
    if !transport_available(config) || !config.participation.passage_feedback_enabled() {
        return None;
    }
    let policies: BTreeMap<&str, &str> = site
        .posts
        .iter()
        .map(|post| {
            let mode = ParticipationKind::PASSAGE_FEEDBACK
                .into_iter()
                .map(|kind| effective_mode(config, post, kind))
                .min()
                .unwrap_or(ParticipationMode::Hidden);
            (post.url.as_str(), mode.id())
        })
        .collect();
    Some(serde_json::to_string(&policies).expect("feedback policy map is serializable"))
}

/// The passage feedback kinds a post's form offers: those of B5's four that
/// are `open` there, in the form's order (ADR 0101). Empty means no form.
pub fn offered_passage_kinds(config: &SiteConfig, post: &Post) -> Vec<ParticipationKind> {
    ParticipationKind::PASSAGE_FEEDBACK
        .into_iter()
        .filter(|kind| effective_mode(config, post, *kind) == ParticipationMode::Open)
        .collect()
}
