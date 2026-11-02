//! A terminal pane: one child process running in a PTY, with its screen kept
//! up to date in the background.

use std::ffi::OsString;
use std::fmt::Display;
use std::io::{self, Read, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use alacritty_terminal::grid::Dimensions;
use error_stack::{Report, ResultExt};
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use ratatui::buffer::Buffer;
use ratatui::crossterm::cursor::SetCursorStyle;
use ratatui::crossterm::event::{KeyEvent, MouseEvent};
use ratatui::layout::{Position, Rect};
use ratatui::style::Color;
use wherror::Error;

use crate::emulator::{Emulator, Notify, lock};
use crate::graphics::GraphicsFrame;

/// The pane's size in character cells, and each cell's size in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneSize {
    /// Width in columns.
    pub cols: u16,
    /// Height in rows.
    pub rows: u16,
    /// Each cell's pixels.
    pub cell: CellSize,
}

impl PaneSize {
    /// The size of `area`, at least 2 columns by 1 row so the child always
    /// has a usable screen, with cells of `cell` pixels.
    pub fn new(area: Rect, cell: CellSize) -> Self {
        Self {
            cols: area.width.max(2),
            rows: area.height.max(1),
            cell,
        }
    }
}

impl Dimensions for PaneSize {
    fn total_lines(&self) -> usize {
        self.screen_lines()
    }

    fn screen_lines(&self) -> usize {
        usize::from(self.rows)
    }

    fn columns(&self) -> usize {
        usize::from(self.cols)
    }
}

/// One character cell in pixels; zero when the outer terminal doesn't say.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CellSize {
    /// Width in pixels.
    pub width: u16,
    /// Height in pixels.
    pub height: u16,
}

/// Whether the images a pane's child sends can reach the screen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum GraphicsSupport {
    /// The outer terminal shows no kitty images: queries get an error, the
    /// rest is dropped.
    #[default]
    None,
    /// The outer terminal is kitty; `transient` (0.48.0 and later) keeps
    /// forwarded images in memory only.
    Kitty { transient: bool },
}

/// The colours a pane's child is told when it asks. A colour that isn't RGB,
/// or a palette entry that is `None`, goes unanswered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneColors {
    /// The colour default text shows in (OSC 10).
    pub foreground: Color,
    /// The colour default backgrounds show in (OSC 11).
    pub background: Color,
    /// The colours a pane's ANSI colours 0–15 show in (OSC 4); `None` where
    /// the outer terminal didn't say.
    pub palette: [Option<Color>; 16],
}

/// What the pane runs, where, and with which environment.
#[derive(Debug, Clone)]
pub struct PaneCommand {
    /// The program followed by its arguments.
    pub argv: Vec<OsString>,
    /// The child's working directory.
    pub cwd: PathBuf,
    /// The child's complete environment; nothing is inherited from orb.
    pub env: Vec<(OsString, OsString)>,
    /// Whether this pane's images reach the outer terminal.
    pub graphics: GraphicsSupport,
    /// What the child is told its colours are; `None` leaves colour queries
    /// unanswered.
    pub colors: Option<PaneColors>,
}

/// Something the pane reports to its owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneEvent {
    /// The child wrote output; the screen may have changed.
    Output,
    /// The child copied text to the clipboard.
    Clipboard(String),
    /// The child exited.
    Exited,
    /// Showing the child's output failed; the pane shows nothing more.
    Broken,
}

/// The name of the thread that feeds a pane's output into its screen. A
/// crash on it stops showing only that pane.
pub const PANE_READER_THREAD: &str = "orb-pane-reader";

/// The pane's child could not be started.
#[derive(Debug, Error)]
#[error(debug)]
pub struct PaneError;

/// A running child in a PTY. Its output is parsed on a background thread, so
/// the screen is current whenever the owner draws; the owner is notified of
/// output, clipboard copies, and exit. The pane keeps 10 000 lines of history
/// for the wheel to scroll back through.
///
/// Dropping the pane kills the child.
pub struct Pane {
    emulator: Arc<Mutex<Emulator>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    exited: Arc<AtomicBool>,
    size: PaneSize,
    /// When the child was started.
    started: Instant,
    /// Whether the child has printed anything yet.
    spoke: Arc<AtomicBool>,
    /// The pane's image model's id, read once at spawn.
    graphics_instance: u64,
}

