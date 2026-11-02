use ratatui::layout::Rect;

use super::{
    Grow, NavDirection, Node, PaneInfo, Split, SwapLayout, TileLayout, columns, find_in_direction,
};
use crate::ids::PaneId;

const AREA: Rect = Rect::new(0, 0, 100, 40);

fn pane(id: i64) -> PaneId {
    PaneId(id)
}

fn split(split: Split, ratio: f32, first: Node, second: Node) -> Node {
    Node::Split {
        split,
        ratio,
        first: Box::new(first),
        second: Box::new(second),
    }
}

/// Pane 1 on the left third; on the right, pane 2 on top and panes 3
/// and 4 side by side below it. Pane 2 has the focus.
fn sample_layout() -> TileLayout {
    TileLayout::from_saved(
        split(
            Split::Right,
            0.3,
            Node::Pane(pane(1)),
            split(
                Split::Down,
                0.6,
                Node::Pane(pane(2)),
                split(Split::Right, 0.4, Node::Pane(pane(3)), Node::Pane(pane(4))),
            ),
        ),
        pane(2),
    )
}

/// Panes 1 and 2 side by side, pane `focus` focused.
fn halves(focus: i64) -> TileLayout {
    TileLayout::from_saved(
        split(Split::Right, 0.5, Node::Pane(pane(1)), Node::Pane(pane(2))),
        pane(focus),
    )
}

fn rects(layout: &TileLayout) -> Vec<(PaneId, Rect)> {
    layout
        .panes(AREA)
        .into_iter()
        .map(|info| (info.id, info.rect))
        .collect()
}

fn ratio(layout: &TileLayout) -> Option<f32> {
    match layout.root {
        Node::Split { ratio, .. } => Some(ratio),
        _ => None,
    }
}

/// A layout of panes 1 to `n`, each added with `add_tiled` in vertical.
fn tiled(n: i64) -> TileLayout {
    tiled_as(n, SwapLayout::Vertical)
}

/// A layout of panes 1 to `n`, each added with `add_tiled` in `layout`.
fn tiled_as(n: i64, layout: SwapLayout) -> TileLayout {
    let mut tree = TileLayout::new(pane(1));
    for id in 2..=n {
        tree.add_tiled(pane(id), layout);
    }
    tree
}

/// How many panes each row holds, top to bottom.
fn rows_of(layout: &TileLayout, area: Rect) -> Vec<usize> {
    layout
        .panes(area)
        .chunk_by(|a, b| a.rect.y == b.rect.y)
        .map(<[PaneInfo]>::len)
        .collect()
}

/// Every pane's rect in `area`, in tree order.
fn rects_in(layout: &TileLayout, area: Rect) -> Vec<(PaneId, Rect)> {
    layout
        .panes(area)
        .into_iter()
        .map(|info| (info.id, info.rect))
        .collect()
}

/// Every stack's panes, in tree order.
fn stacked(layout: &TileLayout) -> Vec<Vec<PaneId>> {
    layout
        .stacks(AREA)
        .into_iter()
        .map(|stack| stack.panes)
        .collect()
}

/// The pane rects in `area`, one list per column, left to right.
fn columns_of(layout: &TileLayout, area: Rect) -> Vec<Vec<Rect>> {
    layout
        .panes(area)
        .chunk_by(|a, b| a.rect.x == b.rect.x)
        .map(|column| column.iter().map(|info| info.rect).collect())
        .collect()
}

/// How many panes each column holds, left to right.
fn shape(layout: &TileLayout, area: Rect) -> Vec<usize> {
    columns_of(layout, area).iter().map(Vec::len).collect()
}

/// The biggest gap between any two of `sizes`.
fn spread(sizes: &[u16]) -> u16 {
    let max = sizes.iter().max().copied().unwrap_or_default();
    let min = sizes.iter().min().copied().unwrap_or_default();
    max - min
}

fn info(layout: &TileLayout, id: i64) -> Option<PaneInfo> {
    layout
        .panes(AREA)
        .into_iter()
        .find(|info| info.id == pane(id))
}

#[rstest::rstest]
fn split_right_puts_the_new_pane_beside_the_focused_one() {
    // Given a layout of pane 1.
    let mut layout = TileLayout::new(pane(1));

    // When splitting it right with pane 2.
    layout.split_focused(Split::Right, pane(2));

    // Then pane 1 takes the left half and pane 2 the right half.
    assert_eq!(
        rects(&layout),
        vec![
            (pane(1), Rect::new(0, 0, 50, 40)),
            (pane(2), Rect::new(50, 0, 50, 40)),
        ],
        "a right split should put the panes side by side"
    );
}

#[rstest::rstest]
fn split_down_puts_the_new_pane_below_the_focused_one() {
    // Given a layout of pane 1.
    let mut layout = TileLayout::new(pane(1));

    // When splitting it down with pane 2.
    layout.split_focused(Split::Down, pane(2));

    // Then pane 1 takes the top half and pane 2 the bottom half.
    assert_eq!(
        rects(&layout),
        vec![
            (pane(1), Rect::new(0, 0, 100, 20)),
            (pane(2), Rect::new(0, 20, 100, 20)),
        ],
        "a down split should stack the panes"
    );
}

#[rstest::rstest]
fn split_focuses_the_new_pane() {
    // Given a layout of pane 1.
    let mut layout = TileLayout::new(pane(1));

    // When splitting it with pane 2.
    layout.split_focused(Split::Right, pane(2));

    // Then pane 2 has the focus.
    assert_eq!(layout.focused(), pane(2), "the new pane should be focused");
}

#[rstest::rstest]
fn split_right_beside_two_columns_gives_three_equal_columns() {
    // Given panes 1 and 2 side by side, pane 2 focused.
    let mut layout = halves(2);

    // When splitting pane 2 right with pane 3.
    layout.split_focused(Split::Right, pane(3));

    // Then the tab is three columns of equal width.
    let widths: Vec<u16> = columns_of(&layout, AREA)
        .iter()
        .filter_map(|column| column.first().map(|rect| rect.width))
        .collect();
    assert_eq!(
        (shape(&layout, AREA), spread(&widths) <= 1),
        (vec![1, 1, 1], true),
        "a right split beside two columns should give three even columns, widths {widths:?}"
    );
}

#[rstest::rstest]
fn split_down_inside_the_middle_column_keeps_the_columns_at_thirds() {
    // Given three equal columns of panes 1, 2 and 3, pane 2 focused.
    let mut layout = TileLayout::from_saved(
        split(
            Split::Right,
            1.0 / 3.0,
            Node::Pane(pane(1)),
            split(Split::Right, 0.5, Node::Pane(pane(2)), Node::Pane(pane(3))),
        ),
        pane(2),
    );

    // When splitting pane 2 down with pane 4.
    layout.split_focused(Split::Down, pane(4));

    // Then only the middle column holds two panes, and the columns stay at thirds.
    let widths: Vec<u16> = columns_of(&layout, AREA)
        .iter()
        .filter_map(|column| column.first().map(|rect| rect.width))
        .collect();
    assert_eq!(
        (shape(&layout, AREA), spread(&widths) <= 1),
        (vec![1, 2, 1], true),
        "a down split should divide only its column, widths {widths:?}"
    );
}

