//! The wall clock, kept in one place so everything that depends on "now"
//! (scheduling, session expiry, new post dates) agrees.

use std::time::{SystemTime, UNIX_EPOCH};

use openblog_core::DateTime;

pub fn now() -> DateTime {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    DateTime::from_unix(secs)
}