impl Pane {
    /// Starts `command` in a new PTY of `size`. `notify` is called from
    /// background threads with everything the pane reports.
    ///
    /// # Errors
    ///
    /// Returns [`PaneError`] if the command is empty, the PTY can't be opened,
    /// or the command can't be started.
    pub fn spawn<F>(
        command: &PaneCommand,
        size: PaneSize,
        notify: F,
    ) -> Result<Self, Report<PaneError>>
    where
        F: Fn(PaneEvent) + Send + Sync + 'static,
    {
        let Some((program, args)) = command.argv.split_first() else {
            return Err(Report::new(PaneError).attach("the pane command is empty"));
        };
        let pair = native_pty_system()
            .openpty(pty_size(size))
            .map_err(pty_error)?;
        let reader = pair.master.try_clone_reader().map_err(pty_error)?;
        let writer = spawn_writer(pair.master.take_writer().map_err(pty_error)?)?;
        let builder = {
            let mut builder = CommandBuilder::new(program);
            builder.args(args);
            builder.env_clear();
            for (key, value) in &command.env {
                builder.env(key, value);
            }
            builder.cwd(&command.cwd);
            builder
        };
        let child = pair.slave.spawn_command(builder).map_err(pty_error)?;
        // Our copy of the slave would keep the PTY open after the child exits.
        drop(pair.slave);
        let notify: Notify = Arc::new(notify);
        let emulator = Emulator::new(
            size,
            writer,
            notify.clone(),
            command.graphics,
            command.colors,
        );
        let pane = Self {
            graphics_instance: emulator.graphics_instance(),
            emulator: Arc::new(Mutex::new(emulator)),
            master: pair.master,
            killer: child.clone_killer(),
            exited: Arc::new(AtomicBool::new(false)),
            size,
            started: Instant::now(),
            spoke: Arc::new(AtomicBool::new(false)),
        };
        // From here on, an early return drops `pane`, which kills the child.
        spawn_reader(
            reader,
            pane.emulator.clone(),
            pane.spoke.clone(),
            notify.clone(),
        )?;
        spawn_reaper(child, pane.exited.clone(), notify)?;
        Ok(pane)
    }

    /// Resizes the screen and tells the child, also when only the cells'
    /// pixels changed. Does nothing if the size is unchanged, so it's cheap
    /// to call on every frame.
    pub fn resize(&mut self, size: PaneSize) {
        if size == self.size {
            return;
        }
        self.size = size;
        lock(&self.emulator).resize(size);
        let _ = self.master.resize(pty_size(size));
    }

    /// Whether the child has exited.
    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    /// Whether the child has printed anything yet. A line typed before that
    /// can be lost.
    pub fn has_output(&self) -> bool {
        self.spoke.load(Ordering::SeqCst)
    }

    /// Whether the child has exited and the pane started less than `within`
    /// ago. Asked when the exit wakes the owner, that is whether the child
    /// exited within `within` of starting.
    pub fn exited_early(&self, within: Duration) -> bool {
        self.has_exited() && self.started.elapsed() < within
    }

    /// Sends `key` to the child, encoded for its current keyboard modes. A
    /// press or repeat first returns the view to the bottom and clears the
    /// selection; a release leaves both alone.
    pub fn key(&self, key: &KeyEvent) {
        lock(&self.emulator).key(key);
    }

    /// Sends pasted `text` to the child, after returning the view to the
    /// bottom and clearing the selection.
    pub fn paste(&self, text: &str) {
        lock(&self.emulator).paste(text);
    }

    /// Types `line` and Enter into the child (see [`Emulator::type_line`]).
    pub fn type_line(&self, line: &str) {
        lock(&self.emulator).type_line(line);
    }

    /// Sends a mouse event to the child if it asked for mouse reports and the
    /// event happened over the pane drawn at `area`. `pixel` is where it
    /// happened in the outer terminal's pixels, when the outer terminal
    /// reports them; a child that turned pixel reports on gets them relative
    /// to the pane. A press clears the selection.
    pub fn mouse(&self, event: MouseEvent, area: Rect, pixel: Option<Position>) {
        lock(&self.emulator).mouse(event, area, pixel);
    }

    /// Whether the child asked for mouse reports.
    pub fn reads_mouse(&self) -> bool {
        lock(&self.emulator).reads_mouse()
    }

    /// A wheel notch over the pane drawn at `area`: to the child while it
    /// reads the mouse, as arrow keys on the alternate screen, else a
    /// scroll of the pane's history. `pixel` is as [`Pane::mouse`] takes it.
    pub fn wheel(&self, event: MouseEvent, area: Rect, pixel: Option<Position>) {
        lock(&self.emulator).wheel(event, area, pixel);
    }