#[rstest::rstest]
fn close_focused_returns_to_the_pane_focus_came_from() {
    // Given the sample layout with the focus moved from pane 2 to pane 4.
    let mut layout = sample_layout();
    layout.focus_pane(pane(4));

    // When closing the focused pane.
    let closed = layout.close_focused();

    // Then the focus is back on pane 2.
    assert_eq!(
        (closed, layout.focused()),
        (true, pane(2)),
        "closing should return the focus to where it came from"
    );
}

#[rstest::rstest]
fn close_focused_returns_to_the_pane_that_opened_a_split() {
    // Given three panes, and pane 1 then split with pane 4.
    let mut layout = TileLayout::new(pane(1));
    layout.split_focused(Split::Right, pane(2));
    layout.split_focused(Split::Down, pane(3));
    layout.focus_pane(pane(1));
    layout.split_focused(Split::Right, pane(4));

    // When closing pane 4.
    layout.close_focused();

    // Then pane 1 has the focus again.
    assert_eq!(
        layout.focused(),
        pane(1),
        "closing a fresh split should return to the pane that opened it"
    );
}

#[rstest::rstest]
fn closing_a_background_pane_keeps_the_focus() {
    // Given the sample layout focused on pane 4.
    let mut layout = sample_layout();
    layout.focus_pane(pane(4));

    // When closing pane 1, which isn't focused.
    layout.close_pane(pane(1));

    // Then pane 4 keeps the focus.
    assert_eq!(
        layout.focused(),
        pane(4),
        "closing another pane should leave the focus alone"
    );
}

#[rstest::rstest]
fn close_focused_uses_tree_order_without_focus_history() {
    // Given the sample layout with no focus moves.
    let mut layout = sample_layout();

    // When closing the focused pane 2.
    layout.close_focused();

    // Then the next pane in tree order, pane 3, has the focus.
    assert_eq!(
        layout.focused(),
        pane(3),
        "without history the next pane should take the focus"
    );
}

#[rstest::rstest]
fn closing_the_last_pane_is_refused() {
    // Given a layout of one pane.
    let mut layout = TileLayout::new(pane(1));

    // When closing it.
    let closed = layout.close_focused();

    // Then nothing closes.
    assert!(!closed, "the last pane should not close");
}

#[rstest::rstest]
#[case(3, NavDirection::Left, 1)]
#[case(3, NavDirection::Right, 4)]
#[case(3, NavDirection::Up, 2)]
#[case(2, NavDirection::Down, 4)]
fn find_in_direction_finds_the_neighbour(
    #[case] from: i64,
    #[case] nav: NavDirection,
    #[case] expected: i64,
) {
    // Given the sample layout.
    let layout = sample_layout();
    let panes = layout.panes(AREA);

    // When looking from pane `from` in direction `nav`.
    let found = info(&layout, from).and_then(|from| find_in_direction(&from, nav, &panes));

    // Then the neighbour is found.
    assert_eq!(found, Some(pane(expected)), "neighbour of the pane");
}

#[rstest::rstest]
fn find_in_direction_finds_nothing_past_the_edge() {
    // Given the sample layout.
    let layout = sample_layout();
    let panes = layout.panes(AREA);

    // When looking left from the leftmost pane 1.
    let found =
        info(&layout, 1).and_then(|from| find_in_direction(&from, NavDirection::Left, &panes));

    // Then nothing is there.
    assert_eq!(found, None, "nothing should be left of the leftmost pane");
}

#[rstest::rstest]
fn find_in_direction_tiebreaks_by_larger_overlap() {
    // Given a pane with two panes to its left, the second overlapping it more.
    let at = |id, rect| PaneInfo {
        id: pane(id),
        rect,
        is_focused: false,
        collapsed: false,
    };
    let focused = at(1, Rect::new(10, 10, 10, 10));
    let panes = [
        focused,
        at(2, Rect::new(0, 10, 10, 2)),
        at(3, Rect::new(0, 10, 10, 8)),
    ];

    // When looking left.
    let found = find_in_direction(&focused, NavDirection::Left, &panes);

    // Then the one with the larger overlap wins.
    assert_eq!(found, Some(pane(3)), "larger overlap should win the tie");
}

#[rstest::rstest]
fn layout_json_roundtrips() {
    // Given a three-pane tree focused on pane 3.
    let mut layout = TileLayout::new(pane(1));
    layout.split_focused(Split::Right, pane(2));
    layout.split_focused(Split::Down, pane(3));

    // When saving and loading it.
    let loaded = TileLayout::from_json(&layout.to_json(), pane(3)).ok();

    // Then the panes land in the same places with the same focus.
    assert_eq!(
        loaded.map(|loaded| (rects(&loaded), loaded.focused())),
        Some((rects(&layout), pane(3))),
        "the loaded tree should match the saved one"
    );
}

#[rstest::rstest]
fn layout_json_names_splits_right_and_down() {
    // Given panes 1 and 2 side by side.
    let layout = halves(1);

    // When saving it.
    let json = layout.to_json();

    // Then the split is named right.
    assert_eq!(
        json, r#"{"split":"right","ratio":0.5,"first":{"pane":1},"second":{"pane":2}}"#,
        "the saved tree's shape"
    );
}

#[rstest::rstest]
fn from_json_falls_back_to_the_first_pane_for_an_unknown_focus() {
    // Given a saved two-pane tree.
    let json = halves(2).to_json();

    // When loading it focused on a pane it doesn't hold.
    let loaded = TileLayout::from_json(&json, pane(9)).ok();

    // Then its first pane has the focus.
    assert_eq!(
        loaded.map(|loaded| loaded.focused()),
        Some(pane(1)),
        "an unknown focus should fall back to the first pane"
    );
}

#[rstest::rstest]
fn from_json_rejects_text_that_isnt_a_tree() {
    // Given text that isn't a saved tree.
    let json = r#"{"tabs":3}"#;

    // When loading it.
    let loaded = TileLayout::from_json(json, pane(1));

    // Then it is refused.
    assert!(loaded.is_err(), "a non-tree should be rejected");
}

#[rstest::rstest]
#[case(1, vec![1])]
#[case(2, vec![1, 1])]
#[case(3, vec![1, 2])]
#[case(4, vec![1, 3])]
#[case(5, vec![1, 4])]
#[case(6, vec![2, 4])]
#[case(7, vec![1, 4, 2])]
#[case(8, vec![1, 4, 3])]
#[case(9, vec![1, 4, 4])]
#[case(10, vec![2, 4, 4])]
fn columns_follow_the_template_table(#[case] n: usize, #[case] expected: Vec<usize>) {
    // Given / When / Then the column sizes for n panes match the table.
    assert_eq!(columns(n), expected, "columns for {n} panes");
}

