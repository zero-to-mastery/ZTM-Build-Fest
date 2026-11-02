//! The right-hand area while a session is shown: a one-row tab bar, then the
//! shown tab's panes laid out by its tree, each in a rounded frame titled
//! with its name. The frame shows where the focus is: blue while the pane
//! has the keys, grey while it has the focus and the keys are elsewhere,
//! dim otherwise. A zoomed tab shows only its focused pane. Each stack is a
//! centred list naming its panes, one row each between two dim bars and a
//! `>` outside the left bar on the shown one, above the shown pane. Floats
//! are drawn last, over the tiled panes and stack lists; a pinned float
//! stays drawn while the floats are hidden. While a float has the keys, the
//! tab bar names the floats' layout instead of the tab's. Each drawn pane's
//! images are recorded for the compositor, which places them on the outer
//! screen.

use std::collections::HashMap;
use std::ops::Range;

use orb_domain::AppState;
use orb_domain::feat::layout::floats::FloatLayout;
use orb_domain::feat::layout::state::{Placed, Placement, SessionLayout, StackList};
use orb_domain::feat::layout::tree::SwapLayout;
use orb_domain::ids::PaneId;
use orb_term::Pane;
use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Clear, Widget};

use crate::graphics::DrawnImages;
use crate::mouse::HitMap;
use crate::render::IMAGE_HOLE;
use crate::session_picker::cut_right;
use crate::sidebar::{BLACK, BLUE, COMMENT, DARK3, FG, FG_DARK, GUTTER, ORANGE, PIN};

/// The trailing chevron's text.
const PLUS: &str = " + ";
/// The swap layout keys' hint, before the layout's name.
const SWAP_KEYS: &str = " Alt <[]> ";
/// The powerline arrow each chevron starts and ends with.
const ARROW: &str = "\u{e0b0}";

/// `[tab bar, tab body]` of the right-hand area.
pub(crate) fn areas(right: Rect) -> [Rect; 2] {
    Layout::vertical([Constraint::Length(1), Constraint::Fill(1)]).areas(right)
}

/// Draws `layout` into `right`: the tab bar, then each placed pane that has
/// a client in `panes` inside its frame, each stack's list, then the shown
/// floats (or only the pinned ones while hidden) over them, each on a cleared
/// area, a pinned one with a pin at the right of its top border. Records each
/// pane's screen, and whether its program reads the mouse, and each drawn
/// float's frame in `hits`, and each drawn pane's images in `images`, ranked
/// by its place in the drawing order. Returns the focused pane's cursor
/// while `keys_in_pane`.
pub(crate) fn render(
    state: &AppState,
    layout: &SessionLayout,
    panes: &HashMap<PaneId, Pane>,
    keys_in_pane: bool,
    right: Rect,
    buf: &mut Buffer,
    hits: &mut HitMap,
    images: &mut Vec<DrawnImages>,
) -> Option<Position> {
    let [bar, body] = areas(right);
    tab_bar(state, layout, keys_in_pane, bar, buf, hits);
    let placement = placement(state, layout, body);
    let mut cursor = None;
    let ranked = || placement.panes.iter().enumerate();
    for (rank, place) in ranked().filter(|(_, place)| !place.floating) {
        cursor = draw_pane(state, place, rank, panes, keys_in_pane, buf, hits, images).or(cursor);
    }
    for stack in &placement.stacks {
        let lit = keys_in_pane
            && placement
                .panes
                .iter()
                .any(|place| place.pane == stack.shown && place.focused);
        let left = placement
            .panes
            .iter()
            .find(|place| place.pane == stack.shown)
            .map_or(stack.area.x, |place| place.area.x);
        stack_list(state, stack, left, lit, buf, hits);
        hits.record_stack(stack.area, stack.panes.clone(), stack.shown);
    }
    for (rank, place) in ranked().filter(|(_, place)| place.floating) {
        Clear.render(place.area, buf);
        hits.record_float(place.area, place.pane);
        cursor = draw_pane(state, place, rank, panes, keys_in_pane, buf, hits, images).or(cursor);
    }
    cursor
}

