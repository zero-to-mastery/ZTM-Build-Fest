//! A session's floating panes, drawn over all of its tabs.
//!
//! Floats keep their places as shares of the tab body, so they grow and
//! shrink with the window. They follow one of three layouts: staggered (each
//! float in its own staggered spot: half the body, centred, moved two cells
//! down and right past any float already there), enlarged or spread. Adding,
//! closing or taking out a float lays them out again, in the next layout that
//! fits their count, unless they were changed by hand. The top float has the
//! focus while the floats are shown. A pinned float stays drawn while the
//! floats are hidden, but never has the focus then. Moving or resizing a
//! float marks the floats changed by hand.

use ratatui::layout::Rect;

use super::tree::{NavDirection, first_fitting};
use crate::ids::PaneId;

/// Smallest float width, in cells (capped at the body).
const MIN_WIDTH: u16 = 10;
/// Smallest float height, in cells (capped at the body).
const MIN_HEIGHT: u16 = 4;

/// Where the floats go, in the order `Alt [` / `Alt ]` cycle them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum FloatLayout {
    /// Each float in its own staggered spot.
    #[default]
    Staggered,
    /// Nine tenths of the body each, a row lower each; up to 10 floats.
    Enlarged,
    /// Side by side in halves and quarters; up to 4 floats.
    Spread,
}

impl FloatLayout {
    const ALL: [Self; 3] = [Self::Staggered, Self::Enlarged, Self::Spread];

    /// Whether the layout has a place for each of `n` floats.
    fn fits(self, n: usize) -> bool {
        match self {
            Self::Staggered => n >= 1,
            Self::Enlarged => (1..=10).contains(&n),
            Self::Spread => (1..=4).contains(&n),
        }
    }

    /// The first float layout that fits `n` floats, starting at this one (at
    /// the one after it when `step`), going backwards when `back`, wrapping;
    /// `None` when none fits.
    pub fn fitting(self, n: usize, step: bool, back: bool) -> Option<Self> {
        first_fitting(&Self::ALL, self as usize, step, back, |layout| {
            layout.fits(n)
        })
    }
}

/// A float's place as shares (0..=1) of the tab body.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FloatRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl FloatRect {
    /// `cells` as shares of `body`; the whole body when `body` is empty.
    pub fn from_cells(cells: Rect, body: Rect) -> Self {
        if body.is_empty() {
            Self {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            }
        } else {
            let (bw, bh) = (f32::from(body.width), f32::from(body.height));
            Self {
                x: f32::from(cells.x.saturating_sub(body.x)) / bw,
                y: f32::from(cells.y.saturating_sub(body.y)) / bh,
                width: f32::from(cells.width) / bw,
                height: f32::from(cells.height) / bh,
            }
        }
    }

    /// Back to cells in `body`: rounded, at least the smallest float size (or
    /// the body when smaller), at most the body, slid left and up to stay inside.
    pub fn to_cells(self, body: Rect) -> Rect {
        let (bw, bh) = (f32::from(body.width), f32::from(body.height));
        let width = ((self.width * bw).round().max(0.0) as u16)
            .clamp(MIN_WIDTH.min(body.width), body.width);
        let height = ((self.height * bh).round().max(0.0) as u16)
            .clamp(MIN_HEIGHT.min(body.height), body.height);
        let x = body
            .x
            .saturating_add((self.x * bw).round().max(0.0) as u16)
            .min(body.right() - width);
        let y = body
            .y
            .saturating_add((self.y * bh).round().max(0.0) as u16)
            .min(body.bottom() - height);
        Rect::new(x, y, width, height)
    }
}

/// One float: its pane, place, and whether it stays drawn while the floats are hidden.
#[derive(Debug, Clone, PartialEq)]
pub struct Float {
    pub pane: PaneId,
    pub rect: FloatRect,
    pub pinned: bool,
}

