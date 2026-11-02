//! Where a placement shows inside its pane: cut to the pane's content, set
//! at a whole outer cell plus a pixel offset, with the cells it covers.
//!
//! A placement at its natural size is cropped to the content through the
//! part of the image it shows. One scaled to a number of cells shows only
//! when all those cells are inside the content, since cropping would change
//! its scale.

use ratatui::layout::Rect;

use super::{Image, Placement, Visible};
use crate::pane::CellSize;

/// Where `placement` (its id `id`) of `image` shows inside `content`, whose
/// cells are `cell` pixels, and the cells it covers there; `None` when
/// nothing shows.
pub(super) fn visible(
    placement: &Placement,
    image: &Image,
    id: u32,
    content: Rect,
    cell: CellSize,
) -> Option<(Visible, Rect)> {
    if cell.width == 0 || cell.height == 0 {
        return None;
    }
    let [x, y, width, height] = placement.src.unwrap_or_default();
    let shape = Shape {
        // kitty keeps the offset inside the cell.
        offset: (
            placement.offset.0.min(u32::from(cell.width) - 1),
            placement.offset.1.min(u32::from(cell.height) - 1),
        ),
        size: (
            extent(width, x, image.px.map(|(width, _)| width)),
            extent(height, y, image.px.map(|(_, height)| height)),
        ),
    };
    let cells = (
        placement.cells.0.filter(|&columns| columns > 0),
        placement.cells.1.filter(|&rows| rows > 0),
    );
    let spot = match cells {
        (None, None) => cropped(placement, &shape, [x, y], content, cell)?,
        cells => Spot {
            offset: shape.offset,
            src: [x, y, width, height],
            hole: scaled(placement, &shape, cells, content, cell)?,
        },
    };
    let visible = Visible {
        image: image.outer,
        placement: id,
        generation: image.generation,
        at: spot.hole.as_position(),
        offset: spot.offset,
        src: spot.src,
        cells,
        z: placement.z,
    };
    Some((visible, spot.hole))
}

/// A placement's offset within its cell, and the size of the part of the
/// image it shows, where known.
struct Shape {
    offset: (u32, u32),
    size: (Option<u32>, Option<u32>),
}

/// Where a placement lands: its offset within its first cell, the part of
/// the image it shows (`x`, `y`, `w`, `h`), and the cells it covers, the
/// first one at their top left.
struct Spot {
    offset: (u32, u32),
    src: [u32; 4],
    hole: Rect,
}

/// How many pixels of an image `image` pixels long show from `start` when
/// the child asked for `given` (0 for the rest of the image).
fn extent(given: u32, start: u32, image: Option<u32>) -> Option<u32> {
    match (given, image) {
        (0, image) => image.map(|image| image.saturating_sub(start)),
        (given, Some(image)) => Some(given.min(image.saturating_sub(start))),
        (given, None) => Some(given),
    }
}

/// Where a placement at its natural size lands, cut to `content`. A size
/// kitty knows but orb doesn't runs to the content's edge, where the crop
/// stops it.
fn cropped(
    placement: &Placement,
    shape: &Shape,
    [x, y]: [u32; 2],
    content: Rect,
    cell: CellSize,
) -> Option<Spot> {
    let (cell_width, cell_height) = (i64::from(cell.width), i64::from(cell.height));
    let left = i64::from(placement.col) * cell_width + i64::from(shape.offset.0);
    let top = i64::from(placement.line) * cell_height + i64::from(shape.offset.1);
    let (edge_x, edge_y) = (
        i64::from(content.width) * cell_width,
        i64::from(content.height) * cell_height,
    );
    let right = shape
        .size
        .0
        .map_or(edge_x, |width| left + i64::from(width))
        .min(edge_x);
    let bottom = shape
        .size
        .1
        .map_or(edge_y, |height| top + i64::from(height))
        .min(edge_y);
    let (shown_left, shown_top) = (left.max(0), top.max(0));
    if shown_left >= right || shown_top >= bottom {
        return None;
    }
    let at = (
        content.x + u16::try_from(shown_left / cell_width).ok()?,
        content.y + u16::try_from(shown_top / cell_height).ok()?,
    );
    let offset = (
        u32::try_from(shown_left % cell_width).ok()?,
        u32::try_from(shown_top % cell_height).ok()?,
    );
    let (width, height) = (
        u32::try_from(right - shown_left).ok()?,
        u32::try_from(bottom - shown_top).ok()?,
    );
    let src = [
        x.checked_add(u32::try_from(shown_left - left).ok()?)?,
        y.checked_add(u32::try_from(shown_top - top).ok()?)?,
        width,
        height,
    ];
    let hole = Rect::new(
        at.0,
        at.1,
        cells_over(offset.0 + width, cell.width),
        cells_over(offset.1 + height, cell.height),
    )
    .intersection(content);
    Some(Spot { offset, src, hole })
}

