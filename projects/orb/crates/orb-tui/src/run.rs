//! The frontend loop: wait for input or pane activity, apply it, draw once.
//!
//! Terminal input, the pane's background threads, and the actors' state
//! changes all feed one channel. The loop sleeps until something arrives,
//! handles everything pending, and then draws a single frame, so bursts of
//! output cost one redraw. The panes' kitty images are placed in the same
//! screen update as the cells. The only tick is every spinner frame (100 ms)
//! while an agent is working or a session is starting, so the spinners turn
//! and a working agent's elapsed time counts up.
//!
//! Each pane is a `zmx attach` client: its program runs in a zmx session, so
//! dropping the pane (a detach of its session) leaves the program running.
//! Every session's layout (tabs of split panes) is kept and saved; while a
//! session is attached, each of its panes has a client. The right side shows
//! the selected session, a tab bar over its shown tab's panes, while it is
//! attached, else the start screen. Each frame resizes every visible pane to
//! the inside of its frame; panes of hidden tabs and other sessions keep their size. A
//! pane that leaves every layout (closed, or its session deleted) is killed
//! with `zmx kill`. A pane of an attached session whose program ended closes
//! in its layout. At start every `orb-p*` session on orb's pane dir that no
//! pane names is killed (left by earlier versions, or by panes closed while
//! orb was down), then every unsettled session is attached again (one whose
//! directory is gone only if a pane still runs). A pane whose zmx session is
//! gone gets a fresh shell, and orb types its resume command
//! (`claude --resume <id>`, `pi --session-id <id>`) once the client first
//! prints. A client that dies while its session is still shown and zmx still
//! lists it is attached again once; a second death closes the pane with an
//! error in the message box. One whose session isn't shown any more is
//! dropped, keeping its program. While a pane
//! has the keys, input goes straight to its program except orb's Alt keys,
//! `<C-[>`/`<C-]>` and a `<C-g>` sequence (see [`keymap::route`]). The loop
//! itself reads the directory picker's listings, the branch picker's refs
//! and the session picker's preview, re-reading the preview whenever the
//! selected agent's transcript changes length, since each takes
//! milliseconds.
//!
//! A click on the sidebar, `<C-g> h` or `<C-g> e` from a pane moves the keys
//! to the sidebar and leaves the panes drawn, so `<C-g> l` or `<C-g> e` goes
//! back in. Settling
//! or deleting a session ends its panes' clients; `⏎` on a settled session
//! brings its panes back the way start-up does. A pane whose program exits
//! within a second of attaching leaves `session <title> exited at start` on
//! the start screen.
//!
//! When an agent finishes a turn or starts needing an approval or an answer
//! while orb's terminal isn't focused, the loop sends it as a desktop
//! notification; notices that arrive while it is focused are dropped, since
//! the sidebar already shows them.
//!
//! When a new session, or one moved to another workspace, comes up still
//! selected, the loop attaches to it. If the user is typing in a picker, the rename box or the
//! sidebar search, or is in a pane, it waits, and attaches once the keys are
//! back in the sidebar, leaving them there with the pane drawn, as long as
//! the session is still selected. Attaching to a session whose orb worktree
//! is gone (none of its panes running) asks the sessions actor to recreate
//! it instead, leaving the keys in the sidebar, and attaches the same way
//! once it's back.
//!
//! orb captures the mouse throughout and maps each event through the last
//! frame's hit map (see [`mouse`]). The wheel
//! scrolls a pane's history unless its program reads the mouse or is on the
//! alternate screen. A drag in a pane whose program doesn't read the mouse
//! selects its text, and the release copies it to the clipboard through
//! OSC 52.
//!
//! Agents' requests through the control socket (closing, renaming, settling
//! or focusing a named pane, tab or session, and typing into or reading a
//! pane) are carried out here too, and their refusals go back to the agent,
//! never to the message box. Only `focus` moves the keys.
//!
//! After each frame the outer terminal's cursor takes the shape of where the
//! keys are: a block in the sidebar, a bar in a text input, the attached
//! program's own shape while attached.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::mem;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use error_stack::{Report, ResultExt};
use jiff::tz::TimeZone;
use kameo::prelude::ActorRef;
use orb_domain::feat::control::pane_control::{PaneControl, PaneReply, PaneRequest};
use orb_domain::feat::git::git_service::{GitService, git_reason};
use orb_domain::feat::git::worktree::is_orb_worktree;
use orb_domain::feat::harness::{Harnesses, unreadable_transcript};
use orb_domain::feat::layout::state::{Layouts, SessionLayout};
use orb_domain::feat::notify::notifier::NotifierService;
use orb_domain::feat::notify::sound::{SoundService, sound_for};
use orb_domain::feat::picker::state::{PickerKind, worktree_items};
use orb_domain::feat::search::search_actor::SearchActor;
use orb_domain::feat::sessions::child_env::{pane_env, terminal_browser_env};
use orb_domain::feat::sessions::sessions_actor::SessionsActor;
use orb_domain::feat::sessions::state::Notice;
use orb_domain::feat::sessions::validator::validate_new_session;
use orb_domain::feat::sidebar::state::SidebarLayout;
use orb_domain::feat::worktrees::worktrees_actor::WorktreesActor;
use orb_domain::feat::zmx::zmx_service::{ZmxService, ZmxSession, attach_argv};
use orb_domain::ids::{AgentId, PaneId, SessionId};
use orb_domain::{
    AppState, Command, Focus, Intent, IntentHandler, Log, Outcome, Reporter, SessionsCommand, State,
};
use orb_term::{CellSize, GraphicsSupport, Pane, PaneColors, PaneCommand, PaneEvent, PaneSize};
use ratatui::backend::Backend;
use ratatui::crossterm::cursor::SetCursorStyle;
use ratatui::crossterm::event::{
    self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent,
    MouseEventKind,
};
use ratatui::crossterm::terminal::{BeginSynchronizedUpdate, EndSynchronizedUpdate};
use ratatui::layout::{Margin, Position, Rect};
use wherror::Error;

