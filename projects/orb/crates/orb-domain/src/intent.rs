//! User intents: what a key press asks orb to do.

use std::fmt;

use crate::PaneMode;
use crate::feat::layout::tree::{NavDirection, Split};
use crate::feat::picker::state::SessionFilter;
use crate::feat::sessions::state::SidebarItem;
use crate::ids::PaneId;

/// A user action produced by the keymap and applied by the
/// [`IntentHandler`](crate::IntentHandler).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
    /// Quit orb; sessions keep running.
    Quit,
    /// Move the sidebar's cursor to the row below.
    SelectNext,
    /// Move the sidebar's cursor to the row above.
    SelectPrev,
    /// Move the sidebar's cursor to the first row.
    SelectFirst,
    /// Move the sidebar's cursor to the last row.
    SelectLast,
    /// Move the sidebar's cursor down half its visible height.
    SelectHalfPageDown,
    /// Move the sidebar's cursor up half its visible height.
    SelectHalfPageUp,
    /// Select this sidebar row (a click). During a search, end it on that
    /// row as `⏎` does.
    SelectRow(SidebarItem),
    /// Hide the sidebar, giving the right side the full width, or show it
    /// again.
    ToggleSidebar,
    /// Move the focus to the pane that way; from the tab's left or right edge
    /// to the previous or next tab, wrapping. Only while the keys are in a
    /// pane.
    MoveFocus(NavDirection),
    /// Split the focused pane, the new shell taking the focus.
    SplitPane(Split),
    /// Stack a new shell with the focused pane, the new shell shown and
    /// taking the focus; outside the tab's stack, add it to that stack.
    StackPane,
    /// Add a shell to the shown tab and re-tile it by pane count unless it
    /// was changed by hand, the new shell taking the focus; while a float has
    /// the keys, open a float instead.
    AddPane,
    /// Close the focused pane; on the agent's own pane, detach the agent.
    ClosePane,
    /// Show only the focused pane over its tab, or every pane again.
    ToggleZoom,
    /// Move the focused pane to a new tab of its own and show it.
    BreakPane,
    /// Show or hide the shown session's floats; with none, open a shell float.
    /// Only while the keys are in a pane.
    ToggleFloats,
    /// Turn the focused pane into a float, or the focused float back into the
    /// shown tab. Only while the keys are in a pane.
    ToggleFloatEmbed,
    /// Pin or unpin the focused float. Only while a float has the keys.
    TogglePinFloat,
    /// Grow the focused pane, or widen the sidebar while it has the keys.
    GrowFocused,
    /// Shrink the focused pane, or narrow the sidebar while it has the keys.
    ShrinkFocused,
    /// Turn on a pane mode; only while the keys are in a pane.
    EnterPaneMode(PaneMode),
    /// Turn the pane mode off.
    ExitPaneMode,
    /// Move the focused pane's border facing `dir` out (`grow`) or in by 5%
    /// of the tab.
    ResizeFocused { dir: NavDirection, grow: bool },
    /// Swap the focused pane with its neighbour toward `dir`; the focus
    /// moves with it.
    MovePane(NavDirection),
    /// Swap the focused pane with the next (`forward`) or previous pane,
    /// wrapping; the focus moves with it.
    MovePaneInOrder { forward: bool },
    /// Open a tab with one shell, shown.
    NewTab,
    /// Close the shown tab; one holding a pane an agent runs in detaches the agent.
    CloseTab,
    /// Open the rename box for the shown tab.
    RenameTab,
    /// Open the rename box for the focused pane.
    RenamePane,
    /// Show tab N, counting from 1.
    GoToTab(usize),
    /// Re-tile the shown tab in the next swap layout that fits, wrapping;
    /// a tab changed by hand gets its own layout back first.
    NextSwapLayout,
    /// As `NextSwapLayout`, backwards.
    PreviousSwapLayout,
    /// Swap the shown tab with the one before it.
    MoveTabLeft,
    /// Swap the shown tab with the one after it.
    MoveTabRight,
    /// Focus this pane of the shown tab and move the keys there (a click).
    FocusPane(PaneId),
    /// Show this stacked pane of the shown tab below the stack's list,
    /// leaving the keys where they are (the wheel over the list).
    ShowStacked(PaneId),
    /// Move float `pane`, which has the keys, so its top-left corner is at
    /// screen cell `x`, `y`, inside the tab body (a drag of its frame).
    DragFloat { pane: PaneId, x: u16, y: u16 },
    /// Save the layout after a float's frame was dragged (the release).
    DropFloat,
    /// Attach to the selected session (un-settling a settled one), or open or
    /// close the Settled shelf on its header.
    Attach,
    /// Move the keys from a pane to the sidebar, showing it if it's hidden
    /// and keeping the panes shown.
    LeavePane,
    /// Move the keys from the sidebar into the shown session's panes.
    FocusPanes,
    /// Send Ctrl g to the focused pane's program (`<C-g> <C-g>`, since
    /// `<C-g>` alone is orb's leader).
    SendCtrlG,
    /// Move back to the previous row in the jump list.
    JumpBack,
    /// Move forward to the next row in the jump list, after a jump back.
    JumpForward,
    /// Open the project picker to make a session of that project.
    NewSession,
    /// Make a session in orb's Incognito folder, with one shell.
    NewIncognito,
    /// Open the world picker to make a colony in one.
    NewColony,
    /// Open the session picker over the agents inside the project filter,
    /// newest chat first, to jump into one.
    OpenSessionPicker,
    /// `<C-g> ,` on a colony: the session picker over its colonists' agents.
    OpenColonists,
    /// `c` in the session picker's list: show or hide colonists' agents.
    ToggleColonists,
    /// Open the worktree picker over every directory under
    /// `~/.orb/worktrees/<repo>/`, most recently used first.
    OpenWorktreePicker,
    /// Open the projects screen, listing projects in `<C-g> n` order, to
    /// start a session in one, add one or remove one.
    OpenProjects,
    /// Open the worlds screen, listing Research, Learn and the user's worlds
    /// in worlds order, to start a colony in one, add one or remove one.
    OpenWorlds,
    /// Open the search picker, which finds typed text in the prompts and
    /// replies of every agent's transcripts, newest message first.
    OpenSearch,
    /// Open the project filter picker to filter the sidebar to one project,
    /// or to all of them.
    FilterProjects,
    /// Pin or unpin the selected session.
    TogglePin,
    /// Open the rename box for the selected session, filled in with its
    /// title.
    Rename,
    /// Move the keys to the sidebar's input box to search agent titles.
    Search,
    /// Un-settle the selected session, or ask to settle it.
    ToggleSettle,
    /// Ask to delete the selected session.
    Delete,
    /// Show the selected card's agent rows, or the Settled shelf's sessions
    /// on its header (`l`).
    Unfold,
    /// Hide the selected card's agent rows, from the card or one of them, or
    /// the Settled shelf's sessions from its header or a settled session
    /// (`h`).
    Fold,
    /// Open the directory picker, over the projects or worlds screen, to add
    /// a project or a world (`a`).
    AddProject,
    /// Open the workspace picker for the selected agent before its first
    /// prompt.
    ChangeWorkspace,
    /// Open the branch picker for the selected agent.
    SwitchBranch,
    /// Type a character into the picker's filter, the rename box, or the
    /// sidebar search.
    PickerInput(char),
    /// Delete the grapheme before the cursor of the picker, the rename box, or
    /// the sidebar search.
    PickerBackspace,
    /// Delete the word before the cursor of the picker, the rename box, or
    /// the sidebar search.
    PickerDeleteWord,
    /// Move the cursor of the picker, the rename box, or the sidebar search
    /// one grapheme left.
    PickerCursorLeft,
    /// Move the cursor of the picker, the rename box, or the sidebar search
    /// one grapheme right.
    PickerCursorRight,
    /// Move the cursor of the picker, the rename box, or the sidebar search
    /// to this grapheme (a click), or to the end when the text is shorter.
    PickerCursorTo(usize),
    /// Select the picker's next item, or the sidebar search's next match.
    PickerNext,
    /// Select the picker's previous item, or the sidebar search's previous
    /// match.
    PickerPrev,
    /// Move the picker's selection half a page down.
    PickerHalfPageDown,
    /// Move the picker's selection half a page up.
    PickerHalfPageUp,
    /// Select the picker's shown row at this index (a click). A heading, a
    /// disabled row or an index past the end changes nothing.
    PickerSelectRow(usize),
    /// Select the picker's next item, stopping on the last (the wheel).
    PickerWheelNext,
    /// Select the picker's previous item, stopping on the first (the wheel).
    PickerWheelPrev,
    /// Pick the selected item: go on with the project's new session, add the
    /// directory, or apply the workspace, base, branch, model or permission
    /// mode. In the
    /// rename box, save the name. In the sidebar search, end it and keep the
    /// cursor on the match, or with no match, cancel it.
    PickerConfirm,
    /// Browse into the directory picker's selected directory.
    PickerOpen,
    /// Close the picker without picking, or the rename box without renaming.
    /// In the sidebar search, end it and put the cursor back.
    PickerCancel,
    /// Move a list-mode picker's keys into its input box (`/`).
    PickerStartSearch,
    /// Select the picker's last item (`G` in list mode).
    PickerLast,
    /// `g` in list mode: pressed twice, select the first item.
    PickerG,
    /// Ask to remove the project highlighted in the projects screen, or the
    /// world highlighted in the worlds screen, or to
    /// delete the worktree highlighted in the worktree picker, or to delete
    /// the session highlighted in the session picker (`d`).
    PickerRemove,
    /// Filter the session picker's list to `SessionFilter`, or back to all
    /// when it is already the filter (`a`/`b`/`w`/`i`/`s` in list mode).
    PickerFilter(SessionFilter),
}