/// Draws one placed pane's client (when `panes` has one) inside its frame,
/// records its screen in `hits` and its images, at `rank`, in `images`, and
/// marks the cells over its visible images that have no background of their
/// own as holes the images show through. Returns its cursor while it has the
/// keys.
fn draw_pane(
    state: &AppState,
    place: &Placed,
    rank: usize,
    panes: &HashMap<PaneId, Pane>,
    keys_in_pane: bool,
    buf: &mut Buffer,
    hits: &mut HitMap,
    images: &mut Vec<DrawnImages>,
) -> Option<Position> {
    let lit = place.focused && keys_in_pane;
    let content = place.content();
    let reads_mouse = panes.get(&place.pane).is_some_and(Pane::reads_mouse);
    hits.record_pane(content, place.pane, reads_mouse);
    let drawn = panes
        .get(&place.pane)
        .filter(|_| !content.is_empty())
        .and_then(|pane| {
            let (cursor, frame) = pane.render_with_graphics(content, buf);
            for position in frame.holes.iter().copied().flat_map(Rect::positions) {
                if let Some(cell) = buf.cell_mut(position)
                    && cell.bg == Color::Reset
                {
                    cell.bg = IMAGE_HOLE;
                }
            }
            images.push((pane.graphics_instance(), rank, frame));
            cursor
        });
    let (border, title) = match (lit, place.focused) {
        (true, _) => (BLUE, Style::new().fg(BLUE).add_modifier(Modifier::BOLD)),
        (false, true) => (COMMENT, Style::new().fg(FG_DARK)),
        (false, false) => (GUTTER, Style::new().fg(DARK3)),
    };
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(border))
        .title(Line::styled(
            format!(" {} ", pane_title(state, place.pane)),
            title,
        ));
    let block = if place.pinned {
        block.title_top(Line::styled(format!(" {PIN} "), title).right_aligned())
    } else {
        block
    };
    block.render(place.area, buf);
    drawn.filter(|_| lit)
}

/// Where `layout`'s shown tab draws its panes in `body`, each stack's list as
/// wide as its longest pane title plus its bars and `> `. Every caller
/// places panes through here so drawing, resizing and spawning agree.
pub(crate) fn placement(state: &AppState, layout: &SessionLayout, body: Rect) -> Placement {
    layout.placed(body, |panes| {
        panes
            .iter()
            .map(|pane| Span::raw(pane_title(state, *pane)).width())
            .max()
            .map_or(0, |longest| u16::try_from(longest + 4).unwrap_or(u16::MAX))
    })
}

/// Draws `stack`'s list: a dim bar down each side, and between them a row
/// per pane that fits, the shown pane's bold blue while `lit`, with a `>`
/// two columns left of the left bar when that stays right of `left`, the
/// stack's left edge. Names too long for the row end in `…`. Records every
/// other row in `hits`, reading the mouse so a click focuses its pane
/// without starting a selection.
fn stack_list(
    state: &AppState,
    stack: &StackList,
    left: u16,
    lit: bool,
    buf: &mut Buffer,
    hits: &mut HitMap,
) {
    let bar = Style::new().fg(GUTTER);
    for y in stack.area.rows().map(|row| row.y) {
        buf.set_string(stack.area.x, y, "│", bar);
        buf.set_string(stack.area.right().saturating_sub(1), y, "│", bar);
    }
    for (pane, row) in &stack.rows {
        let style = match (*pane == stack.shown, lit) {
            (true, true) => Style::new().fg(BLUE).add_modifier(Modifier::BOLD),
            (true, false) => Style::new().fg(FG_DARK),
            (false, _) => Style::new().fg(DARK3),
        };
        let text = cut_right(
            &format!(" {}", pane_title(state, *pane)),
            usize::from(row.width),
        );
        buf.set_stringn(row.x, row.y, text, usize::from(row.width), style);
        match stack.area.x.checked_sub(2) {
            Some(x) if *pane == stack.shown && x >= left => {
                buf.set_string(x, row.y, ">", style);
            }
            _ => {}
        }
        if *pane != stack.shown {
            hits.record_pane(*row, *pane, true);
        }
    }
}

/// What orb calls pane `pane` in its frame and the stack list: its name,
/// else the title of the agent running in it, else `shell`.
pub(crate) fn pane_title(state: &AppState, pane: PaneId) -> String {
    state
        .layouts
        .entry(pane)
        .and_then(|entry| entry.name.clone())
        .or_else(|| {
            state
                .sessions
                .all_agents()
                .find(|agent| {
                    agent
                        .pane
                        .as_ref()
                        .is_some_and(|launch| launch.pane == pane)
                })
                .and_then(|agent| agent.title.clone())
        })
        .unwrap_or_else(|| "shell".to_owned())
}

