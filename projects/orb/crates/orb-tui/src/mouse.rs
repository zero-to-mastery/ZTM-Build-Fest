//! The mouse in orb's own UI: a click on the sidebar moves the keys there,
//! a click on a row selects it and a double-click attaches, and a click on
//! the sidebar's input box starts a search. A click on a tab in the tab bar,
//! or on a chip counting hidden tabs, shows that tab with the keys in its
//! focused pane, and a click on its `+` opens a tab; the wheel over the bar
//! shows the next tab on a scroll up and the previous on a scroll down. A
//! click on a row of a stack's list focuses its pane, and the wheel over the
//! list shows the next stacked pane on a scroll down and the previous on a
//! scroll up, leaving the keys where they are. The tiled pane frames and the
//! start screen take no clicks. A press on a float's border brings it to the
//! top with the keys and the drag moves it inside the tab body; the release
//! saves. A click on a float focuses it and brings it to the top; a click on
//! a tiled pane hides the floats. Where floats overlap panes, the topmost
//! one takes the click and the wheel. The wheel over the sidebar scrolls its
//! view and never moves the selection, wherever the keys are. In a picker a
//! click selects a row, a double-click picks it and the wheel over
//! its list moves the selection; a click outside a picker or the rename box
//! closes it like `Esc`. A click in the text of the sidebar search, a
//! picker's input or the rename box moves its cursor there.
//!
//! The wheel over any pane goes to its program
//! while the program reads the mouse, sends arrow keys while it's on the
//! alternate screen, and otherwise scrolls the pane's history. A left press
//! on the focused pane goes to its program while it reads the mouse, and
//! otherwise starts a selection that the drag extends and the release
//! copies. A press on another pane focuses it without reaching its program,
//! and starts a selection there unless its program reads the mouse. The
//! press decides who gets the drag and the release that follow it.
//!
//! Each frame records where it drew what a click can land on, and a mouse
//! event is mapped back through that record. In kitty the mouse arrives in
//! pixels; it's mapped to cells first, and the pixels go on with it to a
//! pane's program.

use std::time::{Duration, Instant};

use orb_domain::feat::sessions::state::SidebarItem;
use orb_domain::ids::PaneId;
use orb_domain::{Focus, Intent};
use orb_term::CellSize;
use ratatui::crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::{Position, Rect};

use crate::picker::grapheme_at;

/// Two clicks on the same target closer than this are a double-click
/// (neovim's `mousetime`).
const DOUBLE_CLICK: Duration = Duration::from_millis(500);
/// How many lines a wheel notch scrolls the sidebar's view.
const WHEEL_LINES: i16 = 3;

/// Where the last frame drew what a click can land on. Rebuilt every frame.
#[derive(Debug, Default)]
pub(crate) struct HitMap {
    /// The sidebar; empty while it's hidden.
    sidebar: Rect,
    /// The right side: the shown session's tabs or the start screen.
    right: Rect,
    /// The sidebar's input box.
    sidebar_input: Option<Rect>,
    /// Each on-screen sidebar row's visible lines.
    sidebar_rows: Vec<(Rect, SidebarItem)>,
    /// Each shown pane's content area, and whether its program read the
    /// mouse when it was drawn.
    panes: Vec<(Rect, PaneId, bool)>,
    /// The open picker's or rename box's popup.
    overlay: Option<Rect>,
    /// Where the wheel moves the open picker's selection: its popup, or the
    /// session or worktree picker's list box.
    selector: Option<Rect>,
    /// Each selectable picker row's line and its index into the picker's
    /// shown rows.
    picker_rows: Vec<(Rect, usize)>,
    /// The text line of the input that has the keys: the sidebar search, a
    /// picker's input or the rename box.
    text: Option<TextHit>,
    /// The tab bar's row, the shown tab's 0-based index and the tab count.
    tab_bar: Option<(Rect, usize, usize)>,
    /// Each tab chevron or overflow chip: its cells, the 0-based tab it
    /// shows and that tab's focused pane.
    tab_targets: Vec<(Rect, usize, PaneId)>,
    /// The tab bar's `+` chevron.
    new_tab: Option<Rect>,
    /// Each stack's list, its stacked panes in order and the shown one.
    stacks: Vec<(Rect, Vec<PaneId>, PaneId)>,
    /// Each drawn float's frame (border included) and pane, bottom first.
    floats: Vec<(Rect, PaneId)>,
}

/// The text line of the input that has the keys, and what `visible` drew
/// its text from.
#[derive(Debug)]
struct TextHit {
    /// The input's line, its prompt included.
    line: Rect,
    /// How many columns the prompt takes before the text.
    prompt: usize,
    /// The typed text.
    text: String,
    /// The cursor, as a grapheme index into `text`.
    cursor: usize,
    /// The columns `visible` was given for the text.
    room: usize,
}

impl HitMap {
    /// A frame's empty hit map, with the sidebar and the right side where
    /// the layout put them.
    pub(crate) fn new(sidebar: Rect, right: Rect) -> Self {
        Self {
            sidebar,
            right,
            ..Self::default()
        }
    }

    /// Records where the sidebar's input box was drawn.
    pub(crate) fn record_sidebar_input(&mut self, area: Rect) {
        self.sidebar_input = Some(area);
    }

    /// Records the visible lines of a sidebar row.
    pub(crate) fn record_row(&mut self, area: Rect, item: SidebarItem) {
        self.sidebar_rows.push((area, item));
    }

    /// Records where pane `id` was drawn and whether its program read the
    /// mouse.
    pub(crate) fn record_pane(&mut self, area: Rect, id: PaneId, reads_mouse: bool) {
        self.panes.push((area, id, reads_mouse));
    }

    /// Records where float `pane` was drawn, its frame included, above
    /// everything recorded before it.
    pub(crate) fn record_float(&mut self, frame: Rect, pane: PaneId) {
        self.floats.push((frame, pane));
    }

    /// The topmost float whose frame is at `at`: its frame and pane.
    fn float_at(&self, at: Position) -> Option<(Rect, PaneId)> {
        self.floats
            .iter()
            .rev()
            .find(|(frame, _)| frame.contains(at))
            .copied()
    }

    /// The pane drawn on top at `at`, if any: inside a float's frame only
    /// that float's content counts, so its border is no pane.
    pub(crate) fn pane_at(&self, at: Position) -> Option<PaneId> {
        if let Some((_, float)) = self.float_at(at) {
            return self
                .panes
                .iter()
                .any(|&(area, id, _)| id == float && area.contains(at))
                .then_some(float);
        }
        self.panes
            .iter()
            .rev()
            .find(|(area, ..)| area.contains(at))
            .map(|&(_, id, _)| id)
    }

    /// Where pane `id` was drawn, if it was.
    pub(crate) fn pane_area(&self, id: PaneId) -> Option<Rect> {
        self.panes
            .iter()
            .rev()
            .find(|(_, pane, _)| *pane == id)
            .map(|&(area, ..)| area)
    }

    /// Whether pane `id`'s program read the mouse when it was drawn.
    fn reads_mouse(&self, id: PaneId) -> bool {
        self.panes
            .iter()
            .any(|&(_, pane, reads)| pane == id && reads)
    }

    /// The sidebar row drawn at `at`, if any.
    pub(crate) fn row_at(&self, at: Position) -> Option<SidebarItem> {
        self.sidebar_rows
            .iter()
            .find(|(area, _)| area.contains(at))
            .map(|&(_, item)| item)
    }

    /// Whether `at` is on the sidebar's input box.
    pub(crate) fn on_sidebar_input(&self, at: Position) -> bool {
        self.sidebar_input.is_some_and(|area| area.contains(at))
    }

    /// Records the tab bar's row, with the shown tab's 0-based index and
    /// the tab count.
    pub(crate) fn record_tab_bar(&mut self, area: Rect, active: usize, count: usize) {
        self.tab_bar = Some((area, active, count));
    }

    /// Records a tab chevron or overflow chip that shows tab `index`
    /// (0-based), whose focused pane is `pane`.
    pub(crate) fn record_tab(&mut self, area: Rect, index: usize, pane: PaneId) {
        self.tab_targets.push((area, index, pane));
    }

    /// Records the tab bar's `+` chevron.
    pub(crate) fn record_new_tab(&mut self, area: Rect) {
        self.new_tab = Some(area);
    }

    /// Records a stack's list `area`, its panes in stack `order` and the
    /// `shown` one, beside any stack already recorded.
    pub(crate) fn record_stack(&mut self, area: Rect, order: Vec<PaneId>, shown: PaneId) {
        self.stacks.push((area, order, shown));
    }

    /// Records where the open picker or rename box was drawn.
    pub(crate) fn record_overlay(&mut self, area: Rect) {
        self.overlay = Some(area);
    }

    /// Records where the wheel moves the open picker's selection.
    pub(crate) fn record_selector(&mut self, area: Rect) {
        self.selector = Some(area);
    }

    /// Records the line of the picker row shown at `index`.
    pub(crate) fn record_picker_row(&mut self, area: Rect, index: usize) {
        self.picker_rows.push((area, index));
    }

