//! The search picker, drawn in the session picker's snacks frame: a float
//! over the sidebar and the right side holding a list box and a preview box,
//! side by side from 120 columns and stacked below that.
//!
//! The list box is titled `Search`, with `indexing n/total` beside it while
//! orb is still indexing transcripts at startup. Its input row holds the
//! typed text and how many messages are listed, or `200+` when more matched,
//! over an orange rule. Each row is one matching message: its agent's dim
//! `<project>/` and bright title, then a dim one-line snippet of the
//! message with the matches lit. When the search index can't be opened, the
//! list says why instead.
//!
//! The preview box is titled with the selected row's label and shows its
//! agent's status, branch and model, then the exchange the message is in:
//! the prompt and every reply text block after it, each speaker named once.
//! The matching message is plain text with its matches lit, scrolled so the
//! first match sits about a third down; the rest render as Markdown. Until
//! the exchange is loaded it says `No transcript yet`. There are no key
//! hints.

use std::time::SystemTime;

use orb_domain::AppState;
use orb_domain::feat::harness::HarnessInfo;
use orb_domain::feat::picker::list::PickerItem;
use orb_domain::feat::picker::state::{PickerKind, PickerState};
use orb_domain::feat::search::state::SearchProgress;
use orb_domain::feat::sessions::transcript::Role;
use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Widget};
use unicode_segmentation::UnicodeSegmentation;

use crate::mouse::HitMap;
use crate::picker::{PickerScroll, highlight, span};
use crate::session_picker::{
    big, boxed, boxes, markdown, meta, render_input, reply_speaker, speaker, wrap_words,
};
use crate::sidebar::{
    BG_DARK, BLUE, BLUE1, COMMENT, CYAN, DARK3, DARK5, FG, ORANGE, RED, VISUAL, is_attached,
};

/// Draws the search picker over `area`: `picker`'s hit rows, with the
/// indexing progress and any index error from `state`, beside the selected
/// hit's preview (`state`'s agents give its status line, drawn at `now`).
/// Returns how many rows the list fits and where the terminal cursor goes in
/// the input. Records the popup, the list box as the wheel's area and the
/// list's rows in `hits`.
pub(crate) fn render(
    picker: &PickerState,
    state: &AppState,
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
    let [list_box, preview_box] = boxes(popup, area.width >= 120);
    hits.record_selector(list_box);
    let drawn = render_list(picker, &state.search, list_box, buf, scroll, hits);
    render_preview(picker, state, now, preview_box, buf);
    drawn
}

/// ` Search `, then a dim `indexing n/total ` while indexing runs.
fn title(search: &SearchProgress) -> Line<'static> {
    let mut spans = vec![span(" Search ", BLUE)];
    if search.indexed < search.total {
        spans.push(span(
            format!("indexing {}/{} ", search.indexed, search.total),
            DARK3,
        ));
    }
    Line::from(spans)
}

/// The list box: title, input row with the count, orange rule, then the
/// rows, or `search unavailable: <error>` in red when the index can't be
/// opened. Records each row in `hits`. Returns the rows' height and the
/// cursor.
fn render_list(
    picker: &PickerState,
    search: &SearchProgress,
    area: Rect,
    buf: &mut Buffer,
    scroll: &mut PickerScroll,
    hits: &mut HitMap,
) -> (usize, Position) {
    let block = boxed(Some(title(search)));
    let inner = block.inner(area);
    block.render(area, buf);
    let [input, rule, rows] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Fill(1),
    ])
    .areas(inner);
    let shown: Vec<&PickerItem> = picker.shown().map(|(item, _)| item).collect();
    let count = match picker.kind() {
        PickerKind::Search { overflow: true } => format!("{}+", picker.total()),
        _ => format!("{}/{}", shown.len(), picker.total()),
    };
    let cursor = render_input(picker, &count, input, buf, hits);
    Line::from(span("─".repeat(usize::from(rule.width)), ORANGE)).render(rule, buf);
    let page = usize::from(rows.height).max(1);
    if let Some(error) = &search.error {
        Line::from(span(format!("  search unavailable: {error}"), RED)).render(rows, buf);
        return (page, cursor);
    }
    let offset = scroll.follow(picker.selection(), shown.len(), page);
    for ((index, item), y) in shown
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
        render_row(item, row, buf);
    }
    (page, cursor)
}