/// The tab bar: the shown session's name, then a chevron per
/// tab with the shown one bold on blue, then a ` + ` chevron. Tabs that
/// don't fit are counted in `← +N` / `+N →` chips, keeping the shown tab.
/// Then, right-aligned, the `Alt <[]>` hint and the shown tab's swap layout
/// name, lit while the tab is untouched and dim once it's changed by hand; a
/// 1-pane tab has none, and it's dropped when the tabs leave no room for it.
/// While a float has the keys (`keys_in_pane`), the name is the floats'
/// layout instead, lit or dim the same way, whatever the tab's pane count.
/// Records the bar, each tab and chip with the tab it shows, and the `+` in
/// `hits`; while the floats are shown, a tab's click keeps the keys in the
/// top float.
fn tab_bar(
    state: &AppState,
    layout: &SessionLayout,
    keys_in_pane: bool,
    bar: Rect,
    buf: &mut Buffer,
    hits: &mut HitMap,
) {
    buf.set_style(bar, Style::new().bg(BLACK));
    let session = Span::styled(
        format!(" {} ", session_label(state)),
        Style::new().fg(FG).bg(BLACK).add_modifier(Modifier::BOLD),
    );
    let shown = Style::new().fg(BLACK).bg(BLUE).add_modifier(Modifier::BOLD);
    let rest = Style::new().fg(COMMENT).bg(GUTTER);
    let labels: Vec<String> = (0..layout.tabs().len())
        .map(|index| format!(" {} ", layout.tab_label(index)))
        .collect();
    let widths: Vec<u16> = labels.iter().map(|label| chevron_width(label)).collect();
    let room = bar
        .width
        .saturating_sub(span_width(&session))
        .saturating_sub(chevron_width(PLUS));
    let range = visible_tabs(&widths, layout.active(), room);
    hits.record_tab_bar(bar, layout.active(), labels.len());
    let mut x = bar.x.saturating_add(span_width(&session));
    // The bar's cells the next chevron of `text` takes.
    let mut next = |text: &str| {
        let width = chevron_width(text);
        let area = Rect::new(x, bar.y, width, 1).intersection(bar);
        x = x.saturating_add(width);
        area
    };
    let mut target = |area: Rect, index: usize| {
        if let Some(tab) = layout.tabs().get(index).filter(|_| !area.is_empty()) {
            hits.record_tab(
                area,
                index,
                layout.floats().focused().unwrap_or_else(|| tab.focused()),
            );
        }
    };
    let mut spans = vec![session];
    if range.start > 0 {
        let chip = left_chip(range.start);
        target(next(&chip), range.start - 1);
        chevron(&mut spans, chip, rest);
    }
    for (index, label) in labels.iter().enumerate().take(range.end).skip(range.start) {
        let style = if index == layout.active() {
            shown
        } else {
            rest
        };
        target(next(label), index);
        chevron(&mut spans, label.clone(), style);
    }
    if range.end < labels.len() {
        let chip = right_chip(labels.len() - range.end);
        target(next(&chip), range.end);
        chevron(&mut spans, chip, rest);
    }
    let plus = next(PLUS);
    if !plus.is_empty() {
        hits.record_new_tab(plus);
    }
    chevron(&mut spans, PLUS.to_owned(), rest);
    let indicator = if keys_in_pane && layout.float_focused() {
        let floats = layout.floats();
        Some((float_layout_name(floats.layout()), floats.hand_changed()))
    } else {
        layout
            .active_tab()
            .filter(|tab| tab.pane_count() > 1)
            .map(|tab| (swap_layout_name(tab.swap_layout()), tab.hand_changed()))
    };
    if let Some((name, hand_changed)) = indicator {
        let hint = Span::styled(
            SWAP_KEYS,
            Style::new()
                .fg(ORANGE)
                .bg(BLACK)
                .add_modifier(Modifier::BOLD),
        );
        let name = format!(" {name} ");
        let width = span_width(&hint).saturating_add(chevron_width(&name));
        let left = bar.right().saturating_sub(x);
        if left >= width {
            spans.push(Span::raw(" ".repeat(usize::from(left - width))));
            spans.push(hint);
            let style = if hand_changed { rest } else { shown };
            chevron(&mut spans, name, style);
        }
    }
    Line::from(spans).render(bar, buf);
}