    /// Whether `at` is on the open picker or rename box.
    pub(crate) fn on_overlay(&self, at: Position) -> bool {
        self.overlay.is_some_and(|area| area.contains(at))
    }

    /// Whether the wheel at `at` moves the open picker's selection.
    pub(crate) fn on_selector(&self, at: Position) -> bool {
        self.selector.is_some_and(|area| area.contains(at))
    }

    /// The shown index of the picker row drawn at `at`, if any.
    pub(crate) fn picker_row_at(&self, at: Position) -> Option<usize> {
        self.picker_rows
            .iter()
            .find(|(area, _)| area.contains(at))
            .map(|&(_, index)| index)
    }

    /// Records the input line `line`, whose text follows `prompt` columns
    /// and was drawn by `visible(text, cursor, room)`.
    pub(crate) fn record_text(
        &mut self,
        line: Rect,
        prompt: usize,
        text: &str,
        cursor: usize,
        room: usize,
    ) {
        self.text = Some(TextHit {
            line,
            prompt,
            text: text.to_owned(),
            cursor,
            room,
        });
    }

    /// The grapheme of the input's text drawn at `at`: the first shown one
    /// when `at` is on the prompt, the text's length past its end. `None` off
    /// the input's line.
    pub(crate) fn text_at(&self, at: Position) -> Option<usize> {
        let hit = self.text.as_ref().filter(|hit| hit.line.contains(at))?;
        let column = usize::from(at.x - hit.line.x).saturating_sub(hit.prompt);
        Some(grapheme_at(&hit.text, hit.cursor, hit.room, column))
    }
}

/// What a click can double on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClickTarget {
    /// A sidebar row.
    Row(SidebarItem),
    /// A picker row, by its index into the picker's shown rows.
    PickerRow(usize),
}

/// Whether a click is the first or the second of a double-click.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Click {
    Single,
    Double,
}

/// The last click, for telling a double-click, and the left-button drag in
/// progress.
#[derive(Debug, Default)]
pub(crate) struct Clicks {
    last: Option<(Instant, ClickTarget)>,
    gesture: Option<Gesture>,
    /// The cell of the last mouse event, so motion within one cell acts once.
    at: Option<Position>,
}

/// Who owns a left-button drag: decided at its press, kept until release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gesture {
    /// The focused pane's program reads the mouse; the drag and release go
    /// to it.
    Program,
    /// orb is selecting in this pane.
    Select(PaneId),
    /// The press acted on orb (focus, a sidebar row, a picker); its drag and
    /// release do nothing.
    Orb,
    /// orb is moving this float; its frame was grabbed `dx`, `dy` cells from
    /// its top-left corner.
    Drag { pane: PaneId, dx: u16, dy: u16 },
}

impl Clicks {
    /// A left click on `target` (`None`: on anything else) at `now`: `Double`
    /// when the last click hit the same target less than 500 ms ago, which
    /// then starts over; else `Single`, remembered when it hit a target.
    pub(crate) fn click(&mut self, target: Option<ClickTarget>, now: Instant) -> Click {
        let double = matches!(
            (self.last, target),
            (Some((then, last)), Some(target))
                if last == target && now.duration_since(then) < DOUBLE_CLICK
        );
        if double {
            self.last = None;
            Click::Double
        } else {
            self.last = target.map(|target| (now, target));
            Click::Single
        }
    }

    /// The left release a drag under way never got, for when input shows
    /// the button is up anyway: at the drag's last cell, moved inside `area`
    /// (the pane holding the keys, when there is one) the way kitty keeps a
    /// release inside its window. `None` while no drag is under way.
    pub(crate) fn lost_release(&self, area: Option<Rect>) -> Option<MouseEvent> {
        let at = self.at.filter(|_| self.gesture.is_some())?;
        let at = area.map_or(at, |area| {
            Rect::new(at.x, at.y, 1, 1).clamp(area).as_position()
        });
        Some(MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column: at.x,
            row: at.y,
            modifiers: KeyModifiers::NONE,
        })
    }
}

/// What the frontend loop does with a mouse event.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MouseRoute {
    /// Pass it to the attached pane.
    Forward,
    /// Handle these intents in order, as if keys asked for them.
    Intents(Vec<Intent>),
    /// Scroll the sidebar's view this many lines (up when negative) without
    /// moving its selection.
    ScrollSidebar(i16),
    /// Run these intents, then start a selection in this pane at the event.
    Select(Vec<Intent>, PaneId),
    /// Extend this pane's selection to the event.
    Extend(PaneId),
    /// End this pane's selection and copy its text.
    Copy(PaneId),
    /// A wheel notch over this pane.
    Wheel(PaneId),
    /// Ignore it.
    Nothing,
}

/// The mouse event acts as a left click or a wheel notch (`1` down, `-1` up).
enum Action {
    Click,
    Wheel(i16),
}

/// Maps a mouse event to what the loop does with it, given where the last
/// frame drew things (`hits`), who has the keys, and the shown layout's
/// `focused` pane. The left press decides who gets the drag and release
/// after it; the wheel over a pane goes to that pane. Other events over the
/// focused pane while the keys are in it go to it; other than that, only
/// left clicks and the vertical wheel act. Motion within the cell of the
/// event before it (which the outer terminal reports when it reports
/// pixels) only goes on to the focused pane's program.
pub(crate) fn route(
    event: MouseEvent,
    hits: &HitMap,
    focus: Focus,
    focused: Option<PaneId>,
    clicks: &mut Clicks,
    now: Instant,
) -> MouseRoute {
    let at = Position::new(event.column, event.row);
    let same_cell = clicks.at.replace(at) == Some(at)
        && matches!(event.kind, MouseEventKind::Moved | MouseEventKind::Drag(_));
    match route_event(event, at, hits, focus, focused, clicks, now) {
        MouseRoute::Forward => MouseRoute::Forward,
        _ if same_cell => MouseRoute::Nothing,
        routed => routed,
    }
}

/// [`route`] for an event at `at`, whatever came before it.
fn route_event(
    event: MouseEvent,
    at: Position,
    hits: &HitMap,
    focus: Focus,
    focused: Option<PaneId>,
    clicks: &mut Clicks,
    now: Instant,
) -> MouseRoute {
    if let Some(routed) = follow_gesture(event.kind, at, clicks) {
        return routed;
    }
    if let MouseEventKind::Down(MouseButton::Left) = event.kind
        && let Some(routed) = press_frame(at, hits, focus, clicks, now)
    {
        return routed;
    }
    let on_focused = focused.is_some() && hits.pane_at(at) == focused;
    let in_pane = focus == Focus::Pane && on_focused;
    match (event.kind, focused) {
        (MouseEventKind::Down(MouseButton::Left), Some(id)) if in_pane => {
            return press_in_pane(id, hits, clicks);
        }
        (MouseEventKind::ScrollUp | MouseEventKind::ScrollDown, _)
            if !matches!(focus, Focus::Picker | Focus::Rename) =>
        {
            if hits.float_at(at).is_none()
                && let Some(routed) = route_stack(at, hits, event.kind)
            {
                return routed;
            }
            if let Some(id) = hits.pane_at(at) {
                return MouseRoute::Wheel(id);
            }
        }
        _ => {}
    }
    if in_pane {
        return MouseRoute::Forward;
    }
    let action = match event.kind {
        MouseEventKind::Down(MouseButton::Left) => Action::Click,
        MouseEventKind::ScrollDown => Action::Wheel(1),
        MouseEventKind::ScrollUp => Action::Wheel(-1),
        _ => return MouseRoute::Nothing,
    };
    if let Some(routed) = route_tab_bar(at, hits, focus, &action, clicks, now) {
        return routed;
    }
    match (focus, action) {
        (Focus::Picker | Focus::Rename, action) => {
            route_overlay(at, hits, focus, action, clicks, now)
        }
        (_, Action::Wheel(_)) if !hits.sidebar.contains(at) => MouseRoute::Nothing,
        (_, Action::Wheel(notch)) => MouseRoute::ScrollSidebar(notch * WHEEL_LINES),
        (_, Action::Click) => {
            let row = hits.row_at(at);
            let click = clicks.click(row.map(ClickTarget::Row), now);
            let routed = route_click(at, hits, focus, row, click);
            if let MouseRoute::Select(_, id) = routed {
                clicks.gesture = Some(Gesture::Select(id));
            }
            routed
        }
    }
}

/// Where a wheel notch over a stack's list goes: the next pane of that stack
/// on a scroll down, the previous on a scroll up, nothing at either end.
/// `None` off every list.
fn route_stack(at: Position, hits: &HitMap, kind: MouseEventKind) -> Option<MouseRoute> {
    let (_, order, shown) = hits.stacks.iter().find(|(area, ..)| area.contains(at))?;
    let next = order
        .iter()
        .position(|id| id == shown)
        .and_then(|at| match kind {
            MouseEventKind::ScrollDown => at.checked_add(1),
            _ => at.checked_sub(1),
        })
        .and_then(|at| order.get(at));
    Some(next.map_or(MouseRoute::Nothing, |&pane| {
        MouseRoute::Intents(vec![Intent::ShowStacked(pane)])
    }))
}