/// A session's floats, bottom first (the last is on top and has the focus),
/// and whether they are shown.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Floats {
    panes: Vec<Float>,
    shown: bool,
    /// Where the floats go when laid out.
    layout: FloatLayout,
    /// Moved or resized by hand since the floats were last laid out.
    hand_changed: bool,
}

impl Floats {
    /// Saved floats, bottom first, hidden, with their layout and whether they
    /// were changed by hand.
    pub fn restore(panes: Vec<Float>, layout: FloatLayout, hand_changed: bool) -> Self {
        Self {
            panes,
            shown: false,
            layout,
            hand_changed,
        }
    }

    /// The floats' layout.
    pub fn layout(&self) -> FloatLayout {
        self.layout
    }

    /// Whether a float was moved or resized by hand since the floats were last laid out.
    pub fn hand_changed(&self) -> bool {
        self.hand_changed
    }

    /// Every float, bottom first.
    pub fn all(&self) -> &[Float] {
        &self.panes
    }

    /// Whether the session has no floats.
    pub fn is_empty(&self) -> bool {
        self.panes.is_empty()
    }

    /// The top float while the floats are shown.
    pub fn focused(&self) -> Option<PaneId> {
        self.panes
            .last()
            .filter(|_| self.shown)
            .map(|float| float.pane)
    }

    /// Whether `pane` is one of the floats.
    pub fn holds(&self, pane: PaneId) -> bool {
        self.panes.iter().any(|float| float.pane == pane)
    }

