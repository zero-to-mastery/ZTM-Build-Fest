// Adapted from herdr (https://github.com/herdrdev/herdr), src/layout.rs at
// commit 3d9d2b18, licensed under the Apache License, Version 2.0. Modified
// for orb: pane ids come from the caller instead of a global counter; splits
// are `Split::{Right, Down}`; resizing grows, stacks and zooms panes; the
// tree saves to and loads from JSON; herdr's borders, scrollbar lanes, swap,
// insert and drag-resize code is left out.

//! A tab's panes as a tree of right and down splits and stacks of panes
//! sharing one area, any number of them: where each pane
//! lands in an area, and which pane is the neighbour in a direction.

use std::cmp::{Ordering, Reverse};

use error_stack::{Report, ResultExt};
use ratatui::layout::Rect;
use serde::{Deserialize, Serialize};
use wherror::Error;

use crate::ids::PaneId;

/// The fewest rows a pane outside a stack keeps after an `Alt +` step, its
/// frame included. A stack keeps twice this, since its list takes up to
/// half its rows.
const MIN_PANE_ROWS: u16 = 5;
/// The fewest columns any pane or stack keeps after an `Alt +` step, its
/// frame included.
const MIN_PANE_COLS: u16 = 5;

/// The `Alt +`/`Alt -` step, in percent of the tab, when the stacked one has
/// nowhere to go, and the least share of the tab a moved pane keeps.
const RESIZE_PERCENT: f32 = 5.0;
/// The share of the tab `Alt +`/`Alt -` try first.
const STACKED_RESIZE_PERCENT: f32 = 30.0;

/// `percent` of `extent` cells, rounded, at least 1.
fn cells(extent: u16, percent: f32) -> u16 {
    ((f32::from(extent) * percent / 100.0).round() as u16).max(1)
}

/// Which way a split puts its second pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Split {
    /// Side by side; the new pane on the right.
    Right,
    /// Stacked; the new pane below.
    Down,
}

/// Cardinal direction for focus moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavDirection {
    Left,
    Right,
    Up,
    Down,
}

impl NavDirection {
    /// The direction facing the other way.
    pub(super) fn opposite(self) -> Self {
        match self {
            Self::Left => Self::Right,
            Self::Right => Self::Left,
            Self::Up => Self::Down,
            Self::Down => Self::Up,
        }
    }
}

/// Where a pane lands in an area, and whether it has the focus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneInfo {
    pub id: PaneId,
    pub rect: Rect,
    pub is_focused: bool,
    /// A stack's one-row title: the pane is in the stack but not expanded.
    pub collapsed: bool,
}

/// A stack in an area: the rect it takes, its panes in order and the one
/// expanded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StackInfo {
    pub area: Rect,
    pub panes: Vec<PaneId>,
    pub expanded: PaneId,
}

impl StackInfo {
    /// The stack's drawn list: how many rows it takes (at most half the
    /// stack, at least one) and the first pane it lists, scrolled so the
    /// shown pane stays listed.
    #[must_use]
    pub fn list_rows(&self) -> (u16, usize) {
        let len = self.panes.len();
        let at = self
            .panes
            .iter()
            .position(|id| *id == self.expanded)
            .unwrap_or_default();
        let fits = len.min(usize::from(self.area.height / 2)).max(1);
        let start = if len > fits {
            at.saturating_sub(fits - 1)
        } else {
            0
        };
        (u16::try_from(fits).unwrap_or(u16::MAX), start)
    }
}

/// What a [`TileLayout::grow_focused`] step did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grow {
    /// The focused pane's border moved.
    Grew,
    /// The focused pane's parent split became one stack showing it.
    Stacked,
    /// No split holds the focused pane or its stack: a lone pane, or a tree
    /// that is one stack.
    Stuck,
}

/// A tab's place in the list of swap layouts, in list order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwapLayout {
    /// The tab's starting shape: one pane.
    Base,
    /// Columns of panes (orb's grid).
    Vertical,
    /// Rows of panes: vertical turned on its side.
    Horizontal,
    /// One stack of every pane.
    Stacked,
    /// The first pane on the left half, the rest stacked on the right.
    HalfStacked,
}

impl SwapLayout {
    const ALL: [Self; 5] = [
        Self::Base,
        Self::Vertical,
        Self::Horizontal,
        Self::Stacked,
        Self::HalfStacked,
    ];

    /// Whether the layout has a template for `n` panes.
    fn fits(self, n: usize) -> bool {
        match self {
            Self::Base => n == 1,
            Self::Vertical | Self::Horizontal => (1..=10).contains(&n),
            Self::Stacked => n >= 2,
            Self::HalfStacked => n >= 3,
        }
    }

    /// The first layout that fits `n` panes, starting at this one (at the
    /// one after it when `step`), going backwards when `back`, wrapping;
    /// `None` when none fits after a full turn.
    pub fn fitting(self, n: usize, step: bool, back: bool) -> Option<Self> {
        first_fitting(&Self::ALL, self as usize, step, back, |layout| {
            layout.fits(n)
        })
    }
}

/// The first of `all` that `fits`, starting at index `at` (at the one after
/// it when `step`), going backwards when `back`, wrapping; `None` when none
/// fits after a full turn.
pub(super) fn first_fitting<T, F>(
    all: &[T],
    at: usize,
    step: bool,
    back: bool,
    fits: F,
) -> Option<T>
where
    T: Copy,
    F: Fn(T) -> bool,
{
    let len = all.len();
    (usize::from(step)..usize::from(step) + len)
        .map(|offset| {
            if back {
                (at + 2 * len - offset) % len
            } else {
                (at + offset) % len
            }
        })
        .filter_map(|index| all.get(index).copied())
        .find(|layout| fits(*layout))
}

/// A node of the tree: one pane, a split holding two subtrees, or a stack
/// of panes sharing one area.
#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Pane(PaneId),
    Split {
        split: Split,
        /// The share of the area the first subtree takes.
        ratio: f32,
        first: Box<Node>,
        second: Box<Node>,
    },
    /// Panes in one area: `expanded` gets the rows, every other pane a
    /// one-row title. Holds at least two panes, `expanded` among them.
    Stack {
        panes: Vec<PaneId>,
        expanded: PaneId,
    },
}

/// A tab's tiling: the tree of splits and the focused pane.
#[derive(Debug, Clone, PartialEq)]
pub struct TileLayout {
    root: Node,
    focus: PaneId,
    /// Pane focused before `focus`, where `close_focused` returns to. Only a
    /// real focus move writes it.
    prev_focus: Option<PaneId>,
}

/// A saved tree couldn't be read.
#[derive(Debug, Error)]
#[error(debug)]
pub struct LayoutJsonError;

