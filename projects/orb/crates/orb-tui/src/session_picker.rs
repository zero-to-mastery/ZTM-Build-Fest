//! The session picker, drawn like LazyVim's snacks picker in tokyonight-moon:
//! a float over the sidebar and the right side holding a list box and a
//! preview box, side by side from 120 columns and stacked below that.
//!
//! The list box is titled `Sessions`, followed by the active filter
//! (`Sessions · blocked`) unless it shows all. Its input row holds the typed text and how many sessions are shown
//! out of those listed, over an orange rule. Each row is one agent running in
//! a session's pane: the agent's status icon, its dim `<project>/` and bright
//! `<session>/<agent>`, and how long the agent has worked or since its last
//! chat; status and time are drawn live. Settled rows are dimmed behind a check. Nothing matched
//! leaves the list empty.
//!
//! The popup's bottom row, under both boxes, holds the picker's keys, dim.
//!
//! The preview box is titled with the selected row's label and shows its
//! most recently active agent's status, branch and model, then its latest
//! exchanges from the transcript: up to two earlier ones in brief while
//! there is room, and the newest with the prompt, the tools it ran, and the
//! end of its last reply as a small Markdown subset.

use std::collections::HashSet;
use std::time::SystemTime;

use orb_domain::feat::harness::HarnessInfo;
use orb_domain::feat::picker::list::{Matches, PickerItem};
use orb_domain::feat::picker::state::{PickerKind, PickerState, SessionFilter};
use orb_domain::feat::sessions::state::{Agent, AgentStatus, Sessions};
use orb_domain::feat::sessions::transcript::Exchange;
use orb_domain::ids::SessionId;
use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Clear, Widget};
use unicode_segmentation::UnicodeSegmentation;

use crate::mouse::HitMap;
use crate::picker::{
    PROMPT_WIDTH, PickerScroll, cut_left, highlight, hints, input_spans, span, visible,
};
use crate::sidebar::{
    BG_DARK, BLACK, BLUE, BORDER, BRANCH, COMMENT, COMPLETED_ICON, CYAN, DARK3, DARK5, FG, FG_DARK,
    GREEN1, GUTTER, ORANGE, VISUAL, ago_label, mark, render_split, status, working_label,
};

/// Draws the session picker over `area`: the list of `picker`'s rows with
/// live status from `sessions` (`attached` sessions fill the idle circle),
/// and the selected row's agent preview with its harness's mark and name from
/// `harnesses`. Returns how many rows the list fits, and where the terminal
/// cursor goes in the input. Records the popup, the list box as the wheel's
/// area and the list's rows in `hits`; the preview maps to no row and takes
/// no wheel.
#[expect(
    clippy::too_many_arguments,
    reason = "the picker's inputs plus the scroll and hit map it updates"
)]
pub(crate) fn render(
    picker: &PickerState,
    sessions: &Sessions,
    attached: &HashSet<SessionId>,
    harnesses: &[HarnessInfo],
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
    scroll: &mut PickerScroll,
    hits: &mut HitMap,
) -> (usize, Position) {
    let popup = big(area);
    Clear.render(popup, buf);
    buf.set_style(popup, Style::new().bg(BG_DARK));
    hits.record_overlay(popup);
    let frame = with_hints(picker, popup, buf);
    let [list_box, preview_box] = boxes(frame, area.width >= 120);
    hits.record_selector(list_box);
    let drawn = render_list(picker, sessions, attached, now, list_box, buf, scroll, hits);
    render_preview(picker, sessions, attached, harnesses, now, preview_box, buf);
    drawn
}

/// Draws `picker`'s keys along `popup`'s bottom row, under both boxes.
/// Returns the rest of `popup`.
pub(crate) fn with_hints(picker: &PickerState, popup: Rect, buf: &mut Buffer) -> Rect {
    let [frame, footer] =
        Layout::vertical([Constraint::Fill(1), Constraint::Length(1)]).areas(popup);
    hints(picker).render(footer, buf);
    frame
}

/// The list box and the preview box: side by side (45/55, one column
/// apart) when `wide`, else the list over the preview (60/40).
pub(crate) fn boxes(popup: Rect, wide: bool) -> [Rect; 2] {
    if wide {
        Layout::horizontal([Constraint::Percentage(45), Constraint::Percentage(55)])
            .spacing(1)
            .areas(popup)
    } else {
        Layout::vertical([Constraint::Percentage(60), Constraint::Percentage(40)]).areas(popup)
    }
}

/// 80% of `area` (at least 120 columns when it has them), centred.
pub(crate) fn big(area: Rect) -> Rect {
    let width = (area.width * 4 / 5).max(area.width.min(120));
    centred(area, width, area.height * 4 / 5)
}

/// A `width`×`height` rect centred in `area`, cut to fit it.
fn centred(area: Rect, width: u16, height: u16) -> Rect {
    let (width, height) = (width.min(area.width), height.min(area.height));
    Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    )
}

/// A rounded `BORDER` box on `BG_DARK`, with `title` centred in its top
/// border when there is one.
pub(crate) fn boxed(title: Option<Line<'static>>) -> Block<'static> {
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(BORDER).bg(BG_DARK))
        .style(Style::new().bg(BG_DARK));
    match title {
        Some(title) => block.title(title.centered()),
        None => block,
    }
}

/// ` Sessions `, or ` Colonists ` in the Colonists picker, then
/// ` · <filter>` unless the filter is all, then ` · colonists` while
/// colonists' agents are shown.
fn title(kind: &PickerKind) -> Line<'static> {
    let (filter, colonists, scope) = match kind {
        PickerKind::Sessions {
            filter,
            colonists,
            scope,
        } => (*filter, *colonists, scope.is_some()),
        _ => (SessionFilter::All, false, false),
    };
    let name = match filter {
        SessionFilter::All => None,
        SessionFilter::Blocked => Some("blocked"),
        SessionFilter::Working => Some("working"),
        SessionFilter::Idle => Some("idle"),
        SessionFilter::Settled => Some("settled"),
    };
    let mut text = if scope { " Colonists" } else { " Sessions" }.to_owned();
    if let Some(name) = name {
        text.push_str(" · ");
        text.push_str(name);
    }
    if colonists {
        text.push_str(" · colonists");
    }
    text.push(' ');
    Line::from(span(text, BLUE))
}

