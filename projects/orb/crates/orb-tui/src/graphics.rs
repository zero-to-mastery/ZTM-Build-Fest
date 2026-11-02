//! The panes' kitty images on the outer screen, kept in step with each frame.
//!
//! Each frame, what the panes' programs sent for kitty (images, frame edits,
//! frees) goes out first, a drawn pane's with its cells and a hidden pane's
//! as it arrives. Then each drawn pane's images are placed where its content
//! shows them: new or moved ones placed, ones no longer shown taken off. A
//! pane that isn't drawn has its images taken off the screen but kept in
//! kitty, so showing it again brings them straight back; a pane that is gone
//! has its images freed. Images sit in kitty's deepest layer, under every
//! cell with a background of its own, so everything orb draws covers them; a
//! float's images sit above those of the panes under it. All of it is
//! written in the frame's own screen update, with the cursor saved before
//! and restored after.
//!
//! One frame writes at most 256 KiB of the panes' image bytes, cut only
//! between whole commands; the rest waits for the next frames, and the
//! placements wait until it is out, so kitty never places an image it
//! hasn't got. More than 32 MiB waiting goes out in one frame.

use std::collections::{HashMap, HashSet};
use std::io::{self, Write};

use orb_domain::ids::PaneId;
use orb_term::{GraphicsFrame, Pane, Visible};

/// The z of the lowest-ranked pane's images: deep under kitty's limit for
/// images drawn below cells with a background of their own
/// (−1,073,741,824).
const DEEPEST: i32 = -2_000_000_000;
/// The z values one pane's images span above its rank's base.
const RANK_SPAN: i32 = 1 << 24;
/// The highest rank with a band of its own; higher ranks share it, which
/// keeps every band under kitty's limit.
const TOP_RANK: usize = 54;
/// The most pane image bytes one frame writes to kitty; the rest waits
/// for the next frames, cut only between whole commands.
const FRAME_BUDGET: usize = 256 * 1024;
/// The most image bytes left waiting; past it a frame writes them all, as
/// it did before the budget, so a pane sending images faster than frames
/// write them can't grow the wait without end.
const BACKLOG_CAP: usize = 32 * 1024 * 1024;

/// One drawn pane's images this frame: its image model's id, its rank among
/// the placed panes (tiled first, then floats bottom to top), and its
/// images.
pub(crate) type DrawnImages = (u64, usize, GraphicsFrame);

/// What kitty shows of the panes' images, kept in step with each frame.
#[derive(Default)]
pub(crate) struct Compositor {
    /// Per image model: the placements kitty shows, as last placed.
    shown: HashMap<u64, HashMap<(u32, u32), Visible>>,
    /// Per image model: the kitty ids of the images it last held.
    images: HashMap<u64, Vec<u32>>,
    /// Image bytes past a frame's budget, written first next frame.
    backlog: Vec<u8>,
}

impl Compositor {
    /// Whether image bytes are waiting for the next frame.
    pub(crate) fn pending(&self) -> bool {
        !self.backlog.is_empty()
    }

    /// Writes this frame's image bytes to `out` for the panes `drawn`, after
    /// taking the waiting bytes of the panes in `panes` that weren't drawn
    /// and reading which images every pane still holds.
    ///
    /// # Errors
    ///
    /// Returns an error if writing to `out` fails.
    pub(crate) fn compose<W>(
        &mut self,
        out: &mut W,
        drawn: &[DrawnImages],
        panes: &HashMap<PaneId, Pane>,
    ) -> io::Result<()>
    where
        W: Write,
    {
        let drawn_models: HashSet<u64> = drawn.iter().map(|(model, _, _)| *model).collect();
        let hidden: Vec<u8> = panes
            .values()
            .filter(|pane| !drawn_models.contains(&pane.graphics_instance()))
            .flat_map(Pane::take_graphics_output)
            .collect();
        let live = panes
            .values()
            .map(|pane| (pane.graphics_instance(), pane.live_images()))
            .collect();
        self.write(out, drawn, &hidden, live)
    }

