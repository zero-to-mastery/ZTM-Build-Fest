//! The service behind optional update subscriptions (RD15, #232, ADR 0225).
//!
//! [`crate::continuation`] says what a subscription request is. This module
//! is the boundary a hosted service plugs into, written so that the baseline
//! is "no provider": every function that needs to send says so
//! ([`SubscribeError::Unavailable`]) and the page falls back to its ordinary
//! links, which never depended on any of this.
//!
//! - **Pluggable.** [`Mailer`] sends one plain-text [`Message`] to one
//!   address; [`Tokens`] supplies ids and tokens from a secure random source.
//!   Nothing here knows an e-mail vendor, opens a socket or reads a secret.
//! - **Double opt-in.** A request makes a *pending* record and a confirmation
//!   message; only the single-use link in it makes the record active, within
//!   [`CONFIRM_WINDOW_SECS`]. An expired one is erased by `sweep`.
//! - **No enumeration.** Every valid request gets the same answer whether the
//!   address is new, pending, active or recently asked about; a repeat sends
//!   nothing. A wrong, replayed or expired link gets one answer.
//! - **Minimal.** A message holds a title, a canonical link and the
//!   reader's own unsubscribe link, as plain text: no pixel, no tracked link,
//!   no count, no reader text, no address. At most one message a day goes to
//!   one subscription, however many updates are waiting.
//! - **Unsubscribe and deletion** need no account: any unsubscribe link the
//!   reader was ever sent (the latest [`MAX_TOKENS`]) erases the whole record.
//! - **Redaction.** `Debug` of the service or a message never shows an
//!   address or a token, and a send failure carries no text.

use std::collections::BTreeSet;

use crate::continuation::{is_token, token_digest, ContinuationError, Scope, SubscriptionRequest};
use crate::feedback_provenance::is_work_path;
use crate::future_suggestion::Contact;
use crate::scholarly_feedback::is_uuid;

/// How long a confirmation link works.
pub const CONFIRM_WINDOW_SECS: u64 = 48 * 60 * 60;
/// The soonest the same address and scope may be asked to confirm again.
pub const REQUEST_COOLDOWN_SECS: u64 = 60 * 60;
/// The least time between two update messages to one subscription.
pub const MIN_SEND_INTERVAL_SECS: u64 = 24 * 60 * 60;
/// The most waiting updates one subscription holds; the oldest are dropped.
pub const MAX_QUEUED: usize = 10;
/// The most unsubscribe links valid at once for one subscription.
pub const MAX_TOKENS: usize = 8;
/// The most records one service holds.
pub const MAX_RECORDS: usize = 10_000;
/// The longest title in a message, in characters.
pub const MAX_TITLE_CHARS: usize = 200;

/// Sends one message to one address. A site with no transport has no mailer.
pub trait Mailer {
    /// `Err` means the message did not leave; nothing about why is kept.
    fn send(&mut self, to: &str, message: &Message) -> Result<(), SendFailed>;
}

/// A send did not happen. It carries nothing a log could leak.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SendFailed;

/// Ids and tokens from a secure random source (an operating system source,
/// or the hosted database's `gen_random_bytes`), never a clock or a counter.
pub trait Tokens {
    /// A fresh lowercase UUID for a record.
    fn id(&mut self) -> String;
    /// A fresh token that passes [`is_token`].
    fn token(&mut self) -> String;
}

/// What a message is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageKind {
    Confirm,
    Update,
}

/// A plain-text message. Its text holds links with tokens in them, so `Debug`
/// shows the kind only.
#[derive(Clone, PartialEq, Eq)]
pub struct Message {
    pub kind: MessageKind,
    pub subject: String,
    pub body: String,
}

impl std::fmt::Debug for Message {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Message")
            .field("kind", &self.kind)
            .field("body", &"<redacted>")
            .finish()
    }
}

/// Where the links in a message point: the site's own HTTPS origin and the
/// paths of the hosted confirm and unsubscribe pages, which take a token as
/// the query value after the `=`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Links {
    site: String,
    confirm: String,
    unsubscribe: String,
}

