//! Draws a frame: the sidebar on the left, the shown session's tabs or the
//! start screen on the right, the mode line at the bottom, and the which-key
//! popup on top while a key sequence is pending. The message box is drawn
//! over everything but the mode line.
//! While the sidebar is hidden, the right side takes the full width.
//! An open picker is drawn over everything but the mode line, without the
//! popup (the session and worktree pickers in their own snacks layout), and
//! so is the rename box while it has the keys. A confirm opened over a
//! picker draws on top of it, and only the confirm takes clicks.
//! The terminal's cursor is shown only where the keys are: on the sidebar's
//! selected row, at the text cursor of the picker (unless the picker is in
//! list mode), the rename box or the sidebar search, or in the focused pane.
//! Each frame records where it drew the sidebar's rows and input box, the
//! shown panes, the pickers' rows and the rename box, so a click maps back
//! to them.
//! Whatever is left on the terminal's default background gets orb's navy (or
//! the colour start-up chose in its place), so a transparent terminal doesn't
//! show through, except the cells over a pane's visible image, which keep the
//! terminal's default background so the image shows.

use std::collections::HashMap;
use std::time::SystemTime;

use jiff::tz::TimeZone;
use orb_domain::feat::picker::state::{PickerKind, PickerState};
use orb_domain::feat::sidebar::state::{SidebarLayout, SidebarView};
use orb_domain::ids::PaneId;
use orb_domain::{AppState, Focus};
use orb_term::Pane;
use ratatui::Frame;
use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::Color;

use crate::dashboard;
use crate::graphics::DrawnImages;
use crate::keymap::Keys;
use crate::mode_line;
use crate::mouse::HitMap;
use crate::picker::{self, PickerScroll};
use crate::rename;
use crate::search_picker;
use crate::session_picker;
use crate::sidebar::{self, SidebarScroll};
use crate::tabs;
use crate::toast::{self, Toast};
use crate::which_key;
use crate::worktree_picker;

/// Behind everything that doesn't set its own background (tokyonight-moon's
/// `bg`).
pub(crate) const BACKGROUND: Color = Color::Rgb(0x22, 0x24, 0x36);

/// Marks the cells over a pane's visible image until the final pass gives
/// them the terminal's default background.
// ponytail: one reserved RGB marks image holes; a child painting exactly this colour gets the default background there.
pub(crate) const IMAGE_HOLE: Color = Color::Rgb(0x01, 0x02, 0x03);

/// Splits the screen into `[sidebar, right side, mode line]`, the sidebar
/// `sidebar.width` columns wide, or none while it's hidden.
pub(crate) fn layout(area: Rect, sidebar: &SidebarView) -> [Rect; 3] {
    let [body, mode_line] =
        Layout::vertical([Constraint::Fill(1), Constraint::Length(1)]).areas(area);
    let width = if sidebar.hidden { 0 } else { sidebar.width };
    let [sidebar, right] =
        Layout::horizontal([Constraint::Length(width), Constraint::Fill(1)]).areas(body);
    [sidebar, right, mode_line]
}