/// Where a click or wheel notch on the tab bar goes: a click on a tab or a chip
/// shows that tab with the keys in its focused pane, a click on `+` opens a
/// tab, and the wheel shows the next tab on a scroll up and the previous on a
/// scroll down, without wrapping. Other clicks on the bar do nothing. `None`
/// off the bar, or while a picker or the rename box is open (a click there
/// closes it).
fn route_tab_bar(
    at: Position,
    hits: &HitMap,
    focus: Focus,
    action: &Action,
    clicks: &mut Clicks,
    now: Instant,
) -> Option<MouseRoute> {
    if matches!(focus, Focus::Picker | Focus::Rename) {
        return None;
    }
    let (_, active, count) = hits.tab_bar.filter(|(bar, ..)| bar.contains(at))?;
    let lead = match focus {
        Focus::Search => vec![Intent::PickerConfirm],
        _ => vec![],
    };
    let target = hits
        .tab_targets
        .iter()
        .find(|(area, ..)| area.contains(at))
        .map(|&(_, index, pane)| (index, pane));
    let on_new_tab = hits.new_tab.is_some_and(|area| area.contains(at));
    Some(match (action, target, on_new_tab) {
        (Action::Wheel(-1), ..) if active + 1 < count => {
            MouseRoute::Intents(vec![Intent::GoToTab(active + 2)])
        }
        (Action::Wheel(1), ..) if active > 0 => MouseRoute::Intents(vec![Intent::GoToTab(active)]),
        (Action::Wheel(_), ..) => MouseRoute::Nothing,
        (Action::Click, Some((index, pane)), _) => {
            clicks.click(None, now);
            MouseRoute::Intents(
                lead.into_iter()
                    .chain([Intent::GoToTab(index + 1), Intent::FocusPane(pane)])
                    .collect(),
            )
        }
        (Action::Click, None, true) => {
            clicks.click(None, now);
            MouseRoute::Intents(lead.into_iter().chain([Intent::NewTab]).collect())
        }
        (Action::Click, None, false) => {
            clicks.click(None, now);
            MouseRoute::Nothing
        }
    })
}

/// Routes a left drag or release by the gesture its press started, and
/// forgets the gesture on release; `None` when the gesture doesn't decide.
/// A left press starts a new gesture (owned by orb until a pane takes it),
/// dropping one whose release never came. While orb selects, nothing else
/// acts. While orb drags a float, the drag moves it by where its frame was
/// grabbed and the release saves it.
fn follow_gesture(kind: MouseEventKind, at: Position, clicks: &mut Clicks) -> Option<MouseRoute> {
    let gesture = clicks.gesture;
    match (kind, gesture) {
        (MouseEventKind::Down(MouseButton::Left), _) => {
            clicks.gesture = Some(Gesture::Orb);
            None
        }
        (MouseEventKind::Up(MouseButton::Left), _) => {
            clicks.gesture = None;
            match gesture {
                Some(Gesture::Select(id)) => Some(MouseRoute::Copy(id)),
                Some(Gesture::Drag { .. }) => Some(MouseRoute::Intents(vec![Intent::DropFloat])),
                Some(Gesture::Orb) => Some(MouseRoute::Nothing),
                Some(Gesture::Program) | None => None,
            }
        }
        (MouseEventKind::Drag(MouseButton::Left), Some(Gesture::Select(id))) => {
            Some(MouseRoute::Extend(id))
        }
        (MouseEventKind::Drag(MouseButton::Left), Some(Gesture::Drag { pane, dx, dy })) => {
            Some(MouseRoute::Intents(vec![Intent::DragFloat {
                pane,
                x: at.x.saturating_sub(dx),
                y: at.y.saturating_sub(dy),
            }]))
        }
        (MouseEventKind::Drag(MouseButton::Left), Some(Gesture::Orb))
        | (_, Some(Gesture::Select(_))) => Some(MouseRoute::Nothing),
        _ => None,
    }
}

/// A left press on a drawn float's border, outside a picker or the rename
/// box: brings the float to the top with the keys (confirming a search
/// first) and starts dragging it. `None` anywhere else.
fn press_frame(
    at: Position,
    hits: &HitMap,
    focus: Focus,
    clicks: &mut Clicks,
    now: Instant,
) -> Option<MouseRoute> {
    if matches!(focus, Focus::Picker | Focus::Rename) || hits.pane_at(at).is_some() {
        return None;
    }
    let (frame, pane) = hits.float_at(at)?;
    clicks.click(None, now);
    clicks.gesture = Some(Gesture::Drag {
        pane,
        dx: at.x - frame.x,
        dy: at.y - frame.y,
    });
    let lead = match focus {
        Focus::Search => Some(Intent::PickerConfirm),
        _ => None,
    };
    Some(intents([lead, Some(Intent::FocusPane(pane))]))
}

/// A left press on the focused pane while it has the keys: its program's
/// when it reads the mouse, else the start of orb's selection.
fn press_in_pane(id: PaneId, hits: &HitMap, clicks: &mut Clicks) -> MouseRoute {
    if hits.reads_mouse(id) {
        clicks.gesture = Some(Gesture::Program);
        MouseRoute::Forward
    } else {
        clicks.gesture = Some(Gesture::Select(id));
        MouseRoute::Select(Vec::new(), id)
    }
}

/// `lead`, then a focus on the pane at `at`, which also starts a selection
/// there unless its program reads the mouse; just `lead` off any pane.
fn focus_pane_at(at: Position, hits: &HitMap, lead: Vec<Intent>) -> MouseRoute {
    let Some(id) = hits.pane_at(at) else {
        return if lead.is_empty() {
            MouseRoute::Nothing
        } else {
            MouseRoute::Intents(lead)
        };
    };
    let mut intents = lead;
    intents.push(Intent::FocusPane(id));
    if hits.reads_mouse(id) {
        MouseRoute::Intents(intents)
    } else {
        MouseRoute::Select(intents, id)
    }
}

/// Where a click or wheel notch at `at` goes while a picker or the rename
/// box has the keys: a click outside the popup cancels it, a click on a
/// picker row selects it and a double-click picks it, a click in the
/// input's text moves its cursor there, and the wheel over a picker's list
/// moves its selection. Before the popup is drawn, nothing.
fn route_overlay(
    at: Position,
    hits: &HitMap,
    focus: Focus,
    action: Action,
    clicks: &mut Clicks,
    now: Instant,
) -> MouseRoute {
    if hits.overlay.is_none() {
        return MouseRoute::Nothing;
    }
    match (action, hits.on_overlay(at), focus) {
        (Action::Wheel(notch), _, Focus::Picker) if hits.on_selector(at) => match notch {
            1 => MouseRoute::Intents(vec![Intent::PickerWheelNext]),
            _ => MouseRoute::Intents(vec![Intent::PickerWheelPrev]),
        },
        (Action::Wheel(_), ..) => MouseRoute::Nothing,
        (Action::Click, false, _) => {
            clicks.click(None, now);
            MouseRoute::Intents(vec![Intent::PickerCancel])
        }
        (Action::Click, true, _) => {
            let row = hits.picker_row_at(at);
            let click = clicks.click(row.map(ClickTarget::PickerRow), now);
            match (row, hits.text_at(at)) {
                (Some(index), _) => intents([
                    Some(Intent::PickerSelectRow(index)),
                    (click == Click::Double).then_some(Intent::PickerConfirm),
                ]),
                (None, Some(grapheme)) => {
                    MouseRoute::Intents(vec![Intent::PickerCursorTo(grapheme)])
                }
                (None, None) => MouseRoute::Nothing,
            }
        }
    }
}

/// Where a left click at `at` sends the keys and what it selects; `row` is
/// the sidebar row under it. A click on a pane focuses it, and starts a
/// selection there unless its program reads the mouse.
fn route_click(
    at: Position,
    hits: &HitMap,
    focus: Focus,
    row: Option<SidebarItem>,
    click: Click,
) -> MouseRoute {
    let attach = (click == Click::Double).then_some(Intent::Attach);
    let lead = match focus {
        Focus::Search => {
            return match (row, hits.text_at(at), hits.right.contains(at)) {
                (Some(item), ..) => intents([Some(Intent::SelectRow(item)), attach]),
                (None, Some(grapheme), _) => {
                    MouseRoute::Intents(vec![Intent::PickerCursorTo(grapheme)])
                }
                (None, None, true) => focus_pane_at(at, hits, vec![Intent::PickerConfirm]),
                (None, None, false) => MouseRoute::Nothing,
            };
        }
        Focus::Pane => Some(Intent::LeavePane),
        Focus::Sidebar | Focus::Picker | Focus::Rename => None,
    };
    if hits.on_sidebar_input(at) {
        return intents([lead, Some(Intent::Search)]);
    }
    if let Some(item) = row {
        return intents([lead, Some(Intent::SelectRow(item)), attach]);
    }
    focus_pane_at(at, hits, Vec::new())
}

/// The intents that are there, in order.
fn intents<I>(list: I) -> MouseRoute
where
    I: IntoIterator<Item = Option<Intent>>,
{
    MouseRoute::Intents(list.into_iter().flatten().collect())
}

