//! Every session's tabs, which tab is shown, where each pane's program runs,
//! and the tab body's size.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use ratatui::layout::Rect;

use super::floats::Floats;
use super::tree::{Grow, NavDirection, PaneInfo, Split, SwapLayout, TileLayout, find_in_direction};
use crate::feat::sessions::state::{Agent, NEW_AGENT};
use crate::feat::zmx::zmx_service::ZmxSession;
use crate::ids::{PaneId, SessionId};

/// Where a pane's program runs: its zmx session and directory, the name the
/// user gave it, and the command that brings its conversation back in a
/// fresh shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneEntry {
    pub id: PaneId,
    pub zmx: ZmxSession,
    pub cwd: PathBuf,
    pub name: Option<String>,
    /// Typed into the pane's shell when zmx has to make its session anew.
    pub resume: Option<String>,
}

/// The trees `Alt +` and `Alt -` can go back to. It holds only while the
/// tab's tree is still the one the last of them left.
#[derive(Debug, Clone, PartialEq)]
struct ResizeHistory {
    /// The tree the last `Alt +` or `Alt -` left.
    after: TileLayout,
    /// The trees from before each `Alt +`, newest last; `Alt -` goes back to them.
    before_grow: Vec<TileLayout>,
    /// The trees from before each `Alt -`, newest last; `Alt +` goes back to them.
    before_shrink: Vec<TileLayout>,
}

/// One tab: its name, its panes' tree, whether it shows only the focused
/// pane, its swap layout and whether it was changed by hand, and what
/// `Alt +` and `Alt -` can undo.
#[derive(Debug, Clone, PartialEq)]
pub struct Tab {
    /// Set by renaming the tab; unnamed tabs show only their number.
    name: Option<String>,
    tree: TileLayout,
    zoomed: bool,
    /// Where the tab is in the swap layout list.
    swap_layout: SwapLayout,
    /// Changed by hand: a split, a stack, or an `Alt +`/`Alt -` that changed
    /// the tree. Adds and closes don't re-tile while it's set; a relayout
    /// clears it.
    hand_changed: bool,
    /// Never saved: a restored tab starts without one.
    history: Option<ResizeHistory>,
}

impl Tab {
    fn new(pane: PaneId) -> Self {
        Self::restore(None, TileLayout::new(pane), SwapLayout::Base, false)
    }

    /// A saved tab: its name, tree, swap layout and mark, not zoomed, with no
    /// resize history.
    pub fn restore(
        name: Option<String>,
        tree: TileLayout,
        swap_layout: SwapLayout,
        hand_changed: bool,
    ) -> Self {
        Self {
            name,
            tree,
            zoomed: false,
            swap_layout,
            hand_changed,
            history: None,
        }
    }

    /// The tab's swap layout.
    pub fn swap_layout(&self) -> SwapLayout {
        self.swap_layout
    }

    /// Whether the tab was changed by hand since its last relayout.
    pub fn hand_changed(&self) -> bool {
        self.hand_changed
    }

    /// How many panes the tab holds, stacked or not.
    pub fn pane_count(&self) -> usize {
        self.tree.pane_count()
    }

    /// Re-tiles the tab in the first swap layout that fits its pane count,
    /// clears the mark and shows every pane. `cycle` is `None` for an add or
    /// close (the search starts at the tab's own layout, forwards) and
    /// `Some(back)` for `Alt ]`/`Alt [`, which first steps one layout that way
    /// unless the tab was changed by hand.
    fn relayout(&mut self, cycle: Option<bool>) {
        let step = cycle.is_some() && !self.hand_changed;
        if let Some(layout) =
            self.swap_layout
                .fitting(self.tree.pane_count(), step, cycle == Some(true))
        {
            self.swap_layout = layout;
            self.tree.tile(layout);
        }
        self.hand_changed = false;
        self.zoomed = false;
    }

    /// Closes `pane`, leaving any zoom; a tab not changed by hand is re-tiled in
    /// its swap layout, else the closed pane's neighbour takes its space.
    /// Whether it closed (a tab's only pane doesn't).
    fn close_and_retile(&mut self, pane: PaneId) -> bool {
        let closed = self.tree.close_pane(pane);
        match (closed, self.hand_changed) {
            (false, _) => {}
            (true, true) => self.zoomed = false,
            (true, false) => self.relayout(None),
        }
        closed
    }

    /// Adds pane `id`, focused, and shows every pane: an untouched tab
    /// re-tiles in the first swap layout from its own that fits one more
    /// pane; a tab changed by hand places it beside the focused pane in
    /// `body`.
    fn add_tiled(&mut self, id: PaneId, body: Rect) {
        let fitting = self
            .swap_layout
            .fitting(self.tree.pane_count() + 1, false, false);
        match (self.hand_changed, fitting) {
            (true, _) => self.tree.add_beside_focus(id, body),
            (false, Some(layout)) => {
                self.swap_layout = layout;
                self.tree.add_tiled(id, layout);
            }
            (false, None) => {}
        }
        self.zoomed = false;
    }

    /// The name the user gave the tab, if any.
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    /// Whether the tab shows only its focused pane.
    pub fn zoomed(&self) -> bool {
        self.zoomed
    }

    /// Whether pane `pane` is one of this tab's.
    pub fn holds(&self, pane: PaneId) -> bool {
        self.tree.pane_ids().contains(&pane)
    }

