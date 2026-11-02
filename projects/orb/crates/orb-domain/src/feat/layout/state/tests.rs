use std::collections::HashSet;

use ratatui::layout::Rect;

use super::{FocusMove, Layouts, Placed, Placement, SessionLayout, Tab, test_entry as entry};
use crate::feat::harness::HarnessId;
use crate::feat::layout::floats::{Float, FloatLayout, FloatRect, Floats};
use crate::feat::layout::tree::{NavDirection, Node, Split, SwapLayout, TileLayout};
use crate::feat::sessions::state::{Agent, AgentStatus};
use crate::feat::sessions::test_ids::{pane, session};
use crate::ids::{AgentId, PaneId, SessionId};
use std::time::UNIX_EPOCH;

const OWNER: SessionId = SessionId(1);
const BODY: Rect = Rect::new(0, 0, 80, 24);

/// Session 1's layout of pane 7, measured against an 80×24 body.
fn opened() -> Layouts {
    let mut layouts = Layouts::default();
    layouts.insert(OWNER, SessionLayout::of(entry(7)));
    layouts.fit_to(BODY);
    layouts
}

/// Session 1's layout split right once: pane 7 on the left, pane 8 on
/// the right and focused.
fn split_right() -> Layouts {
    let mut layouts = opened();
    layouts.split(OWNER, Split::Right, entry(8));
    layouts
}

/// The width the tests' stack lists ask for.
const LIST_WIDTH: u16 = 20;

fn placement(layouts: &Layouts) -> Placement {
    placement_with(layouts, LIST_WIDTH)
}

fn placement_with(layouts: &Layouts, list_width: u16) -> Placement {
    layouts
        .get(OWNER)
        .map(|layout| layout.placed(BODY, |_| list_width))
        .unwrap_or_default()
}

fn placed(layouts: &Layouts) -> Vec<Placed> {
    placement(layouts).panes
}

fn focused(layouts: &Layouts) -> Option<PaneId> {
    layouts.get(OWNER)?.focused()
}

fn active(layouts: &Layouts) -> Option<usize> {
    layouts.get(OWNER).map(SessionLayout::active)
}

fn tab_count(layouts: &Layouts) -> usize {
    layouts.get(OWNER).map_or(0, |layout| layout.tabs().len())
}

/// Session 1's layout with three tabs (panes 7, 8, 9), the first shown.
fn three_tabs() -> Layouts {
    let mut layouts = opened();
    layouts.new_tab(OWNER, entry(8));
    layouts.new_tab(OWNER, entry(9));
    layouts.go_to_tab(OWNER, 1);
    layouts
}

#[rstest::rstest]
fn move_session_points_every_pane_at_the_dir() {
    // Given session 1's layout of panes 7 and 8 in /work.
    let mut layouts = split_right();

    // When moving the session to /wt.
    layouts.move_session(OWNER, std::path::Path::new("/wt"));

    // Then both panes start in /wt.
    let cwds: Vec<_> = [7, 8]
        .into_iter()
        .filter_map(|id| layouts.entry(PaneId(id)).map(|entry| entry.cwd.clone()))
        .collect();
    assert_eq!(
        cwds,
        vec![std::path::PathBuf::from("/wt"); 2],
        "every pane should start in the new directory"
    );
}

#[rstest::rstest]
fn layout_of_a_pane_is_one_tab_of_it() {
    // Given no layouts.
    let mut layouts = Layouts::default();

    // When putting in session 1's layout of pane 7.
    layouts.insert(OWNER, SessionLayout::of(entry(7)));

    // Then it has one tab focused on pane 7.
    assert_eq!(
        (tab_count(&layouts), focused(&layouts)),
        (1, Some(PaneId(7))),
        "a new layout is one tab of its pane"
    );
}

#[rstest::rstest]
fn split_takes_the_given_pane_and_focuses_it() {
    // Given a layout of pane 7.
    let mut layouts = opened();

    // When splitting it right with pane 8.
    layouts.split(OWNER, Split::Right, entry(8));

    // Then pane 8 is placed beside it and focused.
    let panes: Vec<(PaneId, bool)> = placed(&layouts)
        .iter()
        .map(|place| (place.pane, place.focused))
        .collect();
    assert_eq!(
        panes,
        vec![(PaneId(7), false), (PaneId(8), true)],
        "the given pane joins the tab with the focus"
    );
}

#[rstest::rstest]
fn new_tab_takes_the_given_pane() {
    // Given a layout of pane 7.
    let mut layouts = opened();

    // When opening a tab of pane 8.
    layouts.new_tab(OWNER, entry(8));

    // Then pane 8's entry is there.
    assert_eq!(
        layouts.entry(PaneId(8)),
        Some(&entry(8)),
        "a new tab's pane says where it runs"
    );
}

#[rstest::rstest]
fn closing_a_pane_drops_its_entry() {
    // Given two panes side by side.
    let mut layouts = split_right();

    // When closing pane 8.
    layouts.close_pane(PaneId(8));

    // Then nothing says where pane 8 runs.
    assert_eq!(layouts.entry(PaneId(8)), None, "a closed pane has no entry");
}

#[rstest::rstest]
fn restored_tab_keeps_its_name_tree_and_focus() {
    // Given a saved tab named "logs" of panes 7 and 8, focused on 7.
    let tree = {
        let mut tree = TileLayout::new(PaneId(7));
        tree.split_focused(Split::Right, PaneId(8));
        tree.focus_pane(PaneId(7));
        tree
    };

    // When restoring it.
    let tab = Tab::restore(
        Some("logs".into()),
        tree.clone(),
        SwapLayout::Vertical,
        false,
    );

    // Then it has that name, tree and focus.
    assert_eq!(
        (tab.name(), tab.layout_json(), tab.focused()),
        (Some("logs"), tree.to_json(), PaneId(7)),
        "a restored tab is the saved one"
    );
}

#[rstest::rstest]
fn restore_keeps_float_entries() {
    // Given a saved tab of pane 7 and a saved float of pane 20.
    let floats = Floats::restore(
        vec![Float {
            pane: PaneId(20),
            rect: FloatRect {
                x: 0.25,
                y: 0.25,
                width: 0.5,
                height: 0.5,
            },
            pinned: false,
        }],
        FloatLayout::Staggered,
        false,
    );

    // When restoring the session.
    let mut layouts = Layouts::default();
    layouts.insert(
        OWNER,
        SessionLayout::restore(
            vec![Tab::restore(
                None,
                TileLayout::new(PaneId(7)),
                SwapLayout::Vertical,
                false,
            )],
            0,
            vec![entry(7), entry(20)],
            floats,
        ),
    );

    // Then the float's pane still has its entry.
    assert!(
        layouts.entry(PaneId(20)).is_some(),
        "a restored float keeps where its pane runs"
    );
}

#[rstest::rstest]
fn split_clears_the_zoom() {
    // Given a zoomed two-pane tab.
    let mut layouts = split_right();
    layouts.toggle_zoom(OWNER);

    // When splitting again.
    layouts.split(OWNER, Split::Down, entry(9));

    // Then the tab isn't zoomed.
    assert_eq!(
        placed(&layouts).len(),
        3,
        "a split should show every pane again"
    );
}

/// Session 1's layout of panes 7 to `last`, each added with `add_tiled`.
fn tiled(last: i64) -> Layouts {
    let mut layouts = opened();
    for id in 8..=last {
        layouts.add_tiled(OWNER, entry(id));
    }
    layouts
}

/// How many panes each column holds, left to right, a stack counting
/// every pane in it.
fn shape(layouts: &Layouts) -> Vec<usize> {
    let placement = placement(layouts);
    let mut columns: Vec<(u16, usize)> = Vec::new();
    for place in &placement.panes {
        let count = placement
            .stacks
            .iter()
            .find(|stack| stack.shown == place.pane)
            .map_or(1, |stack| stack.panes.len());
        match columns.last_mut() {
            Some((x, n)) if *x == place.area.x => *n += count,
            _ => columns.push((place.area.x, count)),
        }
    }
    columns.into_iter().map(|(_, n)| n).collect()
}

#[rstest::rstest]
fn closing_a_pane_re_tiles_the_tab() {
    // Given seven tiled panes, laid out [1][4][2].
    let mut layouts = tiled(13);

    // When closing pane 9.
    layouts.close_pane(PaneId(9));

    // Then the six left are laid out [2][4].
    assert_eq!(shape(&layouts), vec![2, 4], "six panes re-tile to [2][4]");
}

#[rstest::rstest]
#[case(8, vec![1])]
#[case(9, vec![1, 1])]
#[case(12, vec![1, 4])]
#[case(13, vec![2, 4])]
#[case(14, vec![1, 4, 2])]
#[case(16, vec![1, 4, 4])]
#[case(17, vec![10])]
#[case(18, vec![11])]
#[case(19, vec![12])]
fn closing_any_pane_re_tiles_to_the_template_for_one_fewer(
    #[case] last: i64,
    #[case] expected: Vec<usize>,
) {
    // Given panes 7 to `last` tiled.
    let tab = || tiled(last);

    // When closing each pane in turn, on its own copy of the tab.
    let shapes: Vec<Vec<usize>> = (7..=last)
        .map(|closed| {
            let mut layouts = tab();
            layouts.close_pane(PaneId(closed));
            shape(&layouts)
        })
        .collect();

    // Then every close leaves the template shape for the new count.
    assert!(
        shapes.iter().all(|shape| *shape == expected),
        "closing any of panes 7..={last} should give {expected:?}, got {shapes:?}"
    );
}

/// The stacked pane shown below the stack's list.
fn expanded(layouts: &Layouts) -> Option<PaneId> {
    placement(layouts)
        .stacks
        .into_iter()
        .next()
        .map(|stack| stack.shown)
}

/// Session 1's one tab, changed by hand: panes 301, 302 and 303 stacked
/// on the top half with pane `300 + shown` shown, over pane 304 on the
/// bottom half, which has the focus.
fn stack_over_pane(shown: i64) -> Layouts {
    stack_over_pane_in(shown, 0.5, BODY)
}

/// [`stack_over_pane`], the stack taking `ratio` of `body`.
fn stack_over_pane_in(shown: i64, ratio: f32, body: Rect) -> Layouts {
    let tree = TileLayout::from_saved(
        Node::Split {
            split: Split::Down,
            ratio,
            first: Box::new(Node::Stack {
                panes: vec![pane(1), pane(2), pane(3)],
                expanded: pane(shown),
            }),
            second: Box::new(Node::Pane(pane(4))),
        },
        pane(4),
    );
    let mut layouts = Layouts::default();
    layouts.insert(
        OWNER,
        SessionLayout::restore(
            vec![Tab::restore(None, tree, SwapLayout::Base, true)],
            0,
            (1..=4).map(|n| entry(pane(n).0)).collect(),
            Floats::default(),
        ),
    );
    layouts.fit_to(body);
    layouts
}

#[rstest::rstest]
#[case::first(1)]
#[case::middle(2)]
#[case::last(3)]
fn up_from_below_a_stack_lands_on_its_shown_pane(#[case] shown: i64) {
    // Given panes 301, 302 and 303 stacked over pane 304, pane `300 + shown`
    // shown and pane 304 focused.
    let mut layouts = stack_over_pane(shown);

    // When moving the focus up.
    layouts.move_focus(OWNER, NavDirection::Up);

    // Then the stack's shown pane, drawn right above pane 304, has the focus.
    assert_eq!(
        focused(&layouts),
        Some(pane(shown)),
        "moving up from below a stack should land on the pane it shows"
    );
}

#[rstest::rstest]
#[case::no_rows(0.1, 4)]
#[case::one_row(0.25, 3)]
fn up_from_below_a_stack_under_two_rows_lands_on_its_shown_pane(
    #[case] ratio: f32,
    #[case] height: u16,
) {
    // Given panes 301, 302 and 303 stacked over pane 304 in a body so short
    // the stack gets under two rows, pane 302 shown and pane 304 focused.
    let mut layouts = stack_over_pane_in(2, ratio, Rect::new(0, 0, 80, height));

    // When moving the focus up.
    layouts.move_focus(OWNER, NavDirection::Up);

    // Then the stack's shown pane has the focus.
    assert_eq!(
        focused(&layouts),
        Some(pane(2)),
        "moving up from below a short stack should land on the pane it shows"
    );
}