/// The list box: title, input row with the count, orange rule, rows.
/// Records each row in `hits`. Returns the rows' height and the cursor.
#[expect(
    clippy::too_many_arguments,
    reason = "the list's inputs plus the scroll and hit map it updates"
)]
fn render_list(
    picker: &PickerState,
    sessions: &Sessions,
    attached: &HashSet<SessionId>,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
    scroll: &mut PickerScroll,
    hits: &mut HitMap,
) -> (usize, Position) {
    let block = boxed(Some(title(picker.kind())));
    let inner = block.inner(area);
    block.render(area, buf);
    let [input, rule, rows] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Fill(1),
    ])
    .areas(inner);
    let shown: Vec<(&PickerItem, &Matches)> = picker.shown().collect();
    let count = format!("{}/{}", shown.len(), picker.total());
    let cursor = render_input(picker, &count, input, buf, hits);
    Line::from(span("─".repeat(usize::from(rule.width)), ORANGE)).render(rule, buf);
    let page = usize::from(rows.height).max(1);
    let offset = scroll.follow(picker.selection(), shown.len(), page);
    for ((index, (item, matches)), y) in shown
        .into_iter()
        .enumerate()
        .skip(offset)
        .zip(rows.top()..rows.bottom())
    {
        let row = Rect::new(rows.x, y, rows.width, 1);
        hits.record_picker_row(row, index);
        if index == picker.selection() {
            buf.set_style(row, Style::new().bg(VISUAL));
        }
        render_row(item, matches, sessions, attached, now, row, buf);
    }
    (page, cursor)
}

/// The prompt and the typed text (its end while too long, as in the
/// select picker), with `count` dim against the right edge. Returns the
/// cursor's position. Records its line in `hits`.
pub(crate) fn render_input(
    picker: &PickerState,
    count: &str,
    area: Rect,
    buf: &mut Buffer,
    hits: &mut HitMap,
) -> Position {
    let count = span(count.to_owned(), DARK3);
    // The count, the cell before it, the right margin and the cursor's cell.
    let room = usize::from(area.width).saturating_sub(PROMPT_WIDTH + count.width() + 3);
    let (shown, before) = visible(picker.input(), picker.cursor(), room);
    hits.record_text(area, PROMPT_WIDTH, picker.input(), picker.cursor(), room);
    render_split(
        Line::from(input_spans(picker, shown)),
        Line::from(count),
        Rect {
            width: area.width.saturating_sub(1),
            ..area
        },
        buf,
    );
    let x = u16::try_from(PROMPT_WIDTH + before)
        .unwrap_or(u16::MAX)
        .min(area.width.saturating_sub(1));
    Position::new(area.x + x, area.y)
}

/// One agent row: its agent's status icon (a dim check when its session is
/// settled), its label with the project dim and the matches lit, and its
/// agent's time on the right. A row whose session or agent is gone from
/// `sessions` shows only its label, dim.
fn render_row(
    item: &PickerItem,
    matches: &Matches,
    sessions: &Sessions,
    attached: &HashSet<SessionId>,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
) {
    let PickerItem::Session {
        id,
        agent: agent_id,
        label,
        split,
        settled,
        ..
    } = item
    else {
        return;
    };
    let agent = sessions
        .session(*id)
        .and_then(|_| sessions.all_agents().find(|shown| shown.id == *agent_id));
    let (icon, (dim, bright), time) = match (agent, settled) {
        (None, _) => (Span::raw("  "), (DARK3, DARK3), String::new()),
        (Some(agent), true) => (
            span(format!("{COMPLETED_ICON} "), DARK3),
            (DARK3, COMMENT),
            when(agent, now),
        ),
        (Some(agent), false) => {
            let (glyph, _, fg) = status(agent, attached.contains(id), now);
            (span(format!("{glyph} "), fg), (DARK5, FG), when(agent, now))
        }
    };
    let left: Line = [Span::raw(" "), icon]
        .into_iter()
        .chain(highlight(label, &matches.name, |at| {
            if at < *split { dim } else { bright }
        }))
        .collect();
    render_split(
        left,
        Line::from(span(time, DARK3)),
        Rect {
            width: area.width.saturating_sub(1),
            ..area
        },
        buf,
    );
}

/// How long the turn has run while working, else how long since the last
/// chat.
fn when(agent: &Agent, now: SystemTime) -> String {
    match (agent.status, agent.turn_started_at) {
        (AgentStatus::Working, Some(at)) => {
            working_label(now.duration_since(at).unwrap_or_default())
        }
        _ => ago_label(now.duration_since(agent.last_chat()).unwrap_or_default()),
    }
}

/// The preview box: untitled and empty with no agent selected, else
/// titled with the row's label and holding the agent's chat card.
fn render_preview(
    picker: &PickerState,
    sessions: &Sessions,
    attached: &HashSet<SessionId>,
    harnesses: &[HarnessInfo],
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
) {
    let Some(PickerItem::Session {
        id, agent, label, ..
    }) = picker.selected()
    else {
        boxed(None).render(area, buf);
        return;
    };
    let block = boxed(Some(Line::from(span(format!(" {label} "), BLUE))));
    let inner = block.inner(area);
    block.render(area, buf);
    let agent = sessions.all_agents().find(|shown| shown.id == *agent);
    let info = agent.and_then(|agent| harnesses.iter().find(|info| info.id == agent.harness));
    let meta = agent.map_or_else(Line::default, |agent| {
        meta(agent, info, attached.contains(id), now)
    });
    let exchanges = picker
        .preview()
        .map_or(&[][..], |preview| preview.exchanges.as_slice());
    for (line, y) in card(meta, exchanges, info, inner, now)
        .into_iter()
        .zip(inner.top()..inner.bottom())
    {
        line.render(Rect::new(inner.x, y, inner.width, 1), buf);
    }
}

/// The selected agent's status (`idle` while idle), branch and model after
/// its harness's (`info`'s) mark, dim.
pub(crate) fn meta(
    agent: &Agent,
    info: Option<&HarnessInfo>,
    attached: bool,
    now: SystemTime,
) -> Line<'static> {
    let (glyph, word, fg) = status(agent, attached, now);
    let mut spans = vec![
        span(format!(" {glyph} "), fg),
        span(word.unwrap_or("idle"), fg),
    ];
    if let Some(branch) = &agent.branch {
        spans.push(span(" · ", DARK3));
        spans.push(span(format!("{BRANCH} {branch}"), DARK5));
    }
    if let Some(model) = &agent.model {
        spans.push(span(" · ", DARK3));
        let (glyph, _) = mark(info.and_then(|info| info.icon.as_deref()));
        spans.push(span(format!("{glyph} {model}"), DARK5));
    }
    Line::from(spans)
}