/// What the tab bar calls the shown session: its name, else its branch,
/// else `session`.
fn session_label(state: &AppState) -> String {
    state
        .shown_session()
        .and_then(|id| state.sessions.session(id))
        .and_then(|session| session.name.clone().or_else(|| session.branch.clone()))
        .unwrap_or_else(|| "session".to_owned())
}

/// Pushes `text` on `style`'s background between two arrows onto `spans`.
fn chevron(spans: &mut Vec<Span<'static>>, text: String, style: Style) {
    let bg = style.bg.unwrap_or(BLACK);
    spans.push(Span::styled(ARROW, Style::new().fg(BLACK).bg(bg)));
    spans.push(Span::styled(text, style));
    spans.push(Span::styled(ARROW, Style::new().fg(bg).bg(BLACK)));
}

fn chevron_width(text: &str) -> u16 {
    span_width(&Span::raw(text)).saturating_add(2)
}

fn span_width(span: &Span) -> u16 {
    u16::try_from(span.width()).unwrap_or(u16::MAX)
}

/// Counts the `n` tabs hidden left of the bar.
fn left_chip(n: usize) -> String {
    format!(" ← +{n} ")
}

/// Counts the `n` tabs hidden right of the bar.
fn right_chip(n: usize) -> String {
    format!(" +{n} → ")
}

/// What the tab bar calls `layout`, in caps.
fn swap_layout_name(layout: SwapLayout) -> &'static str {
    match layout {
        SwapLayout::Base => "BASE",
        SwapLayout::Vertical => "VERTICAL",
        SwapLayout::Horizontal => "HORIZONTAL",
        SwapLayout::Stacked => "STACKED",
        SwapLayout::HalfStacked => "HALF-STACKED",
    }
}

/// What the tab bar calls the floats' `layout`, in caps.
fn float_layout_name(layout: FloatLayout) -> &'static str {
    match layout {
        FloatLayout::Staggered => "STAGGERED",
        FloatLayout::Enlarged => "ENLARGED",
        FloatLayout::Spread => "SPREAD",
    }
}