    /// Every float's pane, shown or not, bottom first.
    pub fn pane_ids(&self) -> impl Iterator<Item = PaneId> + '_ {
        self.panes.iter().map(|float| float.pane)
    }

    /// Each drawn float's pane, frame in `body` and pin, bottom first: every
    /// float while shown, only the pinned ones while hidden.
    pub fn visible(&self, body: Rect) -> impl Iterator<Item = (PaneId, Rect, bool)> + '_ {
        self.panes
            .iter()
            .filter(|float| self.shown || float.pinned)
            .map(move |float| (float.pane, float.rect.to_cells(body), float.pinned))
    }

    /// Puts `pane` on top in the staggered spot for `body` and shows the
    /// floats; lays them out again unless they were changed by hand.
    pub fn add(&mut self, pane: PaneId, body: Rect) {
        self.insert(self.panes.len(), pane, body);
        self.shown = true;
    }

    /// Puts `pane` just under the top float, so the float with the keys keeps
    /// them, and leaves the floats shown or hidden as they were; lays them out
    /// again unless they were changed by hand.
    pub fn add_under_top(&mut self, pane: PaneId, body: Rect) {
        self.insert(self.panes.len().saturating_sub(1), pane, body);
    }

    /// Puts `pane` at `index`, bottom first, in the staggered spot for `body`
    /// and lays the floats out again unless they were changed by hand.
    fn insert(&mut self, index: usize, pane: PaneId, body: Rect) {
        let spot = {
            let taken: Vec<Rect> = self
                .panes
                .iter()
                .map(|float| float.rect.to_cells(body))
                .collect();
            staggered_spot(body, &taken)
        };
        self.panes.insert(
            index,
            Float {
                pane,
                rect: FloatRect::from_cells(spot, body),
                pinned: false,
            },
        );
        if !self.hand_changed {
            self.relayout(None, body);
        }
    }

    /// Shows or hides the floats; nothing with no floats. Whether it changed.
    pub fn toggle(&mut self) -> bool {
        if self.panes.is_empty() {
            return false;
        }
        self.shown = !self.shown;
        true
    }

    /// Takes `pane` out; hides the floats when none are left, else lays the
    /// rest out again in `body` unless they were changed by hand. Whether it
    /// was a float.
    pub fn remove(&mut self, pane: PaneId, body: Rect) -> bool {
        let Some(index) = self.panes.iter().position(|float| float.pane == pane) else {
            return false;
        };
        self.panes.remove(index);
        if self.panes.is_empty() {
            self.shown = false;
        } else {
            self.relayout_unless_hand_changed(body);
        }
        true
    }

    /// Takes the top float out and hides the floats, laying the rest out
    /// again in `body` unless they were changed by hand; none while hidden.
    pub fn take_focused(&mut self, body: Rect) -> Option<PaneId> {
        let pane = self.focused()?;
        self.panes.pop();
        self.shown = false;
        if !self.panes.is_empty() {
            self.relayout_unless_hand_changed(body);
        }
        Some(pane)
    }

    /// Lays the floats out in `body` again unless they were changed by hand.
    fn relayout_unless_hand_changed(&mut self, body: Rect) {
        if !self.hand_changed {
            self.relayout(None, body);
        }
    }

    /// Lays the floats out in the first layout that fits their count and
    /// clears the mark. `cycle` is `None` for an add, close or take-out (the
    /// search starts at the floats' own layout, forwards) and `Some(back)`
    /// for `Alt [` / `Alt ]`, which first steps one layout that way unless
    /// the floats were changed by hand.
    fn relayout(&mut self, cycle: Option<bool>, body: Rect) {
        let step = cycle.is_some() && !self.hand_changed;
        if let Some(layout) = self
            .layout
            .fitting(self.panes.len(), step, cycle == Some(true))
        {
            self.layout = layout;
            self.apply(body);
        }
        self.hand_changed = false;
    }

    /// `Alt ]` (or `Alt [` when `back`): the floats go to the next layout
    /// that fits their count in `body`, wrapping; floats changed by hand get
    /// their own layout back first. Whether there were floats.
    pub fn cycle(&mut self, back: bool, body: Rect) -> bool {
        if self.panes.is_empty() {
            return false;
        }
        self.relayout(Some(back), body);
        true
    }

    /// Puts each float, bottom first, in its place under the layout: its
    /// staggered spot among the floats below it, with the layout's values put
    /// in, kept inside `body` at least the smallest float size. Nothing when
    /// `body` is empty.
    fn apply(&mut self, body: Rect) {
        if body.is_empty() {
            return;
        }
        let (layout, n) = (self.layout, self.panes.len());
        let mut placed = Vec::with_capacity(n);
        for (i, float) in self.panes.iter_mut().enumerate() {
            let spot = staggered_spot(body, &placed);
            let raw = entry(layout, n, i).map_or(spot, |entry| entry.place(spot, body));
            let frame = FloatRect::from_cells(raw, body).to_cells(body);
            float.rect = FloatRect::from_cells(frame, body);
            placed.push(frame);
        }
    }

    /// Pins or unpins the top float; nothing while hidden. Whether it changed.
    pub fn toggle_pin(&mut self) -> bool {
        let shown = self.shown;
        match self.panes.last_mut().filter(|_| shown) {
            Some(float) => {
                float.pinned = !float.pinned;
                true
            }
            None => false,
        }
    }

    /// Moves `pane` to the top.
    pub fn raise(&mut self, pane: PaneId) {
        if let Some(index) = self.panes.iter().position(|float| float.pane == pane) {
            let float = self.panes.remove(index);
            self.panes.push(float);
        }
    }

    /// Whether `pane` is a float that is drawn: any float while shown, a pinned one while hidden.
    pub fn draws(&self, pane: PaneId) -> bool {
        self.panes
            .iter()
            .any(|float| float.pane == pane && (self.shown || float.pinned))
    }

    /// Puts `pane` on top and shows the floats. Whether `pane` is a float.
    pub fn focus(&mut self, pane: PaneId) -> bool {
        if !self.holds(pane) {
            return false;
        }
        self.raise(pane);
        self.shown = true;
        true
    }

    /// Hides the floats; pinned ones stay drawn.
    pub fn hide(&mut self) {
        self.shown = false;
    }

    /// A mouse drag: the top float's top-left corner to `x`, `y` (screen
    /// cells), kept inside `body`, while `pane` is the shown top float. A move
    /// marks the floats changed by hand. Whether it moved.
    pub fn move_top_to(&mut self, pane: PaneId, x: u16, y: u16, body: Rect) -> bool {
        if self.focused() != Some(pane) {
            return false;
        }
        self.edit_top(body, |frame| Rect {
            x: x.clamp(body.x, body.right().saturating_sub(frame.width).max(body.x)),
            y: y.clamp(
                body.y,
                body.bottom().saturating_sub(frame.height).max(body.y),
            ),
            ..frame
        })
    }

    /// Puts what `edit` makes of the top float's frame in `body` back as its
    /// place, while shown; a change marks the floats changed by hand. Whether it changed.
    fn edit_top<F>(&mut self, body: Rect, edit: F) -> bool
    where
        F: FnOnce(Rect) -> Rect,
    {
        if !self.shown || body.is_empty() {
            return false;
        }
        let Some(top) = self.panes.last_mut() else {
            return false;
        };
        let before = top.rect.to_cells(body);
        let after = edit(before);
        if after == before {
            return false;
        }
        top.rect = FloatRect::from_cells(after, body);
        self.hand_changed = true;
        true
    }

    /// `Alt +` (`grow`) or `Alt -`: every side of the top float one step out
    /// or in, stopping at the body and the smallest float size. Whether it changed.
    pub fn resize(&mut self, body: Rect, grow: bool) -> bool {
        use NavDirection::{Down, Left, Right, Up};
        self.edit_top(body, |frame| {
            [Left, Right, Up, Down]
                .into_iter()
                .fold(frame, |frame, dir| push_edge(frame, body, dir, grow))
        })
    }

    /// Resize mode: the top float's `dir` edge one step out (`grow`) or in. A
    /// grow at the body's edge pulls the opposite edge in instead; a shrink at
    /// the smallest float size changes nothing. Whether it changed.
    pub fn resize_side(&mut self, body: Rect, dir: NavDirection, grow: bool) -> bool {
        self.edit_top(body, |frame| {
            let pushed = push_edge(frame, body, dir, grow);
            if grow && pushed == frame {
                push_edge(frame, body, dir.opposite(), false)
            } else {
                pushed
            }
        })
    }

    /// Move mode: the top float one step `dir`, stopping at the body's edge. Whether it moved.
    pub fn shift(&mut self, body: Rect, dir: NavDirection) -> bool {
        self.edit_top(body, |frame| shift_frame(frame, body, dir))
    }

    /// Move mode's next (`forward`: the bottom float goes on top) or previous
    /// (the top float goes to the bottom), while shown with two or more
    /// floats. Not a change by hand. Whether the order changed.
    pub fn rotate(&mut self, forward: bool) -> bool {
        if !self.shown || self.panes.len() < 2 {
            return false;
        }
        if forward {
            self.panes.rotate_left(1);
        } else {
            self.panes.rotate_right(1);
        }
        true
    }

    /// The float `nav` of the top one in `body`: among floats whose top-left
    /// corner lies that way and whose rows (left/right) or columns (up/down)
    /// overlap the top float's, the nearest one.
    pub fn neighbour(&self, nav: NavDirection, body: Rect) -> Option<PaneId> {
        let (top, rest) = self.panes.split_last()?;
        let from = top.rect.to_cells(body);
        let rows = |r: Rect| r.y < from.bottom() && from.y < r.bottom();
        let cols = |r: Rect| r.x < from.right() && from.x < r.right();
        let candidates = rest
            .iter()
            .map(|float| (float.pane, float.rect.to_cells(body)));
        match nav {
            NavDirection::Left => candidates
                .filter(|(_, r)| r.x < from.x && rows(*r))
                .max_by_key(|(_, r)| (r.x, r.y)),
            NavDirection::Right => candidates
                .filter(|(_, r)| r.x > from.x && rows(*r))
                .min_by_key(|(_, r)| (r.x, r.y)),
            NavDirection::Up => candidates
                .filter(|(_, r)| r.y < from.y && cols(*r))
                .max_by_key(|(_, r)| (r.y, r.x)),
            NavDirection::Down => candidates
                .filter(|(_, r)| r.y > from.y && cols(*r))
                .min_by_key(|(_, r)| (r.y, r.x)),
        }
        .map(|(pane, _)| pane)
    }
}