use crate::graphics::Compositor;
use crate::keymap::{self, Keys, Route, Scope};
use crate::mouse::{self, Clicks, HitMap, MouseRoute};
use crate::outer_terminal::{self, OrbTerminal, OuterTerminal};
use crate::picker::PickerScroll;
use crate::sidebar::{FG, SPINNER_FRAME, SidebarScroll};
use crate::toast::Toasts;
use crate::{render, tabs};

mod control;
mod panes;
mod report;

use self::panes::{AttachPlan, attach_or_restore};
use self::report::Ready;

/// How soon after its pane starts an attached program's exit counts as a
/// failed start.
const EARLY_EXIT: Duration = Duration::from_secs(1);

/// How often the session picker re-reads the same agent's growing transcript.
const PREVIEW_EVERY: Duration = Duration::from_secs(1);

/// What the start screen says after an attached program exits within
/// [`EARLY_EXIT`] of starting.
const EXITED_AT_START: &str = "session exited at start";

/// The frontend loop failed to draw a frame or read a terminal event.
#[derive(Debug, Error)]
#[error(debug)]
pub struct TuiRunError;

/// orb's TUI. Created before the actors so they can report to its loop.
pub struct Frontend {
    tx: Sender<LoopEvent>,
    rx: Receiver<LoopEvent>,
    /// The zone the mode line's clock shows.
    tz: TimeZone,
}

impl Frontend {
    /// A frontend whose mode line shows the time in `tz`.
    pub fn new(tz: TimeZone) -> Self {
        let (tx, rx) = mpsc::channel();
        Self { tx, rx, tz }
    }

    /// Sends an actor's outcomes to the loop, which applies each one.
    pub fn reporter(&self) -> Reporter {
        let tx = self.tx.clone();
        Reporter::new(move |outcome| {
            let _ = tx.send(LoopEvent::Reported(outcome));
        })
    }

    /// Quits orb the way `<C-g> q` does, from outside the loop. A quit sent
    /// before the loop starts is handled on its first turn.
    pub fn quitter(&self) -> impl Fn() + Send + Sync + 'static {
        let tx = self.tx.clone();
        move || {
            let _ = tx.send(LoopEvent::Quit);
        }
    }

    /// Hands agents' requests to the loop, which applies each and answers.
    pub fn controller(&self) -> PaneControl {
        let tx = self.tx.clone();
        PaneControl::new(move |request, reply| {
            let _ = tx.send(LoopEvent::Control(request, reply));
        })
    }

    /// Runs orb's TUI until the user quits or [`Frontend::quitter`] is called.
    /// Session commands go to `sessions`; worktree commands go to
    /// `worktrees`; search commands go to `search`; an agent whose worktree
    /// under `worktrees_root` is gone has it recreated before attaching; the
    /// branch picker's refs come from `git`; panes run with `env`, plus
    /// terminal-browser's settings while orb runs in kitty, and attach
    /// through `zmx`; notices play a sound through `sounds` unless the
    /// user is looking at that agent's finished turn, and are announced
    /// through `notifier` while orb's terminal isn't focused;
    /// problems are written to `log`. The first frame is drawn before the
    /// panes of open sessions reconnect. Before anything reads input, the
    /// outer terminal is asked what it is; in kitty the mouse is read in
    /// pixels. The terminal is restored on exit and on panic.
    ///
    /// # Errors
    ///
    /// Returns [`TuiRunError`] if drawing a frame or reading a terminal event
    /// fails.
    pub fn run(
        self,
        state: State,
        sessions: ActorRef<SessionsActor>,
        worktrees: ActorRef<WorktreesActor>,
        worktrees_root: PathBuf,
        search: ActorRef<SearchActor>,
        git: GitService,
        harnesses: Harnesses,
        env: Vec<(OsString, OsString)>,
        zmx: ZmxService,
        notifier: NotifierService,
        sounds: SoundService,
        log: Log,
    ) -> Result<(), Report<TuiRunError>> {
        let Self { tx, rx, tz } = self;
        outer_terminal::run(&log.clone(), |terminal, outer| {
            outer_terminal::enable(terminal.backend_mut(), outer.pixel_mouse())?;
            outer_terminal::install_panic_hook(log.clone());
            let env = [
                env,
                terminal_browser_env(matches!(outer.graphics, GraphicsSupport::Kitty { .. })),
            ]
            .concat();
            let result = App::new(
                state,
                sessions,
                worktrees,
                worktrees_root,
                search,
                git,
                harnesses,
                env,
                zmx,
                attach_argv,
                notifier,
                sounds,
                log,
                tx,
                tz,
                outer,
            )
            .run(terminal, &rx);
            let restored = outer_terminal::disable(terminal.backend_mut());
            result.and(restored)
        })
        .change_context(TuiRunError)
    }
}

