//! The sidebar: one list of orb's sessions across projects, drawn
//! like LazyVim's file explorer (snacks.nvim) in tokyonight-moon.
//!
//! An input box heads it: `Sessions`, with an `i` badge lit while the
//! search has the keys, the filtered project after the `>` prompt, and how
//! many sessions are listed out of all of them. Below it, pinned sessions
//! come first, then active ones, each a two-line card: the most urgent
//! status of it and everything under it, its title, pin and time; then the
//! project's name, or a colony's world icon and name in the world's colour,
//! with one status icon per agent and `⌄`, or `›` while folded and its rows
//! hidden. Agent rows (status, name or title, harness mark) and the
//! colonists row hang off the card's second line, 4 columns a level with
//! `├╴`/`└╴` and `│` carried down past later siblings. The colonists row
//! packs one status dot per colonist, then their count and `⌄`/`›`; its
//! colonists hang under it the same way. A folded session shown only on the
//! way to a stuck colonist is one dim `›` line. The hovered row's first line
//! is highlighted, and the active row's (the one the right side shows) title
//! is blue and bold.
//! Settled sessions fold into a shelf at the bottom, drawn as one-line rows
//! while it's open. The sidebar scrolls to keep the whole selected row in
//! view, unless the wheel scrolled it while the keys are elsewhere.
//!
//! While the user searches, the typed text follows the prompt, and only
//! the sessions whose title or an agent's title matches it are
//! listed, settled ones included and folded cards open, with the matched
//! characters highlighted as in the pickers.

use std::borrow::Cow;
use std::collections::HashSet;
use std::time::{Duration, SystemTime};

use orb_domain::feat::harness::HarnessInfo;
use orb_domain::feat::layout::state::Layouts;
use orb_domain::feat::sessions::state::{
    Agent, AgentStatus, FolderKind, Project, ProjectKind, Session, SessionKind, Sessions,
    SidebarItem, SidebarRow, most_urgent,
};
use orb_domain::feat::sidebar::state::SidebarLayout;
use orb_domain::ids::SessionId;
use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Clear, Widget};
use unicode_segmentation::UnicodeSegmentation;

use crate::mouse::HitMap;
use crate::picker::{highlight, visible};

/// Whether `agent`'s session is among the `attached` ones.
pub(crate) fn is_attached(attached: &HashSet<SessionId>, agent: &Agent) -> bool {
    agent
        .session()
        .is_some_and(|session| attached.contains(&session))
}

/// A harness's mark in orange, else the model chip in blue.
pub(crate) fn mark(icon: Option<&str>) -> (&str, Color) {
    match icon {
        Some(icon) => (icon, LOGO),
        None => (CHIP, BLUE1),
    }
}

/// How far the sidebar is scrolled, kept between frames.
#[derive(Debug, Default)]
pub(crate) struct SidebarScroll {
    /// The list line drawn on the sidebar's top row.
    offset: u16,
    /// The selection the wheel scrolled the view on, while the view is
    /// free of it.
    #[expect(
        clippy::option_option,
        reason = "free on no selection differs from not free"
    )]
    free: Option<Option<SidebarItem>>,
    /// Whether the keys were in the sidebar at the last draw.
    keys_here: bool,
}

impl SidebarScroll {
    /// Scrolls the view `lines` down (up when negative) without following
    /// the selection, `cursor`, until it moves or the keys move into the
    /// sidebar.
    pub(crate) fn scroll_free(&mut self, lines: i16, cursor: Option<SidebarItem>) {
        self.offset = self.offset.saturating_add_signed(lines);
        self.free = Some(cursor);
    }

    /// Brings the view back to the selection on the next draw when the keys
    /// just moved into the sidebar (`in_sidebar` now, elsewhere last draw).
    pub(crate) fn follow_keys(&mut self, in_sidebar: bool) {
        if in_sidebar && !self.keys_here {
            self.free = None;
        }
        self.keys_here = in_sidebar;
    }

    /// Whether this draw leaves the view where the wheel put it: only while
    /// the selection is still `cursor`, the one it was scrolled on.
    fn stays_free(&mut self, cursor: Option<SidebarItem>) -> bool {
        let free = self.free == Some(cursor);
        if !free {
            self.free = None;
        }
        free
    }
}

/// Draws the sidebar into `area`, a blank column short of its right edge: the
/// input box, then the list, scrolled so the cursor's row is in view. Returns
/// the y of the selected row's first line when it's on screen, the list's
/// layout, and the search text's cursor while there is a search. An idle
/// agent of a session in `attached` shows a filled circle; an agent row reads
/// its pane's name from `layouts` and ends with its harness's mark from
/// `harnesses`. The active row's (`active`) title is blue and bold.
#[expect(
    clippy::too_many_arguments,
    reason = "the sidebar's inputs plus the scroll and hit map it updates"
)]
pub(crate) fn render(
    sessions: &Sessions,
    active: Option<SidebarItem>,
    attached: &HashSet<SessionId>,
    harnesses: &[HarnessInfo],
    layouts: &Layouts,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
    scroll: &mut SidebarScroll,
    hits: &mut HitMap,
) -> (Option<u16>, SidebarLayout, Option<Position>) {
    buf.set_style(area, Style::new().bg(BG_DARK).fg(FG));
    let area = Rect {
        width: area.width.saturating_sub(1),
        ..area
    };
    let [input, list] = Layout::vertical([Constraint::Length(3), Constraint::Fill(1)]).areas(area);
    hits.record_sidebar_input(input);
    let rows = sessions.sidebar(layouts);
    let search_cursor = render_input(sessions, &rows, input, buf, hits);
    let layout = SidebarLayout {
        rows: list.height,
        heights: rows.iter().map(height).collect(),
    };
    let selected_y = render_list(
        sessions, active, attached, harnesses, layouts, rows, now, list, buf, scroll, hits,
    );
    (selected_y, layout, search_cursor)
}