/// One value of a float's place: a percent of the body (rounded down) or
/// whole cells from the body's edge.
#[derive(Clone, Copy)]
enum Size {
    Percent(u16),
    Cells(u16),
}

impl Size {
    /// The value in cells, along a body side `len` long.
    fn cells(self, len: u16) -> u16 {
        match self {
            Self::Percent(percent) => {
                u16::try_from(u32::from(len) * u32::from(percent) / 100).unwrap_or(len)
            }
            Self::Cells(cells) => cells,
        }
    }
}

/// One float's place in a layout; `None` keeps the staggered spot's value,
/// except that a missing `x` or `y` with a given width or height is centred.
#[derive(Clone, Copy)]
struct Entry {
    x: Option<Size>,
    y: Option<Size>,
    width: Option<Size>,
    height: Option<Size>,
}

impl Entry {
    /// `spot` with this entry's values put in, in cells of `body`.
    fn place(self, spot: Rect, body: Rect) -> Rect {
        let width = self.width.map_or(spot.width, |size| size.cells(body.width));
        let height = self
            .height
            .map_or(spot.height, |size| size.cells(body.height));
        let x = match (self.x, self.width) {
            (Some(x), _) => body.x.saturating_add(x.cells(body.width)),
            (None, Some(_)) => body.x.saturating_add(body.width.saturating_sub(width) / 2),
            (None, None) => spot.x,
        };
        let y = match (self.y, self.height) {
            (Some(y), _) => body.y.saturating_add(y.cells(body.height)),
            (None, Some(_)) => body
                .y
                .saturating_add(body.height.saturating_sub(height) / 2),
            (None, None) => spot.y,
        };
        Rect::new(x, y, width, height)
    }
}