    /// Writes, inside `ESC 7 … ESC 8`, the bytes left from the last frame,
    /// the drawn panes' waiting bytes, then `hidden` (the other panes'
    /// waiting bytes), then what places, moves and takes off placements,
    /// then frees for the images of models no longer in `live`. Writes
    /// nothing when none of that has anything. When the waiting bytes pass
    /// [`FRAME_BUDGET`], it writes only their first part and keeps the rest
    /// and everything after it for the next frame, unless they pass
    /// [`BACKLOG_CAP`].
    fn write<W>(
        &mut self,
        out: &mut W,
        drawn: &[DrawnImages],
        hidden: &[u8],
        live: HashMap<u64, Vec<u32>>,
    ) -> io::Result<()>
    where
        W: Write,
    {
        let mut body = std::mem::take(&mut self.backlog);
        body.extend(
            drawn
                .iter()
                .flat_map(|(_, _, frame)| frame.out.iter().copied()),
        );
        body.extend_from_slice(hidden);
        let cut = match body.len() {
            len if len > BACKLOG_CAP => len,
            _ => cut(&body, FRAME_BUDGET),
        };
        if cut < body.len() {
            self.backlog = body.split_off(cut);
            return wrapped(out, &body);
        }
        let mut before = std::mem::take(&mut self.shown);
        for (model, rank, frame) in drawn {
            let shown = before.remove(model).unwrap_or_default();
            let wanted: HashMap<(u32, u32), Visible> = frame
                .visible
                .iter()
                .map(|visible| {
                    let z = band(*rank, visible.z);
                    (
                        (visible.image, visible.placement),
                        Visible { z, ..*visible },
                    )
                })
                .collect();
            for key in shown.keys().filter(|key| !wanted.contains_key(key)) {
                take_off(&mut body, *key);
            }
            for (key, visible) in &wanted {
                if shown.get(key) != Some(visible) {
                    place(&mut body, visible);
                }
            }
            self.shown.insert(*model, wanted);
        }
        for key in before.values().flat_map(HashMap::keys) {
            take_off(&mut body, *key);
        }
        for (_, images) in self
            .images
            .iter()
            .filter(|(model, _)| !live.contains_key(model))
        {
            for image in images {
                body.extend_from_slice(format!("\x1b_Ga=d,d=I,i={image},q=2\x1b\\").as_bytes());
            }
        }
        self.images = live;
        wrapped(out, &body)
    }
}

/// Writes `body` inside `ESC 7 … ESC 8`, or nothing when it is empty.
fn wrapped<W>(out: &mut W, body: &[u8]) -> io::Result<()>
where
    W: Write,
{
    if body.is_empty() {
        return Ok(());
    }
    out.write_all(b"\x1b7")?;
    out.write_all(body)?;
    out.write_all(b"\x1b8")
}

/// Where to cut `body`, a run of whole commands, so its first part holds
/// at most `budget` bytes, or only the first command when that alone is
/// bigger.
fn cut(body: &[u8], budget: usize) -> usize {
    if body.len() <= budget {
        return body.len();
    }
    let mut last = None;
    for end in body
        .windows(2)
        .enumerate()
        .filter(|(_, pair)| pair == b"\x1b\\")
        .map(|(at, _)| at + 2)
    {
        if end > budget {
            return last.unwrap_or(end);
        }
        last = Some(end);
    }
    body.len()
}

/// kitty's z for an image the pane of `rank` asked to stack at `z`: under
/// every cell with a background of its own, and above the images of every
/// lower rank.
fn band(rank: usize, z: i32) -> i32 {
    let rank = i32::try_from(rank.min(TOP_RANK)).unwrap_or_default();
    DEEPEST + rank * RANK_SPAN + z.clamp(0, RANK_SPAN - 1)
}

/// Takes the placement `(image, placement)` off the screen, keeping the
/// image in kitty.
fn take_off(body: &mut Vec<u8>, (image, placement): (u32, u32)) {
    body.extend_from_slice(format!("\x1b_Ga=d,d=i,i={image},p={placement},q=2\x1b\\").as_bytes());
}