#[rstest::rstest]
fn split_in_a_stacked_tab_splits_the_whole_stack() {
    // Given eleven tiled panes, one stack.
    let mut layouts = tiled(17);

    // When splitting the focused pane right with pane 18.
    layouts.split(OWNER, Split::Right, entry(18));

    // Then the stack of eleven stays whole and pane 18 takes the right half.
    let stack_sizes: Vec<usize> = stacked(&layouts).iter().map(Vec::len).collect();
    assert_eq!(
        (stack_sizes, area(&layouts, 18)),
        (vec![11], Some(Rect::new(40, 0, 40, 24))),
        "a split in a stacked tab should split the whole stack"
    );
}

#[rstest::rstest]
fn split_in_a_stacked_tab_focuses_the_new_pane() {
    // Given eleven tiled panes with pane 12 focused.
    let mut layouts = tiled(17);
    layouts.focus_pane(OWNER, PaneId(12));

    // When splitting the focused pane right with pane 18.
    layouts.split(OWNER, Split::Right, entry(18));

    // Then pane 18 has the focus.
    assert_eq!(
        focused(&layouts),
        Some(PaneId(18)),
        "the split's new pane should be focused"
    );
}

#[rstest::rstest]
fn move_focus_down_in_a_stack_expands_the_pane_below() {
    // Given eleven tiled panes with the stacked pane 12 focused.
    let mut layouts = tiled(17);
    layouts.focus_pane(OWNER, PaneId(12));

    // When moving the focus down.
    layouts.move_focus(OWNER, NavDirection::Down);

    // Then pane 13 is focused and expanded.
    assert_eq!(
        (focused(&layouts), expanded(&layouts)),
        (Some(PaneId(13)), Some(PaneId(13))),
        "the pane below should take the focus and the rows"
    );
}

#[rstest::rstest]
#[case::up(NavDirection::Up, 1)]
#[case::down(NavDirection::Down, 3)]
fn up_and_down_inside_the_focused_stack_step_in_list_order(
    #[case] nav: NavDirection,
    #[case] expected: i64,
) {
    // Given panes 301, 302 and 303 stacked over pane 304, pane 302 shown
    // and focused.
    let mut layouts = stack_over_pane(2);
    layouts.focus_pane(OWNER, pane(2));

    // When moving the focus `nav`.
    layouts.move_focus(OWNER, nav);

    // Then the stacked pane next to 302 in the list has the focus.
    assert_eq!(
        focused(&layouts),
        Some(pane(expected)),
        "a move inside the focused stack should step through its list in order"
    );
}

#[rstest::rstest]
fn focus_moving_to_the_main_pane_keeps_the_stack_expanded() {
    // Given eleven tiled panes with the stacked pane 12 focused.
    let mut layouts = tiled(17);
    layouts.focus_pane(OWNER, PaneId(12));

    // When moving the focus left to the main pane.
    layouts.move_focus(OWNER, NavDirection::Left);

    // Then pane 12 stays expanded.
    assert_eq!(
        expanded(&layouts),
        Some(PaneId(12)),
        "leaving the stack should keep its expanded pane"
    );
}

#[rstest::rstest]
fn closing_a_pane_keeps_the_stack_expanded() {
    // Given twelve tiled panes, pane 12 expanded and the main pane focused.
    let mut layouts = tiled(18);
    layouts.focus_pane(OWNER, PaneId(12));
    layouts.move_focus(OWNER, NavDirection::Left);

    // When closing the stacked pane 15.
    layouts.close_pane(PaneId(15));

    // Then the re-tiled stack still expands pane 12.
    assert_eq!(
        expanded(&layouts),
        Some(PaneId(12)),
        "re-tiling should keep the expanded pane"
    );
}

#[rstest::rstest]
fn reveal_shows_and_focuses_the_pane_in_its_tab() {
    // Given panes 7 and 8 split in tab 1, pane 8 focused, and tab 2 shown.
    let mut layouts = split_right();
    layouts.new_tab(OWNER, entry(9));

    // When revealing pane 7.
    layouts.reveal(OWNER, PaneId(7));

    // Then tab 1 is shown with pane 7 focused.
    assert_eq!(
        (active(&layouts), focused(&layouts)),
        (Some(0), Some(PaneId(7))),
        "reveal should show the pane's tab and focus it"
    );
}

#[rstest::rstest]
fn reveal_expands_a_stacked_pane() {
    // Given eleven tiled panes with pane 17 expanded in the stack.
    let mut layouts = tiled(17);

    // When revealing the collapsed pane 12.
    layouts.reveal(OWNER, PaneId(12));

    // Then pane 12 is the stack's shown pane.
    assert_eq!(
        expanded(&layouts),
        Some(PaneId(12)),
        "reveal should expand a stacked pane"
    );
}

#[rstest::rstest]
fn stack_list_is_centred_at_the_top_of_the_stack() {
    // Given eleven tiled panes, one stack over the whole body.
    let layouts = tiled(17);

    // When placing them with a 20-column list.
    let list = placement(&layouts)
        .stacks
        .into_iter()
        .next()
        .map(|stack| stack.area);

    // Then the list takes the body's top eleven rows, 20 columns wide and centred.
    assert_eq!(
        list,
        Some(Rect::new(30, 0, 20, 11)),
        "the list is a centred row per pane on top"
    );
}

#[rstest::rstest]
#[case(0, 3)]
#[case(1, 3)]
#[case(200, 76)]
fn stack_list_width_stays_between_three_and_the_stack(
    #[case] list_width: u16,
    #[case] expected: u16,
) {
    // Given eleven tiled panes, one stack 80 columns wide.
    let layouts = tiled(17);

    // When placing them with a list `list_width` wide.
    let width = placement_with(&layouts, list_width)
        .stacks
        .into_iter()
        .next()
        .map(|stack| stack.area.width);

    // Then the list is clamped to fit two bars and a column, and the
    // stack with room for the `>` beside it.
    assert_eq!(width, Some(expected), "list width for {list_width}");
}

#[rstest::rstest]
fn stack_list_rows_sit_between_the_bars() {
    // Given eleven tiled panes, one stack over the whole body.
    let layouts = tiled(17);

    // When placing them with a 20-column list.
    let first = placement(&layouts)
        .stacks
        .into_iter()
        .next()
        .and_then(|stack| stack.rows.first().map(|(_, row)| *row));

    // Then the first name's row leaves a column for each bar.
    assert_eq!(
        first,
        Some(Rect::new(31, 0, 18, 1)),
        "names go inside the bars"
    );
}

#[rstest::rstest]
fn stack_shown_pane_fills_the_rows_below_the_list() {
    // Given eleven tiled panes, one stack over the whole body.
    let layouts = tiled(17);

    // When placing them.
    let area = placement(&layouts)
        .panes
        .iter()
        .find(|place| Some(place.pane) == expanded(&layouts))
        .map(|place| place.area);

    // Then the shown pane takes every row under the list.
    assert_eq!(
        area,
        Some(Rect::new(0, 11, 80, 13)),
        "the shown pane is pinned below the list"
    );
}

#[rstest::rstest]
fn stack_list_is_at_most_half_the_stack() {
    // Given fourteen tiled panes in a 24-row body.
    let layouts = tiled(20);

    // When placing them.
    let height = placement(&layouts)
        .stacks
        .into_iter()
        .next()
        .map(|stack| stack.area.height);

    // Then the list is half the body's height.
    assert_eq!(height, Some(12), "the list stops at half the stack");
}

#[rstest::rstest]
fn stack_list_scrolls_to_keep_the_shown_row() {
    // Given eleven tiled panes, the last stacked pane 17 shown.
    let layouts = tiled(17);

    // When placing them in an 8-row body, whose list fits four rows.
    let rows: Vec<PaneId> = layouts
        .get(OWNER)
        .and_then(|layout| {
            layout
                .placed(Rect::new(0, 0, 80, 8), |_| LIST_WIDTH)
                .stacks
                .into_iter()
                .next()
        })
        .map(|stack| stack.rows.into_iter().map(|(pane, _)| pane).collect())
        .unwrap_or_default();

    // Then the list shows the last four stacked panes, pane 17 among them.
    assert_eq!(
        rows,
        vec![PaneId(14), PaneId(15), PaneId(16), PaneId(17)],
        "the list scrolls to the shown pane"
    );
}

/// The panes each tab holds, in tab order.
fn tab_panes(layouts: &Layouts) -> Vec<Vec<PaneId>> {
    layouts.get(OWNER).map_or_else(Vec::new, |layout| {
        layout
            .tabs()
            .iter()
            .map(|tab| tab.tree.pane_ids())
            .collect()
    })
}

#[rstest::rstest]
fn break_pane_moves_the_focused_pane_to_its_own_tab() {
    // Given pane 7 split right with pane 8, which has the focus.
    let mut layouts = split_right();

    // When breaking the focused pane out.
    layouts.break_pane(OWNER);

    // Then pane 7 keeps the first tab and pane 8 has a second tab.
    assert_eq!(
        tab_panes(&layouts),
        vec![vec![PaneId(7)], vec![PaneId(8)]],
        "the focused pane leaves for a new tab"
    );
}

#[rstest::rstest]
fn break_pane_shows_the_new_tab() {
    // Given pane 7 split right with pane 8, which has the focus.
    let mut layouts = split_right();

    // When breaking the focused pane out.
    layouts.break_pane(OWNER);

    // Then the new tab is shown.
    assert_eq!(
        layouts.get(OWNER).map(SessionLayout::active),
        Some(1),
        "the broken-out pane's tab is shown"
    );
}

#[rstest::rstest]
fn break_pane_on_a_lone_pane_does_nothing() {
    // Given a tab of pane 7 alone.
    let mut layouts = opened();

    // When breaking the focused pane out.
    layouts.break_pane(OWNER);

    // Then there is still one tab of pane 7.
    assert_eq!(
        tab_panes(&layouts),
        vec![vec![PaneId(7)]],
        "a lone pane is already its own tab"
    );
}

#[rstest::rstest]
fn stack_on_a_lone_pane_stacks_the_new_pane_shown() {
    // Given a lone pane 7.
    let mut layouts = opened();

    // When stacking pane 8 with it.
    layouts.stack(OWNER, entry(8));

    // Then panes 7 and 8 are a stack showing pane 8, which has the focus.
    assert_eq!(
        (
            placement(&layouts)
                .stacks
                .into_iter()
                .next()
                .map(|stack| stack.rows.len()),
            expanded(&layouts),
            focused(&layouts)
        ),
        (Some(2), Some(PaneId(8)), Some(PaneId(8))),
        "a stack of two shows the new pane"
    );
}

/// Session 1's layout with two stacks: panes 7 and 10 on the left, panes
/// 8 and 9 on the right, pane 10 focused.
fn two_stacks() -> Layouts {
    let mut layouts = split_right();
    layouts.stack(OWNER, entry(9));
    layouts.focus_pane(OWNER, PaneId(7));
    layouts.stack(OWNER, entry(10));
    layouts
}

#[rstest::rstest]
fn stack_outside_every_stack_starts_a_second_list() {
    // Given pane 7 beside a stack of panes 8 and 9, pane 7 focused.
    let mut layouts = split_right();
    layouts.stack(OWNER, entry(9));
    layouts.focus_pane(OWNER, PaneId(7));

    // When stacking pane 10.
    layouts.stack(OWNER, entry(10));

    // Then the tab draws two stack lists.
    assert_eq!(
        placement(&layouts).stacks.len(),
        2,
        "a pane outside every stack starts a second stack with its own list"
    );
}

#[rstest::rstest]
fn each_stack_list_takes_its_own_width() {
    // Given two stacks, the left one holding pane 7.
    let layouts = two_stacks();

    // When placing them with a 10-column list for the left stack and a
    // 20-column one for the right.
    let widths: Vec<u16> = layouts
        .get(OWNER)
        .map(|layout| {
            layout.placed(
                BODY,
                |panes| {
                    if panes.contains(&PaneId(7)) { 10 } else { 20 }
                },
            )
        })
        .unwrap_or_default()
        .stacks
        .iter()
        .map(|stack| stack.area.width)
        .collect();

    // Then each list is as wide as its own stack asked.
    assert_eq!(widths, vec![10, 20], "each stack list has its own width");
}

#[rstest::rstest]
fn add_tiled_shows_every_pane_of_a_zoomed_tab() {
    // Given a zoomed two-pane tab.
    let mut layouts = split_right();
    layouts.toggle_zoom(OWNER);

    // When adding a tiled pane.
    layouts.add_tiled(OWNER, entry(9));

    // Then the tab isn't zoomed.
    assert_eq!(
        placed(&layouts).len(),
        3,
        "adding a pane should show every pane again"
    );
}