/// A mouse event the outer terminal reported in pixels, in cells of `cell`
/// pixels, and its pixel position (0-based, as kitty counts). crossterm takes
/// one off each coordinate as it does for cells, wrapping at pixel 0, so the
/// one goes back on. `None` while the cell size is unknown.
pub(crate) fn from_pixels(event: MouseEvent, cell: CellSize) -> Option<(MouseEvent, Position)> {
    let pixel = Position::new(event.column.wrapping_add(1), event.row.wrapping_add(1));
    let column = pixel.x.checked_div(cell.width)?;
    let row = pixel.y.checked_div(cell.height)?;
    Some((
        MouseEvent {
            column,
            row,
            ..event
        },
        pixel,
    ))
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use orb_domain::feat::sessions::state::SidebarItem;
    use orb_domain::ids::{PaneId, SessionId};
    use orb_domain::{Focus, Intent};
    use orb_term::CellSize;
    use ratatui::crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
    use ratatui::layout::{Position, Rect};

    use super::{Click, ClickTarget, Clicks, HitMap, MouseRoute, from_pixels, route};

    const AGENT_1: SidebarItem = SidebarItem::Session(SessionId(1));

    /// A 30-column sidebar and a 50-column right side, 20 lines tall over the
    /// mode line: the input box on lines 0 to 2 and agent 1 on lines 3 and 4;
    /// on the right a tab bar on line 0, then agent 1's pane in columns 30
    /// to 54 and pane -1 in columns 56 to 79, both running programs that
    /// read the mouse.
    fn hits() -> HitMap {
        hits_reading(true)
    }

    /// `hits()` with both panes running shells, which don't read the mouse.
    fn shell_hits() -> HitMap {
        hits_reading(false)
    }

    /// `hits()` with both panes' programs reading the mouse or not.
    fn hits_reading(reads_mouse: bool) -> HitMap {
        let mut hits = HitMap::new(Rect::new(0, 0, 30, 20), Rect::new(30, 0, 50, 20));
        hits.record_sidebar_input(Rect::new(0, 0, 29, 3));
        hits.record_row(Rect::new(0, 3, 29, 2), AGENT_1);
        hits.record_pane(Rect::new(30, 1, 25, 19), PaneId(1), reads_mouse);
        hits.record_pane(Rect::new(56, 1, 24, 19), PaneId(-1), reads_mouse);
        hits
    }

    fn mouse(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
        MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }
    }

    fn left_click(column: u16, row: u16) -> MouseEvent {
        mouse(MouseEventKind::Down(MouseButton::Left), column, row)
    }

    /// Routes `event` with `focus`, agent 1's pane focused and no earlier
    /// click.
    fn route_once(event: MouseEvent, focus: Focus) -> MouseRoute {
        route(
            event,
            &hits(),
            focus,
            Some(PaneId(1)),
            &mut Clicks::default(),
            Instant::now(),
        )
    }

    /// Routes `event` over `hits` with `focus`, agent 1's pane focused and
    /// the gesture so far in `clicks`.
    fn route_with(
        event: MouseEvent,
        hits: &HitMap,
        focus: Focus,
        clicks: &mut Clicks,
    ) -> MouseRoute {
        route(event, hits, focus, Some(PaneId(1)), clicks, Instant::now())
    }

    fn left_drag(column: u16, row: u16) -> MouseEvent {
        mouse(MouseEventKind::Drag(MouseButton::Left), column, row)
    }

    fn left_release(column: u16, row: u16) -> MouseEvent {
        mouse(MouseEventKind::Up(MouseButton::Left), column, row)
    }

    /// The intents a route runs; empty for any other route.
    fn intents_of(route: MouseRoute) -> Vec<Intent> {
        match route {
            MouseRoute::Intents(intents) => intents,
            _ => vec![],
        }
    }

    #[rstest::rstest]
    fn click_on_a_row_with_the_sidebar_focused_selects_it() {
        // Given the sidebar has the keys.
        // When clicking agent 1's row.
        let routed = route_once(left_click(5, 4), Focus::Sidebar);

        // Then the row is selected.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::SelectRow(AGENT_1)]),
            "a click on a row should select it"
        );
    }

    #[rstest::rstest]
    fn click_on_a_row_from_the_pane_leaves_it_first() {
        // Given the attached pane has the keys.
        // When clicking agent 1's row.
        let routed = route_once(left_click(5, 4), Focus::Pane);

        // Then the pane is left, then the row is selected.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::LeavePane, Intent::SelectRow(AGENT_1)]),
            "a click on a row should leave the pane first"
        );
    }

    #[rstest::rstest]
    fn double_click_on_a_row_attaches() {
        // Given the sidebar has the keys and agent 1's row was just clicked.
        let (hits, mut clicks, now) = (hits(), Clicks::default(), Instant::now());
        route(
            left_click(5, 4),
            &hits,
            Focus::Sidebar,
            None,
            &mut clicks,
            now,
        );

        // When clicking it again 100 ms later.
        let routed = route(
            left_click(5, 4),
            &hits,
            Focus::Sidebar,
            None,
            &mut clicks,
            now + Duration::from_millis(100),
        );

        // Then the last intent attaches.
        assert_eq!(
            intents_of(routed).last(),
            Some(&Intent::Attach),
            "a double-click on a row should attach"
        );
    }

    #[rstest::rstest]
    fn click_on_the_focused_pane_while_attached_is_forwarded() {
        // Given agent 1's focused pane has the keys and its program reads
        // the mouse.
        // When clicking inside it.
        let routed = route_once(left_click(40, 5), Focus::Pane);

        // Then the click goes to the pane.
        assert_eq!(
            routed,
            MouseRoute::Forward,
            "a click on the focused pane should go to it"
        );
    }

    #[rstest::rstest]
    fn click_on_another_pane_while_attached_focuses_it() {
        // Given agent 1's focused pane has the keys and pane -1's program
        // reads the mouse.
        // When clicking pane -1.
        let routed = route_once(left_click(60, 5), Focus::Pane);

        // Then pane -1 takes the focus.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::FocusPane(PaneId(-1))]),
            "a click on another pane should focus it"
        );
    }

    #[rstest::rstest]
    fn click_on_another_pane_while_attached_is_not_forwarded() {
        // Given agent 1's focused pane has the keys.
        // When clicking pane -1.
        let routed = route_once(left_click(60, 5), Focus::Pane);

        // Then the click doesn't reach any program.
        assert_ne!(
            routed,
            MouseRoute::Forward,
            "a focusing click shouldn't be forwarded"
        );
    }

    /// `hits()` with a tab bar on line 0 showing tab `active` of four: the
    /// session label in columns 30 to 39, a `← +1` chip for tab 0 in 40 to
    /// 45, tabs 1 and 2 in 46 to 51 and 52 to 57, a `+1 →` chip for tab 3 in
    /// 58 to 63 and `+` in 64 to 68. Tab N's focused pane is pane 10 + N.
    fn tab_hits(active: usize) -> HitMap {
        let mut hits = hits();
        hits.record_tab_bar(Rect::new(30, 0, 50, 1), active, 4);
        for (x, index) in [(40, 0), (46, 1), (52, 2), (58, 3)] {
            hits.record_tab(Rect::new(x, 0, 6, 1), index, PaneId(10 + index as i64));
        }
        hits.record_new_tab(Rect::new(64, 0, 5, 1));
        hits
    }

    /// Routes `event` over `tab_hits(active)` with `focus`.
    fn route_on_tabs(event: MouseEvent, active: usize, focus: Focus) -> MouseRoute {
        route_with(event, &tab_hits(active), focus, &mut Clicks::default())
    }

    #[rstest::rstest]
    #[case::sidebar(Focus::Sidebar)]
    #[case::pane(Focus::Pane)]
    fn click_on_a_tab_shows_it_with_the_keys_in_its_pane(#[case] focus: Focus) {
        // Given tab 1 of four shown.
        // When clicking tab 2.
        let routed = route_on_tabs(left_click(54, 0), 1, focus);

        // Then tab 2 is shown and its focused pane takes the keys.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::GoToTab(3), Intent::FocusPane(PaneId(12))]),
            "a tab click shows the tab and focuses its pane"
        );
    }

    #[rstest::rstest]
    #[case::left_chip(42, Intent::GoToTab(1), PaneId(10))]
    #[case::right_chip(60, Intent::GoToTab(4), PaneId(13))]
    fn click_on_an_overflow_chip_shows_the_nearest_hidden_tab(
        #[case] column: u16,
        #[case] go_to: Intent,
        #[case] pane: PaneId,
    ) {
        // Given tab 1 of four shown, tabs 0 and 3 hidden in chips.
        // When clicking a chip.
        let routed = route_on_tabs(left_click(column, 0), 1, Focus::Sidebar);

        // Then the nearest hidden tab on that side is shown.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![go_to, Intent::FocusPane(pane)]),
            "a chip shows the hidden tab next to the bar"
        );
    }

    #[rstest::rstest]
    fn click_on_plus_opens_a_tab() {
        // Given tab 1 of four shown.
        // When clicking `+`.
        let routed = route_on_tabs(left_click(66, 0), 1, Focus::Pane);

        // Then a tab is opened.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::NewTab]),
            "`+` opens a tab as <C-g> t n does"
        );
    }

    #[rstest::rstest]
    fn click_on_a_tab_during_a_search_ends_it_first() {
        // Given a sidebar search with tab 1 of four shown.
        // When clicking tab 2.
        let routed = route_on_tabs(left_click(54, 0), 1, Focus::Search);

        // Then the search ends before the tab is shown.
        assert_eq!(
            intents_of(routed).first(),
            Some(&Intent::PickerConfirm),
            "the search ends first"
        );
    }

    #[rstest::rstest]
    fn click_on_the_tab_bars_session_label_does_nothing() {
        // Given tab 1 of four shown.
        // When clicking the session label.
        let routed = route_on_tabs(left_click(35, 0), 1, Focus::Sidebar);

        // Then nothing happens.
        assert_eq!(routed, MouseRoute::Nothing, "the label takes no clicks");
    }

    #[rstest::rstest]
    #[case::up_shows_the_next(MouseEventKind::ScrollUp, 1, MouseRoute::Intents(vec![Intent::GoToTab(3)]))]
    #[case::down_shows_the_previous(MouseEventKind::ScrollDown, 1, MouseRoute::Intents(vec![Intent::GoToTab(1)]))]
    #[case::up_on_the_last_stops(MouseEventKind::ScrollUp, 3, MouseRoute::Nothing)]
    #[case::down_on_the_first_stops(MouseEventKind::ScrollDown, 0, MouseRoute::Nothing)]
    fn wheel_over_the_tab_bar_steps_through_tabs_without_wrapping(
        #[case] kind: MouseEventKind,
        #[case] active: usize,
        #[case] expected: MouseRoute,
    ) {
        // Given tab `active` of four shown.
        // When turning the wheel over the session label.
        let routed = route_on_tabs(mouse(kind, 35, 0), active, Focus::Pane);

        // Then the tab beside it is shown, stopping at the ends.
        assert_eq!(routed, expected, "the wheel over the tab bar");
    }

    #[rstest::rstest]
    fn click_on_a_pane_frame_does_nothing() {
        // Given the keys in pane 1, its frame and pane -1's meeting at column 55.
        // When clicking that column.
        let routed = route_once(left_click(55, 5), Focus::Pane);

        // Then nothing happens.
        assert_eq!(
            routed,
            MouseRoute::Nothing,
            "a pane's frame takes no clicks"
        );
    }

    #[rstest::rstest]
    fn click_on_the_start_screen_does_nothing() {
        // Given the start screen on the right, so no pane drawn there.
        let hits = HitMap::new(Rect::new(0, 0, 30, 20), Rect::new(30, 0, 50, 20));

        // When clicking the right side.
        let routed = route(
            left_click(50, 5),
            &hits,
            Focus::Sidebar,
            None,
            &mut Clicks::default(),
            Instant::now(),
        );

        // Then nothing happens.
        assert_eq!(
            routed,
            MouseRoute::Nothing,
            "the start screen takes no clicks"
        );
    }

    #[rstest::rstest]
    fn click_on_a_pane_from_the_sidebar_focuses_it() {
        // Given the sidebar has the keys and agent 1's pane's program reads
        // the mouse.
        // When clicking agent 1's pane.
        let routed = route_once(left_click(35, 5), Focus::Sidebar);

        // Then the pane takes the focus and the keys.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::FocusPane(PaneId(1))]),
            "a click on a pane should focus it"
        );
    }

    #[rstest::rstest]
    #[case::sidebar(Focus::Sidebar)]
    #[case::pane(Focus::Pane)]
    fn wheel_over_the_sidebar_scrolls_its_view(#[case] focus: Focus) {
        // Given the keys in the sidebar or the attached pane.
        // When wheeling down over the sidebar.
        let routed = route_once(mouse(MouseEventKind::ScrollDown, 5, 10), focus);

        // Then the sidebar's view scrolls three lines.
        assert_eq!(
            routed,
            MouseRoute::ScrollSidebar(3),
            "the wheel should scroll the sidebar's view"
        );
    }

    #[rstest::rstest]
    #[case::sidebar(Focus::Sidebar)]
    #[case::pane(Focus::Pane)]
    fn click_on_the_input_box_starts_a_search(#[case] focus: Focus) {
        // Given `focus` has the keys.
        // When clicking the sidebar's input box.
        let routed = route_once(left_click(5, 1), focus);

        // Then the last intent starts a search.
        assert_eq!(
            intents_of(routed).last(),
            Some(&Intent::Search),
            "a click on the input box from {focus:?} should search"
        );
    }

    #[rstest::rstest]
    fn click_on_a_row_during_a_search_selects_it() {
        // Given a search has the keys.
        // When clicking agent 1's row.
        let routed = route_once(left_click(5, 4), Focus::Search);

        // Then the row is selected.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::SelectRow(AGENT_1)]),
            "a click on a row during a search should select it"
        );
    }

    #[rstest::rstest]
    fn click_on_a_pane_during_a_search_confirms_and_focuses_it() {
        // Given a search has the keys.
        // When clicking agent 1's pane.
        let routed = route_once(left_click(50, 5), Focus::Search);

        // Then the search ends on its match and the pane takes the keys.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::PickerConfirm, Intent::FocusPane(PaneId(1))]),
            "a click on a pane should end the search there"
        );
    }

    #[rstest::rstest]
    fn click_on_the_mode_line_does_nothing() {
        // Given the sidebar has the keys.
        // When clicking the mode line below both sides.
        let routed = route_once(left_click(5, 20), Focus::Sidebar);

        // Then nothing happens.
        assert_eq!(
            routed,
            MouseRoute::Nothing,
            "a click on the mode line should do nothing"
        );
    }

    /// `hits()` under a picker popup over columns 20 to 59, lines 4 to 13
    /// (it covers part of agent 1's row), with shown row 1 on line 8.
    fn picker_hits() -> HitMap {
        let mut hits = hits();
        hits.record_overlay(Rect::new(20, 4, 40, 10));
        hits.record_selector(Rect::new(20, 4, 40, 10));
        hits.record_picker_row(Rect::new(21, 8, 38, 1), 1);
        hits
    }

    /// `hits()` under a session picker popup over columns 20 to 59, lines 4
    /// to 13: the list box on columns 20 to 37, the preview on 39 to 59.
    fn session_picker_hits() -> HitMap {
        let mut hits = hits();
        hits.record_overlay(Rect::new(20, 4, 40, 10));
        hits.record_selector(Rect::new(20, 4, 18, 10));
        hits
    }

    /// Routes `event` over `hits` with `focus`, no pane shown and no earlier
    /// click.
    fn route_over(event: MouseEvent, hits: &HitMap, focus: Focus) -> MouseRoute {
        route(
            event,
            hits,
            focus,
            None,
            &mut Clicks::default(),
            Instant::now(),
        )
    }

    #[rstest::rstest]
    fn click_outside_a_picker_cancels_it() {
        // Given a picker has the keys.
        // When clicking agent 1's row, outside the popup.
        let routed = route_over(left_click(5, 4), &picker_hits(), Focus::Picker);

        // Then the picker is cancelled and the row isn't selected.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::PickerCancel]),
            "a click outside a picker should only cancel it"
        );
    }

    #[rstest::rstest]
    fn click_on_a_picker_row_selects_it() {
        // Given a picker has the keys.
        // When clicking its shown row 1.
        let routed = route_over(left_click(30, 8), &picker_hits(), Focus::Picker);

        // Then that row is selected.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::PickerSelectRow(1)]),
            "a click on a picker row should select it"
        );
    }

    #[rstest::rstest]
    fn double_click_on_a_picker_row_picks_it() {
        // Given a picker has the keys and its row 1 was just clicked.
        let (hits, mut clicks, now) = (picker_hits(), Clicks::default(), Instant::now());
        route(
            left_click(30, 8),
            &hits,
            Focus::Picker,
            None,
            &mut clicks,
            now,
        );

        // When clicking it again 100 ms later.
        let routed = route(
            left_click(30, 8),
            &hits,
            Focus::Picker,
            None,
            &mut clicks,
            now + Duration::from_millis(100),
        );

        // Then the row is selected and picked.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::PickerSelectRow(1), Intent::PickerConfirm]),
            "a double-click on a picker row should pick it"
        );
    }

    #[rstest::rstest]
    #[case::down(MouseEventKind::ScrollDown, Intent::PickerWheelNext)]
    #[case::up(MouseEventKind::ScrollUp, Intent::PickerWheelPrev)]
    fn wheel_over_a_picker_moves_its_selection(
        #[case] kind: MouseEventKind,
        #[case] expected: Intent,
    ) {
        // Given a picker has the keys.
        // When wheeling over its popup.
        let routed = route_over(mouse(kind, 30, 6), &picker_hits(), Focus::Picker);

        // Then the picker's selection moves.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![expected]),
            "the wheel over a picker should move its selection"
        );
    }

    #[rstest::rstest]
    fn wheel_outside_a_picker_does_nothing() {
        // Given a picker has the keys.
        // When wheeling down over the sidebar, outside the popup.
        let routed = route_over(
            mouse(MouseEventKind::ScrollDown, 5, 15),
            &picker_hits(),
            Focus::Picker,
        );

        // Then nothing happens.
        assert_eq!(
            routed,
            MouseRoute::Nothing,
            "the wheel outside a picker should do nothing"
        );
    }

    #[rstest::rstest]
    fn wheel_over_the_session_pickers_list_moves_its_selection() {
        // Given the session picker has the keys.
        // When wheeling down over its list box.
        let routed = route_over(
            mouse(MouseEventKind::ScrollDown, 25, 8),
            &session_picker_hits(),
            Focus::Picker,
        );

        // Then the picker's selection moves down.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::PickerWheelNext]),
            "the wheel over the session picker's list should move its selection"
        );
    }

    #[rstest::rstest]
    fn wheel_over_the_session_pickers_preview_does_nothing() {
        // Given the session picker has the keys.
        // When wheeling down over its preview.
        let routed = route_over(
            mouse(MouseEventKind::ScrollDown, 50, 8),
            &session_picker_hits(),
            Focus::Picker,
        );

        // Then nothing happens.
        assert_eq!(
            routed,
            MouseRoute::Nothing,
            "the wheel over the session picker's preview should do nothing"
        );
    }

    #[rstest::rstest]
    fn click_inside_a_picker_off_its_rows_does_nothing() {
        // Given a picker has the keys.
        // When clicking inside the popup on no row.
        let routed = route_over(left_click(30, 5), &picker_hits(), Focus::Picker);

        // Then nothing happens: the picker stays open.
        assert_eq!(
            routed,
            MouseRoute::Nothing,
            "a click inside a picker off its rows should do nothing"
        );
    }

    #[rstest::rstest]
    fn double_click_inside_a_picker_off_its_rows_does_nothing() {
        // Given a picker has the keys and a spot on no row was just clicked.
        let (hits, mut clicks, now) = (picker_hits(), Clicks::default(), Instant::now());
        route(
            left_click(30, 5),
            &hits,
            Focus::Picker,
            None,
            &mut clicks,
            now,
        );

        // When clicking it again 100 ms later.
        let routed = route(
            left_click(30, 5),
            &hits,
            Focus::Picker,
            None,
            &mut clicks,
            now + Duration::from_millis(100),
        );

        // Then nothing happens: the selected row isn't picked.
        assert_eq!(
            routed,
            MouseRoute::Nothing,
            "a double-click inside a picker off its rows should pick nothing"
        );
    }

    /// `hits()` while searching for "agents": the box's inner line is
    /// columns 1 to 27 of line 1, the text after the two-column `> `.
    fn search_hits() -> HitMap {
        let mut hits = hits();
        hits.record_text(Rect::new(1, 1, 27, 1), 2, "agents", 6, 24);
        hits
    }

    /// `picker_hits()` with "alpha" typed on the input line (line 5), after
    /// the three-column ` > `.
    fn input_hits() -> HitMap {
        let mut hits = picker_hits();
        hits.record_text(Rect::new(21, 5, 38, 1), 3, "alpha", 5, 34);
        hits
    }

    #[rstest::rstest]
    fn click_on_the_search_text_moves_its_cursor() {
        // Given the sidebar search has the keys, "agents" typed.
        // When clicking the "e" of "agents".
        let routed = route_over(left_click(5, 1), &search_hits(), Focus::Search);

        // Then the search cursor moves before the "e".
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::PickerCursorTo(2)]),
            "a click on the search text should move its cursor there"
        );
    }

    #[rstest::rstest]
    fn click_on_the_search_prompt_moves_the_cursor_to_the_start() {
        // Given the sidebar search has the keys, "agents" typed.
        // When clicking the `>` of the prompt.
        let routed = route_over(left_click(1, 1), &search_hits(), Focus::Search);

        // Then the search cursor moves to the first shown grapheme.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::PickerCursorTo(0)]),
            "a click on the prompt should move the cursor to the start"
        );
    }

    #[rstest::rstest]
    fn click_on_the_search_box_border_does_nothing() {
        // Given the sidebar search has the keys, "agents" typed.
        // When clicking the box's top border, off the text line.
        let routed = route_over(left_click(5, 0), &search_hits(), Focus::Search);

        // Then nothing happens.
        assert_eq!(
            routed,
            MouseRoute::Nothing,
            "a click on the search box's border should do nothing"
        );
    }

    #[rstest::rstest]
    #[case::picker(Focus::Picker)]
    #[case::rename(Focus::Rename)]
    fn click_on_an_inputs_text_moves_its_cursor(#[case] focus: Focus) {
        // Given a picker or the rename box has the keys, "alpha" typed.
        // When clicking the "p" of "alpha".
        let routed = route_over(left_click(26, 5), &input_hits(), focus);

        // Then its cursor moves before the "p".
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::PickerCursorTo(2)]),
            "a click on the input's text should move its cursor there with {focus:?}"
        );
    }

    #[rstest::rstest]
    fn click_before_the_picker_is_drawn_does_nothing() {
        // Given a picker has the keys but no frame has drawn it yet.
        // When clicking agent 1's row.
        let routed = route_over(left_click(5, 4), &hits(), Focus::Picker);

        // Then nothing happens.
        assert_eq!(
            routed,
            MouseRoute::Nothing,
            "a click before the picker is drawn should do nothing"
        );
    }

    #[rstest::rstest]
    fn click_outside_the_rename_box_cancels_it() {
        // Given the rename box has the keys, drawn over columns 20 to 59,
        // lines 2 to 4.
        let hits = {
            let mut hits = hits();
            hits.record_overlay(Rect::new(20, 2, 40, 3));
            hits
        };

        // When clicking outside it.
        let routed = route_over(left_click(5, 10), &hits, Focus::Rename);

        // Then the rename box is cancelled.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::PickerCancel]),
            "a click outside the rename box should cancel it"
        );
    }

    const ROW_1: Option<ClickTarget> = Some(ClickTarget::Row(AGENT_1));

    #[rstest::rstest]
    fn two_quick_clicks_on_the_same_row_are_a_double_click() {
        // Given a click on agent 1's row.
        let (mut clicks, now) = (Clicks::default(), Instant::now());
        clicks.click(ROW_1, now);

        // When clicking it again 100 ms later.
        let click = clicks.click(ROW_1, now + Duration::from_millis(100));

        // Then it's a double-click.
        assert_eq!(click, Click::Double, "the second quick click");
    }

    #[rstest::rstest]
    fn clicks_600ms_apart_are_two_singles() {
        // Given a click on agent 1's row.
        let (mut clicks, now) = (Clicks::default(), Instant::now());
        clicks.click(ROW_1, now);

        // When clicking it again 600 ms later.
        let click = clicks.click(ROW_1, now + Duration::from_millis(600));

        // Then it's a single click.
        assert_eq!(click, Click::Single, "the second slow click");
    }

    #[rstest::rstest]
    fn clicks_on_different_rows_are_two_singles() {
        // Given a click on agent 1's row.
        let (mut clicks, now) = (Clicks::default(), Instant::now());
        clicks.click(ROW_1, now);

        // When clicking agent 2's row 100 ms later.
        let click = clicks.click(
            Some(ClickTarget::Row(SidebarItem::Session(SessionId(2)))),
            now + Duration::from_millis(100),
        );

        // Then it's a single click.
        assert_eq!(click, Click::Single, "a quick click on another row");
    }

    #[rstest::rstest]
    fn third_quick_click_is_a_single() {
        // Given a double-click on agent 1's row.
        let (mut clicks, now) = (Clicks::default(), Instant::now());
        clicks.click(ROW_1, now);
        clicks.click(ROW_1, now + Duration::from_millis(100));

        // When clicking it a third time 100 ms later.
        let click = clicks.click(ROW_1, now + Duration::from_millis(200));

        // Then it's a single click.
        assert_eq!(click, Click::Single, "the third quick click");
    }

    #[rstest::rstest]
    fn press_on_the_focused_shell_pane_starts_a_selection() {
        // Given agent 1's focused shell pane has the keys.
        // When pressing inside it.
        let routed = route_with(
            left_click(40, 5),
            &shell_hits(),
            Focus::Pane,
            &mut Clicks::default(),
        );

        // Then a selection starts there.
        assert_eq!(
            routed,
            MouseRoute::Select(vec![], PaneId(1)),
            "a press in a shell should start a selection"
        );
    }

    #[rstest::rstest]
    fn drag_after_a_selecting_press_extends_the_selection() {
        // Given a press that started a selection in agent 1's shell pane.
        let (hits, mut clicks) = (shell_hits(), Clicks::default());
        route_with(left_click(40, 5), &hits, Focus::Pane, &mut clicks);

        // When dragging.
        let routed = route_with(left_drag(45, 6), &hits, Focus::Pane, &mut clicks);

        // Then the selection grows.
        assert_eq!(
            routed,
            MouseRoute::Extend(PaneId(1)),
            "the drag should extend the selection"
        );
    }

    #[rstest::rstest]
    fn drag_within_one_cell_extends_the_selection_once() {
        // Given a selection in agent 1's shell pane dragged to (45, 6).
        let (hits, mut clicks) = (shell_hits(), Clicks::default());
        route_with(left_click(40, 5), &hits, Focus::Pane, &mut clicks);
        route_with(left_drag(45, 6), &hits, Focus::Pane, &mut clicks);

        // When the drag moves again within that cell, as pixel reports do.
        let routed = route_with(left_drag(45, 6), &hits, Focus::Pane, &mut clicks);

        // Then orb does nothing more.
        assert_eq!(
            routed,
            MouseRoute::Nothing,
            "motion within a cell should act once"
        );
    }

    #[rstest::rstest]
    fn drag_within_one_cell_still_reaches_a_mouse_tracking_program() {
        // Given a drag forwarded to agent 1's mouse-reading program at
        // (45, 6).
        let (hits, mut clicks) = (hits(), Clicks::default());
        route_with(left_click(40, 5), &hits, Focus::Pane, &mut clicks);
        route_with(left_drag(45, 6), &hits, Focus::Pane, &mut clicks);

        // When the drag moves again within that cell.
        let routed = route_with(left_drag(45, 6), &hits, Focus::Pane, &mut clicks);

        // Then the program gets it, to read its pixels.
        assert_eq!(
            routed,
            MouseRoute::Forward,
            "the program decides what motion within a cell means"
        );
    }

    #[rstest::rstest]
    fn release_after_a_selecting_press_copies() {
        // Given a press that started a selection in agent 1's shell pane.
        let (hits, mut clicks) = (shell_hits(), Clicks::default());
        route_with(left_click(40, 5), &hits, Focus::Pane, &mut clicks);

        // When releasing.
        let routed = route_with(left_release(45, 6), &hits, Focus::Pane, &mut clicks);

        // Then the selection is copied.
        assert_eq!(
            routed,
            MouseRoute::Copy(PaneId(1)),
            "the release should copy the selection"
        );
    }

    #[rstest::rstest]
    fn drag_past_the_pane_keeps_extending_the_selection() {
        // Given a press that started a selection in agent 1's shell pane.
        let (hits, mut clicks) = (shell_hits(), Clicks::default());
        route_with(left_click(40, 5), &hits, Focus::Pane, &mut clicks);

        // When dragging over the sidebar.
        let routed = route_with(left_drag(10, 5), &hits, Focus::Pane, &mut clicks);

        // Then the pane's selection still grows.
        assert_eq!(
            routed,
            MouseRoute::Extend(PaneId(1)),
            "the drag should stay with the selecting pane"
        );
    }

    #[rstest::rstest]
    fn press_in_a_mouse_tracking_program_is_forwarded() {
        // Given agent 1's focused pane has the keys and its program reads
        // the mouse.
        // When pressing inside it.
        let routed = route_with(
            left_click(40, 5),
            &hits(),
            Focus::Pane,
            &mut Clicks::default(),
        );

        // Then the press goes to the program.
        assert_eq!(
            routed,
            MouseRoute::Forward,
            "the program should get the press"
        );
    }

    #[rstest::rstest]
    fn drag_in_a_mouse_tracking_program_is_forwarded() {
        // Given a press forwarded to agent 1's mouse-reading program.
        let (hits, mut clicks) = (hits(), Clicks::default());
        route_with(left_click(40, 5), &hits, Focus::Pane, &mut clicks);

        // When dragging inside the pane.
        let routed = route_with(left_drag(45, 6), &hits, Focus::Pane, &mut clicks);

        // Then the drag goes to the program.
        assert_eq!(
            routed,
            MouseRoute::Forward,
            "the program should get the drag"
        );
    }

    #[rstest::rstest]
    fn release_in_a_mouse_tracking_program_is_forwarded() {
        // Given a press forwarded to agent 1's mouse-reading program.
        let (hits, mut clicks) = (hits(), Clicks::default());
        route_with(left_click(40, 5), &hits, Focus::Pane, &mut clicks);

        // When releasing inside the pane.
        let routed = route_with(left_release(45, 6), &hits, Focus::Pane, &mut clicks);

        // Then the release goes to the program.
        assert_eq!(
            routed,
            MouseRoute::Forward,
            "the program should get the release"
        );
    }

    #[rstest::rstest]
    fn press_on_another_shell_pane_focuses_it_and_starts_a_selection() {
        // Given agent 1's focused pane has the keys and pane -1 runs a shell.
        // When pressing pane -1.
        let routed = route_with(
            left_click(60, 5),
            &shell_hits(),
            Focus::Pane,
            &mut Clicks::default(),
        );

        // Then pane -1 takes the focus and a selection starts there.
        assert_eq!(
            routed,
            MouseRoute::Select(vec![Intent::FocusPane(PaneId(-1))], PaneId(-1)),
            "a press on another shell should focus it and select"
        );
    }

    #[rstest::rstest]
    fn press_on_a_shell_pane_from_the_sidebar_focuses_it_and_starts_a_selection() {
        // Given the sidebar has the keys and agent 1's pane runs a shell.
        // When pressing agent 1's pane.
        let routed = route_with(
            left_click(40, 5),
            &shell_hits(),
            Focus::Sidebar,
            &mut Clicks::default(),
        );

        // Then the pane takes the focus and a selection starts there.
        assert_eq!(
            routed,
            MouseRoute::Select(vec![Intent::FocusPane(PaneId(1))], PaneId(1)),
            "a press on a shell from the sidebar should focus it and select"
        );
    }

    #[rstest::rstest]
    fn release_after_a_focusing_press_is_not_forwarded() {
        // Given a press that focused pane -1, whose program reads the mouse.
        let (hits, mut clicks) = (hits(), Clicks::default());
        route_with(left_click(60, 5), &hits, Focus::Pane, &mut clicks);

        // When releasing over agent 1's focused pane while it has the keys.
        let routed = route_with(left_release(40, 5), &hits, Focus::Pane, &mut clicks);

        // Then nothing happens.
        assert_eq!(
            routed,
            MouseRoute::Nothing,
            "a focusing press's release shouldn't reach a program"
        );
    }

    #[rstest::rstest]
    #[case::focused_pane(Focus::Pane, 40, PaneId(1))]
    #[case::other_pane(Focus::Pane, 60, PaneId(-1))]
    #[case::from_the_sidebar(Focus::Sidebar, 40, PaneId(1))]
    fn wheel_over_a_pane_goes_to_that_pane(
        #[case] focus: Focus,
        #[case] column: u16,
        #[case] expected: PaneId,
    ) {
        // Given `focus` has the keys.
        // When wheeling up over the pane at `column`.
        let routed = route_once(mouse(MouseEventKind::ScrollUp, column, 5), focus);

        // Then the notch goes to that pane.
        assert_eq!(routed, MouseRoute::Wheel(expected), "the wheel's pane");
    }

    /// A right side holding one stack of panes 2, 3 and 4 showing `shown`:
    /// the list in columns 40 to 59 on lines 1 to 3, a row per pane between
    /// its bars, the other rows recorded as their panes, and the shown pane
    /// below it.
    fn stack_hits(shown: i64) -> HitMap {
        let mut hits = HitMap::new(Rect::new(0, 0, 30, 20), Rect::new(30, 0, 50, 20));
        for (pane, y) in [(2, 1), (3, 2), (4, 3)] {
            if pane != shown {
                hits.record_pane(Rect::new(41, y, 18, 1), PaneId(pane), true);
            }
        }
        hits.record_pane(Rect::new(31, 5, 48, 14), PaneId(shown), true);
        hits.record_stack(
            Rect::new(40, 1, 20, 3),
            vec![PaneId(2), PaneId(3), PaneId(4)],
            PaneId(shown),
        );
        hits
    }

    #[rstest::rstest]
    #[case::down_shows_the_next(MouseEventKind::ScrollDown, 3, MouseRoute::Intents(vec![Intent::ShowStacked(PaneId(4))]))]
    #[case::up_shows_the_previous(MouseEventKind::ScrollUp, 3, MouseRoute::Intents(vec![Intent::ShowStacked(PaneId(2))]))]
    #[case::down_on_the_last_stops(MouseEventKind::ScrollDown, 4, MouseRoute::Nothing)]
    #[case::up_on_the_first_stops(MouseEventKind::ScrollUp, 2, MouseRoute::Nothing)]
    fn wheel_over_the_stack_list_steps_the_shown_pane(
        #[case] kind: MouseEventKind,
        #[case] shown: i64,
        #[case] expected: MouseRoute,
    ) {
        // Given a stack of panes 2, 3 and 4 showing `shown`, the keys in it.
        let hits = stack_hits(shown);

        // When turning the wheel over the list's bar.
        let routed = route(
            mouse(kind, 40, 2),
            &hits,
            Focus::Pane,
            Some(PaneId(shown)),
            &mut Clicks::default(),
            Instant::now(),
        );

        // Then the stacked pane beside the shown one is shown, stopping at the ends.
        assert_eq!(routed, expected, "the wheel over the stack's list");
    }

    #[rstest::rstest]
    fn wheel_over_a_stack_row_skips_its_hidden_pane() {
        // Given a stack of panes 2, 3 and 4 showing pane 4.
        let hits = stack_hits(4);

        // When wheeling down over pane 2's row.
        let routed = route(
            mouse(MouseEventKind::ScrollDown, 45, 1),
            &hits,
            Focus::Pane,
            Some(PaneId(4)),
            &mut Clicks::default(),
            Instant::now(),
        );

        // Then pane 2's hidden program gets nothing.
        assert_ne!(
            routed,
            MouseRoute::Wheel(PaneId(2)),
            "a list row doesn't forward the wheel"
        );
    }

    #[rstest::rstest]
    fn wheel_during_a_selection_does_nothing() {
        // Given a press that started a selection in agent 1's shell pane.
        let (hits, mut clicks) = (shell_hits(), Clicks::default());
        route_with(left_click(40, 5), &hits, Focus::Pane, &mut clicks);

        // When wheeling over the pane.
        let routed = route_with(
            mouse(MouseEventKind::ScrollUp, 40, 5),
            &hits,
            Focus::Pane,
            &mut clicks,
        );

        // Then nothing happens.
        assert_eq!(
            routed,
            MouseRoute::Nothing,
            "the wheel waits for the release"
        );
    }

    #[rstest::rstest]
    fn press_after_a_lost_release_starts_a_new_selection() {
        // Given a selection in agent 1's shell pane whose release never came.
        let (hits, mut clicks) = (shell_hits(), Clicks::default());
        route_with(left_click(40, 5), &hits, Focus::Pane, &mut clicks);

        // When pressing in the pane again.
        let routed = route_with(left_click(42, 7), &hits, Focus::Pane, &mut clicks);

        // Then a new selection starts.
        assert_eq!(
            routed,
            MouseRoute::Select(vec![], PaneId(1)),
            "a new press should start over"
        );
    }

    /// `hits()` with float 9 drawn over both panes: its frame in columns 45
    /// to 64 on lines 4 to 11, its content inside the border.
    fn float_hits() -> HitMap {
        let mut hits = hits();
        hits.record_pane(Rect::new(46, 5, 18, 6), PaneId(9), true);
        hits.record_float(Rect::new(45, 4, 20, 8), PaneId(9));
        hits
    }

    #[rstest::rstest]
    fn pane_at_returns_the_float_over_a_tiled_pane() {
        // Given float 9 drawn over agent 1's pane.
        let hits = float_hits();

        // When asking which pane is at a cell of both.
        let pane = hits.pane_at(ratatui::layout::Position::new(50, 7));

        // Then it is the float.
        assert_eq!(pane, Some(PaneId(9)), "the topmost pane wins");
    }

    #[rstest::rstest]
    fn pane_at_on_a_float_border_is_no_pane() {
        // Given float 9's border drawn over agent 1's pane.
        let hits = float_hits();

        // When asking which pane is on the border.
        let pane = hits.pane_at(ratatui::layout::Position::new(45, 7));

        // Then there is none.
        assert_eq!(pane, None, "a float's border hides the pane beneath it");
    }

    #[rstest::rstest]
    fn press_on_a_float_border_focuses_the_float() {
        // Given float 9 drawn over agent 1's focused pane.
        let (hits, mut clicks) = (float_hits(), Clicks::default());

        // When pressing on the float's border.
        let routed = route_with(left_click(45, 7), &hits, Focus::Pane, &mut clicks);

        // Then the float gets the keys.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::FocusPane(PaneId(9))]),
            "a press on a float's border brings it to the top"
        );
    }

    #[rstest::rstest]
    fn drag_after_a_float_border_press_moves_it_by_the_grab() {
        // Given float 9's top border pressed two cells from its corner.
        let (hits, mut clicks) = (float_hits(), Clicks::default());
        route_with(left_click(47, 4), &hits, Focus::Pane, &mut clicks);

        // When dragging to (50, 10).
        let routed = route_with(left_drag(50, 10), &hits, Focus::Pane, &mut clicks);

        // Then the float's corner follows, two cells to the left of the mouse.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::DragFloat {
                pane: PaneId(9),
                x: 48,
                y: 10,
            }]),
            "the float moves with the grabbed point"
        );
    }

    #[rstest::rstest]
    fn release_after_a_float_drag_saves() {
        // Given float 9's border pressed and dragged.
        let (hits, mut clicks) = (float_hits(), Clicks::default());
        route_with(left_click(45, 7), &hits, Focus::Pane, &mut clicks);
        route_with(left_drag(50, 10), &hits, Focus::Pane, &mut clicks);

        // When releasing.
        let routed = route_with(left_release(50, 10), &hits, Focus::Pane, &mut clicks);

        // Then the dragged float is saved.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::DropFloat]),
            "the release saves the drag"
        );
    }

    #[rstest::rstest]
    fn lost_release_after_a_float_drag_saves() {
        // Given float 9's border pressed and dragged to the top line, then
        // released above the window, where the release was lost.
        let (hits, mut clicks) = (float_hits(), Clicks::default());
        route_with(left_click(45, 7), &hits, Focus::Pane, &mut clicks);
        route_with(left_drag(50, 0), &hits, Focus::Pane, &mut clicks);

        // When the release that never came is routed.
        let routed = clicks
            .lost_release(hits.pane_area(PaneId(9)))
            .map(|release| route_with(release, &hits, Focus::Pane, &mut clicks));

        // Then the dragged float is saved.
        assert_eq!(
            routed,
            Some(MouseRoute::Intents(vec![Intent::DropFloat])),
            "a lost release still saves the drag"
        );
    }

    #[rstest::rstest]
    fn press_on_a_float_over_the_focused_pane_focuses_the_float() {
        // Given float 9 drawn over agent 1's focused pane, which has the keys.
        let (hits, mut clicks) = (float_hits(), Clicks::default());

        // When pressing on the float's content.
        let routed = route_with(left_click(50, 7), &hits, Focus::Pane, &mut clicks);

        // Then the float gets the keys instead of the pane beneath it.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::FocusPane(PaneId(9))]),
            "a press on a float isn't forwarded to the pane under it"
        );
    }

    #[rstest::rstest]
    fn click_on_a_tiled_pane_beside_a_focused_float_focuses_it() {
        // Given float 9 with the keys.
        let hits = float_hits();

        // When clicking agent 1's pane outside the float.
        let routed = route(
            left_click(40, 15),
            &hits,
            Focus::Pane,
            Some(PaneId(9)),
            &mut Clicks::default(),
            Instant::now(),
        );

        // Then agent 1's pane gets the keys.
        assert_eq!(
            routed,
            MouseRoute::Intents(vec![Intent::FocusPane(PaneId(1))]),
            "a click on a tiled pane focuses it"
        );
    }

    #[rstest::rstest]
    fn wheel_over_a_float_above_a_stack_list_goes_to_the_float() {
        // Given float 9 drawn over a stack's list.
        let mut hits = stack_hits(4);
        hits.record_pane(Rect::new(36, 2, 28, 4), PaneId(9), true);
        hits.record_float(Rect::new(35, 1, 30, 6), PaneId(9));

        // When wheeling over the list under the float.
        let routed = route(
            mouse(MouseEventKind::ScrollDown, 40, 2),
            &hits,
            Focus::Pane,
            Some(PaneId(9)),
            &mut Clicks::default(),
            Instant::now(),
        );

        // Then the float's program gets the wheel.
        assert_eq!(
            routed,
            MouseRoute::Wheel(PaneId(9)),
            "the wheel over a float skips the list beneath it"
        );
    }

    #[rstest::rstest]
    #[case::inside_a_cell((34, 46), (3, 2), (35, 47))]
    #[case::first_pixel((u16::MAX, u16::MAX), (0, 0), (0, 0))]
    #[case::last_pixel_of_the_first_cell((8, 18), (0, 0), (9, 19))]
    #[case::first_pixel_of_the_next_cell((9, 19), (1, 1), (10, 20))]
    fn pixel_report_maps_to_its_cell(
        #[case] reported: (u16, u16),
        #[case] cell: (u16, u16),
        #[case] pixel: (u16, u16),
    ) {
        // Given 10 by 20 pixel cells and a click crossterm read in pixels,
        // one less than kitty's 0-based pixel (wrapped at pixel 0).
        let size = CellSize {
            width: 10,
            height: 20,
        };
        let click = left_click(reported.0, reported.1);

        // When mapping it to cells.
        let mapped = from_pixels(click, size);

        // Then it lands on the cell holding kitty's pixel, and keeps that
        // pixel.
        assert_eq!(
            mapped,
            Some((left_click(cell.0, cell.1), Position::new(pixel.0, pixel.1))),
            "the pixel should map to its cell"
        );
    }

    #[rstest::rstest]
    #[case::unknown(CellSize::default())]
    #[case::no_width(CellSize { width: 0, height: 20 })]
    #[case::no_height(CellSize { width: 10, height: 0 })]
    fn pixel_report_without_a_cell_size_is_dropped(#[case] size: CellSize) {
        // Given a cell size that isn't known.

        // When mapping a pixel click to cells.
        let mapped = from_pixels(left_click(34, 46), size);

        // Then there is nothing to route.
        assert_eq!(mapped, None, "a pixel report needs a cell size");
    }
}