impl TileLayout {
    /// A layout of the one pane `root`, focused.
    pub fn new(root: PaneId) -> Self {
        Self::from_saved(Node::Pane(root), root)
    }

    /// A layout of the tree `root`, focused on `focus`, which is expanded
    /// if it's stacked.
    pub fn from_saved(mut root: Node, focus: PaneId) -> Self {
        expand(&mut root, focus);
        Self {
            root,
            focus,
            prev_focus: None,
        }
    }

    /// Move focus, recording the pane being left, and expand it if it's
    /// stacked. Focus and its history stay when focus is unchanged.
    fn set_focus(&mut self, id: PaneId) {
        expand(&mut self.root, id);
        if id != self.focus {
            self.prev_focus = Some(self.focus);
            self.focus = id;
        }
    }

    pub fn focused(&self) -> PaneId {
        self.focus
    }

    pub fn pane_count(&self) -> usize {
        count_panes(&self.root)
    }

    /// Where each pane lands in `area`, in tree order.
    pub fn panes(&self, area: Rect) -> Vec<PaneInfo> {
        let mut result = Vec::new();
        collect_panes(&self.root, area, self.focus, &mut result);
        result
    }

    /// Every stack in the tree and the area it takes in `area`, in tree order.
    pub fn stacks(&self, area: Rect) -> Vec<StackInfo> {
        let mut stacks = Vec::new();
        stacks_in(&self.root, area, &mut stacks);
        stacks
    }

    /// Where each pane sits for a focus move or a move-mode step in `area`:
    /// a stack holding the focus keeps its rows in list order, so a move
    /// inside it steps through the list; every other stack sits as drawn,
    /// its list rows on top and its shown pane below them.
    pub fn nav_panes(&self, area: Rect) -> Vec<PaneInfo> {
        let drawn: Vec<StackInfo> = self
            .stacks(area)
            .into_iter()
            .filter(|stack| !stack.panes.contains(&self.focus))
            .collect();
        let mut panes: Vec<PaneInfo> = self
            .panes(area)
            .into_iter()
            .filter(|info| !drawn.iter().any(|stack| stack.panes.contains(&info.id)))
            .collect();
        for stack in drawn {
            let bounds = stack.area;
            let (rows, start) = stack.list_rows();
            // A stack with no rows has no list, so its shown pane sits at
            // its top edge, right above the pane below it.
            let rows = rows.min(bounds.height);
            // ponytail: a list row counts as the stack's full width; the drawn
            // list is only as wide as its names, which only the frontend knows.
            // Pass the list width in if a pane overlapping only the stack's
            // edges must skip the list.
            panes.extend(
                stack
                    .panes
                    .iter()
                    .skip(start)
                    .zip(bounds.y..bounds.y.saturating_add(rows))
                    .map(|(id, y)| PaneInfo {
                        id: *id,
                        rect: Rect::new(bounds.x, y, bounds.width, 1),
                        is_focused: false,
                        collapsed: true,
                    }),
            );
            panes.push(PaneInfo {
                id: stack.expanded,
                rect: Rect::new(
                    bounds.x,
                    bounds.y.saturating_add(rows),
                    bounds.width,
                    bounds.height.saturating_sub(rows),
                ),
                is_focused: false,
                collapsed: false,
            });
        }
        panes
    }

    /// Every pane id, in tree order.
    pub fn pane_ids(&self) -> Vec<PaneId> {
        let mut ids = Vec::new();
        collect_ids(&self.root, &mut ids);
        ids
    }

    /// Splits the focused pane, or its whole stack when it's stacked, `split`:
    /// the new pane `id` goes right after it and takes the focus, and the run
    /// of `split` splits the two join is re-divided into equal shares.
    pub fn split_focused(&mut self, split: Split, id: PaneId) {
        if self.split_at(self.focus, split, id) {
            self.set_focus(id);
        }
    }

    /// Splits pane `at`, or its whole stack when it's stacked, `split`: the
    /// new pane `id` goes right after it, the run is re-divided evenly, and
    /// the focus stays where it was. Whether `at` is in this tree.
    pub fn split_at(&mut self, at: PaneId, split: Split, id: PaneId) -> bool {
        let Some(node) = find_holding_mut(&mut self.root, at) else {
            return false;
        };
        let held = std::mem::replace(node, Node::Pane(id));
        *node = split_node(held, split, id, 0.5);
        even_run(&mut self.root, split, id);
        true
    }

    /// Stacks the new pane `id` right after the focused pane and focuses it:
    /// in the focused pane's stack when it has one, else in a new stack of
    /// the two.
    pub fn stack_focused(&mut self, id: PaneId) {
        self.stack_at(self.focus, id);
        self.set_focus(id);
    }

    /// Stacks the new pane `id` right after pane `at`: in `at`'s stack when it
    /// has one, which keeps showing the pane it showed, else in a new stack of
    /// the two showing `at`. The focus stays where it was. Whether `at` is in
    /// this tree.
    pub fn stack_at(&mut self, at: PaneId, id: PaneId) -> bool {
        if let Some(panes) = find_stack_holding_mut(&mut self.root, at) {
            let index = panes
                .iter()
                .position(|pane| *pane == at)
                .map_or(panes.len(), |index| index + 1);
            panes.insert(index, id);
            return true;
        }
        let Some(node) = find_holding_mut(&mut self.root, at) else {
            return false;
        };
        *node = Node::Stack {
            panes: vec![at, id],
            expanded: at,
        };
        true
    }

    /// Adds pane `id`, focused, where a new pane goes in a tab changed by
    /// hand: into the focused pane's stack when it has one; else it halves
    /// the focused pane's cell in `area`, top and bottom when it's tall (rows
    /// × [`CELL_RATIO`] over its columns, and over 20 rows), left and right
    /// when it's over 60 columns; else the two are stacked. No other pane
    /// moves.
    pub fn add_beside_focus(&mut self, id: PaneId, area: Rect) {
        let focus = self.focus;
        let stacked = self
            .stacks(area)
            .iter()
            .any(|stack| stack.panes.contains(&focus));
        let split = self
            .panes(area)
            .into_iter()
            .find(|info| info.id == focus && !stacked)
            .and_then(|info| {
                let (rows, cols) = (info.rect.height, info.rect.width);
                if rows.saturating_mul(CELL_RATIO) > cols && rows > 20 {
                    Some(Split::Down)
                } else if cols > 60 {
                    Some(Split::Right)
                } else {
                    None
                }
            });
        match split.zip(find_holding_mut(&mut self.root, focus)) {
            Some((split, node)) => {
                *node = split_node(Node::Pane(focus), split, id, 0.5);
                self.set_focus(id);
            }
            None => self.stack_focused(id),
        }
    }