/// Something that wakes the loop.
enum LoopEvent {
    Input(Event),
    InputFailed(io::Error),
    /// Pane `PaneId` reported `PaneEvent`.
    Pane(PaneId, PaneEvent),
    /// A worker reported an outcome.
    Reported(Outcome),
    /// orb was asked to quit from outside (a signal).
    Quit,
    /// An agent's request through the control socket, answered on its sender.
    Control(PaneRequest, Sender<PaneReply>),
}

/// Handles a mouse event's intents in order after ending any pane mode;
/// `execute` runs each intent's commands before the next intent is handled.
fn handle_mouse_intents<F>(state: &State, intents: &[Intent], mut execute: F)
where
    F: FnMut(&Command),
{
    IntentHandler::handle(&Intent::ExitPaneMode, &mut state.write());
    for intent in intents {
        let commands = IntentHandler::handle(intent, &mut state.write());
        for command in &commands {
            execute(command);
        }
    }
}

/// Where the keys go once the pane is gone: from the pane to the sidebar;
/// anywhere else (the sidebar after a click on it, a text input) they stay.
fn after_pane(focus: Focus) -> Focus {
    match focus {
        Focus::Pane => Focus::Sidebar,
        Focus::Sidebar | Focus::Picker | Focus::Rename | Focus::Search => focus,
    }
}

/// The outer terminal's cursor shape with the keys in `focus`: a steady
/// block on the sidebar's selected row, a steady bar in a text input (a
/// picker's filter, the rename box, the sidebar search), the child's own shape (`pane`) while attached, and the user's
/// default while attached without a pane.
fn cursor_style(focus: Focus, pane: Option<SetCursorStyle>) -> SetCursorStyle {
    match (focus, pane) {
        (Focus::Sidebar, _) => SetCursorStyle::SteadyBlock,
        (Focus::Picker | Focus::Rename | Focus::Search, _) => SetCursorStyle::SteadyBar,
        (Focus::Pane, Some(style)) => style,
        (Focus::Pane, None) => SetCursorStyle::DefaultUserShape,
    }
}

struct App {
    state: State,
    sessions: ActorRef<SessionsActor>,
    /// Refreshes and deletes orb's worktrees.
    worktrees: ActorRef<WorktreesActor>,
    /// Where orb makes worktrees; an agent's missing worktree there is
    /// recreated on attach.
    worktrees_root: PathBuf,
    /// Runs transcript searches and loads their previews.
    search: ActorRef<SearchActor>,
    git: GitService,
    /// Every harness, to read an agent's transcript in its own format.
    harnesses: Harnesses,
    keys: Keys,
    /// Every pane orb holds a `zmx attach` client for, kept while other
    /// agents are selected.
    panes: HashMap<PaneId, Pane>,
    /// The zmx session each held pane's client attached to, for killing it
    /// once its layout no longer says, also for a broken pane.
    pane_sessions: HashMap<PaneId, ZmxSession>,
    /// The pane that last got a focus-in, so it gets a focus-out when the
    /// keys move on (see [`App::sync_focus`]).
    focused_pane: Option<PaneId>,
    /// Panes whose client exit the loop hasn't classified yet.
    exited: Vec<PaneId>,
    /// Panes already attached again once after their client died.
    respawned: HashSet<PaneId>,
    /// Panes whose output handling crashed; they get no client until their
    /// session leaves `attached`.
    broken: HashSet<PaneId>,
    /// Resume commands waiting for their fresh pane's first output.
    typing: HashMap<PaneId, String>,
    /// Shown on the start screen when a pane's client couldn't start.
    pane_error: Option<String>,
    /// The message box: the latest error or notice, until it times out.
    toasts: Toasts,
    /// The session a worker last made ready, until it opens or is dropped.
    ready: Option<Ready>,
    /// The environment panes run with.
    env: Vec<(OsString, OsString)>,
    /// Lists the zmx sessions panes attach to.
    zmx: ZmxService,
    /// The command a pane's client runs to attach to its zmx session.
    attach: fn(&ZmxSession) -> Vec<OsString>,
    /// Announces the sessions actor's status changes.
    notifier: NotifierService,
    /// Plays the sounds for the sessions actor's status changes.
    sounds: SoundService,
    /// orb's log file.
    log: Log,
    /// The zone the mode line's clock shows.
    tz: TimeZone,
    tx: Sender<LoopEvent>,
    pane_area: Rect,
    /// One outer cell in pixels, as panes are told; zero when the outer
    /// terminal doesn't say.
    cell: CellSize,
    /// The cursor style last sent to the outer terminal.
    cursor_style: SetCursorStyle,
    sidebar_scroll: SidebarScroll,
    picker_scroll: PickerScroll,
    /// Where the last frame drew what a click can land on.
    hits: HitMap,
    /// The last click, for telling a double-click.
    clicks: Clicks,
    /// Keys whose last press went to a pane, and which pane, so each one's
    /// release reaches that pane and no other.
    held: HashMap<KeyCode, PaneId>,
    /// orb's pane has the outer terminal's focus, as its last focus event
    /// said; `true` until one arrives.
    focused: bool,
    /// The agent the session picker's preview was last read for, and when.
    last_preview: Option<(AgentId, Instant)>,
    /// What the outer terminal said at start-up.
    outer: OuterTerminal,
    /// Keeps the panes' images on the outer screen in step with each frame.
    compositor: Compositor,
}

