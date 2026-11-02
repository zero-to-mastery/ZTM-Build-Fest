//! Sounds — herdr's "done" and "request" sounds, played when an agent
//! finishes a turn or starts needing the user.
//!
//! A request always plays. A finished turn plays unless the user is looking
//! at that agent. The sounds are built into orb, written into a folder once
//! at startup, and played by the OS's own audio player: `afplay` on macOS,
//! the first of a few common players that works on Linux.

use std::ffi::OsStr;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use error_stack::{Report, ResultExt};
use wherror::Error;

use super::click::on_path;
use crate::common::{Finished, run_within};
use crate::feat::sessions::state::NoticeKind;

/// herdr's "done" sound.
static DONE_MP3: &[u8] = include_bytes!("../../../assets/sounds/done.mp3");
/// herdr's "request" sound.
static REQUEST_MP3: &[u8] = include_bytes!("../../../assets/sounds/request.mp3");

/// Linux's audio players, tried in this order, each with the arguments that
/// go before the sound file. Never bare `aplay`: it plays mp3 bytes as noise.
const LINUX_PLAYERS: [(&str, &[&str]); 5] = [
    ("paplay", &[]),
    ("pw-play", &[]),
    ("ffplay", &["-nodisp", "-autoexit", "-loglevel", "quiet"]),
    ("mpg123", &["-q"]),
    ("mpv", &["--no-video", "--really-quiet"]),
];

/// How long one player may run before it's stopped and the next is tried.
const PLAYER_LIMIT: Duration = Duration::from_secs(5);

/// A sound couldn't be set up or played.
#[derive(Debug, Error)]
#[error(debug)]
pub struct SoundError;

/// Which of herdr's sounds to play.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sound {
    /// A turn finished.
    Done,
    /// An agent needs an approval or an answer.
    Request,
}

/// The sound a notice of `kind` plays, given whether the user is `looking`
/// at its agent: a request always plays, a finished turn only when the user
/// isn't looking.
pub fn sound_for(kind: NoticeKind, looking: bool) -> Option<Sound> {
    match kind {
        NoticeKind::NeedsApproval | NoticeKind::NeedsInput => Some(Sound::Request),
        NoticeKind::Finished if looking => None,
        NoticeKind::Finished => Some(Sound::Done),
    }
}

/// Plays sound files.
pub trait SoundPlayer: Send + Sync {
    fn name(&self) -> &'static str;

    /// Plays the mp3 at `file` to the end, waiting for it.
    ///
    /// # Errors
    ///
    /// Returns an error if the sound couldn't be played.
    fn play(&self, file: &Path) -> Result<(), Report<SoundError>>;
}

/// Plays a sound with the first program, in order, that exits 0 within its
/// time limit; one still running past it is stopped and the next tried.
#[derive(Debug)]
pub struct CommandPlayers {
    /// Each program, with the arguments that go before the sound file.
    programs: Vec<(PathBuf, &'static [&'static str])>,
    /// How long one player may run; tests shorten it.
    limit: Duration,
}

impl CommandPlayers {
    pub fn new(programs: Vec<(PathBuf, &'static [&'static str])>) -> Self {
        Self {
            programs,
            limit: PLAYER_LIMIT,
        }
    }
}

impl SoundPlayer for CommandPlayers {
    fn name(&self) -> &'static str {
        "command"
    }

    fn play(&self, file: &Path) -> Result<(), Report<SoundError>> {
        let mut failures = Vec::new();
        for (program, args) in &self.programs {
            let command = {
                let mut command = Command::new(program);
                command.args(*args).arg(file);
                command
            };
            match run_within(command, self.limit) {
                Ok(Finished::Exited(out)) if out.status.success() => return Ok(()),
                Ok(Finished::Exited(out)) => {
                    failures.push(format!("{}: {}", program.display(), out.status));
                }
                Ok(Finished::TimedOut) => failures.push(format!(
                    "{}: still playing after {} s",
                    program.display(),
                    self.limit.as_secs_f32()
                )),
                Err(error) => failures.push(format!("{}: {error}", program.display())),
            }
        }
        let report = Report::new(SoundError).attach("no audio player played the sound");
        Err(failures
            .into_iter()
            .fold(report, |report, failure| report.attach(failure)))
    }
}

/// Plays nothing.
#[derive(Debug)]
pub struct SilentPlayer;

impl SoundPlayer for SilentPlayer {
    fn name(&self) -> &'static str {
        "none"
    }

    fn play(&self, _file: &Path) -> Result<(), Report<SoundError>> {
        Ok(())
    }
}