    /// Starts a selection at `at` in the pane drawn at `area`: a word on the
    /// second quick press on the same cell, its line on the third, else a
    /// plain selection.
    pub fn select_start(&self, at: Position, area: Rect, now: Instant) {
        lock(&self.emulator).select_start(at, area, now);
    }

    /// Extends the selection to `at`; past the top or bottom edge of `area`
    /// the view scrolls a line that way.
    pub fn select_update(&self, at: Position, area: Rect, now: Instant) {
        lock(&self.emulator).select_update(at, area, now);
    }

    /// Ends the selection, which stays highlighted, and returns its text;
    /// `None` when nothing is selected.
    pub fn select_finish(&self) -> Option<String> {
        lock(&self.emulator).select_finish()
    }

    /// Tells the child the pane gained or lost focus, if it asked to know.
    pub fn focus(&self, focused: bool) {
        lock(&self.emulator).focus(focused);
    }

    /// When a synchronized update the child hasn't finished must be shown
    /// anyway; `None` when there's nothing pending. The owner should call
    /// [`Pane::flush_expired_sync`] once this passes.
    pub fn sync_deadline(&self) -> Option<Instant> {
        lock(&self.emulator).sync_deadline()
    }

    /// Shows a pending synchronized update whose deadline is at or before
    /// `now`.
    pub fn flush_expired_sync(&self, now: Instant) {
        lock(&self.emulator).flush_expired_sync(now);
    }

    /// Draws the child's screen into `area` of `buf`; returns where the cursor
    /// is when the child shows it.
    pub fn render(&self, area: Rect, buf: &mut Buffer) -> Option<Position> {
        lock(&self.emulator).render(area, buf)
    }

    /// Draws the child's screen into `area` of `buf` and, under the same
    /// lock, takes its images for this frame: the bytes waiting for kitty
    /// and where its placements show. A drawn pane's bytes go out with its
    /// cells, so a child's frame never reaches kitty half done. Returns
    /// where the cursor is when the child shows it, and the images.
    pub fn render_with_graphics(
        &self,
        area: Rect,
        buf: &mut Buffer,
    ) -> (Option<Position>, GraphicsFrame) {
        lock(&self.emulator).render_with_graphics(area, buf)
    }

    /// Takes the bytes the pane's images have waiting for kitty. A pane
    /// that isn't drawn hands them over this way, so its images keep
    /// arriving while hidden.
    pub fn take_graphics_output(&self) -> Vec<u8> {
        lock(&self.emulator).take_graphics_output()
    }

    /// The kitty id of every image the pane holds, for freeing them once
    /// the pane is gone.
    pub fn live_images(&self) -> Vec<u32> {
        lock(&self.emulator).live_images()
    }

    /// The pane's image model's id, different for every pane ever made.
    pub fn graphics_instance(&self) -> u64 {
        self.graphics_instance
    }

    /// Starts or stops telling the child that images work. Stopped, its
    /// image questions hear "no graphics" and the images it sends never
    /// show; the ones it already sent are freed.
    pub fn answer_graphics(&self, on: bool) {
        lock(&self.emulator).answer_graphics(on);
    }

    /// The cursor style the child asked for.
    pub fn cursor_style(&self) -> SetCursorStyle {
        lock(&self.emulator).cursor_style()
    }

    /// The child's screen as plain text, after up to `lines` lines of its
    /// history: soft-wrapped rows joined, trailing blanks dropped.
    pub fn text(&self, lines: usize) -> String {
        lock(&self.emulator).text(lines)
    }
}

impl Drop for Pane {
    fn drop(&mut self) {
        // Kill first: dropping the PTY writer sends the child a newline and EOF.
        let _ = self.killer.kill();
    }
}

/// Starts a thread that owns the child's input and writes everything sent to
/// the returned writer into it, in order. Writing to the returned writer never
/// blocks, so a child that stops reading can't stall orb or the thread feeding
/// the child's output.
fn spawn_writer(
    mut input: Box<dyn Write + Send>,
) -> Result<Box<dyn Write + Send>, Report<PaneError>> {
    let (sender, receiver) = mpsc::channel::<Vec<u8>>();
    thread::Builder::new()
        .name("orb-pane-writer".to_owned())
        .spawn(move || {
            for bytes in receiver {
                if input
                    .write_all(&bytes)
                    .and_then(|()| input.flush())
                    .is_err()
                {
                    break;
                }
            }
        })
        .change_context(PaneError)
        .attach("failed to start the pane writer thread")?;
    Ok(Box::new(QueuedWriter(sender)))
}