#[rstest::rstest]
#[case::left_from_the_second(2, NavDirection::Left, 0)]
#[case::left_from_the_first_wraps(1, NavDirection::Left, 2)]
#[case::right_from_the_first(1, NavDirection::Right, 1)]
#[case::right_from_the_last_wraps(3, NavDirection::Right, 0)]
fn move_focus_off_the_tab_edge_shows_the_tab_beside_it(
    #[case] from: usize,
    #[case] nav: NavDirection,
    #[case] shown: usize,
) {
    // Given three one-pane tabs, tab `from` shown.
    let mut layouts = three_tabs();
    layouts.go_to_tab(OWNER, from);

    // When moving the focus off the tab's edge.
    let moved = layouts.move_focus(OWNER, nav);

    // Then the tab beside it is shown, wrapping past the ends.
    assert_eq!(
        (moved, active(&layouts)),
        (FocusMove::Moved, Some(shown)),
        "the edge leads to the tab beside it"
    );
}

#[rstest::rstest]
fn move_focus_left_into_a_tab_focuses_its_rightmost_pane() {
    // Given tab 1 with panes 7 and 8 side by side, 7 focused, and tab 2
    // of pane 9 shown.
    let mut layouts = split_right();
    layouts.focus_pane(OWNER, PaneId(7));
    layouts.new_tab(OWNER, entry(9));

    // When moving the focus left.
    layouts.move_focus(OWNER, NavDirection::Left);

    // Then tab 1's right pane has the focus.
    assert_eq!(
        focused(&layouts),
        Some(PaneId(8)),
        "entering from the right focuses the rightmost pane"
    );
}

#[rstest::rstest]
fn move_focus_right_into_a_tab_focuses_its_leftmost_pane() {
    // Given tab 1 of pane 7 and tab 2 with panes 9 and 10 side by side,
    // 10 focused, tab 1 shown.
    let mut layouts = opened();
    layouts.new_tab(OWNER, entry(9));
    layouts.split(OWNER, Split::Right, entry(10));
    layouts.go_to_tab(OWNER, 1);

    // When moving the focus right.
    layouts.move_focus(OWNER, NavDirection::Right);

    // Then tab 2's left pane has the focus.
    assert_eq!(
        focused(&layouts),
        Some(PaneId(9)),
        "entering from the left focuses the leftmost pane"
    );
}

#[rstest::rstest]
fn move_focus_into_a_tab_keeps_its_focus_on_the_entry_edge() {
    // Given tab 1 of pane 7 and tab 2 with pane 9 above pane 10, 10
    // focused, tab 1 shown.
    let mut layouts = opened();
    layouts.new_tab(OWNER, entry(9));
    layouts.split(OWNER, Split::Down, entry(10));
    layouts.go_to_tab(OWNER, 1);

    // When moving the focus right.
    layouts.move_focus(OWNER, NavDirection::Right);

    // Then tab 2 keeps the focus on the lower pane.
    assert_eq!(
        focused(&layouts),
        Some(PaneId(10)),
        "a focused pane on the entry edge keeps the focus"
    );
}

#[rstest::rstest]
#[case::left(NavDirection::Left)]
#[case::right(NavDirection::Right)]
fn move_focus_off_the_edge_of_the_only_tab_is_stuck(#[case] nav: NavDirection) {
    // Given a lone pane in the only tab.
    let mut layouts = opened();

    // When moving the focus off its edge.
    let moved = layouts.move_focus(OWNER, nav);

    // Then nothing moves.
    assert_eq!(moved, FocusMove::Stuck, "one tab has nothing beside it");
}

#[rstest::rstest]
fn move_focus_moves_to_the_neighbour() {
    // Given two panes side by side, the right one focused.
    let mut layouts = split_right();

    // When moving the focus left.
    layouts.move_focus(OWNER, NavDirection::Left);

    // Then the left pane has the focus.
    assert_eq!(
        focused(&layouts),
        Some(PaneId(7)),
        "the left pane is the neighbour"
    );
}

#[rstest::rstest]
fn zoomed_tab_places_only_the_focused_pane_over_the_body() {
    // Given two panes side by side.
    let mut layouts = split_right();

    // When zooming.
    layouts.toggle_zoom(OWNER);

    // Then only the focused pane is placed, over the whole body.
    assert_eq!(
        placement(&layouts),
        Placement {
            panes: vec![Placed {
                pane: PaneId(8),
                area: BODY,
                focused: true,
                floating: false,
                pinned: false,
            }],
            stacks: vec![],
        },
        "a zoomed tab shows its focused pane alone"
    );
}

#[rstest::rstest]
fn zoom_twice_places_every_pane_again() {
    // Given two panes side by side.
    let mut layouts = split_right();

    // When zooming twice.
    layouts.toggle_zoom(OWNER);
    layouts.toggle_zoom(OWNER);

    // Then both panes are placed.
    assert_eq!(placed(&layouts).len(), 2, "unzoom shows every pane");
}

#[rstest::rstest]
fn split_right_places_each_pane_on_its_whole_tree_cell() {
    // Given two panes side by side over an 80-column body.
    let layouts = split_right();

    // When placing them.
    let areas: Vec<Rect> = placed(&layouts).iter().map(|place| place.area).collect();

    // Then each pane's frame takes its half.
    assert_eq!(
        areas,
        vec![Rect::new(0, 0, 40, 24), Rect::new(40, 0, 40, 24)],
        "the frames touch at column 40"
    );
}

#[rstest::rstest]
fn split_down_places_each_pane_on_its_whole_tree_cell() {
    // Given two stacked panes over a 24-row body.
    let mut layouts = opened();
    layouts.split(OWNER, Split::Down, entry(8));

    // When placing them.
    let areas: Vec<Rect> = placed(&layouts).iter().map(|place| place.area).collect();

    // Then each pane's frame takes its half.
    assert_eq!(
        areas,
        vec![Rect::new(0, 0, 80, 12), Rect::new(0, 12, 80, 12)],
        "the frames touch at row 12"
    );
}

#[rstest::rstest]
fn content_is_the_cell_less_one_cell_on_each_side() {
    // Given a pane placed on a 40×24 cell.
    let place = Placed {
        pane: PaneId(7),
        area: Rect::new(0, 0, 40, 24),
        focused: false,
        floating: false,
        pinned: false,
    };

    // When asking where its screen goes.
    let content = place.content();

    // Then the frame takes one cell on every side.
    assert_eq!(
        content,
        Rect::new(1, 1, 38, 22),
        "the frame is one cell thick"
    );
}

#[rstest::rstest]
fn closing_a_tabs_last_pane_closes_the_tab() {
    // Given a second tab of one pane, shown.
    let mut layouts = opened();
    layouts.new_tab(OWNER, entry(8));

    // When closing that pane.
    layouts.close_pane(PaneId(8));

    // Then only the first tab is left, shown.
    assert_eq!(
        (tab_count(&layouts), active(&layouts)),
        (1, Some(0)),
        "the emptied tab should close"
    );
}

#[rstest::rstest]
fn closing_the_last_tab_drops_the_layout() {
    // Given a layout of one tab.
    let mut layouts = opened();

    // When closing the tab.
    layouts.close_tab(OWNER);

    // Then the layout is gone.
    assert!(layouts.get(OWNER).is_none(), "no tabs means no layout");
}

#[rstest::rstest]
fn new_tab_is_appended_and_shown() {
    // Given a layout of one tab.
    let mut layouts = opened();

    // When opening a tab of pane 8.
    layouts.new_tab(OWNER, entry(8));

    // Then the second tab is shown, focused on pane 8.
    assert_eq!(
        (active(&layouts), focused(&layouts)),
        (Some(1), Some(PaneId(8))),
        "the new tab is shown"
    );
}

#[rstest::rstest]
fn go_to_tab_past_the_last_changes_nothing() {
    // Given three tabs, the first shown.
    let mut layouts = three_tabs();

    // When going to tab 5.
    layouts.go_to_tab(OWNER, 5);

    // Then the first is still shown.
    assert_eq!(active(&layouts), Some(0), "tab 5 doesn't exist");
}

#[rstest::rstest]
fn move_tab_right_swaps_it_with_its_neighbour() {
    // Given three tabs, the first shown and named.
    let mut layouts = three_tabs();
    layouts.rename_tab(OWNER, 0, Some("logs".into()));

    // When moving it right.
    layouts.move_tab_right(OWNER);

    // Then it is second and still shown.
    let second = layouts
        .get(OWNER)
        .and_then(|layout| layout.tabs().get(1))
        .and_then(|tab| tab.name().map(str::to_owned));
    assert_eq!(
        (second, active(&layouts)),
        (Some("logs".to_owned()), Some(1)),
        "the moved tab is second and shown"
    );
}

#[rstest::rstest]
fn move_tab_left_at_the_first_changes_nothing() {
    // Given three tabs, the first shown.
    let mut layouts = three_tabs();

    // When moving it left.
    layouts.move_tab_left(OWNER);

    // Then it is still first.
    assert_eq!(active(&layouts), Some(0), "the first tab can't move left");
}

#[rstest::rstest]
fn pane_ids_lists_every_tabs_panes() {
    // Given a split first tab and a second tab.
    let mut layouts = split_right();
    layouts.new_tab(OWNER, entry(9));

    // When listing the panes.
    let panes = layouts.pane_ids();

    // Then all three are there.
    assert_eq!(
        panes,
        HashSet::from([PaneId(7), PaneId(8), PaneId(9)]),
        "panes of every tab"
    );
}

#[rstest::rstest]
fn owner_of_finds_a_panes_session() {
    // Given session 1's split layout.
    let layouts = split_right();

    // When asking whose pane 8 is.
    let owner = layouts.owner_of(PaneId(8));

    // Then it is session 1's.
    assert_eq!(owner, Some(OWNER), "pane 8 is in session 1's layout");
}

#[rstest::rstest]
fn unnamed_tab_is_labelled_by_its_number() {
    // Given an unnamed first tab.
    let layouts = opened();

    // When labelling it.
    let label = layouts.get(OWNER).map(|layout| layout.tab_label(0));

    // Then the label is its number.
    assert_eq!(label.as_deref(), Some("1"), "unnamed tab label");
}

#[rstest::rstest]
fn named_tab_is_labelled_by_number_and_name() {
    // Given a first tab named "logs".
    let mut layouts = opened();
    layouts.rename_tab(OWNER, 0, Some("logs".into()));

    // When labelling it.
    let label = layouts.get(OWNER).map(|layout| layout.tab_label(0));

    // Then the label is its number and name.
    assert_eq!(label.as_deref(), Some("1 logs"), "named tab label");
}

#[rstest::rstest]
fn unnamed_tab_is_labelled_by_its_focused_panes_name() {
    // Given an unnamed tab whose focused pane is named "server".
    let mut layouts = opened();
    layouts.rename_pane(PaneId(7), Some("server".into()));

    // When labelling it.
    let label = layouts.get(OWNER).map(|layout| layout.tab_label(0));

    // Then the label is its number and the pane's name.
    assert_eq!(
        label.as_deref(),
        Some("1 server"),
        "pane name labels the tab"
    );
}

#[rstest::rstest]
fn remembered_resume_shows_in_the_panes_entry() {
    // Given session 1's layout holding pane 7.
    let mut layouts = opened();

    // When remembering pane 7's resume command.
    layouts.remember_resume(PaneId(7), Some("claude --resume aa".into()));

    // Then pane 7's entry carries it.
    assert_eq!(
        layouts
            .entry(PaneId(7))
            .and_then(|entry| entry.resume.as_deref()),
        Some("claude --resume aa"),
        "resume command in the entry"
    );
}

/// A tall body for the `Alt +` climb: in 80×24 the first step on a [1][4]
/// column already stacks.
const TALL: Rect = Rect::new(0, 0, 80, 40);

/// Whether the shown tab is zoomed.
fn zoomed(layouts: &Layouts) -> bool {
    layouts
        .get(OWNER)
        .and_then(SessionLayout::active_tab)
        .is_some_and(Tab::zoomed)
}

/// The shown tab's tree as saved.
fn tree_json(layouts: &Layouts) -> Option<String> {
    layouts
        .get(OWNER)
        .and_then(SessionLayout::active_tab)
        .map(Tab::layout_json)
}

/// The shown tab placed over `TALL`.
fn tall_placement(layouts: &Layouts) -> Placement {
    layouts
        .get(OWNER)
        .map(|layout| layout.placed(TALL, |_| LIST_WIDTH))
        .unwrap_or_default()
}