    /// Rebuilds the tree from `layout`'s template, panes in their current
    /// tree order. Focus, its history and each stack's expanded pane stay.
    pub fn tile(&mut self, layout: SwapLayout) {
        let prefer: Vec<PaneId> = std::iter::once(self.focus)
            .chain(
                self.stacks(Rect::default())
                    .into_iter()
                    .map(|stack| stack.expanded),
            )
            .collect();
        if let Some(root) = template_for(layout, &self.pane_ids(), &prefer) {
            self.root = root;
        }
    }

    /// Adds pane `id` last in reading order, re-tiles in `layout`, and
    /// focuses it.
    pub fn add_tiled(&mut self, id: PaneId, layout: SwapLayout) {
        let ids = {
            let mut ids = self.pane_ids();
            ids.push(id);
            ids
        };
        if let Some(root) = template_for(layout, &ids, &[id]) {
            self.root = root;
            self.set_focus(id);
        }
    }

    /// Close the focused pane, returning focus to the pane it came from when
    /// that pane is still open. Returns false if it's the last pane.
    pub fn close_focused(&mut self) -> bool {
        if self.pane_count() <= 1 {
            return false;
        }
        let target = self.focus;
        let ids = self.pane_ids();
        let Some(pos) = ids.iter().position(|id| *id == target) else {
            return false;
        };
        let ordered = ids
            .get(pos + 1)
            .or_else(|| ids.get(pos.wrapping_sub(1)))
            .copied()
            .unwrap_or(target);
        let new_focus = match self.prev_focus {
            Some(prev) if prev != target && ids.contains(&prev) => prev,
            _ => ordered,
        };
        let old = std::mem::replace(&mut self.root, Node::Pane(PaneId(0)));
        match remove_pane(old, target) {
            Some(new_root) => {
                self.root = new_root;
                self.focus = new_focus;
                expand(&mut self.root, new_focus);
                self.prev_focus = None;
                true
            }
            None => false,
        }
    }

    /// Close any pane. Focus and its history are left alone unless the closed
    /// pane is the focused one. Returns false for the last pane or one not here.
    pub fn close_pane(&mut self, id: PaneId) -> bool {
        if self.focus == id {
            return self.close_focused();
        }
        if self.pane_count() <= 1 || !self.pane_ids().contains(&id) {
            return false;
        }
        let old = std::mem::replace(&mut self.root, Node::Pane(PaneId(0)));
        let Some(new_root) = remove_pane(old, id) else {
            return false;
        };
        self.root = new_root;
        if self.prev_focus == Some(id) {
            self.prev_focus = None;
        }
        true
    }

    /// Focus `id` when it is one of this layout's panes.
    pub fn focus_pane(&mut self, id: PaneId) {
        if self.pane_ids().contains(&id) {
            self.set_focus(id);
        }
    }

    /// `Alt +`: towards the first neighbour above, below,
    /// left or right that lines up with the focused pane (or its stack) along
    /// its whole edge, grows it [`STACKED_RESIZE_PERCENT`] of the tab, or
    /// when that leaves a pane there too small, stacks it with that
    /// neighbour. With no such neighbour it grows [`RESIZE_PERCENT`] any way
    /// that fits; `Stuck` when nothing fits.
    pub fn grow_focused(&mut self, body: Rect) -> Grow {
        for dir in [
            NavDirection::Up,
            NavDirection::Down,
            NavDirection::Left,
            NavDirection::Right,
        ] {
            if !self.lined_up(body, dir) {
                continue;
            }
            if self.resize_toward(body, dir, true, STACKED_RESIZE_PERCENT) {
                return Grow::Grew;
            }
            if self.stack_toward(body, dir) {
                return Grow::Stacked;
            }
        }
        if self.resize_any(body, true, RESIZE_PERCENT) {
            Grow::Grew
        } else {
            Grow::Stuck
        }
    }

    /// `Alt -`: breaks one pane out of the focused pane's
    /// stack, else shrinks the focused pane [`STACKED_RESIZE_PERCENT`] of the
    /// tab, else [`RESIZE_PERCENT`], any way that fits. Whether it changed.
    pub fn shrink_focused(&mut self, body: Rect) -> bool {
        self.unstack_focused()
            || self.resize_any(body, false, STACKED_RESIZE_PERCENT)
            || self.resize_any(body, false, RESIZE_PERCENT)
    }

    /// Resize mode's step: moves the focused unit's (pane's or stack's) edge
    /// facing `dir` [`RESIZE_PERCENT`] of the tab, out when `grow`, in
    /// otherwise. A grow that can't go that way (the tab's edge, or a
    /// neighbour that would get too small) pulls the opposite edge in
    /// instead; a shrink never falls back. Whether it changed.
    pub fn resize_side(&mut self, body: Rect, dir: NavDirection, grow: bool) -> bool {
        self.resize_toward(body, dir, grow, RESIZE_PERCENT)
            || (grow && self.resize_toward(body, dir.opposite(), false, RESIZE_PERCENT))
    }

    /// Move mode's step: swaps the focused pane with the pane `dir` of it,
    /// the one a directional focus move would reach. Whether it moved.
    pub fn swap_toward(&mut self, body: Rect, dir: NavDirection) -> bool {
        let panes = self.nav_panes(body);
        let target = panes
            .iter()
            .find(|info| info.is_focused)
            .and_then(|focused| find_in_direction(focused, dir, &panes));
        target.is_some_and(|target| self.swap_with(target))
    }

    /// Move mode's step in tree order: swaps the focused pane with the next
    /// (`forward`) or previous pane, wrapping. Whether it moved; a lone pane
    /// doesn't.
    pub fn swap_in_order(&mut self, forward: bool) -> bool {
        let ids = self.pane_ids();
        let target = ids.iter().position(|id| *id == self.focus).and_then(|at| {
            let n = ids.len();
            let step = if forward { 1 } else { n - 1 };
            let next = (at + step) % n;
            ids.get(next).copied()
        });
        target.is_some_and(|target| self.swap_with(target))
    }

    /// Swaps the focused pane and `target` wherever they sit (a pane, a
    /// stack entry, a stack's shown pane); the focus stays on the moved
    /// pane, shown if it landed in a stack. The tree's shape doesn't change.
    fn swap_with(&mut self, target: PaneId) -> bool {
        if target == self.focus {
            return false;
        }
        swap_ids(&mut self.root, self.focus, target);
        self.set_focus(self.focus);
        true
    }

