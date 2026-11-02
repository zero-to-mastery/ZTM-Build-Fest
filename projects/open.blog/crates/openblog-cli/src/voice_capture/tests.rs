use std::io::Cursor;
use std::sync::mpsc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use super::*;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn reader(text: &str) -> Receiver<Option<String>> {
    let bytes = text.as_bytes().to_vec();
    spawn_line_reader(move || Cursor::new(bytes))
}

#[test]
fn text_below_the_marker_is_taken_and_the_header_is_not() {
    let header = "# Prompt\n";
    let file = format!("{header}{MARKER}\nso i delted the foldr\r\n\r\nlol  \n");
    assert_eq!(
        text_below_marker(&file, header),
        "so i delted the foldr\n\nlol  "
    );
}

#[test]
fn a_deleted_marker_still_never_saves_the_header() {
    let header = "# Prompt\n# Rule\n";
    assert_eq!(
        text_below_marker(&format!("{header}words\n"), header),
        "words"
    );
    assert_eq!(text_below_marker("just words\n", header), "just words");
    assert_eq!(
        text_below_marker(&format!("{header}{MARKER}\n"), header),
        ""
    );
}

#[test]
fn lines_end_at_a_dot_and_keep_typos_and_blank_lines() {
    let lines = reader("teh first\n\n  indented  \n.\nafter the dot\n");
    let mut out = Vec::new();
    let mut saved = Vec::new();
    let captured = capture_lines(&lines, "", now() + 60, &now, &mut out, &mut |t| {
        saved.push(t.to_string())
    });
    assert_eq!(captured.ended, Ended::Finished);
    assert_eq!(captured.text, "teh first\n\n  indented  ");
    assert_eq!(saved.last().unwrap(), &captured.text);
}

#[test]
fn end_of_input_finishes_and_a_resumed_draft_comes_first() {
    let lines = reader("more\n");
    let captured = capture_lines(
        &lines,
        "so far",
        now() + 60,
        &now,
        &mut Vec::new(),
        &mut |_| {},
    );
    assert_eq!(
        (captured.text.as_str(), captured.ended),
        ("so far\nmore", Ended::Finished)
    );
}

#[test]
fn a_silent_reader_does_not_hold_the_session_past_the_deadline() {
    // The sender stays open and sends one line, then nothing: like a person who stopped typing.
    let (sender, lines) = mpsc::channel();
    sender.send(Some("first".to_string())).unwrap();
    let started = Instant::now();
    let deadline = now() + 1;
    let captured = capture_lines(&lines, "", deadline, &now, &mut Vec::new(), &mut |_| {});
    assert_eq!(captured.ended, Ended::Deadline);
    assert_eq!(captured.text, "first");
    assert!(started.elapsed() < Duration::from_secs(4));
    // A line sent afterwards is never part of it.
    sender.send(Some("late".to_string())).unwrap();
}

#[test]
fn a_line_that_arrives_after_the_deadline_is_discarded() {
    let (sender, lines) = mpsc::channel();
    sender.send(Some("on time".to_string())).unwrap();
    let clock_calls = std::cell::Cell::new(0);
    // The first reads of the clock are before the deadline, the later ones after it.
    let clock = || {
        clock_calls.set(clock_calls.get() + 1);
        if clock_calls.get() <= 1 {
            100
        } else {
            200
        }
    };
    let captured = capture_lines(&lines, "", 150, &clock, &mut Vec::new(), &mut |_| {});
    assert_eq!(captured.ended, Ended::Deadline);
    assert_eq!(captured.text, "");
}

#[test]
fn a_countdown_line_is_printed() {
    let lines = reader("");
    let mut out = Vec::new();
    capture_lines(&lines, "", now() + 30, &now, &mut out, &mut |_| {});
    let printed = String::from_utf8(out).unwrap();
    assert!(printed.contains("left]"), "{printed}");
}

fn script(dir: &Path, name: &str, unix: &str, windows: &str) -> String {
    #[cfg(windows)]
    {
        let _ = unix;
        let path = dir.join(format!("{name}.cmd"));
        std::fs::write(&path, format!("@echo off\r\n{windows}\r\n")).unwrap();
        format!("\"{}\"", path.display())
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = windows;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{unix}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        format!("\"{}\"", path.display())
    }
}

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ob-voice-capture-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

use std::path::PathBuf;