    /// The tab's panes, in tree order.
    pub fn pane_ids(&self) -> Vec<PaneId> {
        self.tree.pane_ids()
    }

    /// The tab's focused pane.
    pub fn focused(&self) -> PaneId {
        self.tree.focused()
    }

    /// The tab's tree, as the store saves it.
    pub fn layout_json(&self) -> String {
        self.tree.to_json()
    }

    /// Runs `step` with the tab's resize history, emptied first when the tree
    /// is no longer the one the last `Alt +` or `Alt -` left, then keeps the
    /// history for the tree `step` leaves. Whether `step` changed the tree.
    fn with_history<F>(&mut self, step: F) -> bool
    where
        F: FnOnce(&mut Self, &mut ResizeHistory) -> bool,
    {
        let mut history = self
            .history
            .take()
            .filter(|history| history.after == self.tree)
            .unwrap_or_else(|| ResizeHistory {
                after: self.tree.clone(),
                before_grow: Vec::new(),
                before_shrink: Vec::new(),
            });
        let changed = step(self, &mut history);
        history.after = self.tree.clone();
        self.history = Some(history);
        changed
    }

    /// Goes back to the tree from before the last `Alt -`, or grows or
    /// stacks the focused pane. With nothing left to grow or stack, the tab
    /// zooms unless the pane is its only one. A zoomed tab doesn't grow, and
    /// neither does one with no
    /// body yet. Whether the tree changed.
    fn grow(&mut self, body: Rect) -> bool {
        if self.zoomed || body.is_empty() {
            return false;
        }
        self.with_history(|tab, history| match history.before_shrink.pop() {
            Some(tree) => {
                tab.tree = tree;
                true
            }
            None => {
                let before = tab.tree.clone();
                match tab.tree.grow_focused(body) {
                    Grow::Grew | Grow::Stacked => {
                        history.before_grow.push(before);
                        true
                    }
                    Grow::Stuck => {
                        tab.zoomed = tab.tree.pane_count() > 1;
                        false
                    }
                }
            }
        })
    }

    /// Leaves a zoom, or goes back to the tree from before the last `Alt +`,
    /// or breaks a pane out of the focused stack, or shrinks the focused pane.
    /// Whether the tree changed; leaving a zoom isn't a change.
    fn shrink(&mut self, body: Rect) -> bool {
        if self.zoomed {
            self.zoomed = false;
            return false;
        }
        self.with_history(|tab, history| match history.before_grow.pop() {
            Some(tree) => {
                tab.tree = tree;
                true
            }
            None => {
                let before = tab.tree.clone();
                let shrank = tab.tree.shrink_focused(body);
                if shrank {
                    history.before_shrink.push(before);
                }
                shrank
            }
        })
    }
}

/// A session's tabs, in order, the one shown, where each of their panes
/// runs, and its floats.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionLayout {
    tabs: Vec<Tab>,
    active: usize,
    panes: HashMap<PaneId, PaneEntry>,
    floats: Floats,
}

impl SessionLayout {
    /// One tab of the one pane `pane`.
    pub fn of(pane: PaneEntry) -> Self {
        Self {
            tabs: vec![Tab::new(pane.id)],
            active: 0,
            panes: HashMap::from([(pane.id, pane)]),
            floats: Floats::default(),
        }
    }

    /// Saved tabs showing tab `active` (the last when past it) and saved
    /// floats, hidden, with where their panes run. Entries for panes no tab
    /// or float holds are left out.
    pub fn restore(tabs: Vec<Tab>, active: usize, panes: Vec<PaneEntry>, floats: Floats) -> Self {
        let panes = panes
            .into_iter()
            .filter(|entry| tabs.iter().any(|tab| tab.holds(entry.id)) || floats.holds(entry.id))
            .map(|entry| (entry.id, entry))
            .collect();
        Self {
            active: active.min(tabs.len().saturating_sub(1)),
            tabs,
            panes,
            floats,
        }
    }

    pub fn tabs(&self) -> &[Tab] {
        &self.tabs
    }

    /// The session's floats.
    pub fn floats(&self) -> &Floats {
        &self.floats
    }

    /// Where each of the session's panes runs, in no order.
    pub fn panes(&self) -> impl Iterator<Item = &PaneEntry> {
        self.panes.values()
    }

    /// The shown tab's 0-based index.
    pub fn active(&self) -> usize {
        self.active
    }

    /// The shown tab.
    pub fn active_tab(&self) -> Option<&Tab> {
        self.tabs.get(self.active)
    }

    /// The pane with the keys: the top float while the floats are shown,
    /// else the shown tab's focused pane.
    pub fn focused(&self) -> Option<PaneId> {
        self.floats
            .focused()
            .or_else(|| self.active_tab().map(Tab::focused))
    }

    /// Whether a float has the focus.
    pub fn float_focused(&self) -> bool {
        self.floats.focused().is_some()
    }

    /// What the tab bar shows for the tab at 0-based `index`: its number,
    /// then its name, else its focused pane's name, as `"1"` or `"1 name"`.
    pub fn tab_label(&self, index: usize) -> String {
        let name = self.tabs.get(index).and_then(|tab| {
            tab.name.as_deref().or_else(|| {
                self.panes
                    .get(&tab.focused())
                    .and_then(|entry| entry.name.as_deref())
            })
        });
        match name {
            Some(name) => format!("{} {name}", index + 1),
            None => (index + 1).to_string(),
        }
    }

