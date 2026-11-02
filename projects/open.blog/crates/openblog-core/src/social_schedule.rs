//! Optional scheduled social publishing: the announcement model (ADR 0308).
//!
//! An **announcement** is one scheduled post that links one already-published canonical article
//! from one connected account. This module holds the pure rules the Rust Admin enforces before it
//! calls the hosted function, and that the hosted function (`netlify/lib/social-schedule.mjs`)
//! enforces again on the way into the database. Both are held to
//! `tests/fixtures/social-schedule.json`, so they accept and refuse the same inputs. It reads no
//! environment, opens no connection and never holds a credential; a refused value is never
//! repeated in an error.

use std::fmt;

use crate::config::SiteConfig;
use crate::date::DateTime;
use crate::model::{Post, Site};

/// The longest caption the schema stores, in characters (`supabase/social.sql`, `body`).
pub const MAX_CAPTION_CHARS: usize = 3000;
/// The soonest an announcement may be scheduled, so a worker is never handed a time already gone.
pub const MIN_LEAD_SECONDS: i64 = 60;
/// The furthest ahead an announcement may be scheduled: one year and a day.
pub const MAX_HORIZON_SECONDS: i64 = 366 * 86_400;
/// The longest public address stored for an announcement (`canonical_url`).
pub const MAX_URL_CHARS: usize = 2000;

/// A destination provider this release can announce to. A third provider is a code change on
/// purpose: an unsupported destination must fail explicitly, never be guessed at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    LinkedIn,
    Facebook,
}

impl Provider {
    /// Every supported destination.
    pub const ALL: [Provider; 2] = [Self::LinkedIn, Self::Facebook];

    pub fn parse(value: &str) -> Result<Self, ScheduleError> {
        match value {
            "linkedin" => Ok(Self::LinkedIn),
            "facebook" => Ok(Self::Facebook),
            _ => Err(ScheduleError::UnsupportedProvider),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::LinkedIn => "linkedin",
            Self::Facebook => "facebook",
        }
    }

    /// The caption bound for this provider. LinkedIn commentary is limited to 3,000 characters;
    /// Facebook allows far more, but the stored caption is bounded by the schema, so both stop
    /// at the lower of the two limits. The link is attached by the adapter, not typed into the
    /// caption, so it does not count against it.
    pub fn caption_limit(self) -> usize {
        match self {
            Self::LinkedIn | Self::Facebook => MAX_CAPTION_CHARS,
        }
    }
}

/// Why an announcement was refused. Every message is fixed text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleError {
    UnsupportedProvider,
    EmptyCaption,
    CaptionTooLong,
    CaptionCharacters,
    InvalidTime,
    TimeNeedsZone,
    TimeTooSoon,
    TimeTooFar,
    InvalidTimeZone,
    InvalidKey,
    PostNotPublished,
    PostScheduled,
    CanonicalElsewhere,
    UrlNotPublic,
    InvalidUrl,
    InvalidTransition,
    NotEditable,
}

impl ScheduleError {
    /// A short stable code the Admin shows and the tests assert on.
    pub fn code(self) -> &'static str {
        match self {
            Self::UnsupportedProvider => "unsupported-provider",
            Self::EmptyCaption => "caption-empty",
            Self::CaptionTooLong => "caption-too-long",
            Self::CaptionCharacters => "caption-characters",
            Self::InvalidTime => "time-invalid",
            Self::TimeNeedsZone => "time-needs-zone",
            Self::TimeTooSoon => "time-too-soon",
            Self::TimeTooFar => "time-too-far",
            Self::InvalidTimeZone => "time-zone-invalid",
            Self::InvalidKey => "key-invalid",
            Self::PostNotPublished => "post-not-published",
            Self::PostScheduled => "post-not-yet-public",
            Self::CanonicalElsewhere => "canonical-elsewhere",
            Self::UrlNotPublic => "url-not-public",
            Self::InvalidUrl => "url-invalid",
            Self::InvalidTransition => "status-transition",
            Self::NotEditable => "not-editable",
        }
    }
}