/// The chat card's lines for `area`: `meta` over a rule, then ` No
/// transcript yet` without exchanges, else up to two earlier exchanges in
/// brief while the newest keeps twelve lines, and the newest with the rest.
/// Replies are headed with the harness's (`info`'s) mark and name.
fn card(
    meta: Line<'static>,
    exchanges: &[Exchange],
    info: Option<&HarnessInfo>,
    area: Rect,
    now: SystemTime,
) -> Vec<Line<'static>> {
    let width = usize::from(area.width).saturating_sub(1);
    let mut lines = vec![
        meta,
        Line::from(span("─".repeat(usize::from(area.width)), DARK3)),
    ];
    let height = usize::from(area.height).saturating_sub(lines.len());
    let Some((newest, earlier)) = exchanges.split_last() else {
        lines.push(Line::from(span(" No transcript yet", COMMENT)));
        return lines;
    };
    let mut briefs: Vec<Vec<Line<'static>>> = Vec::new();
    let mut used = 0;
    for exchange in earlier.iter().rev().take(2) {
        let brief = exchange_lines(exchange, info, width, usize::MAX, 2, 3, now);
        if used + brief.len() + 1 + 12 > height {
            break;
        }
        used += brief.len() + 1;
        briefs.push(brief);
    }
    for brief in briefs.into_iter().rev() {
        lines.extend(brief);
        lines.push(Line::from(span(
            format!(" {}", "┄".repeat(width.saturating_sub(1))),
            GUTTER,
        )));
    }
    lines.extend(exchange_lines(
        newest,
        info,
        width,
        height.saturating_sub(used),
        4,
        usize::MAX,
        now,
    ));
    lines
}

/// `exchange` as lines `width` wide, at most `room` of them: the prompt
/// (`prompt_cap` lines at most) on a cyan bar, then under the harness's
/// (`info`'s) header the tools it ran on one dim line and the end of its last
/// words (`reply_cap` lines at most).
fn exchange_lines(
    exchange: &Exchange,
    info: Option<&HarnessInfo>,
    width: usize,
    room: usize,
    prompt_cap: usize,
    reply_cap: usize,
    now: SystemTime,
) -> Vec<Line<'static>> {
    let mut head: Vec<Line<'static>> = Vec::new();
    if let Some((prompt, at)) = &exchange.prompt {
        head.push(speaker("", "You", CYAN, *at, now, width));
        let bar = || span(" ▎ ", CYAN);
        let mut lines = wrap_words(
            inline(&prompt.replace('\n', " "), Style::new().fg(FG)),
            width,
            &[bar()],
            &[bar()],
        );
        if lines.len() > prompt_cap {
            lines.truncate(prompt_cap);
            if let Some(last) = lines.last_mut() {
                last.spans.push(span(" …", DARK5));
            }
        }
        head.extend(lines);
        head.push(Line::default());
    }
    let reply_at = exchange.reply.as_ref().and_then(|(_, at)| *at);
    head.push(reply_speaker(info, reply_at, now, width));
    if !exchange.tools.is_empty() {
        let tools: Vec<String> = exchange
            .tools
            .iter()
            .map(|(name, count)| match count {
                1 => name.clone(),
                _ => format!("{name} ×{count}"),
            })
            .collect();
        let text = cut_left(&tools.join(" · "), width.saturating_sub(6));
        head.push(Line::from(vec![span("   ⎿  ", DARK3), span(text, DARK5)]));
    }
    let body = match &exchange.reply {
        Some((reply, _)) => markdown(reply, width, "   ", Style::new().fg(FG)),
        None => vec![Line::from(span("   …", DARK5))],
    };
    // The reply's end says where the agent stands, so a long one keeps
    // its last lines under a `⋮`.
    let left = room.saturating_sub(head.len()).min(reply_cap);
    let body = if body.len() > left {
        let skip = body.len() - left.saturating_sub(1);
        std::iter::once(Line::from(span("   ⋮", DARK5)))
            .chain(body.into_iter().skip(skip))
            .collect()
    } else {
        body
    };
    head.extend(body);
    head.truncate(room);
    head
}

/// The header of a reply: the harness's (`info`'s) mark and name.
pub(crate) fn reply_speaker(
    info: Option<&HarnessInfo>,
    at: Option<SystemTime>,
    now: SystemTime,
    width: usize,
) -> Line<'static> {
    let (glyph, fg) = mark(info.and_then(|info| info.icon.as_deref()));
    let label = info.map_or("", |info| info.label.as_str());
    speaker(glyph, label, fg, at, now, width)
}

/// A speaker's header: `mark name` in bold `fg`, how long ago on the right.
pub(crate) fn speaker(
    mark: &str,
    name: &str,
    fg: Color,
    at: Option<SystemTime>,
    now: SystemTime,
    width: usize,
) -> Line<'static> {
    let left = format!(" {mark} {name}");
    let when = at
        .map(|at| ago_label(now.duration_since(at).unwrap_or_default()))
        .unwrap_or_default();
    let gap = width.saturating_sub(Line::raw(left.as_str()).width() + when.len() + 1);
    Line::from(vec![
        Span::styled(left, Style::new().fg(fg).add_modifier(Modifier::BOLD)),
        Span::raw(" ".repeat(gap)),
        span(when, DARK3),
    ])
}