#[rstest::rstest]
#[case(1, vec![1])]
#[case(2, vec![1, 1])]
#[case(3, vec![1, 2])]
#[case(4, vec![1, 3])]
#[case(5, vec![1, 4])]
#[case(6, vec![2, 4])]
#[case(7, vec![1, 4, 2])]
#[case(8, vec![1, 4, 3])]
#[case(9, vec![1, 4, 4])]
#[case(10, vec![2, 4, 4])]
fn panes_added_one_at_a_time_follow_the_template_table(
    #[case] n: i64,
    #[case] expected: Vec<usize>,
) {
    // Given panes added one at a time up to n.
    let layout = tiled(n);

    // When laying them out.
    let shape = shape(&layout, AREA);

    // Then each column holds the table's pane count.
    assert_eq!(shape, expected, "shape for {n} panes");
}

#[rstest::rstest]
fn panes_added_one_at_a_time_keep_even_sizes(#[values(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)] n: i64) {
    // Given panes added one at a time up to n.
    let layout = tiled(n);

    // When laying them out.
    let columns = columns_of(&layout, AREA);

    // Then column widths differ by at most one cell, and so do the row
    // heights within each column.
    let widths: Vec<u16> = columns
        .iter()
        .filter_map(|column| column.first().map(|rect| rect.width))
        .collect();
    let heights: Vec<Vec<u16>> = columns
        .iter()
        .map(|column| column.iter().map(|rect| rect.height).collect())
        .collect();
    assert!(
        spread(&widths) <= 1 && heights.iter().all(|column| spread(column) <= 1),
        "uneven sizes for {n} panes, widths {widths:?}, heights {heights:?}"
    );
}

#[rstest::rstest]
fn tiled_columns_share_the_width_evenly() {
    // Given seven tiled panes.
    let layout = tiled(7);

    // When laying them out in a 120×40 area.
    let widths: Vec<u16> = columns_of(&layout, Rect::new(0, 0, 120, 40))
        .iter()
        .filter_map(|column| column.first().map(|rect| rect.width))
        .collect();

    // Then the column widths differ by at most one cell.
    assert!(spread(&widths) <= 1, "uneven column widths {widths:?}");
}

#[rstest::rstest]
fn tiled_column_rows_share_the_height_evenly() {
    // Given five tiled panes, one column then four.
    let layout = tiled(5);

    // When laying them out in a 40-row area.
    let heights: Vec<u16> = columns_of(&layout, AREA)
        .get(1)
        .map(|column| column.iter().map(|rect| rect.height).collect())
        .unwrap_or_default();

    // Then the second column's four heights differ by at most one row.
    assert!(
        heights.len() == 4 && spread(&heights) <= 1,
        "uneven row heights {heights:?}"
    );
}

#[rstest::rstest]
fn add_tiled_lays_six_panes_out_two_and_four() {
    // Given five tiled panes.
    let mut layout = tiled(5);

    // When adding pane 6.
    layout.add_tiled(pane(6), SwapLayout::Vertical);

    // Then two panes sit in the first column and four in the second.
    assert_eq!(shape(&layout, AREA), vec![2, 4], "six panes tile [2][4]");
}

#[rstest::rstest]
fn add_tiled_focuses_the_new_pane() {
    // Given five tiled panes.
    let mut layout = tiled(5);

    // When adding pane 6.
    layout.add_tiled(pane(6), SwapLayout::Vertical);

    // Then pane 6 has the focus.
    assert_eq!(
        layout.focused(),
        pane(6),
        "the added pane should be focused"
    );
}

#[rstest::rstest]
fn add_tiled_evens_out_a_resized_tab() {
    // Given three tiled panes with the focused pane's border moved.
    let mut layout = tiled(3);
    layout.grow_focused(AREA);

    // When adding pane 4.
    layout.add_tiled(pane(4), SwapLayout::Vertical);

    // Then the tab is one column then three, every size even again.
    let columns = columns_of(&layout, AREA);
    let widths: Vec<u16> = columns
        .iter()
        .filter_map(|column| column.first().map(|rect| rect.width))
        .collect();
    let heights: Vec<u16> = columns
        .get(1)
        .map(|column| column.iter().map(|rect| rect.height).collect())
        .unwrap_or_default();
    assert_eq!(
        (
            shape(&layout, AREA),
            spread(&widths) <= 1,
            spread(&heights) <= 1
        ),
        (vec![1, 3], true, true),
        "the re-tiled tab should be [1][3] with even sizes, widths {widths:?}, heights {heights:?}"
    );
}

/// Panes `ids` stacked, pane `expanded` expanded.
fn stack_of(ids: &[i64], expanded: i64) -> Node {
    Node::Stack {
        panes: ids.iter().copied().map(pane).collect(),
        expanded: pane(expanded),
    }
}

/// Pane 1 on the left half; panes 2, 3 and 4 stacked on the right half,
/// pane `expanded` expanded. Pane `focus` has the focus.
fn main_and_stack(expanded: i64, focus: i64) -> TileLayout {
    TileLayout::from_saved(
        split(
            Split::Right,
            0.5,
            Node::Pane(pane(1)),
            stack_of(&[2, 3, 4], expanded),
        ),
        pane(focus),
    )
}

/// The stacked pane that gets rows of its own.
fn expanded(layout: &TileLayout) -> Option<PaneId> {
    layout.stacks(AREA).first().map(|stack| stack.expanded)
}

#[rstest::rstest]
fn stacked_template_is_one_stack_of_every_pane() {
    // Given eleven panes tiled in stacked.
    let layout = tiled_as(11, SwapLayout::Stacked);

    // When laying them out.
    let collapsed = layout
        .panes(AREA)
        .iter()
        .filter(|info| info.collapsed)
        .count();

    // Then all eleven sit in one stack, ten of them titles.
    assert_eq!(
        (shape(&layout, AREA), collapsed),
        (vec![11], 10),
        "eleven panes tile as one stack"
    );
}

#[rstest::rstest]
fn stacked_template_expands_the_focused_pane() {
    // Given four panes tiled vertical, pane 2 focused.
    let mut layout = tiled(4);
    layout.focus_pane(pane(2));

    // When re-tiling in stacked.
    layout.tile(SwapLayout::Stacked);

    // Then pane 2 is the stack's expanded pane.
    assert_eq!(
        expanded(&layout),
        Some(pane(2)),
        "the focused pane should be expanded"
    );
}

#[rstest::rstest]
fn half_stacked_template_puts_the_first_pane_on_the_left_half() {
    // Given four panes tiled in half-stacked.
    let layout = tiled_as(4, SwapLayout::HalfStacked);

    // When laying them out.
    let left = info(&layout, 1).map(|info| info.rect);

    // Then pane 1 takes the left half and panes 2 to 4 are one stack.
    assert_eq!(
        (left, stacked(&layout)),
        (
            Some(Rect::new(0, 0, 50, 40)),
            vec![vec![pane(2), pane(3), pane(4)]]
        ),
        "half-stacked puts pane 1 on the left half beside one stack"
    );
}