/// The cells a placement scaled to `cells` (columns, rows; one may be left
/// for kitty to work out from the image's shape) covers, when they are all
/// inside `content`.
fn scaled(
    placement: &Placement,
    shape: &Shape,
    cells: (Option<u32>, Option<u32>),
    content: Rect,
    cell: CellSize,
) -> Option<Rect> {
    let (cell_width, cell_height) = (u64::from(cell.width), u64::from(cell.height));
    let size = || {
        let (width, height) = shape.size.0.zip(shape.size.1)?;
        let size = (u64::from(width), u64::from(height));
        (size.0 > 0 && size.1 > 0).then_some(size)
    };
    let (columns, rows) = match cells {
        (Some(columns), Some(rows)) => (u64::from(columns), u64::from(rows)),
        (Some(columns), None) => {
            let (width, height) = size()?;
            let columns = u64::from(columns);
            let rows = columns
                .saturating_mul(cell_width)
                .saturating_mul(height)
                .div_ceil(width * cell_height);
            (columns, rows)
        }
        (None, Some(rows)) => {
            let (width, height) = size()?;
            let rows = u64::from(rows);
            let columns = rows
                .saturating_mul(cell_height)
                .saturating_mul(width)
                .div_ceil(height * cell_width);
            (columns, rows)
        }
        (None, None) => return None,
    };
    let (col, line) = (
        u64::from(placement.col),
        u64::try_from(placement.line).ok()?,
    );
    let inside = col.saturating_add(columns) <= u64::from(content.width)
        && line.saturating_add(rows) <= u64::from(content.height);
    inside.then(|| {
        Rect::new(
            content.x + col as u16,
            content.y + line as u16,
            columns as u16,
            rows as u16,
        )
    })
}

/// The columns and rows a placement covers, as kitty counts them to move
/// the cursor past it: `c`/`r` when given, else from the shown part of an
/// image `size` pixels at `cell`; `None` when that needs a size or cell
/// size orb doesn't know.
pub(super) fn cells_covered(
    placement: &Placement,
    size: Option<(u32, u32)>,
    cell: CellSize,
) -> Option<(u32, u32)> {
    if cell.width == 0 || cell.height == 0 {
        return None;
    }
    let (cell_width, cell_height) = (u64::from(cell.width), u64::from(cell.height));
    let offset = (
        u64::from(placement.offset.0).min(cell_width - 1),
        u64::from(placement.offset.1).min(cell_height - 1),
    );
    let shown = || {
        let [x, y, width, height] = placement.src.unwrap_or_default();
        let (image_width, image_height) = size?;
        let shown = (
            u64::from(extent(width, x, Some(image_width))?),
            u64::from(extent(height, y, Some(image_height))?),
        );
        (shown.0 > 0 && shown.1 > 0).then_some(shown)
    };
    let (columns, rows) = match (
        placement.cells.0.filter(|&columns| columns > 0),
        placement.cells.1.filter(|&rows| rows > 0),
    ) {
        (Some(columns), Some(rows)) => (u64::from(columns), u64::from(rows)),
        (Some(columns), None) => {
            let (width, height) = shown()?;
            let width_px = cell_width * u64::from(columns) + offset.0;
            let rows = width_px
                .saturating_mul(height)
                .div_ceil(width * cell_height);
            (u64::from(columns), rows)
        }
        (None, Some(rows)) => {
            let (width, height) = shown()?;
            let height_px = cell_height * u64::from(rows) + offset.1;
            let columns = height_px
                .saturating_mul(width)
                .div_ceil(height * cell_width);
            (columns, u64::from(rows))
        }
        (None, None) => {
            let (width, height) = shown()?;
            (
                (width + offset.0).div_ceil(cell_width),
                (height + offset.1).div_ceil(cell_height),
            )
        }
    };
    Some((u32::try_from(columns).ok()?, u32::try_from(rows).ok()?))
}