/// Hands writes to the writer thread.
struct QueuedWriter(Sender<Vec<u8>>);

impl Write for QueuedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.send(buf.to_vec()).map_err(io::Error::other)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Feeds the child's output into `emulator` until the PTY closes, marking
/// `spoke` before the first chunk is fed.
fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    emulator: Arc<Mutex<Emulator>>,
    spoke: Arc<AtomicBool>,
    notify: Notify,
) -> Result<(), Report<PaneError>> {
    let feed = move |chunk: &[u8]| {
        spoke.store(true, Ordering::SeqCst);
        lock(&emulator).feed(chunk);
    };
    thread::Builder::new()
        .name(PANE_READER_THREAD.to_owned())
        .spawn(move || read_into(&mut reader, feed, &*notify))
        .change_context(PaneError)
        .attach("failed to start the pane reader thread")?;
    Ok(())
}

/// Feeds what `reader` yields to `feed` until it ends or fails, telling
/// `notify` after each chunk. A crash in `feed` is caught: `notify` hears
/// [`PaneEvent::Broken`] once and reading stops.
fn read_into<R, F, N>(reader: &mut R, mut feed: F, notify: &N)
where
    R: Read,
    F: FnMut(&[u8]),
    N: Fn(PaneEvent) + ?Sized,
{
    let caught = panic::catch_unwind(AssertUnwindSafe(|| {
        let mut buf = vec![0; 64 * 1024];
        while let Ok(n) = reader.read(&mut buf) {
            let Some(chunk) = buf.get(..n).filter(|chunk| !chunk.is_empty()) else {
                break;
            };
            feed(chunk);
            notify(PaneEvent::Output);
        }
    }));
    if caught.is_err() {
        notify(PaneEvent::Broken);
    }
}

/// Waits for the child to exit, then marks the pane exited. This, not the
/// reader's EOF, is the exit signal: the child's own children can keep the PTY
/// open after it exits.
fn spawn_reaper(
    mut child: Box<dyn Child + Send + Sync>,
    exited: Arc<AtomicBool>,
    notify: Notify,
) -> Result<(), Report<PaneError>> {
    thread::Builder::new()
        .name("orb-pane-reaper".to_owned())
        .spawn(move || {
            let _ = child.wait();
            exited.store(true, Ordering::SeqCst);
            notify(PaneEvent::Exited);
        })
        .change_context(PaneError)
        .attach("failed to start the pane reaper thread")?;
    Ok(())
}

fn pty_size(size: PaneSize) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: size.cols.saturating_mul(size.cell.width),
        pixel_height: size.rows.saturating_mul(size.cell.height),
    }
}