#[rstest::rstest]
#[case(1, vec![1])]
#[case(2, vec![1, 1])]
#[case(3, vec![1, 2])]
#[case(4, vec![1, 3])]
#[case(5, vec![1, 4])]
#[case(6, vec![2, 4])]
#[case(7, vec![1, 4, 2])]
#[case(8, vec![1, 4, 3])]
#[case(9, vec![1, 4, 4])]
#[case(10, vec![2, 4, 4])]
fn horizontal_template_lays_rows_from_the_table(#[case] n: i64, #[case] expected: Vec<usize>) {
    // Given n panes tiled in horizontal.
    let layout = tiled_as(n, SwapLayout::Horizontal);

    // When laying them out.
    let rows = rows_of(&layout, AREA);

    // Then each row holds the table's pane count.
    assert_eq!(rows, expected, "rows for {n} panes");
}

#[rstest::rstest]
#[case(SwapLayout::Base, 1, true)]
#[case(SwapLayout::Base, 2, false)]
#[case(SwapLayout::Vertical, 10, true)]
#[case(SwapLayout::Vertical, 11, false)]
#[case(SwapLayout::Horizontal, 10, true)]
#[case(SwapLayout::Horizontal, 11, false)]
#[case(SwapLayout::Stacked, 1, false)]
#[case(SwapLayout::Stacked, 2, true)]
#[case(SwapLayout::HalfStacked, 2, false)]
#[case(SwapLayout::HalfStacked, 3, true)]
fn swap_layout_fits_from_the_table(
    #[case] layout: SwapLayout,
    #[case] n: usize,
    #[case] fits: bool,
) {
    // Given / When searching for a fitting layout from the layout itself.
    let found = layout.fitting(n, false, false);

    // Then it finds itself only when it fits n panes.
    assert_eq!(found == Some(layout), fits, "{layout:?} fitting {n} panes");
}

#[rstest::rstest]
fn stack_focused_on_a_lone_pane_stacks_the_new_pane_shown() {
    // Given a lone pane 1.
    let mut layout = TileLayout::new(pane(1));

    // When stacking pane 2 with it.
    layout.stack_focused(pane(2));

    // Then panes 1 and 2 are a stack with pane 2 expanded and focused.
    assert_eq!(
        (
            layout
                .stacks(AREA)
                .into_iter()
                .next()
                .map(|stack| stack.panes),
            expanded(&layout),
            layout.focused()
        ),
        (Some(vec![pane(1), pane(2)]), Some(pane(2)), pane(2)),
        "the new pane is stacked after the focused one and shown"
    );
}

#[rstest::rstest]
fn stack_focused_in_a_stack_inserts_after_the_focused_pane() {
    // Given pane 1 beside a stack of 2, 3 and 4, pane 2 focused.
    let mut layout = main_and_stack(2, 2);

    // When stacking pane 5.
    layout.stack_focused(pane(5));

    // Then pane 5 sits right after pane 2.
    assert_eq!(
        layout
            .stacks(AREA)
            .into_iter()
            .next()
            .map(|stack| stack.panes),
        Some(vec![pane(2), pane(5), pane(3), pane(4)]),
        "the new pane goes right after the focused one"
    );
}

#[rstest::rstest]
fn stack_focused_outside_every_stack_starts_a_new_one() {
    // Given pane 1 beside a stack of 2, 3 and 4, pane 1 focused.
    let mut layout = main_and_stack(3, 1);

    // When stacking pane 5.
    layout.stack_focused(pane(5));

    // Then panes 1 and 5 are a second stack beside the first.
    assert_eq!(
        layout
            .stacks(AREA)
            .into_iter()
            .map(|stack| stack.panes)
            .collect::<Vec<_>>(),
        vec![vec![pane(1), pane(5)], vec![pane(2), pane(3), pane(4)]],
        "a pane outside every stack starts its own stack"
    );
}

/// A stack of panes 1 and 2 (1 expanded) on the left half beside a stack
/// of panes 3 and 4 (3 expanded) on the right half. Pane `focus` has the
/// focus.
fn two_stacks(focus: i64) -> TileLayout {
    TileLayout::from_saved(
        split(
            Split::Right,
            0.5,
            stack_of(&[1, 2], 1),
            stack_of(&[3, 4], 3),
        ),
        pane(focus),
    )
}

#[rstest::rstest]
fn stack_focused_joins_the_focused_panes_own_stack() {
    // Given two stacks, pane 3 in the second one focused.
    let mut layout = two_stacks(3);

    // When stacking pane 5.
    layout.stack_focused(pane(5));

    // Then pane 5 sits right after pane 3 in the second stack.
    assert_eq!(
        layout
            .stacks(AREA)
            .into_iter()
            .map(|stack| stack.panes)
            .collect::<Vec<_>>(),
        vec![vec![pane(1), pane(2)], vec![pane(3), pane(5), pane(4)]],
        "the new pane joins the focused pane's own stack"
    );
}

#[rstest::rstest]
fn stacks_lists_every_stack_in_tree_order() {
    // Given two stacks side by side.
    let layout = two_stacks(1);

    // When listing the stacks.
    let stacks: Vec<(Rect, Vec<PaneId>)> = layout
        .stacks(AREA)
        .into_iter()
        .map(|stack| (stack.area, stack.panes))
        .collect();

    // Then the left stack comes first, then the right one, each on its half.
    assert_eq!(
        stacks,
        vec![
            (Rect::new(0, 0, 50, 40), vec![pane(1), pane(2)]),
            (Rect::new(50, 0, 50, 40), vec![pane(3), pane(4)]),
        ],
        "every stack is listed in tree order with its area"
    );
}

#[rstest::rstest]
fn stack_titles_take_one_row_each_and_the_expanded_pane_the_rest() {
    // Given pane 1 beside a stack of panes 2, 3 and 4, pane 3 expanded.
    let layout = main_and_stack(3, 1);

    // When laying it out in a 40-row area.
    let stacked: Vec<(PaneId, Rect)> = rects(&layout).into_iter().skip(1).collect();

    // Then panes 2 and 4 take one row each and pane 3 every row between them.
    assert_eq!(
        stacked,
        vec![
            (pane(2), Rect::new(50, 0, 50, 1)),
            (pane(3), Rect::new(50, 1, 50, 38)),
            (pane(4), Rect::new(50, 39, 50, 1)),
        ],
        "titles are one row, the expanded pane takes the rest"
    );
}

#[rstest::rstest]
fn stack_in_a_short_area_keeps_a_row_for_the_expanded_pane() {
    // Given a stack of panes 1 to 5, pane 5 expanded.
    let layout = TileLayout::from_saved(stack_of(&[1, 2, 3, 4, 5], 5), pane(5));

    // When laying it out in a 3-row area.
    let rect = layout
        .panes(Rect::new(0, 0, 100, 3))
        .into_iter()
        .find(|info| info.id == pane(5))
        .map(|info| info.rect);

    // Then pane 5 still gets the last row.
    assert_eq!(
        rect,
        Some(Rect::new(0, 2, 100, 1)),
        "the expanded pane should keep a row"
    );
}

