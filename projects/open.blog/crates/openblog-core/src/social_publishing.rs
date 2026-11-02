//! Optional scheduled social publishing: the identity boundary (ADR 0293).
//!
//! Social publishing is off unless a deployer turns it on. When it is on, nothing in a browser
//! talks to Supabase: the Rust Admin server authenticates the author with its own session, then
//! calls the hosted social function with a server-held key. The hosted function owns the
//! `service_role` key and binds every row to one **site scope** taken from its own environment,
//! never from a request. The Admin user name travels only as the **social actor**, an audit
//! attribution, and is accepted only on a request that already carries the admin key.
//!
//! This module holds the pure rules both sides share, so the Rust Admin and the hosted function
//! (`netlify/lib/social-scope.mjs`) refuse the same inputs. It reads no environment, opens no
//! connection and never holds a credential.

use std::fmt;

/// The longest site scope, in bytes. Kept short so it is safe in a header, a log line and a
/// Postgres check, and identical to the check in `supabase/social.sql`.
pub const MAX_SITE_SCOPE_BYTES: usize = 80;

/// The header the Rust Admin uses to name the signed-in Admin user to the hosted function.
pub const ACTOR_HEADER: &str = "X-OpenBlog-Actor";

/// The audit actor recorded for work the scheduled worker does on its own.
pub const WORKER_ACTOR: &str = "@worker";

/// Why an identity input was refused. The text never repeats the refused value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeError {
    /// The site scope is empty, too long or has a character outside `A-Z a-z 0-9 . _ -`.
    InvalidSite,
    /// The Admin user name does not follow the Admin account rule.
    InvalidActor,
    /// A request tried to name a site. The site always comes from the server's configuration.
    SiteNotAccepted,
    /// A row came back that belongs to another site.
    OtherSite,
}

impl fmt::Display for ScopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidSite => {
                "the site scope must be 1 to 80 letters, digits, dots, hyphens or underscores and start with a letter or digit"
            }
            Self::InvalidActor => "the Admin user name is not a valid Admin account name",
            Self::SiteNotAccepted => {
                "a request cannot name a site; the server decides which site it acts for"
            }
            Self::OtherSite => "the record belongs to another site",
        })
    }
}

impl std::error::Error for ScopeError {}

/// The one site a social deployment acts for: the hosted function's `OPENBLOG_SITE_ID`, the same
/// namespace hosted engagement uses. Every social row carries it and every query filters by it.
#[derive(Clone, PartialEq, Eq)]
pub struct SiteScope(String);

impl SiteScope {
    /// Accepts `[A-Za-z0-9][A-Za-z0-9._-]{0,79}`, with nothing trimmed or changed.
    pub fn parse(value: &str) -> Result<Self, ScopeError> {
        let bytes = value.as_bytes();
        let valid = !bytes.is_empty()
            && bytes.len() <= MAX_SITE_SCOPE_BYTES
            && bytes[0].is_ascii_alphanumeric()
            && bytes
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
        if valid {
            Ok(Self(value.to_string()))
        } else {
            Err(ScopeError::InvalidSite)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The site of a request is never the request's to choose: any site the caller names, even
    /// this one, is refused, so a client cannot learn to rely on naming it.
    pub fn refuse_requested(requested: Option<&str>) -> Result<(), ScopeError> {
        match requested {
            None => Ok(()),
            Some(_) => Err(ScopeError::SiteNotAccepted),
        }
    }

    /// A defensive check on every row read back: a row from another site is an error, never
    /// shown and never acted on.
    pub fn ensure_owned(&self, row_site: &str) -> Result<(), ScopeError> {
        if row_site == self.0 {
            Ok(())
        } else {
            Err(ScopeError::OtherSite)
        }
    }
}

impl fmt::Debug for SiteScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("SiteScope").field(&self.0).finish()
    }
}

/// Who asked: an Admin account (named by the Rust Admin after its own session check), or the
/// scheduled worker. A role is decided by which server key authenticated the request, never by
/// anything the request says about itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SocialActor {
    Admin(String),
    Worker,
}

impl SocialActor {
    /// An Admin actor follows the Admin account rule (`collaboration::valid_admin_username`).
    pub fn admin(name: &str) -> Result<Self, ScopeError> {
        if crate::collaboration::valid_admin_username(name) {
            Ok(Self::Admin(name.to_string()))
        } else {
            Err(ScopeError::InvalidActor)
        }
    }

    /// The text stored as `created_by`, `connected_by` or an attempt's worker: the Admin name, or
    /// `@worker`, which no Admin account can take because `@` is outside the account rule.
    pub fn audit_name(&self) -> &str {
        match self {
            Self::Admin(name) => name,
            Self::Worker => WORKER_ACTOR,
        }
    }

    pub fn is_admin(&self) -> bool {
        matches!(self, Self::Admin(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_site_scope_is_short_plain_and_unchanged() {
        assert_eq!(
            SiteScope::parse("lantern-studios").unwrap().as_str(),
            "lantern-studios"
        );
        assert!(SiteScope::parse("a").is_ok());
        assert!(SiteScope::parse(&"a".repeat(80)).is_ok());
        for bad in [
            "",
            " lantern",
            "lantern ",
            "-lantern",
            ".lantern",
            "lan/tern",
            "lan%2ftern",
            "lantern\n",
            "λ",
            &"a".repeat(81),
        ] {
            assert_eq!(
                SiteScope::parse(bad),
                Err(ScopeError::InvalidSite),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn errors_never_repeat_the_refused_value() {
        let error = SiteScope::parse("x y sb_secret_should_not_echo").unwrap_err();
        assert!(!error.to_string().contains("sb_secret"));
        let error = SocialActor::admin("Bearer sb_secret_x").unwrap_err();
        assert!(!error.to_string().contains("sb_secret"));
    }
}
