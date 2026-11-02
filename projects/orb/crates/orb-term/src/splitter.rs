//! Picks out of a pane's raw output the few sequences orb handles itself,
//! before the rest reaches the terminal emulator.
//!
//! The child's output arrives in reads that can cut any sequence in two, so
//! the start of a cut sequence is carried into the next read. What comes out
//! keeps the child's byte order: runs of text for the emulator, kitty graphics
//! commands, and markers for the synchronized-update brackets, the cell-size,
//! version and pixel-mouse queries, pixel-mouse switches, screen clears and
//! resets. Only the exact forms below are picked out; everything else stays
//! text.

use std::borrow::Cow;
use std::mem;

const ESC: u8 = 0x1b;
/// The longest unfinished escape sequence carried into the next read; a
/// longer one is let through as text.
const MAX_ESCAPE: usize = 32;
/// The largest graphics command kept; a bigger one is dropped whole.
const MAX_GRAPHICS: usize = 16 * 1024 * 1024;
/// The length of `ESC _ G`, which starts a graphics command.
const GRAPHICS_START: usize = 3;

/// One piece of a pane's output, in the order the child wrote it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Piece<'a> {
    /// Bytes for the terminal, unchanged: borrowed from the read, or owned
    /// when part of them came from the previous read.
    Text(Cow<'a, [u8]>),
    /// A kitty graphics command: the bytes between `ESC _ G` and `ESC \`.
    Graphics(Vec<u8>),
    /// The start of a synchronized update (`CSI ? 2026 h`), taken out of the
    /// text.
    SyncStart,
    /// The end of a synchronized update (`CSI ? 2026 l`), taken out of the
    /// text.
    SyncEnd,
    /// A question for the cell size in pixels (`CSI 16 t`), taken out of the
    /// text.
    CellSizeQuery,
    /// A question for the terminal's name and version (`CSI > q` or
    /// `CSI > 0 q`), taken out of the text.
    VersionQuery,
    /// Follows a private mode set or reset whose parameters include 1016
    /// (pixel mouse reports), left in the text before it; `true` for set.
    PixelMouse(bool),
    /// A question for the pixel mouse mode (`CSI ? 1016 $ p`), taken out of
    /// the text.
    PixelMouseQuery,
    /// Follows a screen clear (`CSI 2 J` or `CSI 3 J`) left in the text before
    /// it.
    ClearedScreen,
    /// Follows a full reset (`ESC c`) left in the text before it.
    Reset,
}

impl Piece<'_> {
    /// The same piece, owning its bytes.
    pub(crate) fn into_owned(self) -> Piece<'static> {
        match self {
            Piece::Text(text) => Piece::Text(Cow::Owned(text.into_owned())),
            Piece::Graphics(body) => Piece::Graphics(body),
            Piece::SyncStart => Piece::SyncStart,
            Piece::SyncEnd => Piece::SyncEnd,
            Piece::CellSizeQuery => Piece::CellSizeQuery,
            Piece::VersionQuery => Piece::VersionQuery,
            Piece::PixelMouse(on) => Piece::PixelMouse(on),
            Piece::PixelMouseQuery => Piece::PixelMouseQuery,
            Piece::ClearedScreen => Piece::ClearedScreen,
            Piece::Reset => Piece::Reset,
        }
    }
}

/// Splits a pane's output into [`Piece`]s, read after read.
#[derive(Debug, Default)]
pub(crate) struct Splitter {
    /// The bytes of a sequence the last read cut off.
    carry: Vec<u8>,
    /// What the carried bytes are.
    open: Open,
}

/// What the previous read left unfinished.
#[derive(Debug, Clone, Copy, Default)]
enum Open {
    /// Nothing: the next read starts fresh.
    #[default]
    Nothing,
    /// The start of an escape sequence that may still be one orb picks out.
    Escape,
    /// A graphics command's bytes so far.
    Graphics,
    /// A graphics command over the size limit, skipped to its end; `esc` when
    /// the last read ended in the first byte of `ESC \`.
    Skipping { esc: bool },
}