/// The place of float `index` (bottom first) of `count` under `layout`; `None` for
/// staggered, which keeps each float's staggered spot.
fn entry(layout: FloatLayout, count: usize, index: usize) -> Option<Entry> {
    let p = |percent| Some(Size::Percent(percent));
    let c = |cells| Some(Size::Cells(cells));
    let e = |x, y, width, height| Entry {
        x,
        y,
        width,
        height,
    };
    match layout {
        FloatLayout::Staggered => None,
        FloatLayout::Enlarged => match u16::try_from(index) {
            Ok(row) if row < 9 => Some(e(p(5), c(row + 1), p(90), p(90))),
            _ => Some(e(c(10), c(10), p(90), p(90))),
        },
        FloatLayout::Spread => match (count, index) {
            (1, 0) => Some(e(p(50), p(50), None, None)),
            (2, 0) => Some(e(p(1), p(25), p(45), None)),
            (2, 1) => Some(e(p(50), p(25), p(45), None)),
            (3, 0) => Some(e(None, p(55), p(45), p(45))),
            (3, 1) => Some(e(p(1), p(1), p(45), None)),
            (3, 2) => Some(e(p(50), p(1), p(45), None)),
            (4, 0) => Some(e(p(1), p(55), p(45), p(45))),
            (4, 1) => Some(e(p(50), p(55), p(45), p(45))),
            (4, 2) => Some(e(p(1), p(1), p(45), p(45))),
            (4, 3) => Some(e(p(50), p(1), p(45), p(45))),
            _ => None,
        },
    }
}