#[rstest::rstest]
fn focusing_a_stacked_pane_expands_it() {
    // Given pane 1 beside a stack of 2, 3 and 4 with 3 expanded, pane 1 focused.
    let mut layout = main_and_stack(3, 1);

    // When focusing pane 2.
    layout.focus_pane(pane(2));

    // Then pane 2 is expanded.
    assert_eq!(
        expanded(&layout),
        Some(pane(2)),
        "the focused stacked pane should be expanded"
    );
}

#[rstest::rstest]
fn add_tiled_expands_the_new_pane() {
    // Given eleven panes tiled in stacked.
    let mut layout = tiled_as(11, SwapLayout::Stacked);

    // When adding pane 12.
    layout.add_tiled(pane(12), SwapLayout::Stacked);

    // Then pane 12 is the expanded pane of the stack.
    assert_eq!(
        expanded(&layout),
        Some(pane(12)),
        "the added pane should be expanded"
    );
}

#[rstest::rstest]
fn split_in_a_stacked_layout_focuses_the_new_pane() {
    // Given eleven panes tiled in stacked, pane 5 focused.
    let mut layout = tiled_as(11, SwapLayout::Stacked);
    layout.focus_pane(pane(5));

    // When splitting it right with pane 12.
    layout.split_focused(Split::Right, pane(12));

    // Then pane 12 has the focus.
    assert_eq!(
        layout.focused(),
        pane(12),
        "the split's new pane should be focused"
    );
}

#[rstest::rstest]
fn split_of_a_stacked_pane_keeps_its_stack_whole() {
    // Given pane 1 beside a stack of 2, 3 and 4, pane 3 focused.
    let mut layout = main_and_stack(3, 3);

    // When splitting it right with pane 5.
    layout.split_focused(Split::Right, pane(5));

    // Then the stack still holds panes 2, 3 and 4.
    assert_eq!(
        stacked(&layout),
        vec![vec![pane(2), pane(3), pane(4)]],
        "a split should take the whole stack, not one pane out of it"
    );
}

#[rstest::rstest]
fn add_beside_focus_in_a_stack_joins_it() {
    // Given pane 1 beside a stack of 2, 3 and 4, pane 3 focused.
    let mut layout = main_and_stack(3, 3);

    // When adding pane 5 beside the focus.
    layout.add_beside_focus(pane(5), AREA);

    // Then pane 5 joins the stack right after pane 3.
    assert_eq!(
        stacked(&layout),
        vec![vec![pane(2), pane(3), pane(5), pane(4)]],
        "a new pane beside a stacked focus joins its stack"
    );
}

#[rstest::rstest]
fn add_beside_focus_splits_a_tall_pane_top_and_bottom() {
    // Given a lone pane 1 in a 60×40 area.
    let area = Rect::new(0, 0, 60, 40);
    let mut layout = TileLayout::new(pane(1));

    // When adding pane 2 beside the focus.
    layout.add_beside_focus(pane(2), area);

    // Then pane 2 sits below pane 1.
    assert_eq!(
        rects_in(&layout, area),
        vec![
            (pane(1), Rect::new(0, 0, 60, 20)),
            (pane(2), Rect::new(0, 20, 60, 20)),
        ],
        "a tall pane is halved top and bottom"
    );
}

#[rstest::rstest]
fn add_beside_focus_halves_only_the_focused_pane() {
    // Given panes 1 and 2 side by side in a 200×48 area, pane 1 focused.
    let area = Rect::new(0, 0, 200, 48);
    let mut layout = halves(1);

    // When adding pane 3 beside the focus.
    layout.add_beside_focus(pane(3), area);

    // Then pane 1 is halved and pane 2 keeps its width.
    let widths: Vec<u16> = layout
        .panes(area)
        .iter()
        .map(|info| info.rect.width)
        .collect();
    assert_eq!(
        widths,
        vec![50, 50, 100],
        "only the focused pane should be halved"
    );
}

#[rstest::rstest]
fn add_beside_focus_splits_a_wide_pane_left_and_right() {
    // Given a lone pane 1 in a 200×24 area.
    let area = Rect::new(0, 0, 200, 24);
    let mut layout = TileLayout::new(pane(1));

    // When adding pane 2 beside the focus.
    layout.add_beside_focus(pane(2), area);

    // Then pane 2 sits beside pane 1.
    assert_eq!(
        rects_in(&layout, area),
        vec![
            (pane(1), Rect::new(0, 0, 100, 24)),
            (pane(2), Rect::new(100, 0, 100, 24)),
        ],
        "a wide pane is halved left and right"
    );
}

#[rstest::rstest]
fn add_beside_focus_stacks_a_small_pane() {
    // Given a lone pane 1 in a 50×18 area.
    let area = Rect::new(0, 0, 50, 18);
    let mut layout = TileLayout::new(pane(1));

    // When adding pane 2 beside the focus.
    layout.add_beside_focus(pane(2), area);

    // Then panes 1 and 2 are one stack.
    assert_eq!(
        stacked(&layout),
        vec![vec![pane(1), pane(2)]],
        "a pane too small to split is stacked with the new one"
    );
}

#[rstest::rstest]
fn stack_layout_json_roundtrips() {
    // Given twelve panes tiled in stacked with pane 5 expanded and pane 1 focused.
    let mut layout = tiled_as(12, SwapLayout::Stacked);
    layout.focus_pane(pane(5));
    layout.focus_pane(pane(1));

    // When saving and loading it.
    let loaded = TileLayout::from_json(&layout.to_json(), pane(1)).ok();

    // Then every pane lands in the same place, with the same focus and titles.
    assert_eq!(
        loaded.map(|loaded| loaded.panes(AREA)),
        Some(layout.panes(AREA)),
        "the loaded stack should match the saved one"
    );
}

#[rstest::rstest]
fn layout_json_names_a_stack() {
    // Given a stack of panes 2 and 3, pane 3 expanded.
    let layout = TileLayout::from_saved(stack_of(&[2, 3], 3), pane(3));

    // When saving it.
    let json = layout.to_json();

    // Then the stack and its expanded pane are named.
    assert_eq!(
        json, r#"{"stack":[2,3],"expanded":3}"#,
        "the saved stack's shape"
    );
}

#[rstest::rstest]
fn from_json_expands_the_first_pane_when_expanded_isnt_in_the_stack() {
    // Given a saved stack whose expanded pane 9 isn't in it.
    let json = r#"{"split":"right","ratio":0.5,"first":{"pane":1},"second":{"stack":[2,3,4],"expanded":9}}"#;

    // When loading it focused on pane 1.
    let loaded = TileLayout::from_json(json, pane(1)).ok();

    // Then the stack's first pane is expanded.
    assert_eq!(
        loaded.as_ref().and_then(expanded),
        Some(pane(2)),
        "an unknown expanded pane should fall back to the first"
    );
}