/// The label the which-key popup shows for the intent.
impl fmt::Display for Intent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Quit => "quit",
            Self::SelectNext => "next session",
            Self::SelectPrev => "previous session",
            Self::SelectRow(_) | Self::PickerSelectRow(_) => "select",
            Self::MoveFocus(NavDirection::Right) => "focus right",
            Self::PickerNext | Self::PickerWheelNext => "next item",
            Self::PickerPrev | Self::PickerWheelPrev => "previous item",
            Self::ToggleSidebar | Self::LeavePane => "sidebar",
            Self::FocusPanes => "panes",
            Self::StackPane => "stack",
            Self::MoveFocus(NavDirection::Left) => "focus left",
            Self::MoveFocus(NavDirection::Up) => "focus up",
            Self::MoveFocus(NavDirection::Down) => "focus down",
            Self::SplitPane(Split::Right) => "split right",
            Self::SplitPane(Split::Down) => "split down",
            Self::AddPane => "add pane",
            Self::ClosePane => "close pane",
            Self::ToggleZoom => "zoom",
            Self::BreakPane => "break pane",
            Self::ToggleFloats => "floats",
            Self::ToggleFloatEmbed => "embed/float",
            Self::TogglePinFloat => "pin float",
            Self::GrowFocused => "grow",
            Self::ShrinkFocused => "shrink",
            Self::EnterPaneMode(PaneMode::Resize) => "resize mode",
            Self::EnterPaneMode(PaneMode::Move) => "move mode",
            Self::ExitPaneMode => "exit mode",
            Self::ResizeFocused { grow: true, .. } => "grow side",
            Self::ResizeFocused { grow: false, .. } => "shrink side",
            Self::MovePane(_) => "move pane",
            Self::MovePaneInOrder { forward: true } => "move next",
            Self::MovePaneInOrder { forward: false } => "move previous",
            Self::NewTab => "new tab",
            Self::CloseTab => "close tab",
            Self::RenameTab => "rename tab",
            Self::RenamePane => "rename pane",
            Self::GoToTab(_) => "tab",
            Self::NextSwapLayout => "next layout",
            Self::PreviousSwapLayout => "previous layout",
            Self::MoveTabLeft => "move tab left",
            Self::MoveTabRight => "move tab right",
            Self::FocusPane(_) => "focus pane",
            Self::ShowStacked(_) => "show pane",
            Self::DragFloat { .. } => "drag float",
            Self::DropFloat => "drop float",
            Self::SendCtrlG => "send ctrl g",
            Self::Attach => "attach",
            Self::JumpBack => "jump back",
            Self::JumpForward => "jump forward",
            Self::NewSession => "new session",
            Self::NewIncognito => "incognito",
            Self::NewColony => "new colony",
            Self::OpenSessionPicker => "sessions",
            Self::OpenColonists | Self::ToggleColonists => "colonists",
            Self::OpenWorktreePicker => "worktrees",
            Self::OpenProjects => "projects",
            Self::OpenWorlds => "worlds",
            Self::OpenSearch => "grep",
            Self::FilterProjects => "filter projects",
            Self::PickerHalfPageDown | Self::SelectHalfPageDown => "half page down",
            Self::PickerHalfPageUp | Self::SelectHalfPageUp => "half page up",
            Self::SelectFirst => "top",
            Self::SelectLast => "bottom",
            Self::TogglePin => "pin",
            Self::Rename => "rename",
            Self::Search | Self::PickerStartSearch => "search",
            Self::ToggleSettle => "settle",
            Self::Delete | Self::PickerBackspace => "delete",
            Self::Unfold => "open",
            Self::Fold => "close",
            Self::AddProject => "add project",
            Self::ChangeWorkspace => "workspace",
            Self::SwitchBranch => "branch",
            Self::PickerInput(_) => "type",
            Self::PickerDeleteWord => "delete word",
            Self::PickerCursorLeft => "cursor left",
            Self::PickerCursorRight => "cursor right",
            Self::PickerCursorTo(_) => "move cursor",
            Self::PickerConfirm => "pick",
            Self::PickerOpen => "open directory",
            Self::PickerCancel => "cancel",
            Self::PickerLast => "last item",
            Self::PickerG => "first item",
            Self::PickerRemove => "remove",
            Self::PickerFilter(_) => "filter",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::Intent;
    use crate::feat::layout::tree::{NavDirection, Split};
    use crate::feat::picker::state::SessionFilter;
    use crate::ids::PaneId;

    #[rstest::rstest]
    #[case(Intent::MoveFocus(NavDirection::Left), "focus left")]
    #[case(Intent::MoveFocus(NavDirection::Right), "focus right")]
    #[case(Intent::MoveFocus(NavDirection::Up), "focus up")]
    #[case(Intent::MoveFocus(NavDirection::Down), "focus down")]
    #[case(Intent::SplitPane(Split::Right), "split right")]
    #[case(Intent::SplitPane(Split::Down), "split down")]
    #[case(Intent::AddPane, "add pane")]
    #[case(Intent::ClosePane, "close pane")]
    #[case(Intent::ToggleZoom, "zoom")]
    #[case(Intent::BreakPane, "break pane")]
    #[case(Intent::GrowFocused, "grow")]
    #[case(Intent::ShrinkFocused, "shrink")]
    #[case(Intent::NewTab, "new tab")]
    #[case(Intent::CloseTab, "close tab")]
    #[case(Intent::RenameTab, "rename tab")]
    #[case(Intent::RenamePane, "rename pane")]
    #[case(Intent::GoToTab(3), "tab")]
    #[case(Intent::NextSwapLayout, "next layout")]
    #[case(Intent::PreviousSwapLayout, "previous layout")]
    #[case(Intent::MoveTabLeft, "move tab left")]
    #[case(Intent::MoveTabRight, "move tab right")]
    #[case(Intent::FocusPane(PaneId(-1)), "focus pane")]
    #[case(Intent::ShowStacked(PaneId(-1)), "show pane")]
    #[case(Intent::DragFloat { pane: PaneId(-1), x: 0, y: 0 }, "drag float")]
    #[case(Intent::DropFloat, "drop float")]
    #[case(Intent::SendCtrlG, "send ctrl g")]
    #[case(Intent::ToggleFloats, "floats")]
    #[case(Intent::ToggleFloatEmbed, "embed/float")]
    #[case(Intent::TogglePinFloat, "pin float")]
    fn layout_intents_display_their_labels(#[case] intent: Intent, #[case] expected: &str) {
        // Given / When / Then: which-key labels the layout intent.
        assert_eq!(intent.to_string(), expected, "which-key label");
    }

    #[rstest::rstest]
    #[case(Intent::OpenSessionPicker, "sessions")]
    #[case(Intent::OpenColonists, "colonists")]
    #[case(Intent::ToggleColonists, "colonists")]
    #[case(Intent::PickerFilter(SessionFilter::Blocked), "filter")]
    fn session_picker_intents_display_their_labels(#[case] intent: Intent, #[case] expected: &str) {
        // Given / When / Then: which-key labels the session picker's intents.
        assert_eq!(intent.to_string(), expected, "which-key label");
    }

    #[rstest::rstest]
    fn open_worktree_picker_displays_as_worktrees() {
        // Given / When / Then: which-key labels OpenWorktreePicker "worktrees".
        assert_eq!(
            Intent::OpenWorktreePicker.to_string(),
            "worktrees",
            "which-key label"
        );
    }

    #[rstest::rstest]
    fn open_projects_displays_as_projects() {
        // Given / When / Then: which-key labels OpenProjects "projects".
        assert_eq!(
            Intent::OpenProjects.to_string(),
            "projects",
            "which-key label"
        );
    }

    #[rstest::rstest]
    fn open_search_displays_as_grep() {
        // Given / When / Then: which-key labels OpenSearch "grep".
        assert_eq!(Intent::OpenSearch.to_string(), "grep", "which-key label");
    }

    #[rstest::rstest]
    #[case(Intent::NewColony, "new colony")]
    #[case(Intent::OpenWorlds, "worlds")]
    fn colony_keys_display_their_labels(#[case] intent: Intent, #[case] expected: &str) {
        // Given / When / Then: which-key labels the colony keys.
        assert_eq!(intent.to_string(), expected, "which-key label");
    }
}