/// Each stack's panes, in tree order.
fn stacked(layouts: &Layouts) -> Vec<Vec<PaneId>> {
    tall_placement(layouts)
        .stacks
        .into_iter()
        .map(|stack| stack.panes)
        .collect()
}

/// A [1][4] tab (pane 7 | panes 8 to 11) over `TALL`, focused on pane 9.
fn climb() -> Layouts {
    let mut layouts = tiled(11);
    layouts.fit_to(TALL);
    layouts.focus_pane(OWNER, PaneId(9));
    layouts
}

/// Presses `Alt +` until the stacks change, at most 30 times.
fn grow_until_the_stacks_change(layouts: &mut Layouts) {
    let before = stacked(layouts);
    for _ in 0..30 {
        layouts.resize_focused(OWNER, true);
        if stacked(layouts) != before {
            return;
        }
    }
}

/// Presses `Alt +` `times` times.
fn grow_times(layouts: &mut Layouts, times: usize) {
    for _ in 0..times {
        layouts.resize_focused(OWNER, true);
    }
}

#[rstest::rstest]
fn cmd_plus_in_a_column_stacks_the_pane_above() {
    // Given a [1][4] tab focused on pane 9, 10 rows tall below pane 8.
    let mut layouts = climb();

    // When pressing Alt + once, 12 rows more than pane 8 can give.
    layouts.resize_focused(OWNER, true);

    // Then panes 8 and 9 are one stack.
    assert_eq!(
        stacked(&layouts),
        vec![vec![PaneId(8), PaneId(9)]],
        "the first Alt + should stack pane 9 with the pane above"
    );
}

#[rstest::rstest]
fn cmd_plus_three_times_stacks_the_whole_column() {
    // Given a [1][4] tab focused on pane 9.
    let mut layouts = climb();

    // When pressing Alt + three times.
    grow_times(&mut layouts, 3);

    // Then the whole right column is one stack.
    assert_eq!(
        stacked(&layouts),
        vec![vec![PaneId(8), PaneId(9), PaneId(10), PaneId(11)]],
        "the stack should take in the panes below, one per press"
    );
}

#[rstest::rstest]
fn cmd_plus_on_a_stacked_column_grows_it_30_percent_left() {
    // Given a [1][4] tab whose right column Alt + stacked.
    let mut layouts = climb();
    grow_times(&mut layouts, 3);

    // When pressing Alt + once more.
    layouts.resize_focused(OWNER, true);

    // Then pane 7 is 24 columns narrower: 30% of the 80-column tab.
    let width = tall_placement(&layouts)
        .panes
        .iter()
        .find(|place| place.pane == PaneId(7))
        .map(|place| place.area.width);
    assert_eq!(width, Some(16), "the column should grow 24 columns left");
}

#[rstest::rstest]
fn cmd_plus_on_a_grown_column_stacks_the_whole_tab() {
    // Given a [1][4] tab whose stacked right column Alt + grew left.
    let mut layouts = climb();
    grow_times(&mut layouts, 4);

    // When pressing Alt + once more.
    layouts.resize_focused(OWNER, true);

    // Then every pane in the tab is one stack.
    assert_eq!(
        stacked(&layouts),
        vec![vec![
            PaneId(7),
            PaneId(8),
            PaneId(9),
            PaneId(10),
            PaneId(11)
        ]],
        "the last stack should hold the whole tab"
    );
}

#[rstest::rstest]
fn cmd_plus_on_a_whole_tab_stack_zooms_it() {
    // Given a [1][4] tab that Alt + stacked whole.
    let mut layouts = climb();
    grow_times(&mut layouts, 5);

    // When pressing Alt + once more.
    layouts.resize_focused(OWNER, true);

    // Then the tab is zoomed.
    assert!(
        zoomed(&layouts),
        "Alt + on a whole-tab stack should zoom it"
    );
}

#[rstest::rstest]
fn grow_on_a_stacked_tab_zooms_it() {
    // Given a tab that is one stack of panes 7 and 8.
    let mut layouts = opened();
    layouts.stack(OWNER, entry(8));

    // When growing the focused pane.
    layouts.resize_focused(OWNER, true);

    // Then the tab is zoomed.
    assert!(zoomed(&layouts), "growing a one-stack tab should zoom it");
}

#[rstest::rstest]
fn grow_on_a_lone_pane_changes_nothing() {
    // Given a tab of pane 7 alone.
    let mut layouts = opened();

    // When growing it.
    let changed = layouts.resize_focused(OWNER, true);

    // Then neither the tree nor the zoom changed.
    assert_eq!(
        (changed, zoomed(&layouts)),
        (false, false),
        "a lone pane has nothing to grow into and nothing to zoom"
    );
}

#[rstest::rstest]
fn grow_on_a_zoomed_tab_keeps_the_tree() {
    // Given panes 7 and 8 side by side, zoomed.
    let mut layouts = split_right();
    layouts.toggle_zoom(OWNER);
    let before = tree_json(&layouts);

    // When growing the focused pane.
    layouts.resize_focused(OWNER, true);

    // Then the tree is as it was.
    assert_eq!(
        tree_json(&layouts),
        before,
        "growing a zoomed tab should leave its tree alone"
    );
}

#[rstest::rstest]
fn resize_side_on_a_zoomed_tab_keeps_the_tree() {
    // Given panes 7 and 8 side by side, zoomed.
    let mut layouts = split_right();
    layouts.toggle_zoom(OWNER);
    let before = tree_json(&layouts);

    // When pushing the focused pane's left border out.
    layouts.resize_side(OWNER, NavDirection::Left, true);

    // Then the tree is as it was.
    assert_eq!(
        tree_json(&layouts),
        before,
        "resize mode on a zoomed tab should leave its tree alone"
    );
}

#[rstest::rstest]
fn resize_side_marks_the_tab_changed_by_hand() {
    // Given panes 7 and 8 side by side, pane 8 focused.
    let mut layouts = split_right();

    // When pushing pane 8's left border out.
    layouts.resize_side(OWNER, NavDirection::Left, true);

    // Then the tab is changed by hand.
    assert!(
        hand_changed(&layouts),
        "a resize-mode step should mark the tab changed by hand"
    );
}

#[rstest::rstest]
fn move_pane_does_not_mark_the_tab_changed_by_hand() {
    // Given an untouched tab of panes 7 and 8, pane 8 focused.
    let mut layouts = opened();
    layouts.add_tiled(OWNER, entry(8));

    // When moving pane 8 left.
    layouts.move_pane(OWNER, NavDirection::Left);

    // Then the tab is still untouched.
    assert!(
        !hand_changed(&layouts),
        "a move keeps the tab's shape, so it isn't changed by hand"
    );
}

#[rstest::rstest]
fn moved_order_survives_a_re_tile_on_add() {
    // Given an untouched tab of panes 7, 8 and 9, pane 9 moved before pane 8.
    let mut layouts = opened();
    layouts.add_tiled(OWNER, entry(8));
    layouts.add_tiled(OWNER, entry(9));
    layouts.move_pane_in_order(OWNER, false);

    // When adding pane 10, which re-tiles the tab.
    layouts.add_tiled(OWNER, entry(10));

    // Then the panes keep the moved order.
    let order: Vec<_> = placed(&layouts)
        .into_iter()
        .map(|place| place.pane)
        .collect();
    assert_eq!(
        order,
        vec![PaneId(7), PaneId(9), PaneId(8), PaneId(10)],
        "a re-tile should keep the order a move left"
    );
}

#[rstest::rstest]
fn move_pane_on_a_zoomed_tab_keeps_the_tree() {
    // Given panes 7 and 8 side by side, zoomed.
    let mut layouts = split_right();
    layouts.toggle_zoom(OWNER);
    let before = tree_json(&layouts);

    // When moving the focused pane left.
    layouts.move_pane(OWNER, NavDirection::Left);

    // Then the tree is as it was.
    assert_eq!(
        tree_json(&layouts),
        before,
        "move mode on a zoomed tab should leave its tree alone"
    );
}

#[rstest::rstest]
fn move_pane_never_changes_tab() {
    // Given three tabs, the first (pane 7 alone) shown.
    let mut layouts = three_tabs();

    // When moving pane 7 left.
    layouts.move_pane(OWNER, NavDirection::Left);

    // Then the first tab is still shown.
    assert_eq!(
        active(&layouts),
        Some(0),
        "a move past the tab's edge should not change tab"
    );
}

/// A 10-column body: panes 7 and 8 side by side get 5 columns each, so a
/// 1-column `Alt +` on pane 8 would leave pane 7 4 columns wide and stacks
/// them instead.
const NARROW: Rect = Rect::new(0, 0, 10, 24);

/// `split_right()` over `NARROW`.
fn narrow() -> Layouts {
    let mut layouts = split_right();
    layouts.fit_to(NARROW);
    layouts
}

/// Pane `pane`'s width when placed over `BODY`.
fn width(layouts: &Layouts, pane: i64) -> Option<u16> {
    placed(layouts)
        .into_iter()
        .find(|place| place.pane == PaneId(pane))
        .map(|place| place.area.width)
}

/// A 200 × 60 body.
const HUGE: Rect = Rect::new(0, 0, 200, 60);

/// Pane `pane`'s area when placed over `HUGE`.
fn huge_area(layouts: &Layouts, pane: i64) -> Option<Rect> {
    layouts
        .get(OWNER)
        .map(|layout| layout.placed(HUGE, |_| LIST_WIDTH))
        .unwrap_or_default()
        .panes
        .into_iter()
        .find(|place| place.pane == PaneId(pane))
        .map(|place| place.area)
}

#[rstest::rstest]
fn cmd_plus_on_a_200_column_tab_moves_a_left_right_border_60_columns() {
    // Given panes 7 and 8 side by side over a 200-column body, 8 focused.
    let mut layouts = split_right();
    layouts.fit_to(HUGE);
    let before = huge_area(&layouts, 8).map(|area| area.width);

    // When pressing Alt +.
    layouts.resize_focused(OWNER, true);

    // Then pane 8 is 60 columns wider: 30% of the tab.
    let after = huge_area(&layouts, 8).map(|area| area.width);
    assert_eq!(
        after,
        before.map(|width| width + 60),
        "Alt + moves 30% of the tab's width"
    );
}

#[rstest::rstest]
fn cmd_plus_on_a_60_row_tab_moves_a_top_bottom_border_18_rows() {
    // Given pane 8 below pane 7 over a 60-row body, 8 focused.
    let mut layouts = opened();
    layouts.split(OWNER, Split::Down, entry(8));
    layouts.fit_to(HUGE);
    let before = huge_area(&layouts, 8).map(|area| area.height);

    // When pressing Alt +.
    layouts.resize_focused(OWNER, true);

    // Then pane 8 is 18 rows taller: 30% of the tab.
    let after = huge_area(&layouts, 8).map(|area| area.height);
    assert_eq!(
        after,
        before.map(|height| height + 18),
        "Alt + moves 30% of the tab's height"
    );
}

#[rstest::rstest]
fn cmd_minus_after_a_30_percent_cmd_plus_restores_the_tree() {
    // Given panes 7 and 8 side by side over a 200-column body, grown once.
    let mut layouts = split_right();
    layouts.fit_to(HUGE);
    let before = tree_json(&layouts);
    layouts.resize_focused(OWNER, true);

    // When pressing Alt -.
    layouts.resize_focused(OWNER, false);

    // Then the tree is the one from before the Alt +.
    assert_eq!(tree_json(&layouts), before, "Alt - undoes the Alt +");
}

#[rstest::rstest]
fn cmd_minus_on_a_zoomed_tab_only_unzooms_it() {
    // Given panes 7 and 8 side by side, zoomed.
    let mut layouts = split_right();
    layouts.toggle_zoom(OWNER);
    let before = tree_json(&layouts);

    // When pressing Alt -.
    layouts.resize_focused(OWNER, false);

    // Then the tab is unzoomed and its tree is as it was.
    assert_eq!(
        (zoomed(&layouts), tree_json(&layouts)),
        (false, before),
        "Alt - on a zoomed tab should only leave the zoom"
    );
}

#[rstest::rstest]
fn cmd_minus_after_a_stacking_cmd_plus_restores_the_tree() {
    // Given panes 7 and 8 over a narrow body, stacked by one Alt +.
    let mut layouts = narrow();
    let before = tree_json(&layouts);
    layouts.resize_focused(OWNER, true);

    // When pressing Alt -.
    layouts.resize_focused(OWNER, false);

    // Then the tree is the one from before the Alt +.
    assert_eq!(
        tree_json(&layouts),
        before,
        "Alt - should undo the Alt + that stacked the split"
    );
}