impl App {
    fn new(
        state: State,
        sessions: ActorRef<SessionsActor>,
        worktrees: ActorRef<WorktreesActor>,
        worktrees_root: PathBuf,
        search: ActorRef<SearchActor>,
        git: GitService,
        harnesses: Harnesses,
        env: Vec<(OsString, OsString)>,
        zmx: ZmxService,
        attach: fn(&ZmxSession) -> Vec<OsString>,
        notifier: NotifierService,
        sounds: SoundService,
        log: Log,
        tx: Sender<LoopEvent>,
        tz: TimeZone,
        outer: OuterTerminal,
    ) -> Self {
        let scope = {
            let state = state.read();
            Scope::of(state.focus, &state)
        };
        Self {
            state,
            sessions,
            worktrees,
            worktrees_root,
            search,
            git,
            harnesses,
            keys: Keys::new(keymap::keymap(), scope),
            panes: HashMap::new(),
            pane_sessions: HashMap::new(),
            focused_pane: None,
            exited: Vec::new(),
            respawned: HashSet::new(),
            broken: HashSet::new(),
            typing: HashMap::new(),
            pane_error: None,
            toasts: Toasts::default(),
            ready: None,
            env,
            zmx,
            attach,
            notifier,
            sounds,
            log,
            tz,
            tx,
            pane_area: Rect::default(),
            cell: CellSize::default(),
            cursor_style: SetCursorStyle::DefaultUserShape,
            sidebar_scroll: SidebarScroll::default(),
            picker_scroll: PickerScroll::default(),
            hits: HitMap::default(),
            clicks: Clicks::default(),
            held: HashMap::new(),
            focused: true,
            last_preview: None,
            outer,
            compositor: Compositor::default(),
        }
    }