    /// Where the shown tab's panes are drawn in `body`: each pane's frame on
    /// its whole tree cell. A zoomed tab places only its focused pane, over
    /// all of `body`. Each stack becomes a list of its panes, one row each,
    /// at the top of its area and at most half its height, and its expanded
    /// pane below it at the stack's full width. `list_width` gives a stack's
    /// list width, bars included, from its panes; the list is centred,
    /// leaving at least two columns on each side for the shown row's `>` (at
    /// least 3 wide, at most the stack's width). Shown floats, or only the
    /// pinned ones while hidden, come last, bottom first, also with no tab;
    /// while one has the keys, no tiled pane is placed as focused.
    pub fn placed<F>(&self, body: Rect, list_width: F) -> Placement
    where
        F: Fn(&[PaneId]) -> u16,
    {
        let mut placement = self
            .active_tab()
            .map(|tab| tiled(tab, body, &list_width))
            .unwrap_or_default();
        if self.float_focused() {
            for place in &mut placement.panes {
                place.focused = false;
            }
        }
        let top = self.floats.focused();
        placement.panes.extend(
            self.floats
                .visible(body)
                .map(|(pane, area, pinned)| Placed {
                    pane,
                    area,
                    focused: Some(pane) == top,
                    floating: true,
                    pinned,
                }),
        );
        placement
    }

    fn holds(&self, pane: PaneId) -> bool {
        self.tabs.iter().any(|tab| tab.holds(pane)) || self.floats.holds(pane)
    }

    /// Every pane of every tab and float.
    fn pane_ids(&self) -> impl Iterator<Item = PaneId> + '_ {
        self.tabs
            .iter()
            .flat_map(|tab| tab.tree.pane_ids())
            .chain(self.floats.pane_ids())
    }

    fn tab_mut(&mut self) -> Option<&mut Tab> {
        self.tabs.get_mut(self.active)
    }

    /// Removes tab `index`, showing the tab before it when it was shown.
    fn remove_tab(&mut self, index: usize) {
        if index < self.tabs.len() {
            self.tabs.remove(index);
            if index <= self.active {
                self.active = self.active.saturating_sub(1);
            }
        }
    }

    /// Forgets where panes no tab or float holds any more run.
    fn drop_loose_entries(&mut self) {
        let held: HashSet<PaneId> = self.pane_ids().collect();
        self.panes.retain(|id, _| held.contains(id));
    }
}

/// Where `tab`'s panes are drawn in `body` (see [`SessionLayout::placed`]).
fn tiled<F>(tab: &Tab, body: Rect, list_width: &F) -> Placement
where
    F: Fn(&[PaneId]) -> u16,
{
    if tab.zoomed {
        return Placement {
            panes: vec![Placed {
                pane: tab.tree.focused(),
                area: body,
                focused: true,
                floating: false,
                pinned: false,
            }],
            stacks: vec![],
        };
    }
    let stacks = tab.tree.stacks(body);
    let mut panes: Vec<Placed> = tab
        .tree
        .panes(body)
        .into_iter()
        .filter(|info| !stacks.iter().any(|stack| stack.panes.contains(&info.id)))
        .map(|info| Placed {
            pane: info.id,
            area: info.rect,
            focused: info.is_focused,
            floating: false,
            pinned: false,
        })
        .collect();
    let stacks = stacks
        .into_iter()
        .map(|stack| {
            let (rows, start) = stack.list_rows();
            let area = {
                let width = list_width(&stack.panes)
                    .min(stack.area.width.saturating_sub(4))
                    .max(3)
                    .min(stack.area.width);
                let x = stack.area.x + (stack.area.width - width) / 2;
                Rect::new(x, stack.area.y, width, rows)
            };
            panes.push(Placed {
                pane: stack.expanded,
                area: Rect::new(
                    stack.area.x,
                    stack.area.y.saturating_add(rows),
                    stack.area.width,
                    stack.area.height.saturating_sub(rows),
                ),
                focused: tab.tree.focused() == stack.expanded,
                floating: false,
                pinned: false,
            });
            let rows = stack
                .panes
                .iter()
                .skip(start)
                .zip(inside_bars(area).rows())
                .map(|(id, row)| (*id, row))
                .collect();
            StackList {
                area,
                rows,
                shown: stack.expanded,
                panes: stack.panes,
            }
        })
        .collect();
    Placement { panes, stacks }
}

/// Where the shown tab draws its panes, then the shown floats bottom first,
/// and a list per stack.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Placement {
    pub panes: Vec<Placed>,
    pub stacks: Vec<StackList>,
}

/// A pane with a frame: the frame's outer rect, whether it has the focus,
/// and whether it floats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placed {
    pub pane: PaneId,
    pub area: Rect,
    /// Gets the keys while they are in the panes.
    pub focused: bool,
    /// Drawn over the tiled panes.
    pub floating: bool,
    /// A float that stays drawn while the floats are hidden.
    pub pinned: bool,
}

impl Placed {
    /// Where the pane's screen goes: `area` less one cell on every side.
    pub fn content(&self) -> Rect {
        inside(self.area)
    }
}