impl Links {
    /// `site` is an origin such as `https://example.org`; the other two are
    /// paths like `/subscribe/confirm/?token=` and end in `token=`.
    pub fn new(site: &str, confirm: &str, unsubscribe: &str) -> Option<Self> {
        let origin_ok = site.starts_with("https://")
            && !site.ends_with('/')
            && !site.contains(['?', '#', '@', ' '])
            && site.len() <= 200;
        let path_ok = |p: &str| p.starts_with('/') && p.ends_with("token=") && !p.contains(' ');
        (origin_ok && path_ok(confirm) && path_ok(unsubscribe)).then(|| Self {
            site: site.to_string(),
            confirm: confirm.to_string(),
            unsubscribe: unsubscribe.to_string(),
        })
    }
}

/// Why a request did not start a subscription.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubscribeError {
    /// The request itself is malformed or lacks agreement.
    Invalid(ContinuationError),
    /// No provider, a send failure or a full store: the page offers links only.
    Unavailable,
}

/// The answer to every valid request, whatever the store held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Accepted;

/// One later work, as an update names it. Built from a resolved continuation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Update {
    /// The earlier page whose questions the later work takes up.
    pub from: String,
    /// The series of the later work, if any.
    pub series: Option<String>,
    /// The later work's canonical path.
    pub to: String,
    pub title: String,
}

impl Update {
    fn valid(&self) -> bool {
        is_work_path(&self.from)
            && is_work_path(&self.to)
            && self.from != self.to
            && (1..=MAX_TITLE_CHARS).contains(&self.title.chars().count())
            && !self.title.chars().any(char::is_control)
    }

    fn matches(&self, scope: &Scope) -> bool {
        match scope {
            Scope::Page(path) => *path == self.from,
            Scope::Series(slug) => self.series.as_deref() == Some(slug.as_str()),
        }
    }
}

struct Record {
    id: String,
    scope: Scope,
    contact: Contact,
    active: bool,
    requested: u64,
    confirm: Option<String>,
    unsubscribe: Vec<String>,
    last_sent: Option<u64>,
    waiting: Vec<Update>,
}

/// The records and the plug-in points. `mailer` is `None` when the site has
/// no provider.
pub struct SubscriptionService<M: Mailer, T: Tokens> {
    mailer: Option<M>,
    tokens: T,
    links: Links,
    records: Vec<Record>,
}

impl<M: Mailer, T: Tokens> std::fmt::Debug for SubscriptionService<M, T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SubscriptionService")
            .field("provider", &self.mailer.is_some())
            .field("records", &self.records.len())
            .finish()
    }
}

impl<M: Mailer, T: Tokens> SubscriptionService<M, T> {
    pub fn new(mailer: Option<M>, tokens: T, links: Links) -> Self {
        Self {
            mailer,
            tokens,
            links,
            records: Vec::new(),
        }
    }

    /// Whether a provider is plugged in; with none, tell
    /// [`crate::continuation::offer`] `false` and the page shows links only.
    pub fn available(&self) -> bool {
        self.mailer.is_some()
    }

    fn fresh_token(&mut self) -> Option<String> {
        let token = self.tokens.token();
        is_token(&token).then_some(token)
    }

    /// Take a request. A valid one always gets [`Accepted`]; whether anything
    /// was sent is not told, so the answer cannot be used to find out who is
    /// subscribed.
    pub fn subscribe(&mut self, input: &str, now: u64) -> Result<Accepted, SubscribeError> {
        let request = SubscriptionRequest::parse(input).map_err(SubscribeError::Invalid)?;
        if self.mailer.is_none() {
            return Err(SubscribeError::Unavailable);
        }
        let (scope, contact) = request.into_parts();
        let known = self.records.iter().find(|r| {
            r.scope == scope && r.contact.address().eq_ignore_ascii_case(contact.address())
        });
        if let Some(r) = known {
            // Active, or asked about lately: say the same thing, send nothing.
            if r.active || now < r.requested.saturating_add(REQUEST_COOLDOWN_SECS) {
                return Ok(Accepted);
            }
        }
        if self.records.len() >= MAX_RECORDS && known.is_none() {
            return Err(SubscribeError::Unavailable);
        }
        let (Some(confirm), Some(unsubscribe)) = (self.fresh_token(), self.fresh_token()) else {
            return Err(SubscribeError::Unavailable);
        };
        let id = self.tokens.id();
        if !is_uuid(&id) {
            return Err(SubscribeError::Unavailable);
        }
        let message = confirmation(&self.links, &confirm, &unsubscribe);
        // Only an address that was sent a link is kept.
        let sent = self
            .mailer
            .as_mut()
            .map(|m| m.send(contact.address(), &message));
        if sent != Some(Ok(())) {
            return Err(SubscribeError::Unavailable);
        }
        self.records.retain(|r| {
            !(r.scope == scope && r.contact.address().eq_ignore_ascii_case(contact.address()))
        });
        self.records.push(Record {
            id,
            scope,
            contact,
            active: false,
            requested: now,
            confirm: Some(token_digest(&confirm)),
            unsubscribe: vec![token_digest(&unsubscribe)],
            last_sent: None,
            waiting: Vec::new(),
        });
        Ok(Accepted)
    }