/// One hit row: a space, its label with the `<project|group>/` prefix dim
/// and the title bright, a space, then the snippet in `COMMENT` with its
/// matches lit. Clipped one column short of the row's right edge.
fn render_row(item: &PickerItem, area: Rect, buf: &mut Buffer) {
    let PickerItem::Hit {
        label,
        split,
        snippet,
        lit,
        ..
    } = item
    else {
        return;
    };
    let line: Line = std::iter::once(Span::raw(" "))
        .chain(highlight(
            label,
            &[],
            |at| if at < *split { DARK5 } else { FG },
        ))
        .chain(std::iter::once(Span::raw(" ")))
        .chain(highlight(snippet, lit, |_| COMMENT))
        .collect();
    line.render(
        Rect {
            width: area.width.saturating_sub(1),
            ..area
        },
        buf,
    );
}

/// The preview box: untitled and empty with no hit selected, else titled
/// with the hit's label, holding its agent's status line, a blank line, then
/// the hit's exchange scrolled so its first match sits about a third down,
/// or ` No transcript yet` until the exchange is loaded.
fn render_preview(
    picker: &PickerState,
    state: &AppState,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
) {
    let Some(PickerItem::Hit {
        id,
        agent,
        label,
        text_lit,
        ..
    }) = picker.selected()
    else {
        boxed(None).render(area, buf);
        return;
    };
    let block = boxed(Some(Line::from(span(format!(" {label} "), BLUE))));
    let inner = block.inner(area);
    block.render(area, buf);
    let found = state.sessions.all_agents().find(|found| found.id == *agent);
    let info = found.and_then(|found| state.harness_info(&found.harness));
    let status = found.map_or_else(Line::default, |found| {
        meta(found, info, is_attached(&state.attached, found), now)
    });
    let width = usize::from(inner.width).saturating_sub(1);
    let (body, focus) = match picker.search_preview() {
        Some(preview) => exchange_lines(&preview.messages, info, *id, text_lit, width, now),
        None => (vec![Line::from(span(" No transcript yet", COMMENT))], 0),
    };
    let skip = {
        let room = usize::from(inner.height).saturating_sub(2);
        focus
            .saturating_sub(room / 3)
            .min(body.len().saturating_sub(room))
    };
    let lines = [status, Line::default()]
        .into_iter()
        .chain(body.into_iter().skip(skip));
    for (line, y) in lines.zip(inner.top()..inner.bottom()) {
        line.render(Rect::new(inner.x, y, inner.width, 1), buf);
    }
}

/// `messages` as lines `width` wide, a speaker header (`You`, or the
/// harness's (`info`'s) mark and name) wherever the speaker changes, with a
/// blank line before each header but the first. Message `hit` is plain text
/// with the graphemes at byte offsets `lit` lit; the rest are Markdown.
/// Returns the lines and the index of the first lit line, or of the hit's
/// first line when nothing is lit.
fn exchange_lines(
    messages: &[(i64, Role, String)],
    info: Option<&HarnessInfo>,
    hit: i64,
    lit: &[usize],
    width: usize,
    now: SystemTime,
) -> (Vec<Line<'static>>, usize) {
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut focus = 0;
    let mut last: Option<Role> = None;
    for (id, role, text) in messages {
        if last != Some(*role) {
            if last.is_some() {
                lines.push(Line::default());
            }
            lines.push(match role {
                Role::User => speaker("", "You", CYAN, None, now, width),
                Role::Assistant => reply_speaker(info, None, now, width),
            });
            last = Some(*role);
        }
        if *id != hit {
            lines.extend(markdown(text, width, "   ", Style::new().fg(FG)));
            continue;
        }
        let body = lit_text(text, lit, width);
        focus = lines.len()
            + body
                .iter()
                .position(|line| line.spans.iter().any(|span| span.style.fg == Some(BLUE1)))
                .unwrap_or(0);
        lines.extend(body);
    }
    (lines, focus)
}