/// A stack's list of panes: its rect (bars included), every stacked pane,
/// one row per pane that fits (between the bars), and the pane shown below
/// it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StackList {
    pub area: Rect,
    pub rows: Vec<(PaneId, Rect)>,
    pub shown: PaneId,
    /// Every stacked pane, in stack order: the order the wheel steps through.
    pub panes: Vec<PaneId>,
}

/// A stack list's `area` less its bar column on each side.
fn inside_bars(area: Rect) -> Rect {
    Rect::new(
        area.x.saturating_add(1),
        area.y,
        area.width.saturating_sub(2),
        area.height,
    )
}

/// `area` less one cell on every side.
fn inside(area: Rect) -> Rect {
    Rect::new(
        area.x.saturating_add(1),
        area.y.saturating_add(1),
        area.width.saturating_sub(2),
        area.height.saturating_sub(2),
    )
}

/// The pane a move `nav` into a tab focuses: one on the edge it enters
/// from (the rightmost column moving left, the leftmost moving right). The
/// tab's own focus is kept when it's on that edge; else the topmost
/// pane there that isn't collapsed in a stack.
fn entry_pane(panes: &[PaneInfo], nav: NavDirection) -> Option<PaneId> {
    let edge: Vec<&PaneInfo> = match nav {
        NavDirection::Left => {
            let right = panes.iter().map(|info| info.rect.right()).max()?;
            panes
                .iter()
                .filter(|info| info.rect.right() == right)
                .collect()
        }
        NavDirection::Right => {
            let left = panes.iter().map(|info| info.rect.x).min()?;
            panes.iter().filter(|info| info.rect.x == left).collect()
        }
        NavDirection::Up | NavDirection::Down => return None,
    };
    match edge.iter().find(|info| info.is_focused) {
        Some(info) => Some(info.id),
        None => edge
            .iter()
            .filter(|info| !info.collapsed)
            .min_by_key(|info| info.rect.y)
            .or_else(|| edge.iter().min_by_key(|info| info.rect.y))
            .map(|info| info.id),
    }
}

/// What a focus move did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusMove {
    /// Another pane, in this tab or the one beside it, has the focus.
    Moved,
    /// Nothing that way; nothing changed.
    Stuck,
}

/// Every session's tabs and splits. Written by the sessions actor (loading
/// them at start, adding a pane on add, split, new tab or a new session,
/// adding a float, pointing a moved session's panes at its new directory,
/// dropping a deleted session), the intent handler (focus, resize, zoom, tab
/// moves, renames, closes, showing, hiding and pinning floats, moving panes
/// between a tab and the floats) and the frontend (closing panes whose program
/// ended, the tab body's size).
#[derive(Debug, Default)]
pub struct Layouts {
    sessions: HashMap<SessionId, SessionLayout>,
    /// The tab body's area in the last frame; focus moves and resizes
    /// measure against it.
    body: Rect,
}

impl Layouts {
    /// Puts `layout` in as `session`'s, replacing the one it had.
    pub fn insert(&mut self, session: SessionId, layout: SessionLayout) {
        self.sessions.insert(session, layout);
    }

    /// Drops `session`'s layout.
    pub fn remove(&mut self, session: SessionId) {
        self.sessions.remove(&session);
    }

    pub fn get(&self, owner: SessionId) -> Option<&SessionLayout> {
        self.sessions.get(&owner)
    }

    /// The session whose layout holds `pane`, in a tab or a float.
    pub fn owner_of(&self, pane: PaneId) -> Option<SessionId> {
        self.sessions
            .iter()
            .find(|(_, layout)| layout.holds(pane))
            .map(|(owner, _)| *owner)
    }

    /// Where pane `pane` runs.
    pub fn entry(&self, pane: PaneId) -> Option<&PaneEntry> {
        self.sessions
            .values()
            .find_map(|layout| layout.panes.get(&pane))
    }

    /// What agent pane `pane` is called: its name, else `agent`'s title,
    /// else `New agent`. The sidebar's agent row, the close confirm and the
    /// session picker all use it.
    pub fn agent_name<'a>(&'a self, pane: PaneId, agent: Option<&'a Agent>) -> &'a str {
        self.entry(pane)
            .and_then(|entry| entry.name.as_deref())
            .or_else(|| agent?.title.as_deref())
            .unwrap_or(NEW_AGENT)
    }

    /// Every pane of every tab and float of `owner`'s layout.
    pub fn session_panes(&self, owner: SessionId) -> Vec<PaneId> {
        self.sessions
            .get(&owner)
            .map(|layout| layout.pane_ids().collect())
            .unwrap_or_default()
    }

    /// Every pane of every tab and float of every layout.
    pub fn pane_ids(&self) -> HashSet<PaneId> {
        self.sessions
            .values()
            .flat_map(SessionLayout::pane_ids)
            .collect()
    }

    /// The tab body's area in the last frame.
    pub fn body(&self) -> Rect {
        self.body
    }

    /// The tab body now measures `body`.
    pub fn fit_to(&mut self, body: Rect) {
        self.body = body;
    }