#[rstest::rstest]
fn cmd_plus_after_a_cmd_minus_restores_the_tree() {
    // Given panes 7 and 8 side by side, pane 8 shrunk twice.
    let mut layouts = split_right();
    layouts.resize_focused(OWNER, false);
    let before = tree_json(&layouts);
    layouts.resize_focused(OWNER, false);

    // When pressing Alt +.
    layouts.resize_focused(OWNER, true);

    // Then the tree is the one from before the second Alt -.
    assert_eq!(
        tree_json(&layouts),
        before,
        "Alt + should undo the last Alt -"
    );
}

#[rstest::rstest]
fn cmd_minus_replays_the_climb_back_to_the_original_tree() {
    // Given a [1][4] tab that Alt + climbed until it zoomed.
    let mut layouts = climb();
    let original = tree_json(&layouts);
    let mut changes = 0;
    for _ in 0..30 {
        if zoomed(&layouts) {
            break;
        }
        if layouts.resize_focused(OWNER, true) {
            changes += 1;
        }
    }

    // When pressing Alt - once per change, plus once for the zoom.
    for _ in 0..=changes {
        layouts.resize_focused(OWNER, false);
    }

    // Then the tab is unzoomed with its original tree.
    assert_eq!(
        (zoomed(&layouts), tree_json(&layouts)),
        (false, original),
        "Alt - should replay every Alt + back to the original tree"
    );
}

#[rstest::rstest]
fn cmd_minus_after_a_focus_move_shrinks_the_newly_focused_pane() {
    // Given pane 8 grown once, leaving pane 7 16 columns wide, and the
    // focus moved to pane 7.
    let mut layouts = split_right();
    layouts.resize_focused(OWNER, true);
    layouts.focus_pane(OWNER, PaneId(7));

    // When pressing Alt -.
    layouts.resize_focused(OWNER, false);

    // Then pane 7 shrank 5% (4 columns), since 30% doesn't fit, instead
    // of the grow being undone.
    assert_eq!(
        width(&layouts, 7),
        Some(12),
        "after a focus move Alt - should shrink the focused pane"
    );
}

#[rstest::rstest]
fn cmd_minus_after_an_added_pane_keeps_it() {
    // Given pane 8 grown once, then pane 9 added.
    let mut layouts = split_right();
    layouts.resize_focused(OWNER, true);
    layouts.add_tiled(OWNER, entry(9));

    // When pressing Alt -.
    layouts.resize_focused(OWNER, false);

    // Then pane 9 is still placed.
    assert!(
        placed(&layouts).iter().any(|place| place.pane == PaneId(9)),
        "Alt - after an add should not bring back the tree without pane 9"
    );
}

#[rstest::rstest]
fn cmd_minus_without_history_shrinks_the_pane_a_step() {
    // Given panes 7 and 8 side by side, pane 8 40 columns wide.
    let mut layouts = split_right();

    // When pressing Alt -.
    layouts.resize_focused(OWNER, false);

    // Then pane 8 is 24 columns narrower: 30% of the 80-column tab.
    assert_eq!(
        width(&layouts, 8),
        Some(16),
        "Alt - with no history should shrink the focused pane a step"
    );
}

#[rstest::rstest]
fn next_swap_layout_drops_a_stack_made_by_cmd_plus() {
    // Given a [1][4] tab where Alt + stacked part of the right column.
    let mut layouts = climb();
    grow_until_the_stacks_change(&mut layouts);

    // When moving to the next swap layout.
    layouts.next_swap_layout(OWNER);

    // Then the re-applied vertical layout holds no stack.
    assert_eq!(
        stacked(&layouts),
        Vec::<Vec<PaneId>>::new(),
        "re-applying the vertical layout drops the stack Alt + made"
    );
}

/// The shown tab's swap layout and whether it was changed by hand.
fn swap(layouts: &Layouts) -> Option<(SwapLayout, bool)> {
    layouts
        .get(OWNER)
        .and_then(SessionLayout::active_tab)
        .map(|tab| (tab.swap_layout(), tab.hand_changed()))
}

/// The shown tab's swap layout.
fn swap_layout(layouts: &Layouts) -> Option<SwapLayout> {
    swap(layouts).map(|(layout, _)| layout)
}

/// Whether the shown tab was changed by hand.
fn hand_changed(layouts: &Layouts) -> bool {
    swap(layouts).is_some_and(|(_, marked)| marked)
}

/// Pane `pane`'s cell when placed over `BODY`.
fn area(layouts: &Layouts, pane: i64) -> Option<Rect> {
    placed(layouts)
        .into_iter()
        .find(|place| place.pane == PaneId(pane))
        .map(|place| place.area)
}

/// Pane 7 over panes 8 and 9, top to bottom, pane 9 focused.
fn three_down() -> Layouts {
    let mut layouts = opened();
    layouts.split(OWNER, Split::Down, entry(8));
    layouts.split(OWNER, Split::Down, entry(9));
    layouts
}

#[rstest::rstest]
fn new_tab_starts_on_base_untouched() {
    // Given / When opening a layout of pane 7.
    let layouts = opened();

    // Then its tab is on BASE and unmarked.
    assert_eq!(
        swap(&layouts),
        Some((SwapLayout::Base, false)),
        "a new tab starts on BASE, untouched"
    );
}

#[rstest::rstest]
fn second_pane_moves_an_untouched_base_tab_to_vertical() {
    // Given a tab of pane 7.
    let mut layouts = opened();

    // When adding pane 8.
    layouts.add_tiled(OWNER, entry(8));

    // Then the tab is vertical.
    assert_eq!(
        swap_layout(&layouts),
        Some(SwapLayout::Vertical),
        "BASE doesn't fit two panes, vertical does"
    );
}

#[rstest::rstest]
fn add_tiled_in_an_untouched_tab_re_tiles_it() {
    // Given six tiled panes, laid out [2][4].
    let mut layouts = tiled(12);

    // When adding pane 13.
    layouts.add_tiled(OWNER, entry(13));

    // Then the seven are laid out [1][4][2].
    assert_eq!(
        shape(&layouts),
        vec![1, 4, 2],
        "an add in an untouched tab re-tiles it"
    );
}

#[rstest::rstest]
fn eleventh_pane_moves_an_untouched_tab_to_stacked() {
    // Given ten tiled panes.
    let mut layouts = tiled(16);

    // When adding an eleventh.
    layouts.add_tiled(OWNER, entry(17));

    // Then the tab is stacked.
    assert_eq!(
        swap_layout(&layouts),
        Some(SwapLayout::Stacked),
        "eleven panes overflow vertical and horizontal into stacked"
    );
}

#[rstest::rstest]
#[case::split(opened, |layouts: &mut Layouts| layouts.split(OWNER, Split::Right, entry(8)))]
#[case::stack(opened, |layouts: &mut Layouts| layouts.stack(OWNER, entry(8)))]
#[case::cmd_plus(climb, |layouts: &mut Layouts| { layouts.resize_focused(OWNER, true); })]
#[case::cmd_minus(|| tiled(8), |layouts: &mut Layouts| { layouts.resize_focused(OWNER, false); })]
fn hand_changes_mark_the_tab(#[case] given: fn() -> Layouts, #[case] change: fn(&mut Layouts)) {
    // Given an untouched tab.
    let mut layouts = given();

    // When changing it by hand.
    change(&mut layouts);

    // Then the tab is marked.
    assert!(hand_changed(&layouts), "a hand change should mark the tab");
}

#[rstest::rstest]
fn zoom_does_not_mark_the_tab() {
    // Given two tiled panes.
    let mut layouts = tiled(8);

    // When zooming.
    layouts.toggle_zoom(OWNER);

    // Then the tab is unmarked.
    assert!(!hand_changed(&layouts), "a zoom isn't a hand change");
}

#[rstest::rstest]
fn overflow_stack_does_not_mark_the_tab() {
    // Given ten tiled panes.
    let mut layouts = tiled(16);

    // When adding an eleventh, which stacks the tab.
    layouts.add_tiled(OWNER, entry(17));

    // Then the tab is unmarked.
    assert!(
        !hand_changed(&layouts),
        "overflowing into stacked isn't a hand change"
    );
}

#[rstest::rstest]
fn closing_a_pane_in_a_split_tab_moves_no_other_pane() {
    // Given pane 7 over panes 8 and 9, split by hand.
    let mut layouts = three_down();
    let before = area(&layouts, 7);

    // When closing pane 9.
    layouts.close_pane(PaneId(9));

    // Then pane 7 keeps its cell.
    assert_eq!(
        area(&layouts, 7),
        before,
        "a close in a split tab should leave the other panes alone"
    );
}

#[rstest::rstest]
fn closing_a_pane_keeps_a_stack_made_by_cmd_plus() {
    // Given a [1][4] tab where Alt + stacked panes 8 and 9.
    let mut layouts = climb();
    grow_until_the_stacks_change(&mut layouts);

    // When closing pane 7.
    layouts.close_pane(PaneId(7));

    // Then panes 8 and 9 are still one stack.
    assert_eq!(
        stacked(&layouts),
        vec![vec![PaneId(8), PaneId(9)]],
        "a close in a marked tab keeps the stack Alt + made"
    );
}

#[rstest::rstest]
fn break_pane_from_a_split_tab_keeps_its_shape() {
    // Given pane 7 over panes 8 and 9, split by hand, pane 9 focused.
    let mut layouts = three_down();
    let before = area(&layouts, 7);

    // When breaking pane 9 out and going back to the first tab.
    layouts.break_pane(OWNER);
    layouts.go_to_tab(OWNER, 1);

    // Then pane 7 keeps its cell.
    assert_eq!(
        area(&layouts, 7),
        before,
        "breaking a pane out of a split tab should leave the others alone"
    );
}

#[rstest::rstest]
fn untouched_stacked_tab_stays_stacked_at_three_panes() {
    // Given four tiled panes moved on to stacked.
    let mut layouts = tiled(10);
    layouts.next_swap_layout(OWNER);
    layouts.next_swap_layout(OWNER);

    // When closing pane 10.
    layouts.close_pane(PaneId(10));

    // Then the tab is still one stack, of three.
    assert_eq!(
        (swap_layout(&layouts), shape(&layouts)),
        (Some(SwapLayout::Stacked), vec![3]),
        "stacked fits three panes, so the tab stays stacked"
    );
}

#[rstest::rstest]
fn overflowed_tab_stays_stacked_when_closed_back_down() {
    // Given eleven tiled panes, overflowed into stacked.
    let mut layouts = tiled(17);

    // When closing panes 9 to 17, leaving two.
    for pane in 9..=17 {
        layouts.close_pane(PaneId(pane));
    }

    // Then the tab is still stacked.
    assert_eq!(
        swap_layout(&layouts),
        Some(SwapLayout::Stacked),
        "an overflowed tab stays stacked down to two panes"
    );
}

#[rstest::rstest]
fn overflowed_tab_closed_to_one_pane_wraps_to_base() {
    // Given eleven tiled panes, overflowed into stacked.
    let mut layouts = tiled(17);

    // When closing panes 8 to 17, leaving one.
    for pane in 8..=17 {
        layouts.close_pane(PaneId(pane));
    }

    // Then the tab is on BASE.
    assert_eq!(
        swap_layout(&layouts),
        Some(SwapLayout::Base),
        "one pane fits neither stacked layout, so the search wraps to BASE"
    );
}

#[rstest::rstest]
fn add_tiled_in_a_split_tab_splits_the_focused_pane() {
    // Given panes 7 and 8 side by side, split by hand, pane 8 focused.
    let mut layouts = split_right();
    let before = area(&layouts, 7);

    // When adding pane 9.
    layouts.add_tiled(OWNER, entry(9));

    // Then pane 9 sits below pane 8 and pane 7 keeps its cell.
    let (eight, nine) = (area(&layouts, 8), area(&layouts, 9));
    assert_eq!(
        (
            area(&layouts, 7),
            nine.map(|rect| rect.x) == eight.map(|rect| rect.x),
            nine.map(|rect| rect.y) > eight.map(|rect| rect.y)
        ),
        (before, true, true),
        "an add in a split tab should halve only the focused pane, got 8 {eight:?}, 9 {nine:?}"
    );
}

#[rstest::rstest]
fn next_swap_layout_steps_vertical_to_horizontal() {
    // Given three tiled panes, vertical.
    let mut layouts = tiled(9);

    // When moving to the next swap layout.
    layouts.next_swap_layout(OWNER);

    // Then the tab is horizontal.
    assert_eq!(
        swap_layout(&layouts),
        Some(SwapLayout::Horizontal),
        "next after vertical is horizontal"
    );
}