    fn run(mut self, terminal: &mut OrbTerminal, rx: &Receiver<LoopEvent>) -> io::Result<()> {
        spawn_input_thread(self.tx.clone())?;
        let cell = outer_terminal::cell_size(terminal.backend_mut().window_size().ok());
        self.measure(terminal.size()?.into(), cell);
        let mut last_cursor = None;
        // The loop's own draw stores the layout this first frame returns.
        self.draw(terminal, &mut last_cursor)?;
        self.reattach_live();
        loop {
            let cell = outer_terminal::cell_size(terminal.backend_mut().window_size().ok());
            self.measure(terminal.size()?.into(), cell);
            let placed = {
                let state = self.state.read();
                state
                    .shown_layout()
                    .map(|layout| tabs::placement(&state, layout, self.pane_area).panes)
                    .unwrap_or_default()
            };
            for place in &placed {
                if let Some(pane) = self.panes.get_mut(&place.pane) {
                    pane.resize(PaneSize::new(place.content(), self.cell));
                }
            }
            let (sidebar_layout, picker_page) = self.draw(terminal, &mut last_cursor)?;
            // Navigation scrolls by what was just drawn.
            if let Some(layout) = sidebar_layout
                && self.state.read().sidebar.layout != layout
            {
                self.state.write().sidebar.layout = layout;
            }
            if let Some(page) = picker_page
                && self
                    .state
                    .read()
                    .picker
                    .as_ref()
                    .is_some_and(|picker| picker.page() != page)
                && let Some(picker) = &mut self.state.write().picker
            {
                picker.resize(page);
            }
            self.sync_cursor_style(terminal.backend_mut())?;
            if self.state.read().should_quit {
                return Ok(());
            }
            let first = match self.deadline() {
                Some(deadline) => {
                    match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(event) => Some(event),
                        Err(RecvTimeoutError::Timeout) => None,
                        Err(RecvTimeoutError::Disconnected) => return Ok(()),
                    }
                }
                None => match rx.recv() {
                    Ok(event) => Some(event),
                    Err(_) => return Ok(()),
                },
            };
            self.toasts.begin_turn();
            for event in first.into_iter().chain(rx.try_iter()) {
                self.handle(event, terminal.backend_mut())?;
            }
            self.refresh_preview();
            self.reconcile();
            self.open_ready();
            self.take_error();
            self.sync_focus();
            let now = Instant::now();
            for pane in self.panes.values() {
                pane.flush_expired_sync(now);
            }
        }
    }

    /// When the loop must wake without an event: a pane's synchronized
    /// update times out, a spinner frame passes while an agent is working
    /// or a session is starting, so the spinners and elapsed time tick, or
    /// the message box runs out, so it hides, or the session picker's preview
    /// waits to be read again, so a transcript that stopped growing still
    /// catches up; at once while pane image bytes wait for the next frame.
    fn deadline(&self) -> Option<Instant> {
        let tick = self
            .state
            .read()
            .sessions
            .spinning()
            .then(|| Instant::now() + SPINNER_FRAME);
        let sync = self.panes.values().filter_map(Pane::sync_deadline);
        let toast = self.toasts.deadline(Instant::now());
        let preview = stale_preview(&self.state.read())
            .map(|(agent, _)| preview_due(self.last_preview, agent, Instant::now()));
        let images = self.compositor.pending().then(Instant::now);
        tick.into_iter()
            .chain(sync)
            .chain(toast)
            .chain(preview)
            .chain(images)
            .min()
    }

    /// Lays the screen of `size` out: the tab body becomes the pane area,
    /// and the layouts measure their focus moves and resizes against it.
    /// Panes are told their cells are `cell` pixels.
    fn measure(&mut self, size: Rect, cell: CellSize) {
        self.cell = cell;
        let [_, right, _] = render::layout(size, &self.state.read().sidebar);
        let [_, body] = tabs::areas(right);
        self.pane_area = body;
        if self.state.read().layouts.body() != body {
            self.state.write().layouts.fit_to(body);
        }
    }

    /// The shown layout's focused pane while the keys are in a pane.
    fn attached_id(&self) -> Option<PaneId> {
        let state = self.state.read();
        match state.focus {
            Focus::Pane => state.shown_layout()?.focused(),
            Focus::Sidebar | Focus::Picker | Focus::Rename | Focus::Search => None,
        }
    }

    /// The pane that receives input: the shown layout's focused pane while
    /// the keys are in a pane.
    fn attached_pane(&self) -> Option<&Pane> {
        self.panes.get(&self.attached_id()?)
    }

    /// Gives a focus-in to the pane that has the keys, the shown layout's
    /// focused pane, and a focus-out to the one that had them.
    fn sync_focus(&mut self) {
        let want = self.attached_id();
        if want == self.focused_pane {
            return;
        }
        if let Some(pane) = self.focused_pane.and_then(|id| self.panes.get(&id)) {
            pane.focus(false);
        }
        if let Some(pane) = want.and_then(|id| self.panes.get(&id)) {
            pane.focus(true);
        }
        self.focused_pane = want;
    }

    /// Acts on a mouse event: forwards it to the focused pane, runs the
    /// intents it maps to (ending any key sequence in progress), scrolls the
    /// sidebar's view, sends a wheel notch to a pane, or starts, extends or
    /// copies a pane's selection, writing the copy to the clipboard through
    /// `out`. `pixel` is where it happened in pixels, when the outer terminal
    /// reports them; only a pane's program gets it.
    fn mouse<W>(
        &mut self,
        mouse: MouseEvent,
        pixel: Option<Position>,
        out: &mut W,
    ) -> io::Result<()>
    where
        W: Write,
    {
        let (focus, focused, cursor) = {
            let state = self.state.read();
            (
                state.focus,
                state.shown_layout().and_then(SessionLayout::focused),
                state.sessions.cursor,
            )
        };
        let now = Instant::now();
        let route = mouse::route(mouse, &self.hits, focus, focused, &mut self.clicks, now);
        let at = Position::new(mouse.column, mouse.row);
        match route {
            MouseRoute::Forward => {
                if let Some((pane, area)) = self.attached_id().and_then(|id| self.pane_and_area(id))
                {
                    pane.mouse(mouse, area, pixel);
                }
            }
            MouseRoute::Intents(intents) => self.run_mouse_intents(&intents),
            MouseRoute::Select(intents, id) => {
                self.run_mouse_intents(&intents);
                if let Some((pane, area)) = self.pane_and_area(id) {
                    pane.select_start(at, area, now);
                }
            }
            MouseRoute::Extend(id) => {
                if let Some((pane, area)) = self.pane_and_area(id) {
                    pane.select_update(at, area, now);
                }
            }
            MouseRoute::Copy(id) => {
                if let Some(text) = self.panes.get(&id).and_then(Pane::select_finish) {
                    outer_terminal::copy_to_clipboard(out, &text)?;
                    self.toasts.copied(now);
                }
            }
            MouseRoute::Wheel(id) => {
                if let Some((pane, area)) = self.pane_and_area(id) {
                    pane.wheel(mouse, area, pixel);
                }
            }
            MouseRoute::ScrollSidebar(lines) => {
                self.sidebar_scroll.scroll_free(lines, cursor);
            }
            MouseRoute::Nothing => {}
        }
        Ok(())
    }

    /// Ends the left drag under way as its release would have (copying a
    /// selection, saving a dragged float, telling the pane's program), once
    /// input shows the button is up although no release came. kitty reports
    /// a release above or left of its window in negative pixels, which
    /// crossterm drops; with the mouse in cells nothing changes.
    // ponytail: no drag reaches orb while the pointer is above or left of the window, so a selection doesn't scroll into the history there and its copy waits for the pointer to come back, a click or orb losing focus; read kitty's raw reports before crossterm if that matters.
    fn end_lost_release<W>(&mut self, out: &mut W) -> io::Result<()>
    where
        W: Write,
    {
        let area = self.attached_id().and_then(|id| self.hits.pane_area(id));
        match self.clicks.lost_release(area) {
            Some(release) if self.outer.pixel_mouse() => {
                // The release cell's top-left pixel, inside the pane as well.
                let pixel = Position::new(
                    release.column.saturating_mul(self.cell.width),
                    release.row.saturating_mul(self.cell.height),
                );
                self.mouse(release, Some(pixel), out)
            }
            _ => Ok(()),
        }
    }

    /// Pane `id` and where the last frame drew it.
    fn pane_and_area(&self, id: PaneId) -> Option<(&Pane, Rect)> {
        Some((self.panes.get(&id)?, self.hits.pane_area(id)?))
    }

    /// Runs a mouse event's intents, ending any key sequence in progress and
    /// any pane mode.
    fn run_mouse_intents(&mut self, intents: &[Intent]) {
        if intents.is_empty() {
            return;
        }
        self.keys.dismiss();
        let state = self.state.clone();
        handle_mouse_intents(&state, intents, |command| self.execute(command));
        self.toasts.dismiss();
    }

    /// Acts on a key: a release reaches the pane that got that key's last
    /// press, if it did, and nothing else; a press or repeat goes through
    /// orb's keys, and only what they hand on reaches the pane.
    fn key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            if let Some(pane) = self
                .held
                .remove(&key.code)
                .and_then(|id| self.panes.get(&id))
            {
                pane.key(&key);
            }
            return;
        }
        let (focus, mode, list_intent) = {
            let state = self.state.read();
            let list_intent = state
                .picker
                .as_ref()
                .filter(|picker| picker.listing())
                .map(|picker| keymap::picker_list_route(picker.kind(), key));
            (state.focus, state.pane_mode(), list_intent)
        };
        let mut forwarded = None;
        let intent = match (focus, mode) {
            // A list-mode picker takes letters as commands until `/`.
            (Focus::Picker, _) if list_intent.is_some() => list_intent.flatten(),
            // The rename box and the search take the picker's keys.
            (Focus::Picker | Focus::Rename | Focus::Search, _) => keymap::picker_route(key),
            (Focus::Pane, Some(mode)) => {
                // A pane mode takes every key; none reaches the pane's program.
                self.keys.dismiss();
                keymap::mode_route(mode, key)
            }
            (Focus::Sidebar | Focus::Pane, _) => {
                match keymap::route(key, focus == Focus::Pane, self.keys.is_pending()) {
                    Route::Intent(intent) => {
                        // An Alt key or a jump ends any key sequence in progress.
                        self.keys.dismiss();
                        Some(intent)
                    }
                    Route::Keymap => {
                        // Focus and the selection also change outside
                        // intents (the pane exits, a new session attaches).
                        let scope = Scope::of(focus, &self.state.read());
                        if *self.keys.scope() != scope {
                            self.keys.set_scope(scope);
                        }
                        keymap::press(&mut self.keys, key)
                    }
                    Route::Forward => {
                        forwarded = self.attached_id().filter(|id| self.panes.contains_key(id));
                        if let Some(pane) = forwarded.and_then(|id| self.panes.get(&id)) {
                            pane.key(&key);
                        }
                        None
                    }
                }
            }
        };
        // ponytail: keyed by key code alone, so a release whose case differs from its press (Shift pressed mid-hold) is dropped; key by the unshifted key if that ever shows.
        match (forwarded, key.kind) {
            (Some(id), _) => {
                self.held.insert(key.code, id);
            }
            // orb took this press: its release must not reach any pane.
            (None, KeyEventKind::Press) => {
                self.held.remove(&key.code);
            }
            // A repeat orb took (the keys moved off the pane mid-hold) leaves
            // the release with the pane that got the press.
            (None, _) => {}
        }
        if let Some(intent) = intent {
            let commands = IntentHandler::handle(&intent, &mut self.state.write());
            self.toasts.dismiss();
            for command in &commands {
                self.execute(command);
            }
        }
    }

    fn handle<W>(&mut self, event: LoopEvent, out: &mut W) -> io::Result<()>
    where
        W: Write,
    {
        match event {
            LoopEvent::Input(Event::Key(key)) => self.key(key),
            LoopEvent::Input(Event::Paste(text)) => {
                if let Some(pane) = self.attached_pane() {
                    pane.paste(&text);
                }
            }
            LoopEvent::Input(Event::Mouse(mouse)) if self.outer.pixel_mouse() => {
                if let Some((mouse, pixel)) = mouse::from_pixels(mouse, self.cell) {
                    // Motion with no button held, or a new left press: the
                    // left button is up.
                    if matches!(
                        mouse.kind,
                        MouseEventKind::Moved | MouseEventKind::Down(MouseButton::Left)
                    ) {
                        self.end_lost_release(out)?;
                    }
                    self.mouse(mouse, Some(pixel), out)?;
                }
            }
            LoopEvent::Input(Event::Mouse(mouse)) => self.mouse(mouse, None, out)?,
            LoopEvent::Input(Event::FocusGained) => {
                self.focused = true;
                if let Some(pane) = self.attached_pane() {
                    pane.focus(true);
                }
            }
            LoopEvent::Input(Event::FocusLost) => {
                self.end_lost_release(out)?;
                self.focused = false;
                if let Some(pane) = self.attached_pane() {
                    pane.focus(false);
                }
            }
            // Resize and the rest: the next iteration lays out and redraws;
            // `reconcile` sweeps exited agent panes.
            LoopEvent::Pane(id, PaneEvent::Output) => self.type_resume(id),
            LoopEvent::Input(_) => {}
            LoopEvent::Pane(id, PaneEvent::Broken) => self.drop_broken(id),
            LoopEvent::Reported(outcome) => self.apply(outcome),
            LoopEvent::Quit => {
                IntentHandler::handle(&Intent::Quit, &mut self.state.write());
            }
            LoopEvent::Pane(id, PaneEvent::Exited) => self.exited.push(id),
            LoopEvent::InputFailed(error) => return Err(error),
            LoopEvent::Pane(_, PaneEvent::Clipboard(text)) => {
                outer_terminal::copy_to_clipboard(out, &text)?;
            }
            LoopEvent::Control(request, reply) => self.control(request, &reply),
        }
        Ok(())
    }

    fn execute(&mut self, command: &Command) {
        match command {
            Command::Attach(session) => {
                let (dir, panes) = {
                    let app = self.state.read();
                    (
                        app.sessions
                            .session(*session)
                            .map(|shown| shown.dir.clone()),
                        app.layouts.session_panes(*session),
                    )
                };
                let live = panes
                    .iter()
                    .any(|id| self.panes.get(id).is_some_and(|pane| !pane.has_exited()));
                if !live
                    && dir.is_some_and(|dir| {
                        attach_or_restore(&dir, &self.worktrees_root) == AttachPlan::Restore
                    })
                {
                    {
                        let mut app = self.state.write();
                        app.focus = Focus::Sidebar;
                        app.attached.remove(session);
                        // One start at a time, as for a new session.
                        if validate_new_session(&app).is_err() {
                            return;
                        }
                        app.sessions.starting = true;
                    }
                    let command = SessionsCommand::RestoreWorktree(*session);
                    let sent = self.sessions.tell(command.clone()).try_send();
                    log_unsent(&self.log, "sessions", &command, sent);
                    return;
                }
                self.pane_error = None;
                self.reconcile();
                self.sync_focus();
            }
            Command::Detach => self.sync_focus(),
            Command::SendCtrlG => {
                if let Some(pane) = self.attached_pane() {
                    pane.key(&KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL));
                }
            }
            Command::ListBranches(cwd) => {
                let refs = self.git.refs(cwd);
                let mut app = self.state.write();
                match refs {
                    Ok(refs) => {
                        if let Some(picker) = &mut app.picker {
                            picker.show_branches(cwd, refs);
                        }
                    }
                    Err(report) => {
                        if let Some(picker) = app.picker.take() {
                            app.focus = picker.return_to();
                        }
                        app.sessions.error = Some(git_reason(&report));
                    }
                }
            }
            Command::ListDirectories(dir) => {
                let names = list_directories(dir);
                if let Some(picker) = &mut self.state.write().picker {
                    picker.show_directories(dir, names);
                }
            }
            Command::LoadPreview { agent, transcript } => {
                self.load_preview(*agent, transcript);
            }
            Command::Sessions(command) => {
                let sent = self.sessions.tell(command.clone()).try_send();
                log_unsent(&self.log, "sessions", command, sent);
            }
            Command::Worktrees(command) => {
                let sent = self.worktrees.tell(command.clone()).try_send();
                log_unsent(&self.log, "worktrees", command, sent);
            }
            Command::Search(command) => {
                let sent = self.search.tell(command.clone()).try_send();
                log_unsent(&self.log, "search", command, sent);
            }
        }
    }

    /// Reads `agent`'s transcript, in its harness's format, into the open
    /// picker's preview. An unreadable transcript, or one whose harness orb
    /// doesn't know, gives an empty preview, which shows as no transcript;
    /// an unreadable one is logged, once per agent until its text changes.
    fn load_preview(&mut self, agent: AgentId, transcript: &Path) {
        let harness = self
            .state
            .read()
            .sessions
            .all_agents()
            .find(|candidate| candidate.id == agent)
            .and_then(|found| self.harnesses.get(&found.harness).cloned());
        let (len, exchanges) = match harness.map(|harness| harness.exchanges(transcript)) {
            Some(Ok(read)) => read,
            Some(Err(report)) => {
                self.log.error_on_change(
                    &format!("preview read {}", agent.0),
                    &unreadable_transcript(agent, transcript),
                    &report,
                );
                Default::default()
            }
            None => Default::default(),
        };
        if let Some(picker) = &mut self.state.write().picker {
            picker.show_preview(agent, len, exchanges);
        }
        self.last_preview = Some((agent, Instant::now()));
    }

    /// Reads the session picker's preview again when the selected agent's
    /// transcript isn't the length it was read at: it grew while the agent
    /// works, or it was found or replaced (`/clear`) since. The same agent
    /// is read at most once every [`PREVIEW_EVERY`]; the loop's deadline
    /// wakes it for the next read.
    fn refresh_preview(&mut self) {
        let now = Instant::now();
        let stale = stale_preview(&self.state.read());
        if let Some((agent, transcript)) = stale
            && preview_due(self.last_preview, agent, now) <= now
        {
            self.load_preview(agent, &transcript);
        }
    }

    /// Draws one frame. The terminal shows only the finished frame, the
    /// panes' images placed in the same update as the cells, and a
    /// hidden cursor goes back to `last_cursor`, where it last showed, so it
    /// never visibly moves. Returns the sidebar's layout and the picker's page.
    fn draw(
        &mut self,
        terminal: &mut OrbTerminal,
        last_cursor: &mut Option<Position>,
    ) -> io::Result<(Option<SidebarLayout>, Option<usize>)> {
        let now = SystemTime::now();
        let mut drawn = (None, None, None);
        self.sidebar_scroll
            .follow_keys(self.state.read().focus == Focus::Sidebar);
        let mut images = Vec::new();
        ratatui::crossterm::queue!(terminal.backend_mut(), BeginSynchronizedUpdate)?;
        terminal.draw(|frame| {
            let state = self.state.read();
            drawn = render::render(
                frame,
                &state,
                &self.panes,
                self.pane_error.as_deref(),
                self.toasts.shown(Instant::now()),
                &self.keys,
                now,
                &self.tz,
                self.outer.orb_background(),
                &mut self.sidebar_scroll,
                &mut self.picker_scroll,
                &mut self.hits,
                &mut images,
            );
        })?;
        self.compositor
            .compose(terminal.backend_mut(), &images, &self.panes)?;
        let (sidebar_layout, picker_page, cursor) = drawn;
        match (cursor, *last_cursor) {
            (Some(_), _) => *last_cursor = cursor,
            (None, Some(parked)) => terminal.set_cursor_position(parked)?,
            (None, None) => {}
        }
        ratatui::crossterm::execute!(terminal.backend_mut(), EndSynchronizedUpdate)?;
        Ok((sidebar_layout, picker_page))
    }

    /// Shows the cursor shape for where the keys are in the outer terminal.
    fn sync_cursor_style<W>(&mut self, out: &mut W) -> io::Result<()>
    where
        W: Write,
    {
        let style = {
            let focus = self.state.read().focus;
            cursor_style(focus, self.attached_pane().map(Pane::cursor_style))
        };
        if style == self.cursor_style {
            return Ok(());
        }
        self.cursor_style = style;
        outer_terminal::set_cursor_style(out, style)
    }
}