    /// Splits the shown tab's focused pane, or its whole stack when it's
    /// stacked, `split` with `pane`, which takes the focus, sharing the space
    /// evenly along that direction. The tab shows every pane again and is
    /// marked changed by hand.
    pub fn split(&mut self, owner: SessionId, split: Split, pane: PaneEntry) {
        let Some(layout) = self.sessions.get_mut(&owner) else {
            return;
        };
        if let Some(tab) = layout.tab_mut() {
            tab.tree.split_focused(split, pane.id);
            tab.zoomed = false;
            tab.hand_changed = true;
            layout.panes.insert(pane.id, pane);
        }
    }

    /// Stacks `pane` with the shown tab's focused pane, joining the focused
    /// pane's stack when it has one; `pane` is shown and takes the focus, and
    /// the tab shows every pane again and is marked changed by hand.
    pub fn stack(&mut self, owner: SessionId, pane: PaneEntry) {
        let Some(layout) = self.sessions.get_mut(&owner) else {
            return;
        };
        if let Some(tab) = layout.tab_mut() {
            tab.tree.stack_focused(pane.id);
            tab.zoomed = false;
            tab.hand_changed = true;
            layout.panes.insert(pane.id, pane);
        }
    }

    /// Adds `pane` to the shown tab: an untouched tab re-tiles in its swap
    /// layout, a tab changed by hand places it beside the focused pane.
    /// `pane` takes the focus and the tab shows every pane again.
    pub fn add_tiled(&mut self, owner: SessionId, pane: PaneEntry) {
        let body = self.body;
        let Some(layout) = self.sessions.get_mut(&owner) else {
            return;
        };
        if let Some(tab) = layout.tab_mut() {
            tab.add_tiled(pane.id, body);
            layout.panes.insert(pane.id, pane);
        }
    }

    /// Appends a tab of the one pane `pane` and shows it.
    pub fn new_tab(&mut self, owner: SessionId, pane: PaneEntry) {
        if let Some(layout) = self.sessions.get_mut(&owner) {
            layout.tabs.push(Tab::new(pane.id));
            layout.active = layout.tabs.len() - 1;
            layout.panes.insert(pane.id, pane);
        }
    }

    /// Puts `pane` on top of `owner`'s floats in the staggered spot and shows them.
    pub fn add_float(&mut self, owner: SessionId, pane: PaneEntry) {
        let body = self.body;
        if let Some(layout) = self.sessions.get_mut(&owner) {
            layout.floats.add(pane.id, body);
            layout.panes.insert(pane.id, pane);
        }
    }

    /// Splits pane `at` of `owner`, or its whole stack when it's stacked,
    /// `split` with `pane`, in whichever tab holds it, shown or not. The
    /// focus and the shown tab stay; that tab shows every pane again and is
    /// marked changed by hand. Whether `pane` was placed.
    pub fn split_at(
        &mut self,
        owner: SessionId,
        at: PaneId,
        split: Split,
        pane: PaneEntry,
    ) -> bool {
        self.place_in_tab_of(owner, at, pane, |tree, id| tree.split_at(at, split, id))
    }

    /// Stacks `pane` right after pane `at` of `owner`, in whichever tab holds
    /// it, joining `at`'s stack when it has one. The focus, the shown tab and
    /// the pane a stack shows stay; that tab shows every pane again and is
    /// marked changed by hand. Whether `pane` was placed.
    pub fn stack_at(&mut self, owner: SessionId, at: PaneId, pane: PaneEntry) -> bool {
        self.place_in_tab_of(owner, at, pane, |tree, id| tree.stack_at(at, id))
    }

    /// Appends a tab of the one pane `pane` to `owner`'s layout and keeps
    /// showing the tab that was shown. Whether `owner` has a layout.
    pub fn new_tab_keeping_shown(&mut self, owner: SessionId, pane: PaneEntry) -> bool {
        let Some(layout) = self.sessions.get_mut(&owner) else {
            return false;
        };
        layout.tabs.push(Tab::new(pane.id));
        layout.panes.insert(pane.id, pane);
        true
    }

    /// Puts `pane` among `owner`'s floats just under the top one. It never
    /// shows the floats or takes the focus. Whether `owner` has a layout.
    pub fn add_float_hidden(&mut self, owner: SessionId, pane: PaneEntry) -> bool {
        let body = self.body;
        let Some(layout) = self.sessions.get_mut(&owner) else {
            return false;
        };
        layout.floats.add_under_top(pane.id, body);
        layout.panes.insert(pane.id, pane);
        true
    }

    /// Closes the tab holding `pane`, shown or not; when it was shown, the tab
    /// before it is shown. A layout left without tabs or floats goes. False
    /// for a float or a pane no layout holds.
    pub fn close_tab_of(&mut self, pane: PaneId) -> bool {
        let Some(owner) = self.owner_of(pane) else {
            return false;
        };
        let Some(layout) = self.sessions.get_mut(&owner) else {
            return false;
        };
        let Some(index) = layout.tabs.iter().position(|tab| tab.holds(pane)) else {
            return false;
        };
        layout.remove_tab(index);
        layout.drop_loose_entries();
        self.drop_if_empty(owner);
        true
    }