/// The rounded box at the top: its title and search badge, the prompt, and the
/// count against its right edge. Returns the search text's cursor while
/// there is a search. Records the search text's line in `hits` while there
/// is a search.
fn render_input(
    sessions: &Sessions,
    rows: &[SidebarRow<'_>],
    area: Rect,
    buf: &mut Buffer,
    hits: &mut HitMap,
) -> Option<Position> {
    let badge = if sessions.search.is_some() {
        Style::new().fg(BLUE).bg(GUTTER)
    } else {
        Style::new().fg(DARK3)
    };
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(ORANGE))
        .title(Line::from(vec![
            span(" Sessions ", ORANGE),
            Span::styled(" i ", badge),
            Span::raw(" "),
        ]));
    let inner = block.inner(area);
    block.render(area, buf);
    let count = Line::from(span(count(sessions, rows), COMMENT));
    let (prompt, cursor) = prompt(
        sessions,
        usize::from(inner.width).saturating_sub(usize::from(width(&count)) + 1),
        inner,
        hits,
    );
    render_split(prompt, count, inner, buf);
    cursor.map(|column| {
        Position::new(
            inner
                .x
                .saturating_add(column)
                .min(inner.right().saturating_sub(1)),
            inner.y,
        )
    })
}

/// `>`, followed by the filtered project's folder and name while there is
/// one, then the search text while there is a search, where snacks shows the
/// query. A search text too long for the `room` columns shows its end. Also
/// returns the column of the search text's cursor. Records the search text's
/// line `line` in `hits`.
fn prompt<'a>(
    sessions: &'a Sessions,
    room: usize,
    line: Rect,
    hits: &mut HitMap,
) -> (Line<'a>, Option<u16>) {
    let filtered = sessions
        .filter
        .and_then(|id| sessions.projects.iter().find(|project| project.id == id));
    let mut spans = match filtered {
        Some(project) => vec![
            span("> ", CYAN),
            span(format!("{FOLDER} "), project_colour(&project.title)),
            span(project.title.as_str(), FG),
        ],
        None => vec![span(">", CYAN)],
    };
    let Some(search) = &sessions.search else {
        return (Line::from(spans), None);
    };
    spans.push(Span::raw(" "));
    let prefix_width: usize = spans.iter().map(Span::width).sum();
    let room = room.saturating_sub(prefix_width + 1);
    let (shown, before) = visible(search.input.text(), search.input.cursor(), room);
    hits.record_text(
        line,
        prefix_width,
        search.input.text(),
        search.input.cursor(),
        room,
    );
    spans.push(span(shown, FG));
    (
        Line::from(spans),
        Some(u16::try_from(prefix_width + before).unwrap_or(u16::MAX)),
    )
}

/// `shown/total`, like snacks' match count: the sessions listed as cards
/// or settled rows, out of every session not being deleted. Path lines,
/// agent rows and colonists rows aren't counted.
fn count(sessions: &Sessions, rows: &[SidebarRow<'_>]) -> String {
    let shown = rows
        .iter()
        .filter(|row| {
            matches!(
                row,
                SidebarRow::Card { path: false, .. } | SidebarRow::Settled { .. }
            )
        })
        .count();
    let live = sessions
        .sessions
        .iter()
        .filter(|session| !sessions.deleting.contains(&session.id))
        .count();
    format!("{shown}/{live}")
}

/// Draws the rows into `area`, scrolled so the selected one is whole on
/// screen, with the shelf header held on the bottom row while its real line
/// is below the view, and records each row's visible lines in `hits`.
/// Returns the y of the selected row's first line when it's there.
#[expect(
    clippy::too_many_arguments,
    reason = "the list's inputs plus the scroll and hit map it updates"
)]
fn render_list(
    sessions: &Sessions,
    active: Option<SidebarItem>,
    attached: &HashSet<SessionId>,
    harnesses: &[HarnessInfo],
    layouts: &Layouts,
    rows: Vec<SidebarRow<'_>>,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
    scroll: &mut SidebarScroll,
    hits: &mut HitMap,
) -> Option<u16> {
    let (placed, total) = place(rows, area.height);
    let cursor = sessions.cursor_row(layouts);
    let selected = placed
        .iter()
        .find(|(row, _)| Some(row.item()) == cursor)
        .map(|(row, top)| (*top, height(row)));
    let free = scroll.stays_free(sessions.cursor);
    if let (false, Some((top, rows))) = (free, selected) {
        scroll.offset = scroll
            .offset
            .min(top)
            .max(top.saturating_add(rows).saturating_sub(area.height));
    }
    scroll.offset = scroll.offset.min(total.saturating_sub(area.height));
    // The shelf header while its real line is below the view: it then takes
    // the bottom row, which the selected row must stay clear of.
    let below = |offset: u16| {
        placed.iter().find_map(|(row, top)| match row {
            SidebarRow::ShelfHeader { count, open }
                if area.height >= 2 && *top >= offset.saturating_add(area.height) =>
            {
                Some((*count, *open))
            }
            _ => None,
        })
    };
    if let (false, Some(_), Some((top, rows))) = (free, below(scroll.offset), selected) {
        scroll.offset = scroll
            .offset
            .max(top.saturating_add(rows).saturating_sub(area.height - 1));
    }
    let sticky = below(scroll.offset);
    record_rows(&placed, scroll.offset, sticky.is_some(), area, hits);
    // The whole list, then the lines in view.
    let list = {
        let mut list = Buffer::empty(Rect::new(area.x, 0, area.width, total));
        list.set_style(list.area, Style::new().bg(BG_DARK).fg(FG));
        for (index, (row, top)) in placed.iter().enumerate() {
            let row_area = Rect::new(area.x, *top, area.width, height(row));
            if Some(row.item()) == cursor {
                list.set_style(
                    Rect {
                        height: 1,
                        ..row_area
                    },
                    Style::new().bg(VISUAL),
                );
            }
            let ends_shelf = !placed
                .get(index + 1)
                .is_some_and(|(row, _)| matches!(row, SidebarRow::Settled { .. }));
            let is_active = Some(row.item()) == active;
            render_row(
                sessions, attached, harnesses, layouts, row, ends_shelf, is_active, now, row_area,
                &mut list,
            );
        }
        list
    };
    for (y, line) in (area.top()..area.bottom()).zip(scroll.offset..total) {
        for x in area.left()..area.right() {
            if let (Some(cell), Some(shown)) = (list.cell((x, line)), buf.cell_mut((x, y))) {
                *shown = cell.clone();
            }
        }
    }
    if let Some((count, open)) = sticky {
        let row = Rect {
            y: area.bottom() - 1,
            height: 1,
            ..area
        };
        Clear.render(row, buf);
        buf.set_style(row, Style::new().bg(BG_DARK).fg(FG));
        render_shelf_header(count, open, row, buf);
    }
    selected
        .map(|(top, _)| top)
        .filter(|top| (scroll.offset..scroll.offset.saturating_add(area.height)).contains(top))
        .map(|top| area.y + top - scroll.offset)
}