/// Markdown `text` as lines `width` wide behind `indent`: headings blue,
/// bullets as `•`, fenced code dim on black, `code` and **bold** inline.
/// Blank lines collapse to one and trailing ones are dropped.
pub(crate) fn markdown(text: &str, width: usize, indent: &str, base: Style) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut fenced = false;
    let pad = || Span::raw(indent.to_owned());
    for raw in text.lines() {
        let trimmed = raw.trim_start();
        if trimmed.starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            let room = width.saturating_sub(indent.len() + 2);
            let code = cut_right(raw, room);
            let fill = " ".repeat(room.saturating_sub(Line::raw(code.as_str()).width()));
            out.push(Line::from(vec![
                pad(),
                Span::styled(
                    format!(" {code}{fill} "),
                    Style::new().fg(FG_DARK).bg(BLACK),
                ),
            ]));
            continue;
        }
        if trimmed.is_empty() {
            if out.last().is_some_and(|line| line.width() > indent.len()) {
                out.push(Line::default());
            }
            continue;
        }
        let (first, next, body, style) = if let Some(heading) = trimmed.strip_prefix('#') {
            let body = heading.trim_start_matches('#').trim_start();
            let style = Style::new().fg(BLUE).add_modifier(Modifier::BOLD);
            (vec![pad()], vec![pad()], body, style)
        } else if let Some(body) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            (
                vec![pad(), span("• ", ORANGE)],
                vec![pad(), Span::raw("  ")],
                body,
                base,
            )
        } else {
            (vec![pad()], vec![pad()], trimmed, base)
        };
        out.extend(wrap_words(inline(body, style), width, &first, &next));
    }
    while out.last().is_some_and(|line| line.width() == 0) {
        out.pop();
    }
    out
}

