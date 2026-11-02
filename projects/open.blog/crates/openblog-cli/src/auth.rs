//! Users, password hashing, sessions, and login throttling.
//!
//! Passwords are hashed with Argon2id (the `argon2` crate). Session and CSRF
//! tokens are 256 bits from the operating system's random source.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use argon2::password_hash::{PasswordHash, SaltString};
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use serde::{Deserialize, Serialize};

pub const MIN_PASSWORD_LEN: usize = 12;
pub const MAX_PASSWORD_LEN: usize = 256;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct UserRecord {
    pub name: String,
    pub hash: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Users {
    pub users: Vec<UserRecord>,
}

impl Users {
    pub fn load(path: &Path) -> Result<Users, String> {
        match crate::fsutil::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| format!("{} is not valid: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Users::default()),
            Err(e) => Err(format!("cannot read {}: {e}", path.display())),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())? + "\n";
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        crate::fsutil::replace_file(&tmp, path)
            .map_err(|e| format!("cannot replace {}: {e}", path.display()))
    }

    pub fn find(&self, name: &str) -> Option<&UserRecord> {
        self.users.iter().find(|u| u.name == name)
    }

    pub fn set(&mut self, name: &str, password: &str) -> Result<(), String> {
        let hash = hash_password(password)?;
        match self.users.iter_mut().find(|u| u.name == name) {
            Some(u) => u.hash = hash,
            None => self.users.push(UserRecord {
                name: name.to_string(),
                hash,
            }),
        }
        Ok(())
    }

    pub fn remove(&mut self, name: &str) -> bool {
        let before = self.users.len();
        self.users.retain(|u| u.name != name);
        self.users.len() != before
    }
}

/// Lowercase ASCII letters, digits, `_`, `.`, and `-`, at most 32 bytes. The rule lives in
/// `openblog-core` so collaboration bindings accept exactly the accounts the CLI creates.
/// `Users::load` does not re-check names, so a name hand-edited into the users file outside
/// this rule can sign in but can never be bound.
pub fn valid_username(name: &str) -> bool {
    openblog_core::collaboration::valid_admin_username(name)
}

pub fn check_password_policy(password: &str) -> Result<(), String> {
    let len = password.chars().count();
    if len < MIN_PASSWORD_LEN {
        return Err(format!(
            "password must be at least {MIN_PASSWORD_LEN} characters"
        ));
    }
    if len > MAX_PASSWORD_LEN {
        return Err(format!(
            "password must be at most {MAX_PASSWORD_LEN} characters"
        ));
    }
    Ok(())
}

pub fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf)
        .map_err(|e| format!("the operating system's random source failed: {e}"))?;
    Ok(buf)
}

/// 256 random bits as 64 hex characters.
pub fn random_token() -> Result<String, String> {
    let bytes: [u8; 32] = random_bytes()?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn hash_password(password: &str) -> Result<String, String> {
    check_password_policy(password)?;
    let salt_bytes: [u8; 16] = random_bytes()?;
    let salt = SaltString::encode_b64(&salt_bytes).map_err(|e| e.to_string())?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| format!("password hashing failed: {e}"))
}

pub fn verify_password(hash: &str, password: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// A real hash to verify against when the username does not exist, so a login
/// attempt takes about as long either way and cannot reveal valid usernames.
pub fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash_password("not-a-real-password-for-timing").unwrap_or_default())
}

/// Compare two strings without stopping at the first difference.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Clone, Debug)]
pub struct Session {
    pub user: String,
    /// The password hash the user signed in with. The session stops working
    /// the moment the user is removed or their password changes.
    pub credential: String,
    pub csrf: String,
    pub expires: Instant,
}

#[derive(Default)]
pub struct Sessions {
    map: HashMap<String, Session>,
}

const MAX_SESSIONS: usize = 200;

impl Sessions {
    pub fn create(
        &mut self,
        user: &str,
        credential: &str,
        ttl: Duration,
    ) -> Result<(String, Session), String> {
        self.purge();
        if self.map.len() >= MAX_SESSIONS {
            // Drop the session closest to expiry rather than refuse a legitimate login.
            if let Some(oldest) = self
                .map
                .iter()
                .min_by_key(|(_, s)| s.expires)
                .map(|(k, _)| k.clone())
            {
                self.map.remove(&oldest);
            }
        }
        let token = random_token()?;
        let session = Session {
            user: user.to_string(),
            credential: credential.to_string(),
            csrf: random_token()?,
            expires: Instant::now() + ttl,
        };
        self.map.insert(token.clone(), session.clone());
        Ok((token, session))
    }

    pub fn get(&mut self, token: &str) -> Option<Session> {
        let session = self.map.get(token)?.clone();
        if session.expires <= Instant::now() {
            self.map.remove(token);
            return None;
        }
        Some(session)
    }

    pub fn remove(&mut self, token: &str) {
        self.map.remove(token);
    }

    fn purge(&mut self) {
        let now = Instant::now();
        self.map.retain(|_, s| s.expires > now);
    }
}

/// Counts failed logins per key (a client address or a username) and locks the
/// key for a while after too many.
#[derive(Default)]
pub struct Throttle {
    map: HashMap<String, Entry>,
}

struct Entry {
    failures: u32,
    window_start: Instant,
    locked_until: Option<Instant>,
}

pub const MAX_FAILURES: u32 = 5;
const WINDOW: Duration = Duration::from_secs(15 * 60);
const LOCKOUT: Duration = Duration::from_secs(5 * 60);