/// Where a new float goes among the `taken` frames: half size and centred,
/// walking two cells down and right; then third size in each corner (top-left,
/// top-right, bottom-left, bottom-right) with the same walk. The first spot
/// inside `body`, at least the smallest float size and not identical to a
/// taken frame wins; the whole body when none does.
fn staggered_spot(body: Rect, taken: &[Rect]) -> Rect {
    let (left, top) = (i32::from(body.x), i32::from(body.y));
    let (right, bottom) = (i32::from(body.right()), i32::from(body.bottom()));
    let (w, h) = (i32::from(body.width), i32::from(body.height));
    let (half_w, half_h) = (w / 2, h / 2);
    let (third_w, third_h) = (w / 3, h / 3);
    // Each walk: top-left corner and size of the spot at offset `o`.
    let walks: [&dyn Fn(i32) -> (i32, i32, i32, i32); 5] = [
        &|o| {
            (
                left + (w + 2) / 4 + o,
                top + (h + 2) / 4 + o,
                half_w,
                half_h,
            )
        },
        &|o| (left + 2 + o, top + 2 + o, third_w, third_h),
        &|o| (right - third_w - 2 - o, top + 2 + o, third_w, third_h),
        &|o| (left + 2 + o, bottom - third_h - 2 - o, third_w, third_h),
        &|o| {
            (
                right - third_w - 2 - o,
                bottom - third_h - 2 - o,
                third_w,
                third_h,
            )
        },
    ];
    let inside = |(x, y, width, height): (i32, i32, i32, i32)| {
        let fits = width >= i32::from(MIN_WIDTH)
            && height >= i32::from(MIN_HEIGHT)
            && x >= left
            && y >= top
            && x + width <= right
            && y + height <= bottom;
        fits.then(|| Rect::new(x as u16, y as u16, width as u16, height as u16))
    };
    walks
        .iter()
        .find_map(|walk| {
            (0..)
                .step_by(2)
                .map_while(|o| inside(walk(o)))
                .find(|spot| !taken.contains(spot))
        })
        .unwrap_or(body)
}

/// One move or resize step, as a share of the body.
const STEP: f32 = 0.05;

/// One step across and down `body`, in whole cells, at least one each.
fn steps(body: Rect) -> (u16, u16) {
    let step = |len: u16| ((f32::from(len) * STEP).round() as u16).max(1);
    (step(body.width), step(body.height))
}

/// `frame` with its `dir` edge one step out (`out`, stopping at the body's
/// edge) or in (stopping at the smallest float size).
fn push_edge(frame: Rect, body: Rect, dir: NavDirection, out: bool) -> Rect {
    let (sx, sy) = steps(body);
    let (min_w, min_h) = (MIN_WIDTH.min(body.width), MIN_HEIGHT.min(body.height));
    let (mut left, mut top, mut right, mut bottom) =
        (frame.x, frame.y, frame.right(), frame.bottom());
    match (dir, out) {
        (NavDirection::Left, true) => left = left.saturating_sub(sx).max(body.x),
        (NavDirection::Left, false) => left = (left + sx).min(right - min_w),
        (NavDirection::Right, true) => right = (right + sx).min(body.right()),
        (NavDirection::Right, false) => right = right.saturating_sub(sx).max(left + min_w),
        (NavDirection::Up, true) => top = top.saturating_sub(sy).max(body.y),
        (NavDirection::Up, false) => top = (top + sy).min(bottom - min_h),
        (NavDirection::Down, true) => bottom = (bottom + sy).min(body.bottom()),
        (NavDirection::Down, false) => bottom = bottom.saturating_sub(sy).max(top + min_h),
    }
    Rect::new(left, top, right - left, bottom - top)
}