/// What the bytes at an `ESC` turned out to be.
enum Seq {
    /// The start of a sequence orb picks out, cut short.
    Partial,
    /// Text: none of orb's sequences starts here. Scanning goes on from this
    /// index, the first byte that rules them all out.
    Text(usize),
    /// A sequence of this length that orb takes out of the text.
    TakenOut(Piece<'static>, usize),
    /// A sequence of this length left in the text, followed by a marker.
    Marked(Piece<'static>, usize),
    /// `ESC _ G`, the start of a graphics command.
    Graphics,
}

impl Splitter {
    /// Splits one read. A sequence cut at its end is carried into the next
    /// call.
    pub(crate) fn split<'a>(&mut self, bytes: &'a [u8]) -> Vec<Piece<'a>> {
        let mut pieces = Vec::new();
        let mut rest = bytes;
        while !rest.is_empty() {
            rest = match self.open {
                Open::Nothing => self.text(rest, &mut pieces),
                Open::Escape => self.resume_escape(rest, &mut pieces),
                Open::Graphics | Open::Skipping { .. } => self.graphics(rest, &mut pieces),
            };
        }
        pieces
    }

    /// Scans `bytes` from a fresh start, keeping each run of text whole up to
    /// the next sequence orb picks out; returns what follows that sequence.
    fn text<'a>(&mut self, bytes: &'a [u8], pieces: &mut Vec<Piece<'a>>) -> &'a [u8] {
        let mut scanned = 0;
        loop {
            let Some(at) = bytes
                .get(scanned..)
                .and_then(|unscanned| unscanned.iter().position(|&byte| byte == ESC))
                .map(|at| scanned + at)
            else {
                push_text(pieces, Cow::Borrowed(bytes));
                return &[];
            };
            let (before, seq) = bytes.split_at_checked(at).unwrap_or((bytes, &[]));
            match classify(seq) {
                Seq::Text(skip) => scanned = at + skip,
                Seq::Partial if seq.len() >= MAX_ESCAPE => {
                    push_text(pieces, Cow::Borrowed(bytes));
                    return &[];
                }
                Seq::Partial => {
                    push_text(pieces, Cow::Borrowed(before));
                    self.carry.extend_from_slice(seq);
                    self.open = Open::Escape;
                    return &[];
                }
                Seq::TakenOut(piece, len) => {
                    push_text(pieces, Cow::Borrowed(before));
                    pieces.push(piece);
                    return seq.get(len..).unwrap_or_default();
                }
                Seq::Marked(piece, len) => {
                    let (text, after) = bytes.split_at_checked(at + len).unwrap_or((bytes, &[]));
                    push_text(pieces, Cow::Borrowed(text));
                    pieces.push(piece);
                    return after;
                }
                Seq::Graphics => {
                    push_text(pieces, Cow::Borrowed(before));
                    self.open = Open::Graphics;
                    return seq.get(GRAPHICS_START..).unwrap_or_default();
                }
            }
        }
    }

    /// Finishes the escape sequence the last read cut off with the start of
    /// `bytes`; returns the bytes after it.
    fn resume_escape<'a>(&mut self, bytes: &'a [u8], pieces: &mut Vec<Piece<'a>>) -> &'a [u8] {
        let carried = self.carry.len();
        let (head, _) = bytes
            .split_at_checked(MAX_ESCAPE.saturating_sub(carried))
            .unwrap_or((bytes, &[]));
        self.carry.extend_from_slice(head);
        // How much of the joined bytes is text, the marker after it, how much
        // of them the sequence used, and what comes next.
        let (text, marker, used, open) = match classify(&self.carry) {
            Seq::Partial if self.carry.len() < MAX_ESCAPE => return &[],
            Seq::Partial => (self.carry.len(), None, self.carry.len(), Open::Nothing),
            Seq::Text(len) => (len, None, len, Open::Nothing),
            Seq::TakenOut(piece, len) => (0, Some(piece), len, Open::Nothing),
            Seq::Marked(piece, len) => (len, Some(piece), len, Open::Nothing),
            Seq::Graphics => (0, None, GRAPHICS_START, Open::Graphics),
        };
        self.carry.truncate(text);
        push_text(pieces, Cow::Owned(mem::take(&mut self.carry)));
        pieces.extend(marker);
        self.open = open;
        bytes
            .get(used.saturating_sub(carried)..)
            .unwrap_or_default()
    }