impl Throttle {
    /// `Err(seconds)` while the key is locked out.
    pub fn check(&mut self, key: &str) -> Result<(), u64> {
        if let Some(entry) = self.map.get(key) {
            if let Some(until) = entry.locked_until {
                let now = Instant::now();
                if until > now {
                    return Err((until - now).as_secs().max(1));
                }
            }
        }
        Ok(())
    }

    pub fn fail(&mut self, key: &str) {
        let now = Instant::now();
        if self.map.len() > 5000 {
            self.map
                .retain(|_, e| now.duration_since(e.window_start) < WINDOW);
        }
        let entry = self.map.entry(key.to_string()).or_insert(Entry {
            failures: 0,
            window_start: now,
            locked_until: None,
        });
        if now.duration_since(entry.window_start) > WINDOW {
            entry.failures = 0;
            entry.window_start = now;
            entry.locked_until = None;
        }
        entry.failures += 1;
        if entry.failures >= MAX_FAILURES {
            entry.locked_until = Some(now + LOCKOUT);
            entry.failures = 0;
            entry.window_start = now;
        }
    }

    pub fn clear(&mut self, key: &str) {
        self.map.remove(key);
    }

    /// Reserve one attempt under a locking key (a client address): refuse
    /// while locked, otherwise count the attempt as a failure right away so
    /// concurrent requests cannot all slip past the limit. Call `clear` on
    /// success to refund it.
    pub fn reserve(&mut self, key: &str) -> Result<(), u64> {
        self.check(key)?;
        self.fail(key);
        Ok(())
    }

    /// Record an attempt under a delaying key (a username) and return how long
    /// to wait before verifying. The delay grows with recent failures but never
    /// locks the key, so an attacker who knows a username cannot shut its
    /// owner out; they can only make guesses slow.
    pub fn delay(&mut self, key: &str) -> Duration {
        let now = Instant::now();
        let entry = self.map.entry(key.to_string()).or_insert(Entry {
            failures: 0,
            window_start: now,
            locked_until: None,
        });
        if now.duration_since(entry.window_start) > WINDOW {
            entry.failures = 0;
            entry.window_start = now;
        }
        entry.failures = entry.failures.saturating_add(1);
        let steps = u64::from(entry.failures.saturating_sub(1).min(8));
        Duration::from_millis(steps * 400)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_verify_and_policies_hold() {
        let hash = hash_password("correct horse battery").unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password(&hash, "correct horse battery"));
        assert!(!verify_password(&hash, "wrong horse battery"));
        assert!(!verify_password("not a hash", "x"));
        assert!(hash_password("short").is_err());
        assert!(valid_username("mikey_1"));
        assert!(!valid_username("Mikey"));
        assert!(!valid_username("a/b"));
        assert!(!valid_username(""));
    }

    #[test]
    fn tokens_are_unique_hex_and_compare_in_constant_time_shape() {
        let a = random_token().unwrap();
        let b = random_token().unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(constant_time_eq(&a, &a));
        assert!(!constant_time_eq(&a, &b));
        assert!(!constant_time_eq("a", "ab"));
    }

    #[test]
    fn sessions_expire_and_can_be_revoked() {
        let mut s = Sessions::default();
        let (token, session) = s.create("mikey", "h", Duration::from_secs(60)).unwrap();
        assert_eq!(s.get(&token).unwrap().csrf, session.csrf);
        assert!(s.get("nope").is_none());
        s.remove(&token);
        assert!(s.get(&token).is_none());
        let (expired, _) = s.create("mikey", "h", Duration::from_secs(0)).unwrap();
        assert!(s.get(&expired).is_none());
    }

    #[test]
    fn throttle_locks_after_repeated_failures_and_clears_on_success() {
        let mut t = Throttle::default();
        for _ in 0..MAX_FAILURES - 1 {
            t.fail("ip:1");
            assert!(t.check("ip:1").is_ok());
        }
        t.fail("ip:1");
        assert!(t.check("ip:1").is_err());
        assert!(t.check("ip:2").is_ok());
        t.clear("ip:1");
        assert!(t.check("ip:1").is_ok());
    }

    #[test]
    fn reserve_counts_the_attempt_up_front_and_delay_never_locks() {
        let mut t = Throttle::default();
        for _ in 0..MAX_FAILURES {
            assert!(t.reserve("ip:9").is_ok());
        }
        assert!(
            t.reserve("ip:9").is_err(),
            "the fifth reservation locks before any verification happens"
        );
        assert_eq!(t.delay("user:x"), Duration::ZERO);
        assert_eq!(t.delay("user:x"), Duration::from_millis(400));
        for _ in 0..20 {
            t.delay("user:x");
        }
        assert_eq!(
            t.delay("user:x"),
            Duration::from_millis(3200),
            "delay is capped"
        );
        assert!(t.check("user:x").is_ok(), "a username is never locked out");
        t.clear("user:x");
        assert_eq!(t.delay("user:x"), Duration::ZERO);
    }

    #[test]
    fn users_file_round_trips() {
        let dir = std::env::temp_dir().join(format!("ob-users-{}", std::process::id()));
        let path = dir.join("users.json");
        let mut users = Users::default();
        users.set("mikey", "correct horse battery").unwrap();
        users.save(&path).unwrap();
        let loaded = Users::load(&path).unwrap();
        assert!(verify_password(
            &loaded.find("mikey").unwrap().hash,
            "correct horse battery"
        ));
        assert_eq!(
            Users::load(&dir.join("missing.json")).unwrap(),
            Users::default()
        );
        assert!(users.remove("mikey"));
        assert!(!users.remove("mikey"));
        let _ = fs::remove_dir_all(&dir);
    }
}
