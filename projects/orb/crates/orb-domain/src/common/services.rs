//! The services actors use, created once at startup and shared by cloning.

use crate::Log;
use crate::feat::git::git_service::GitService;
use crate::feat::harness::Harnesses;
use crate::feat::zmx::zmx_service::ZmxService;

/// Every service the actors depend on.
#[derive(Debug, Clone)]
pub struct Services {
    /// Every harness an agent can run in.
    pub harnesses: Harnesses,
    pub git: GitService,
    /// Runs every pane's program under zmx.
    pub zmx: ZmxService,
    /// orb's log file.
    pub log: Log,
}