#[rstest::rstest]
#[case(r#"{"stack":[2],"expanded":2}"#, vec![1, 2])]
#[case(r#"{"stack":[],"expanded":2}"#, vec![1])]
fn from_json_loads_a_short_stack_as_plain_panes(#[case] stack: &str, #[case] expected: Vec<i64>) {
    // Given pane 1 split right from a stack of fewer than two panes.
    let json = format!(r#"{{"split":"right","ratio":0.5,"first":{{"pane":1}},"second":{stack}}}"#);

    // When loading it.
    let loaded = TileLayout::from_json(&json, pane(1)).ok();

    // Then it holds the panes plainly, none of them a title.
    assert_eq!(
        loaded.map(|loaded| (
            loaded.pane_ids(),
            loaded.panes(AREA).iter().any(|info| info.collapsed)
        )),
        Some((expected.into_iter().map(pane).collect(), false)),
        "a short stack should load as plain panes"
    );
}

#[rstest::rstest]
#[case(3, 4)]
#[case(4, 3)]
fn closing_the_expanded_pane_expands_its_neighbour(#[case] closed: i64, #[case] after: i64) {
    // Given pane 1 beside a stack of 2, 3 and 4 with pane `closed` expanded, pane 1 focused.
    let mut layout = main_and_stack(closed, 1);

    // When closing pane `closed`.
    layout.close_pane(pane(closed));

    // Then the pane after it, or before it when it was last, is expanded.
    assert_eq!(
        expanded(&layout),
        Some(pane(after)),
        "closing the expanded pane should expand its neighbour"
    );
}

#[rstest::rstest]
#[case::left(1, 0.8)]
#[case::right(2, 0.2)]
fn grow_moves_a_side_by_side_border_30_percent_of_the_tab(
    #[case] focus: i64,
    #[case] expected: f32,
) {
    // Given two halves of a 100-column area, pane `focus` focused.
    let mut layout = halves(focus);

    // When growing it.
    let grew = layout.grow_focused(AREA);

    // Then the border moves 30 columns away from it.
    assert!(
        grew == Grow::Grew && ratio(&layout).is_some_and(|r| (r - expected).abs() < 1e-6),
        "the border should move to {expected}, got {grew:?} at {:?}",
        ratio(&layout)
    );
}

#[rstest::rstest]
fn grow_tries_the_neighbours_above_first() {
    // Given panes 1 and 2 side by side above pane 3, pane 3 focused.
    let mut layout = TileLayout::from_saved(
        split(
            Split::Down,
            0.5,
            split(Split::Right, 0.5, Node::Pane(pane(1)), Node::Pane(pane(2))),
            Node::Pane(pane(3)),
        ),
        pane(3),
    );

    // When growing it.
    layout.grow_focused(AREA);

    // Then pane 3 grows 12 rows up: 30% of the 40-row tab.
    let height = layout
        .panes(AREA)
        .into_iter()
        .find(|info| info.id == pane(3))
        .map(|info| info.rect.height);
    assert_eq!(height, Some(32), "pane 3 should grow up first");
}

#[rstest::rstest]
fn grow_skips_a_neighbour_wider_than_the_pane() {
    // Given panes 1 and 2 side by side above pane 3, pane 1 focused.
    let mut layout = TileLayout::from_saved(
        split(
            Split::Down,
            0.5,
            split(Split::Right, 0.5, Node::Pane(pane(1)), Node::Pane(pane(2))),
            Node::Pane(pane(3)),
        ),
        pane(1),
    );

    // When growing it.
    layout.grow_focused(AREA);

    // Then pane 1 grows right into pane 2, not down into the wider pane 3.
    let rect = layout
        .panes(AREA)
        .into_iter()
        .find(|info| info.id == pane(1))
        .map(|info| info.rect);
    assert_eq!(
        rect,
        Some(Rect::new(0, 0, 80, 20)),
        "pane 1 should skip pane 3 and grow right"
    );
}

#[rstest::rstest]
fn grow_stacks_when_30_percent_does_not_fit() {
    // Given panes 1 and 2 split right at 0.8, pane 1 focused.
    let mut layout = TileLayout::from_saved(
        split(Split::Right, 0.8, Node::Pane(pane(1)), Node::Pane(pane(2))),
        pane(1),
    );

    // When growing pane 1, which would leave pane 2 no columns.
    let grew = layout.grow_focused(AREA);

    // Then the two become one stack showing pane 1.
    assert_eq!(
        (grew, layout.root),
        (Grow::Stacked, stack_of(&[1, 2], 1)),
        "a step that doesn't fit should stack the neighbour"
    );
}

#[rstest::rstest]
fn grow_stacks_only_the_neighbour_touching_the_pane() {
    // Given panes 1 and 2 (15 rows each) above pane 3 (10 rows), pane 3
    // focused.
    let mut layout = TileLayout::from_saved(
        split(
            Split::Down,
            0.75,
            split(Split::Down, 0.5, Node::Pane(pane(1)), Node::Pane(pane(2))),
            Node::Pane(pane(3)),
        ),
        pane(3),
    );

    // When growing pane 3, which would leave pane 2 3 rows.
    layout.grow_focused(AREA);

    // Then panes 2 and 3 are one stack below pane 1, which keeps its 15 rows.
    assert_eq!(
        layout.root,
        split(
            Split::Down,
            0.375,
            Node::Pane(pane(1)),
            stack_of(&[2, 3], 3)
        ),
        "only the pane touching pane 3 should join its stack"
    );
}

#[rstest::rstest]
fn grow_stacks_the_neighbour_below_under_the_pane() {
    // Given pane 1 (30 rows) above panes 2 and 3 (5 rows each), pane 1
    // focused.
    let mut layout = TileLayout::from_saved(
        split(
            Split::Down,
            0.75,
            Node::Pane(pane(1)),
            split(Split::Down, 0.5, Node::Pane(pane(2)), Node::Pane(pane(3))),
        ),
        pane(1),
    );

    // When growing pane 1, which would leave pane 2 no rows.
    layout.grow_focused(AREA);

    // Then panes 1 and 2 are one stack above pane 3, which keeps its 5 rows.
    assert_eq!(
        layout.root,
        split(
            Split::Down,
            0.875,
            stack_of(&[1, 2], 1),
            Node::Pane(pane(3))
        ),
        "the pane below should join pane 1's stack"
    );
}

#[rstest::rstest]
fn grow_moves_a_stacks_border() {
    // Given a stack of 1 and 2 beside pane 3, pane 1 focused.
    let mut layout = TileLayout::from_saved(
        split(Split::Right, 0.5, stack_of(&[1, 2], 1), Node::Pane(pane(3))),
        pane(1),
    );

    // When growing pane 1.
    layout.grow_focused(AREA);

    // Then the border between the stack and pane 3 moves 30 columns right.
    assert!(
        ratio(&layout).is_some_and(|r| (r - 0.8).abs() < 1e-6),
        "the stack's border should move to 0.8, got {:?}",
        ratio(&layout)
    );
}

#[rstest::rstest]
#[case::thirty_percent(0.5, 0.2)]
#[case::five_percent_when_thirty_does_not_fit(0.25, 0.2)]
fn shrink_moves_the_border_towards_the_pane(#[case] start: f32, #[case] expected: f32) {
    // Given panes 1 and 2 split right at `start`, pane 1 focused.
    let mut layout = TileLayout::from_saved(
        split(
            Split::Right,
            start,
            Node::Pane(pane(1)),
            Node::Pane(pane(2)),
        ),
        pane(1),
    );

    // When shrinking pane 1.
    layout.shrink_focused(AREA);

    // Then the border lands at `expected`.
    assert!(
        ratio(&layout).is_some_and(|r| (r - expected).abs() < 1e-6),
        "the border should move to {expected}, got {:?}",
        ratio(&layout)
    );
}

#[rstest::rstest]
#[case::shown_last_breaks_out_the_top(
        3,
        split(Split::Down, 1.0 / 3.0, Node::Pane(pane(1)), stack_of(&[2, 3], 3))
    )]