    /// Collects a graphics command's bytes up to its `ESC \`; returns the
    /// bytes after it.
    fn graphics<'a>(&mut self, bytes: &'a [u8], pieces: &mut Vec<Piece<'a>>) -> &'a [u8] {
        let esc_before = match self.open {
            Open::Skipping { esc } => esc,
            _ => self.carry.last() == Some(&ESC),
        };
        // Where the command's bytes in this read stop, and where the bytes
        // after its `ESC \` start; `None` when it goes on into the next read.
        let end = match bytes.first() {
            Some(b'\\') if esc_before => {
                self.carry.pop();
                Some((0, 1))
            }
            _ => bytes
                .windows(2)
                .position(|pair| pair == b"\x1b\\")
                .map(|at| (at, at + 2)),
        };
        let (body, after) = match end {
            Some((stop, after)) => (
                bytes.get(..stop).unwrap_or_default(),
                bytes.get(after..).unwrap_or_default(),
            ),
            None => (bytes, &[][..]),
        };
        let skipping = matches!(self.open, Open::Skipping { .. })
            || self.carry.len() + body.len() > MAX_GRAPHICS;
        match (skipping, end) {
            (false, Some(_)) => {
                self.carry.extend_from_slice(body);
                pieces.push(Piece::Graphics(mem::take(&mut self.carry)));
                self.open = Open::Nothing;
            }
            (false, None) => self.carry.extend_from_slice(body),
            (true, Some(_)) => {
                self.carry = Vec::new();
                self.open = Open::Nothing;
            }
            (true, None) => {
                self.carry = Vec::new();
                self.open = Open::Skipping {
                    esc: bytes.last() == Some(&ESC),
                };
            }
        }
        after
    }
}

/// Adds `text` as a piece unless it is empty.
fn push_text<'a>(pieces: &mut Vec<Piece<'a>>, text: Cow<'a, [u8]>) {
    if !text.is_empty() {
        pieces.push(Piece::Text(text));
    }
}

/// What `seq`, which starts with `ESC`, is.
fn classify(seq: &[u8]) -> Seq {
    match seq {
        [ESC] | [ESC, b'_'] => Seq::Partial,
        [ESC, b'c', ..] => Seq::Marked(Piece::Reset, 2),
        [ESC, b'_', b'G', ..] => Seq::Graphics,
        [ESC, b'_', ..] => Seq::Text(2),
        [ESC, b'[', body @ ..] => csi(body),
        _ => Seq::Text(1),
    }
}