/// Records in `hits` the lines of `area` each placed row shows from list
/// line `offset` down, and the bottom line as the shelf while the header is
/// `sticky` there. Blank gap lines map to nothing.
fn record_rows(
    placed: &[(SidebarRow<'_>, u16)],
    offset: u16,
    sticky: bool,
    area: Rect,
    hits: &mut HitMap,
) {
    let shown = area.height - u16::from(sticky);
    for (row, top) in placed {
        let start = (*top).max(offset);
        let end = top
            .saturating_add(height(row))
            .min(offset.saturating_add(shown));
        if start < end {
            hits.record_row(
                Rect::new(area.x, area.y + start - offset, area.width, end - start),
                row.item(),
            );
        }
    }
    if sticky {
        hits.record_row(
            Rect {
                y: area.bottom() - 1,
                height: 1,
                ..area
            },
            SidebarItem::SettledShelf,
        );
    }
}

/// Each row with its top line in the list, and the list's height. Blank lines
/// above the shelf header keep the shelf at the bottom of `lines` while the
/// list is short.
fn place(rows: Vec<SidebarRow<'_>>, lines: u16) -> (Vec<(SidebarRow<'_>, u16)>, u16) {
    let content = rows.iter().map(height).fold(0, u16::saturating_add);
    let gap = lines.saturating_sub(content);
    let mut top = 0_u16;
    let placed = rows
        .into_iter()
        .map(|row| {
            if matches!(row, SidebarRow::ShelfHeader { .. }) {
                top = top.saturating_add(gap);
            }
            let row_top = top;
            top = top.saturating_add(height(&row));
            (row, row_top)
        })
        .collect();
    (placed, top)
}

/// How many lines a row takes: a session's card 2, any other row (a path
/// line and a colonists row included) 1.
fn height(row: &SidebarRow<'_>) -> u16 {
    match row {
        SidebarRow::Card { path: false, .. } => 2,
        SidebarRow::Card { path: true, .. }
        | SidebarRow::ShelfHeader { .. }
        | SidebarRow::Settled { .. }
        | SidebarRow::Agent { .. }
        | SidebarRow::Colonists { .. } => 1,
    }
}

/// One row; `ends_shelf` says no settled session follows it, and `active`
/// lights a card's or agent row's title. Titles show where the search
/// matched them.
#[expect(
    clippy::too_many_arguments,
    reason = "the row plus the frame inputs every node takes"
)]
fn render_row(
    sessions: &Sessions,
    attached: &HashSet<SessionId>,
    harnesses: &[HarnessInfo],
    layouts: &Layouts,
    row: &SidebarRow<'_>,
    ends_shelf: bool,
    active: bool,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
) {
    match row {
        SidebarRow::Card {
            session,
            depth,
            rails,
            last,
            path: true,
            ..
        } => render_path(
            sessions,
            session,
            &deep_prefix(*depth, rails, *last),
            area,
            buf,
        ),
        SidebarRow::Card {
            project,
            session,
            depth,
            rails,
            last,
            path: false,
        } => render_card(
            sessions,
            project,
            session,
            attached,
            layouts,
            [
                deep_prefix(*depth, rails, *last),
                deep_l2_prefix(*depth, rails, *last),
            ],
            active,
            now,
            area,
            buf,
        ),
        SidebarRow::ShelfHeader { count, open } => render_shelf_header(*count, *open, area, buf),
        SidebarRow::Settled { session, .. } => {
            render_settled(sessions, session, ends_shelf, now, area, buf);
        }
        SidebarRow::Agent {
            session,
            agent,
            pane,
            depth,
            rails,
            last,
        } => {
            let label = layouts.agent_name(*pane, Some(agent));
            render_agent(
                sessions,
                harnesses,
                agent,
                label,
                &deep_prefix(*depth, rails, *last),
                attached.contains(&session.id),
                active,
                now,
                area,
                buf,
            );
        }
        SidebarRow::Colonists {
            session,
            depth,
            rails,
            last,
            open,
        } => render_colonists(
            sessions,
            session.id,
            attached,
            &deep_prefix(*depth, rails, *last),
            *open,
            now,
            area,
            buf,
        ),
    }
}