#[rstest::rstest]
fn next_swap_layout_steps_horizontal_to_stacked() {
    // Given five tiled panes moved on to horizontal.
    let mut layouts = tiled(11);
    layouts.next_swap_layout(OWNER);

    // When moving to the next swap layout.
    layouts.next_swap_layout(OWNER);

    // Then the tab is stacked.
    assert_eq!(
        swap_layout(&layouts),
        Some(SwapLayout::Stacked),
        "next after horizontal is stacked"
    );
}

#[rstest::rstest]
fn next_swap_layout_steps_stacked_to_half_stacked() {
    // Given five tiled panes moved on to stacked.
    let mut layouts = tiled(11);
    layouts.next_swap_layout(OWNER);
    layouts.next_swap_layout(OWNER);

    // When moving to the next swap layout.
    layouts.next_swap_layout(OWNER);

    // Then the tab is half-stacked.
    assert_eq!(
        swap_layout(&layouts),
        Some(SwapLayout::HalfStacked),
        "next after stacked is half-stacked"
    );
}

#[rstest::rstest]
fn next_swap_layout_wraps_half_stacked_past_base_to_vertical() {
    // Given five tiled panes moved on to half-stacked.
    let mut layouts = tiled(11);
    for _ in 0..3 {
        layouts.next_swap_layout(OWNER);
    }

    // When moving to the next swap layout.
    layouts.next_swap_layout(OWNER);

    // Then the tab is vertical.
    assert_eq!(
        swap_layout(&layouts),
        Some(SwapLayout::Vertical),
        "BASE doesn't fit five panes, so next wraps past it to vertical"
    );
}

#[rstest::rstest]
fn previous_swap_layout_from_two_vertical_panes_is_stacked() {
    // Given two tiled panes, vertical.
    let mut layouts = tiled(8);

    // When moving to the previous swap layout.
    layouts.previous_swap_layout(OWNER);

    // Then the tab is stacked.
    assert_eq!(
        swap_layout(&layouts),
        Some(SwapLayout::Stacked),
        "BASE and half-stacked don't fit two panes, so previous wraps to stacked"
    );
}

#[rstest::rstest]
fn second_previous_swap_layout_from_two_vertical_panes_is_horizontal() {
    // Given two tiled panes moved back to stacked.
    let mut layouts = tiled(8);
    layouts.previous_swap_layout(OWNER);

    // When moving to the previous swap layout again.
    layouts.previous_swap_layout(OWNER);

    // Then the tab is horizontal.
    assert_eq!(
        swap_layout(&layouts),
        Some(SwapLayout::Horizontal),
        "previous before stacked is horizontal"
    );
}

#[rstest::rstest]
fn next_swap_layout_on_a_changed_tab_reapplies_its_layout() {
    // Given three tiled panes, vertical, resized by Alt -.
    let mut layouts = tiled(9);
    layouts.resize_focused(OWNER, false);

    // When moving to the next swap layout.
    layouts.next_swap_layout(OWNER);

    // Then the tab is vertical again and unmarked.
    assert_eq!(
        swap(&layouts),
        Some((SwapLayout::Vertical, false)),
        "the first press on a changed tab re-applies its layout"
    );
}

#[rstest::rstest]
fn second_next_swap_layout_on_a_changed_tab_steps() {
    // Given three vertical panes resized by Alt -, then re-applied.
    let mut layouts = tiled(9);
    layouts.resize_focused(OWNER, false);
    layouts.next_swap_layout(OWNER);

    // When moving to the next swap layout again.
    layouts.next_swap_layout(OWNER);

    // Then the tab is horizontal.
    assert_eq!(
        swap(&layouts),
        Some((SwapLayout::Horizontal, false)),
        "the second press on a changed tab steps"
    );
}

#[rstest::rstest]
fn next_swap_layout_on_a_lone_pane_moves_base_to_vertical() {
    // Given a tab of pane 7, on BASE.
    let mut layouts = opened();

    // When moving to the next swap layout.
    layouts.next_swap_layout(OWNER);

    // Then the tab is vertical.
    assert_eq!(
        swap_layout(&layouts),
        Some(SwapLayout::Vertical),
        "next after BASE is vertical, which fits one pane"
    );
}

#[rstest::rstest]
fn next_swap_layout_shows_every_pane_of_a_zoomed_tab() {
    // Given two tiled panes, zoomed.
    let mut layouts = tiled(8);
    layouts.toggle_zoom(OWNER);

    // When moving to the next swap layout.
    layouts.next_swap_layout(OWNER);

    // Then the tab isn't zoomed.
    assert!(!zoomed(&layouts), "a swap layout change should unzoom");
}

#[rstest::rstest]
fn each_stack_list_is_centred_over_its_own_stack() {
    // Given two stacks side by side, each 40 columns wide.
    let layouts = two_stacks();

    // When placing them with 20-column lists.
    let lists: Vec<u16> = placement(&layouts)
        .stacks
        .iter()
        .map(|stack| stack.area.x)
        .collect();

    // Then each list starts 10 columns into its own stack.
    assert_eq!(lists, vec![10, 50], "each list is centred over its stack");
}

/// Session 1's layout of pane 7 with float 20 added.
fn with_float() -> Layouts {
    let mut layouts = opened();
    layouts.add_float(OWNER, entry(20));
    layouts
}

/// Session 1's two side-by-side panes with floats 20 and 21 added, 21 on top.
fn split_with_two_floats() -> Layouts {
    let mut layouts = split_right();
    layouts.add_float(OWNER, entry(20));
    layouts.add_float(OWNER, entry(21));
    layouts
}

#[rstest::rstest]
fn add_float_gives_the_float_the_keys() {
    // Given session 1's layout of pane 7.
    let mut layouts = opened();

    // When adding float 20.
    layouts.add_float(OWNER, entry(20));

    // Then the float has the keys.
    assert_eq!(
        focused(&layouts),
        Some(PaneId(20)),
        "a new float takes the keys"
    );
}

#[rstest::rstest]
fn toggle_floats_while_shown_gives_the_keys_back_to_the_tab() {
    // Given a shown float over pane 7.
    let mut layouts = with_float();

    // When hiding the floats.
    layouts.toggle_floats(OWNER);

    // Then pane 7 has the keys again.
    assert_eq!(
        focused(&layouts),
        Some(PaneId(7)),
        "hidden floats give the keys back"
    );
}

#[rstest::rstest]
fn go_to_tab_keeps_the_float_focused() {
    // Given three tabs and a shown float.
    let mut layouts = three_tabs();
    layouts.add_float(OWNER, entry(20));

    // When showing the second tab.
    layouts.go_to_tab(OWNER, 2);

    // Then the float still has the keys.
    assert_eq!(
        focused(&layouts),
        Some(PaneId(20)),
        "floats sit over every tab"
    );
}

#[rstest::rstest]
fn closing_the_last_float_gives_the_keys_back_to_the_tab() {
    // Given a shown float over pane 7.
    let mut layouts = with_float();

    // When closing the float.
    layouts.close_pane(PaneId(20));

    // Then pane 7 has the keys again.
    assert_eq!(
        focused(&layouts),
        Some(PaneId(7)),
        "the tab gets the keys back"
    );
}

#[rstest::rstest]
fn move_focus_right_with_no_float_there_is_stuck() {
    // Given three tabs and one shown float.
    let mut layouts = three_tabs();
    layouts.add_float(OWNER, entry(20));

    // When moving the focus right.
    let moved = layouts.move_focus(OWNER, NavDirection::Right);

    // Then nothing moves and the first tab stays shown.
    assert_eq!(
        (moved, active(&layouts)),
        (FocusMove::Stuck, Some(0)),
        "focus among floats never changes tab"
    );
}

#[rstest::rstest]
fn move_focus_left_reaches_the_float_on_the_left() {
    // Given two staggered floats, 21 on top of 20.
    let mut layouts = opened();
    layouts.add_float(OWNER, entry(20));
    layouts.add_float(OWNER, entry(21));

    // When moving the focus left.
    layouts.move_focus(OWNER, NavDirection::Left);

    // Then float 20 has the keys.
    assert_eq!(
        focused(&layouts),
        Some(PaneId(20)),
        "the float to the left gets the keys"
    );
}

#[rstest::rstest]
fn placed_lists_shown_floats_last_bottom_first() {
    // Given two side-by-side panes and floats 20 and 21.
    let layouts = split_with_two_floats();

    // When placing them.
    let last: Vec<(PaneId, bool)> = placed(&layouts)
        .iter()
        .skip(2)
        .map(|place| (place.pane, place.floating))
        .collect();

    // Then the floats come last, bottom first.
    assert_eq!(
        last,
        vec![(PaneId(20), true), (PaneId(21), true)],
        "floats are placed after the tiled panes"
    );
}

#[rstest::rstest]
fn placed_focuses_only_the_top_float() {
    // Given two side-by-side panes and floats 20 and 21.
    let layouts = split_with_two_floats();

    // When placing them.
    let lit: Vec<PaneId> = placed(&layouts)
        .iter()
        .filter(|place| place.focused)
        .map(|place| place.pane)
        .collect();

    // Then only the top float is lit.
    assert_eq!(lit, vec![PaneId(21)], "one frame has the focus");
}

#[rstest::rstest]
fn hidden_floats_are_not_placed() {
    // Given a float that has been hidden.
    let mut layouts = with_float();
    layouts.toggle_floats(OWNER);

    // When placing the panes.
    let floating = placed(&layouts).iter().any(|place| place.floating);

    // Then no float is placed.
    assert!(!floating, "hidden floats are not drawn");
}

#[rstest::rstest]
fn floats_keep_a_layout_without_tabs() {
    // Given a float over the lone pane 7.
    let mut layouts = with_float();

    // When closing pane 7.
    layouts.close_pane(PaneId(7));

    // Then the layout stays.
    assert!(layouts.get(OWNER).is_some(), "a layout with floats is kept");
}

#[rstest::rstest]
fn pane_ids_include_hidden_floats() {
    // Given a float that has been hidden.
    let mut layouts = with_float();
    layouts.toggle_floats(OWNER);

    // When listing every pane.
    let ids = layouts.pane_ids();

    // Then the hidden float is among them.
    assert!(
        ids.contains(&PaneId(20)),
        "hidden floats keep their programs"
    );
}

#[rstest::rstest]
fn owner_of_finds_a_floats_session() {
    // Given float 20 in session 1.
    let layouts = with_float();

    // When looking up the float's session.
    let owner = layouts.owner_of(PaneId(20));

    // Then it is session 1.
    assert_eq!(owner, Some(OWNER), "a float belongs to its session");
}

#[rstest::rstest]
fn float_pane_moves_the_pane_to_the_top_float() {
    // Given panes 7 and 8 side by side, 8 focused.
    let mut layouts = split_right();

    // When turning the focused pane into a float.
    layouts.float_pane(OWNER);

    // Then pane 8 is the focused float and the tab keeps only pane 7.
    let shape = layouts.get(OWNER).map(|layout| {
        (
            layout.focused(),
            layout.float_focused(),
            layout.active_tab().map(Tab::pane_count),
        )
    });
    assert_eq!(
        shape,
        Some((Some(PaneId(8)), true, Some(1))),
        "the focused pane becomes the top float"
    );
}

#[rstest::rstest]
fn float_pane_on_a_tabs_only_pane_changes_nothing() {
    // Given the lone pane 7.
    let mut layouts = opened();
    let before = layouts.get(OWNER).cloned();

    // When turning the focused pane into a float.
    let changed = layouts.float_pane(OWNER);

    // Then nothing changes.
    assert_eq!(
        (changed, layouts.get(OWNER).cloned()),
        (false, before),
        "a tab's only pane stays in the tab"
    );
}

#[rstest::rstest]
fn embed_float_puts_the_float_back_in_the_tab_focused() {
    // Given float 20 over the lone pane 7.
    let mut layouts = with_float();

    // When putting the float back into the tab.
    layouts.embed_float(OWNER);

    // Then pane 20 is focused in the tab of two panes.
    let shape = layouts.get(OWNER).map(|layout| {
        (
            layout.focused(),
            layout.active_tab().map(Tab::pane_count),
            layout.float_focused(),
        )
    });
    assert_eq!(
        shape,
        Some((Some(PaneId(20)), Some(2), false)),
        "the float goes back into the tab with the keys"
    );
}