    /// Follow a confirmation link. The link works once and only in time; a
    /// wrong, used or late one is the same `false`.
    pub fn confirm(&mut self, token: &str, now: u64) -> bool {
        if !is_token(token) {
            return false;
        }
        let digest = token_digest(token);
        let Some(r) = self
            .records
            .iter_mut()
            .find(|r| r.confirm.as_deref() == Some(digest.as_str()))
        else {
            return false;
        };
        r.confirm = None;
        if now > r.requested.saturating_add(CONFIRM_WINDOW_SECS) {
            return false;
        }
        r.active = true;
        true
    }

    /// Follow an unsubscribe link, or delete on request: the whole record,
    /// address included, goes. Pending ones can be cancelled the same way.
    /// An unknown or already used link is `false`.
    pub fn unsubscribe(&mut self, token: &str) -> bool {
        if !is_token(token) {
            return false;
        }
        let digest = token_digest(token);
        let before = self.records.len();
        self.records.retain(|r| !r.unsubscribe.contains(&digest));
        self.records.len() < before
    }

    /// Erase every pending record whose window has passed. Run it on a
    /// schedule; it is what makes consent expire.
    pub fn sweep(&mut self, now: u64) -> usize {
        let before = self.records.len();
        self.records
            .retain(|r| r.active || now <= r.requested.saturating_add(CONFIRM_WINDOW_SECS));
        before - self.records.len()
    }

    /// Note a later work for every active subscription it matches. Nothing is
    /// sent yet; [`Self::deliver_due`] sends.
    pub fn queue(&mut self, update: &Update) -> usize {
        if !update.valid() {
            return 0;
        }
        let mut queued = 0;
        for r in self
            .records
            .iter_mut()
            .filter(|r| r.active && update.matches(&r.scope))
        {
            if r.waiting.iter().any(|w| w.to == update.to) {
                continue;
            }
            r.waiting.push(update.clone());
            if r.waiting.len() > MAX_QUEUED {
                r.waiting.remove(0);
            }
            queued += 1;
        }
        queued
    }

    /// Send one message to each active subscription with updates waiting and
    /// none sent in the last [`MIN_SEND_INTERVAL_SECS`]. A failed send keeps
    /// the updates for the next run. Returns how many messages left.
    pub fn deliver_due(&mut self, now: u64) -> usize {
        let Some(mailer) = self.mailer.as_mut() else {
            return 0;
        };
        let mut sent = 0;
        for r in self.records.iter_mut() {
            let due = r.active
                && !r.waiting.is_empty()
                && r.last_sent
                    .is_none_or(|t| now >= t.saturating_add(MIN_SEND_INTERVAL_SECS));
            if !due {
                continue;
            }
            let token = self.tokens.token();
            if !is_token(&token) {
                continue;
            }
            let message = update_message(&self.links, &r.waiting, &token);
            if mailer.send(r.contact.address(), &message).is_err() {
                continue;
            }
            r.unsubscribe.push(token_digest(&token));
            if r.unsubscribe.len() > MAX_TOKENS {
                r.unsubscribe.remove(0);
            }
            r.waiting.clear();
            r.last_sent = Some(now);
            sent += 1;
        }
        sent
    }

    /// How many records exist and how many are active: the only counts the
    /// service gives, for an operator and never a page.
    pub fn counts(&self) -> (usize, usize) {
        (
            self.records.len(),
            self.records.iter().filter(|r| r.active).count(),
        )
    }