/// The guides before a tree row: each level 4 columns in, its connector
/// under the parent's second-line icon, so children hang off that line;
/// `rails` says which levels above carry `│` down, and `last` closes the
/// level with `└╴`.
fn deep_prefix(depth: usize, rails: &[bool], last: bool) -> String {
    if depth == 0 {
        return " ".to_owned();
    }
    let mut prefix = String::from("   ");
    for &rail in rails {
        prefix.push_str(if rail { "│   " } else { "    " });
    }
    prefix.push_str(if last { "└╴" } else { "├╴" });
    prefix
}

/// The guides before a card's second line, its `└╴` under the card's
/// status icon, carrying `│` down while more siblings follow.
fn deep_l2_prefix(depth: usize, rails: &[bool], last: bool) -> String {
    let mut prefix = String::from(" ");
    if depth > 0 {
        prefix.push_str("  ");
        for &rail in rails {
            prefix.push_str(if rail { "│   " } else { "    " });
        }
        prefix.push_str(if last { "  " } else { "│ " });
    }
    prefix.push_str("└╴");
    prefix
}

/// A folded session shown only on the way to a stuck colonist: one dim
/// line under `prefix`, `›` and its title, with where the search matched it.
fn render_path(sessions: &Sessions, session: &Session, prefix: &str, area: Rect, buf: &mut Buffer) {
    let title = sessions.title(session);
    let matched = sessions.title_matches(&title).unwrap_or_default();
    render_split(
        Line::from(
            [
                span(prefix.to_owned(), GUTTER),
                span(format!("{FOLD_CLOSED} "), DARK3),
            ]
            .into_iter()
            .chain(highlight(&title, &matched, |_| COMMENT))
            .collect::<Vec<_>>(),
        ),
        Line::default(),
        area,
        buf,
    );
}

/// A session's colonists row under `prefix`: the users icon and
/// `colonists`, then one packed status dot per direct colonist (its own
/// colonists included), at most [`AGENT_ICONS`] then `+N`, how many there
/// are, and `⌄` while `open` or `›` while folded.
#[expect(
    clippy::too_many_arguments,
    reason = "the row's parts plus the frame inputs every node takes"
)]
fn render_colonists(
    sessions: &Sessions,
    id: SessionId,
    attached: &HashSet<SessionId>,
    prefix: &str,
    open: bool,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
) {
    let colonists = sessions.colonists(id);
    let count = colonists.len();
    let rest = count.saturating_sub(AGENT_ICONS);
    let gap = if rest > 0 { "" } else { " " };
    let chevron = if open { FOLD_OPEN } else { FOLD_CLOSED };
    render_split(
        Line::from(vec![
            span(prefix.to_owned(), GUTTER),
            span(format!("{USERS} "), FG_DARK),
            span("colonists", FG_DARK),
        ]),
        Line::from(
            colonists
                .iter()
                .take(AGENT_ICONS)
                .map(|colonist| {
                    let (glyph, colour) = tree_status(sessions, colonist.id, attached, now);
                    span(glyph, colour)
                })
                .chain((rest > 0).then(|| span(format!("+{rest} "), COMMENT)))
                .chain([
                    span(format!("{gap}{count} "), COMMENT),
                    span(chevron, DARK3),
                ])
                .collect::<Vec<_>>(),
        ),
        area,
        buf,
    );
}

/// Session `id`'s status icon and colour: the most urgent agent of it and
/// everything under it ([`Sessions::status`]), else the idle circle, filled
/// while it's attached.
fn tree_status(
    sessions: &Sessions,
    id: SessionId,
    attached: &HashSet<SessionId>,
    now: SystemTime,
) -> (&'static str, Color) {
    match sessions.status(id) {
        Some(agent) => {
            let (glyph, _, colour) = status(agent, is_attached(attached, agent), now);
            (glyph, colour)
        }
        None if attached.contains(&id) => (ATTACHED_ICON, FG),
        None => (IDLE_ICON, DARK3),
    }
}