/// Shared handle to the [`SoundPlayer`] in use and the sound files it plays.
#[derive(Clone)]
pub struct SoundService {
    player: Arc<dyn SoundPlayer>,
    done: PathBuf,
    request: PathBuf,
}

impl SoundService {
    pub fn new(player: Arc<dyn SoundPlayer>, done: PathBuf, request: PathBuf) -> Self {
        Self {
            player,
            done,
            request,
        }
    }

    /// A service that plays nothing.
    pub fn silent() -> Self {
        Self::new(Arc::new(SilentPlayer), PathBuf::new(), PathBuf::new())
    }

    /// The desktop's sounds: writes them into `dir`, replacing older ones,
    /// and plays them with `afplay` on macOS, or on Linux with the first of
    /// paplay, pw-play, ffplay, mpg123 and mpv on `path` (a `PATH` value)
    /// that works. Anywhere else nothing plays.
    ///
    /// # Errors
    ///
    /// Returns an error if the sound files couldn't be written.
    pub fn desktop(dir: &Path, path: &OsStr) -> Result<Self, Report<SoundError>> {
        fs::create_dir_all(dir)
            .change_context(SoundError)
            .attach_with(|| format!("couldn't create {}", dir.display()))?;
        let done = dir.join("done.mp3");
        let request = dir.join("request.mp3");
        for (file, bytes) in [(&done, DONE_MP3), (&request, REQUEST_MP3)] {
            fs::write(file, bytes)
                .change_context(SoundError)
                .attach_with(|| format!("couldn't write {}", file.display()))?;
        }
        Ok(Self::new(desktop_player(path), done, request))
    }

    /// Plays `sound` to the end, waiting for it.
    ///
    /// # Errors
    ///
    /// Returns an error if the sound couldn't be played.
    pub fn play(&self, sound: Sound) -> Result<(), Report<SoundError>> {
        let file = match sound {
            Sound::Done => &self.done,
            Sound::Request => &self.request,
        };
        self.player.play(file)
    }
}

/// The OS's audio player: `afplay` on macOS, the Linux players `path` has
/// on Linux, nothing anywhere else.
fn desktop_player(path: &OsStr) -> Arc<dyn SoundPlayer> {
    if cfg!(target_os = "macos") {
        let afplay = on_path("afplay", path).unwrap_or_else(|| PathBuf::from("/usr/bin/afplay"));
        Arc::new(CommandPlayers::new(vec![(afplay, &[])]))
    } else if cfg!(target_os = "linux") {
        Arc::new(CommandPlayers::new(
            LINUX_PLAYERS
                .iter()
                .filter_map(|&(program, args)| Some((on_path(program, path)?, args)))
                .collect(),
        ))
    } else {
        Arc::new(SilentPlayer)
    }
}

impl fmt::Debug for SoundService {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Sounds<{}>", self.player.name())
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate failures with `?` and assert on the outcome"
)]
mod tests {
    use std::ffi::OsString;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use error_stack::{Report, ResultExt};
    use tempfile::TempDir;

    use super::{
        CommandPlayers, DONE_MP3, REQUEST_MP3, Sound, SoundError, SoundPlayer, SoundService,
        sound_for,
    };
    use crate::feat::sessions::state::NoticeKind;

