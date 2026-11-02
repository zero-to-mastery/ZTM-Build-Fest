//! The ids of agents, sessions, panes and projects: their rows in orb's store.

use serde::{Deserialize, Serialize};

/// Identifies an agent across launches (its row in orb's store).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AgentId(pub i64);

/// Identifies a session across launches (its row in orb's store).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub i64);

/// Identifies a pane across launches (its row in orb's store).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PaneId(pub i64);

impl PaneId {
    /// The zmx session name of a pane orb made: `orb-p<id>`.
    pub fn zmx_name(self) -> String {
        format!("orb-p{}", self.0)
    }
}

/// Identifies a project across launches (its row in orb's store).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProjectId(pub i64);