#[rstest::rstest]
fn embed_float_hides_the_other_floats() {
    // Given floats 20 and 21 over two tiled panes.
    let mut layouts = split_with_two_floats();

    // When putting the top float back into the tab.
    layouts.embed_float(OWNER);

    // Then no float is drawn.
    assert!(
        !placed(&layouts).iter().any(|place| place.floating),
        "embedding a float hides the others"
    );
}

#[rstest::rstest]
fn restored_floats_place_only_the_pinned_one() {
    // Given a saved tab of pane 7, float 20 unpinned and float 21 pinned.
    let float = |pane, pinned| Float {
        pane: PaneId(pane),
        rect: FloatRect {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.5,
        },
        pinned,
    };
    let floats = Floats::restore(
        vec![float(20, false), float(21, true)],
        FloatLayout::Staggered,
        false,
    );

    // When restoring the session.
    let mut layouts = Layouts::default();
    layouts.insert(
        OWNER,
        SessionLayout::restore(
            vec![Tab::restore(
                None,
                TileLayout::new(PaneId(7)),
                SwapLayout::Vertical,
                false,
            )],
            0,
            vec![entry(7), entry(20), entry(21)],
            floats,
        ),
    );
    layouts.fit_to(BODY);

    // Then only the pinned float is placed.
    let floating: Vec<PaneId> = placed(&layouts)
        .iter()
        .filter(|place| place.floating)
        .map(|place| place.pane)
        .collect();
    assert_eq!(
        floating,
        vec![PaneId(21)],
        "hidden floats draw only the pinned one"
    );
}

#[rstest::rstest]
fn hidden_pinned_float_leaves_the_keys_in_the_tab() {
    // Given float 20 pinned over pane 7.
    let mut layouts = with_float();
    layouts.toggle_pin(OWNER);

    // When hiding the floats.
    layouts.toggle_floats(OWNER);

    // Then the tiled pane has the keys.
    assert_eq!(
        focused(&layouts),
        Some(PaneId(7)),
        "a hidden pinned float never has the keys"
    );
}

#[rstest::rstest]
fn hidden_pinned_float_is_placed_unfocused() {
    // Given float 20 pinned over pane 7.
    let mut layouts = with_float();
    layouts.toggle_pin(OWNER);

    // When hiding the floats.
    layouts.toggle_floats(OWNER);

    // Then the float is still drawn, pinned and without the focus.
    let float = placed(&layouts)
        .into_iter()
        .find(|place| place.floating)
        .map(|place| (place.pinned, place.focused));
    assert_eq!(
        float,
        Some((true, false)),
        "a hidden pinned float is drawn unfocused"
    );
}

#[rstest::rstest]
fn toggle_pin_while_hidden_changes_nothing() {
    // Given float 20 hidden.
    let mut layouts = with_float();
    layouts.toggle_floats(OWNER);

    // When pinning.
    let changed = layouts.toggle_pin(OWNER);

    // Then nothing changes.
    assert!(!changed, "a hidden float can't be pinned");
}

/// The top float's frame in the tests' body.
fn top_frame(layouts: &Layouts) -> Option<Rect> {
    layouts
        .get(OWNER)?
        .floats()
        .visible(BODY)
        .last()
        .map(|(_, frame, _)| frame)
}

/// Whether session 1's floats are marked changed by hand.
fn floats_marked(layouts: &Layouts) -> bool {
    layouts
        .get(OWNER)
        .is_some_and(|layout| layout.floats().hand_changed())
}

/// `with_float` with the float moved by each direction and step count in turn.
fn with_float_moved(moves: &[(NavDirection, usize)]) -> Layouts {
    let mut layouts = with_float();
    for &(dir, times) in moves {
        for _ in 0..times {
            layouts.move_pane(OWNER, dir);
        }
    }
    layouts
}

#[rstest::rstest]
fn resize_mode_grow_pushes_a_float_edge_out_one_step() {
    // Given a float at (20, 6), 40×12, on an 80×24 body.
    let mut layouts = with_float();

    // When growing its right edge.
    layouts.resize_side(OWNER, NavDirection::Right, true);

    // Then the right edge moves out 4 columns.
    assert_eq!(
        top_frame(&layouts),
        Some(Rect::new(20, 6, 44, 12)),
        "the right edge should move out one step"
    );
}

#[rstest::rstest]
fn resize_mode_grow_at_the_body_edge_pulls_the_other_edge_in() {
    // Given a float against the body's right edge, at (40, 6), 40×12.
    let mut layouts = with_float_moved(&[(NavDirection::Right, 5)]);

    // When growing its right edge.
    layouts.resize_side(OWNER, NavDirection::Right, true);

    // Then the left edge is pulled in 4 columns instead.
    assert_eq!(
        top_frame(&layouts),
        Some(Rect::new(44, 6, 36, 12)),
        "the left edge should be pulled in one step"
    );
}

#[rstest::rstest]
fn resize_mode_shrink_stops_at_the_smallest_float() {
    // Given a float shrunk to the smallest size, 10×4.
    let mut layouts = with_float();
    for _ in 0..4 {
        layouts.resize_focused(OWNER, false);
    }

    // When shrinking its left edge.
    let changed = layouts.resize_side(OWNER, NavDirection::Left, false);

    // Then nothing changes.
    assert!(!changed, "the smallest float should not shrink further");
}

#[rstest::rstest]
fn move_mode_shifts_a_float_one_step() {
    // Given a float at (20, 6), 40×12.
    let mut layouts = with_float();

    // When moving it right.
    layouts.move_pane(OWNER, NavDirection::Right);

    // Then it moves 4 columns right.
    assert_eq!(
        top_frame(&layouts),
        Some(Rect::new(24, 6, 40, 12)),
        "the float should move one step right"
    );
}

#[rstest::rstest]
fn move_mode_at_the_left_edge_leaves_the_float() {
    // Given a float against the body's left edge.
    let mut layouts = with_float_moved(&[(NavDirection::Left, 5)]);

    // When moving it left.
    let changed = layouts.move_pane(OWNER, NavDirection::Left);

    // Then nothing changes.
    assert!(!changed, "a float at the left edge should not move left");
}

#[rstest::rstest]
fn grow_focused_moves_each_side_of_a_float_out() {
    // Given a float at (20, 6), 40×12.
    let mut layouts = with_float();

    // When growing it.
    layouts.resize_focused(OWNER, true);

    // Then each side moves out one step.
    assert_eq!(
        top_frame(&layouts),
        Some(Rect::new(16, 5, 48, 14)),
        "every side should move out one step"
    );
}

#[rstest::rstest]
fn grow_focused_keeps_a_float_inside_the_body() {
    // Given a float in the body's top-left corner.
    let mut layouts = with_float_moved(&[(NavDirection::Left, 5), (NavDirection::Up, 6)]);

    // When growing it.
    layouts.resize_focused(OWNER, true);

    // Then only the right and bottom edges move.
    assert_eq!(
        top_frame(&layouts),
        Some(Rect::new(0, 0, 44, 13)),
        "the float should stay inside the body"
    );
}

#[rstest::rstest]
fn shrink_focused_moves_each_side_of_a_float_in() {
    // Given a float at (20, 6), 40×12.
    let mut layouts = with_float();

    // When shrinking it.
    layouts.resize_focused(OWNER, false);

    // Then each side moves in one step.
    assert_eq!(
        top_frame(&layouts),
        Some(Rect::new(24, 7, 32, 10)),
        "every side should move in one step"
    );
}

#[rstest::rstest]
fn move_mode_next_puts_the_bottom_float_on_top() {
    // Given floats 20 and 21, 21 on top.
    let mut layouts = split_with_two_floats();

    // When stepping to the next float in move mode.
    layouts.move_pane_in_order(OWNER, true);

    // Then float 20 is on top with the keys.
    assert_eq!(
        focused(&layouts),
        Some(PaneId(20)),
        "the bottom float should come to the top"
    );
}

#[rstest::rstest]
fn move_mode_next_does_not_mark_the_floats() {
    // Given floats 20 and 21, 21 on top.
    let mut layouts = split_with_two_floats();

    // When stepping to the next float in move mode.
    layouts.move_pane_in_order(OWNER, true);

    // Then the floats are not marked changed by hand.
    assert!(
        !floats_marked(&layouts),
        "rotating the floats is not a change by hand"
    );
}

#[rstest::rstest]
#[case::move_mode(|l: &mut Layouts| { l.move_pane(OWNER, NavDirection::Right); })]
#[case::resize_mode(|l: &mut Layouts| { l.resize_side(OWNER, NavDirection::Right, true); })]
#[case::grow(|l: &mut Layouts| { l.resize_focused(OWNER, true); })]
fn changing_a_float_marks_the_floats(#[case] change: fn(&mut Layouts)) {
    // Given a shown float.
    let mut layouts = with_float();

    // When moving or resizing it.
    change(&mut layouts);

    // Then the floats are marked changed by hand.
    assert!(
        floats_marked(&layouts),
        "moving or resizing a float marks the floats"
    );
}

#[rstest::rstest]
fn resize_mode_on_a_float_leaves_the_tab_alone() {
    // Given two side-by-side panes under two shown floats.
    let mut layouts = split_with_two_floats();
    let before = layouts
        .get(OWNER)
        .and_then(SessionLayout::active_tab)
        .map(Tab::layout_json);

    // When growing the right edge in resize mode.
    layouts.resize_side(OWNER, NavDirection::Right, true);

    // Then the tab's tree is unchanged.
    let after = layouts
        .get(OWNER)
        .and_then(SessionLayout::active_tab)
        .map(Tab::layout_json);
    assert_eq!(after, before, "resizing a float leaves the tab alone");
}

#[rstest::rstest]
fn resize_mode_with_floats_hidden_resizes_the_tab() {
    // Given two side-by-side panes under two hidden floats.
    let mut layouts = split_with_two_floats();
    layouts.toggle_floats(OWNER);

    // When growing the left edge in resize mode.
    let changed = layouts.resize_side(OWNER, NavDirection::Left, true);

    // Then the tab resizes and the floats stay unmarked.
    assert_eq!(
        (changed, floats_marked(&layouts)),
        (true, false),
        "hidden floats leave resize mode to the tab"
    );
}

/// Session 1's layout of pane 7 with its floats laid out `layout` and
/// each of `panes` added as a float in turn.
fn floats_in(layout: FloatLayout, panes: &[i64]) -> Layouts {
    let mut layouts = Layouts::default();
    layouts.insert(
        OWNER,
        SessionLayout::restore(
            vec![Tab::restore(
                None,
                TileLayout::new(PaneId(7)),
                SwapLayout::Vertical,
                false,
            )],
            0,
            vec![entry(7)],
            Floats::restore(Vec::new(), layout, false),
        ),
    );
    layouts.fit_to(BODY);
    for &pane in panes {
        layouts.add_float(OWNER, entry(pane));
    }
    layouts
}

/// Every float's frame in the tests' body, bottom first.
fn float_frames(layouts: &Layouts) -> Vec<Rect> {
    layouts
        .get(OWNER)
        .map(|layout| {
            layout
                .floats()
                .visible(BODY)
                .map(|(_, frame, _)| frame)
                .collect()
        })
        .unwrap_or_default()
}

#[rstest::rstest]
fn adding_a_float_to_floats_moved_by_hand_does_not_re_lay_them() {
    // Given a float moved two steps right, at (28, 6).
    let mut layouts = with_float_moved(&[(NavDirection::Right, 2)]);

    // When adding float 21.
    layouts.add_float(OWNER, entry(21));

    // Then the moved float stays put and float 21 takes the staggered spot.
    assert_eq!(
        float_frames(&layouts),
        vec![Rect::new(28, 6, 40, 12), Rect::new(20, 6, 40, 12)],
        "floats moved by hand keep their places"
    );
}

#[rstest::rstest]
fn fifth_float_under_spread_moves_to_the_next_fitting_layout() {
    // Given four spread floats.
    let mut layouts = floats_in(FloatLayout::Spread, &[20, 21, 22, 23]);

    // When adding a fifth.
    layouts.add_float(OWNER, entry(24));

    // Then the floats are staggered.
    assert_eq!(
        layouts.get(OWNER).map(|layout| layout.floats().layout()),
        Some(FloatLayout::Staggered),
        "spread fits at most four floats"
    );
}