    /// Writes a program `name` into `dir` that appends its name and arguments
    /// as one line to `dir/runs`, then exits `code`.
    fn program(dir: &Path, name: &str, code: i32) -> Result<PathBuf, Report<SoundError>> {
        let path = dir.join(name);
        let runs = dir.join("runs");
        fs::write(
            &path,
            format!(
                "#!/bin/sh\necho \"{name} $*\" >> '{}'\nexit {code}\n",
                runs.display()
            ),
        )
        .change_context(SoundError)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).change_context(SoundError)?;
        Ok(path)
    }

    /// Every line the programs in `dir` wrote, in order.
    fn runs(dir: &Path) -> Vec<String> {
        fs::read_to_string(dir.join("runs"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[rstest::rstest]
    #[case::finished_while_looking(NoticeKind::Finished, true, None)]
    #[case::finished_elsewhere(NoticeKind::Finished, false, Some(Sound::Done))]
    #[case::approval_while_looking(NoticeKind::NeedsApproval, true, Some(Sound::Request))]
    #[case::input_while_looking(NoticeKind::NeedsInput, true, Some(Sound::Request))]
    #[case::approval_elsewhere(NoticeKind::NeedsApproval, false, Some(Sound::Request))]
    fn sound_for_follows_herdrs_rule(
        #[case] kind: NoticeKind,
        #[case] looking: bool,
        #[case] expected: Option<Sound>,
    ) {
        // Given a notice of `kind`, with the user looking at its agent or not.
        // When choosing its sound.
        let sound = sound_for(kind, looking);

        // Then it is `expected`.
        assert_eq!(sound, expected, "the sound for {kind:?}, looking {looking}");
    }

    #[rstest::rstest]
    fn command_players_put_the_file_after_the_args() -> Result<(), Report<SoundError>> {
        // Given a player run with two arguments.
        let dir = TempDir::new().change_context(SoundError)?;
        let player = program(dir.path(), "player", 0)?;
        let players = CommandPlayers::new(vec![(player, &["-a", "-b"])]);

        // When playing /s/done.mp3.
        players.play(Path::new("/s/done.mp3"))?;

        // Then it ran with its arguments, then the file.
        assert_eq!(
            runs(dir.path()),
            ["player -a -b /s/done.mp3"],
            "the player's arguments"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn command_players_try_the_next_after_a_failure() -> Result<(), Report<SoundError>> {
        // Given a first player that fails and a second that works.
        let dir = TempDir::new().change_context(SoundError)?;
        let first = program(dir.path(), "first", 1)?;
        let second = program(dir.path(), "second", 0)?;
        let players = CommandPlayers::new(vec![(first, &[]), (second, &[])]);

        // When playing a sound.
        players.play(Path::new("/s/done.mp3"))?;

        // Then both ran, in order.
        assert_eq!(
            runs(dir.path()),
            ["first /s/done.mp3", "second /s/done.mp3"],
            "the players tried"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn command_players_stop_at_the_first_that_works() -> Result<(), Report<SoundError>> {
        // Given a first player that works and a second.
        let dir = TempDir::new().change_context(SoundError)?;
        let first = program(dir.path(), "first", 0)?;
        let second = program(dir.path(), "second", 0)?;
        let players = CommandPlayers::new(vec![(first, &[]), (second, &[])]);

        // When playing a sound.
        players.play(Path::new("/s/done.mp3"))?;

        // Then only the first ran.
        assert_eq!(runs(dir.path()), ["first /s/done.mp3"], "the players tried");
        Ok(())
    }

    #[rstest::rstest]
    fn hung_player_gives_way_to_the_next() {
        // Given a first player that hangs, a second that works, and a 2 s
        // limit. Both are system programs: macOS scans a program written
        // just now on its first run, which under a full test run can outlast
        // the limit.
        let players = CommandPlayers {
            programs: vec![
                (PathBuf::from("/bin/sh"), &["-c", "exec /bin/sleep 30"]),
                (PathBuf::from("/usr/bin/true"), &[]),
            ],
            limit: Duration::from_secs(2),
        };

        // When playing a sound.
        let result = players.play(Path::new("/s/done.mp3"));

        // Then the second player played it.
        assert!(result.is_ok(), "the second player played: {result:?}");
    }

    #[rstest::rstest]
    fn command_players_name_every_failure() -> Result<(), Report<SoundError>> {
        // Given a player that fails and one that's missing.
        let dir = TempDir::new().change_context(SoundError)?;
        let failing = program(dir.path(), "failing", 1)?;
        let missing = dir.path().join("missing");
        let players = CommandPlayers::new(vec![(failing, &[]), (missing, &[])]);

        // When playing a sound.
        let result = players.play(Path::new("/s/done.mp3"));

        // Then it fails, naming both.
        let report = result.err().map(|report| format!("{report:?}"));
        assert!(
            report
                .as_deref()
                .is_some_and(|report| report.contains("failing") && report.contains("missing")),
            "the error names every player tried: {report:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn desktop_writes_the_built_in_sounds() -> Result<(), Report<SoundError>> {
        // Given an empty folder and a PATH with no players.
        let dir = TempDir::new().change_context(SoundError)?;
        let sounds = dir.path().join("sounds");

        // When setting up the desktop's sounds there.
        SoundService::desktop(&sounds, &OsString::from(dir.path()))?;

        // Then both sounds are written, byte for byte.
        let written = (
            fs::read(sounds.join("done.mp3")).change_context(SoundError)?,
            fs::read(sounds.join("request.mp3")).change_context(SoundError)?,
        );
        assert!(
            written.0 == DONE_MP3 && written.1 == REQUEST_MP3,
            "the written sounds match the built-in ones"
        );
        Ok(())
    }
}