/// Logs a command that didn't reach the `actor` actor: which kind of command
/// it was and why, not what it carried (a search holds the user's text).
fn log_unsent<C, E>(log: &Log, actor: &str, command: &C, sent: Result<(), E>)
where
    C: std::fmt::Debug,
    E: std::fmt::Display,
{
    if let Err(error) = sent {
        let shown = format!("{command:?}");
        let kind = shown
            .split(|c: char| !c.is_alphanumeric())
            .next()
            .unwrap_or_default();
        log.line(
            "error",
            &format!("couldn't send {kind} to the {actor} actor: {error}"),
        );
    }
}

/// The names of `dir`'s subdirectories, symlinked ones included. Names that
/// aren't UTF-8 are skipped, and an unreadable `dir` has none.
fn list_directories(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| fs::metadata(entry.path()).is_ok_and(|metadata| metadata.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect()
}

/// The session picker's selected agent and its transcript, when the
/// transcript's length isn't the one its preview was read at. A transcript
/// that can't be measured is left alone, and so is every other picker: the
/// search picker's previews come from the search index.
fn stale_preview(state: &AppState) -> Option<(AgentId, PathBuf)> {
    let picker = state
        .picker
        .as_ref()
        .filter(|picker| matches!(picker.kind(), PickerKind::Sessions { .. }))?;
    let id = picker.selected_agent_id()?;
    let transcript = state
        .sessions
        .all_agents()
        .find(|agent| agent.id == id)?
        .transcript
        .as_ref()?;
    let len = fs::metadata(transcript).ok()?.len();
    picker.wants_preview(len).then(|| (id, transcript.clone()))
}

/// When the preview of `agent` may be read: at once for an agent other than
/// the one `last` read, else [`PREVIEW_EVERY`] after that read.
fn preview_due(last: Option<(AgentId, Instant)>, agent: AgentId, now: Instant) -> Instant {
    match last {
        Some((read, at)) if read == agent => at + PREVIEW_EVERY,
        _ => now,
    }
}

/// Reads terminal events on a background thread and sends them to the loop.
fn spawn_input_thread(tx: Sender<LoopEvent>) -> io::Result<()> {
    thread::Builder::new()
        .name("orb-input".into())
        .spawn(move || {
            loop {
                match event::read() {
                    Ok(event) => {
                        if tx.send(LoopEvent::Input(event)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = tx.send(LoopEvent::InputFailed(error));
                        break;
                    }
                }
            }
        })
        .map(drop)
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate file failures with `?` and assert on the outcome"
)]
mod tests;