/// `text`'s words with Markdown's `code` and **bold** styled, each word one
/// or more spans.
fn inline(text: &str, base: Style) -> Vec<Vec<Span<'static>>> {
    let mut words: Vec<Vec<Span<'static>>> = Vec::new();
    let mut word: Vec<Span<'static>> = Vec::new();
    let mut piece = String::new();
    let (mut in_code, mut bold) = (false, false);
    let style = |in_code: bool, bold: bool| match (in_code, bold) {
        (true, _) => Style::new().fg(GREEN1),
        (false, true) => base.add_modifier(Modifier::BOLD),
        (false, false) => base,
    };
    let mut graphemes = text.graphemes(true).peekable();
    while let Some(grapheme) = graphemes.next() {
        let toggle = match grapheme {
            "`" => Some(true),
            "*" if !in_code && graphemes.peek() == Some(&"*") => {
                graphemes.next();
                Some(false)
            }
            " " if !in_code => {
                if !piece.is_empty() {
                    word.push(Span::styled(
                        std::mem::take(&mut piece),
                        style(in_code, bold),
                    ));
                }
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
                continue;
            }
            _ => None,
        };
        match toggle {
            Some(flip_code) => {
                if !piece.is_empty() {
                    word.push(Span::styled(
                        std::mem::take(&mut piece),
                        style(in_code, bold),
                    ));
                }
                if flip_code {
                    in_code = !in_code;
                } else {
                    bold = !bold;
                }
            }
            None => piece.push_str(grapheme),
        }
    }
    if !piece.is_empty() {
        word.push(Span::styled(piece, style(in_code, bold)));
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

/// `words` wrapped to `width`, `first` before the first line and `next`
/// before the rest.
pub(crate) fn wrap_words(
    words: Vec<Vec<Span<'static>>>,
    width: usize,
    first: &[Span<'static>],
    next: &[Span<'static>],
) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut line: Vec<Span<'static>> = first.to_vec();
    let mut used = Line::from(first.to_vec()).width();
    let mut empty = true;
    for word in words {
        let size = Line::from(word.clone()).width();
        if !empty && used + 1 + size > width {
            lines.push(Line::from(std::mem::replace(&mut line, next.to_vec())));
            used = Line::from(next.to_vec()).width();
            empty = true;
        }
        if !empty {
            line.push(Span::raw(" "));
            used += 1;
        }
        used += size;
        line.extend(word);
        empty = false;
    }
    lines.push(Line::from(line));
    lines
}

/// `text` if it fits in `width` columns, else as much of its start as fits
/// and `…`.
pub(crate) fn cut_right(text: &str, width: usize) -> String {
    if Line::raw(text).width() <= width {
        return text.to_owned();
    }
    let mut used = 1;
    let head: String = text
        .graphemes(true)
        .take_while(|grapheme| {
            used += Line::raw(*grapheme).width();
            used <= width
        })
        .collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use orb_domain::feat::harness::HarnessId;
    use orb_domain::feat::harness::claude::info;
    use std::collections::HashSet;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use orb_domain::Focus;
    use orb_domain::feat::picker::state::{PickerState, SessionFilter, session_items};
    use orb_domain::feat::sessions::state::{
        Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Sessions,
    };
    use orb_domain::feat::sessions::transcript::Exchange;
    use orb_domain::ids::{AgentId, PaneId, ProjectId, SessionId};
    use ratatui::buffer::{Buffer, Cell};
    use ratatui::layout::{Position, Rect};
    use ratatui::style::Modifier;
    use unicode_segmentation::UnicodeSegmentation;

    use super::render;
    use crate::mouse::HitMap;
    use crate::picker::PickerScroll;
    use crate::sidebar::{BLACK, BRANCH, COMPLETED_ICON, DARK3, DARK5, IDLE_ICON, VISUAL};
    use crate::test_support::{layouts_for, sessions_for};

    /// The clock every picker is drawn at.
    fn now() -> SystemTime {
        UNIX_EPOCH + Duration::from_hours(240)
    }

    /// Agent `id` titled `title`, alone in session `id`, last active five
    /// minutes before [`now`].
    fn agent(id: i64, title: &str, status: AgentStatus) -> Agent {
        Agent {
            last_session: None,
            harness: HarnessId::new("claude"),
            id: AgentId(id),
            title: Some(title.to_owned()),
            cwd: "/Users/me/dev/orb".into(),
            transcript: None,
            status,
            turn_started_at: None,
            pane: Some(PaneLaunch {
                pane: PaneId(id),
                session: SessionId(id),
            }),
            branch: None,
            created_at: UNIX_EPOCH,
            last_activity_at: now() - Duration::from_mins(5),
            unseen: false,
            model: None,
        }
    }

    /// `sessions` with session 1 settled at [`now`].
    fn settled(mut sessions: Sessions) -> Sessions {
        sessions
            .sessions
            .iter_mut()
            .filter(|session| session.id == SessionId(1))
            .for_each(|session| session.settled_at = Some(now()));
        sessions
    }

    /// `agents` in one project, `orb`, each in its own session.
    fn sessions(agents: Vec<Agent>) -> Sessions {
        let projects = vec![Project {
            id: ProjectId(1),
            title: "orb".to_owned(),
            root: "/Users/me/dev/orb".into(),
            created_at: UNIX_EPOCH,
            removed: false,
            repo: true,
            agents,
            kind: ProjectKind::Normal,
        }];
        Sessions {
            sessions: sessions_for(&projects),
            projects,
            ..Sessions::default()
        }
    }

    /// The session picker over `sessions`, on all agents.
    fn picker(sessions: &Sessions) -> PickerState {
        PickerState::sessions(
            session_items(
                sessions,
                &layouts_for(&sessions.projects),
                SessionFilter::All,
                false,
                None,
            ),
            Focus::Sidebar,
        )
    }

    /// Types `text` into `picker`.
    fn typed(picker: &mut PickerState, text: &[char]) {
        for ch in text {
            picker.insert(*ch);
        }
    }

    /// An exchange with no times: `prompt`, then `tools`, then `reply`.
    fn exchange(prompt: Option<&str>, tools: &[(&str, usize)], reply: Option<&str>) -> Exchange {
        Exchange {
            prompt: prompt.map(|prompt| (prompt.to_owned(), None)),
            tools: tools
                .iter()
                .map(|&(name, count)| (name.to_owned(), count))
                .collect(),
            reply: reply.map(|reply| (reply.to_owned(), None)),
        }
    }

    /// The picker over one agent, `orb/Fix the bug`, previewing `exchanges`.
    fn previewing(exchanges: Vec<Exchange>) -> (PickerState, Sessions) {
        let sessions = sessions(vec![agent(1, "Fix the bug", AgentStatus::Idle)]);
        let mut picker = picker(&sessions);
        picker.show_preview(AgentId(1), 1, exchanges);
        (picker, sessions)
    }

    /// Draws `picker` over a `width`×`height` screen with live data from
    /// `sessions`, nothing attached. Returns the screen and the page size.
    fn draw(picker: &PickerState, sessions: &Sessions, width: u16, height: u16) -> (Buffer, usize) {
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));
        let (page, _) = render(
            picker,
            sessions,
            &HashSet::new(),
            &[info()],
            now(),
            buf.area,
            &mut buf,
            &mut PickerScroll::default(),
            &mut HitMap::default(),
        );
        (buf, page)
    }

    /// Draws `picker` over a `width`×`height` screen with live data from
    /// `sessions`, nothing attached. Returns what it recorded and the input's
    /// cursor, two lines above the first row.
    fn hits_of(
        picker: &PickerState,
        sessions: &Sessions,
        width: u16,
        height: u16,
    ) -> (HitMap, Position) {
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));
        let mut hits = HitMap::default();
        let (_, cursor) = render(
            picker,
            sessions,
            &HashSet::new(),
            &[info()],
            now(),
            buf.area,
            &mut buf,
            &mut PickerScroll::default(),
            &mut hits,
        );
        (hits, cursor)
    }

    /// Three idle agents in `orb`.
    fn three_agents() -> Sessions {
        sessions(vec![
            agent(1, "one", AgentStatus::Idle),
            agent(2, "two", AgentStatus::Idle),
            agent(3, "three", AgentStatus::Idle),
        ])
    }

    /// The screen's lines, top to bottom.
    fn lines(buf: &Buffer) -> Vec<String> {
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .filter_map(|x| buf.cell((x, y)).map(Cell::symbol))
                    .collect()
            })
            .collect()
    }

    /// The cell where `text` first starts, row by row.
    fn find(buf: &Buffer, text: &str) -> Option<(u16, u16)> {
        let len = text.graphemes(true).count();
        (0..buf.area.height).find_map(|y| {
            let row: Vec<&str> = (0..buf.area.width)
                .filter_map(|x| buf.cell((x, y)).map(Cell::symbol))
                .collect();
            (0..row.len())
                .find(|&x| {
                    row.get(x..x + len)
                        .is_some_and(|cells| cells.concat() == text)
                })
                .map(|x| (x as u16, y))
        })
    }

    /// The line `text` first shows on.
    fn line_of(buf: &Buffer, text: &str) -> String {
        find(buf, text)
            .and_then(|(_, y)| lines(buf).into_iter().nth(usize::from(y)))
            .unwrap_or_default()
    }

    /// Two agents, `orb/Fix the bug` and `orb/Write docs`.
    fn two() -> Sessions {
        sessions(vec![
            agent(1, "Fix the bug", AgentStatus::Idle),
            agent(2, "Write docs", AgentStatus::Idle),
        ])
    }

    #[rstest::rstest]
    fn wide_area_puts_the_boxes_side_by_side() {
        // Given two agents on a 140-column screen.
        let sessions = two();

        // When drawing the picker.
        let (buf, _) = draw(&picker(&sessions), &sessions, 140, 30);

        // Then the top border row holds two box corners.
        let top = line_of(&buf, "╭");
        assert_eq!(top.matches('╭').count(), 2, "top row was {top}");
    }

    #[rstest::rstest]
    fn narrow_area_stacks_the_list_over_the_preview() {
        // Given two agents on a 100-column screen.
        let sessions = two();

        // When drawing the picker.
        let (buf, _) = draw(&picker(&sessions), &sessions, 100, 30);

        // Then two box corners sit in the same column on different rows.
        let corners: Vec<(usize, usize)> = lines(&buf)
            .iter()
            .enumerate()
            .filter_map(|(y, line)| {
                line.graphemes(true)
                    .position(|grapheme| grapheme == "╭")
                    .map(|x| (x, y))
            })
            .collect();
        let stacked = matches!(corners.as_slice(), [(x1, _), (x2, _)] if x1 == x2);
        assert!(stacked, "corners were {corners:?}");
    }

    #[rstest::rstest]
    #[case(SessionFilter::Blocked, false, " Sessions · blocked ")]
    #[case(SessionFilter::Working, false, " Sessions · working ")]
    #[case(SessionFilter::Idle, false, " Sessions · idle ")]
    #[case(SessionFilter::Settled, false, " Sessions · settled ")]
    #[case(SessionFilter::Blocked, true, " Sessions · blocked · colonists ")]
    fn title_names_the_active_filter(
        #[case] filter: SessionFilter,
        #[case] colonists: bool,
        #[case] expected: &str,
    ) {
        // Given the session picker filtered to `filter`, showing colonists
        // when `colonists`.
        let sessions = two();
        let layouts = layouts_for(&sessions.projects);
        let mut picker = picker(&sessions);
        picker.set_filter(filter, &sessions, &layouts);
        if colonists {
            picker.toggle_colonists(&sessions, &layouts);
        }

        // When drawing the picker.
        let (buf, _) = draw(&picker, &sessions, 140, 30);

        // Then the title row names the filter.
        let title = line_of(&buf, "Sessions");
        assert!(title.contains(expected), "title row was {title}");
    }

    #[rstest::rstest]
    fn title_on_all_names_no_filter() {
        // Given the session picker on all agents.
        let sessions = two();

        // When drawing the picker.
        let (buf, _) = draw(&picker(&sessions), &sessions, 140, 30);

        // Then the title row is ` Sessions ` with no filter after it.
        let title = line_of(&buf, "Sessions");
        assert!(
            title.contains(" Sessions ") && !title.contains('·'),
            "title row was {title}"
        );
    }

    #[rstest::rstest]
    fn count_sits_at_the_input_rows_right_end() {
        // Given two agents, with `docs` typed.
        let sessions = two();
        let mut picker = picker(&sessions);
        typed(&mut picker, &['d', 'o', 'c', 's']);

        // When drawing the picker.
        let (buf, _) = draw(&picker, &sessions, 140, 30);

        // Then the input row ends in the count, one cell from the border.
        let input = line_of(&buf, " / ");
        assert!(input.contains("1/2 │"), "input row was {input}");
    }

    #[rstest::rstest]
    fn nothing_matched_draws_no_rows() {
        // Given two agents, with `zzz` typed.
        let sessions = two();
        let mut picker = picker(&sessions);
        typed(&mut picker, &['z', 'z', 'z']);

        // When drawing the picker.
        let (buf, _) = draw(&picker, &sessions, 140, 30);

        // Then neither title shows.
        let screen = lines(&buf).join("\n");
        assert!(
            !screen.contains("Fix the bug") && !screen.contains("Write docs"),
            "screen was\n{screen}"
        );
    }

    #[rstest::rstest]
    fn selected_row_is_filled_with_visual() {
        // Given two agents.
        let sessions = two();

        // When drawing the stacked picker, the list above the preview.
        let (buf, _) = draw(&picker(&sessions), &sessions, 100, 30);

        // Then the first row is filled.
        let bg = find(&buf, "orb/")
            .and_then(|at| buf.cell(at))
            .map(|cell| cell.bg);
        assert_eq!(bg, Some(VISUAL), "the selected row should be filled");
    }

    #[rstest::rstest]
    fn row_prefix_is_dark5() {
        // Given one agent.
        let sessions = sessions(vec![agent(1, "Fix the bug", AgentStatus::Idle)]);

        // When drawing the stacked picker, the list above the preview.
        let (buf, _) = draw(&picker(&sessions), &sessions, 100, 30);

        // Then the row's `orb/` is dim.
        let fg = find(&buf, "orb/")
            .and_then(|at| buf.cell(at))
            .map(|cell| cell.fg);
        assert_eq!(fg, Some(DARK5), "the prefix should be dark5");
    }

    #[rstest::rstest]
    fn settled_row_shows_the_check_in_dark3() {
        // Given a settled agent, with settled agents shown.
        let sessions = settled(sessions(vec![agent(1, "Fix the bug", AgentStatus::Idle)]));
        let mut picker = picker(&sessions);
        picker.set_filter(
            SessionFilter::Settled,
            &sessions,
            &layouts_for(&sessions.projects),
        );

        // When drawing the stacked picker, the list above the preview.
        let (buf, _) = draw(&picker, &sessions, 100, 30);

        // Then the row's check is dim.
        let fg = find(&buf, COMPLETED_ICON)
            .and_then(|at| buf.cell(at))
            .map(|cell| cell.fg);
        assert_eq!(fg, Some(DARK3), "the check should be dark3");
    }

    #[rstest::rstest]
    fn working_row_shows_the_spinner_and_its_turn_time() {
        // Given an agent two minutes into its turn.
        let sessions = sessions(vec![Agent {
            turn_started_at: Some(now() - Duration::from_mins(2)),
            ..agent(1, "Fix the bug", AgentStatus::Working)
        }]);

        // When drawing the stacked picker, the list above the preview.
        let (buf, _) = draw(&picker(&sessions), &sessions, 100, 30);

        // Then its row holds the spinner and ends in the turn's time.
        let row = line_of(&buf, "⠋");
        assert!(
            row.contains("Fix the bug") && row.contains("2m │"),
            "row was {row}"
        );
    }

    #[rstest::rstest]
    fn idle_agent_beside_a_working_sibling_shows_the_idle_icon() {
        // Given session 1 running working agent 1 and idle agent 2.
        let sessions = sessions(vec![
            agent(1, "Fix the bug", AgentStatus::Working),
            Agent {
                pane: Some(PaneLaunch {
                    pane: PaneId(2),
                    session: SessionId(1),
                }),
                ..agent(2, "Write docs", AgentStatus::Idle)
            },
        ]);

        // When drawing the stacked picker, the list above the preview.
        let (buf, _) = draw(&picker(&sessions), &sessions, 100, 30);

        // Then the idle agent's row shows the idle icon.
        let row = line_of(&buf, "Write docs");
        assert!(row.contains(IDLE_ICON), "row was {row}");
    }

    #[rstest::rstest]
    fn deleted_agent_row_is_dark3_without_a_time() {
        // Given a picker over two agents, one since gone from the sessions.
        let picker = picker(&two());
        let sessions = sessions(vec![agent(2, "Write docs", AgentStatus::Idle)]);

        // When drawing the stacked picker, the list above the preview.
        let (buf, _) = draw(&picker, &sessions, 100, 30);

        // Then the gone agent's title is dim and its row has no time.
        let fg = find(&buf, "Fix the bug")
            .and_then(|at| buf.cell(at))
            .map(|cell| cell.fg);
        let row = line_of(&buf, "Fix the bug");
        assert!(
            fg == Some(DARK3) && !row.contains("5m"),
            "fg was {fg:?}, row was {row}"
        );
    }

    #[rstest::rstest]
    fn nothing_matched_leaves_the_preview_untitled() {
        // Given two agents, with `zzz` typed.
        let sessions = two();
        let mut picker = picker(&sessions);
        typed(&mut picker, &['z', 'z', 'z']);

        // When drawing the picker.
        let (buf, _) = draw(&picker, &sessions, 140, 30);

        // Then the preview box's top border is only `─` between its corners.
        let top = line_of(&buf, "╭");
        let border = top
            .rsplit_once('╭')
            .and_then(|(_, rest)| rest.split_once('╮'))
            .map_or("", |(border, _)| border);
        assert!(
            !border.is_empty() && border.graphemes(true).all(|grapheme| grapheme == "─"),
            "top row was {top}"
        );
    }

    #[rstest::rstest]
    fn preview_is_titled_with_the_selected_label() {
        // Given one agent.
        let sessions = sessions(vec![agent(1, "Fix the bug", AgentStatus::Idle)]);

        // When drawing the picker.
        let (buf, _) = draw(&picker(&sessions), &sessions, 140, 30);

        // Then the top border row holds the agent's label.
        let top = line_of(&buf, "╭");
        assert!(top.contains("orb/Fix the bug"), "top row was {top}");
    }

    #[rstest::rstest]
    fn meta_line_shows_the_branch_and_model() {
        // Given an agent on `main` running `opus`.
        let sessions = sessions(vec![Agent {
            branch: Some("main".to_owned()),
            model: Some("opus".to_owned()),
            ..agent(1, "Fix the bug", AgentStatus::Idle)
        }]);

        // When drawing the stacked picker, the preview below the list.
        let (buf, _) = draw(&picker(&sessions), &sessions, 100, 30);

        // Then the line under the preview's top border holds the status, the
        // branch and the model.
        let lines = lines(&buf);
        let meta = lines
            .iter()
            .rposition(|line| line.contains('╭'))
            .and_then(|y| lines.get(y + 1))
            .map_or("", String::as_str);
        assert!(
            meta.contains(&format!("idle · {BRANCH} main · ✳ opus")),
            "meta row was {meta}"
        );
    }

    #[rstest::rstest]
    fn preview_without_exchanges_says_no_transcript_yet() {
        // Given one agent with no preview loaded.
        let sessions = sessions(vec![agent(1, "Fix the bug", AgentStatus::Idle)]);

        // When drawing the picker.
        let (buf, _) = draw(&picker(&sessions), &sessions, 140, 30);

        // Then the preview says there is no transcript yet.
        let screen = lines(&buf).join("\n");
        assert!(
            screen.contains(" No transcript yet"),
            "screen was\n{screen}"
        );
    }

    #[rstest::rstest]
    fn newest_exchange_starts_with_you_over_a_prompt_bar() {
        // Given a preview of one exchange prompted `hello`.
        let (picker, sessions) = previewing(vec![exchange(Some("hello"), &[], None)]);

        // When drawing the picker.
        let (buf, _) = draw(&picker, &sessions, 140, 30);

        // Then the line under `You` holds the prompt on its bar.
        let prompt = find(&buf, " You")
            .and_then(|(_, y)| lines(&buf).into_iter().nth(usize::from(y) + 1))
            .unwrap_or_default();
        assert!(prompt.contains("▎ hello"), "prompt row was {prompt}");
    }

    #[rstest::rstest]
    fn tools_line_joins_runs_with_a_count() {
        // Given a preview of an exchange that ran Grep once and Edit twice.
        let (picker, sessions) = previewing(vec![exchange(
            Some("hello"),
            &[("Grep", 1), ("Edit", 2)],
            Some("done"),
        )]);

        // When drawing the picker.
        let (buf, _) = draw(&picker, &sessions, 140, 30);

        // Then one line lists the tools with the run counted.
        let screen = lines(&buf).join("\n");
        assert!(screen.contains("⎿  Grep · Edit ×2"), "screen was\n{screen}");
    }

    #[rstest::rstest]
    fn long_reply_keeps_its_tail_under_a_vertical_ellipsis() {
        // Given a preview of a sixty-line reply.
        let reply = (1..=60)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let (picker, sessions) = previewing(vec![exchange(Some("hello"), &[], Some(&reply))]);

        // When drawing the picker.
        let (buf, _) = draw(&picker, &sessions, 140, 30);

        // Then a `⋮` stands over the reply's tail, which ends at its last line.
        let lines = lines(&buf);
        let last = lines.iter().rfind(|line| line.contains("line "));
        assert!(
            lines.iter().any(|line| line.contains('⋮'))
                && last.is_some_and(|line| line.contains("line 60"))
                && !lines.iter().any(|line| line.contains("line 1 ")),
            "screen was\n{}",
            lines.join("\n")
        );
    }

    #[rstest::rstest]
    fn tall_preview_shows_an_earlier_exchange_in_brief() {
        // Given a preview of three exchanges.
        let (picker, sessions) = previewing(vec![
            exchange(Some("first"), &[], Some("one")),
            exchange(Some("second"), &[], Some("two")),
            exchange(Some("third"), &[], Some("three")),
        ]);

        // When drawing the picker on a tall screen.
        let (buf, _) = draw(&picker, &sessions, 140, 60);

        // Then `second` shows in brief, with a dotted rule after it.
        let lines = lines(&buf);
        let ruled = lines
            .iter()
            .skip_while(|line| !line.contains("second"))
            .any(|line| line.contains('┄'));
        assert!(ruled, "screen was\n{}", lines.join("\n"));
    }

    #[rstest::rstest]
    fn short_preview_drops_the_briefs_and_keeps_the_newest() {
        // Given a preview of three exchanges.
        let (picker, sessions) = previewing(vec![
            exchange(Some("first"), &[], Some("one")),
            exchange(Some("second"), &[], Some("two")),
            exchange(Some("third"), &[], Some("three")),
        ]);

        // When drawing the picker on a short screen.
        let (buf, _) = draw(&picker, &sessions, 140, 20);

        // Then only the newest exchange shows.
        let screen = lines(&buf).join("\n");
        assert!(
            !screen.contains("second") && screen.contains("third"),
            "screen was\n{screen}"
        );
    }

    #[rstest::rstest]
    fn fenced_code_sits_on_black() {
        // Given a preview whose reply is a fenced code block.
        let (picker, sessions) = previewing(vec![exchange(
            Some("hello"),
            &[],
            Some("```\nlet x = 1;\n```"),
        )]);

        // When drawing the picker.
        let (buf, _) = draw(&picker, &sessions, 140, 30);

        // Then the code sits on black.
        let bg = find(&buf, "let x")
            .and_then(|at| buf.cell(at))
            .map(|cell| cell.bg);
        assert_eq!(bg, Some(BLACK), "fenced code should be on black");
    }

    #[rstest::rstest]
    fn bold_markdown_is_bold_without_asterisks() {
        // Given a preview whose reply is `**done**`.
        let (picker, sessions) = previewing(vec![exchange(Some("hello"), &[], Some("**done**"))]);

        // When drawing the picker.
        let (buf, _) = draw(&picker, &sessions, 140, 30);

        // Then `done` is bold and no asterisks show.
        let bold = find(&buf, "done")
            .and_then(|at| buf.cell(at))
            .is_some_and(|cell| cell.modifier.contains(Modifier::BOLD));
        let screen = lines(&buf).join("\n");
        assert!(bold && !screen.contains("**"), "screen was\n{screen}");
    }

    #[rstest::rstest]
    fn hints_sit_on_the_popups_bottom_row() {
        // Given two agents on a 140×30 screen.
        let sessions = two();

        // When drawing the picker.
        let (buf, _) = draw(&picker(&sessions), &sessions, 140, 30);

        // Then the keys start one cell in on the popup's bottom row.
        let popup = super::big(buf.area);
        let at = find(&buf, "↑↓/j/k rows");
        assert_eq!(
            at,
            Some((popup.x + 1, popup.bottom() - 1)),
            "where the hints start"
        );
    }

    #[rstest::rstest]
    fn hints_name_the_session_keys() {
        // Given two agents.
        let sessions = two();

        // When drawing the picker.
        let (buf, _) = draw(&picker(&sessions), &sessions, 140, 30);

        // Then the hints name the filters, colonists, close and open.
        let expected = "↑↓/j/k rows · / search · a/b/w/i/s filter · c colonists · d close · ⏎ open · Esc close";
        assert!(find(&buf, expected).is_some(), "the hints {expected:?}");
    }

    /// The Colonists picker over `sessions`' agents, on colony 1.
    fn colonists_picker(sessions: &Sessions) -> PickerState {
        PickerState::colonists(
            session_items(
                sessions,
                &layouts_for(&sessions.projects),
                SessionFilter::All,
                false,
                None,
            ),
            SessionId(1),
            Focus::Sidebar,
        )
    }

    #[rstest::rstest]
    fn colonists_picker_is_titled_colonists() {
        // Given the Colonists picker.
        let sessions = two();

        // When drawing it.
        let (buf, _) = draw(&colonists_picker(&sessions), &sessions, 140, 30);

        // Then the title row is ` Colonists `.
        let title = line_of(&buf, "Colonists");
        assert!(title.contains(" Colonists "), "title row was {title}");
    }

    #[rstest::rstest]
    fn colonists_picker_hints_leave_out_c() {
        // Given the Colonists picker.
        let sessions = two();

        // When drawing it.
        let (buf, _) = draw(&colonists_picker(&sessions), &sessions, 140, 30);

        // Then the hints name the filters and close, but not `c`.
        let expected = "↑↓/j/k rows · / search · a/b/w/i/s filter · d close · ⏎ open · Esc close";
        assert!(find(&buf, expected).is_some(), "the hints {expected:?}");
    }

    #[rstest::rstest]
    fn page_is_the_list_boxs_row_count() {
        // Given two agents on a 140×30 screen.
        let sessions = two();

        // When drawing the picker.
        let (_, page) = draw(&picker(&sessions), &sessions, 140, 30);

        // Then the page is the 24-row float less its hint row, borders, input
        // and rule.
        assert_eq!(page, 19, "page size");
    }

    #[rstest::rstest]
    #[case::wide(160, 40)]
    #[case::stacked(100, 40)]
    fn hit_map_maps_a_list_row_to_its_index(#[case] width: u16, #[case] height: u16) {
        // Given the session picker over three agents.
        let sessions = three_agents();
        let picker = picker(&sessions);

        // When drawing it on a `width`×`height` screen.
        let (hits, cursor) = hits_of(&picker, &sessions, width, height);

        // Then the list's second row maps to shown row 1.
        assert_eq!(
            hits.picker_row_at(Position::new(cursor.x, cursor.y + 3)),
            Some(1),
            "the second list row should be shown row 1 at {width}×{height}"
        );
    }

    #[rstest::rstest]
    fn hit_map_maps_the_preview_to_nothing() {
        // Given the session picker over three agents.
        let sessions = three_agents();
        let picker = picker(&sessions);

        // When drawing it wide, the preview beside the list.
        let (hits, _) = hits_of(&picker, &sessions, 160, 40);

        // Then a point in the preview is on the popup but on no row.
        let at = Position::new(140, 20);
        assert_eq!(
            (hits.on_overlay(at), hits.picker_row_at(at)),
            (true, None),
            "the preview should be inside the popup and on no row"
        );
    }

    #[rstest::rstest]
    #[case::wide(160, 40, Position::new(140, 20))]
    #[case::stacked(100, 40, Position::new(50, 33))]
    fn hit_map_leaves_the_preview_out_of_the_wheels_area(
        #[case] width: u16,
        #[case] height: u16,
        #[case] preview: Position,
    ) {
        // Given the session picker over three agents.
        let sessions = three_agents();
        let picker = picker(&sessions);

        // When drawing it on a `width`×`height` screen.
        let (hits, cursor) = hits_of(&picker, &sessions, width, height);

        // Then the wheel's area holds the list's input but not the preview.
        assert_eq!(
            (hits.on_selector(cursor), hits.on_selector(preview)),
            (true, false),
            "the wheel should cover the list and not the preview at {width}×{height}"
        );
    }

    #[rstest::rstest]
    fn hit_map_maps_the_input_text_to_its_graphemes() {
        // Given the session picker over three agents with "on" typed.
        let sessions = three_agents();
        let mut picker = picker(&sessions);
        typed(&mut picker, &['o', 'n']);

        // When drawing it.
        let (hits, cursor) = hits_of(&picker, &sessions, 160, 40);

        // Then the column before the terminal cursor maps to "n".
        assert_eq!(
            hits.text_at(Position::new(cursor.x - 1, cursor.y)),
            Some(1),
            "the column before the cursor should be the last typed grapheme"
        );
    }
}