/// What a CSI is, from the bytes after its `ESC [`: parameter and
/// intermediate bytes, then one final byte.
fn csi(body: &[u8]) -> Seq {
    let Some(last) = body.iter().position(|byte| !(0x20..=0x3f).contains(byte)) else {
        return Seq::Partial;
    };
    let len = 2 + last + 1;
    match body.get(..=last).unwrap_or_default() {
        b"?2026h" => Seq::TakenOut(Piece::SyncStart, len),
        b"?2026l" => Seq::TakenOut(Piece::SyncEnd, len),
        b"16t" => Seq::TakenOut(Piece::CellSizeQuery, len),
        b">q" | b">0q" => Seq::TakenOut(Piece::VersionQuery, len),
        b"2J" | b"3J" => Seq::Marked(Piece::ClearedScreen, len),
        b"?1016$p" => Seq::TakenOut(Piece::PixelMouseQuery, len),
        [b'?', params @ .., end @ (b'h' | b'l')]
            if params
                .split(|byte| *byte == b';')
                .any(|param| param == b"1016") =>
        {
            Seq::Marked(Piece::PixelMouse(*end == b'h'), len)
        }
        [.., 0x40..=0x7e] => Seq::Text(len),
        _ => Seq::Text(2 + last),
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use super::{MAX_GRAPHICS, Piece, Splitter};

    /// The pieces `reads` split into, one read after another, owned, with
    /// neighbouring text joined.
    fn pieces(reads: &[&[u8]]) -> Vec<Piece<'static>> {
        let mut splitter = Splitter::default();
        let mut pieces: Vec<Piece<'static>> = Vec::new();
        for read in reads {
            for piece in splitter.split(read) {
                match (pieces.last_mut(), piece) {
                    (Some(Piece::Text(joined)), Piece::Text(text)) => {
                        joined.to_mut().extend_from_slice(&text);
                    }
                    (_, piece) => pieces.push(piece.into_owned()),
                }
            }
        }
        pieces
    }

    /// A text piece holding `bytes`.
    fn text(bytes: &[u8]) -> Piece<'static> {
        Piece::Text(Cow::Owned(bytes.to_vec()))
    }

    #[rstest::rstest]
    fn graphics_command_cut_anywhere_comes_out_whole() {
        // Given a cursor move then a graphics command, as terminal-browser
        // writes them.
        let body: &[u8] = b"a=T,f=32,s=154,v=110,t=s,i=41,p=1,C=1,z=532,X=3,Y=21,N=1,q=2;\
            L3B4LTY1NzcwLTAtNjEy";
        let sample = [b"\x1b[35;101H\x1b_G", body, b"\x1b\\"].concat();

        for cut in 0..=sample.len() {
            // When it arrives in two reads cut at `cut`.
            let (first, second) = sample.split_at_checked(cut).unwrap_or_default();
            let split = pieces(&[first, second]);

            // Then the cursor move is text and the command comes out once,
            // whole.
            assert_eq!(
                split,
                [text(b"\x1b[35;101H"), Piece::Graphics(body.to_vec())],
                "pieces for the cut at byte {cut}"
            );
        }
    }

    #[rstest::rstest]
    fn apc_other_than_graphics_stays_text() {
        // Given an application command that isn't a graphics command.
        let output = b"a\x1b_Xhello\x1b\\b";

        // When splitting it.
        let split = pieces(&[output]);

        // Then all of it is text.
        assert_eq!(split, [text(output)], "a non-graphics APC is text");
    }

    #[rstest::rstest]
    #[case::start(b"h", Piece::SyncStart)]
    #[case::end(b"l", Piece::SyncEnd)]
    fn sync_markers_never_reach_the_text(#[case] last: &[u8], #[case] marker: Piece<'static>) {
        // Given text around a synchronized-update bracket.
        let output = [b"a\x1b[?2026", last, b"b"].concat();

        // When splitting it.
        let split = pieces(&[&output]);

        // Then the bracket comes out as a marker between the two texts.
        assert_eq!(
            split,
            [text(b"a"), marker, text(b"b")],
            "the bracket is taken out of the text"
        );
    }

    #[rstest::rstest]
    fn sync_start_cut_across_reads_is_recognised() {
        // Given a synchronized-update start cut in two reads.
        let reads: [&[u8]; 2] = [b"a\x1b[?20", b"26hb"];

        // When splitting them.
        let split = pieces(&reads);

        // Then the start comes out as a marker.
        assert_eq!(
            split,
            [text(b"a"), Piece::SyncStart, text(b"b")],
            "the cut start is still recognised"
        );
    }

    #[rstest::rstest]
    fn cell_size_query_is_taken_out_of_the_text() {
        // Given text around a cell-size query.
        let output = b"a\x1b[16tb";

        // When splitting it.
        let split = pieces(&[output]);

        // Then the query comes out on its own.
        assert_eq!(
            split,
            [text(b"a"), Piece::CellSizeQuery, text(b"b")],
            "the query is taken out of the text"
        );
    }

    #[rstest::rstest]
    #[case::bare(b"\x1b[>q")]
    #[case::zero(b"\x1b[>0q")]
    fn version_query_is_taken_out_of_the_text(#[case] query: &[u8]) {
        // Given text around a version query.
        let output = [b"a", query, b"b"].concat();

        // When splitting it.
        let split = pieces(&[&output]);

        // Then the query comes out on its own.
        assert_eq!(
            split,
            [text(b"a"), Piece::VersionQuery, text(b"b")],
            "the query is taken out of the text"
        );
    }

    #[rstest::rstest]
    #[case::screen(b"2J")]
    #[case::screen_and_history(b"3J")]
    fn screen_clear_stays_in_the_text_and_is_marked(#[case] clear: &[u8]) {
        // Given text around a screen clear.
        let output = [b"a\x1b[", clear, b"b"].concat();

        // When splitting it.
        let split = pieces(&[&output]);

        // Then the clear stays in the text before it and a marker follows.
        assert_eq!(
            split,
            [
                text(&[b"a\x1b[", clear].concat()),
                Piece::ClearedScreen,
                text(b"b")
            ],
            "the clear is text, then marked"
        );
    }

    #[rstest::rstest]
    fn reset_stays_in_the_text_and_is_marked() {
        // Given text around a full reset.
        let output = b"a\x1bcb";

        // When splitting it.
        let split = pieces(&[output]);

        // Then the reset stays in the text before it and a marker follows.
        assert_eq!(
            split,
            [text(b"a\x1bc"), Piece::Reset, text(b"b")],
            "the reset is text, then marked"
        );
    }

    #[rstest::rstest]
    fn pixel_mouse_query_is_taken_out_of_the_text() {
        // Given text around a pixel mouse mode query.
        let output = b"ab\x1b[?1016$pcd";

        // When splitting it.
        let split = pieces(&[output]);

        // Then the query comes out on its own.
        assert_eq!(
            split,
            [text(b"ab"), Piece::PixelMouseQuery, text(b"cd")],
            "the query is taken out of the text"
        );
    }

    #[rstest::rstest]
    #[case::set(b"\x1b[?1016h", true)]
    #[case::reset(b"\x1b[?1016l", false)]
    #[case::among_others(b"\x1b[?1003;1006;1016h", true)]
    fn pixel_mouse_switch_stays_in_the_text(#[case] switch: &[u8], #[case] on: bool) {
        // Given a mode switch naming pixel mouse reports.

        // When splitting it.
        let split = pieces(&[switch]);

        // Then it stays text and a marker follows.
        assert_eq!(
            split,
            [text(switch), Piece::PixelMouse(on)],
            "the switch is text, then marked"
        );
    }

    #[rstest::rstest]
    fn other_escapes_pass_through_unchanged() {
        // Given colours, text and an alternate-screen switch.
        let output = b"\x1b[1;31mhi\x1b[0m\x1b[?1049h";

        // When splitting it in one read.
        let split = Splitter::default().split(output);

        // Then it comes out as one unchanged text.
        assert_eq!(split, [text(output)], "one run of text");
    }

    #[rstest::rstest]
    fn long_escape_cut_across_reads_stays_text() {
        // Given a colour sequence longer than the carry limit, cut in its
        // middle.
        let output = [b"a\x1b[".as_slice(), &b"1;".repeat(20), b"31mb"].concat();
        let (first, second) = output.split_at_checked(30).unwrap_or_default();

        // When splitting the two reads.
        let split = pieces(&[first, second]);

        // Then every byte comes out as text, in order.
        assert_eq!(split, [text(&output)], "a long sequence is text");
    }

    #[rstest::rstest]
    fn graphics_command_past_the_limit_is_dropped_whole() {
        // Given a graphics command one byte over the limit, ended in a
        // second read that goes on with text.
        let first = [b"a\x1b_G".as_slice(), &vec![b'A'; MAX_GRAPHICS + 1]].concat();
        let second = b"AAA\x1b\\b";

        // When splitting the two reads.
        let split = pieces(&[&first, second]);

        // Then only the text around it comes out.
        assert_eq!(split, [text(b"ab")], "the oversized command is dropped");
    }
}
