//! Key routing: which keys do what in each focus. Only keys the user has
//! defined are bound.
//!
//! The Alt keys (focus moves, split, close, grow and shrink, tab moves) and
//! `<C-[>`/`<C-]>` (back and forward through the jump list) come first, in
//! the sidebar and in panes, outside which-key: they must win over a pane's
//! program, and Ctrl+[ must never match a plain Esc. `<C-g>` is the
//! which-key leader in both; its popup lists only the keys that do something
//! for the selection (`<C-g> w`/`<C-g> b` not on Incognito sessions or
//! colonies, `<C-g> p`, `<C-g> <C-g>` and `<C-g> h` only in a pane,
//! `<C-g> t` only with a session selected and its `b` only in a pane, `<C-g>
//! f` and `<C-g> l` only in the sidebar); `<C-g> h` moves the keys to the
//! sidebar, `<C-g> l` into the panes, `<C-g> e` hides or shows the sidebar,
//! `<C-g> q` quits, `<C-g> c` starts a colony and `<C-g> C` opens the
//! worlds screen. The sidebar's own keys (`j`/`k`, `gg`/`G`, `<C-d>`/`<C-u>`, `⏎`,
//! `/` and `i`, `l`/`h`, `r`/`p`/`s`/`d` on a session, `r`/`d` on an agent
//! row, `l`/`h`/`⏎` but none of `r`/`p`/`s`/`d` on a colonists row) go
//! through the same keymap. Which keys are bound follows the side with
//! the keys, the row they act on and the session's kind; [`hidden`] is the
//! one rule that leaves a kind's useless keys unbound. In a pane every
//! other key goes to its program. An open picker, the rename box and
//! the sidebar search take typed characters and have their own fixed keys.
//! The projects screen and the session and worktree pickers open in list
//! mode, where letters are keys, until `/`.

use std::fmt;

use orb_domain::feat::layout::tree::{NavDirection, Split};
use orb_domain::feat::picker::state::{PickerKind, SessionFilter};
use orb_domain::feat::sessions::state::{SessionKind, SidebarItem};
use orb_domain::{AppState, Focus, Intent, PaneMode};
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui_which_key::{Keymap, WhichKeyState};

/// The which-key popup's section for a binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyCategory {
    General,
    Navigation,
    Sessions,
    Agents,
}

impl fmt::Display for KeyCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::General => "general",
            Self::Navigation => "navigation",
            Self::Sessions => "sessions",
            Self::Agents => "agents",
        })
    }
}

/// Which side has the keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Side {
    Sidebar,
    Pane,
}

/// What the keys act on: the sidebar cursor's row, or in a pane the shown
/// session (always [`Row::Session`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Row {
    /// A session's card.
    Session,
    /// An agent row under a session's card.
    Agent,
    /// A colony's colonists row.
    Colonists,
    /// No row, the settled shelf's header, or the colonists row of a
    /// session that isn't a colony.
    Empty,
}

/// Which bindings apply: the side with the keys, the row they act on, and
/// the kind of session there, whose [`hidden`] rule leaves a few keys
/// unbound. With no session the kind reads as [`SessionKind::Plain`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Scope {
    side: Side,
    row: Row,
    kind: SessionKind,
}

impl Scope {
    /// The scope for keys in `focus` over `state`: the sidebar cursor's row
    /// and its session, or in a pane the shown session. A pane focus with
    /// nothing shown doesn't last (the keys leave once no layout is shown),
    /// so it reads as a plain session's pane.
    pub(crate) fn of(focus: Focus, state: &AppState) -> Self {
        let plain = |side, row| Self {
            side,
            row,
            kind: SessionKind::Plain,
        };
        if focus == Focus::Pane {
            let kind = state.keyed_session().map_or(SessionKind::Plain, |s| s.kind);
            return Self {
                side: Side::Pane,
                row: Row::Session,
                kind,
            };
        }
        let sessions = &state.sessions;
        if let Some(SidebarItem::Colonists(id)) = sessions.cursor {
            return match sessions.session(id) {
                Some(session) if session.kind == SessionKind::Colony => Self {
                    side: Side::Sidebar,
                    row: Row::Colonists,
                    kind: SessionKind::Colony,
                },
                _ => plain(Side::Sidebar, Row::Empty),
            };
        }
        match sessions.selected_session() {
            Some(session) => Self {
                side: Side::Sidebar,
                row: match sessions.selected_agent(&state.layouts) {
                    Some(_) => Row::Agent,
                    None => Row::Session,
                },
                kind: session.kind,
            },
            None => plain(Side::Sidebar, Row::Empty),
        }
    }

    /// Every scope the keys can be in: a session's card or agent row of each
    /// kind and a pane of each, a colony's colonists row, and no session.
    fn all() -> impl Iterator<Item = Self> {
        let kinds = [
            SessionKind::Plain,
            SessionKind::Incognito,
            SessionKind::Colony,
        ];
        let at = |side, row, kind| Self { side, row, kind };
        kinds
            .into_iter()
            .flat_map(move |kind| {
                [
                    at(Side::Sidebar, Row::Session, kind),
                    at(Side::Sidebar, Row::Agent, kind),
                    at(Side::Pane, Row::Session, kind),
                ]
            })
            .chain([
                at(Side::Sidebar, Row::Colonists, SessionKind::Colony),
                at(Side::Sidebar, Row::Empty, SessionKind::Plain),
            ])
    }
}

/// The keys a kind of session leaves unbound, since they do nothing there:
/// `<C-g> ,` everywhere but a colony, `<C-g> w`/`<C-g> b` on Incognito
/// sessions and colonies, whose folders aren't a project's.
fn hidden(kind: SessionKind, intent: &Intent) -> bool {
    match kind {
        SessionKind::Plain => matches!(intent, Intent::OpenColonists),
        SessionKind::Incognito => matches!(
            intent,
            Intent::ChangeWorkspace | Intent::SwitchBranch | Intent::OpenColonists
        ),
        SessionKind::Colony => matches!(intent, Intent::ChangeWorkspace | Intent::SwitchBranch),
    }
}

/// The keymap with its current scope and pending key sequence.
pub(crate) type Keys = WhichKeyState<KeyEvent, Scope, Intent, KeyCategory>;

/// orb's which-key leader in the sidebar and in panes.
pub(crate) const LEADER: KeyEvent = KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL);

/// The sidebar and pane bindings, each group bound in the scopes its filter
/// picks, less the keys each scope's session kind hides.
#[expect(
    clippy::too_many_lines,
    reason = "one binding per key keeps the whole keymap in one place"
)]
pub(crate) fn keymap() -> Keymap<KeyEvent, Scope, Intent, KeyCategory> {
    use KeyCategory::{Agents, General, Navigation, Sessions};
    let mut keymap = Keymap::new().with_leader(LEADER);
    keymap.describe_group("<leader>", "leader");
    keymap.describe_group("<leader>p", "pane");
    keymap.describe_group("<leader>t", "tab");
    let sidebar = |s: &Scope| s.side == Side::Sidebar;
    bind(
        &mut keymap,
        sidebar,
        &[
            ("j", Intent::SelectNext, Navigation),
            ("k", Intent::SelectPrev, Navigation),
            ("gg", Intent::SelectFirst, Navigation),
            ("G", Intent::SelectLast, Navigation),
            ("<c-d>", Intent::SelectHalfPageDown, Navigation),
            ("<c-u>", Intent::SelectHalfPageUp, Navigation),
            ("<enter>", Intent::Attach, Sessions),
            ("/", Intent::Search, Navigation),
            ("i", Intent::Search, Navigation),
            ("l", Intent::Unfold, Navigation),
            ("h", Intent::Fold, Navigation),
            ("<leader>f", Intent::FilterProjects, Sessions),
            ("<leader>l", Intent::FocusPanes, Navigation),
        ],
    );
    bind(
        &mut keymap,
        |s| sidebar(s) && s.row == Row::Session,
        &[
            ("r", Intent::Rename, Agents),
            ("p", Intent::TogglePin, Agents),
            ("s", Intent::ToggleSettle, Agents),
            ("d", Intent::Delete, Agents),
        ],
    );
    bind(
        &mut keymap,
        |s| sidebar(s) && s.row == Row::Agent,
        &[("r", Intent::Rename, Agents), ("d", Intent::Delete, Agents)],
    );
    bind(
        &mut keymap,
        |_| true,
        &[
            ("<leader>q", Intent::Quit, General),
            ("<leader>e", Intent::ToggleSidebar, Navigation),
            ("<leader><space>", Intent::OpenSessionPicker, Navigation),
            ("<leader>n", Intent::NewSession, Sessions),
            ("<leader>P", Intent::OpenProjects, Sessions),
            ("<leader>i", Intent::NewIncognito, Sessions),
            ("<leader>c", Intent::NewColony, Sessions),
            ("<leader>C", Intent::OpenWorlds, Sessions),
            ("<leader>/", Intent::OpenSearch, Navigation),
            ("<leader>W", Intent::OpenWorktreePicker, Navigation),
        ],
    );
    bind(
        &mut keymap,
        |s| s.row != Row::Empty,
        &[("<leader>,", Intent::OpenColonists, Navigation)],
    );
    let session = |s: &Scope| matches!(s.row, Row::Session | Row::Agent);
    bind(
        &mut keymap,
        session,
        &[
            ("<leader>w", Intent::ChangeWorkspace, Sessions),
            ("<leader>b", Intent::SwitchBranch, Sessions),
            ("<leader>tn", Intent::NewTab, Navigation),
            ("<leader>tx", Intent::CloseTab, Navigation),
            ("<leader>tr", Intent::RenameTab, Navigation),
        ],
    );
    let tabs: Vec<(String, Intent, KeyCategory)> = (1..=9)
        .map(|n| (format!("<leader>t{n}"), Intent::GoToTab(n), Navigation))
        .collect();
    bind(&mut keymap, session, &tabs);
    bind(
        &mut keymap,
        |s| s.side == Side::Pane,
        &[
            ("<leader>h", Intent::LeavePane, Navigation),
            ("<leader>pd", Intent::SplitPane(Split::Down), Navigation),
            ("<leader>pr", Intent::SplitPane(Split::Right), Navigation),
            ("<leader>ps", Intent::StackPane, Navigation),
            ("<leader>pf", Intent::ToggleZoom, Navigation),
            ("<leader>tb", Intent::BreakPane, Navigation),
            ("<leader>px", Intent::ClosePane, Navigation),
            ("<leader>pw", Intent::ToggleFloats, Navigation),
            ("<leader>pe", Intent::ToggleFloatEmbed, Navigation),
            ("<leader>pi", Intent::TogglePinFloat, Navigation),
            ("<leader>pc", Intent::RenamePane, Navigation),
            (
                "<leader>r",
                Intent::EnterPaneMode(PaneMode::Resize),
                Navigation,
            ),
            (
                "<leader>m",
                Intent::EnterPaneMode(PaneMode::Move),
                Navigation,
            ),
            ("<leader><c-g>", Intent::SendCtrlG, Navigation),
        ],
    );
    keymap
}