impl fmt::Display for ScheduleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::UnsupportedProvider => "That destination is not supported yet.",
            Self::EmptyCaption => "Write a caption.",
            Self::CaptionTooLong => "The caption is longer than this destination allows.",
            Self::CaptionCharacters => "The caption contains characters that cannot be posted.",
            Self::InvalidTime => "Choose a valid date and time.",
            Self::TimeNeedsZone => "The time must say which time zone it is in.",
            Self::TimeTooSoon => "Choose a time at least a minute from now.",
            Self::TimeTooFar => "Choose a time within the next year.",
            Self::InvalidTimeZone => "That is not a valid time zone name.",
            Self::InvalidKey => "The request needs a valid idempotency key.",
            Self::PostNotPublished => "Only a published post can be announced.",
            Self::PostScheduled => "This post is not public yet; schedule the announcement after it is.",
            Self::CanonicalElsewhere => {
                "This post names a canonical address on another site, so it is not announced from here."
            }
            Self::UrlNotPublic => "The site needs a public https address before it can announce a post.",
            Self::InvalidUrl => "The link is not a valid public https address.",
            Self::InvalidTransition => "That change is not allowed from the current status.",
            Self::NotEditable => "Only a scheduled announcement that no worker has claimed can be changed.",
        })
    }
}

impl std::error::Error for ScheduleError {}

/// Normalizes line endings and trims, then checks length for the provider and refuses control
/// characters other than a newline. The returned text is what is stored and sent.
pub fn check_caption(provider: Provider, caption: &str) -> Result<String, ScheduleError> {
    let text = caption.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim();
    if text.is_empty() {
        return Err(ScheduleError::EmptyCaption);
    }
    // Control characters, line and paragraph separators, byte-order marks and bidirectional
    // overrides would change what a reader sees from what the author reviewed.
    let refused = |c: char| {
        (c.is_control() && c != '\n')
            || matches!(c, '\u{2028}' | '\u{2029}' | '\u{feff}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    };
    if text.chars().any(refused) {
        return Err(ScheduleError::CaptionCharacters);
    }
    if text.chars().count() > provider.caption_limit() {
        return Err(ScheduleError::CaptionTooLong);
    }
    Ok(text.to_string())
}

/// A caption that every supported destination accepts: the Admin checks this before it knows
/// which destination the hosted function will resolve, and the hosted function then applies the
/// destination's own bound. Returns the text to send, and the tightest limit.
pub fn check_caption_for_all(caption: &str) -> Result<String, ScheduleError> {
    let mut stored = None;
    for provider in Provider::ALL {
        stored = Some(check_caption(provider, caption)?);
    }
    stored.ok_or(ScheduleError::UnsupportedProvider)
}

/// An idempotency key is 16 to 128 of `A-Z a-z 0-9 _ -` (the schema's check).
pub fn check_idempotency_key(key: &str) -> Result<(), ScheduleError> {
    let ok = (16..=128).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    ok.then_some(()).ok_or(ScheduleError::InvalidKey)
}

/// An IANA-style time zone name (`Europe/London`, `America/Argentina/Buenos_Aires`, `UTC`). The
/// shape is checked, not the tz database, which the engine does not carry: the time zone only
/// says how the author chose the time, and the stored instant is always UTC.
pub fn check_time_zone(name: &str) -> Result<(), ScheduleError> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.split('/').count() <= 3
        && name.split('/').all(|part| {
            part.starts_with(|c: char| c.is_ascii_alphabetic())
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'+'))
        });
    ok.then_some(()).ok_or(ScheduleError::InvalidTimeZone)
}

/// Reads a schedule instant. It must be a full RFC 3339 date and time that names its zone (`Z`
/// or an offset such as `+02:00`), so a time can never be read in the server's zone by accident.
/// The result is an exact UTC instant, no earlier than a minute after `now` and no later than a
/// year and a day.
pub fn parse_schedule(input: &str, now: DateTime) -> Result<DateTime, ScheduleError> {
    parse_schedule_with(input, now, true)
}