    /// Runs `place` on the tree of `owner`'s tab holding `at`; when it placed
    /// `pane`, that tab shows every pane again, is marked changed by hand and
    /// `pane` is recorded. Whether it was placed.
    fn place_in_tab_of<F>(
        &mut self,
        owner: SessionId,
        at: PaneId,
        pane: PaneEntry,
        place: F,
    ) -> bool
    where
        F: FnOnce(&mut TileLayout, PaneId) -> bool,
    {
        let Some(layout) = self.sessions.get_mut(&owner) else {
            return false;
        };
        let Some(tab) = layout.tabs.iter_mut().find(|tab| tab.holds(at)) else {
            return false;
        };
        if !place(&mut tab.tree, pane.id) {
            return false;
        }
        tab.zoomed = false;
        tab.hand_changed = true;
        layout.panes.insert(pane.id, pane);
        true
    }

    /// Turns the shown tab's focused pane into the top float in the staggered
    /// spot and shows the floats; the tab is re-tiled in its swap layout
    /// unless it was changed by hand. A tab's only pane, or a float having
    /// the keys, changes nothing. Whether it changed.
    pub fn float_pane(&mut self, owner: SessionId) -> bool {
        let body = self.body;
        let Some(layout) = self.sessions.get_mut(&owner) else {
            return false;
        };
        if layout.float_focused() {
            return false;
        }
        let Some(tab) = layout.tab_mut() else {
            return false;
        };
        let pane = tab.tree.focused();
        if tab.pane_count() < 2 || !tab.close_and_retile(pane) {
            return false;
        }
        layout.floats.add(pane, body);
        true
    }

    /// Puts the top float back into the shown tab, focused, as a new pane is
    /// added there, and hides the floats, laying the rest out again unless
    /// they were changed by hand. Nothing unless a float has the keys and a
    /// tab is shown. Whether it changed.
    pub fn embed_float(&mut self, owner: SessionId) -> bool {
        let body = self.body;
        let Some(layout) = self.sessions.get_mut(&owner) else {
            return false;
        };
        if layout.active_tab().is_none() {
            return false;
        }
        let Some(pane) = layout.floats.take_focused(body) else {
            return false;
        };
        if let Some(tab) = layout.tab_mut() {
            tab.add_tiled(pane, body);
        }
        true
    }

    /// Shows or hides `owner`'s floats; nothing with none. Whether it changed.
    pub fn toggle_floats(&mut self, owner: SessionId) -> bool {
        self.sessions
            .get_mut(&owner)
            .is_some_and(|layout| layout.floats.toggle())
    }

    /// Pins or unpins `owner`'s top float while the floats are shown. Whether it changed.
    pub fn toggle_pin(&mut self, owner: SessionId) -> bool {
        self.sessions
            .get_mut(&owner)
            .is_some_and(|layout| layout.floats.toggle_pin())
    }

    /// Moves the shown tab's focused pane to a new tab after the last one and
    /// shows it; the tab it leaves is re-tiled
    /// in its swap layout unless it was changed by hand. A tab of one pane
    /// stays as it is.
    pub fn break_pane(&mut self, owner: SessionId) {
        let Some(layout) = self.sessions.get_mut(&owner) else {
            return;
        };
        let Some(tab) = layout.tab_mut() else {
            return;
        };
        let pane = tab.tree.focused();
        if tab.tree.pane_ids().len() < 2 || !tab.close_and_retile(pane) {
            return;
        }
        layout.tabs.push(Tab::new(pane));
        layout.active = layout.tabs.len() - 1;
    }

    /// Closes `pane` wherever it is. The tab it leaves is re-tiled in its
    /// swap layout unless it was changed by hand, when the closed pane's
    /// neighbour takes its space; a tab left without panes goes, and the tab
    /// before it is shown. A float closes; the floats hide when it was the
    /// last, else the rest are laid out again unless changed by hand. A
    /// layout left without tabs or floats goes.
    pub fn close_pane(&mut self, pane: PaneId) {
        let body = self.body;
        let Some(owner) = self.owner_of(pane) else {
            return;
        };
        let Some(layout) = self.sessions.get_mut(&owner) else {
            return;
        };
        if layout.floats.remove(pane, body) {
            layout.drop_loose_entries();
            self.drop_if_empty(owner);
            return;
        }
        let Some(index) = layout.tabs.iter().position(|tab| tab.holds(pane)) else {
            return;
        };
        let emptied = layout
            .tabs
            .get_mut(index)
            .is_some_and(|tab| !tab.close_and_retile(pane));
        if emptied {
            layout.remove_tab(index);
        }
        layout.drop_loose_entries();
        self.drop_if_empty(owner);
    }

    /// Closes the shown tab; the tab before it is shown. A layout left
    /// without tabs or floats goes.
    pub fn close_tab(&mut self, owner: SessionId) {
        if let Some(layout) = self.sessions.get_mut(&owner) {
            layout.remove_tab(layout.active);
            layout.drop_loose_entries();
        }
        self.drop_if_empty(owner);
    }