    /// A resize with no direction: the first of the corners (right
    /// and down, left and down, right and up, left and up), then the sides
    /// (right, down, left, up) where both moves fit.
    fn resize_any(&mut self, body: Rect, grow: bool, percent: f32) -> bool {
        use NavDirection::{Down, Left, Right, Up};
        let order = [
            (Right, Some(Down)),
            (Left, Some(Down)),
            (Right, Some(Up)),
            (Left, Some(Up)),
            (Right, None),
            (Down, None),
            (Left, None),
            (Up, None),
        ];
        for (main, sub) in order {
            let mut layout = self.clone();
            if layout.resize_toward(body, main, grow, percent)
                && sub.is_none_or(|sub| layout.resize_toward(body, sub, grow, percent))
            {
                *self = layout;
                return true;
            }
        }
        false
    }

    /// Moves the focused unit's (pane's or stack's) edge facing `dir` by
    /// `percent` of the tab that way: out when `grow`, in otherwise, with
    /// every pane along the same border. Nothing changes, and `false`, when
    /// the edge is the tab's or a moved pane would end under
    /// [`MIN_PANE_COLS`] × [`MIN_PANE_ROWS`] (a stack twice the rows) or
    /// under [`RESIZE_PERCENT`] of the tab.
    fn resize_toward(&mut self, body: Rect, dir: NavDirection, grow: bool, percent: f32) -> bool {
        let Some(edge) = edge(&self.root, body, self.focus, dir) else {
            return false;
        };
        let (region_start, region_len) = along(edge.region, edge.split);
        let cells = cells(along(body, edge.split).1, percent);
        let back = matches!(dir, NavDirection::Up | NavDirection::Left) == grow;
        let to = if back {
            edge.border.checked_sub(cells)
        } else {
            edge.border.checked_add(cells)
        };
        let Some(to) = to.filter(|to| (region_start + 1..region_start + region_len).contains(to))
        else {
            return false;
        };
        let before = leaves_of(&self.root, body, self.focus);
        let Some(after) = shifted(&before, &edge, to) else {
            return false;
        };
        let fits = after
            .iter()
            .zip(&before)
            .all(|(a, b)| a.rect == b.rect || a.roomy(body));
        if fits {
            fit(&mut self.root, &after);
        }
        fits
    }

    /// Whether the focused unit has direct neighbours towards
    /// `dir`: panes or stacks touching its edge that lie within its sides
    /// and together cover the whole edge.
    fn lined_up(&self, body: Rect, dir: NavDirection) -> bool {
        let leaves = leaves_of(&self.root, body, self.focus);
        let Some(unit) = leaves.iter().find(|leaf| leaf.focused) else {
            return false;
        };
        let split = axis(dir);
        let (start, len) = along(unit.rect, split);
        let (side, width) = across(unit.rect, split);
        let touching: Vec<(u16, u16)> = leaves
            .iter()
            .filter(|leaf| {
                let (n_start, n_len) = along(leaf.rect, split);
                let touches = match dir {
                    NavDirection::Up | NavDirection::Left => n_start + n_len == start,
                    NavDirection::Down | NavDirection::Right => n_start == start + len,
                };
                let (n_side, n_width) = across(leaf.rect, split);
                touches && ranges_overlap(side, width, n_side, n_width)
            })
            .map(|leaf| across(leaf.rect, split))
            .filter(|(n_side, n_width)| *n_side >= side && n_side + n_width <= side + width)
            .collect();
        touching.iter().any(|(n_side, _)| *n_side == side)
            && touching
                .iter()
                .any(|(n_side, n_width)| n_side + n_width == side + width)
    }

    /// Makes the focused unit and its neighbours
    /// across the edge facing `dir` one stack showing the focused pane, over
    /// both their areas. Only when the unit spans the whole border; `false`
    /// otherwise.
    // ponytail: a unit narrower than its border doesn't stack, since the tree can't hold a stack
    // across two subtrees; restructure the tree if aligned-neighbour stacks matter
    fn stack_toward(&mut self, body: Rect, dir: NavDirection) -> bool {
        let Some(edge) = edge(&self.root, body, self.focus, dir) else {
            return false;
        };
        let before = leaves_of(&self.root, body, self.focus);
        let Some(unit) = before.iter().find(|leaf| leaf.focused).copied() else {
            return false;
        };
        if across(unit.rect, edge.split) != across(edge.region, edge.split) {
            return false;
        }
        let unit_first = matches!(dir, NavDirection::Down | NavDirection::Right);
        let root = std::mem::replace(&mut self.root, Node::Pane(self.focus));
        let mut stacked = Vec::new();
        self.root = stack_at(root, body, &edge, unit_first, self.focus, &mut stacked);
        let rect = before
            .iter()
            .filter(|leaf| stacked.contains(&leaf.key))
            .fold(unit.rect, |rect, leaf| rect.union(leaf.rect));
        let mut after: Vec<Leaf> = before
            .into_iter()
            .filter(|leaf| !stacked.contains(&leaf.key))
            .collect();
        let key = match find_holding_mut(&mut self.root, self.focus) {
            Some(Node::Stack { panes, .. }) => panes.first().copied(),
            _ => None,
        };
        after.extend(key.map(|key| Leaf {
            key,
            rect,
            stack: true,
            focused: true,
        }));
        fit(&mut self.root, &after);
        true
    }

    /// The focused pane's stack gives its
    /// top pane (when the shown pane is its last) or its bottom pane a
    /// 1/n share of its rows, above or below it. `false` outside a stack.
    fn unstack_focused(&mut self) -> bool {
        let Some(node) = find_holding_mut(&mut self.root, self.focus) else {
            return false;
        };
        let Node::Stack { panes, expanded } = node else {
            return false;
        };
        let (mut panes, expanded) = (std::mem::take(panes), *expanded);
        let count = panes.len() as f32;
        let up = panes.last() == Some(&expanded);
        let out = if up {
            panes.remove(0)
        } else {
            panes.pop().unwrap_or(expanded)
        };
        let Some(rest) = stack(panes, expanded) else {
            return false;
        };
        let out = Box::new(Node::Pane(out));
        let rest = Box::new(rest);
        *node = if up {
            Node::Split {
                split: Split::Down,
                ratio: 1.0 / count,
                first: out,
                second: rest,
            }
        } else {
            Node::Split {
                split: Split::Down,
                ratio: (count - 1.0) / count,
                first: rest,
                second: out,
            }
        };
        true
    }

    /// The tree as JSON: `{"pane":7}` or
    /// `{"split":"right","ratio":0.5,"first":…,"second":…}` or
    /// `{"stack":[3,4,5],"expanded":4}`.
    pub fn to_json(&self) -> String {
        serde_json::to_string(&Saved::from(&self.root)).unwrap_or_default()
    }