/// Moves the cursor to `visible`'s cell and places it there, replacing the
/// placement with the same ids; scaled only where the pane asked.
fn place(body: &mut Vec<u8>, visible: &Visible) {
    let Visible {
        image,
        placement,
        at,
        offset: (right, down),
        src: [x, y, width, height],
        cells: (columns, rows),
        z,
        ..
    } = *visible;
    let scale: String = [("c", columns), ("r", rows)]
        .into_iter()
        .filter_map(|(key, cells)| Some(format!(",{key}={}", cells?)))
        .collect();
    let command = format!(
        "\x1b[{};{}H\x1b_Ga=p,i={image},p={placement},x={x},y={y},w={width},h={height},X={right},Y={down}{scale},z={z},C=1,q=2\x1b\\",
        u32::from(at.y) + 1,
        u32::from(at.x) + 1,
    );
    body.extend_from_slice(command.as_bytes());
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use orb_term::{GraphicsFrame, Visible};
    use ratatui::layout::Position;

    use super::{Compositor, DrawnImages};

    /// Image 7's placement 1, 10×20 pixels, at outer cell (5, 3).
    fn visible() -> Visible {
        Visible {
            image: 7,
            placement: 1,
            generation: 0,
            at: Position::new(5, 3),
            offset: (0, 0),
            src: [0, 0, 10, 20],
            cells: (None, None),
            z: 0,
        }
    }

    /// Model `model` drawn at `rank`, showing `visible` with `out` waiting.
    fn drawn(model: u64, rank: usize, visible: Vec<Visible>, out: &[u8]) -> DrawnImages {
        let frame = GraphicsFrame {
            out: out.to_vec(),
            visible,
            holes: Vec::new(),
        };
        (model, rank, frame)
    }

    /// What `compositor` writes for `drawn` while models 1 and 2 hold
    /// image 7 and the models `gone` are gone.
    fn written(compositor: &mut Compositor, drawn: &[DrawnImages], gone: &[u64]) -> String {
        let live: HashMap<u64, Vec<u32>> = [1, 2]
            .into_iter()
            .filter(|model| !gone.contains(model))
            .map(|model| (model, vec![7]))
            .collect();
        let mut out = Vec::new();
        let Ok(()) = compositor.write(&mut out, drawn, &[], live) else {
            return "write failed".to_owned();
        };
        String::from_utf8_lossy(&out).into_owned()
    }

    /// Two whole transmits of image 7 together just over [`FRAME_BUDGET`]:
    /// the first fills the budget but for 100 bytes, the second is 200.
    fn two_transmits() -> (String, String) {
        let command = |size: usize| {
            let head = "\x1b_Ga=t,f=32,s=10,v=20,t=d,i=7,q=2,m=1;";
            let payload = "A".repeat(size - head.len() - 2);
            format!("{head}{payload}\x1b\\")
        };
        (command(super::FRAME_BUDGET - 100), command(200))
    }

    /// kitty's placement of [`visible`] at its cell.
    const PLACED: &str =
        "\x1b[4;6H\x1b_Ga=p,i=7,p=1,x=0,y=0,w=10,h=20,X=0,Y=0,z=-2000000000,C=1,q=2\x1b\\";

    #[rstest::rstest]
    fn new_placement_is_placed_inside_cursor_save_restore() {
        // Given a compositor that placed nothing yet.
        let mut compositor = Compositor::default();

        // When a pane shows image 7 at cell (5, 3).
        let written = written(&mut compositor, &[drawn(1, 0, vec![visible()], b"")], &[]);

        // Then kitty is told to place it there, the cursor saved around it.
        assert_eq!(written, format!("\x1b7{PLACED}\x1b8"), "the placement");
    }

    #[rstest::rstest]
    fn scaled_placement_names_only_the_cells_asked_for() {
        // Given a compositor that placed nothing yet.
        let mut compositor = Compositor::default();

        // When a pane shows image 7 scaled to 4 columns, its rows left to
        // kitty.
        let scaled = Visible {
            cells: (Some(4), None),
            ..visible()
        };
        let written = written(&mut compositor, &[drawn(1, 0, vec![scaled], b"")], &[]);

        // Then the placement gives the columns and no rows.
        assert!(
            written.contains(",Y=0,c=4,z=") && !written.contains(",r="),
            "scaled placement {written:?}"
        );
    }

    #[rstest::rstest]
    fn unchanged_frame_writes_nothing() {
        // Given a pane whose image 7 is placed.
        let mut compositor = Compositor::default();
        let frame = [drawn(1, 0, vec![visible()], b"")];
        written(&mut compositor, &frame, &[]);

        // When the next frame shows it the same.
        let written = written(&mut compositor, &frame, &[]);

        // Then nothing is written.
        assert_eq!(written, "", "an unchanged frame");
    }

    #[rstest::rstest]
    fn moved_placement_is_placed_again_with_the_same_ids() {
        // Given a pane whose image 7 is placed at cell (5, 3).
        let mut compositor = Compositor::default();
        written(&mut compositor, &[drawn(1, 0, vec![visible()], b"")], &[]);

        // When the pane moves it one row down.
        let moved = Visible {
            at: Position::new(5, 4),
            ..visible()
        };
        let written = written(&mut compositor, &[drawn(1, 0, vec![moved], b"")], &[]);

        // Then the same placement is placed at the new cell, nothing taken off.
        assert_eq!(
            written,
            "\x1b7\x1b[5;6H\x1b_Ga=p,i=7,p=1,x=0,y=0,w=10,h=20,X=0,Y=0,z=-2000000000,C=1,q=2\x1b\\\x1b8",
            "the placement moved"
        );
    }

    #[rstest::rstest]
    fn queued_output_comes_before_placements() {
        // Given a compositor that placed nothing yet.
        let mut compositor = Compositor::default();

        // When a pane sends image 7 and shows it in the same frame.
        let transmit = "\x1b_Ga=t,f=32,s=10,v=20,t=s,i=7,q=2;bmFtZQ==\x1b\\";
        let frame = drawn(1, 0, vec![visible()], transmit.as_bytes());
        let written = written(&mut compositor, &[frame], &[]);

        // Then kitty gets the image before its placement.
        assert_eq!(
            written,
            format!("\x1b7{transmit}{PLACED}\x1b8"),
            "the transmit, then the placement"
        );
    }

    #[rstest::rstest]
    fn undrawn_pane_placements_are_taken_off_keeping_their_data() {
        // Given a pane whose image 7 is placed.
        let mut compositor = Compositor::default();
        written(&mut compositor, &[drawn(1, 0, vec![visible()], b"")], &[]);

        // When a frame doesn't draw that pane.
        let written = written(&mut compositor, &[], &[]);

        // Then its placement is taken off and the image kept.
        assert_eq!(
            written, "\x1b7\x1b_Ga=d,d=i,i=7,p=1,q=2\x1b\\\x1b8",
            "the placement taken off"
        );
    }

    #[rstest::rstest]
    fn vanished_instance_images_are_freed() {
        // Given a hidden pane holding image 7.
        let mut compositor = Compositor::default();
        written(&mut compositor, &[], &[]);

        // When that pane is gone.
        let written = written(&mut compositor, &[], &[1]);

        // Then kitty frees its image.
        assert_eq!(
            written, "\x1b7\x1b_Ga=d,d=I,i=7,q=2\x1b\\\x1b8",
            "the image freed"
        );
    }

    #[rstest::rstest]
    fn float_images_sit_above_tiled_images() {
        // Given a compositor that placed nothing yet.
        let mut compositor = Compositor::default();

        // When a tiled pane (rank 0) shows an image stacked high and a float
        // (rank 3) one stacked at the bottom.
        let tiled = Visible {
            z: 5000,
            ..visible()
        };
        let float = Visible {
            image: 8,
            ..visible()
        };
        let frames = [drawn(1, 0, vec![tiled], b""), drawn(2, 3, vec![float], b"")];
        let written = written(&mut compositor, &frames, &[]);

        // Then the float's image is above the tiled one's, both under the
        // cells with a background of their own.
        let zs: Vec<i64> = written
            .split(",z=")
            .skip(1)
            .filter_map(|rest| rest.split(',').next()?.parse().ok())
            .collect();
        assert!(
            matches!(zs.as_slice(), [tiled, float] if tiled < float && *float < -1_073_741_824),
            "z values {zs:?}"
        );
    }

    #[rstest::rstest]
    fn image_bytes_past_the_budget_wait_for_the_next_frame() {
        // Given a pane that sent two transmits together over the budget.
        let mut compositor = Compositor::default();
        let (first, second) = two_transmits();
        let frame = drawn(1, 0, vec![visible()], format!("{first}{second}").as_bytes());

        // When composing once.
        let written = written(&mut compositor, &[frame], &[]);

        // Then only the first transmit is written, and the rest waits.
        assert_eq!(
            (written, compositor.pending()),
            (format!("\x1b7{first}\x1b8"), true),
            "the first frame's write"
        );
    }

    #[rstest::rstest]
    fn placements_wait_until_the_image_bytes_are_out() {
        // Given a pane that sent two transmits together over the budget.
        let mut compositor = Compositor::default();
        let (first, second) = two_transmits();
        let frame = drawn(1, 0, vec![visible()], format!("{first}{second}").as_bytes());

        // When composing once.
        let written = written(&mut compositor, &[frame], &[]);

        // Then nothing is placed.
        assert!(
            !written.contains("a=p"),
            "no placement before the image is out"
        );
    }

    #[rstest::rstest]
    fn backlog_goes_out_on_the_next_frame() {
        // Given a frame that held back a transmit past the budget.
        let mut compositor = Compositor::default();
        let (first, second) = two_transmits();
        let frame = drawn(1, 0, vec![visible()], format!("{first}{second}").as_bytes());
        written(&mut compositor, &[frame], &[]);

        // When composing the next frame.
        let written = written(&mut compositor, &[drawn(1, 0, vec![visible()], b"")], &[]);

        // Then it holds the held-back transmit, then the placement.
        assert_eq!(
            written,
            format!("\x1b7{second}{PLACED}\x1b8"),
            "the second frame's write"
        );
    }

    #[rstest::rstest]
    fn image_bytes_past_the_backlog_cap_go_out_in_one_frame() {
        // Given a pane that sent a transmit filling the budget, then one
        // bigger than the most bytes left waiting.
        let mut compositor = Compositor::default();
        let (first, _) = two_transmits();
        let huge = format!(
            "\x1b_Ga=t,f=32,s=10,v=20,t=d,i=7,q=2;{}\x1b\\",
            "A".repeat(super::BACKLOG_CAP)
        );
        let frame = drawn(1, 0, vec![visible()], format!("{first}{huge}").as_bytes());

        // When composing once.
        written(&mut compositor, &[frame], &[]);

        // Then nothing is left waiting.
        assert!(
            !compositor.pending(),
            "a backlog past its cap goes out at once"
        );
    }
}