    /// Moves the focus to the pane `nav` of the focused one. With none to the
    /// left or right, the previous or next tab is shown, wrapping, and the
    /// pane on the edge it's entered from gets the focus. With one tab
    /// nothing changes. While a float has the keys, the focus moves among
    /// the floats only and never changes tab.
    pub fn move_focus(&mut self, owner: SessionId, nav: NavDirection) -> FocusMove {
        let body = self.body;
        let Some(layout) = self.sessions.get_mut(&owner) else {
            return FocusMove::Stuck;
        };
        if layout.float_focused() {
            return match layout.floats.neighbour(nav, body) {
                Some(id) => {
                    layout.floats.raise(id);
                    FocusMove::Moved
                }
                None => FocusMove::Stuck,
            };
        }
        let tab_count = layout.tabs.len();
        let active = layout.active;
        let Some(tab) = layout.tab_mut() else {
            return FocusMove::Stuck;
        };
        let panes = tab.tree.nav_panes(body);
        let neighbour = panes
            .iter()
            .find(|info| info.is_focused)
            .and_then(|focused| find_in_direction(focused, nav, &panes));
        let target = match (neighbour, nav) {
            (Some(id), _) => {
                tab.tree.focus_pane(id);
                return FocusMove::Moved;
            }
            (None, NavDirection::Left) if tab_count > 1 => (active + tab_count - 1) % tab_count,
            (None, NavDirection::Right) if tab_count > 1 => (active + 1) % tab_count,
            (None, _) => return FocusMove::Stuck,
        };
        layout.active = target;
        if let Some(tab) = layout.tab_mut()
            && !tab.zoomed
            && let Some(id) = entry_pane(&tab.tree.nav_panes(body), nav)
        {
            tab.tree.focus_pane(id);
        }
        FocusMove::Moved
    }

    /// Focuses `pane` in `owner`'s shown tab.
    pub fn focus_pane(&mut self, owner: SessionId, pane: PaneId) {
        if let Some(tab) = self.tab_mut(owner) {
            tab.tree.focus_pane(pane);
        }
    }

    /// Gives `pane` of `owner`'s layout the keys: a float goes on top and the
    /// floats are shown; a tiled pane hides the floats (pinned ones stay
    /// drawn), its tab is shown and it is focused, expanding it when it's
    /// stacked. Nothing when the layout doesn't hold it. A zoomed tab stays
    /// zoomed.
    pub fn reveal(&mut self, owner: SessionId, pane: PaneId) {
        let Some(layout) = self.sessions.get_mut(&owner) else {
            return;
        };
        if layout.floats.focus(pane) {
            return;
        }
        if let Some(index) = layout.tabs.iter().position(|tab| tab.holds(pane)) {
            layout.floats.hide();
            layout.active = index;
            self.focus_pane(owner, pane);
        }
    }

    /// Shows only the focused pane over the shown tab, or every pane again.
    pub fn toggle_zoom(&mut self, owner: SessionId) {
        if let Some(tab) = self.tab_mut(owner) {
            tab.zoomed = !tab.zoomed;
        }
    }

    /// `Alt +` (`grow`) or `Alt -` on the shown tab's focused pane: see
    /// [`Tab::grow`] and [`Tab::shrink`]. Each undoes the other first. Whether
    /// the tree changed, which marks the tab changed by hand; a zoom or
    /// unzoom alone isn't a change. While a float has the keys, every side of
    /// the focused float moves one step of 5% of the body instead, marking
    /// the floats changed by hand.
    pub fn resize_focused(&mut self, owner: SessionId, grow: bool) -> bool {
        let body = self.body;
        if let Some(floats) = self.focused_floats(owner) {
            return floats.resize(body, grow);
        }
        self.tab_mut(owner).is_some_and(|tab| {
            let changed = if grow {
                tab.grow(body)
            } else {
                tab.shrink(body)
            };
            tab.hand_changed |= changed;
            changed
        })
    }

    /// Resize mode's step on `owner`'s shown tab: see
    /// [`TileLayout::resize_side`]. A zoomed tab, or one with no body yet,
    /// doesn't change. Whether the tree changed, which marks the tab changed
    /// by hand. While a float has the keys, the focused float's edge moves
    /// one step of 5% of the body instead, marking the floats changed by hand.
    pub fn resize_side(&mut self, owner: SessionId, dir: NavDirection, grow: bool) -> bool {
        let body = self.body;
        if let Some(floats) = self.focused_floats(owner) {
            return floats.resize_side(body, dir, grow);
        }
        self.tab_mut(owner).is_some_and(|tab| {
            let changed = !tab.zoomed && !body.is_empty() && tab.tree.resize_side(body, dir, grow);
            tab.hand_changed |= changed;
            changed
        })
    }

    /// Move mode's step on `owner`'s shown tab: see
    /// [`TileLayout::swap_toward`]. Never changes tab. A zoomed tab, or one
    /// with no body yet, doesn't change. Whether a pane moved; the tab's
    /// shape is unchanged, so it isn't marked changed by hand. While a float
    /// has the keys, it moves the focused float one step of 5% of the body
    /// instead, marking the floats changed by hand.
    pub fn move_pane(&mut self, owner: SessionId, dir: NavDirection) -> bool {
        let body = self.body;
        if let Some(floats) = self.focused_floats(owner) {
            return floats.shift(body, dir);
        }
        self.tab_mut(owner)
            .is_some_and(|tab| !tab.zoomed && !body.is_empty() && tab.tree.swap_toward(body, dir))
    }

    /// Move mode's next/previous step: see [`TileLayout::swap_in_order`]. A
    /// zoomed tab doesn't change. Whether a pane moved; not changed by hand.
    /// While a float has the keys, it rotates which float is on top instead.
    pub fn move_pane_in_order(&mut self, owner: SessionId, forward: bool) -> bool {
        if let Some(floats) = self.focused_floats(owner) {
            return floats.rotate(forward);
        }
        self.tab_mut(owner)
            .is_some_and(|tab| !tab.zoomed && tab.tree.swap_in_order(forward))
    }