/// Binds each of `keys` in every scope `within` picks, unless that scope's
/// session kind hides it.
fn bind<W, S>(
    keymap: &mut Keymap<KeyEvent, Scope, Intent, KeyCategory>,
    within: W,
    keys: &[(S, Intent, KeyCategory)],
) where
    W: Fn(&Scope) -> bool,
    S: AsRef<str>,
{
    for scope in Scope::all().filter(within) {
        for (sequence, intent, category) in keys {
            if !hidden(scope.kind, intent) {
                keymap.bind(sequence.as_ref(), intent.clone(), *category, scope);
            }
        }
    }
}

/// Feeds `key` to the keymap; returns the intent once a binding completes.
pub(crate) fn press(keys: &mut Keys, key: KeyEvent) -> Option<Intent> {
    // Bindings compare the whole event: a held key (`Repeat`) or one carrying
    // lock-state bits would never match, so keep only the code and modifiers.
    // A shifted character already carries its case (`G`), and the bindings
    // name it without SHIFT.
    let modifiers = match key.code {
        KeyCode::Char(_) => key.modifiers - KeyModifiers::SHIFT,
        _ => key.modifiers,
    };
    keys.handle_key(KeyEvent::new(key.code, modifiers))
}

/// Where a key goes in the sidebar or a pane.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Route {
    /// An Alt key or a jump key: run this intent.
    Intent(Intent),
    /// Feed it to the which-key keymap.
    Keymap,
    /// Write it to the focused pane's program.
    Forward,
}

/// Where `key` goes in the sidebar, or in a pane when `in_pane`, with a
/// which-key sequence `pending` or not: the Alt keys, then the jump keys,
/// then the keymap. In a pane only `<C-g>` and the rest of the sequence it
/// starts go to the keymap; every other key goes to its program.
pub(crate) fn route(key: KeyEvent, in_pane: bool, pending: bool) -> Route {
    match alt_route(key).or_else(|| jump_route(key)) {
        Some(intent) => Route::Intent(intent),
        None if !in_pane || pending || is_leader(key) => Route::Keymap,
        None => Route::Forward,
    }
}

/// Whether `key` is `<C-g>`, whatever its kind or lock state.
fn is_leader(key: KeyEvent) -> bool {
    (key.code, key.modifiers) == (LEADER.code, LEADER.modifiers)
}

/// The jump `key` asks for: `<C-[>` goes back through the jump list and
/// `<C-]>` forward, as kitty reports them under the disambiguate flag
/// (`CSI 91;5u`, `CSI 93;5u`). A plain Esc, which is what Ctrl+[ sends
/// without that flag, never matches; nor does the legacy `<C-]>` byte,
/// which crossterm reads as Ctrl+5.
fn jump_route(key: KeyEvent) -> Option<Intent> {
    match (key.code, key.modifiers) {
        (KeyCode::Char('['), KeyModifiers::CONTROL) => Some(Intent::JumpBack),
        (KeyCode::Char(']'), KeyModifiers::CONTROL) => Some(Intent::JumpForward),
        _ => None,
    }
}

/// The Alt key `key` asks for, in the sidebar or a pane. Shift is ignored so
/// `Alt +` matches however the terminal reports it. A terminal that sends Cmd
/// as Alt makes these Cmd keys. `None` for any other key, Alt or not.
fn alt_route(key: KeyEvent) -> Option<Intent> {
    if key.modifiers - KeyModifiers::SHIFT != KeyModifiers::ALT {
        return None;
    }
    match key.code {
        KeyCode::Char('h') | KeyCode::Left => Some(Intent::MoveFocus(NavDirection::Left)),
        KeyCode::Char('j') | KeyCode::Down => Some(Intent::MoveFocus(NavDirection::Down)),
        KeyCode::Char('k') | KeyCode::Up => Some(Intent::MoveFocus(NavDirection::Up)),
        KeyCode::Char('l') | KeyCode::Right => Some(Intent::MoveFocus(NavDirection::Right)),
        KeyCode::Char('n') => Some(Intent::AddPane),
        KeyCode::Char('x') => Some(Intent::ClosePane),
        KeyCode::Char('f') => Some(Intent::ToggleFloats),
        KeyCode::Char('+' | '=') => Some(Intent::GrowFocused),
        KeyCode::Char('-') => Some(Intent::ShrinkFocused),
        KeyCode::Char(digit @ '1'..='9') => digit.to_digit(10).map(|n| Intent::GoToTab(n as usize)),
        KeyCode::Char('[') => Some(Intent::PreviousSwapLayout),
        KeyCode::Char(']') => Some(Intent::NextSwapLayout),
        KeyCode::Char('i') => Some(Intent::MoveTabLeft),
        KeyCode::Char('o') => Some(Intent::MoveTabRight),
        _ => None,
    }
}

/// What `key` does while pane mode `mode` is on: the Alt keys and the jump
/// keys as usual, then the mode's own keys. `None` means the key does
/// nothing; it never reaches the pane, and `<C-g>` does nothing until the mode ends.
pub(crate) fn mode_route(mode: PaneMode, key: KeyEvent) -> Option<Intent> {
    alt_route(key)
        .or_else(|| jump_route(key))
        .or_else(|| mode_key(mode, key))
}

/// A pane mode's own keys. A shifted letter is matched by its case alone,
/// as `press` does.
fn mode_key(mode: PaneMode, key: KeyEvent) -> Option<Intent> {
    use NavDirection::{Down, Left, Right, Up};
    let modifiers = match key.code {
        KeyCode::Char(_) => key.modifiers - KeyModifiers::SHIFT,
        _ => key.modifiers,
    };
    if modifiers != KeyModifiers::NONE {
        return None;
    }
    let side = |dir, grow| Some(Intent::ResizeFocused { dir, grow });
    let swap = |dir| Some(Intent::MovePane(dir));
    match (mode, key.code) {
        (_, KeyCode::Esc | KeyCode::Enter) => Some(Intent::ExitPaneMode),
        (PaneMode::Resize, KeyCode::Char('h') | KeyCode::Left) => side(Left, true),
        (PaneMode::Resize, KeyCode::Char('j') | KeyCode::Down) => side(Down, true),
        (PaneMode::Resize, KeyCode::Char('k') | KeyCode::Up) => side(Up, true),
        (PaneMode::Resize, KeyCode::Char('l') | KeyCode::Right) => side(Right, true),
        (PaneMode::Resize, KeyCode::Char('H')) => side(Left, false),
        (PaneMode::Resize, KeyCode::Char('J')) => side(Down, false),
        (PaneMode::Resize, KeyCode::Char('K')) => side(Up, false),
        (PaneMode::Resize, KeyCode::Char('L')) => side(Right, false),
        (PaneMode::Resize, KeyCode::Char('+' | '=')) => Some(Intent::GrowFocused),
        (PaneMode::Resize, KeyCode::Char('-')) => Some(Intent::ShrinkFocused),
        (PaneMode::Move, KeyCode::Char('h') | KeyCode::Left) => swap(Left),
        (PaneMode::Move, KeyCode::Char('j') | KeyCode::Down) => swap(Down),
        (PaneMode::Move, KeyCode::Char('k') | KeyCode::Up) => swap(Up),
        (PaneMode::Move, KeyCode::Char('l') | KeyCode::Right) => swap(Right),
        (PaneMode::Move, KeyCode::Char('n') | KeyCode::Tab) => {
            Some(Intent::MovePaneInOrder { forward: true })
        }
        (PaneMode::Move, KeyCode::Char('p')) => Some(Intent::MovePaneInOrder { forward: false }),
        _ => None,
    }
}

/// What `key` does in an open picker; `None` when it does nothing.
pub(crate) fn picker_route(key: KeyEvent) -> Option<Intent> {
    match (key.code, key.modifiers) {
        (KeyCode::Char(c), KeyModifiers::NONE | KeyModifiers::SHIFT) => {
            Some(Intent::PickerInput(c))
        }
        (KeyCode::Backspace, KeyModifiers::NONE) => Some(Intent::PickerBackspace),
        (KeyCode::Char('w'), KeyModifiers::CONTROL) => Some(Intent::PickerDeleteWord),
        (KeyCode::Left, KeyModifiers::NONE) => Some(Intent::PickerCursorLeft),
        (KeyCode::Right, KeyModifiers::NONE) => Some(Intent::PickerCursorRight),
        (KeyCode::Down, KeyModifiers::NONE) | (KeyCode::Char('j'), KeyModifiers::CONTROL) => {
            Some(Intent::PickerNext)
        }
        (KeyCode::Up, KeyModifiers::NONE) | (KeyCode::Char('k'), KeyModifiers::CONTROL) => {
            Some(Intent::PickerPrev)
        }
        (KeyCode::Char('d'), KeyModifiers::CONTROL) => Some(Intent::PickerHalfPageDown),
        (KeyCode::Char('u'), KeyModifiers::CONTROL) => Some(Intent::PickerHalfPageUp),
        (KeyCode::Enter, KeyModifiers::NONE) => Some(Intent::PickerConfirm),
        (KeyCode::Tab, KeyModifiers::NONE) => Some(Intent::PickerOpen),
        (KeyCode::Esc, KeyModifiers::NONE) => Some(Intent::PickerCancel),
        _ => None,
    }
}