#[rstest::rstest]
fn cycle_float_layout_without_a_float_focused_changes_nothing() {
    // Given a float, hidden.
    let mut layouts = floats_in(FloatLayout::Staggered, &[20]);
    layouts.toggle_floats(OWNER);

    // When cycling the float layout.
    let cycled = layouts.cycle_float_layout(OWNER, false);

    // Then nothing is cycled.
    assert!(!cycled, "hidden floats don't have the keys to cycle");
}

#[rstest::rstest]
fn closing_a_float_re_lays_the_rest() {
    // Given three enlarged floats, a row apart.
    let mut layouts = floats_in(FloatLayout::Enlarged, &[20, 21, 22]);

    // When closing the middle one.
    layouts.close_pane(PaneId(21));

    // Then the other two sit on rows 1 and 2.
    assert_eq!(
        float_frames(&layouts),
        vec![Rect::new(4, 1, 72, 21), Rect::new(4, 2, 72, 21)],
        "the floats above a closed one move into its place"
    );
}

#[rstest::rstest]
fn embedding_a_float_re_lays_the_rest() {
    // Given two spread floats.
    let mut layouts = floats_in(FloatLayout::Spread, &[20, 21]);

    // When putting the top float back into the tab and showing the floats.
    layouts.embed_float(OWNER);
    layouts.toggle_floats(OWNER);

    // Then the other float takes spread's place for one float.
    assert_eq!(
        float_frames(&layouts),
        vec![Rect::new(40, 12, 40, 12)],
        "the float left takes the one-float place"
    );
}

#[rstest::rstest]
fn reveal_on_a_hidden_float_shows_it_on_top() {
    // Given floats 20 and 21 over two panes, 21 on top, hidden.
    let mut layouts = split_with_two_floats();
    layouts.toggle_floats(OWNER);

    // When revealing float 20.
    layouts.reveal(OWNER, PaneId(20));

    // Then float 20 is shown on top with the keys.
    assert_eq!(
        focused(&layouts),
        Some(PaneId(20)),
        "revealing a float shows the floats with it on top"
    );
}

#[rstest::rstest]
fn reveal_on_a_tiled_pane_hides_the_floats() {
    // Given floats 20 and 21 shown over panes 7 and 8.
    let mut layouts = split_with_two_floats();

    // When revealing pane 7.
    layouts.reveal(OWNER, PaneId(7));

    // Then the floats are hidden and pane 7 has the keys.
    assert_eq!(
        (
            layouts.get(OWNER).map(SessionLayout::float_focused),
            focused(&layouts)
        ),
        (Some(false), Some(PaneId(7))),
        "revealing a tiled pane hides the floats"
    );
}

#[rstest::rstest]
fn move_float_to_after_a_move_the_next_add_does_not_relay() {
    // Given float 20 dragged to (5, 5).
    let mut layouts = floats_in(FloatLayout::Staggered, &[20]);
    layouts.move_float_to(OWNER, PaneId(20), 5, 5);

    // When adding float 21.
    layouts.add_float(OWNER, entry(21));

    // Then float 20 stays where it was dragged.
    assert_eq!(
        float_frames(&layouts).first(),
        Some(&Rect::new(5, 5, 40, 12)),
        "a dragged float is changed by hand and not laid out again"
    );
}

/// Agent 7 titled `title`, for naming pane 7.
fn titled(title: Option<&str>) -> Agent {
    Agent {
        harness: HarnessId::new("claude"),
        id: AgentId(7),
        title: title.map(str::to_owned),
        cwd: "/work".into(),
        transcript: None,
        status: AgentStatus::Idle,
        turn_started_at: None,
        pane: None,
        last_session: None,
        branch: None,
        created_at: UNIX_EPOCH,
        last_activity_at: UNIX_EPOCH,
        unseen: false,
        model: None,
    }
}

#[rstest::rstest]
#[case::pane_name(Some("api"), Some("fix"), "api")]
#[case::title(None, Some("fix"), "fix")]
#[case::new_agent(None, None, "New agent")]
fn agent_name_prefers_pane_name_then_title_then_new_agent(
    #[case] pane_name: Option<&str>,
    #[case] title: Option<&str>,
    #[case] expected: &str,
) {
    // Given pane 7 named `pane_name`, running an agent titled `title`.
    let mut layouts = opened();
    layouts.rename_pane(PaneId(7), pane_name.map(str::to_owned));
    let agent = titled(title);

    // When naming its agent.
    let name = layouts.agent_name(PaneId(7), Some(&agent));

    // Then it is `expected`.
    assert_eq!(name, expected, "pane {pane_name:?}, title {title:?}");
}

/// Fails the test if a pane of `before` is in neither `after` nor `closed`.
fn assert_no_pane_lost(before: &HashSet<PaneId>, after: &Layouts, closed: &[PaneId]) {
    let lost: Vec<PaneId> = {
        let kept = after.pane_ids();
        let mut lost: Vec<PaneId> = before
            .iter()
            .filter(|pane| !kept.contains(pane) && !closed.contains(pane))
            .copied()
            .collect();
        lost.sort_unstable_by_key(|pane| pane.0);
        lost
    };
    assert!(lost.is_empty(), "lost panes {lost:?}");
}

/// Session 1's layout with tiles and a float: tab 1 holds pane 1 split
/// right with pane 2, and pane 3 stacked on pane 2; tab 2 holds pane 4;
/// float pane 5 is hidden, so tab 1 is shown with the keys.
fn seams() -> Layouts {
    let mut layouts = Layouts::default();
    layouts.insert(session(1), SessionLayout::of(entry(pane(1).0)));
    layouts.fit_to(BODY);
    layouts.split(session(1), Split::Right, entry(pane(2).0));
    layouts.stack(session(1), entry(pane(3).0));
    layouts.new_tab(session(1), entry(pane(4).0));
    layouts.go_to_tab(session(1), 1);
    layouts.add_float(session(1), entry(pane(5).0));
    layouts.toggle_floats(session(1));
    layouts
}

/// [`seams`] with the floats shown, float pane 5 having the keys.
fn seams_on_float() -> Layouts {
    let mut layouts = seams();
    layouts.toggle_floats(session(1));
    layouts
}

/// [`seams`] with tab 2 shown.
fn seams_on_tab_2() -> Layouts {
    let mut layouts = seams();
    layouts.go_to_tab(session(1), 2);
    layouts
}

#[rstest::rstest]
#[case::split(seams, |l: &mut Layouts| l.split(session(1), Split::Right, entry(pane(9).0)))]
#[case::stack(seams, |l: &mut Layouts| l.stack(session(1), entry(pane(9).0)))]
#[case::add_tiled(seams, |l: &mut Layouts| l.add_tiled(session(1), entry(pane(9).0)))]
#[case::new_tab(seams, |l: &mut Layouts| l.new_tab(session(1), entry(pane(9).0)))]
#[case::add_float(seams, |l: &mut Layouts| l.add_float(session(1), entry(pane(9).0)))]
#[case::float_pane(seams, |l: &mut Layouts| { l.float_pane(session(1)); })]
#[case::embed_float(seams_on_float, |l: &mut Layouts| { l.embed_float(session(1)); })]
#[case::toggle_floats(seams, |l: &mut Layouts| { l.toggle_floats(session(1)); })]
#[case::toggle_pin(seams_on_float, |l: &mut Layouts| { l.toggle_pin(session(1)); })]
#[case::break_pane(seams, |l: &mut Layouts| l.break_pane(session(1)))]
#[case::move_focus(seams, |l: &mut Layouts| { l.move_focus(session(1), NavDirection::Left); })]
#[case::focus_pane(seams, |l: &mut Layouts| l.focus_pane(session(1), pane(1)))]
#[case::reveal(seams, |l: &mut Layouts| l.reveal(session(1), pane(4)))]
#[case::toggle_zoom(seams, |l: &mut Layouts| l.toggle_zoom(session(1)))]
#[case::resize_focused(seams, |l: &mut Layouts| { l.resize_focused(session(1), true); })]
#[case::resize_side(seams, |l: &mut Layouts| { l.resize_side(session(1), NavDirection::Right, true); })]
#[case::move_pane(seams, |l: &mut Layouts| { l.move_pane(session(1), NavDirection::Left); })]
#[case::move_pane_in_order(seams, |l: &mut Layouts| { l.move_pane_in_order(session(1), true); })]
#[case::go_to_tab(seams, |l: &mut Layouts| l.go_to_tab(session(1), 2))]
#[case::next_swap_layout(seams, |l: &mut Layouts| l.next_swap_layout(session(1)))]
#[case::previous_swap_layout(seams, |l: &mut Layouts| l.previous_swap_layout(session(1)))]
#[case::cycle_float_layout(seams_on_float, |l: &mut Layouts| { l.cycle_float_layout(session(1), false); })]
#[case::move_float_to(seams_on_float, |l: &mut Layouts| { l.move_float_to(session(1), pane(5), 2, 2); })]
#[case::move_tab_left(seams_on_tab_2, |l: &mut Layouts| l.move_tab_left(session(1)))]
#[case::move_tab_right(seams, |l: &mut Layouts| l.move_tab_right(session(1)))]
#[case::rename_pane(seams, |l: &mut Layouts| l.rename_pane(pane(1), Some("api".into())))]
#[case::rename_tab(seams, |l: &mut Layouts| l.rename_tab(session(1), 0, Some("agent".into())))]
#[case::fit_to(seams, |l: &mut Layouts| l.fit_to(Rect::new(0, 0, 40, 12)))]
#[case::remember_resume(seams, |l: &mut Layouts| l.remember_resume(pane(1), Some("claude --resume x".into())))]
#[case::move_session(seams, |l: &mut Layouts| l.move_session(session(1), std::path::Path::new("/wt")))]
fn tree_operation_loses_no_pane(#[case] given: fn() -> Layouts, #[case] op: fn(&mut Layouts)) {
    // Given a layout of tiles, stacks, tabs and a float.
    let mut layouts = given();
    let before = layouts.pane_ids();

    // When running the operation.
    op(&mut layouts);

    // Then every pane it held is still held.
    assert_no_pane_lost(&before, &layouts, &[]);
}

#[rstest::rstest]
#[case::close_pane(|l: &mut Layouts| l.close_pane(pane(2)), &[2])]
#[case::close_tab(|l: &mut Layouts| l.close_tab(session(1)), &[1, 2, 3])]
fn closing_loses_only_the_closed_panes(#[case] op: fn(&mut Layouts), #[case] closed: &[i64]) {
    // Given a layout of tiles, stacks, tabs and a float, tab 1 shown.
    let mut layouts = seams();
    let before = layouts.pane_ids();
    let closed: Vec<PaneId> = closed.iter().map(|&n| pane(n)).collect();

    // When closing.
    op(&mut layouts);

    // Then only the closed panes are gone.
    assert_no_pane_lost(&before, &layouts, &closed);
}

#[rstest::rstest]
fn split_at_in_a_hidden_tab_changes_that_tab() {
    // Given session 1 with tabs of pane 7 and pane 8, the second shown.
    let mut layouts = opened();
    layouts.new_tab(OWNER, entry(8));

    // When splitting pane 7 right with pane 9.
    layouts.split_at(OWNER, PaneId(7), Split::Right, entry(9));

    // Then the first tab holds pane 9, the shown second tab doesn't, and it
    // stays shown.
    let holds = |index: usize| {
        layouts
            .get(OWNER)
            .and_then(|layout| layout.tabs().get(index))
            .is_some_and(|tab| tab.holds(PaneId(9)))
    };
    assert_eq!(
        (holds(0), holds(1), active(&layouts)),
        (true, false, Some(1)),
        "the split lands in the hidden tab holding pane 7"
    );
}

#[rstest::rstest]
#[case::split_at(|layouts: &mut Layouts| layouts.split_at(OWNER, PaneId(7), Split::Down, entry(9)))]
#[case::stack_at(|layouts: &mut Layouts| layouts.stack_at(OWNER, PaneId(7), entry(9)))]
#[case::new_tab_keeping_shown(|layouts: &mut Layouts| layouts.new_tab_keeping_shown(OWNER, entry(9)))]
#[case::add_float_hidden(|layouts: &mut Layouts| layouts.add_float_hidden(OWNER, entry(9)))]
fn api_adds_keep_the_pane_with_the_keys(#[case] add: fn(&mut Layouts) -> bool) {
    // Given pane 7 beside pane 8, pane 8 focused.
    let mut layouts = split_right();
    let before = (active(&layouts), focused(&layouts));

    // When adding pane 9 by name.
    add(&mut layouts);

    // Then the shown tab and its focused pane stay.
    assert_eq!(
        (active(&layouts), focused(&layouts)),
        before,
        "an API add leaves the keys where they were"
    );
}