/// `frame` moved one step `dir`, stopping at the body's edge.
fn shift_frame(frame: Rect, body: Rect, dir: NavDirection) -> Rect {
    let (sx, sy) = steps(body);
    match dir {
        NavDirection::Left => Rect {
            x: frame.x.saturating_sub(sx).max(body.x),
            ..frame
        },
        NavDirection::Right => Rect {
            x: (frame.x + sx).min(body.right() - frame.width),
            ..frame
        },
        NavDirection::Up => Rect {
            y: frame.y.saturating_sub(sy).max(body.y),
            ..frame
        },
        NavDirection::Down => Rect {
            y: (frame.y + sy).min(body.bottom() - frame.height),
            ..frame
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: Rect = Rect::new(0, 0, 80, 24);

    #[rstest::rstest]
    fn fitting_from_enlarged_with_five_floats_skips_spread() {
        // Given the enlarged layout and five floats.
        let layout = FloatLayout::Enlarged;

        // When stepping to the next layout that fits.
        let next = layout.fitting(5, true, false);

        // Then spread (up to four floats) is skipped for staggered.
        assert_eq!(
            next,
            Some(FloatLayout::Staggered),
            "spread should not fit five floats"
        );
    }

    #[rstest::rstest]
    fn first_float_takes_the_centred_half_of_the_body() {
        // Given no floats.
        let mut floats = Floats::default();

        // When adding a float on an 80×24 body.
        floats.add(PaneId(1), BODY);

        // Then its frame is the centred half of the body.
        let frames: Vec<Rect> = floats.visible(BODY).map(|(_, r, _)| r).collect();
        assert_eq!(
            frames,
            vec![Rect::new(20, 6, 40, 12)],
            "first float should be centred at half size"
        );
    }

    #[rstest::rstest]
    fn second_float_sits_two_cells_down_and_right() {
        // Given one float in the centred spot.
        let mut floats = Floats::default();
        floats.add(PaneId(1), BODY);

        // When adding another float.
        floats.add(PaneId(2), BODY);

        // Then the new top frame is two cells down and right.
        let top = floats.visible(BODY).last().map(|(_, r, _)| r);
        assert_eq!(
            top,
            Some(Rect::new(22, 8, 40, 12)),
            "second float should be staggered by two cells"
        );
    }

    #[rstest::rstest]
    fn float_frame_doubles_when_the_body_doubles() {
        // Given a float added on an 80×24 body.
        let mut floats = Floats::default();
        floats.add(PaneId(1), BODY);

        // When placing it on a 160×48 body.
        let frame = floats
            .visible(Rect::new(0, 0, 160, 48))
            .next()
            .map(|(_, r, _)| r);

        // Then its frame doubles.
        assert_eq!(
            frame,
            Some(Rect::new(40, 12, 80, 24)),
            "float frame should scale with the body"
        );
    }

    #[rstest::rstest]
    fn float_on_a_tiny_body_fits_inside_it() {
        // Given a body smaller than the smallest float.
        let body = Rect::new(3, 2, 6, 3);
        let mut floats = Floats::default();

        // When adding a float.
        floats.add(PaneId(1), body);

        // Then its frame is the whole body.
        let frame = floats.visible(body).next().map(|(_, r, _)| r);
        assert_eq!(
            frame,
            Some(body),
            "float on a tiny body should be clamped to the body"
        );
    }

    #[rstest::rstest]
    fn neighbour_up_is_the_float_above_the_top_one() {
        // Given two staggered floats, 2 on top and two cells below 1.
        let mut floats = Floats::default();
        floats.add(PaneId(1), BODY);
        floats.add(PaneId(2), BODY);

        // When looking for the float above the top one.
        let above = floats.neighbour(NavDirection::Up, BODY);

        // Then it is float 1.
        assert_eq!(above, Some(PaneId(1)), "the float above should be found");
    }

    /// Every float's frame in the tests' body, bottom first.
    fn frames(floats: &Floats) -> Vec<Rect> {
        floats
            .all()
            .iter()
            .map(|float| float.rect.to_cells(BODY))
            .collect()
    }

    #[rstest::rstest]
    fn spread_puts_two_floats_side_by_side() {
        // Given spread floats.
        let mut floats = Floats::restore(Vec::new(), FloatLayout::Spread, false);

        // When adding two floats on an 80×24 body.
        floats.add(PaneId(1), BODY);
        floats.add(PaneId(2), BODY);

        // Then they sit side by side, each 45% wide.
        assert_eq!(
            frames(&floats),
            vec![Rect::new(0, 6, 36, 12), Rect::new(40, 6, 36, 12)],
            "two spread floats share the body's width"
        );
    }

    #[rstest::rstest]
    fn enlarged_puts_each_float_a_row_lower() {
        // Given enlarged floats.
        let mut floats = Floats::restore(Vec::new(), FloatLayout::Enlarged, false);

        // When adding three floats on an 80×24 body.
        for pane in 1..=3 {
            floats.add(PaneId(pane), BODY);
        }

        // Then each takes nine tenths of the body, a row lower than the one below it.
        assert_eq!(
            frames(&floats),
            vec![
                Rect::new(4, 1, 72, 21),
                Rect::new(4, 2, 72, 21),
                Rect::new(4, 3, 72, 21),
            ],
            "enlarged floats step down a row each"
        );
    }

    /// One staggered float on the tests' body, moved a step right by hand.
    fn moved_float() -> Floats {
        let mut floats = Floats::default();
        floats.add(PaneId(1), BODY);
        floats.shift(BODY, NavDirection::Right);
        floats
    }

    #[rstest::rstest]
    fn cycling_marked_floats_keeps_their_layout() {
        // Given a staggered float moved by hand.
        let mut floats = moved_float();

        // When cycling to the next layout.
        floats.cycle(false, BODY);

        // Then it stays staggered, back in its staggered spot.
        assert_eq!(
            (floats.layout(), frames(&floats)),
            (FloatLayout::Staggered, vec![Rect::new(20, 6, 40, 12)]),
            "the first cycle on moved floats re-applies their own layout"
        );
    }

    #[rstest::rstest]
    fn cycling_clears_the_floats_mark() {
        // Given a staggered float moved by hand.
        let mut floats = moved_float();

        // When cycling to the next layout.
        floats.cycle(false, BODY);

        // Then the floats are no longer marked changed by hand.
        assert!(
            !floats.hand_changed(),
            "cycling should clear the changed-by-hand mark"
        );
    }

    #[rstest::rstest]
    fn move_top_to_stops_at_the_body_edge() {
        // Given one staggered float on an 80×24 body.
        let mut floats = Floats::default();
        floats.add(PaneId(1), BODY);

        // When dragging it to (200, 200).
        floats.move_top_to(PaneId(1), 200, 200, BODY);

        // Then its frame ends at the body's right and bottom.
        let corner = frames(&floats)
            .first()
            .map(|frame| (frame.right(), frame.bottom()));
        assert_eq!(
            corner,
            Some((BODY.right(), BODY.bottom())),
            "a dragged float stays inside the body"
        );
    }

    #[rstest::rstest]
    fn move_top_to_marks_the_floats_changed_by_hand() {
        // Given one staggered float.
        let mut floats = Floats::default();
        floats.add(PaneId(1), BODY);

        // When dragging it to (0, 0).
        floats.move_top_to(PaneId(1), 0, 0, BODY);

        // Then the floats are marked changed by hand.
        assert!(
            floats.hand_changed(),
            "a drag that moves a float marks it changed by hand"
        );
    }

    #[rstest::rstest]
    #[case(true, true)]
    #[case(false, false)]
    fn draws_a_pinned_float_while_hidden(#[case] pinned: bool, #[case] expected: bool) {
        // Given one float, pinned or not, hidden.
        let mut floats = Floats::default();
        floats.add(PaneId(1), BODY);
        if pinned {
            floats.toggle_pin();
        }
        floats.toggle();

        // When asking whether it is drawn.
        let drawn = floats.draws(PaneId(1));

        // Then only a pinned float is drawn.
        assert_eq!(drawn, expected, "hidden floats draw only when pinned");
    }
}