/// Draws the whole frame. The right side shows the shown layout's tabs with
/// each of its panes that has a client in `panes`; the focused pane's cursor
/// shows only while the keys are in it. Without a shown layout, the right
/// side shows the start screen, with `pane_error` saying why the session
/// couldn't start. While the sidebar has the keys, the cursor sits on the
/// first cell of its selected row. `toast` shows in the message box, and the
/// mode line's clock shows `now` in `tz`. Cells nothing coloured get
/// `background`. Each drawn pane's images go into
/// `images`. Returns the sidebar's layout unless it's hidden, how
/// many rows the picker fits when it's open, and where the cursor shows, if anywhere.
#[expect(
    clippy::too_many_arguments,
    reason = "the frame's inputs, the two frontend view states it updates, the hit map it fills, and the frame's pane images"
)]
pub(crate) fn render(
    frame: &mut Frame,
    state: &AppState,
    panes: &HashMap<PaneId, Pane>,
    pane_error: Option<&str>,
    toast: Option<&Toast>,
    keys: &Keys,
    now: SystemTime,
    tz: &TimeZone,
    background: Color,
    scroll: &mut SidebarScroll,
    picker_scroll: &mut PickerScroll,
    hits: &mut HitMap,
    images: &mut Vec<DrawnImages>,
) -> (Option<SidebarLayout>, Option<usize>, Option<Position>) {
    let mut cursor = None;
    let [sidebar_area, right, mode_area] = layout(frame.area(), &state.sidebar);
    *hits = HitMap::new(sidebar_area, right);
    let (selected_y, sidebar_layout, search_cursor) = if state.sidebar.hidden {
        (None, None, None)
    } else {
        let (selected_y, sidebar_layout, search_cursor) = sidebar::render(
            &state.sessions,
            state.active_row(),
            &state.attached,
            &state.harnesses,
            &state.layouts,
            now,
            sidebar_area,
            frame.buffer_mut(),
            scroll,
            hits,
        );
        (selected_y, Some(sidebar_layout), search_cursor)
    };
    match state.shown_layout() {
        Some(layout) => {
            let keys_in_pane = state.focus == Focus::Pane;
            if let Some(pane_cursor) = tabs::render(
                state,
                layout,
                panes,
                keys_in_pane,
                right,
                frame.buffer_mut(),
                hits,
                images,
            ) {
                cursor = Some(pane_cursor);
            }
        }
        None => dashboard::render(state, pane_error, right, frame.buffer_mut()),
    }
    mode_line::render(state, now, tz, mode_area, frame.buffer_mut());
    let renaming = state
        .rename
        .as_ref()
        .filter(|_| state.focus == Focus::Rename);
    let picker_page = match (&state.picker, renaming) {
        (Some(picker), _) => {
            let (rows, picker_cursor) = render_open_picker(
                frame,
                picker,
                state,
                now,
                sidebar_area.union(right),
                picker_scroll,
                hits,
            );
            cursor = picker_cursor.or(cursor);
            Some(rows)
        }
        (None, Some(rename)) => {
            cursor = Some(rename::render(
                rename,
                sidebar_area.union(right),
                frame.buffer_mut(),
                hits,
            ));
            None
        }
        (None, None) => {
            let area = sidebar_area.union(right);
            match state.pane_mode() {
                Some(mode) => which_key::render_mode(mode, area, frame.buffer_mut()),
                None => which_key::render(keys, area, frame.buffer_mut()),
            }
            None
        }
    };
    match (state.focus, selected_y, search_cursor) {
        (Focus::Sidebar, Some(y), _) => cursor = Some(Position::new(sidebar_area.x, y)),
        (Focus::Search, _, Some(search)) => cursor = Some(search),
        _ => {}
    }
    if let Some(cursor) = cursor {
        frame.set_cursor_position(cursor);
    }
    if let Some(toast) = toast {
        toast::render(toast, right, frame.buffer_mut());
    }
    for cell in &mut frame.buffer_mut().content {
        cell.bg = match cell.bg {
            Color::Reset => background,
            IMAGE_HOLE => Color::Reset,
            other => other,
        };
    }
    (sidebar_layout, picker_page, cursor)
}

/// Draws the open `picker` into `area`, over the picker it was opened over
/// if any. Returns how many rows a page of its list holds, and its text
/// cursor unless the picker is in list mode.
fn render_open_picker(
    frame: &mut Frame,
    picker: &PickerState,
    state: &AppState,
    now: SystemTime,
    area: Rect,
    picker_scroll: &mut PickerScroll,
    hits: &mut HitMap,
) -> (usize, Option<Position>) {
    let buf = frame.buffer_mut();
    let (rows, cursor) = match picker.under() {
        Some(list) => {
            render_picker(
                list,
                state,
                now,
                area,
                buf,
                picker_scroll,
                &mut HitMap::default(),
            );
            render_picker(
                picker,
                state,
                now,
                area,
                buf,
                &mut PickerScroll::default(),
                hits,
            )
        }
        None => render_picker(picker, state, now, area, buf, picker_scroll, hits),
    };
    (rows, (!picker.listing()).then_some(cursor))
}

/// Draws `picker` over `area` with its own look, the session and worktree
/// pickers in their snacks layout and the rest in the select popup.
/// Returns how many rows fit and where the terminal cursor goes.
fn render_picker(
    picker: &PickerState,
    state: &AppState,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
    scroll: &mut PickerScroll,
    hits: &mut HitMap,
) -> (usize, Position) {
    match picker.kind() {
        PickerKind::Sessions { .. } => session_picker::render(
            picker,
            &state.sessions,
            &state.attached,
            &state.harnesses,
            now,
            area,
            buf,
            scroll,
            hits,
        ),
        PickerKind::Worktrees => {
            worktree_picker::render(picker, state, now, area, buf, scroll, hits)
        }
        PickerKind::Search { .. } => {
            search_picker::render(picker, state, now, area, buf, scroll, hits)
        }
        _ => picker::render(
            picker,
            &state.home,
            &state.sessions,
            &state.layouts,
            area,
            buf,
            scroll,
            hits,
        ),
    }
}

#[cfg(test)]
mod tests;