#[test]
fn an_editor_that_closes_hands_back_the_text_below_the_marker() {
    let dir = scratch("editor");
    let editor = script(
        &dir,
        "append",
        "printf 'teh text\n' >> \"$1\"",
        "echo teh text>> \"%~1\"",
    );
    let header = "# header\n";
    let file = dir.join("draft.md");
    let captured = capture_in_editor(
        &editor,
        &file,
        header,
        &format!("{header}{MARKER}\n"),
        now() + 60,
        &now,
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(captured.ended, Ended::Finished);
    assert_eq!(captured.text, "teh text");
    assert!(!file.exists(), "the temporary file is removed");
    let _ = std::fs::remove_dir_all(dir);
}

/// A clock for the deadline tests that does not depend on how fast the machine is. It reads the
/// real time until the editor has saved `needle` into `file`, and from then on says the deadline
/// has arrived. The deadline itself is far away on the real clock, so the save is always "in time"
/// by the file's own modification time, however long the editor takes to start under load.
fn deadline_once_saved(file: PathBuf, needle: &'static str, deadline: i64) -> impl Fn() -> i64 {
    move || match std::fs::read_to_string(&file) {
        Ok(text) if text.contains(needle) => deadline,
        _ => now(),
    }
}

#[test]
fn an_editor_still_open_at_the_deadline_is_read_as_it_stands() {
    let dir = scratch("slow");
    let editor = script(
        &dir,
        "slow",
        "printf 'written in time
' >> \"$1\"
exec sleep 60",
        "echo written in time>> \"%~1\"
ping -n 61 127.0.0.1 >nul",
    );
    let header = "# header
";
    let file = dir.join("draft.md");
    let deadline = now() + 120;
    let clock = deadline_once_saved(file.clone(), "written in time", deadline);
    let started = Instant::now();
    let captured = capture_in_editor(
        &editor,
        &file,
        header,
        &format!(
            "{header}{MARKER}
"
        ),
        deadline,
        &clock,
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(captured.ended, Ended::Deadline);
    assert_eq!(captured.text, "written in time");
    // The editor would have kept running for a minute: it was stopped, not waited for.
    assert!(started.elapsed() < Duration::from_secs(30));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_missing_editor_is_a_plain_error() {
    let dir = scratch("missing");
    let file = dir.join("draft.md");
    let result = capture_in_editor(
        "definitely-not-an-editor-xyz",
        &file,
        "",
        MARKER,
        now() + 60,
        &now,
        &mut |_| {},
    );
    assert!(result.unwrap_err().contains("did not finish normally"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn each_session_gets_its_own_editor_file_and_stale_ones_are_removed() {
    let first = session_file_name("editing");
    let second = session_file_name("editing");
    assert_ne!(first, second);
    assert!(first.starts_with("editing-") && first.ends_with(".md"));
    let dir = scratch("stale");
    for name in ["editing.md", "editing-old.md", "polishing-1.md", "keep.md"] {
        std::fs::write(dir.join(name), "x").unwrap();
    }
    remove_stale(&dir, "editing");
    assert!(!dir.join("editing.md").exists());
    assert!(!dir.join("editing-old.md").exists());
    assert!(dir.join("polishing-1.md").exists());
    assert!(dir.join("keep.md").exists());
    remove_stale(&dir, "polishing");
    assert!(!dir.join("polishing-1.md").exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_deadline_stops_the_whole_editor_so_a_later_save_never_lands() {
    let dir = scratch("tree");
    // The editor saves once, then keeps appending a heartbeat from a loop that runs a child
    // process each time. If any of it survived the deadline the heartbeat would keep growing.
    let editor = script(
        &dir,
        "tree",
        "printf 'in time
' >> \"$1\"
while :; do printf x >> \"$1.beat\"; sleep 1; done",
        "echo in time>> \"%~1\"
:beat
echo x>> \"%~1.beat\"
ping -n 2 127.0.0.1 >nul
goto beat",
    );
    let header = "# header
";
    let file = dir.join("draft.md");
    let deadline = now() + 120;
    let clock = deadline_once_saved(file.clone(), "in time", deadline);
    let started = Instant::now();
    let captured = capture_in_editor(
        &editor,
        &file,
        header,
        &format!(
            "{header}{MARKER}
"
        ),
        deadline,
        &clock,
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(captured.ended, Ended::Deadline);
    assert_eq!(captured.text, "in time");
    assert!(started.elapsed() < Duration::from_secs(30));
    // Let anything still running show itself: a surviving loop beats at least once a second.
    let beat = dir.join("draft.md.beat");
    let size = |path: &PathBuf| std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let before = size(&beat);
    std::thread::sleep(Duration::from_millis(2500));
    assert_eq!(
        size(&beat),
        before,
        "the editor process survived the deadline"
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// An editor that saves once in time and once after the deadline. The clock runs two seconds
/// behind, so the program has not yet noticed the deadline when the late save arrives.
fn late_save(tail_seconds: u32) -> (Captured, PathBuf) {
    let dir = scratch(&format!("late{tail_seconds}"));
    let editor = script(
        &dir,
        "late",
        &format!(
            "printf 'in time\n' >> \"$1\"\nsleep 3\nprintf 'too late\n' >> \"$1\"\nsleep {tail_seconds}"
        ),
        &format!(
            "echo in time>> \"%~1\"\r\nping -n 4 127.0.0.1 >nul\r\necho too late>> \"%~1\"\r\nping -n {} 127.0.0.1 >nul",
            tail_seconds + 1
        ),
    );
    let header = "# header\n";
    let file = dir.join("draft.md");
    let deadline = now() + 2;
    let behind = || now() - 2;
    let mut accepted = Vec::new();
    let captured = capture_in_editor(
        &editor,
        &file,
        header,
        &format!("{header}{MARKER}\n"),
        deadline,
        &behind,
        &mut |t| accepted.push(t.to_string()),
    )
    .unwrap();
    assert!(
        accepted.iter().all(|t| !t.contains("too late")),
        "{accepted:?}"
    );
    (captured, dir)
}

#[test]
fn text_saved_after_the_deadline_is_not_captured_when_the_editor_closes() {
    let (captured, dir) = late_save(0);
    assert_eq!(captured.ended, Ended::Deadline);
    assert_eq!(captured.text, "in time");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn text_saved_after_the_deadline_is_not_captured_when_the_editor_stays_open() {
    let (captured, dir) = late_save(8);
    assert_eq!(captured.ended, Ended::Deadline);
    assert_eq!(captured.text, "in time");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_editor_file_that_cannot_be_read_at_the_end_keeps_the_last_text_seen() {
    let dir = scratch("vanished");
    // Saves once, waits long enough to be seen, then the file disappears before it exits.
    let editor = script(
        &dir,
        "vanish",
        "printf 'seen in time\n' >> \"$1\"\nsleep 2\nrm -f \"$1\"",
        "echo seen in time>> \"%~1\"\r\nping -n 3 127.0.0.1 >nul\r\ndel /q \"%~1\"",
    );
    let header = "# header\n";
    let file = dir.join("draft.md");
    let mut seen = Vec::new();
    let captured = capture_in_editor(
        &editor,
        &file,
        header,
        &format!("{header}{MARKER}\n"),
        now() + 60,
        &now,
        &mut |text| seen.push(text.to_string()),
    )
    .unwrap();
    assert_eq!(captured.text, "seen in time", "{seen:?}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_editor_that_returns_at_once_without_a_change_is_not_the_end_of_the_writing() {
    let dir = scratch("nowait");
    let editor = script(&dir, "nowait", "exit 0", "exit /b 0");
    let header = "# header\n";
    let file = dir.join("draft.md");
    let result = capture_in_editor(
        &editor,
        &file,
        header,
        &format!("{header}{MARKER}\nso far\n"),
        now() + 60,
        &now,
        &mut |_| {},
    );
    assert!(result.unwrap_err().contains("--wait"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_running_window_keeps_its_editor_file() {
    let dir = scratch("live");
    let mine = format!("editing-{}-1.md", std::process::id());
    std::fs::write(dir.join(&mine), "x").unwrap();
    assert!(
        !other_window_editing(&dir, "editing"),
        "this process is not another window"
    );
    remove_stale(&dir, "editing");
    assert!(
        !dir.join(&mine).exists(),
        "this process's own leftover goes"
    );
    // A process that is surely running: this test's parent is not knowable everywhere, so spawn one.
    let mut child = std::process::Command::new(if cfg!(windows) { "ping" } else { "sleep" })
        .args(if cfg!(windows) {
            vec!["-n", "30", "127.0.0.1"]
        } else {
            vec!["30"]
        })
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let theirs = format!("editing-{}-2.md", child.id());
    std::fs::write(dir.join(&theirs), "x").unwrap();
    assert!(other_window_editing(&dir, "editing"));
    remove_stale(&dir, "editing");
    assert!(
        dir.join(&theirs).exists(),
        "a running window's file is left alone"
    );
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        !process_alive(child.id()),
        "a stopped process is not running"
    );
    remove_stale(&dir, "editing");
    let _ = std::fs::remove_dir_all(dir);
}