/// A session's two-line card under its `prefixes` (line 1, line 2). Line
/// 1: the most urgent status of it and everything under it (the idle
/// circle without one, filled while attached), its title, pin and time.
/// Line 2: the project's name, or a colony's world icon and name in the
/// world's colour, then one status icon per agent row (at most 8, then
/// `+N`) and, when the card lists its agent rows, `⌄` while they show or
/// `›` while folded. The title is blue and bold while the card is `active`.
#[expect(
    clippy::too_many_arguments,
    reason = "the card's parts plus the frame inputs every node takes"
)]
fn render_card(
    sessions: &Sessions,
    project: &Project,
    session: &Session,
    attached: &HashSet<SessionId>,
    layouts: &Layouts,
    prefixes: [String; 2],
    active: bool,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
) {
    let [first, second] = Layout::vertical([Constraint::Length(1); 2]).areas(area);
    let [prefix, l2_prefix] = prefixes;
    let (glyph, colour) = tree_status(sessions, session.id, attached, now);
    let pin = if session.pinned_at.is_some() { PIN } else { "" };
    let time = match most_urgent(sessions.agents(session.id)) {
        Some(agent) if agent.status == AgentStatus::Working => when(agent, now),
        _ => ago_label(since(now, session.last_activity_at)),
    };
    let title = sessions.title(session);
    let matched = sessions.title_matches(&title).unwrap_or_default();
    render_split(
        Line::from(
            [span(prefix, GUTTER), span(format!("{glyph} "), colour)]
                .into_iter()
                .chain(title_spans(&title, &matched, active))
                .collect::<Vec<_>>(),
        ),
        Line::from(vec![span(format!("{pin} "), ORANGE), span(time, COMMENT)]),
        first,
        buf,
    );
    let place = match (session.kind, world_look(project.kind)) {
        (SessionKind::Colony, Some((icon, colour))) => vec![
            span(l2_prefix, GUTTER),
            span(format!("{icon} "), colour),
            span(project.title.as_str(), colour),
        ],
        _ => vec![
            span(format!("{l2_prefix} "), GUTTER),
            span(project.title.as_str(), FG_DARK),
        ],
    };
    let rows = sessions.agent_rows(session.id, layouts);
    let own_attached = attached.contains(&session.id);
    let rest = rows.len().saturating_sub(AGENT_ICONS);
    let chevron = (!rows.is_empty() && !sessions.hides_one_agent(session.id, layouts)).then(|| {
        if sessions.hides_agents(session.id) {
            FOLD_CLOSED
        } else {
            FOLD_OPEN
        }
    });
    render_split(
        Line::from(place),
        Line::from(
            rows.iter()
                .take(AGENT_ICONS)
                .map(|(agent, _)| {
                    let (glyph, _, colour) = status(agent, own_attached, now);
                    span(format!("{glyph} "), colour)
                })
                .chain((rest > 0).then(|| span(format!("+{rest} "), COMMENT)))
                .chain(chevron.map(|chevron| span(chevron, DARK3)))
                .collect::<Vec<_>>(),
        ),
        second,
        buf,
    );
}

/// An agent pane's row under its tree `guide`: its status icon (the idle
/// circle filled while `attached`), `label` with where the search matched
/// it (blue and bold while `active`), and its harness mark on the right.
#[expect(
    clippy::too_many_arguments,
    reason = "the row's parts plus the frame inputs every node takes"
)]
fn render_agent(
    sessions: &Sessions,
    harnesses: &[HarnessInfo],
    agent: &Agent,
    label: &str,
    guide: &str,
    attached: bool,
    active: bool,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
) {
    let (glyph, _, colour) = status(agent, attached, now);
    let matched = sessions.title_matches(label).unwrap_or_default();
    let mark = harnesses
        .iter()
        .find(|info| info.id == agent.harness)
        .and_then(|info| info.icon.clone());
    render_split(
        Line::from(
            [
                span(guide.to_owned(), GUTTER),
                span(format!("{glyph} "), colour),
            ]
            .into_iter()
            .chain(title_spans(label, &matched, active))
            .collect::<Vec<_>>(),
        ),
        Line::from(mark.map(|mark| span(mark, LOGO)).unwrap_or_default()),
        area,
        buf,
    );
}

/// A folder kind's icon and colour: Research `nf-fa-flask` blue2, Learn
/// `nf-fa-book` purple.
pub(crate) fn kind_look(kind: FolderKind) -> (&'static str, Color) {
    match kind {
        FolderKind::Research => ("\u{f0c3}", BLUE2),
        FolderKind::Learn => ("\u{f02d}", PURPLE),
    }
}

/// A world's icon and colour: shared `nf-fa-globe` green1, Research
/// `nf-fa-flask` blue2, Learn `nf-fa-book` purple, fresh `nf-fa-copy` cyan;
/// `None` for other projects.
pub(crate) fn world_look(kind: ProjectKind) -> Option<(&'static str, Color)> {
    match kind {
        ProjectKind::SharedWorld => Some(("\u{f0ac}", GREEN1)),
        ProjectKind::Research => Some(kind_look(FolderKind::Research)),
        ProjectKind::Learn => Some(kind_look(FolderKind::Learn)),
        ProjectKind::FreshWorld => Some(("\u{f0c5}", CYAN)),
        ProjectKind::Normal | ProjectKind::Incognito => None,
    }
}

/// The Settled shelf's folder, open or closed, and how many sessions it
/// holds.
fn render_shelf_header(count: usize, open: bool, area: Rect, buf: &mut Buffer) {
    let folder = if open { FOLDER_OPEN } else { FOLDER };
    render_split(
        Line::from(vec![
            span(format!(" {folder} "), BLUE),
            span("Settled", BLUE),
        ]),
        Line::from(span(count.to_string(), COMMENT)),
        area,
        buf,
    );
}