    /// The record ids, which hold no address.
    pub fn ids(&self) -> BTreeSet<&str> {
        self.records.iter().map(|r| r.id.as_str()).collect()
    }
}

fn confirmation(links: &Links, confirm: &str, unsubscribe: &str) -> Message {
    Message {
        kind: MessageKind::Confirm,
        subject: "Confirm that you want updates".to_string(),
        body: format!(
            "Someone asked for updates when later work takes up a question on {site}. If that was you, confirm with this link within two days:\n\n{site}{c}{confirm}\n\nIf it was not you, do nothing and your address is erased. To cancel now: {site}{u}{unsubscribe}\n",
            site = links.site,
            c = links.confirm,
            u = links.unsubscribe,
        ),
    }
}

fn update_message(links: &Links, updates: &[Update], unsubscribe: &str) -> Message {
    let mut body = String::from(
        "Later work has taken up a topic you asked to follow. A link means the work takes the topic up; it does not mean anyone's question caused it or that anyone endorses it.\n\n",
    );
    for u in updates {
        body.push_str(&format!("- {}: {}{}\n", u.title, links.site, u.to));
    }
    body.push_str(&format!(
        "\nYou asked for these updates. To stop them and erase your address: {}{}{}\n",
        links.site, links.unsubscribe, unsubscribe
    ));
    Message {
        kind: MessageKind::Update,
        subject: "Later work on a topic you follow".to_string(),
        body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::continuation::SUBSCRIPTION_NOTICE;
    use std::cell::RefCell;
    use std::rc::Rc;

    type Outbox = Rc<RefCell<Vec<(String, Message)>>>;

    struct Out {
        sent: Outbox,
        fail: bool,
    }

    impl Mailer for Out {
        fn send(&mut self, to: &str, message: &Message) -> Result<(), SendFailed> {
            if self.fail {
                return Err(SendFailed);
            }
            self.sent.borrow_mut().push((to.into(), message.clone()));
            Ok(())
        }
    }

    struct Counter(u32);

    impl Tokens for Counter {
        fn id(&mut self) -> String {
            self.0 += 1;
            format!("11111111-2222-4333-8444-{:012}", self.0)
        }
        fn token(&mut self) -> String {
            self.0 += 1;
            format!("token{:040}", self.0)
        }
    }

    fn links() -> Links {
        Links::new(
            "https://example.org",
            "/subscribe/confirm/?token=",
            "/subscribe/stop/?token=",
        )
        .unwrap()
    }

    fn service(fail: bool) -> (SubscriptionService<Out, Counter>, Outbox) {
        let sent = Outbox::default();
        let out = Out {
            sent: sent.clone(),
            fail,
        };
        (
            SubscriptionService::new(Some(out), Counter(0), links()),
            sent,
        )
    }

    fn ask(address: &str, scope: &str) -> String {
        format!(r#"{{"scope":{scope},"address":"{address}","agree":true}}"#)
    }

    const PAGE: &str = r#"{"type":"page","value":"/posts/tides/"}"#;
    const SERIES: &str = r#"{"type":"series","value":"sea"}"#;

    fn token_in(message: &Message, after: &str) -> String {
        let start = message.body.find(after).unwrap() + after.len();
        message.body[start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect()
    }

    fn update(to: &str) -> Update {
        Update {
            from: "/posts/tides/".into(),
            series: Some("sea".into()),
            to: to.into(),
            title: "The Moon".into(),
        }
    }

    fn active(s: &mut SubscriptionService<Out, Counter>, sent: &Outbox, scope: &str) -> String {
        s.subscribe(&ask("a@example.org", scope), 0).unwrap();
        let m = sent.borrow().last().unwrap().1.clone();
        assert!(s.confirm(&token_in(&m, "confirm/?token="), 10));
        token_in(&m, "stop/?token=")
    }

    #[test]
    fn with_no_provider_a_request_is_unavailable_and_nothing_is_kept() {
        let mut s: SubscriptionService<Out, Counter> =
            SubscriptionService::new(None, Counter(0), links());
        assert!(!s.available());
        assert_eq!(
            s.subscribe(&ask("a@example.org", PAGE), 0),
            Err(SubscribeError::Unavailable)
        );
        assert_eq!(s.counts(), (0, 0));
        assert_eq!(s.deliver_due(0), 0);
        // A malformed request is still refused as malformed.
        assert!(matches!(
            s.subscribe("{}", 0),
            Err(SubscribeError::Invalid(_))
        ));
    }

    #[test]
    fn a_failed_send_keeps_no_address() {
        let (mut s, _) = service(true);
        assert_eq!(
            s.subscribe(&ask("a@example.org", PAGE), 0),
            Err(SubscribeError::Unavailable)
        );
        assert_eq!(s.counts(), (0, 0));
    }

    #[test]
    fn double_opt_in_nothing_is_active_until_the_link_is_followed_once() {
        let (mut s, sent) = service(false);
        s.subscribe(&ask("a@example.org", PAGE), 0).unwrap();
        assert_eq!(s.counts(), (1, 0));
        assert_eq!(sent.borrow()[0].0, "a@example.org");
        let m = sent.borrow()[0].1.clone();
        assert_eq!(m.kind, MessageKind::Confirm);
        let confirm = token_in(&m, "confirm/?token=");
        assert_eq!(s.queue(&update("/posts/moon/")), 0, "pending gets nothing");
        assert!(s.confirm(&confirm, 100));
        assert_eq!(s.counts(), (1, 1));
        assert!(!s.confirm(&confirm, 101), "a used link is replay");
    }

    #[test]
    fn consent_expires_and_a_late_link_does_nothing() {
        let (mut s, sent) = service(false);
        s.subscribe(&ask("a@example.org", PAGE), 0).unwrap();
        let confirm = token_in(&sent.borrow()[0].1, "confirm/?token=");
        assert!(!s.confirm(&confirm, CONFIRM_WINDOW_SECS + 1));
        assert_eq!(s.counts(), (1, 0));
        assert_eq!(s.sweep(CONFIRM_WINDOW_SECS + 1), 1);
        assert_eq!(s.counts(), (0, 0));

        s.subscribe(&ask("b@example.org", PAGE), 5).unwrap();
        assert_eq!(s.sweep(6), 0, "in-window pending stays");
    }

    #[test]
    fn a_request_cannot_be_used_to_find_who_is_subscribed() {
        let (mut s, sent) = service(false);
        active(&mut s, &sent, PAGE);
        let before = sent.borrow().len();
        // Already active: the same answer, and no mail.
        assert_eq!(s.subscribe(&ask("A@example.org", PAGE), 20), Ok(Accepted));
        assert_eq!(sent.borrow().len(), before);

        let (mut s2, sent2) = service(false);
        s2.subscribe(&ask("a@example.org", PAGE), 0).unwrap();
        assert_eq!(s2.subscribe(&ask("a@example.org", PAGE), 5), Ok(Accepted));
        assert_eq!(
            sent2.borrow().len(),
            1,
            "no second mail inside the cooldown"
        );
        // After the cooldown a pending request is asked again, replacing the old link.
        let first = token_in(&sent2.borrow()[0].1, "confirm/?token=");
        s2.subscribe(&ask("a@example.org", PAGE), REQUEST_COOLDOWN_SECS + 1)
            .unwrap();
        assert_eq!(sent2.borrow().len(), 2);
        assert_eq!(s2.counts(), (1, 0));
        assert!(!s2.confirm(&first, REQUEST_COOLDOWN_SECS + 2));
    }

    #[test]
    fn unsubscribe_erases_the_record_without_an_account_and_cannot_be_replayed() {
        let (mut s, sent) = service(false);
        let stop = active(&mut s, &sent, PAGE);
        assert!(!s.unsubscribe("wrong-token-wrong-token-wrong-token-1"));
        assert!(!s.unsubscribe("short"));
        assert_eq!(s.counts(), (1, 1));
        assert!(s.unsubscribe(&stop));
        assert_eq!(s.counts(), (0, 0));
        assert!(!s.unsubscribe(&stop));
        assert_eq!(s.queue(&update("/posts/moon/")), 0);
    }

    #[test]
    fn a_pending_request_can_be_cancelled_from_its_own_message() {
        let (mut s, sent) = service(false);
        s.subscribe(&ask("a@example.org", PAGE), 0).unwrap();
        let m = sent.borrow()[0].1.clone();
        assert!(s.unsubscribe(&token_in(&m, "stop/?token=")));
        assert_eq!(s.counts(), (0, 0));
    }

    #[test]
    fn updates_match_the_scope_are_minimal_and_come_at_most_once_a_day() {
        let (mut s, sent) = service(false);
        let stop = active(&mut s, &sent, SERIES);
        sent.borrow_mut().clear();
        assert_eq!(s.queue(&update("/posts/moon/")), 1);
        assert_eq!(s.queue(&update("/posts/moon/")), 0, "the same work twice");
        assert_eq!(s.queue(&update("/posts/sun/")), 1);
        let mut other = update("/posts/wind/");
        other.series = Some("air".into());
        assert_eq!(s.queue(&other), 0, "a different series");
        assert_eq!(s.deliver_due(1000), 1);
        assert_eq!(s.deliver_due(1001), 0, "nothing waiting");
        s.queue(&update("/posts/wind-two/"));
        assert_eq!(s.deliver_due(2000), 0, "less than a day later");
        assert_eq!(s.deliver_due(1000 + MIN_SEND_INTERVAL_SECS), 1);

        let (to, m) = sent.borrow()[0].clone();
        assert_eq!(to, "a@example.org");
        assert_eq!(m.kind, MessageKind::Update);
        assert!(m.body.contains("The Moon: https://example.org/posts/moon/"));
        assert!(m.body.contains("The Moon: https://example.org/posts/sun/"));
        assert!(
            !m.body.contains("a@example.org")
                && !m.body.contains('<')
                && !m.body.contains("http://")
        );
        // Each message carries a fresh link, and the first one still works.
        let newer = token_in(&m, "stop/?token=");
        assert_ne!(newer, stop);
        assert!(s.unsubscribe(&stop));
        assert_eq!(s.counts(), (0, 0));
    }

    #[test]
    fn a_failed_update_send_is_retried() {
        let (mut s, sent) = service(false);
        active(&mut s, &sent, PAGE);
        s.queue(&update("/posts/moon/"));
        if let Some(m) = s.mailer.as_mut() {
            m.fail = true;
        }
        assert_eq!(s.deliver_due(5), 0);
        if let Some(m) = s.mailer.as_mut() {
            m.fail = false;
        }
        assert_eq!(s.deliver_due(6), 1);
    }

    #[test]
    fn nothing_prints_an_address_or_a_token() {
        let (mut s, sent) = service(false);
        let stop = active(&mut s, &sent, PAGE);
        let m = sent.borrow()[0].1.clone();
        for shown in [
            format!("{s:?}"),
            format!("{m:?}"),
            format!("{:?}", SendFailed),
        ] {
            assert!(
                !shown.contains("example.org") && !shown.contains(&stop),
                "{shown}"
            );
        }
        assert!(s.ids().iter().all(|id| !id.contains('@')));
    }

    #[test]
    fn the_notice_promises_what_the_service_does() {
        assert!(
            SUBSCRIPTION_NOTICE.contains("unsubscribe") && SUBSCRIPTION_NOTICE.contains("erases")
        );
    }

    #[test]
    fn bad_links_and_tokens_are_refused() {
        assert!(Links::new("http://example.org", "/c?token=", "/u?token=").is_none());
        assert!(Links::new("https://example.org/", "/c?token=", "/u?token=").is_none());
        assert!(Links::new("https://example.org", "/c", "/u?token=").is_none());
        struct Weak;
        impl Tokens for Weak {
            fn id(&mut self) -> String {
                "11111111-2222-4333-8444-555555555555".into()
            }
            fn token(&mut self) -> String {
                "short".into()
            }
        }
        let sent = Outbox::default();
        let mut s = SubscriptionService::new(
            Some(Out {
                sent: sent.clone(),
                fail: false,
            }),
            Weak,
            links(),
        );
        assert_eq!(
            s.subscribe(&ask("a@example.org", PAGE), 0),
            Err(SubscribeError::Unavailable)
        );
        assert!(sent.borrow().is_empty());
        let mut bad = update("/posts/moon/");
        bad.title = "x\ny".into();
        assert!(!bad.valid());
    }
}