#[case::shown_first_breaks_out_the_bottom(
        1,
        split(Split::Down, 2.0 / 3.0, stack_of(&[1, 2], 1), Node::Pane(pane(3)))
    )]
fn shrink_breaks_a_pane_out_of_the_stack(#[case] shown: i64, #[case] expected: Node) {
    // Given a stack of 1, 2 and 3 showing pane `shown`.
    let mut layout = TileLayout::from_saved(stack_of(&[1, 2, 3], shown), pane(shown));

    // When shrinking.
    layout.shrink_focused(AREA);

    // Then one pane leaves the stack with a third of its rows.
    assert_eq!(layout.root, expected, "Alt - should break a pane out");
}

/// Whether the root split's ratio is `expected`, give or take a rounding.
fn ratio_is(layout: &TileLayout, expected: f32) -> bool {
    ratio(layout).is_some_and(|ratio| (ratio - expected).abs() < 1e-3)
}

#[rstest::rstest]
fn resize_side_out_moves_the_border_5_percent() {
    // Given panes 1 and 2 side by side, pane 1 focused.
    let mut layout = halves(1);

    // When pushing pane 1's right border out.
    layout.resize_side(AREA, NavDirection::Right, true);

    // Then the border sits 5% of the tab further right.
    assert!(
        ratio_is(&layout, 0.55),
        "the right border should move right 5%, got {:?}",
        ratio(&layout)
    );
}

#[rstest::rstest]
fn resize_side_in_moves_the_border_back_5_percent() {
    // Given panes 1 and 2 side by side, pane 1 focused.
    let mut layout = halves(1);

    // When pulling pane 1's right border in.
    layout.resize_side(AREA, NavDirection::Right, false);

    // Then the border sits 5% of the tab further left.
    assert!(
        ratio_is(&layout, 0.45),
        "the right border should move left 5%, got {:?}",
        ratio(&layout)
    );
}

#[rstest::rstest]
fn resize_side_growing_toward_the_tabs_edge_pulls_the_opposite_border_in() {
    // Given panes 1 and 2 side by side, pane 1 focused, its left edge the tab's.
    let mut layout = halves(1);

    // When pushing pane 1's left border out.
    layout.resize_side(AREA, NavDirection::Left, true);

    // Then its right border moves in 5% instead.
    assert!(
        ratio_is(&layout, 0.45),
        "a grow at the tab's edge should pull the opposite border in, got {:?}",
        ratio(&layout)
    );
}

#[rstest::rstest]
fn resize_side_shrinking_toward_the_tabs_edge_changes_nothing() {
    // Given panes 1 and 2 side by side, pane 1 focused, its left edge the tab's.
    let mut layout = halves(1);
    let before = layout.clone();

    // When pulling pane 1's left border in.
    layout.resize_side(AREA, NavDirection::Left, false);

    // Then the tree is unchanged.
    assert_eq!(layout, before, "the tab's edge never moves");
}

#[rstest::rstest]
fn resize_side_never_leaves_a_pane_under_the_minimum() {
    // Given panes 1 and 2 side by side in a 10-column tab, pane 1 focused.
    let mut layout = halves(1);
    let before = layout.clone();

    // When pushing pane 1's right border out (pane 2 would get 4 columns).
    layout.resize_side(Rect::new(0, 0, 10, 40), NavDirection::Right, true);

    // Then the tree is unchanged.
    assert_eq!(layout, before, "no pane goes under the minimum size");
}

#[rstest::rstest]
fn swap_toward_swaps_the_two_panes_ids() {
    // Given panes 1 and 2 side by side, pane 1 focused.
    let mut layout = halves(1);
    let cells: Vec<Rect> = rects(&layout).into_iter().map(|(_, rect)| rect).collect();

    // When moving pane 1 right.
    layout.swap_toward(AREA, NavDirection::Right);

    // Then pane 2 takes the left cell and pane 1 the right, sizes unchanged.
    let expected: Vec<_> = [pane(2), pane(1)].into_iter().zip(cells).collect();
    assert_eq!(rects(&layout), expected, "the two panes should trade cells");
}

#[rstest::rstest]
fn swap_toward_keeps_the_focus_on_the_moved_pane() {
    // Given panes 1 and 2 side by side, pane 1 focused.
    let mut layout = halves(1);

    // When moving pane 1 right.
    layout.swap_toward(AREA, NavDirection::Right);

    // Then pane 1 still has the focus.
    assert_eq!(
        layout.focused(),
        pane(1),
        "the focus follows the moved pane"
    );
}

#[rstest::rstest]
fn swap_toward_past_the_tabs_edge_changes_nothing() {
    // Given panes 1 and 2 side by side, pane 1 focused on the left edge.
    let mut layout = halves(1);
    let before = layout.clone();

    // When moving pane 1 left.
    let moved = layout.swap_toward(AREA, NavDirection::Left);

    // Then nothing moved.
    assert!(
        !moved && layout == before,
        "a move past the tab's edge should change nothing"
    );
}

#[rstest::rstest]
fn swap_in_order_forward_on_the_last_pane_swaps_with_the_first() {
    // Given panes 1 to 3 tiled, pane 3 focused.
    let mut layout = tiled(3);

    // When moving pane 3 to the next pane.
    layout.swap_in_order(true);

    // Then it wraps and swaps with pane 1.
    assert_eq!(
        layout.pane_ids(),
        vec![pane(3), pane(2), pane(1)],
        "next on the last pane should swap with the first"
    );
}

#[rstest::rstest]
fn swap_in_order_backward_on_the_first_pane_swaps_with_the_last() {
    // Given panes 1 to 3 tiled, pane 1 focused.
    let mut layout = tiled(3);
    layout.focus_pane(pane(1));

    // When moving pane 1 to the previous pane.
    layout.swap_in_order(false);

    // Then it wraps and swaps with pane 3.
    assert_eq!(
        layout.pane_ids(),
        vec![pane(3), pane(2), pane(1)],
        "previous on the first pane should swap with the last"
    );
}

#[rstest::rstest]
fn swap_in_order_on_a_lone_pane_changes_nothing() {
    // Given a layout of pane 1.
    let mut layout = TileLayout::new(pane(1));

    // When moving it to the next pane.
    let moved = layout.swap_in_order(true);

    // Then nothing moved.
    assert!(!moved, "a lone pane has nothing to swap with");
}