    /// A layout from [`Self::to_json`]'s output, focused on `focus`, or on
    /// its first pane when `focus` isn't in it.
    ///
    /// # Errors
    ///
    /// Returns an error if `json` isn't a saved tree.
    pub fn from_json(json: &str, focus: PaneId) -> Result<Self, Report<LayoutJsonError>> {
        let saved: Saved = serde_json::from_str(json)
            .change_context(LayoutJsonError)
            .attach("failed to read a saved layout tree")?;
        let root = load(saved)
            .ok_or_else(|| Report::new(LayoutJsonError))
            .attach("the saved layout tree holds no panes")?;
        let focus = {
            let mut ids = Vec::new();
            collect_ids(&root, &mut ids);
            if ids.contains(&focus) {
                focus
            } else {
                ids.first().copied().unwrap_or(focus)
            }
        };
        Ok(Self::from_saved(root, focus))
    }
}

/// The JSON shape of a [`Node`].
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum Saved {
    Pane {
        pane: PaneId,
    },
    Split {
        split: Split,
        ratio: f32,
        first: Box<Saved>,
        second: Box<Saved>,
    },
    Stack {
        stack: Vec<PaneId>,
        expanded: PaneId,
    },
}

impl From<&Node> for Saved {
    fn from(node: &Node) -> Self {
        match node {
            Node::Pane(pane) => Self::Pane { pane: *pane },
            Node::Split {
                split,
                ratio,
                first,
                second,
            } => Self::Split {
                split: *split,
                ratio: *ratio,
                first: Box::new(Self::from(first.as_ref())),
                second: Box::new(Self::from(second.as_ref())),
            },
            Node::Stack { panes, expanded } => Self::Stack {
                stack: panes.clone(),
                expanded: *expanded,
            },
        }
    }
}

/// The tree `saved` describes, ratios clamped. A stack whose `expanded`
/// isn't in it expands its first pane, a one-pane stack is that pane, and
/// an empty stack is dropped (its split's other side takes its place).
fn load(saved: Saved) -> Option<Node> {
    match saved {
        Saved::Pane { pane } => Some(Node::Pane(pane)),
        Saved::Split {
            split,
            ratio,
            first,
            second,
        } => match (load(*first), load(*second)) {
            (Some(first), Some(second)) => Some(Node::Split {
                split,
                ratio: valid_split_ratio(ratio),
                first: Box::new(first),
                second: Box::new(second),
            }),
            (first, second) => first.or(second),
        },
        Saved::Stack {
            stack: panes,
            expanded,
        } => stack(panes, expanded),
    }
}

/// Expands pane `id` in the stack holding it; other trees stay as they are.
fn expand(node: &mut Node, id: PaneId) {
    match node {
        Node::Stack { panes, expanded } if panes.contains(&id) => *expanded = id,
        Node::Split { first, second, .. } => {
            expand(first, id);
            expand(second, id);
        }
        _ => {}
    }
}

/// Swaps ids `a` and `b` everywhere in `node`.
fn swap_ids(node: &mut Node, a: PaneId, b: PaneId) {
    let swap = |id: &mut PaneId| match *id {
        x if x == a => *id = b,
        x if x == b => *id = a,
        _ => {}
    };
    match node {
        Node::Pane(id) => swap(id),
        Node::Split { first, second, .. } => {
            swap_ids(first, a, b);
            swap_ids(second, a, b);
        }
        Node::Stack { panes, expanded } => {
            panes.iter_mut().for_each(swap);
            swap(expanded);
        }
    }
}

/// `panes` as a stack expanding `expanded`, or its first pane when
/// `expanded` isn't one of them. One pane is just that pane; none is nothing.
fn stack(panes: Vec<PaneId>, expanded: PaneId) -> Option<Node> {
    match panes.as_slice() {
        [] => None,
        [only] => Some(Node::Pane(*only)),
        [first, ..] => {
            let expanded = if panes.contains(&expanded) {
                expanded
            } else {
                *first
            };
            Some(Node::Stack { panes, expanded })
        }
    }
}

// --- Directional pane navigation ---

/// Find the nearest pane in the given direction from `focused`.
pub fn find_in_direction(
    focused: &PaneInfo,
    direction: NavDirection,
    panes: &[PaneInfo],
) -> Option<PaneId> {
    let fr = focused.rect;

    panes
        .iter()
        .enumerate()
        .filter(|(_, p)| p.id != focused.id)
        .filter(|(_, p)| {
            let r = p.rect;
            match direction {
                NavDirection::Left => {
                    r.x + r.width <= fr.x && ranges_overlap(r.y, r.height, fr.y, fr.height)
                }
                NavDirection::Right => {
                    r.x >= fr.x + fr.width && ranges_overlap(r.y, r.height, fr.y, fr.height)
                }
                NavDirection::Up => {
                    r.y + r.height <= fr.y && ranges_overlap(r.x, r.width, fr.x, fr.width)
                }
                NavDirection::Down => {
                    r.y >= fr.y + fr.height && ranges_overlap(r.x, r.width, fr.x, fr.width)
                }
            }
        })
        .min_by_key(|(index, p)| {
            let r = p.rect;
            let edge_distance = match direction {
                NavDirection::Left => fr.x.saturating_sub(r.x + r.width),
                NavDirection::Right => r.x.saturating_sub(fr.x + fr.width),
                NavDirection::Up => fr.y.saturating_sub(r.y + r.height),
                NavDirection::Down => r.y.saturating_sub(fr.y + fr.height),
            };
            let overlap = match direction {
                NavDirection::Left | NavDirection::Right => {
                    range_overlap_amount(r.y, r.height, fr.y, fr.height)
                }
                NavDirection::Up | NavDirection::Down => {
                    range_overlap_amount(r.x, r.width, fr.x, fr.width)
                }
            };
            let center_distance = match direction {
                NavDirection::Left | NavDirection::Right => {
                    range_center_distance(r.y, r.height, fr.y, fr.height)
                }
                NavDirection::Up | NavDirection::Down => {
                    range_center_distance(r.x, r.width, fr.x, fr.width)
                }
            };
            (edge_distance, Reverse(overlap), center_distance, *index)
        })
        .map(|(_, p)| p.id)
}

fn ranges_overlap(a_start: u16, a_len: u16, b_start: u16, b_len: u16) -> bool {
    a_start < b_start + b_len && a_start + a_len > b_start
}

fn range_overlap_amount(a_start: u16, a_len: u16, b_start: u16, b_len: u16) -> u16 {
    let a_end = a_start.saturating_add(a_len);
    let b_end = b_start.saturating_add(b_len);
    a_end.min(b_end).saturating_sub(a_start.max(b_start))
}

fn range_center_distance(a_start: u16, a_len: u16, b_start: u16, b_len: u16) -> u16 {
    let a_center = a_start.saturating_mul(2).saturating_add(a_len);
    let b_center = b_start.saturating_mul(2).saturating_add(b_len);
    a_center.abs_diff(b_center)
}

// --- Tree operations ---

