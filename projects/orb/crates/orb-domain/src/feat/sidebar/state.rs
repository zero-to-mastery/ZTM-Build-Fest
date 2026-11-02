//! The sidebar's size and visibility, the last frame's row layout, and the
//! name box, which names a session, a new colony, a tab, a pane or an
//! agent's pane.

use crate::ids::{PaneId, ProjectId, SessionId};
use crate::{Focus, TextInput};

/// The sidebar's width in columns until the user resizes it.
pub const DEFAULT_WIDTH: u16 = 32;
/// The narrowest the sidebar gets.
pub const MIN_WIDTH: u16 = 24;
/// The widest the sidebar gets.
pub const MAX_WIDTH: u16 = 80;
/// Columns one resize moves the sidebar's edge by.
pub const STEP: u16 = 4;

/// `width` kept between [`MIN_WIDTH`] and [`MAX_WIDTH`].
#[must_use]
pub fn clamp_width(width: u16) -> u16 {
    width.clamp(MIN_WIDTH, MAX_WIDTH)
}

/// How the sidebar is laid out. The width is written by the intent handler
/// and, on restore, the sessions actor; `hidden` by the intent handler;
/// `layout` by the frontend after each draw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidebarView {
    /// Columns the sidebar takes while shown.
    pub width: u16,
    /// The sidebar is out of the way and the right-hand area takes the full
    /// width.
    pub hidden: bool,
    /// The last frame's list height and row heights.
    pub layout: SidebarLayout,
}

impl Default for SidebarView {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH,
            hidden: false,
            layout: SidebarLayout::default(),
        }
    }
}

impl SidebarView {
    /// Widens the sidebar a step, up to [`MAX_WIDTH`]; whether its width
    /// changed.
    pub fn widen(&mut self) -> bool {
        self.resize(self.width.saturating_add(STEP))
    }

    /// Narrows the sidebar a step, down to [`MIN_WIDTH`]; whether its width
    /// changed.
    pub fn narrow(&mut self) -> bool {
        self.resize(self.width.saturating_sub(STEP))
    }

    fn resize(&mut self, width: u16) -> bool {
        let width = clamp_width(width);
        let changed = width != self.width;
        self.width = width;
        changed
    }
}

/// What the name box names: a session, a new colony, a tab, a
/// pane, or an agent's pane from its sidebar row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenameTarget {
    /// The session being renamed.
    Session(SessionId),
    /// The name of a new colony in world `ProjectId`.
    NewColony(ProjectId),
    /// Tab `tab` (0-based) of `owner`'s layout.
    Tab { owner: SessionId, tab: usize },
    /// A pane of the shown layout.
    Pane(PaneId),
    /// An agent's pane, renamed from its sidebar row; the keys go back to the
    /// sidebar.
    Agent(PaneId),
    /// The name of a new session of `project`, asked right after the project
    /// pick; the keys go back to `return_to`, where `<C-g> n` was pressed.
    NewSession {
        project: ProjectId,
        return_to: Focus,
    },
}

/// The name box: what it names, and the name typed so far.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rename {
    /// What the name is for.
    pub target: RenameTarget,
    /// The name being typed, starting from the session's title, or empty
    /// for a new session.
    pub input: TextInput,
    /// `⏎` asked the sessions actor for the new session: it closes the box
    /// once the session is made, or leaves it open with its refusal.
    pub creating: bool,
}

/// How the last frame laid the sidebar's list out.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SidebarLayout {
    /// Lines the list is drawn in.
    pub rows: u16,
    /// One per sidebar row, in the sidebar's order.
    pub heights: Vec<u16>,
}