/// `text` as plain `FG` lines `width` wide behind three spaces, each of its
/// lines wrapped on its own and blank lines collapsed to one, with the
/// graphemes at byte offsets `lit` lit.
fn lit_text(text: &str, lit: &[usize], width: usize) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut words: Vec<Vec<Span<'static>>> = Vec::new();
    let mut word = (0, String::new());
    let pad = || [Span::raw("   ")];
    let end_word = |words: &mut Vec<Vec<Span<'static>>>, (start, text): &mut (usize, String)| {
        if text.is_empty() {
            return;
        }
        let offsets: Vec<usize> = lit
            .iter()
            .filter(|&&at| (*start..*start + text.len()).contains(&at))
            .map(|at| at - *start)
            .collect();
        words.push(highlight(text, &offsets, |_| FG));
        text.clear();
    };
    let end_line = |out: &mut Vec<Line<'static>>, words: &mut Vec<Vec<Span<'static>>>| match (
        words.is_empty(),
        out.last(),
    ) {
        (false, _) => out.extend(wrap_words(std::mem::take(words), width, &pad(), &pad())),
        (true, Some(line)) if line.width() > 0 => out.push(Line::default()),
        (true, _) => {}
    };
    for (at, grapheme) in text.grapheme_indices(true) {
        if !grapheme.trim().is_empty() {
            if word.1.is_empty() {
                word.0 = at;
            }
            word.1.push_str(grapheme);
            continue;
        }
        end_word(&mut words, &mut word);
        if grapheme.contains('\n') {
            end_line(&mut out, &mut words);
        }
    }
    end_word(&mut words, &mut word);
    end_line(&mut out, &mut words);
    while out.last().is_some_and(|line| line.width() == 0) {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use orb_domain::feat::harness::HarnessId;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use orb_domain::feat::picker::list::PickerItem;
    use orb_domain::feat::picker::state::PickerState;
    use orb_domain::feat::search::state::SearchProgress;
    use orb_domain::feat::sessions::state::{Agent, AgentStatus, Project, ProjectKind, Sessions};
    use orb_domain::feat::sessions::transcript::Role;
    use orb_domain::ids::{AgentId, ProjectId};
    use orb_domain::{AppState, Focus};
    use ratatui::buffer::{Buffer, Cell};
    use ratatui::layout::Rect;
    use ratatui::style::Modifier;
    use unicode_segmentation::UnicodeSegmentation;

    use super::render;
    use crate::mouse::HitMap;
    use crate::picker::PickerScroll;
    use crate::sidebar::{BLUE1, COMMENT, DARK5, FG};

    /// A hit in agent 1 labelled `label` (title from `split`) with
    /// `snippet`, `lit` its lit byte offsets.
    fn hit(label: &str, split: usize, snippet: &str, lit: Vec<usize>) -> PickerItem {
        PickerItem::Hit {
            id: 1,
            agent: AgentId(1),
            label: label.to_owned(),
            split,
            snippet: snippet.to_owned(),
            lit,
            text_lit: vec![],
            path: PathBuf::from("/t/1.jsonl"),
            prompt_offset: 0,
        }
    }

    /// The `orb/fix the bug` hit whose snippet `the parser drops lines`
    /// lights `parser`.
    fn parser_hit() -> PickerItem {
        hit(
            "orb/fix the bug",
            4,
            "the parser drops lines",
            (4..10).collect(),
        )
    }

    /// A fixed clock.
    fn now() -> SystemTime {
        UNIX_EPOCH + Duration::from_hours(240)
    }

    /// Hit `id` in agent 1, labelled `orb/fix the bug`, with `snippet` and
    /// `text_lit` its lit byte offsets into the whole message.
    fn hit_with(id: i64, text_lit: Vec<usize>, snippet: &str) -> PickerItem {
        PickerItem::Hit {
            id,
            agent: AgentId(1),
            label: "orb/fix the bug".to_owned(),
            split: 4,
            snippet: snippet.to_owned(),
            lit: vec![],
            text_lit,
            path: PathBuf::from("/t/1.jsonl"),
            prompt_offset: 0,
        }
    }

    /// A search picker over hit `id` (lighting `text_lit`) alone, its
    /// exchange loaded as `messages`.
    fn previewing(
        id: i64,
        text_lit: Vec<usize>,
        messages: Vec<(i64, Role, String)>,
    ) -> PickerState {
        let mut picker = searching(vec![hit_with(id, text_lit, "x")], false);
        picker.show_search_preview(id, messages);
        picker
    }

    /// The `where does it break` / `the parser drops lines` exchange.
    fn reply_exchange() -> Vec<(i64, Role, String)> {
        vec![
            (1, Role::User, "where does it break".to_owned()),
            (2, Role::Assistant, "the parser drops lines".to_owned()),
        ]
    }

    /// The `where is the parser` / `in the lexer` exchange.
    fn prompt_exchange() -> Vec<(i64, Role, String)> {
        vec![
            (1, Role::User, "where is the parser".to_owned()),
            (2, Role::Assistant, "in the lexer".to_owned()),
        ]
    }

    /// The screen row where `text` first shows.
    fn row_of(buf: &Buffer, text: &str) -> Option<usize> {
        screen(buf).lines().position(|line| line.contains(text))
    }

    /// A search picker listing `items`, as the actor writes them.
    fn searching(items: Vec<PickerItem>, overflow: bool) -> PickerState {
        let mut picker = PickerState::search(Focus::Sidebar);
        picker.show_hits("", items, overflow);
        picker
    }

    /// App state whose search index reports `search`.
    fn app(search: SearchProgress) -> AppState {
        AppState {
            search,
            ..AppState::default()
        }
    }

    /// Draws `picker` over a 100×40 screen, stacked, with `app`'s progress.
    fn draw(picker: &PickerState, app: &AppState) -> Buffer {
        let mut buf = Buffer::empty(Rect::new(0, 0, 100, 40));
        render(
            picker,
            app,
            now(),
            buf.area,
            &mut buf,
            &mut PickerScroll::default(),
            &mut HitMap::default(),
        );
        buf
    }

    /// The screen's text, one line per row.
    fn screen(buf: &Buffer) -> String {
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .filter_map(|x| buf.cell((x, y)).map(Cell::symbol))
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The cell where `text` first starts, row by row.
    fn find<'a>(buf: &'a Buffer, text: &str) -> Option<&'a Cell> {
        let len = text.graphemes(true).count();
        (0..buf.area.height).find_map(|y| {
            let row: Vec<&str> = (0..buf.area.width)
                .filter_map(|x| buf.cell((x, y)).map(Cell::symbol))
                .collect();
            let x = (0..row.len()).find(|&x| {
                row.get(x..x + len)
                    .is_some_and(|cells| cells.concat() == text)
            })?;
            buf.cell((x as u16, y))
        })
    }

    #[rstest::rstest]
    fn hit_row_reads_its_label_then_its_snippet() {
        // Given a search picker over one hit.
        let picker = searching(vec![parser_hit()], false);

        // When drawing it.
        let buf = draw(&picker, &AppState::default());

        // Then the row reads the label, a space, then the snippet.
        let screen = screen(&buf);
        assert!(
            screen.contains("orb/fix the bug the parser drops lines"),
            "screen was\n{screen}"
        );
    }

    #[rstest::rstest]
    fn hit_row_dims_its_label_prefix() {
        // Given a search picker over one hit labelled `orb/fix the bug`.
        let picker = searching(vec![parser_hit()], false);

        // When drawing it.
        let buf = draw(&picker, &AppState::default());

        // Then `orb/` is dim and the title bright.
        let colors = (
            find(&buf, "orb/").map(|cell| cell.fg),
            find(&buf, "fix the bug").map(|cell| cell.fg),
        );
        assert_eq!(colors, (Some(DARK5), Some(FG)), "prefix and title colors");
    }

    #[rstest::rstest]
    fn hit_row_lights_the_snippets_matches() {
        // Given a hit whose snippet lights `parser`.
        let picker = searching(vec![parser_hit()], false);

        // When drawing it.
        let buf = draw(&picker, &AppState::default());

        // Then `parser` is lit blue and bold, and `drops` stays dim.
        let lit =
            find(&buf, "parser").map(|cell| (cell.fg, cell.modifier.contains(Modifier::BOLD)));
        let unlit = find(&buf, "drops").map(|cell| cell.fg);
        assert_eq!(
            (lit, unlit),
            (Some((BLUE1, true)), Some(COMMENT)),
            "lit and unlit snippet graphemes"
        );
    }

    #[rstest::rstest]
    fn list_title_shows_indexing_progress_while_indexing() {
        // Given one of three transcripts indexed.
        let app = app(SearchProgress {
            indexed: 1,
            total: 3,
            error: None,
        });

        // When drawing the search picker.
        let buf = draw(&searching(vec![], false), &app);

        // Then the list title shows the progress.
        let screen = screen(&buf);
        assert!(
            screen.contains(" Search indexing 1/3 "),
            "screen was\n{screen}"
        );
    }

    #[rstest::rstest]
    fn list_title_drops_the_progress_once_indexed() {
        // Given every transcript indexed.
        let app = app(SearchProgress {
            indexed: 3,
            total: 3,
            error: None,
        });

        // When drawing the search picker.
        let buf = draw(&searching(vec![], false), &app);

        // Then no indexing progress shows.
        let screen = screen(&buf);
        assert!(!screen.contains("indexing"), "screen was\n{screen}");
    }

    #[rstest::rstest]
    fn overflowing_results_count_as_200_plus() {
        // Given 200 hits with more matched.
        let hits = std::iter::repeat_with(parser_hit).take(200).collect();
        let picker = searching(hits, true);

        // When drawing it.
        let buf = draw(&picker, &AppState::default());

        // Then the count reads `200+`.
        let screen = screen(&buf);
        assert!(screen.contains("200+"), "screen was\n{screen}");
    }

    #[rstest::rstest]
    fn index_error_shows_search_unavailable_in_the_list() {
        // Given a search index that couldn't be opened.
        let app = app(SearchProgress {
            error: Some("no fts5".to_owned()),
            ..SearchProgress::default()
        });

        // When drawing the search picker.
        let buf = draw(&searching(vec![], false), &app);

        // Then the list says why search is unavailable.
        let screen = screen(&buf);
        assert!(
            screen.contains("search unavailable: no fts5"),
            "screen was\n{screen}"
        );
    }

    #[rstest::rstest]
    fn reply_hit_preview_shows_the_prompt_above_the_reply() {
        // Given a hit in a reply, its exchange loaded.
        let picker = previewing(2, vec![], reply_exchange());

        // When drawing it.
        let buf = draw(&picker, &AppState::default());

        // Then the prompt sits above the reply.
        let rows = (
            row_of(&buf, "where does it break"),
            row_of(&buf, "the parser drops lines"),
        );
        assert!(
            matches!(rows, (Some(prompt), Some(reply)) if prompt < reply),
            "prompt and reply rows were {rows:?}, screen\n{}",
            screen(&buf)
        );
    }

    #[rstest::rstest]
    fn reply_hit_preview_lights_the_hit_in_the_reply() {
        // Given a hit on `parser` in a reply, its exchange loaded.
        let picker = previewing(2, (4..10).collect(), reply_exchange());

        // When drawing it.
        let buf = draw(&picker, &AppState::default());

        // Then `parser` is lit blue and bold.
        let lit =
            find(&buf, "parser").map(|cell| (cell.fg, cell.modifier.contains(Modifier::BOLD)));
        assert_eq!(lit, Some((BLUE1, true)), "lit reply grapheme");
    }

    #[rstest::rstest]
    fn long_reply_hit_preview_scrolls_the_first_match_into_view() {
        // Given a hit on `needle` on line 50 of a 60-line reply.
        let reply = (1..=60)
            .map(|n| match n {
                50 => "line 50 needle".to_owned(),
                _ => format!("line {n}"),
            })
            .collect::<Vec<_>>()
            .join("\n");
        let at = reply.find("needle").unwrap_or(usize::MAX);
        let picker = previewing(
            2,
            (at..at + 6).collect(),
            vec![
                (1, Role::User, "where does it break".to_owned()),
                (2, Role::Assistant, reply),
            ],
        );

        // When drawing it at 100×40.
        let buf = draw(&picker, &AppState::default());

        // Then `needle` shows, lit.
        assert_eq!(
            find(&buf, "needle").map(|cell| cell.fg),
            Some(BLUE1),
            "screen was\n{}",
            screen(&buf)
        );
    }

    #[rstest::rstest]
    fn prompt_hit_preview_lights_the_hit_in_the_prompt() {
        // Given a hit on `parser` in a prompt, its exchange loaded.
        let picker = previewing(1, (13..19).collect(), prompt_exchange());

        // When drawing it.
        let buf = draw(&picker, &AppState::default());

        // Then `parser` is lit blue and bold.
        let lit =
            find(&buf, "parser").map(|cell| (cell.fg, cell.modifier.contains(Modifier::BOLD)));
        assert_eq!(lit, Some((BLUE1, true)), "lit prompt grapheme");
    }

    #[rstest::rstest]
    fn prompt_hit_preview_shows_the_replies_after_the_prompt() {
        // Given a hit in a prompt, its exchange loaded.
        let picker = previewing(1, vec![], prompt_exchange());

        // When drawing it.
        let buf = draw(&picker, &AppState::default());

        // Then the reply sits below the prompt.
        let rows = (row_of(&buf, "where is the"), row_of(&buf, "in the lexer"));
        assert!(
            matches!(rows, (Some(prompt), Some(reply)) if prompt < reply),
            "prompt and reply rows were {rows:?}, screen\n{}",
            screen(&buf)
        );
    }

    #[rstest::rstest]
    fn hit_without_a_loaded_preview_says_no_transcript_yet() {
        // Given a hit whose exchange isn't loaded.
        let picker = searching(vec![parser_hit()], false);

        // When drawing it.
        let buf = draw(&picker, &AppState::default());

        // Then the preview says there's no transcript yet.
        let screen = screen(&buf);
        assert!(screen.contains("No transcript yet"), "screen was\n{screen}");
    }

    #[rstest::rstest]
    fn preview_starts_with_the_agents_branch_and_model() {
        // Given agent 1 on `fix-parser` with `opus`, and its hit's exchange
        // loaded.
        let picker = previewing(1, vec![], prompt_exchange());
        let app = AppState {
            sessions: Sessions {
                projects: vec![Project {
                    id: ProjectId(1),
                    title: "orb".to_owned(),
                    root: "/Users/me/dev/orb".into(),
                    created_at: UNIX_EPOCH,
                    removed: false,
                    repo: true,
                    agents: vec![Agent {
                        last_session: None,
                        harness: HarnessId::new("claude"),
                        id: AgentId(1),
                        title: Some("fix the bug".to_owned()),
                        cwd: "/Users/me/dev/orb".into(),
                        transcript: None,
                        status: AgentStatus::Idle,
                        turn_started_at: None,
                        pane: None,
                        branch: Some("fix-parser".to_owned()),
                        created_at: UNIX_EPOCH,
                        last_activity_at: UNIX_EPOCH,
                        unseen: false,
                        model: Some("opus".to_owned()),
                    }],
                    kind: ProjectKind::Normal,
                }],
                ..Sessions::default()
            },
            ..AppState::default()
        };

        // When drawing it.
        let buf = draw(&picker, &app);

        // Then the preview shows the agent's branch and model.
        let screen = screen(&buf);
        assert!(
            screen.contains("fix-parser") && screen.contains("opus"),
            "screen was\n{screen}"
        );
    }

    #[rstest::rstest]
    fn non_hit_messages_render_markdown() {
        // Given a hit in the prompt and a reply in Markdown bold.
        let picker = previewing(
            1,
            vec![],
            vec![
                (1, Role::User, "where is it".to_owned()),
                (2, Role::Assistant, "**bold** words".to_owned()),
            ],
        );

        // When drawing it.
        let buf = draw(&picker, &AppState::default());

        // Then the reply reads without its Markdown markers.
        let screen = screen(&buf);
        assert!(
            screen.contains("bold words") && !screen.contains("**"),
            "screen was\n{screen}"
        );
    }
}