/// portable-pty reports `anyhow` errors, which `change_context` can't take.
fn pty_error<E>(error: E) -> Report<PaneError>
where
    E: Display,
{
    Report::new(PaneError).attach(format!("{error:#}"))
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate spawn failures with `?` and assert on the outcome"
)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use error_stack::Report;
    use ratatui::buffer::{Buffer, Cell};
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::layout::Rect;

    use super::{
        CellSize, GraphicsSupport, Pane, PaneCommand, PaneError, PaneEvent, PaneSize, read_into,
    };
    use crate::emulator::lock;

    /// The outer terminal didn't say its cells' pixels.
    const NO_PIXELS: CellSize = CellSize {
        width: 0,
        height: 0,
    };

    const SIZE: PaneSize = PaneSize {
        cols: 80,
        rows: 24,
        cell: NO_PIXELS,
    };

    /// Runs `argv` in `/` with exactly `env`.
    fn command(argv: &[&str], env: &[(&str, &str)]) -> PaneCommand {
        PaneCommand {
            argv: argv.iter().map(Into::into).collect(),
            cwd: "/".into(),
            env: env
                .iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
            graphics: GraphicsSupport::None,
            colors: None,
        }
    }

    /// A notify callback and the events it has received so far.
    fn recorder() -> (
        Arc<Mutex<Vec<PaneEvent>>>,
        impl Fn(PaneEvent) + Send + Sync + 'static,
    ) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        (events, move |event| lock(&sink).push(event))
    }

    /// Polls `condition` every 10 ms for up to 5 s; returns whether it held.
    fn wait_until<F>(mut condition: F) -> bool
    where
        F: FnMut() -> bool,
    {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        condition()
    }

    /// The pane's screen as text, one trimmed line per row.
    fn screen(pane: &Pane) -> String {
        let area = Rect::new(0, 0, 120, 40);
        let mut buf = Buffer::empty(area);
        pane.render(area, &mut buf);
        (0..area.height)
            .map(|y| {
                let row: String = (0..area.width)
                    .filter_map(|x| buf.cell((x, y)))
                    .map(Cell::symbol)
                    .collect();
                row.trim_end().to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[rstest::rstest]
    fn child_output_appears_in_pane() -> Result<(), Report<PaneError>> {
        // Given a child that prints "hi".
        let command = command(&["/bin/sh", "-c", "printf hi"], &[]);

        // When it runs in a pane.
        let pane = Pane::spawn(&command, SIZE, |_| {})?;

        // Then "hi" shows up on the pane's first row.
        assert!(
            wait_until(|| screen(&pane).starts_with("hi")),
            "screen should start with the child's output, got {:?}",
            screen(&pane)
        );
        Ok(())
    }

    #[rstest::rstest]
    fn child_runs_in_the_given_directory() -> Result<(), Report<PaneError>> {
        // Given `pwd` with `/` as its directory and no environment (so no
        // `$HOME` fallback applies).
        let command = command(&["/bin/pwd"], &[]);

        // When it runs in a pane.
        let pane = Pane::spawn(&command, SIZE, |_| {})?;

        // Then it prints `/`.
        assert!(
            wait_until(|| screen(&pane).lines().next() == Some("/")),
            "pwd should print /, got {:?}",
            screen(&pane)
        );
        Ok(())
    }

    #[rstest::rstest]
    fn child_sees_only_the_given_environment() -> Result<(), Report<PaneError>> {
        // Given `env` with only ORB_TEST=1 in its environment.
        let command = command(&["/usr/bin/env"], &[("ORB_TEST", "1")]);

        // When it runs in a pane and prints its environment.
        let pane = Pane::spawn(&command, SIZE, |_| {})?;
        let printed = wait_until(|| screen(&pane).contains("ORB_TEST=1"));

        // Then it has ORB_TEST, plus the SHELL portable-pty always sets, and
        // nothing inherited from orb.
        let screen = screen(&pane);
        let inherited = screen.lines().any(|line| {
            !(line.is_empty() || line.starts_with("ORB_TEST=") || line.starts_with("SHELL="))
        });
        assert!(
            printed && !inherited,
            "env should be exactly the given one, got {screen:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn resized_pane_reports_new_size_to_child() -> Result<(), Report<PaneError>> {
        // Given an 80×24 pane whose child prints its size after a line of input.
        let command = command(&["/bin/sh", "-c", "read x; /bin/stty size"], &[]);
        let mut pane = Pane::spawn(&command, SIZE, |_| {})?;

        // When the pane is resized to 100×30 and the user presses Enter.
        pane.resize(PaneSize {
            cols: 100,
            rows: 30,
            cell: NO_PIXELS,
        });
        pane.key(&KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

        // Then the child sees 30 rows by 100 columns.
        assert!(
            wait_until(|| screen(&pane).contains("30 100")),
            "stty should report the new size, got {:?}",
            screen(&pane)
        );
        Ok(())
    }

    #[rstest::rstest]
    fn cell_size_change_alone_resizes_the_pty_in_pixels() -> Result<(), Report<PaneError>> {
        // Given an 80×24 pane with cells of 10×20 pixels whose child prints
        // the pty's pixel size after a line of input.
        let command = command(
            &[
                "/bin/sh",
                "-c",
                "read x; /usr/bin/python3 -c \"import fcntl,struct,termios; \
                 r,c,w,h=struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8))); \
                 print(w, h)\"",
            ],
            &[],
        );
        let cell = CellSize {
            width: 10,
            height: 20,
        };
        let mut pane = Pane::spawn(&command, PaneSize { cell, ..SIZE }, |_| {})?;

        // When only the cells grow to 12×24 pixels and the user presses
        // Enter.
        let cell = CellSize {
            width: 12,
            height: 24,
        };
        pane.resize(PaneSize { cell, ..SIZE });
        pane.key(&KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

        // Then the child sees 960×576 pixels.
        assert!(
            wait_until(|| screen(&pane).contains("960 576")),
            "the pty should carry the new pixels, got {:?}",
            screen(&pane)
        );
        Ok(())
    }

    #[rstest::rstest]
    fn child_exit_is_reported() -> Result<(), Report<PaneError>> {
        // Given a child that exits immediately.
        let command = command(&["/usr/bin/true"], &[]);
        let (events, notify) = recorder();

        // When it runs in a pane.
        let _pane = Pane::spawn(&command, SIZE, notify)?;

        // Then the pane reports the exit.
        assert!(
            wait_until(|| lock(&events).contains(&PaneEvent::Exited)),
            "Exited should be reported, got {:?}",
            lock(&events)
        );
        Ok(())
    }

    #[rstest::rstest]
    fn pane_has_exited_after_child_exits() -> Result<(), Report<PaneError>> {
        // Given a child that exits immediately.
        let command = command(&["/usr/bin/true"], &[]);

        // When it runs in a pane.
        let pane = Pane::spawn(&command, SIZE, |_| {})?;

        // Then the pane says its child has exited.
        assert!(
            wait_until(|| pane.has_exited()),
            "has_exited should turn true"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn pane_whose_child_exits_at_once_exited_early() -> Result<(), Report<PaneError>> {
        // Given a pane whose child exits immediately.
        let command = command(&["/usr/bin/true"], &[]);
        let pane = Pane::spawn(&command, SIZE, |_| {})?;

        // When its child has exited.
        let exited = wait_until(|| pane.has_exited());

        // Then it exited within a second of starting.
        assert!(
            exited && pane.exited_early(Duration::from_secs(1)),
            "a child that exits at once should count as an early exit"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn pane_whose_child_exits_later_did_not_exit_early() -> Result<(), Report<PaneError>> {
        // Given a pane whose child exits after 200 ms.
        let command = command(&["/bin/sleep", "0.2"], &[]);
        let pane = Pane::spawn(&command, SIZE, |_| {})?;

        // When its child has exited.
        let exited = wait_until(|| pane.has_exited());

        // Then it did not exit within 100 ms of starting.
        assert!(
            exited && !pane.exited_early(Duration::from_millis(100)),
            "a child that exits after the window should not count as an early exit"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn running_pane_did_not_exit_early() -> Result<(), Report<PaneError>> {
        // Given a pane whose child keeps running.
        let command = command(&["/bin/cat"], &[]);
        let pane = Pane::spawn(&command, SIZE, |_| {})?;

        // When asking right after it starts.
        let early = pane.exited_early(Duration::from_secs(1));

        // Then it has not exited early.
        assert!(!early, "a running child should not count as an early exit");
        Ok(())
    }

    #[rstest::rstest]
    fn large_paste_reaches_the_child() -> Result<(), Report<PaneError>> {
        // Given a child that echoes its input back while reading it.
        let command = command(&["/bin/cat"], &[]);
        let pane = Pane::spawn(&command, SIZE, |_| {})?;

        // When the user pastes about 100 KB ending in a marker line.
        let text = format!(
            "{}END\n",
            "0123456789abcdefghijklmnopqrstuvwxyz\n".repeat(2800)
        );
        pane.paste(&text);

        // Then the whole paste arrives: the marker shows up on screen.
        assert!(
            wait_until(|| screen(&pane).contains("END")),
            "the end of the paste should be echoed, got {:?}",
            screen(&pane)
        );
        Ok(())
    }

    #[rstest::rstest]
    #[expect(clippy::panic, reason = "the test's output handler crashes on purpose")]
    fn panicking_output_handler_reports_the_pane_broken() {
        // Given output to show and an output handler that crashes on its
        // first chunk.
        let mut output = std::io::Cursor::new(b"hello".to_vec());
        let (events, notify) = recorder();
        let mut fed = 0;
        let feed = |_: &[u8]| {
            fed += 1;
            panic!("the output handler crashed");
        };

        // When reading the output into the handler.
        read_into(&mut output, feed, &notify);

        // Then the pane is reported broken once, after one chunk.
        assert_eq!(
            (lock(&events).clone(), fed),
            (vec![PaneEvent::Broken], 1),
            "a crashing handler should report the pane broken once"
        );
    }

    #[rstest::rstest]
    fn pane_has_output_once_its_child_prints() -> Result<(), Report<PaneError>> {
        // Given a child that prints "hi".
        let command = command(&["/bin/sh", "-c", "printf hi"], &[]);

        // When it runs in a pane.
        let pane = Pane::spawn(&command, SIZE, |_| {})?;

        // Then the pane says its child has printed.
        assert!(
            wait_until(|| pane.has_output()),
            "the pane should know its child printed"
        );
        Ok(())
    }
}