#[rstest::rstest]
fn move_mode_up_from_below_a_stack_swaps_with_its_shown_pane() {
    // Given panes 1, 2 and 3 stacked over pane 4, pane 2 shown and pane 4
    // focused.
    let mut layout = TileLayout::from_saved(
        split(
            Split::Down,
            0.5,
            stack_of(&[1, 2, 3], 2),
            Node::Pane(pane(4)),
        ),
        pane(4),
    );

    // When moving pane 4 up.
    layout.swap_toward(AREA, NavDirection::Up);

    // Then pane 4 takes the shown pane 2's place in the stack.
    assert_eq!(
        stacked(&layout),
        vec![vec![pane(1), pane(4), pane(3)]],
        "a move up from below a stack should swap with the pane it shows"
    );
}

#[rstest::rstest]
fn move_mode_up_from_below_a_no_row_stack_swaps_with_its_shown_pane() {
    // Given panes 1, 2 and 3 stacked in no rows over pane 4, pane 2 shown
    // and pane 4 focused.
    let mut layout = TileLayout::from_saved(
        split(
            Split::Down,
            0.1,
            stack_of(&[1, 2, 3], 2),
            Node::Pane(pane(4)),
        ),
        pane(4),
    );

    // When moving pane 4 up in a body four rows tall.
    layout.swap_toward(Rect::new(0, 0, 100, 4), NavDirection::Up);

    // Then pane 4 takes the shown pane 2's place in the stack.
    assert_eq!(
        stacked(&layout),
        vec![vec![pane(1), pane(4), pane(3)]],
        "a stack with no rows should still swap with the pane it shows"
    );
}

#[rstest::rstest]
fn move_mode_up_from_below_a_one_row_stack_swaps_with_its_shown_pane() {
    // Given panes 1, 2 and 3 stacked in one row over pane 4, pane 2 shown
    // and pane 4 focused.
    let mut layout = TileLayout::from_saved(
        split(
            Split::Down,
            0.25,
            stack_of(&[1, 2, 3], 2),
            Node::Pane(pane(4)),
        ),
        pane(4),
    );

    // When moving pane 4 up in a body three rows tall.
    layout.swap_toward(Rect::new(0, 0, 100, 3), NavDirection::Up);

    // Then pane 4 takes the shown pane 2's place in the stack.
    assert_eq!(
        stacked(&layout),
        vec![vec![pane(1), pane(4), pane(3)]],
        "a one-row stack should still swap with the pane it shows"
    );
}

#[rstest::rstest]
fn swap_toward_down_in_a_stack_swaps_with_the_next_stacked_pane() {
    // Given pane 1 beside a stack of 2, 3 and 4, pane 2 shown and focused.
    let mut layout = main_and_stack(2, 2);

    // When moving pane 2 down.
    layout.swap_toward(AREA, NavDirection::Down);

    // Then pane 2 trades places with pane 3 in the stack.
    assert_eq!(
        stacked(&layout),
        vec![vec![pane(3), pane(2), pane(4)]],
        "a move down in a stack should swap with the next stacked pane"
    );
}

#[rstest::rstest]
fn swap_toward_down_in_a_stack_keeps_the_moved_pane_shown() {
    // Given pane 1 beside a stack of 2, 3 and 4, pane 2 shown and focused.
    let mut layout = main_and_stack(2, 2);

    // When moving pane 2 down.
    layout.swap_toward(AREA, NavDirection::Down);

    // Then pane 2 is still the stack's shown pane.
    assert_eq!(
        expanded(&layout),
        Some(pane(2)),
        "the moved pane should stay shown in the stack"
    );
}

#[rstest::rstest]
fn swap_into_a_stack_shows_the_moved_pane_in_the_stack() {
    // Given pane 1 focused beside a stack of 2, 3 and 4, pane 2 shown.
    let mut layout = main_and_stack(2, 1);

    // When moving pane 1 right.
    layout.swap_toward(AREA, NavDirection::Right);

    // Then pane 1 takes pane 2's place in the stack and is shown.
    assert_eq!(
        (stacked(&layout), expanded(&layout)),
        (vec![vec![pane(1), pane(3), pane(4)]], Some(pane(1))),
        "the moved pane should take the stack's shown slot"
    );
}

#[rstest::rstest]
fn swap_into_a_stack_puts_the_shown_pane_in_the_moved_panes_cell() {
    // Given pane 1 focused beside a stack of 2, 3 and 4, pane 2 shown.
    let mut layout = main_and_stack(2, 1);

    // When moving pane 1 right.
    layout.swap_toward(AREA, NavDirection::Right);

    // Then pane 2 sits on the left half.
    assert_eq!(
        info(&layout, 2).map(|info| info.rect),
        Some(Rect::new(0, 0, 50, 40)),
        "the stack's shown pane should land in the moved pane's cell"
    );
}

#[rstest::rstest]
#[case::lone(TileLayout::new(pane(1)))]
#[case::whole_stack(TileLayout::from_saved(stack_of(&[1, 2], 1), pane(1)))]
fn grow_focused_without_a_neighbour_is_stuck(#[case] mut layout: TileLayout) {
    // Given a layout with no split.

    // When growing the focused pane.
    let grew = layout.grow_focused(AREA);

    // Then it's stuck.
    assert_eq!(
        grew,
        Grow::Stuck,
        "with no neighbour there is nothing to grow"
    );
}

#[rstest::rstest]
fn grow_focused_keeps_unstacked_panes_at_least_five_by_five(
    #[values(2, 3, 4, 5, 6, 7, 8, 9, 10)] n: i64,
) {
    // Given `n` tiled panes, every one at least 33 columns by 10 rows.
    let fresh = |focus: i64| {
        let mut layout = tiled(n);
        layout.focus_pane(pane(focus));
        layout
    };

    // When growing each focused pane, on its own fresh layout, until stuck.
    let mut violations = Vec::new();
    for focus in 1..=n {
        let mut layout = fresh(focus);
        for step in 0..200 {
            if layout.grow_focused(AREA) == Grow::Stuck {
                break;
            }
            let stacks = layout.stacks(AREA);
            violations.extend(
                layout
                    .panes(AREA)
                    .into_iter()
                    .filter(|info| !stacks.iter().any(|stack| stack.panes.contains(&info.id)))
                    .filter(|info| info.rect.width < 5 || info.rect.height < 5)
                    .map(|info| (n, focus, step, info.id, info.rect)),
            );
        }
    }

    // Then no step left a pane outside a stack under 5×5.
    assert!(
        violations.is_empty(),
        "a grow step left panes under 5×5: {violations:?}"
    );
}

#[rstest::rstest]
fn split_at_keeps_the_focused_pane() {
    // Given panes 1 and 2 side by side, pane 2 focused.
    let mut layout = halves(2);

    // When splitting pane 1 down with pane 3.
    layout.split_at(pane(1), Split::Down, pane(3));

    // Then pane 2 keeps the focus.
    assert_eq!(layout.focused(), pane(2), "a named split leaves the focus");
}