/// Which tabs fit in `room` columns, given each tab chevron's `widths`,
/// starting from the shown tab `active` and add neighbours,
/// alternating sides from the left, while they and the chips counting the
/// rest fit. The shown tab is always in, even when it alone overflows.
fn visible_tabs(widths: &[u16], active: usize, room: u16) -> Range<usize> {
    let chip = |hidden: usize, text: fn(usize) -> String| match hidden {
        0 => 0,
        n => u32::from(chevron_width(&text(n))),
    };
    let fits = |range: &Range<usize>| {
        let used: u32 = widths
            .get(range.clone())
            .map_or(0, |widths| widths.iter().copied().map(u32::from).sum());
        used + chip(range.start, left_chip) + chip(widths.len() - range.end, right_chip)
            <= u32::from(room)
    };
    let grow = |range: &Range<usize>, left: bool| {
        if left {
            range.start.checked_sub(1).map(|start| start..range.end)
        } else {
            (range.end < widths.len()).then(|| range.start..range.end + 1)
        }
    };
    let mut range = active.min(widths.len())..(active + 1).min(widths.len());
    let mut left = true;
    while let Some((grown, side)) = [left, !left]
        .into_iter()
        .find_map(|side| grow(&range, side).filter(fits).map(|grown| (grown, side)))
    {
        range = grown;
        left = !side;
    }
    range
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use orb_domain::AppState;
    use orb_domain::feat::layout::state::{Layouts, PaneEntry, SessionLayout};
    use orb_domain::feat::layout::tree::Split;
    use orb_domain::feat::zmx::zmx_service::ZmxSession;
    use orb_domain::ids::{PaneId, SessionId};
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;

    use super::{areas, render, visible_tabs};
    use crate::mouse::HitMap;
    use crate::sidebar::PIN;

    fn entry(id: i64) -> PaneEntry {
        PaneEntry {
            id: PaneId(id),
            zmx: ZmxSession {
                name: format!("orb-p{id}"),
                dir: "/tmp/zmx".into(),
            },
            cwd: "/tmp".into(),
            name: None,
            resume: None,
        }
    }

    #[rstest::rstest]
    fn float_hides_the_tiled_frames_beneath_it() {
        // Given panes 7 and 8 side by side (frames meeting at column 40) and
        // a float over the middle of the body.
        let right = Rect::new(0, 0, 80, 25);
        let layouts = {
            let mut layouts = Layouts::default();
            layouts.insert(SessionId(1), SessionLayout::of(entry(7)));
            layouts.fit_to(areas(right)[1]);
            layouts.split(SessionId(1), Split::Right, entry(8));
            layouts.add_float(SessionId(1), entry(20));
            layouts
        };

        // When rendering the tab area.
        let buf = layouts.get(SessionId(1)).map(|layout| {
            let mut buf = Buffer::empty(right);
            render(
                &AppState::default(),
                layout,
                &HashMap::new(),
                true,
                right,
                &mut buf,
                &mut HitMap::default(),
                &mut Vec::new(),
            );
            buf
        });

        // Then the tiled border column is blank inside the float.
        assert_eq!(
            buf.as_ref()
                .and_then(|buf| buf.cell((40, 12)))
                .map(ratatui::buffer::Cell::symbol),
            Some(" "),
            "the float covers the tiled frames"
        );
    }

    #[rstest::rstest]
    fn pinned_float_shows_a_pin_in_its_top_border() {
        // Given panes 7 and 8 side by side and a pinned float over the middle.
        let right = Rect::new(0, 0, 80, 25);
        let layouts = {
            let mut layouts = Layouts::default();
            layouts.insert(SessionId(1), SessionLayout::of(entry(7)));
            layouts.fit_to(areas(right)[1]);
            layouts.split(SessionId(1), Split::Right, entry(8));
            layouts.add_float(SessionId(1), entry(20));
            layouts.toggle_pin(SessionId(1));
            layouts
        };

        // When rendering the tab area.
        let buf = layouts.get(SessionId(1)).map(|layout| {
            let mut buf = Buffer::empty(right);
            render(
                &AppState::default(),
                layout,
                &HashMap::new(),
                true,
                right,
                &mut buf,
                &mut HitMap::default(),
                &mut Vec::new(),
            );
            buf
        });

        // Then the float's top border row holds the pin.
        let row: String = buf.as_ref().map_or_else(String::new, |buf| {
            (0..right.width)
                .filter_map(|x| buf.cell((x, 7)))
                .map(ratatui::buffer::Cell::symbol)
                .collect()
        });
        assert!(row.contains(PIN), "a pinned float shows a pin: {row:?}");
    }

    #[rstest::rstest]
    fn all_tabs_that_fit_are_visible() {
        // Given three 10-column tabs and 30 columns of room.
        // When choosing the visible tabs with the middle one shown.
        let range = visible_tabs(&[10; 3], 1, 30);

        // Then every tab is visible.
        assert_eq!(range, 0..3, "three tabs fit in 30 columns");
    }

    #[rstest::rstest]
    fn shown_last_tab_keeps_its_left_neighbours() {
        // Given six 10-column tabs and 40 columns of room.
        // When choosing the visible tabs with the last one shown.
        let range = visible_tabs(&[10; 6], 5, 40);

        // Then the range runs to the last tab and hides some on the left.
        assert!(
            range.end == 6 && range.start > 0,
            "the last tab and its left neighbours, got {range:?}"
        );
    }

    #[rstest::rstest]
    fn shown_first_tab_keeps_its_right_neighbours() {
        // Given six 10-column tabs and 40 columns of room.
        // When choosing the visible tabs with the first one shown.
        let range = visible_tabs(&[10; 6], 0, 40);

        // Then the range starts at the first tab and hides some on the right.
        assert!(
            range.start == 0 && range.end < 6,
            "the first tab and its right neighbours, got {range:?}"
        );
    }

    #[rstest::rstest]
    fn shown_middle_tab_hides_tabs_on_both_sides() {
        // Given eight 10-column tabs and 40 columns of room.
        // When choosing the visible tabs with tab 3 shown.
        let range = visible_tabs(&[10; 8], 3, 40);

        // Then tab 3 is visible and tabs are hidden on both sides.
        assert!(
            range.contains(&3) && range.start > 0 && range.end < 8,
            "tab 3 with both ends hidden, got {range:?}"
        );
    }

    #[rstest::rstest]
    fn shown_tab_wider_than_the_room_is_still_visible() {
        // Given a 50-column first tab and 30 columns of room.
        // When choosing the visible tabs with it shown.
        let range = visible_tabs(&[50, 10, 10], 0, 30);

        // Then only the shown tab is visible.
        assert_eq!(range, 0..1, "the shown tab alone");
    }
}