/// How many cells of `cell` pixels `pixels` pixels reach into.
fn cells_over(pixels: u32, cell: u16) -> u16 {
    u16::try_from(pixels.div_ceil(u32::from(cell))).unwrap_or(u16::MAX)
}

#[cfg(test)]
mod tests {
    use ratatui::layout::Rect;

    use super::{cells_covered, visible};
    use crate::graphics::{Image, Placement, Visible};
    use crate::pane::CellSize;

    /// Cells of 10 by 20 pixels.
    const CELL: CellSize = CellSize {
        width: 10,
        height: 20,
    };

    /// A pane's content: 10 by 5 cells (100 by 100 pixels), away from the
    /// outer screen's corner.
    const CONTENT: Rect = Rect::new(5, 3, 10, 5);

    /// A placement at its natural size at column `col` and line `line`.
    fn placement(col: u16, line: i32) -> Placement {
        Placement {
            line,
            col,
            offset: (0, 0),
            src: None,
            cells: (None, None),
            z: 0,
            alt: false,
        }
    }

    /// An image of `width` by `height` pixels.
    fn image(width: u32, height: u32) -> Image {
        Image {
            outer: 1,
            generation: 0,
            px: Some((width, height)),
            declared: Some((width, height)),
            alt: false,
        }
    }

    /// Where `placement` of `image` shows inside [`CONTENT`].
    fn show(placement: &Placement, image: &Image) -> Option<(Visible, Rect)> {
        visible(placement, image, 1, CONTENT, CELL)
    }

    #[rstest::rstest]
    fn placement_half_outside_is_cropped_to_the_content() {
        // Given a 100×40 image placed at the content's middle column.
        let (placement, image) = (placement(5, 0), image(100, 40));

        // When working out where it shows.
        let shown = show(&placement, &image);

        // Then only its left half shows.
        assert_eq!(
            shown.map(|(visible, _)| visible.src),
            Some([0, 0, 50, 40]),
            "the part of the image shown"
        );
    }

    #[rstest::rstest]
    #[case::past_the_cell(2, 1, (25, 45))]
    #[case::cut_at_the_top(2, -1, (7, 13))]
    fn cropped_offsets_stay_below_the_cell_size(
        #[case] col: u16,
        #[case] line: i32,
        #[case] offset: (u32, u32),
    ) {
        // Given a 300×300 image placed with a pixel offset.
        let placement = Placement {
            offset,
            ..placement(col, line)
        };

        // When working out where it shows.
        let shown = show(&placement, &image(300, 300));

        // Then its offset stays inside one cell.
        let offset = shown.map(|(visible, _)| visible.offset);
        assert!(
            offset.is_some_and(|(x, y)| x < 10 && y < 20),
            "offset {offset:?} should stay below 10×20"
        );
    }

    #[rstest::rstest]
    fn hole_stays_inside_the_content() {
        // Given a 300×300 image placed past the content's middle.
        let (placement, image) = (placement(3, 2), image(300, 300));

        // When working out the cells it covers.
        let hole = show(&placement, &image).map(|(_, hole)| hole);

        // Then they run from its cell to the content's corner and no further.
        assert_eq!(
            hole,
            Some(Rect::new(8, 5, 7, 3)),
            "the cells the image covers"
        );
    }