/// The same parse; `bounds: false` skips the lead and horizon checks, so a retried request whose
/// time has since passed can still be recognized by the hosted function.
pub fn parse_schedule_with(
    input: &str,
    now: DateTime,
    bounds: bool,
) -> Result<DateTime, ScheduleError> {
    let b = input.as_bytes();
    let digit = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    let is = |i: usize, c: u8| b.get(i) == Some(&c);
    let shape = b.len() >= 17
        && b.is_ascii()
        && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15]
            .into_iter()
            .all(digit)
        && is(4, b'-')
        && is(7, b'-')
        && is(10, b'T')
        && is(13, b':');
    if !shape {
        return Err(if input.len() == 10 || input.len() == 16 {
            ScheduleError::TimeNeedsZone
        } else {
            ScheduleError::InvalidTime
        });
    }
    let mut rest = &input[16..];
    if rest.len() >= 3 && rest.as_bytes()[0] == b':' {
        if !digit(17) || !digit(18) {
            return Err(ScheduleError::InvalidTime);
        }
        rest = &rest[3..];
        if let Some(fraction) = rest.strip_prefix('.') {
            let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 || digits > 9 {
                return Err(ScheduleError::InvalidTime);
            }
            rest = &fraction[digits..];
        }
    }
    match rest {
        "Z" => {}
        "" => return Err(ScheduleError::TimeNeedsZone),
        zone => {
            let zb = zone.as_bytes();
            let valid = zb.len() == 6
                && matches!(zb[0], b'+' | b'-')
                && zb[3] == b':'
                && [1, 2, 4, 5].into_iter().all(|i| zb[i].is_ascii_digit())
                && zone[1..3].parse::<u32>().is_ok_and(|h| h <= 23)
                && zone[4..6].parse::<u32>().is_ok_and(|m| m <= 59);
            if !valid {
                return Err(ScheduleError::TimeNeedsZone);
            }
        }
    }
    // Leap seconds are not an instant a queue can hold.
    if input.get(17..19) == Some("60") {
        return Err(ScheduleError::InvalidTime);
    }
    let at = DateTime::parse(input).ok_or(ScheduleError::InvalidTime)?;
    let ahead = at.unix() - now.unix();
    if !bounds {
        return Ok(at);
    }
    if ahead < MIN_LEAD_SECONDS {
        return Err(ScheduleError::TimeTooSoon);
    }
    if ahead > MAX_HORIZON_SECONDS {
        return Err(ScheduleError::TimeTooFar);
    }
    Ok(at)
}

/// The instant as it is stored and sent: UTC, to the second, with a `Z`.
pub fn utc_instant(at: DateTime) -> String {
    at.rfc3339()
}

/// Whether `url` is an address a reader on the public web could open: `https`, a real host (not a
/// bare name, an address literal or `localhost`), no credentials, query or fragment.
fn public_https(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("");
    parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query().is_none()
        && parsed.fragment().is_none()
        && matches!(parsed.host(), Some(url::Host::Domain(_)))
        && host.contains('.')
        && !host.ends_with(".localhost")
        && !host.ends_with(".local")
        && !host.ends_with(".internal")
}

/// The shape of a stored announcement link: a public `https` address whose path is the post's
/// own site-relative path (`work`), so a link can never point somewhere the post does not live.
pub fn check_canonical_url(url: &str, work: &str) -> Result<(), ScheduleError> {
    if url.len() > MAX_URL_CHARS || !url.is_ascii() || !public_https(url) {
        return Err(ScheduleError::InvalidUrl);
    }
    let path_ok = work.starts_with('/')
        && !work.starts_with("//")
        && (2..=500).contains(&work.len())
        && !work.contains(['?', '#', '\\'])
        && !work.bytes().any(|b| b < 0x20);
    let parsed = url::Url::parse(url).map_err(|_| ScheduleError::InvalidUrl)?;
    // A site hosted under a folder links `<folder><work>`; the folder is the site's, so the
    // check is that the path is exactly the post's path behind an optional plain prefix.
    let path = parsed.path();
    let prefix_ok = path
        .strip_suffix(work)
        .is_some_and(|prefix| !prefix.ends_with('/') && !prefix.contains("//"));
    if path_ok && prefix_ok {
        Ok(())
    } else {
        Err(ScheduleError::InvalidUrl)
    }
}

/// What an announcement links: the post's site-relative path and its absolute public address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Announceable {
    pub work: String,
    pub canonical_url: String,
}