/// A settled session's row under the shelf's folder: its icon (a dim check
/// unless its most urgent agent failed or is gone), title, and the time since
/// it settled.
fn render_settled(
    sessions: &Sessions,
    session: &Session,
    ends_shelf: bool,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
) {
    let guide = if ends_shelf { LAST_GUIDE } else { GUIDE };
    let agents = sessions.agents(session.id);
    let (glyph, colour) = match most_urgent(agents.iter().copied()) {
        Some(agent) if matches!(agent.status, AgentStatus::Failed | AgentStatus::Gone) => {
            let (glyph, _, colour) = status(agent, false, now);
            (glyph, colour)
        }
        _ => (COMPLETED_ICON, DARK3),
    };
    let title = sessions.title(session);
    let matched = sessions.title_matches(&title).unwrap_or_default();
    let ago = ago_label(since(
        now,
        session.settled_at.unwrap_or(session.last_activity_at),
    ));
    render_split(
        Line::from(
            [span(guide, GUTTER), span(format!("{glyph} "), colour)]
                .into_iter()
                .chain(highlight(&title, &matched, |_| COMMENT))
                .collect::<Vec<_>>(),
        ),
        Line::from(span(ago, DARK3)),
        area,
        buf,
    );
}

/// A session's status from its `agents`: its most urgent agent's, else the
/// idle circle, filled while `attached`.
pub(crate) fn session_status(
    agents: &[&Agent],
    attached: bool,
    now: SystemTime,
) -> (&'static str, Option<&'static str>, Color) {
    match most_urgent(agents.iter().copied()) {
        Some(agent) => status(agent, attached, now),
        None if attached => (ATTACHED_ICON, None, FG),
        None => (IDLE_ICON, None, DARK3),
    }
}

/// An agent's status as its icon, its short word (none while idle), and
/// their colour; `attached` fills the idle circle.
pub(crate) fn status(
    agent: &Agent,
    attached: bool,
    now: SystemTime,
) -> (&'static str, Option<&'static str>, Color) {
    match agent.status {
        AgentStatus::NeedsApproval => (APPROVAL_ICON, Some("approval"), YELLOW),
        AgentStatus::NeedsInput => (INPUT_ICON, Some("input"), MAGENTA),
        AgentStatus::Working => (spinner(agent, now), Some("working"), BLUE),
        AgentStatus::Failed => (FAILED_ICON, Some("failed"), RED),
        AgentStatus::Gone => (GONE_ICON, Some("gone"), RED),
        AgentStatus::Idle if agent.unseen => (COMPLETED_ICON, Some("done"), GREEN),
        AgentStatus::Stopped => (STOPPED_ICON, Some("stopped"), COMMENT),
        AgentStatus::Idle | AgentStatus::Unknown if attached => (ATTACHED_ICON, None, FG),
        AgentStatus::Idle | AgentStatus::Unknown => (IDLE_ICON, None, DARK3),
    }
}

/// The working spinner's frame: one per [`SPINNER_FRAME`] since the turn
/// started, so it moves with the loop's redraw while an agent works.
fn spinner(agent: &Agent, now: SystemTime) -> &'static str {
    let frames = agent
        .turn_started_at
        .map(|at| since(now, at).as_millis() / SPINNER_FRAME.as_millis())
        .unwrap_or_default();
    SPINNER
        .get(frames as usize % SPINNER.len())
        .copied()
        .unwrap_or_default()
}

/// How long the turn has run while working, else how long ago the last turn
/// ended.
fn when(agent: &Agent, now: SystemTime) -> String {
    match (agent.status, agent.turn_started_at) {
        (AgentStatus::Working, Some(at)) => working_label(since(now, at)),
        _ => ago_label(since(now, agent.last_activity_at)),
    }
}

/// A row's title spans, showing where the search `matched` it: blue and bold
/// while the row is `active`, else in `FG`.
fn title_spans(text: &str, matched: &[usize], active: bool) -> Vec<Span<'static>> {
    if active {
        highlight(text, matched, |_| BLUE)
            .into_iter()
            .map(|span| span.patch_style(Style::new().add_modifier(Modifier::BOLD)))
            .collect()
    } else {
        highlight(text, matched, |_| FG)
    }
}

fn span<'a, T>(text: T, fg: Color) -> Span<'a>
where
    T: Into<Cow<'a, str>>,
{
    Span::styled(text, Style::new().fg(fg))
}

/// The project's badge colour, lit.
fn project_colour(name: &str) -> Color {
    let (r, g, b) = BADGE.get(badge_colour(name)).copied().unwrap_or_default();
    Color::Rgb(r, g, b)
}

/// Draws `left`, and `right` against the right edge with a cell between them.
pub(crate) fn render_split(left: Line<'_>, right: Line<'_>, area: Rect, buf: &mut Buffer) {
    let [left_area, right_area] = Layout::horizontal([
        Constraint::Fill(1),
        Constraint::Length(width(&right).saturating_add(1)),
    ])
    .areas(area);
    left.render(left_area, buf);
    right.right_aligned().render(right_area, buf);
}

/// How long before `now` `at` was; zero if the clock went backwards.
fn since(now: SystemTime, at: SystemTime) -> Duration {
    now.duration_since(at).unwrap_or_default()
}

/// How long a turn has run, as T3 shows it: `45s`, `2m`, or `1h 5m`.
pub(crate) fn working_label(elapsed: Duration) -> String {
    let secs = elapsed.as_secs();
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m", secs / 60),
        _ => format!("{}h {}m", secs / 3600, secs / 60 % 60),
    }
}