    #[rstest::rstest]
    fn image_of_unknown_size_runs_to_the_content_corner() {
        // Given an image whose size the child never said, placed past the
        // content's middle.
        let image = Image {
            px: None,
            ..image(1, 1)
        };

        // When working out the cells it covers.
        let hole = show(&placement(3, 2), &image).map(|(_, hole)| hole);

        // Then they run from its cell to the content's corner.
        assert_eq!(
            hole,
            Some(Rect::new(8, 5, 7, 3)),
            "the cells an image of unknown size covers"
        );
    }

    #[rstest::rstest]
    fn zero_cell_size_shows_nothing() {
        // Given an outer terminal that never said its cell size.
        let cell = CellSize::default();

        // When working out where a placement shows.
        let shown = visible(&placement(0, 0), &image(10, 10), 1, CONTENT, cell);

        // Then nothing shows.
        assert_eq!(shown, None, "no cell size, no image");
    }

    #[rstest::rstest]
    fn scaled_placement_partly_outside_is_skipped() {
        // Given an image scaled to 8×2 cells at the content's middle column.
        let placement = Placement {
            cells: (Some(8), Some(2)),
            ..placement(5, 0)
        };

        // When working out where it shows.
        let shown = show(&placement, &image(100, 40));

        // Then nothing shows.
        assert_eq!(shown, None, "a scaled image is never cropped");
    }

    #[rstest::rstest]
    fn scaled_placement_inside_keeps_its_cells() {
        // Given an image scaled to 4×2 cells inside the content.
        let placement = Placement {
            cells: (Some(4), Some(2)),
            ..placement(1, 1)
        };

        // When working out where it shows.
        let shown = show(&placement, &image(100, 40));

        // Then it keeps its cells.
        assert_eq!(
            shown.map(|(visible, _)| visible.cells),
            Some((Some(4), Some(2))),
            "the cells it is scaled to"
        );
    }

    #[rstest::rstest]
    #[case::natural_size((None, None), 0, Some((25, 30)), Some((3, 2)))]
    #[case::columns_only((Some(4), None), 0, Some((100, 40)), Some((4, 1)))]
    #[case::rows_only((None, Some(2)), 0, Some((100, 40)), Some((10, 2)))]
    #[case::both_given((Some(5), Some(3)), 0, None, Some((5, 3)))]
    #[case::offset_adds_a_column((None, None), 5, Some((20, 20)), Some((3, 1)))]
    #[case::unknown_size((None, None), 0, None, None)]
    fn cells_covered_counts_as_kitty_does(
        #[case] cells: (Option<u32>, Option<u32>),
        #[case] offset_x: u32,
        #[case] size: Option<(u32, u32)>,
        #[case] expected: Option<(u32, u32)>,
    ) {
        // Given a placement scaled to `cells`, `offset_x` pixels into its
        // cell, of an image `size` pixels.
        let placement = Placement {
            cells,
            offset: (offset_x, 0),
            ..placement(0, 0)
        };

        // When counting the cells the cursor moves past.
        let covered = cells_covered(&placement, size, CELL);

        // Then they are the cells kitty counts.
        assert_eq!(covered, expected, "cells covered");
    }

    #[rstest::rstest]
    fn cells_covered_of_a_huge_scale_gives_no_move() {
        // Given a placement scaled to the most columns a child can ask for,
        // of an image as tall as a child can say.
        let placement = Placement {
            cells: (Some(u32::MAX), None),
            ..placement(0, 0)
        };

        // When counting the cells the cursor moves past.
        let covered = cells_covered(&placement, Some((1, u32::MAX)), CELL);

        // Then there is no count, since the rows don't fit.
        assert_eq!(covered, None, "cells covered by a huge scale");
    }
}