/// Line sizes for `n` panes, first line first (the vertical and
/// horizontal layouts, 1–10 panes).
fn columns(n: usize) -> Vec<usize> {
    match n {
        0 => vec![],
        1 => vec![1],
        _ => {
            let mut cols = vec![1];
            let mut rest = n - 1;
            while rest > 0 {
                let take = rest.min(4);
                cols.push(take);
                rest -= take;
            }
            if cols.len() > 2 && cols.last() == Some(&1) {
                cols.pop();
                if let Some(first) = cols.first_mut() {
                    *first += 1;
                }
            }
            cols
        }
    }
}

/// `nodes` side by side (`Right`) or top to bottom (`Down`) in equal
/// shares: a chain whose ratios run 1/m, 1/(m-1), …, 1/2.
fn even_chain(mut nodes: Vec<Node>, split: Split) -> Option<Node> {
    let last = nodes.pop()?;
    Some(
        nodes
            .into_iter()
            .rev()
            .enumerate()
            .fold(last, |second, (i, first)| Node::Split {
                split,
                ratio: 1.0 / (i as f32 + 2.0),
                first: Box::new(first),
                second: Box::new(second),
            }),
    )
}

/// `ids` in reading order as lines from [`columns`] chained `across` in
/// equal shares, the panes in each line chained the other way: columns for
/// `Right`, rows for `Down`.
fn grid(ids: &[PaneId], across: Split) -> Option<Node> {
    let along = match across {
        Split::Right => Split::Down,
        Split::Down => Split::Right,
    };
    let mut rest = ids.iter().copied();
    let lines = columns(ids.len())
        .into_iter()
        .filter_map(|k| even_chain(rest.by_ref().take(k).map(Node::Pane).collect(), along))
        .collect();
    even_chain(lines, across)
}

/// `layout`'s tree for `ids` in reading order. A stack expands the first of
/// `prefer` it holds, else its last pane. `None` for no ids.
fn template_for(layout: SwapLayout, ids: &[PaneId], prefer: &[PaneId]) -> Option<Node> {
    let expanded = |panes: &[PaneId]| {
        prefer
            .iter()
            .copied()
            .find(|id| panes.contains(id))
            .or_else(|| panes.last().copied())
    };
    match layout {
        SwapLayout::Base | SwapLayout::Vertical => grid(ids, Split::Right),
        SwapLayout::Horizontal => grid(ids, Split::Down),
        SwapLayout::Stacked => stack(ids.to_vec(), expanded(ids)?),
        SwapLayout::HalfStacked => {
            let (first, rest) = ids.split_first()?;
            even_chain(
                vec![Node::Pane(*first), stack(rest.to_vec(), expanded(rest)?)?],
                Split::Right,
            )
        }
    }
}

/// `node`'s run of `split` splits, flattened: every subtree under it that
/// isn't itself a `split` split, in tree order. Anything else (a pane, a
/// split the other way) is a run of one.
fn run_members(node: &Node, split: Split) -> Vec<Node> {
    match node {
        Node::Split {
            split: direction,
            first,
            second,
            ..
        } if *direction == split => {
            let mut members = run_members(first, split);
            members.extend(run_members(second, split));
            members
        }
        _ => vec![node.clone()],
    }
}

/// Shares the run of `split` splits that pane `id` sits in out evenly: the
/// topmost `split` split whose run has `id` as a member becomes an
/// [`even_chain`] of that run's members.
fn even_run(node: &mut Node, split: Split, id: PaneId) {
    let members = run_members(node, split);
    if members.len() > 1 && members.contains(&Node::Pane(id)) {
        if let Some(chain) = even_chain(members, split) {
            *node = chain;
        }
        return;
    }
    if let Node::Split { first, second, .. } = node {
        even_run(first, split, id);
        even_run(second, split, id);
    }
}

fn count_panes(node: &Node) -> usize {
    match node {
        Node::Pane(_) => 1,
        Node::Split { first, second, .. } => count_panes(first) + count_panes(second),
        Node::Stack { panes, .. } => panes.len(),
    }
}

fn collect_panes(node: &Node, area: Rect, focus: PaneId, result: &mut Vec<PaneInfo>) {
    match node {
        Node::Pane(id) => result.push(PaneInfo {
            id: *id,
            rect: area,
            is_focused: *id == focus,
            collapsed: false,
        }),
        Node::Split {
            split,
            ratio,
            first,
            second,
        } => {
            let (a, b) = split_rect(area, *split, *ratio);
            collect_panes(first, a, focus, result);
            collect_panes(second, b, focus, result);
        }
        Node::Stack { panes, expanded } => {
            let at = panes
                .iter()
                .position(|id| id == expanded)
                .unwrap_or_default();
            let titles = u16::try_from(panes.len().saturating_sub(1)).unwrap_or(u16::MAX);
            // The expanded pane's rows: what the titles leave, at least one.
            let tall = area.height.saturating_sub(titles).max(1).min(area.height);
            // Titles above it that fit beside those rows.
            let above = at.min(usize::from(area.height.saturating_sub(tall)));
            let mut y = area.y;
            for (index, id) in panes.iter().enumerate() {
                let rows = match index.cmp(&at) {
                    Ordering::Equal => tall,
                    Ordering::Less if index < above => 1,
                    Ordering::Less => 0,
                    Ordering::Greater => area.bottom().saturating_sub(y).min(1),
                };
                if rows == 0 && index != at {
                    continue;
                }
                result.push(PaneInfo {
                    id: *id,
                    rect: Rect::new(area.x, y, area.width, rows),
                    is_focused: *id == focus,
                    collapsed: index != at,
                });
                y = y.saturating_add(rows);
            }
        }
    }
}

fn stacks_in(node: &Node, area: Rect, stacks: &mut Vec<StackInfo>) {
    match node {
        Node::Pane(_) => {}
        Node::Split {
            split,
            ratio,
            first,
            second,
        } => {
            let (a, b) = split_rect(area, *split, *ratio);
            stacks_in(first, a, stacks);
            stacks_in(second, b, stacks);
        }
        Node::Stack { panes, expanded } => stacks.push(StackInfo {
            area,
            panes: panes.clone(),
            expanded: *expanded,
        }),
    }
}

fn collect_ids(node: &Node, ids: &mut Vec<PaneId>) {
    match node {
        Node::Pane(id) => ids.push(*id),
        Node::Split { first, second, .. } => {
            collect_ids(first, ids);
            collect_ids(second, ids);
        }
        Node::Stack { panes, .. } => ids.extend(panes.iter().copied()),
    }
}