/// Whether `post` may be announced now, and where. The post must be public on the production
/// site as of `now` (not a draft, not dated in the future), must not name a canonical address
/// elsewhere (a cross-posted article is announced where it lives, not from here), and the site
/// must have a public `https` address.
pub fn announceable(
    site: &Site,
    config: &SiteConfig,
    post: &Post,
    now: DateTime,
) -> Result<Announceable, ScheduleError> {
    if post.draft {
        return Err(ScheduleError::PostNotPublished);
    }
    if post.date > now || !site.is_published(post) {
        return Err(ScheduleError::PostScheduled);
    }
    let own = config.absolute(&post.url);
    if let Some(canonical) = &post.canonical {
        let canonical = canonical.trim_end_matches('/');
        if !canonical.is_empty() && canonical != own.trim_end_matches('/') {
            return Err(ScheduleError::CanonicalElsewhere);
        }
    }
    let url = own;
    if !public_https(&url) {
        return Err(ScheduleError::UrlNotPublic);
    }
    let work = post.url.clone();
    check_canonical_url(&url, &work).map_err(|_| ScheduleError::UrlNotPublic)?;
    Ok(Announceable {
        work,
        canonical_url: url,
    })
}

/// Where an announcement stands. The values are the queue's `status` column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Scheduled,
    Claimed,
    Published,
    Failed,
    Canceled,
    Unknown,
}

impl Status {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "scheduled" => Self::Scheduled,
            "claimed" => Self::Claimed,
            "published" => Self::Published,
            "failed" => Self::Failed,
            "canceled" => Self::Canceled,
            "unknown" => Self::Unknown,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::Claimed => "claimed",
            Self::Published => "published",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
            Self::Unknown => "unknown",
        }
    }

    /// Only a scheduled announcement, which no worker has claimed, can have its caption or time
    /// changed or be canceled by an author. A claimed one may already be on its way to the
    /// provider; an unknown outcome is reconciled, never edited.
    pub fn editable(self) -> bool {
        self == Self::Scheduled
    }

    /// The changes the queue allows. Authors reach only `Scheduled -> Canceled`; the rest belong
    /// to the worker stories (claim, deliver, reconcile, retry), listed here so there is one
    /// table: a claim that expires returns to scheduled, a failure may be retried by being
    /// scheduled again, and an unknown outcome resolves only to published or failed.
    pub fn can_become(self, next: Self) -> bool {
        use Status::*;
        matches!(
            (self, next),
            (Scheduled, Claimed)
                | (Scheduled, Canceled)
                | (Claimed, Published)
                | (Claimed, Failed)
                | (Claimed, Unknown)
                | (Claimed, Scheduled)
                | (Failed, Scheduled)
                | (Unknown, Published)
                | (Unknown, Failed)
        )
    }

    /// Checks an author's change of status.
    pub fn check_author_change(self, next: Self) -> Result<(), ScheduleError> {
        if !self.editable() {
            return Err(ScheduleError::NotEditable);
        }
        if next == Self::Canceled && self.can_become(next) {
            Ok(())
        } else {
            Err(ScheduleError::InvalidTransition)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime {
        DateTime::parse("2026-11-01T12:00:00Z").unwrap()
    }

    #[test]
    fn errors_never_repeat_what_was_refused() {
        let secret = "x y sb_secret_should_not_echo";
        let error = parse_schedule(secret, now()).unwrap_err();
        assert!(!error.to_string().contains("sb_secret"));
        let error = check_time_zone(secret).unwrap_err();
        assert!(!error.to_string().contains("sb_secret"));
    }

    #[test]
    fn a_schedule_is_stored_as_the_utc_instant() {
        let at = parse_schedule("2026-11-02T09:30:00+02:00", now()).unwrap();
        assert_eq!(utc_instant(at), "2026-11-02T07:30:00Z");
    }

    #[test]
    fn an_author_can_only_cancel_what_no_worker_has_claimed() {
        assert!(Status::Scheduled
            .check_author_change(Status::Canceled)
            .is_ok());
        for from in [
            Status::Claimed,
            Status::Published,
            Status::Failed,
            Status::Canceled,
            Status::Unknown,
        ] {
            assert_eq!(
                from.check_author_change(Status::Canceled),
                Err(ScheduleError::NotEditable)
            );
        }
        assert_eq!(
            Status::Scheduled.check_author_change(Status::Published),
            Err(ScheduleError::InvalidTransition)
        );
    }
}