/// What `key` does in a list-mode picker of `kind` (the projects and worlds
/// screens and the session and worktree pickers until `/`); `None` when it
/// does nothing. Letters are commands here, not filter text; `a` adds a
/// project or a world in the projects or worlds screen, `a`/`b`/`w`/`i`/`s`
/// filter the session picker, and `c` shows or hides colonists' agents
/// (not in the Colonists picker).
pub(crate) fn picker_list_route(kind: &PickerKind, key: KeyEvent) -> Option<Intent> {
    match (key.code, key.modifiers) {
        (KeyCode::Char('j') | KeyCode::Down, KeyModifiers::NONE)
        | (KeyCode::Char('j'), KeyModifiers::CONTROL) => Some(Intent::PickerNext),
        (KeyCode::Char('k') | KeyCode::Up, KeyModifiers::NONE)
        | (KeyCode::Char('k'), KeyModifiers::CONTROL) => Some(Intent::PickerPrev),
        (KeyCode::Char('g'), KeyModifiers::NONE) => Some(Intent::PickerG),
        (KeyCode::Char('G'), KeyModifiers::NONE | KeyModifiers::SHIFT) => Some(Intent::PickerLast),
        (KeyCode::Char('d'), KeyModifiers::CONTROL) => Some(Intent::PickerHalfPageDown),
        (KeyCode::Char('u'), KeyModifiers::CONTROL) => Some(Intent::PickerHalfPageUp),
        (KeyCode::Char('/'), KeyModifiers::NONE | KeyModifiers::SHIFT) => {
            Some(Intent::PickerStartSearch)
        }
        (KeyCode::Char('d'), KeyModifiers::NONE) => Some(Intent::PickerRemove),
        (KeyCode::Enter, KeyModifiers::NONE) => Some(Intent::PickerConfirm),
        (KeyCode::Esc, KeyModifiers::NONE) => Some(Intent::PickerCancel),
        (KeyCode::Char('a'), KeyModifiers::NONE)
            if matches!(kind, PickerKind::ManageProjects | PickerKind::ManageWorlds) =>
        {
            Some(Intent::AddProject)
        }
        (KeyCode::Char(letter @ ('a' | 'b' | 'w' | 'i' | 's')), KeyModifiers::NONE)
            if matches!(kind, PickerKind::Sessions { .. }) =>
        {
            let filter = match letter {
                'b' => SessionFilter::Blocked,
                'w' => SessionFilter::Working,
                'i' => SessionFilter::Idle,
                's' => SessionFilter::Settled,
                _ => SessionFilter::All,
            };
            Some(Intent::PickerFilter(filter))
        }
        (KeyCode::Char('c'), KeyModifiers::NONE)
            if matches!(kind, PickerKind::Sessions { scope: None, .. }) =>
        {
            Some(Intent::ToggleColonists)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use orb_domain::feat::harness::HarnessId;
    use std::time::SystemTime;

    use crate::test_support::{layouts_for, sessions_for};
    use orb_domain::feat::sessions::state::{
        Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Session, SessionKind, Sessions,
        SidebarItem,
    };
    use orb_domain::ids::{AgentId, PaneId, ProjectId, SessionId};
    use orb_domain::{AppState, Focus, Intent, PaneMode};
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers};
    use ratatui_which_key::{Key, NodeResult};

    use super::{
        KeyCategory, Keys, LEADER, Route, Row, Scope, Side, alt_route, keymap, mode_route,
        picker_list_route, picker_route, press, route,
    };
    use orb_domain::feat::layout::tree::{NavDirection, Split};
    use orb_domain::feat::picker::state::{PickerKind, SessionFilter};

    /// The scopes by the names tests use.
    impl Scope {
        const fn at(side: Side, row: Row, kind: SessionKind) -> Self {
            Self { side, row, kind }
        }
        pub(crate) const SIDEBAR: Self = Self::at(Side::Sidebar, Row::Session, SessionKind::Plain);
        pub(crate) const SIDEBAR_INCOGNITO: Self =
            Self::at(Side::Sidebar, Row::Session, SessionKind::Incognito);
        pub(crate) const SIDEBAR_COLONY: Self =
            Self::at(Side::Sidebar, Row::Session, SessionKind::Colony);
        pub(crate) const SIDEBAR_AGENT: Self =
            Self::at(Side::Sidebar, Row::Agent, SessionKind::Plain);
        pub(crate) const SIDEBAR_AGENT_INCOGNITO: Self =
            Self::at(Side::Sidebar, Row::Agent, SessionKind::Incognito);
        pub(crate) const SIDEBAR_AGENT_COLONY: Self =
            Self::at(Side::Sidebar, Row::Agent, SessionKind::Colony);
        pub(crate) const SIDEBAR_COLONISTS: Self =
            Self::at(Side::Sidebar, Row::Colonists, SessionKind::Colony);
        pub(crate) const SIDEBAR_EMPTY: Self =
            Self::at(Side::Sidebar, Row::Empty, SessionKind::Plain);
        pub(crate) const PANE: Self = Self::at(Side::Pane, Row::Session, SessionKind::Plain);
        pub(crate) const PANE_INCOGNITO: Self =
            Self::at(Side::Pane, Row::Session, SessionKind::Incognito);
        pub(crate) const PANE_COLONY: Self =
            Self::at(Side::Pane, Row::Session, SessionKind::Colony);
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }

    #[rstest::rstest]
    #[case(key(KeyCode::Char('q')), Intent::PickerInput('q'))]
    #[case(key(KeyCode::Char('j')), Intent::PickerInput('j'))]
    #[case(key(KeyCode::Char(' ')), Intent::PickerInput(' '))]
    #[case(
        KeyEvent::new(KeyCode::Char('G'), KeyModifiers::SHIFT),
        Intent::PickerInput('G')
    )]
    #[case(ctrl('j'), Intent::PickerNext)]
    #[case(ctrl('k'), Intent::PickerPrev)]
    #[case(key(KeyCode::Down), Intent::PickerNext)]
    #[case(key(KeyCode::Up), Intent::PickerPrev)]
    #[case(ctrl('d'), Intent::PickerHalfPageDown)]
    #[case(ctrl('u'), Intent::PickerHalfPageUp)]
    #[case(ctrl('w'), Intent::PickerDeleteWord)]
    #[case(key(KeyCode::Backspace), Intent::PickerBackspace)]
    #[case(key(KeyCode::Left), Intent::PickerCursorLeft)]
    #[case(key(KeyCode::Right), Intent::PickerCursorRight)]
    #[case(key(KeyCode::Enter), Intent::PickerConfirm)]
    #[case(key(KeyCode::Tab), Intent::PickerOpen)]
    #[case(key(KeyCode::Esc), Intent::PickerCancel)]
    fn picker_keys_map_to_their_intents(#[case] pressed: KeyEvent, #[case] expected: Intent) {
        // Given / When routing the key in an open picker.
        let intent = picker_route(pressed);

        // Then it yields its intent.
        assert_eq!(
            intent.as_ref(),
            Some(&expected),
            "the key for {expected} in the picker"
        );
    }

    #[rstest::rstest]
    #[case(ctrl('x'))]
    #[case(ctrl('s'))]
    fn ctrl_x_and_ctrl_s_do_nothing_in_the_picker(#[case] pressed: KeyEvent) {
        // Given / When routing the key in an open picker.
        let intent = picker_route(pressed);

        // Then nothing happens.
        assert_eq!(intent, None, "the key should be unbound in the picker");
    }

    #[rstest::rstest]
    #[case(key(KeyCode::Char('j')), Intent::PickerNext)]
    #[case(key(KeyCode::Char('k')), Intent::PickerPrev)]
    #[case(key(KeyCode::Down), Intent::PickerNext)]
    #[case(key(KeyCode::Up), Intent::PickerPrev)]
    #[case(ctrl('j'), Intent::PickerNext)]
    #[case(ctrl('k'), Intent::PickerPrev)]
    #[case(key(KeyCode::Char('g')), Intent::PickerG)]
    #[case(
        KeyEvent::new(KeyCode::Char('G'), KeyModifiers::SHIFT),
        Intent::PickerLast
    )]
    #[case(ctrl('d'), Intent::PickerHalfPageDown)]
    #[case(ctrl('u'), Intent::PickerHalfPageUp)]
    #[case(key(KeyCode::Char('/')), Intent::PickerStartSearch)]
    #[case(key(KeyCode::Char('d')), Intent::PickerRemove)]
    #[case(key(KeyCode::Enter), Intent::PickerConfirm)]
    #[case(key(KeyCode::Esc), Intent::PickerCancel)]
    fn list_picker_keys_map_to_their_intents(#[case] pressed: KeyEvent, #[case] expected: Intent) {
        // Given / When routing the key in a list-mode picker.
        let intent = picker_list_route(&PickerKind::Worktrees, pressed);

        // Then it yields its intent.
        assert_eq!(
            intent.as_ref(),
            Some(&expected),
            "the key for {expected} in a list-mode picker"
        );
    }

    #[rstest::rstest]
    #[case('q')]
    #[case('x')]
    #[case('z')]
    fn letters_do_nothing_in_a_list_picker(#[case] letter: char) {
        // Given / When routing a letter in a list-mode picker.
        let intent = picker_list_route(&PickerKind::Worktrees, key(KeyCode::Char(letter)));

        // Then it neither filters nor acts.
        assert_eq!(
            intent, None,
            "{letter} should do nothing in a list-mode picker"
        );
    }

    #[rstest::rstest]
    fn a_adds_a_project_in_the_projects_screen() {
        // Given / When routing `a` in the projects screen's list.
        let intent = picker_list_route(&PickerKind::ManageProjects, key(KeyCode::Char('a')));

        // Then it opens the directory picker to add a project.
        assert_eq!(
            intent,
            Some(Intent::AddProject),
            "a in the projects screen should add a project"
        );
    }

    #[rstest::rstest]
    fn a_in_the_worlds_screen_adds() {
        // Given / When routing `a` in the worlds screen's list.
        let intent = picker_list_route(&PickerKind::ManageWorlds, key(KeyCode::Char('a')));

        // Then it opens the directory picker to add a world.
        assert_eq!(
            intent,
            Some(Intent::AddProject),
            "a in the worlds screen should add a world"
        );
    }

    #[rstest::rstest]
    #[case('a', SessionFilter::All)]
    #[case('b', SessionFilter::Blocked)]
    #[case('w', SessionFilter::Working)]
    #[case('i', SessionFilter::Idle)]
    #[case('s', SessionFilter::Settled)]
    fn session_list_letters_filter(#[case] letter: char, #[case] filter: SessionFilter) {
        // Given / When routing `letter` in the session picker's list.
        let intent = picker_list_route(
            &PickerKind::Sessions {
                filter: SessionFilter::All,
                colonists: false,
                scope: None,
            },
            key(KeyCode::Char(letter)),
        );

        // Then it filters the list.
        assert_eq!(
            intent,
            Some(Intent::PickerFilter(filter)),
            "{letter} should filter the session list"
        );
    }

    #[rstest::rstest]
    fn c_in_the_session_list_toggles_colonists() {
        // Given / When routing `c` in the session picker's list.
        let intent = picker_list_route(
            &PickerKind::Sessions {
                filter: SessionFilter::All,
                colonists: false,
                scope: None,
            },
            key(KeyCode::Char('c')),
        );

        // Then it shows or hides colonists.
        assert_eq!(
            intent,
            Some(Intent::ToggleColonists),
            "c should toggle colonists in the session list"
        );
    }

    #[rstest::rstest]
    fn c_in_the_colonists_picker_does_nothing() {
        // Given / When routing `c` in the Colonists picker's list.
        let intent = picker_list_route(
            &PickerKind::Sessions {
                filter: SessionFilter::All,
                colonists: false,
                scope: Some(SessionId(1)),
            },
            key(KeyCode::Char('c')),
        );

        // Then it does nothing.
        assert_eq!(intent, None, "c should do nothing in the Colonists picker");
    }

    #[rstest::rstest]
    #[case('b')]
    #[case('w')]
    #[case('i')]
    #[case('s')]
    fn filter_letters_do_nothing_in_the_worktree_list(#[case] letter: char) {
        // Given / When routing `letter` in the worktree picker's list.
        let intent = picker_list_route(&PickerKind::Worktrees, key(KeyCode::Char(letter)));

        // Then it does nothing.
        assert_eq!(
            intent, None,
            "{letter} should do nothing in the worktree list"
        );
    }

    #[rstest::rstest]
    fn ctrl_s_does_nothing_in_the_session_list() {
        // Given / When routing <C-s> in the session picker's list.
        let intent = picker_list_route(
            &PickerKind::Sessions {
                filter: SessionFilter::All,
                colonists: false,
                scope: None,
            },
            ctrl('s'),
        );

        // Then it does nothing.
        assert_eq!(intent, None, "<C-s> should do nothing in the session list");
    }

    #[rstest::rstest]
    fn a_does_nothing_in_the_worktree_list() {
        // Given / When routing `a` in the worktree picker's list.
        let intent = picker_list_route(&PickerKind::Worktrees, key(KeyCode::Char('a')));

        // Then it does nothing.
        assert_eq!(intent, None, "a should do nothing in the worktree list");
    }

    #[rstest::rstest]
    #[case(key(KeyCode::Char('j')), Intent::SelectNext)]
    #[case(key(KeyCode::Char('k')), Intent::SelectPrev)]
    #[case(key(KeyCode::Enter), Intent::Attach)]
    #[case(key(KeyCode::Char('p')), Intent::TogglePin)]
    #[case(key(KeyCode::Char('r')), Intent::Rename)]
    #[case(key(KeyCode::Char('l')), Intent::Unfold)]
    #[case(key(KeyCode::Char('h')), Intent::Fold)]
    fn sidebar_keys_map_to_their_intents(#[case] pressed: KeyEvent, #[case] expected: Intent) {
        // Given the keymap in Sidebar focus.
        let mut keys = Keys::new(keymap(), Scope::SIDEBAR);

        // When pressing the key.
        let intent = press(&mut keys, pressed);

        // Then it yields its intent.
        assert_eq!(
            intent.as_ref(),
            Some(&expected),
            "the key for {expected} in the sidebar"
        );
    }

    #[rstest::rstest]
    fn slash_and_i_search_in_every_sidebar_scope(
        #[values(Scope::SIDEBAR, Scope::SIDEBAR_EMPTY, Scope::SIDEBAR_INCOGNITO)] scope: Scope,
        #[values('/', 'i')] pressed: char,
    ) {
        // Given the keymap in a sidebar scope.
        let mut keys = Keys::new(keymap(), scope);

        // When pressing the key.
        let intent = press(&mut keys, key(KeyCode::Char(pressed)));

        // Then it starts a search.
        assert_eq!(
            intent,
            Some(Intent::Search),
            "`{pressed}` should search in {scope:?}"
        );
    }

    #[rstest::rstest]
    fn sidebar_jump_keys_map_to_their_intents(
        #[values(Scope::SIDEBAR, Scope::SIDEBAR_EMPTY)] scope: Scope,
        #[values(
            (vec![key(KeyCode::Char('g')), key(KeyCode::Char('g'))], Intent::SelectFirst),
            (vec![KeyEvent::new(KeyCode::Char('G'), KeyModifiers::SHIFT)], Intent::SelectLast),
            (vec![ctrl('d')], Intent::SelectHalfPageDown),
            (vec![ctrl('u')], Intent::SelectHalfPageUp)
        )]
        binding: (Vec<KeyEvent>, Intent),
    ) {
        // Given the keymap in a sidebar scope.
        let (pressed, expected) = binding;
        let mut keys = Keys::new(keymap(), scope);

        // When pressing the keys in order (Shift+G as kitty reports it).
        let intent = pressed
            .into_iter()
            .map(|pressed| press(&mut keys, pressed))
            .last()
            .flatten();

        // Then it yields its jump.
        assert_eq!(
            intent.as_ref(),
            Some(&expected),
            "the key for {expected} in {scope:?}"
        );
    }

    #[rstest::rstest]
    #[case(
        in_sidebar(SessionKind::Plain, Some(SidebarItem::Session(SessionId(1)))),
        Scope::SIDEBAR
    )]
    #[case(in_sidebar(SessionKind::Plain, None), Scope::SIDEBAR_EMPTY)]
    #[case(
        in_sidebar(SessionKind::Plain, Some(SidebarItem::SettledShelf)),
        Scope::SIDEBAR_EMPTY
    )]
    #[case(
        in_sidebar(SessionKind::Incognito, Some(SidebarItem::Session(SessionId(1)))),
        Scope::SIDEBAR_INCOGNITO
    )]
    #[case(
        in_sidebar(SessionKind::Colony, Some(SidebarItem::Session(SessionId(1)))),
        Scope::SIDEBAR_COLONY
    )]
    #[case(in_sidebar(SessionKind::Plain, Some(AGENT)), Scope::SIDEBAR_AGENT)]
    #[case(
        in_sidebar(SessionKind::Incognito, Some(AGENT)),
        Scope::SIDEBAR_AGENT_INCOGNITO
    )]
    #[case(
        in_sidebar(SessionKind::Colony, Some(AGENT)),
        Scope::SIDEBAR_AGENT_COLONY
    )]
    #[case(
        in_sidebar(SessionKind::Colony, Some(SidebarItem::Colonists(SessionId(1)))),
        Scope::SIDEBAR_COLONISTS
    )]
    #[case(in_pane(Some(SessionKind::Plain)), Scope::PANE)]
    #[case(in_pane(None), Scope::PANE)]
    #[case(in_pane(Some(SessionKind::Incognito)), Scope::PANE_INCOGNITO)]
    #[case(in_pane(Some(SessionKind::Colony)), Scope::PANE_COLONY)]
    fn scope_follows_focus_and_the_selection(
        #[case] keys: (Focus, AppState),
        #[case] expected: Scope,
    ) {
        // Given the keys in a side, over a row.
        let (focus, state) = keys;

        // When reading the scope.
        let scope = Scope::of(focus, &state);

        // Then it matches the side, the row and the session's kind.
        assert_eq!(scope, expected, "the scope in {focus:?}");
    }

    /// The scope with the keys in the sidebar over `sessions`.
    fn sidebar_scope(sessions: Sessions) -> Scope {
        let state = AppState {
            layouts: layouts_for(&sessions.projects),
            sessions,
            ..AppState::default()
        };
        Scope::of(Focus::Sidebar, &state)
    }

    /// One project of `kind` holding agent 1 in session 1, with the cursor
    /// on `cursor`.
    fn lone(kind: ProjectKind, cursor: SidebarItem) -> Sessions {
        let projects = vec![Project {
            id: ProjectId(1),
            title: "orb".into(),
            root: "/orb".into(),
            created_at: SystemTime::UNIX_EPOCH,
            removed: false,
            repo: true,
            agents: vec![Agent {
                last_session: None,
                harness: HarnessId::new("claude"),
                id: AgentId(1),
                title: None,
                cwd: "/orb".into(),
                transcript: None,
                status: AgentStatus::Idle,
                turn_started_at: None,
                pane: Some(PaneLaunch {
                    pane: PaneId(1),
                    session: SessionId(1),
                }),
                branch: None,
                created_at: SystemTime::UNIX_EPOCH,
                last_activity_at: SystemTime::UNIX_EPOCH,
                unseen: false,
                model: None,
            }],
            kind,
        }];
        Sessions {
            sessions: sessions_for(&projects),
            projects,
            cursor: Some(cursor),
            ..Sessions::default()
        }
    }

    #[rstest::rstest]
    #[case::normal_session(
        ProjectKind::Normal,
        SidebarItem::Session(SessionId(1)),
        Scope::SIDEBAR
    )]
    #[case::incognito_session(
        ProjectKind::Incognito,
        SidebarItem::Session(SessionId(1)),
        Scope::SIDEBAR_INCOGNITO
    )]
    #[case::normal_agent(
        ProjectKind::Normal,
        SidebarItem::Agent { session: SessionId(1), pane: PaneId(1) },
        Scope::SIDEBAR_AGENT
    )]
    #[case::incognito_agent(
        ProjectKind::Incognito,
        SidebarItem::Agent { session: SessionId(1), pane: PaneId(1) },
        Scope::SIDEBAR_AGENT_INCOGNITO
    )]
    fn selection_follows_the_lone_rows_project_kind(
        #[case] kind: ProjectKind,
        #[case] cursor: SidebarItem,
        #[case] expected: Scope,
    ) {
        // Given the cursor on a session.
        let sessions = lone(kind, cursor);

        // When reading the scope.
        let selection = sidebar_scope(sessions);

        // Then it follows the project's kind.
        assert_eq!(
            selection, expected,
            "the selection on {cursor:?} in a {kind:?} project"
        );
    }

    #[rstest::rstest]
    #[case::colony(SidebarItem::Session(SessionId(1)), Scope::SIDEBAR_COLONY)]
    #[case::colony_agent(
        SidebarItem::Agent { session: SessionId(1), pane: PaneId(1) },
        Scope::SIDEBAR_AGENT_COLONY
    )]
    fn selection_on_a_colony_is_a_colony(#[case] cursor: SidebarItem, #[case] expected: Scope) {
        // Given the cursor on a colony in a shared world.
        let mut sessions = lone(ProjectKind::SharedWorld, cursor);
        for session in &mut sessions.sessions {
            session.kind = SessionKind::Colony;
        }

        // When reading the scope.
        let selection = sidebar_scope(sessions);

        // Then it is the colony's.
        assert_eq!(selection, expected, "the selection on {cursor:?}");
    }

    #[rstest::rstest]
    #[case::colony(SessionKind::Colony, Scope::SIDEBAR_COLONISTS)]
    #[case::other(SessionKind::Plain, Scope::SIDEBAR_EMPTY)]
    fn selection_on_a_colonists_row(#[case] kind: SessionKind, #[case] expected: Scope) {
        // Given the cursor on session 1's colonists row.
        let mut sessions = lone(
            ProjectKind::SharedWorld,
            SidebarItem::Colonists(SessionId(1)),
        );
        for session in &mut sessions.sessions {
            session.kind = kind;
        }

        // When reading the scope.
        let selection = sidebar_scope(sessions);

        // Then it is a colony's colonists row only when 1 is a colony.
        assert_eq!(
            selection, expected,
            "the selection on a {kind:?}'s colonists row"
        );
    }

    #[rstest::rstest]
    fn colonists_row_leaves_r_p_s_d_unbound(
        #[values(Scope::SIDEBAR_COLONISTS, Scope::SIDEBAR_EMPTY)] scope: Scope,
        #[values('r', 'p', 's', 'd')] pressed: char,
    ) {
        // Given the keymap on a colonists row.
        let mut keys = Keys::new(keymap(), scope);

        // When pressing the key.
        let intent = press(&mut keys, key(KeyCode::Char(pressed)));

        // Then nothing happens and no sequence starts.
        assert_eq!(
            (intent, keys.is_pending()),
            (None, false),
            "`{pressed}` should do nothing in {scope:?}"
        );
    }

    #[rstest::rstest]
    fn colony_leaves_leader_w_unbound() {
        // Given a colony in a shared world selected in the sidebar.
        let mut sessions = lone(ProjectKind::SharedWorld, SidebarItem::Session(SessionId(1)));
        for session in &mut sessions.sessions {
            session.kind = SessionKind::Colony;
        }
        let mut keys = Keys::new(keymap(), sidebar_scope(sessions));
        press(&mut keys, LEADER);

        // When pressing `w`.
        let intent = press(&mut keys, key(KeyCode::Char('w')));

        // Then nothing happens and no sequence is left waiting.
        assert_eq!(
            (intent, keys.is_pending()),
            (None, false),
            "<C-g> w should do nothing on a colony"
        );
    }

    #[rstest::rstest]
    fn pane_keys_follow_the_shown_session_not_the_cursor() {
        // Given a colony shown in the panes while the sidebar cursor sits on
        // a plain session.
        let state = {
            let mut sessions = lone(ProjectKind::Normal, SidebarItem::Session(SessionId(2)));
            let plain: Vec<Session> = sessions
                .sessions
                .iter()
                .map(|session| Session {
                    id: SessionId(2),
                    ..session.clone()
                })
                .collect();
            for session in &mut sessions.sessions {
                session.kind = SessionKind::Colony;
            }
            sessions.sessions.extend(plain);
            sessions.active = Some(SessionId(1));
            AppState {
                focus: Focus::Pane,
                layouts: layouts_for(&sessions.projects),
                attached: [SessionId(1)].into(),
                sessions,
                ..AppState::default()
            }
        };
        let mut keys = Keys::new(keymap(), Scope::of(Focus::Pane, &state));
        press(&mut keys, LEADER);

        // When pressing `,` in the pane.
        let intent = press(&mut keys, key(KeyCode::Char(',')));

        // Then the shown colony's colonists open.
        assert_eq!(
            intent,
            Some(Intent::OpenColonists),
            "<C-g> , in a colony's pane should open its colonists"
        );
    }

    #[rstest::rstest]
    fn agent_rows_leave_p_and_s_unbound(
        #[values(Scope::SIDEBAR_AGENT, Scope::SIDEBAR_AGENT_INCOGNITO)] scope: Scope,
        #[values('p', 's')] pressed: char,
    ) {
        // Given the keymap on an agent row.
        let mut keys = Keys::new(keymap(), scope);

        // When pressing the key.
        let intent = press(&mut keys, key(KeyCode::Char(pressed)));

        // Then nothing happens and no sequence starts.
        assert_eq!(
            (intent, keys.is_pending()),
            (None, false),
            "`{pressed}` should do nothing in {scope:?}"
        );
    }

    #[rstest::rstest]
    fn agent_row_keys_map_to_their_intents(
        #[values(Scope::SIDEBAR_AGENT, Scope::SIDEBAR_AGENT_INCOGNITO)] scope: Scope,
        #[values(
            (KeyCode::Char('r'), Intent::Rename),
            (KeyCode::Char('d'), Intent::Delete),
            (KeyCode::Char('j'), Intent::SelectNext),
            (KeyCode::Enter, Intent::Attach)
        )]
        binding: (KeyCode, Intent),
    ) {
        // Given the keymap on an agent row.
        let (pressed, expected) = binding;
        let mut keys = Keys::new(keymap(), scope);

        // When pressing the key.
        let intent = press(&mut keys, key(pressed));

        // Then it yields its intent.
        assert_eq!(
            intent.as_ref(),
            Some(&expected),
            "the key for {expected} in {scope:?}"
        );
    }

    #[rstest::rstest]
    fn n_is_unbound_in_the_sidebar(#[values(Scope::SIDEBAR, Scope::SIDEBAR_EMPTY)] scope: Scope) {
        // Given the keymap in the sidebar.
        let mut keys = Keys::new(keymap(), scope);

        // When pressing `n`.
        let intent = press(&mut keys, key(KeyCode::Char('n')));

        // Then nothing happens.
        assert_eq!(intent, None, "n in {scope:?}");
    }

    /// The keys the popup lists in `scope` after `<C-g>` and `then`, as
    /// which-key names them, sorted.
    fn leader_popup(scope: Scope, then: &[KeyEvent]) -> Vec<String> {
        let mut keys: Vec<String> = keymap()
            .get_children_at_path(&[&[LEADER], then].concat(), &scope)
            .unwrap_or_default()
            .into_iter()
            .map(|(key, _)| key.display())
            .collect();
        keys.sort_unstable();
        keys
    }

    /// Every key sequence bound in `scope` with its intent, sorted by sequence.
    fn bindings(scope: Scope) -> Vec<(Vec<KeyEvent>, Intent)> {
        let keymap = keymap();
        let mut paths: Vec<Vec<KeyEvent>> = keymap
            .get_children_at_path(&[], &scope)
            .unwrap_or_default()
            .into_iter()
            .map(|(key, _)| vec![key])
            .collect();
        let mut found = vec![];
        while let Some(path) = paths.pop() {
            match keymap.navigate(&path, &scope) {
                Some(NodeResult::Leaf { action }) => found.push((path, action)),
                Some(NodeResult::Branch { children }) => paths.extend(
                    children
                        .into_iter()
                        .map(|child| [path.clone(), vec![child.key]].concat()),
                ),
                None => {}
            }
        }
        found.sort_by_key(|(path, _)| format!("{path:?}"));
        found
    }

    /// Every key sequence bound for the sidebar and pane cases below: a
    /// `## <case>` header, then one sorted line per key.
    const GOLDEN: &str = include_str!("keymap/bindings.txt");

    /// What `scope` binds, one sorted line per key: `<keys> -> <intent>:
    /// <popup text>` for a binding and `<keys> +<popup text>` for a group,
    /// keys as which-key names them.
    fn golden_lines(scope: Scope) -> String {
        let keymap = keymap();
        let mut lines = vec![];
        let mut paths: Vec<Vec<KeyEvent>> = vec![vec![]];
        while let Some(path) = paths.pop() {
            for (child, desc) in keymap
                .get_children_at_path(&path, &scope)
                .unwrap_or_default()
            {
                let full = [path.clone(), vec![child]].concat();
                let keys = full.iter().map(Key::display).collect::<Vec<_>>().join(" ");
                match keymap.navigate(&full, &scope) {
                    Some(NodeResult::Leaf { action }) => {
                        lines.push(format!("{keys} -> {action:?}: {desc}"));
                    }
                    Some(NodeResult::Branch { .. }) => {
                        lines.push(format!("{keys} +{desc}"));
                        paths.push(full);
                    }
                    None => {}
                }
            }
        }
        lines.sort();
        lines.join("\n")
    }

    /// Session 1 of `lone` as `kind`, with the keys in the sidebar and its
    /// cursor on `cursor`.
    fn in_sidebar(kind: SessionKind, cursor: Option<SidebarItem>) -> (Focus, AppState) {
        let project = match kind {
            SessionKind::Plain => ProjectKind::Normal,
            SessionKind::Incognito => ProjectKind::Incognito,
            SessionKind::Colony => ProjectKind::SharedWorld,
        };
        let mut sessions = lone(project, SidebarItem::Session(SessionId(1)));
        sessions.cursor = cursor;
        for session in &mut sessions.sessions {
            session.kind = kind;
        }
        let state = AppState {
            layouts: layouts_for(&sessions.projects),
            sessions,
            ..AppState::default()
        };
        (Focus::Sidebar, state)
    }

    /// The keys in a pane of session 1 as `kind`, or with no session shown.
    fn in_pane(kind: Option<SessionKind>) -> (Focus, AppState) {
        let (_, mut state) = in_sidebar(
            kind.unwrap_or(SessionKind::Plain),
            Some(SidebarItem::Session(SessionId(1))),
        );
        state.focus = Focus::Pane;
        if kind.is_some() {
            state.sessions.active = Some(SessionId(1));
            state.attached = [SessionId(1)].into();
        }
        (Focus::Pane, state)
    }

    const AGENT: SidebarItem = SidebarItem::Agent {
        session: SessionId(1),
        pane: PaneId(1),
    };

    #[rstest::rstest]
    #[case(
        "sidebar on a plain session",
        in_sidebar(SessionKind::Plain, Some(SidebarItem::Session(SessionId(1))))
    )]
    #[case(
        "sidebar on an Incognito session",
        in_sidebar(SessionKind::Incognito, Some(SidebarItem::Session(SessionId(1))))
    )]
    #[case(
        "sidebar on a colony",
        in_sidebar(SessionKind::Colony, Some(SidebarItem::Session(SessionId(1))))
    )]
    #[case(
        "sidebar on a plain session's agent row",
        in_sidebar(SessionKind::Plain, Some(AGENT))
    )]
    #[case(
        "sidebar on an Incognito session's agent row",
        in_sidebar(SessionKind::Incognito, Some(AGENT))
    )]
    #[case(
        "sidebar on a colony's agent row",
        in_sidebar(SessionKind::Colony, Some(AGENT))
    )]
    #[case(
        "sidebar on a colony's colonists row",
        in_sidebar(SessionKind::Colony, Some(SidebarItem::Colonists(SessionId(1))))
    )]
    #[case(
        "sidebar on a plain session's colonists row",
        in_sidebar(SessionKind::Plain, Some(SidebarItem::Colonists(SessionId(1))))
    )]
    #[case("sidebar on nothing", in_sidebar(SessionKind::Plain, None))]
    #[case(
        "sidebar on the settled shelf header",
        in_sidebar(SessionKind::Plain, Some(SidebarItem::SettledShelf))
    )]
    #[case("pane of a plain session", in_pane(Some(SessionKind::Plain)))]
    #[case("pane of an Incognito session", in_pane(Some(SessionKind::Incognito)))]
    #[case("pane of a colony", in_pane(Some(SessionKind::Colony)))]
    #[case("pane with nothing shown", in_pane(None))]
    fn every_scope_keeps_its_bindings(#[case] case: &str, #[case] keys: (Focus, AppState)) {
        // Given the keys in a side, on a row, of a kind of session.
        let (focus, state) = keys;
        let expected = GOLDEN
            .split("## ")
            .find_map(|section| section.strip_prefix(case)?.strip_prefix('\n'))
            .map(str::trim_end);

        // When listing what the scope there binds.
        let found = golden_lines(Scope::of(focus, &state));

        // Then it is the case's section of bindings.txt, line for line.
        assert_eq!(Some(found.as_str()), expected, "the bindings {case}");
    }

    #[rstest::rstest]
    #[case(vec![key(KeyCode::Char('p'))])]
    #[case(vec![key(KeyCode::Char('s'))])]
    #[case(vec![key(KeyCode::Char('r'))])]
    fn session_keys_are_unbound_with_nothing_selected(#[case] pressed: Vec<KeyEvent>) {
        // Given the keymap in the sidebar with no session selected.
        let mut keys = Keys::new(keymap(), Scope::SIDEBAR_EMPTY);

        // When pressing `p`, `s` or `r`.
        let intents: Vec<Option<Intent>> = pressed
            .into_iter()
            .map(|pressed| press(&mut keys, pressed))
            .collect();

        // Then nothing happens.
        assert!(
            intents.iter().all(Option::is_none),
            "a session key did something with nothing selected: {intents:?}"
        );
    }

    #[rstest::rstest]
    fn r_is_unbound_on_the_settled_header_or_no_row() {
        // Given the keymap in the sidebar with no session selected.
        let mut keys = Keys::new(keymap(), Scope::SIDEBAR_EMPTY);

        // When pressing `r`.
        let intent = press(&mut keys, key(KeyCode::Char('r')));

        // Then nothing happens.
        assert_eq!(intent, None, "only an agent can be renamed");
    }

    #[rstest::rstest]
    #[case('s', Intent::ToggleSettle)]
    #[case('d', Intent::Delete)]
    fn sidebar_agent_key_yields_its_intent(#[case] c: char, #[case] expected: Intent) {
        // Given the keymap in Sidebar focus.
        let mut keys = Keys::new(keymap(), Scope::SIDEBAR);

        // When pressing the key once.
        let intent = press(&mut keys, key(KeyCode::Char(c)));

        // Then it yields its intent.
        assert_eq!(intent, Some(expected), "{c} in the sidebar");
    }

    #[rstest::rstest]
    fn held_j_selects_the_next_agent() {
        // Given a held `j` as the kitty protocol reports it.
        let mut keys = Keys::new(keymap(), Scope::SIDEBAR);
        let held = KeyEvent::new_with_kind_and_state(
            KeyCode::Char('j'),
            KeyModifiers::NONE,
            KeyEventKind::Repeat,
            KeyEventState::NUM_LOCK,
        );

        // When pressing it.
        let intent = press(&mut keys, held);

        // Then it still selects the next agent.
        assert_eq!(
            intent,
            Some(Intent::SelectNext),
            "a repeated j should select the next agent"
        );
    }

    fn alt(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::ALT)
    }

    #[rstest::rstest]
    fn repeated_alt_key_still_runs_its_intent() {
        // Given a held Alt+h as the kitty protocol reports its repeats.
        let held =
            KeyEvent::new_with_kind(KeyCode::Char('h'), KeyModifiers::ALT, KeyEventKind::Repeat);

        // When routing it in a pane.
        let route = route(held, true, false);

        // Then it still moves the focus left.
        assert_eq!(
            route,
            Route::Intent(Intent::MoveFocus(NavDirection::Left)),
            "a repeated Alt key should run its intent"
        );
    }

    #[rstest::rstest]
    #[case(KeyCode::Char('h'), Intent::MoveFocus(NavDirection::Left))]
    #[case(KeyCode::Char('j'), Intent::MoveFocus(NavDirection::Down))]
    #[case(KeyCode::Char('k'), Intent::MoveFocus(NavDirection::Up))]
    #[case(KeyCode::Char('l'), Intent::MoveFocus(NavDirection::Right))]
    #[case(KeyCode::Left, Intent::MoveFocus(NavDirection::Left))]
    #[case(KeyCode::Down, Intent::MoveFocus(NavDirection::Down))]
    #[case(KeyCode::Up, Intent::MoveFocus(NavDirection::Up))]
    #[case(KeyCode::Right, Intent::MoveFocus(NavDirection::Right))]
    #[case(KeyCode::Char('n'), Intent::AddPane)]
    #[case(KeyCode::Char('x'), Intent::ClosePane)]
    #[case(KeyCode::Char('f'), Intent::ToggleFloats)]
    #[case(KeyCode::Char('+'), Intent::GrowFocused)]
    #[case(KeyCode::Char('='), Intent::GrowFocused)]
    #[case(KeyCode::Char('-'), Intent::ShrinkFocused)]
    #[case(KeyCode::Char('1'), Intent::GoToTab(1))]
    #[case(KeyCode::Char('2'), Intent::GoToTab(2))]
    #[case(KeyCode::Char('3'), Intent::GoToTab(3))]
    #[case(KeyCode::Char('4'), Intent::GoToTab(4))]
    #[case(KeyCode::Char('5'), Intent::GoToTab(5))]
    #[case(KeyCode::Char('6'), Intent::GoToTab(6))]
    #[case(KeyCode::Char('7'), Intent::GoToTab(7))]
    #[case(KeyCode::Char('8'), Intent::GoToTab(8))]
    #[case(KeyCode::Char('9'), Intent::GoToTab(9))]
    #[case(KeyCode::Char('['), Intent::PreviousSwapLayout)]
    #[case(KeyCode::Char(']'), Intent::NextSwapLayout)]
    #[case(KeyCode::Char('i'), Intent::MoveTabLeft)]
    #[case(KeyCode::Char('o'), Intent::MoveTabRight)]
    fn alt_keys_route_to_their_intents(
        #[case] code: KeyCode,
        #[case] expected: Intent,
        #[values(false, true)] in_pane: bool,
    ) {
        // Given / When routing Alt with `code` in the sidebar or a pane.
        let routed = route(alt(code), in_pane, false);

        // Then it asks for its intent.
        assert_eq!(
            routed,
            Route::Intent(expected),
            "Alt {code} should route (in a pane: {in_pane})"
        );
    }

    #[rstest::rstest]
    fn alt_plus_with_shift_grows() {
        // Given Alt + as the terminal reports it with Shift.
        let pressed = KeyEvent::new(KeyCode::Char('+'), KeyModifiers::ALT | KeyModifiers::SHIFT);

        // When routing it.
        let intent = alt_route(pressed);

        // Then it grows.
        assert_eq!(intent, Some(Intent::GrowFocused), "Alt Shift + should grow");
    }

    #[rstest::rstest]
    fn super_keys_go_to_the_pane() {
        // Given Super h.
        let pressed = KeyEvent::new(KeyCode::Char('h'), KeyModifiers::SUPER);

        // When routing it in a pane.
        let routed = route(pressed, true, false);

        // Then the pane's program gets it.
        assert_eq!(routed, Route::Forward, "Super h belongs to the pane");
    }

    #[rstest::rstest]
    fn other_alt_keys_go_to_the_pane() {
        // Given Alt b, which isn't one of orb's keys.
        let pressed = alt(KeyCode::Char('b'));

        // When routing it in a pane.
        let routed = route(pressed, true, false);

        // Then the pane's program gets it.
        assert_eq!(routed, Route::Forward, "Alt b belongs to the pane");
    }

    #[rstest::rstest]
    fn ctrl_letters_are_not_alt_keys() {
        // Given Ctrl h.
        let pressed = ctrl('h');

        // When routing it as an Alt key.
        let intent = alt_route(pressed);

        // Then it isn't one.
        assert_eq!(intent, None, "<C-h> is not an Alt key");
    }

    #[rstest::rstest]
    #[case::kitty_alternate_h(KeyCode::Char('H'), KeyModifiers::CONTROL)]
    #[case::shifted_h(KeyCode::Char('h'), KeyModifiers::CONTROL | KeyModifiers::SHIFT)]
    #[case::kitty_alternate_l(KeyCode::Char('L'), KeyModifiers::CONTROL)]
    #[case::shifted_l(KeyCode::Char('l'), KeyModifiers::CONTROL | KeyModifiers::SHIFT)]
    fn ctrl_shift_h_and_l_go_to_the_pane(#[case] code: KeyCode, #[case] modifiers: KeyModifiers) {
        // Given Ctrl+Shift with `code`, in either form kitty reports it.
        let pressed = KeyEvent::new(code, modifiers);

        // When routing it in a pane.
        let routed = route(pressed, true, false);

        // Then the pane's program gets it.
        assert_eq!(
            routed,
            Route::Forward,
            "{code} with {modifiers:?} belongs to the pane"
        );
    }

    #[rstest::rstest]
    fn plain_q_in_the_sidebar_does_nothing() {
        // Given the keymap in Sidebar focus.
        let mut keys = Keys::new(keymap(), Scope::SIDEBAR);

        // When pressing `q`.
        let intent = press(&mut keys, key(KeyCode::Char('q')));

        // Then nothing happens.
        assert_eq!(intent, None, "<C-g> q quits, not q");
    }

    #[rstest::rstest]
    #[case('[', Intent::JumpBack)]
    #[case(']', Intent::JumpForward)]
    fn ctrl_brackets_jump_in_the_sidebar_and_in_a_pane(
        #[case] c: char,
        #[case] expected: Intent,
        #[values(false, true)] in_pane: bool,
    ) {
        // Given `<C-[>` or `<C-]>` as kitty reports it under the disambiguate
        // flag.
        let pressed = ctrl(c);

        // When routing it in the sidebar or a pane.
        let routed = route(pressed, in_pane, false);

        // Then it moves through the jump list.
        assert_eq!(
            routed,
            Route::Intent(expected),
            "<C-{c}> should jump (in a pane: {in_pane})"
        );
    }

    #[rstest::rstest]
    #[case(KeyEvent::new(KeyCode::Char('['), KeyModifiers::CONTROL | KeyModifiers::SHIFT))]
    #[case(key(KeyCode::Char('[')))]
    #[case(key(KeyCode::Char(']')))]
    fn jump_keys_need_bare_ctrl(#[case] pressed: KeyEvent) {
        // Given a bracket without bare Ctrl.

        // When routing it in a pane.
        let routed = route(pressed, true, false);

        // Then the pane's program gets it.
        assert_eq!(routed, Route::Forward, "{pressed:?} shouldn't jump");
    }

    #[rstest::rstest]
    fn esc_is_forwarded_in_a_pane() {
        // Given a plain Esc, which is also what Ctrl+[ sends without the
        // kitty protocol.
        let pressed = key(KeyCode::Esc);

        // When routing it in a pane.
        let routed = route(pressed, true, false);

        // Then the pane's program gets it.
        assert_eq!(routed, Route::Forward, "Esc should reach the pane");
    }

    #[rstest::rstest]
    fn esc_never_jumps_in_the_sidebar() {
        // Given a plain Esc.
        let pressed = key(KeyCode::Esc);

        // When routing it in the sidebar.
        let routed = route(pressed, false, false);

        // Then it goes to the keymap, not the jump list.
        assert_eq!(routed, Route::Keymap, "Esc should never jump");
    }

    #[rstest::rstest]
    fn legacy_ctrl_right_bracket_is_not_a_jump() {
        // Given Ctrl+5, which is also how crossterm reads the legacy `<C-]>`
        // byte.
        let pressed = ctrl('5');

        // When routing it in a pane.
        let routed = route(pressed, true, false);

        // Then the pane's program gets it.
        assert_eq!(routed, Route::Forward, "Ctrl+5 shouldn't jump forward");
    }

    #[rstest::rstest]
    #[case(ctrl('\\'))]
    #[case(ctrl('4'))]
    #[case(ctrl('h'))]
    #[case(ctrl('b'))]
    #[case(ctrl(' '))]
    #[case(ctrl('o'))]
    #[case(ctrl('i'))]
    #[case(ctrl('l'))]
    #[case(KeyEvent::new(KeyCode::Left, KeyModifiers::CONTROL))]
    #[case(KeyEvent::new(KeyCode::Right, KeyModifiers::CONTROL))]
    fn old_direct_keys_are_forwarded_in_a_pane(#[case] pressed: KeyEvent) {
        // Given a Ctrl key orb took from the pane before.

        // When routing it in a pane.
        let routed = route(pressed, true, false);

        // Then the pane's program gets it.
        assert_eq!(routed, Route::Forward, "{pressed:?} should reach the pane");
    }

    #[rstest::rstest]
    #[case(key(KeyCode::Char('q')))]
    #[case(key(KeyCode::Enter))]
    #[case(key(KeyCode::Char('a')))]
    #[case(key(KeyCode::Char(' ')))]
    #[case(key(KeyCode::Backspace))]
    #[case(key(KeyCode::Tab))]
    fn plain_keys_are_forwarded_in_a_pane(#[case] pressed: KeyEvent) {
        // Given a plain key.

        // When routing it in a pane.
        let routed = route(pressed, true, false);

        // Then the pane's program gets it.
        assert_eq!(routed, Route::Forward, "{pressed:?} should reach the pane");
    }

    #[rstest::rstest]
    fn old_direct_keys_are_unbound_in_the_sidebar(
        #[values(Scope::SIDEBAR, Scope::SIDEBAR_EMPTY)] scope: Scope,
        #[values(
            ctrl('\\'),
            ctrl('4'),
            ctrl('l'),
            ctrl('o'),
            ctrl('i'),
            KeyEvent::new(KeyCode::Left, KeyModifiers::CONTROL),
            KeyEvent::new(KeyCode::Right, KeyModifiers::CONTROL)
        )]
        pressed: KeyEvent,
    ) {
        // Given the keymap in a sidebar scope.
        let mut keys = Keys::new(keymap(), scope);

        // When pressing a Ctrl key orb bound before.
        let intent = press(&mut keys, pressed);

        // Then nothing happens and no sequence starts.
        assert_eq!(
            (intent, keys.is_pending()),
            (None, false),
            "{pressed:?} should do nothing in {scope:?}"
        );
    }

    /// The key that types `c`: a capital with Shift, as kitty reports it,
    /// and BEL (`\x07`) as `<C-g>`.
    fn typed(c: char) -> KeyEvent {
        match c {
            '\x07' => LEADER,
            c if c.is_uppercase() => KeyEvent::new(KeyCode::Char(c), KeyModifiers::SHIFT),
            c => key(KeyCode::Char(c)),
        }
    }

    #[rstest::rstest]
    fn ctrl_g_opens_the_leader_popup(
        #[values(
            Scope::SIDEBAR,
            Scope::SIDEBAR_EMPTY,
            Scope::SIDEBAR_INCOGNITO,
            Scope::PANE,
            Scope::PANE_INCOGNITO
        )]
        scope: Scope,
    ) {
        // Given the keymap in `scope`.
        let mut keys = Keys::new(keymap(), scope);

        // When pressing `<C-g>`.
        press(&mut keys, LEADER);

        // Then the which-key popup waits for the next key.
        assert!(
            keys.is_pending(),
            "<C-g> should open the popup in {scope:?}"
        );
    }

    #[rstest::rstest]
    fn leader_s_is_unbound(#[values(Scope::SIDEBAR, Scope::PANE)] scope: Scope) {
        // Given `<C-g>` pressed in `scope`.
        let mut keys = Keys::new(keymap(), scope);
        press(&mut keys, LEADER);

        // When pressing `s`.
        let intent = press(&mut keys, key(KeyCode::Char('s')));

        // Then nothing happens and no sequence is left waiting.
        assert_eq!(
            (intent, keys.is_pending()),
            (None, false),
            "<C-g> s should do nothing in {scope:?}"
        );
    }

    #[rstest::rstest]
    fn leader_a_is_unbound(#[values(Scope::SIDEBAR, Scope::PANE)] scope: Scope) {
        // Given `<C-g>` pressed in `scope`.
        let mut keys = Keys::new(keymap(), scope);
        press(&mut keys, LEADER);

        // When pressing `a`.
        let intent = press(&mut keys, key(KeyCode::Char('a')));

        // Then nothing happens and no sequence is left waiting.
        assert_eq!(
            (intent, keys.is_pending()),
            (None, false),
            "<C-g> a should do nothing in {scope:?}"
        );
    }

    #[rstest::rstest]
    fn leader_r_is_unbound_in_the_sidebar() {
        // Given `<C-g>` pressed in the sidebar.
        let mut keys = Keys::new(keymap(), Scope::SIDEBAR);
        press(&mut keys, LEADER);

        // When pressing `r`.
        let intent = press(&mut keys, key(KeyCode::Char('r')));

        // Then nothing happens and no sequence is left waiting.
        assert_eq!(
            (intent, keys.is_pending()),
            (None, false),
            "<C-g> r should do nothing in the sidebar"
        );
    }

    #[rstest::rstest]
    #[case::resize_esc(PaneMode::Resize, KeyCode::Esc)]
    #[case::resize_enter(PaneMode::Resize, KeyCode::Enter)]
    #[case::move_esc(PaneMode::Move, KeyCode::Esc)]
    #[case::move_enter(PaneMode::Move, KeyCode::Enter)]
    fn esc_and_enter_leave_a_pane_mode(#[case] mode: PaneMode, #[case] code: KeyCode) {
        // Given the pane mode on.

        // When pressing the key.
        let intent = mode_route(mode, key(code));

        // Then the mode ends.
        assert_eq!(
            intent,
            Some(Intent::ExitPaneMode),
            "{code:?} in {mode:?} mode"
        );
    }

    #[rstest::rstest]
    #[case::shift_h(KeyEvent::new(KeyCode::Char('H'), KeyModifiers::SHIFT))]
    #[case::leader(LEADER)]
    fn other_keys_do_nothing_in_move_mode(#[case] pressed: KeyEvent) {
        // Given move mode.

        // When pressing a key the mode doesn't use.
        let intent = mode_route(PaneMode::Move, pressed);

        // Then nothing happens.
        assert_eq!(intent, None, "{pressed:?} in move mode");
    }

    #[rstest::rstest]
    #[case::h(key(KeyCode::Char('h')), Intent::MovePane(NavDirection::Left))]
    #[case::left(key(KeyCode::Left), Intent::MovePane(NavDirection::Left))]
    #[case::j(key(KeyCode::Char('j')), Intent::MovePane(NavDirection::Down))]
    #[case::down(key(KeyCode::Down), Intent::MovePane(NavDirection::Down))]
    #[case::k(key(KeyCode::Char('k')), Intent::MovePane(NavDirection::Up))]
    #[case::up(key(KeyCode::Up), Intent::MovePane(NavDirection::Up))]
    #[case::l(key(KeyCode::Char('l')), Intent::MovePane(NavDirection::Right))]
    #[case::right(key(KeyCode::Right), Intent::MovePane(NavDirection::Right))]
    #[case::n(key(KeyCode::Char('n')), Intent::MovePaneInOrder { forward: true })]
    #[case::tab(key(KeyCode::Tab), Intent::MovePaneInOrder { forward: true })]
    #[case::p(key(KeyCode::Char('p')), Intent::MovePaneInOrder { forward: false })]
    fn move_mode_keys_map_to_their_moves(#[case] pressed: KeyEvent, #[case] expected: Intent) {
        // Given move mode.

        // When pressing a move key.
        let intent = mode_route(PaneMode::Move, pressed);

        // Then it swaps the focused pane that way.
        assert_eq!(intent, Some(expected), "{pressed:?} in move mode");
    }

    #[rstest::rstest]
    #[case::letter(key(KeyCode::Char('x')))]
    #[case::leader(LEADER)]
    fn other_keys_do_nothing_in_resize_mode(#[case] pressed: KeyEvent) {
        // Given resize mode.

        // When pressing a key the mode doesn't use.
        let intent = mode_route(PaneMode::Resize, pressed);

        // Then nothing happens.
        assert_eq!(intent, None, "{pressed:?} in resize mode");
    }

    #[rstest::rstest]
    #[case::plus('+', Intent::GrowFocused)]
    #[case::equals('=', Intent::GrowFocused)]
    #[case::minus('-', Intent::ShrinkFocused)]
    fn plus_equals_minus_act_as_alt_plus_minus_in_resize_mode(
        #[case] c: char,
        #[case] expected: Intent,
    ) {
        // Given resize mode.

        // When pressing the key.
        let intent = mode_route(PaneMode::Resize, key(KeyCode::Char(c)));

        // Then it does what Alt with that key does.
        assert_eq!(intent, Some(expected), "{c:?} in resize mode");
    }

    #[rstest::rstest]
    #[case::h(key(KeyCode::Char('h')), NavDirection::Left, true)]
    #[case::left(key(KeyCode::Left), NavDirection::Left, true)]
    #[case::j(key(KeyCode::Char('j')), NavDirection::Down, true)]
    #[case::down(key(KeyCode::Down), NavDirection::Down, true)]
    #[case::k(key(KeyCode::Char('k')), NavDirection::Up, true)]
    #[case::up(key(KeyCode::Up), NavDirection::Up, true)]
    #[case::l(key(KeyCode::Char('l')), NavDirection::Right, true)]
    #[case::right(key(KeyCode::Right), NavDirection::Right, true)]
    #[case::shift_h(
        KeyEvent::new(KeyCode::Char('H'), KeyModifiers::SHIFT),
        NavDirection::Left,
        false
    )]
    #[case::bare_h(key(KeyCode::Char('H')), NavDirection::Left, false)]
    #[case::shift_j(
        KeyEvent::new(KeyCode::Char('J'), KeyModifiers::SHIFT),
        NavDirection::Down,
        false
    )]
    #[case::shift_k(
        KeyEvent::new(KeyCode::Char('K'), KeyModifiers::SHIFT),
        NavDirection::Up,
        false
    )]
    #[case::shift_l(
        KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT),
        NavDirection::Right,
        false
    )]
    fn resize_mode_keys_map_to_their_sides(
        #[case] pressed: KeyEvent,
        #[case] dir: NavDirection,
        #[case] grow: bool,
    ) {
        // Given resize mode.

        // When pressing a side key.
        let intent = mode_route(PaneMode::Resize, pressed);

        // Then it moves that side's border out (lower case) or in (capital).
        assert_eq!(
            intent,
            Some(Intent::ResizeFocused { dir, grow }),
            "{pressed:?} in resize mode"
        );
    }

    #[rstest::rstest]
    fn alt_keys_still_work_in_resize_mode() {
        // Given resize mode.

        // When pressing Alt h.
        let intent = mode_route(
            PaneMode::Resize,
            KeyEvent::new(KeyCode::Char('h'), KeyModifiers::ALT),
        );

        // Then the focus moves left, as outside the mode.
        assert_eq!(
            intent,
            Some(Intent::MoveFocus(NavDirection::Left)),
            "Alt h in resize mode"
        );
    }

    #[rstest::rstest]
    fn ctrl_g_does_nothing_in_resize_mode() {
        // Given resize mode.

        // When pressing `<C-g>`.
        let intent = mode_route(PaneMode::Resize, LEADER);

        // Then nothing happens until the mode ends.
        assert_eq!(intent, None, "<C-g> in resize mode");
    }

    #[rstest::rstest]
    fn space_is_unbound_in_the_sidebar() {
        // Given the keymap in the sidebar on a session.
        let mut keys = Keys::new(keymap(), Scope::SIDEBAR);

        // When pressing Space.
        let intent = press(&mut keys, key(KeyCode::Char(' ')));

        // Then nothing happens and no sequence starts.
        assert_eq!(
            (intent, keys.is_pending()),
            (None, false),
            "Space is no longer a leader"
        );
    }

    #[rstest::rstest]
    #[case(Scope::PANE, "e", Intent::ToggleSidebar)]
    #[case(Scope::SIDEBAR, "e", Intent::ToggleSidebar)]
    #[case(Scope::PANE, " ", Intent::OpenSessionPicker)]
    #[case(Scope::SIDEBAR_EMPTY, " ", Intent::OpenSessionPicker)]
    #[case(Scope::SIDEBAR, "n", Intent::NewSession)]
    #[case(Scope::PANE, "n", Intent::NewSession)]
    #[case(Scope::SIDEBAR_EMPTY, "P", Intent::OpenProjects)]
    #[case(Scope::PANE, "P", Intent::OpenProjects)]
    #[case(Scope::SIDEBAR, "f", Intent::FilterProjects)]
    #[case(Scope::SIDEBAR_EMPTY, "f", Intent::FilterProjects)]
    #[case(Scope::PANE_INCOGNITO, "i", Intent::NewIncognito)]
    #[case(Scope::SIDEBAR_EMPTY, "i", Intent::NewIncognito)]
    #[case(Scope::SIDEBAR, "w", Intent::ChangeWorkspace)]
    #[case(Scope::PANE, "w", Intent::ChangeWorkspace)]
    #[case(Scope::SIDEBAR, "b", Intent::SwitchBranch)]
    #[case(Scope::PANE, "b", Intent::SwitchBranch)]
    #[case(Scope::SIDEBAR, "/", Intent::OpenSearch)]
    #[case(Scope::PANE, "/", Intent::OpenSearch)]
    #[case(Scope::SIDEBAR_EMPTY, "W", Intent::OpenWorktreePicker)]
    #[case(Scope::PANE, "W", Intent::OpenWorktreePicker)]
    #[case(Scope::PANE, "pd", Intent::SplitPane(Split::Down))]
    #[case(Scope::PANE, "pr", Intent::SplitPane(Split::Right))]
    #[case(Scope::PANE, "pf", Intent::ToggleZoom)]
    #[case(Scope::PANE, "px", Intent::ClosePane)]
    #[case(Scope::PANE, "pw", Intent::ToggleFloats)]
    #[case(Scope::PANE, "pe", Intent::ToggleFloatEmbed)]
    #[case(Scope::PANE_INCOGNITO, "pi", Intent::TogglePinFloat)]
    #[case(Scope::PANE, "pc", Intent::RenamePane)]
    #[case(Scope::PANE, "ps", Intent::StackPane)]
    #[case(Scope::PANE, "tb", Intent::BreakPane)]
    #[case(Scope::PANE, "tn", Intent::NewTab)]
    #[case(Scope::SIDEBAR, "tn", Intent::NewTab)]
    #[case(Scope::PANE, "tx", Intent::CloseTab)]
    #[case(Scope::SIDEBAR, "tx", Intent::CloseTab)]
    #[case(Scope::PANE, "tr", Intent::RenameTab)]
    #[case(Scope::SIDEBAR, "tr", Intent::RenameTab)]
    #[case(Scope::PANE, "t1", Intent::GoToTab(1))]
    #[case(Scope::SIDEBAR, "t6", Intent::GoToTab(6))]
    #[case(Scope::PANE, "t9", Intent::GoToTab(9))]
    #[case(Scope::PANE, "\x07", Intent::SendCtrlG)]
    #[case(Scope::PANE, "q", Intent::Quit)]
    #[case(Scope::PANE, "r", Intent::EnterPaneMode(PaneMode::Resize))]
    #[case(Scope::PANE_INCOGNITO, "r", Intent::EnterPaneMode(PaneMode::Resize))]
    #[case(Scope::PANE, "m", Intent::EnterPaneMode(PaneMode::Move))]
    #[case(Scope::PANE_INCOGNITO, "m", Intent::EnterPaneMode(PaneMode::Move))]
    #[case(Scope::SIDEBAR, "q", Intent::Quit)]
    #[case(Scope::SIDEBAR_EMPTY, "q", Intent::Quit)]
    #[case(Scope::PANE, "h", Intent::LeavePane)]
    #[case(Scope::PANE_INCOGNITO, "h", Intent::LeavePane)]
    #[case(Scope::SIDEBAR, "l", Intent::FocusPanes)]
    #[case(Scope::SIDEBAR_EMPTY, "l", Intent::FocusPanes)]
    #[case(Scope::SIDEBAR_EMPTY, "c", Intent::NewColony)]
    #[case(Scope::PANE_INCOGNITO, "c", Intent::NewColony)]
    #[case(Scope::SIDEBAR, "C", Intent::OpenWorlds)]
    #[case(Scope::PANE, "C", Intent::OpenWorlds)]
    #[case(Scope::SIDEBAR_COLONY, ",", Intent::OpenColonists)]
    #[case(Scope::SIDEBAR_AGENT_COLONY, ",", Intent::OpenColonists)]
    #[case(Scope::PANE_COLONY, ",", Intent::OpenColonists)]
    #[case(Scope::SIDEBAR_COLONISTS, ",", Intent::OpenColonists)]
    fn leader_keys_yield_their_intents(
        #[case] scope: Scope,
        #[case] then: &str,
        #[case] expected: Intent,
    ) {
        // Given `<C-g>` pressed in `scope`.
        let mut keys = Keys::new(keymap(), scope);
        press(&mut keys, LEADER);

        // When typing the rest of the sequence.
        let intent = then
            .chars()
            .map(|c| press(&mut keys, typed(c)))
            .last()
            .flatten();

        // Then it yields its intent.
        assert_eq!(
            intent.as_ref(),
            Some(&expected),
            "<C-g> {then:?} in {scope:?}"
        );
    }

    #[rstest::rstest]
    #[case(Scope::SIDEBAR, "/ C P Space W b c e f i l n q t w")]
    #[case(Scope::SIDEBAR_EMPTY, "/ C P Space W c e f i l n q")]
    #[case(Scope::SIDEBAR_INCOGNITO, "/ C P Space W c e f i l n q t")]
    #[case(Scope::PANE, "/ <C-g> C P Space W b c e h i m n p q r t w")]
    #[case(Scope::PANE_INCOGNITO, "/ <C-g> C P Space W c e h i m n p q r t")]
    #[case(Scope::SIDEBAR_AGENT, "/ C P Space W b c e f i l n q t w")]
    #[case(Scope::SIDEBAR_AGENT_INCOGNITO, "/ C P Space W c e f i l n q t")]
    #[case(Scope::SIDEBAR_COLONY, ", / C P Space W c e f i l n q t")]
    #[case(Scope::SIDEBAR_AGENT_COLONY, ", / C P Space W c e f i l n q t")]
    #[case(Scope::PANE_COLONY, ", / <C-g> C P Space W c e h i m n p q r t")]
    #[case(Scope::SIDEBAR_COLONISTS, ", / C P Space W c e f i l n q")]
    fn leader_popup_matches_the_scope_table(#[case] scope: Scope, #[case] expected: &str) {
        // Given orb's keymap in the scope.

        // When listing the keys after `<C-g>`, sorted.
        let found = leader_popup(scope, &[]).join(" ");

        // Then they are the scope's row of the key table.
        assert_eq!(found, expected, "<C-g> keys in {scope:?}");
    }

    #[rstest::rstest]
    fn leader_p_popup_lists_the_pane_keys() {
        // Given orb's keymap in a pane.

        // When listing the keys after `<C-g> p`.
        let found = leader_popup(Scope::PANE, &[key(KeyCode::Char('p'))]).join(" ");

        // Then they are the pane keys.
        assert_eq!(found, "c d e f i r s w x", "<C-g> p keys in a pane");
    }

    #[rstest::rstest]
    #[case::sidebar(Scope::SIDEBAR, "1 2 3 4 5 6 7 8 9 n r x")]
    #[case::pane_adds_break(Scope::PANE, "1 2 3 4 5 6 7 8 9 b n r x")]
    fn leader_t_popup_lists_the_tab_keys(#[case] scope: Scope, #[case] expected: &str) {
        // Given orb's keymap with a session selected.

        // When listing the keys after `<C-g> t`.
        let found = leader_popup(scope, &[key(KeyCode::Char('t'))]).join(" ");

        // Then they are the tab keys, `b` only where there is a focused pane to break out.
        assert_eq!(found, expected, "<C-g> t keys in {scope:?}");
    }

    #[rstest::rstest]
    fn leader_g_is_unbound(#[values(Scope::SIDEBAR, Scope::PANE)] scope: Scope) {
        // Given `<C-g>` pressed in `scope`.
        let mut keys = Keys::new(keymap(), scope);
        press(&mut keys, LEADER);

        // When pressing `g`.
        let intent = press(&mut keys, key(KeyCode::Char('g')));

        // Then nothing happens and no sequence is left waiting.
        assert_eq!(
            (intent, keys.is_pending()),
            (None, false),
            "<C-g> g should do nothing in {scope:?}"
        );
    }

    #[rstest::rstest]
    #[case(Scope::SIDEBAR, Scope::SIDEBAR_INCOGNITO)]
    #[case(Scope::PANE, Scope::PANE_INCOGNITO)]
    fn incognito_scope_binds_its_base_scopes_keys_but_w_and_b(
        #[case] base: Scope,
        #[case] incognito: Scope,
    ) {
        // Given the bindings of the base scope, less `<C-g> w` and `<C-g> b`.
        let expected: Vec<(Vec<KeyEvent>, Intent)> = {
            let unbound = ['w', 'b'].map(|c| vec![LEADER, key(KeyCode::Char(c))]);
            bindings(base)
                .into_iter()
                .filter(|(path, _)| !unbound.contains(path))
                .collect()
        };

        // When listing the incognito scope's bindings.
        let found = bindings(incognito);

        // Then they are the same, key for key and intent for intent.
        assert_eq!(found, expected, "{incognito:?} against {base:?}");
    }

    #[rstest::rstest]
    fn ctrl_g_goes_to_the_keymap_in_a_pane() {
        // Given `<C-g>`.

        // When routing it in a pane with no sequence pending.
        let routed = route(LEADER, true, false);

        // Then it goes to the keymap instead of the pane.
        assert_eq!(
            routed,
            Route::Keymap,
            "<C-g> should open which-key in a pane"
        );
    }

    #[rstest::rstest]
    #[case(key(KeyCode::Char('j')))]
    #[case(key(KeyCode::Esc))]
    #[case(key(KeyCode::Char(' ')))]
    fn keys_go_to_the_keymap_while_a_sequence_is_pending_in_a_pane(#[case] pressed: KeyEvent) {
        // Given a `<C-g>` sequence pending in a pane.

        // When routing the next key.
        let routed = route(pressed, true, true);

        // Then the keymap gets it, not the pane.
        assert_eq!(
            routed,
            Route::Keymap,
            "{pressed:?} should continue the sequence"
        );
    }

    #[rstest::rstest]
    fn alt_keys_still_win_while_a_sequence_is_pending() {
        // Given a `<C-g>` sequence pending in a pane.

        // When routing Alt h.
        let routed = route(alt(KeyCode::Char('h')), true, true);

        // Then it moves the focus.
        assert_eq!(
            routed,
            Route::Intent(Intent::MoveFocus(NavDirection::Left)),
            "Alt h should win over a pending sequence"
        );
    }

    #[rstest::rstest]
    fn ctrl_g_ctrl_g_sends_ctrl_g_in_a_pane() {
        // Given `<C-g>` pressed in a pane.
        let mut keys = Keys::new(keymap(), Scope::PANE);
        press(&mut keys, LEADER);

        // When pressing `<C-g>` again.
        let intent = press(&mut keys, LEADER);

        // Then it sends Ctrl g to the pane.
        assert_eq!(
            intent,
            Some(Intent::SendCtrlG),
            "<C-g> <C-g> should send Ctrl g"
        );
    }

    #[rstest::rstest]
    fn agents_category_reads_agents() {
        // Given the which-key section for agent keys.
        let category = KeyCategory::Agents;

        // When formatting it.
        let label = category.to_string();

        // Then it reads "agents".
        assert_eq!(label, "agents", "the agents section should read agents");
    }
}