/// The panes of the stack holding pane `target`, if one does.
fn find_stack_holding_mut(node: &mut Node, target: PaneId) -> Option<&mut Vec<PaneId>> {
    match node {
        Node::Stack { panes, .. } if panes.contains(&target) => Some(panes),
        Node::Pane(_) | Node::Stack { .. } => None,
        Node::Split { first, second, .. } => {
            find_stack_holding_mut(first, target).or_else(|| find_stack_holding_mut(second, target))
        }
    }
}

/// The cell height-to-width ratio: kitty-style 8×16 cells.
// ponytail: fixed cell ratio, read the terminal's pixel cell size if splits pick the wrong way
const CELL_RATIO: u16 = 2;

/// Pane `target`'s node, or the stack holding it.
fn find_holding_mut(node: &mut Node, target: PaneId) -> Option<&mut Node> {
    if holds(node, target) {
        return Some(node);
    }
    match node {
        Node::Split { first, second, .. } => {
            find_holding_mut(first, target).or_else(|| find_holding_mut(second, target))
        }
        Node::Pane(_) | Node::Stack { .. } => None,
    }
}

/// Whether `node` is pane `target` or a stack holding it.
fn holds(node: &Node, target: PaneId) -> bool {
    match node {
        Node::Pane(id) => *id == target,
        Node::Stack { panes, .. } => panes.contains(&target),
        Node::Split { .. } => false,
    }
}

/// A leaf of the tree laid over an area: a pane outside a stack, or a
/// stack, named by its first pane.
#[derive(Debug, Clone, Copy)]
struct Leaf {
    key: PaneId,
    rect: Rect,
    stack: bool,
    /// The focused pane is this pane or in this stack.
    focused: bool,
}

impl Leaf {
    /// Whether the leaf keeps [`MIN_PANE_COLS`] × [`MIN_PANE_ROWS`] (a stack
    /// twice the rows) and [`RESIZE_PERCENT`] of `body` each way.
    fn roomy(&self, body: Rect) -> bool {
        let rows = if self.stack {
            2 * MIN_PANE_ROWS
        } else {
            MIN_PANE_ROWS
        };
        let cols = MIN_PANE_COLS.max(cells(body.width, RESIZE_PERCENT));
        let rows = rows.max(cells(body.height, RESIZE_PERCENT));
        self.rect.width >= cols && self.rect.height >= rows
    }
}