    /// Shows tab `n`, counting from 1; past the last changes nothing.
    pub fn go_to_tab(&mut self, owner: SessionId, n: usize) {
        if let Some(layout) = self.sessions.get_mut(&owner)
            && (1..=layout.tabs.len()).contains(&n)
        {
            layout.active = n - 1;
        }
    }

    /// Re-tiles the shown tab in the next swap layout that fits, wrapping; a
    /// tab changed by hand gets its own layout back first.
    pub fn next_swap_layout(&mut self, owner: SessionId) {
        if let Some(tab) = self.tab_mut(owner) {
            tab.relayout(Some(false));
        }
    }

    /// As [`Self::next_swap_layout`], backwards.
    pub fn previous_swap_layout(&mut self, owner: SessionId) {
        if let Some(tab) = self.tab_mut(owner) {
            tab.relayout(Some(true));
        }
    }

    /// `Alt ]` (or `Alt [` when `back`) while a float has the keys: the floats
    /// go to the next layout that fits their count, wrapping; floats changed
    /// by hand get their own layout back first. Whether a float had the keys.
    pub fn cycle_float_layout(&mut self, owner: SessionId, back: bool) -> bool {
        let body = self.body;
        self.focused_floats(owner)
            .is_some_and(|floats| floats.cycle(back, body))
    }

    /// A mouse drag of float `pane` to top-left `x`, `y` while it has the
    /// keys; see [`Floats::move_top_to`]. Whether it moved.
    pub fn move_float_to(&mut self, owner: SessionId, pane: PaneId, x: u16, y: u16) -> bool {
        let body = self.body;
        self.focused_floats(owner)
            .is_some_and(|floats| floats.move_top_to(pane, x, y, body))
    }

    /// Swaps the shown tab with the one before it; the first stays put.
    pub fn move_tab_left(&mut self, owner: SessionId) {
        if let Some(layout) = self.sessions.get_mut(&owner)
            && layout.active > 0
        {
            layout.tabs.swap(layout.active, layout.active - 1);
            layout.active -= 1;
        }
    }

    /// Swaps the shown tab with the one after it; the last stays put.
    pub fn move_tab_right(&mut self, owner: SessionId) {
        if let Some(layout) = self.sessions.get_mut(&owner)
            && layout.active + 1 < layout.tabs.len()
        {
            layout.tabs.swap(layout.active, layout.active + 1);
            layout.active += 1;
        }
    }

    /// Names pane `pane`, wherever it is; `None` clears the name.
    pub fn rename_pane(&mut self, pane: PaneId, name: Option<String>) {
        if let Some(entry) = self
            .sessions
            .values_mut()
            .find_map(|layout| layout.panes.get_mut(&pane))
        {
            entry.name = name;
        }
    }

    /// Remembers the command that brings pane `pane`'s conversation back in
    /// a fresh shell, wherever the pane is; `None` when it has none.
    pub fn remember_resume(&mut self, pane: PaneId, resume: Option<String>) {
        if let Some(entry) = self
            .sessions
            .values_mut()
            .find_map(|layout| layout.panes.get_mut(&pane))
        {
            entry.resume = resume;
        }
    }

    /// Points every pane of `owner`'s layout at `dir`, where they start next.
    pub fn move_session(&mut self, owner: SessionId, dir: &Path) {
        if let Some(layout) = self.sessions.get_mut(&owner) {
            for entry in layout.panes.values_mut() {
                dir.clone_into(&mut entry.cwd);
            }
        }
    }

    /// Names tab `tab` (0-based) of `owner`'s layout; `None` clears the name.
    pub fn rename_tab(&mut self, owner: SessionId, tab: usize, name: Option<String>) {
        if let Some(tab) = self
            .sessions
            .get_mut(&owner)
            .and_then(|layout| layout.tabs.get_mut(tab))
        {
            tab.name = name;
        }
    }

    fn tab_mut(&mut self, owner: SessionId) -> Option<&mut Tab> {
        self.sessions.get_mut(&owner)?.tab_mut()
    }

    /// `owner`'s floats while one of them has the keys.
    fn focused_floats(&mut self, owner: SessionId) -> Option<&mut Floats> {
        self.sessions
            .get_mut(&owner)
            .filter(|layout| layout.float_focused())
            .map(|layout| &mut layout.floats)
    }

    /// Drops `owner`'s layout when it has no tabs and no floats left.
    fn drop_if_empty(&mut self, owner: SessionId) {
        if self
            .sessions
            .get(&owner)
            .is_some_and(|layout| layout.tabs.is_empty() && layout.floats.is_empty())
        {
            self.sessions.remove(&owner);
        }
    }
}

/// Pane `id` running in `orb-p<id>` on `/tmp/zmx`, in `/work`, for tests.
#[cfg(test)]
pub(crate) fn test_entry(id: i64) -> PaneEntry {
    PaneEntry {
        id: PaneId(id),
        zmx: ZmxSession {
            name: format!("orb-p{id}"),
            dir: "/tmp/zmx".into(),
        },
        cwd: "/work".into(),
        name: None,
        resume: None,
    }
}

#[cfg(test)]
mod tests;