/// How long ago something happened, as T3 shows it: `now`, `5m`, `3h`, or
/// `2d`.
pub(crate) fn ago_label(elapsed: Duration) -> String {
    let secs = elapsed.as_secs();
    match secs {
        0..60 => "now".to_owned(),
        60..3600 => format!("{}m", secs / 60),
        3600..86_400 => format!("{}h", secs / 3600),
        _ => format!("{}d", secs / 86_400),
    }
}

/// T3's two-letter project badge: the first glyph of the first word, then the
/// first digit after it, else the first glyph of the last word, else the first
/// word's last glyph. `PR` when the name has no letters or digits.
pub(crate) fn monogram(name: &str) -> String {
    let words: Vec<&str> = name
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    let glyphs: Vec<&str> = words
        .first()
        .map(|word| word.graphemes(true).collect())
        .unwrap_or_default();
    let Some((first, rest)) = glyphs.split_first() else {
        return "PR".to_owned();
    };
    let second = rest
        .iter()
        .copied()
        .find(|glyph| glyph.chars().all(char::is_numeric))
        .or_else(|| match words.as_slice() {
            [_, .., last] => last.graphemes(true).next(),
            _ => glyphs.last().copied(),
        })
        .unwrap_or(first);
    format!("{first}{second}")
        .to_uppercase()
        .graphemes(true)
        .take(2)
        .collect()
}

/// T3's badge colour for a project: an index into [`BADGE`], hashed from the
/// lower-cased name's code points.
pub(crate) fn badge_colour(name: &str) -> usize {
    let lowered = name.trim().to_lowercase();
    let seed = match lowered.as_str() {
        "" => "project",
        seed => seed,
    };
    seed.chars()
        .fold(0, |index, c| (index * 31 + c as usize) % BADGE.len())
}

/// The project's monogram tile, in its colour, or in gray unless `lit`.
pub(crate) fn badge(name: &str, lit: bool) -> Span<'static> {
    let (r, g, b) = if lit {
        BADGE.get(badge_colour(name))
    } else {
        BADGE.first()
    }
    .copied()
    .unwrap_or_default();
    Span::styled(
        monogram(name),
        Style::new()
            .fg(Color::Rgb(r, g, b))
            .bg(Color::Rgb(tint(r), tint(g), tint(b))),
    )
}

/// 14% of a colour channel over black, rounded.
fn tint(channel: u8) -> u8 {
    u8::try_from((u16::from(channel) * 14 + 50) / 100).unwrap_or(u8::MAX)
}

fn width(line: &Line<'_>) -> u16 {
    u16::try_from(line.width()).unwrap_or(u16::MAX)
}

/// Tailwind's 400 shades in T3's badge order: gray, red, orange, amber,
/// yellow, lime, green, emerald, teal, cyan, sky, blue, indigo, violet, purple,
/// fuchsia, pink, rose.
const BADGE: [(u8, u8, u8); 18] = [
    (0x9c, 0xa3, 0xaf),
    (0xf8, 0x71, 0x71),
    (0xfb, 0x92, 0x3c),
    (0xfb, 0xbf, 0x24),
    (0xfa, 0xcc, 0x15),
    (0xa3, 0xe6, 0x35),
    (0x4a, 0xde, 0x80),
    (0x34, 0xd3, 0x99),
    (0x2d, 0xd4, 0xbf),
    (0x22, 0xd3, 0xee),
    (0x38, 0xbd, 0xf8),
    (0x60, 0xa5, 0xfa),
    (0x81, 0x8c, 0xf8),
    (0xa7, 0x8b, 0xfa),
    (0xc0, 0x84, 0xfc),
    (0xe8, 0x79, 0xf9),
    (0xf4, 0x72, 0xb6),
    (0xfb, 0x71, 0x85),
];
/// The text on the mode line's mode and clock blocks (`black`).
pub(crate) const BLACK: Color = Color::Rgb(0x1b, 0x1d, 0x2b);
/// Behind the whole sidebar, the picker and the mode line (tokyonight-moon's
/// `bg_dark`, lualine's `bg_statusline`), darker than the right side, so the
/// sidebar needs no border.
pub(crate) const BG_DARK: Color = Color::Rgb(0x1e, 0x20, 0x30);
/// Behind the selected row's first line, and the picker's selected row
/// (`bg_visual`, the explorer's cursorline).
pub(crate) const VISUAL: Color = Color::Rgb(0x2d, 0x3f, 0x76);
/// The tree guides, behind the lit shelf badge, and behind the mode line's
/// branch and position blocks (`fg_gutter`).
pub(crate) const GUTTER: Color = Color::Rgb(0x3b, 0x42, 0x61);
/// Titles, the filtered project's name and an attached idle agent's
/// circle; the picker's input and rows, and the rename box's text (`fg`).
pub(crate) const FG: Color = Color::Rgb(0xc8, 0xd3, 0xf5);
/// Project names, and the keys in the picker's hints (`fg_dark`).
pub(crate) const FG_DARK: Color = Color::Rgb(0x82, 0x8b, 0xb8);
/// Times, the count, settled and path-line titles and the stopped icon; the
/// picker's hint labels, headings and empty-list text (`comment`).
pub(crate) const COMMENT: Color = Color::Rgb(0x63, 0x6d, 0xa6);
/// The idle icon, the unlit shelf badge and settled marks; the
/// picker's disabled branches and hint separators (`dark3`).
pub(crate) const DARK3: Color = Color::Rgb(0x54, 0x5c, 0x7e);
/// Working, the Settled shelf and the lit shelf badge; the picker's title and
/// folders (`blue`).
pub(crate) const BLUE: Color = Color::Rgb(0x82, 0xaa, 0xff);
/// The `>` prompt, here and in the picker, and the picker's `default`
/// branch badge, the message box's Messages, and a fresh world's icon
/// (`cyan`).
pub(crate) const CYAN: Color = Color::Rgb(0x86, 0xe1, 0xfc);
/// A completed turn; the picker's current branch and new worktree; the mode
/// line's INSERT (`green`).
pub(crate) const GREEN: Color = Color::Rgb(0xc3, 0xe8, 0x8d);
/// The mode line's PANE (`green1`, lualine's terminal mode), and a shared
/// world's icon.
pub(crate) const GREEN1: Color = Color::Rgb(0x4f, 0xd6, 0xbe);
/// A Research world's icon (`blue2`).
pub(crate) const BLUE2: Color = Color::Rgb(0x0d, 0xb9, 0xd7);
/// A Learn world's icon (`purple`).
pub(crate) const PURPLE: Color = Color::Rgb(0xfc, 0xa7, 0xea);
/// Needing approval; the picker's `worktree` branch badge; the rename box
/// (`yellow`).
pub(crate) const YELLOW: Color = Color::Rgb(0xff, 0xc7, 0x77);
/// The input box and the pin; the rule under the picker's input and its
/// git icon (`orange`).
pub(crate) const ORANGE: Color = Color::Rgb(0xff, 0x96, 0x6c);
/// Failed and gone, the message box's Error, and the which-key popup's lazygit
/// icon (`red`).
pub(crate) const RED: Color = Color::Rgb(0xff, 0x75, 0x7f);
/// Needing input; the picker's remote branches and previous worktree
/// (`magenta`).
pub(crate) const MAGENTA: Color = Color::Rgb(0xc0, 0x99, 0xff);
/// The picker's row numbers and dimmed path parents (`dark5`).
pub(crate) const DARK5: Color = Color::Rgb(0x73, 0x7a, 0xa2);
/// The picker's matched characters, and the rename box's edit icon (`blue1`,
/// snacks' `SnacksInputIcon`).
pub(crate) const BLUE1: Color = Color::Rgb(0x65, 0xbc, 0xff);
/// The picker's border (`border_highlight`).
pub(crate) const BORDER: Color = Color::Rgb(0x58, 0x9e, 0xd7);
/// A harness's mark (orange).
pub(crate) const LOGO: Color = Color::Rgb(0xd9, 0x77, 0x57);