/// `node`'s leaves laid over `area`, in tree order.
fn leaves_of(node: &Node, area: Rect, focus: PaneId) -> Vec<Leaf> {
    fn walk(node: &Node, area: Rect, focus: PaneId, out: &mut Vec<Leaf>) {
        match node {
            Node::Pane(id) => out.push(Leaf {
                key: *id,
                rect: area,
                stack: false,
                focused: *id == focus,
            }),
            Node::Stack { panes, .. } => out.extend(panes.first().map(|&key| Leaf {
                key,
                rect: area,
                stack: true,
                focused: panes.contains(&focus),
            })),
            Node::Split {
                split,
                ratio,
                first,
                second,
            } => {
                let (a, b) = split_rect(area, *split, *ratio);
                walk(first, a, focus, out);
                walk(second, b, focus, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(node, area, focus, &mut out);
    out
}

/// Sets every split's ratio so each leaf lands on its rect in `leaves`.
/// Returns the area `node` covers.
fn fit(node: &mut Node, leaves: &[Leaf]) -> Option<Rect> {
    let rect_of = |key: PaneId| {
        leaves
            .iter()
            .find(|leaf| leaf.key == key)
            .map(|leaf| leaf.rect)
    };
    match node {
        Node::Pane(id) => rect_of(*id),
        Node::Stack { panes, .. } => rect_of(*panes.first()?),
        Node::Split {
            split,
            ratio,
            first,
            second,
        } => {
            let a = fit(first, leaves)?;
            let b = fit(second, leaves)?;
            let (first_len, second_len) = (along(a, *split).1, along(b, *split).1);
            *ratio = f32::from(first_len) / f32::from(first_len + second_len).max(1.0);
            Some(a.union(b))
        }
    }
}

/// The split kind whose border a move towards `dir` crosses.
fn axis(dir: NavDirection) -> Split {
    match dir {
        NavDirection::Left | NavDirection::Right => Split::Right,
        NavDirection::Up | NavDirection::Down => Split::Down,
    }
}

/// `rect`'s start and length in the direction a `split` split divides.
fn along(rect: Rect, split: Split) -> (u16, u16) {
    match split {
        Split::Right => (rect.x, rect.width),
        Split::Down => (rect.y, rect.height),
    }
}

/// `rect`'s start and length across the direction a `split` split divides.
fn across(rect: Rect, split: Split) -> (u16, u16) {
    match split {
        Split::Right => (rect.y, rect.height),
        Split::Down => (rect.x, rect.width),
    }
}

/// The border a unit's edge sits on: the nearest split of kind `split`
/// with the unit on one side, the area it's laid over, and where its
/// border runs.
struct Edge {
    region: Rect,
    split: Split,
    border: u16,
}

/// The border of the focused unit's edge facing `dir`; `None` at the tab's
/// edge.
fn edge(root: &Node, body: Rect, focus: PaneId, dir: NavDirection) -> Option<Edge> {
    let split = axis(dir);
    let unit_first = matches!(dir, NavDirection::Down | NavDirection::Right);
    let (mut node, mut area, mut found) = (root, body, None);
    while let Node::Split {
        split: kind,
        ratio,
        first,
        second,
    } = node
    {
        let (a, b) = split_rect(area, *kind, *ratio);
        let in_first = contains(first, focus);
        if *kind == split && in_first == unit_first {
            found = Some(Edge {
                region: area,
                split,
                border: along(b, split).0,
            });
        }
        (node, area) = if in_first { (first, a) } else { (second, b) };
    }
    found
}

/// Whether pane `target` is in `node`.
fn contains(node: &Node, target: PaneId) -> bool {
    match node {
        Node::Split { first, second, .. } => contains(first, target) || contains(second, target),
        Node::Pane(_) | Node::Stack { .. } => holds(node, target),
    }
}

/// `leaves` with `edge`'s border moved to `to`: each leaf in its region
/// that starts on the border starts at `to`, each that ends on it ends
/// there. `None` when a leaf would have no cells left.
fn shifted(leaves: &[Leaf], edge: &Edge, to: u16) -> Option<Vec<Leaf>> {
    leaves
        .iter()
        .map(|leaf| {
            let inside = edge.region.intersection(leaf.rect) == leaf.rect;
            let (start, len) = along(leaf.rect, edge.split);
            let (start, len) = match () {
                () if inside && start == edge.border => (to, (start + len).checked_sub(to)?),
                () if inside && start + len == edge.border => (start, to.checked_sub(start)?),
                () => (start, len),
            };
            let (side, width) = across(leaf.rect, edge.split);
            let rect = match edge.split {
                Split::Right => Rect::new(start, side, len, width),
                Split::Down => Rect::new(side, start, width, len),
            };
            (len > 0).then_some(Leaf { rect, ..*leaf })
        })
        .collect()
}

/// `node` with the split at `edge` rebuilt so that the unit beside the
/// border (on the first side when `unit_first`) leaves its side and joins
/// the leaf or run of leaves across the border in one stack showing
/// `focus`. `stacked` gets the keys of every leaf merged.
fn stack_at(
    node: Node,
    area: Rect,
    edge: &Edge,
    unit_first: bool,
    focus: PaneId,
    stacked: &mut Vec<PaneId>,
) -> Node {
    let Node::Split {
        split,
        ratio,
        first,
        second,
    } = node
    else {
        return node;
    };
    if area != edge.region || split != edge.split {
        let (a, b) = split_rect(area, split, ratio);
        let (first, second) = if contains(&first, focus) {
            (
                Box::new(stack_at(*first, a, edge, unit_first, focus, stacked)),
                second,
            )
        } else {
            (
                first,
                Box::new(stack_at(*second, b, edge, unit_first, focus, stacked)),
            )
        };
        return Node::Split {
            split,
            ratio,
            first,
            second,
        };
    }
    let (unit_side, other) = if unit_first {
        (*first, *second)
    } else {
        (*second, *first)
    };
    let mut unit_ids = Vec::new();
    let rest = drop_touching(unit_side, split, !unit_first, &mut unit_ids);
    let mut merged = Vec::new();
    let other = replace_touching(other, split, unit_first, &mut |across| {
        let mut ids = Vec::new();
        collect_ids(&across, &mut ids);
        merged = across_keys(&across);
        let panes = if unit_first {
            unit_ids.iter().chain(&ids).copied().collect()
        } else {
            ids.iter().chain(&unit_ids).copied().collect()
        };
        Node::Stack {
            panes,
            expanded: focus,
        }
    });
    stacked.extend(merged);
    stacked.extend(unit_ids.first().copied());
    match rest {
        None => other,
        Some(rest) if unit_first => split_pair(split, other, rest, false),
        Some(rest) => split_pair(split, other, rest, true),
    }
}

/// The split of `a` and `b`, `a` first when `a_first`; its ratio is set by
/// [`fit`].
fn split_pair(split: Split, a: Node, b: Node, a_first: bool) -> Node {
    let (first, second) = if a_first { (a, b) } else { (b, a) };
    Node::Split {
        split,
        ratio: 0.5,
        first: Box::new(first),
        second: Box::new(second),
    }
}

/// The keys of `node`'s leaves.
fn across_keys(node: &Node) -> Vec<PaneId> {
    leaves_of(node, Rect::default(), PaneId(0))
        .into_iter()
        .map(|leaf| leaf.key)
        .collect()
}

/// `node` without its leaf on the border side (`first` when
/// `touch_first`) through `split` splits; `ids` gets that leaf's panes.
/// `None` when `node` is that leaf.
fn drop_touching(
    node: Node,
    split: Split,
    touch_first: bool,
    ids: &mut Vec<PaneId>,
) -> Option<Node> {
    match node {
        Node::Split {
            split: kind,
            ratio,
            first,
            second,
        } if kind == split => {
            let (touching, far) = if touch_first {
                (*first, *second)
            } else {
                (*second, *first)
            };
            Some(match drop_touching(touching, split, touch_first, ids) {
                None => far,
                Some(kept) => {
                    let (first, second) = if touch_first {
                        (kept, far)
                    } else {
                        (far, kept)
                    };
                    Node::Split {
                        split,
                        ratio,
                        first: Box::new(first),
                        second: Box::new(second),
                    }
                }
            })
        }
        leaf => {
            collect_ids(&leaf, ids);
            None
        }
    }
}

/// `node` with the subtree on the border side (`first` when `touch_first`)
/// through `split` splits replaced by `with` of it.
fn replace_touching(
    node: Node,
    split: Split,
    touch_first: bool,
    with: &mut dyn FnMut(Node) -> Node,
) -> Node {
    match node {
        Node::Split {
            split: kind,
            ratio,
            first,
            second,
        } if kind == split => {
            let (first, second) = if touch_first {
                (
                    Box::new(replace_touching(*first, split, touch_first, with)),
                    second,
                )
            } else {
                (
                    first,
                    Box::new(replace_touching(*second, split, touch_first, with)),
                )
            };
            Node::Split {
                split,
                ratio,
                first,
                second,
            }
        }
        other => with(other),
    }
}

fn split_node(first: Node, split: Split, new_id: PaneId, ratio: f32) -> Node {
    Node::Split {
        split,
        ratio,
        first: Box::new(first),
        second: Box::new(Node::Pane(new_id)),
    }
}

fn valid_split_ratio(ratio: f32) -> f32 {
    if ratio.is_finite() {
        ratio.clamp(0.1, 0.9)
    } else {
        0.5
    }
}

fn remove_pane(node: Node, target: PaneId) -> Option<Node> {
    match node {
        Node::Pane(id) if id == target => None,
        Node::Pane(_) => Some(node),
        Node::Split {
            split,
            ratio,
            first,
            second,
        } => match (remove_pane(*first, target), remove_pane(*second, target)) {
            (None, Some(s)) => Some(s),
            (Some(f), None) => Some(f),
            (Some(f), Some(s)) => Some(Node::Split {
                split,
                ratio,
                first: Box::new(f),
                second: Box::new(s),
            }),
            (None, None) => None,
        },
        Node::Stack {
            mut panes,
            expanded,
        } => {
            let Some(at) = panes.iter().position(|id| *id == target) else {
                return Some(Node::Stack { panes, expanded });
            };
            panes.remove(at);
            let expanded = if expanded == target {
                panes
                    .get(at)
                    .or_else(|| panes.get(at.checked_sub(1)?))
                    .copied()
                    .unwrap_or(expanded)
            } else {
                expanded
            };
            stack(panes, expanded)
        }
    }
}

fn split_rect(area: Rect, split: Split, ratio: f32) -> (Rect, Rect) {
    match split {
        Split::Right => {
            let first_w = (f32::from(area.width) * ratio).round() as u16;
            let second_w = area.width.saturating_sub(first_w);
            (
                Rect::new(area.x, area.y, first_w, area.height),
                Rect::new(area.x + first_w, area.y, second_w, area.height),
            )
        }
        Split::Down => {
            let first_h = (f32::from(area.height) * ratio).round() as u16;
            let second_h = area.height.saturating_sub(first_h);
            (
                Rect::new(area.x, area.y, area.width, first_h),
                Rect::new(area.x, area.y + first_h, area.width, second_h),
            )
        }
    }
}

#[cfg(test)]
mod tests;