/// Needing approval, here and in the mode line's count (Nerd Font
/// `nf-fa-warning`).
pub(crate) const APPROVAL_ICON: &str = "\u{f071}";
/// Needing input, here and in the mode line's count (`nf-fa-question_circle`).
pub(crate) const INPUT_ICON: &str = "\u{f059}";
/// Failed, and before the message box's Error title (`nf-fa-times_circle`).
pub(crate) const FAILED_ICON: &str = "\u{f057}";
/// Gone (`nf-fa-ban`).
const GONE_ICON: &str = "\u{f05e}";
/// A completed turn, and a settled agent that didn't fail
/// (`nf-fa-check_circle`).
pub(crate) const COMPLETED_ICON: &str = "\u{f058}";
/// Stopped (`nf-fa-stop`).
const STOPPED_ICON: &str = "\u{f04d}";
/// Idle, or a status orb doesn't know (`nf-fa-circle_o`).
pub(crate) const IDLE_ICON: &str = "\u{f10c}";
/// Idle while orb is attached (`nf-fa-circle`).
const ATTACHED_ICON: &str = "\u{f111}";
/// How long each spinner frame shows; the loop redraws this often while a
/// agent works or a session starts.
pub(crate) const SPINNER_FRAME: Duration = Duration::from_millis(100);
/// The spinner's frames, here and in the mode line's activity.
pub(crate) const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/// A pinned agent (`nf-fa-thumb_tack`).
pub(crate) const PIN: &str = "\u{f08d}";
/// Before a branch, here and in the picker (`nf-pl-branch`).
pub(crate) const BRANCH: &str = "\u{e0a0}";
/// A project, the closed Settled shelf, and the picker's folders
/// (`nf-fa-folder`).
pub(crate) const FOLDER: &str = "\u{f07b}";
/// The open Settled shelf, and the picker's `All projects` row
/// (`nf-fa-folder_open`).
pub(crate) const FOLDER_OPEN: &str = "\u{f07c}";
/// A model, before a harness's models when it has no mark
/// (`nf-fa-microchip`).
pub(crate) const CHIP: &str = "\u{f2db}";
/// The most status icons a card shows before counting the rest, here and in
/// a colonists row's dots.
const AGENT_ICONS: usize = 8;
/// The colonists row (`nf-fa-users`).
const USERS: &str = "\u{f0c0}";
/// A card whose agent rows show, or an open colonists row
/// (`nf-oct-chevron_down`).
const FOLD_OPEN: &str = "\u{f47c}";
/// A folded card or colonists row, and a path line's mark
/// (`nf-oct-chevron_right`).
const FOLD_CLOSED: &str = "\u{f460}";
/// The tree guide before a settled row.
const GUIDE: &str = " ├╴";
/// The tree guide before the last settled row.
const LAST_GUIDE: &str = " └╴";

#[cfg(test)]
mod tests;
