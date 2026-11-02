//! `openblog voice` through the real command line (ADR 0269): the post-init invitation never
//! prompts a script, a session draws, captures against the clock and locks the rough draft
//! exactly as written, an interrupted session resumes with its saved deadline (an expired one
//! locks), a rough draft stays byte-identical through polish, diff and promote, and a polished
//! draft becomes a post draft.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PRIVATE: &str = ".openblog/private/context/voice";
const PORTABLE: &str = "assistant/context/voice";
const PROMPT: &str = "a-mistake-i-made";

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_openblog")
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn command(args: &[&str]) -> Command {
    let mut command = Command::new(bin());
    command
        .args(args)
        .env_remove("VISUAL")
        .env_remove("EDITOR")
        .env_remove("OPENBLOG_WORKSPACE");
    command
}

fn run(dir: &Path, args: &[&str], stdin: &str) -> Output {
    run_with(dir, args, stdin, &[])
}

fn run_with(dir: &Path, args: &[&str], stdin: &str, env: &[(&str, &str)]) -> Output {
    let mut command = command(args);
    command
        .arg("--root")
        .arg(dir)
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn site(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "openblog-voice-cli-{tag}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let output = command(&["init"])
        .arg(&dir)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", text(&output));
    dir
}

fn samples(dir: &Path, folder: &str) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir.join(folder))
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn session_path(dir: &Path) -> PathBuf {
    dir.join(".openblog/private/voice/session.json")
}

/// A session record that started `age` seconds ago with a window of `limit` seconds.
fn write_session(dir: &Path, age: i64, limit: i64, draft: &str) {
    let rfc = |unix: i64| {
        let days = unix.div_euclid(86_400);
        let secs = unix.rem_euclid(86_400);
        // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let year = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = if month <= 2 { year + 1 } else { year };
        format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
            secs / 3600,
            secs % 3600 / 60,
            secs % 60
        )
    };
    let started = unix_now() - age;
    let record = serde_json::json!({
        "format": "openblog-voice-session",
        "version": 1,
        "promptId": PROMPT,
        "pack": "stories",
        "catalogVersion": 1,
        "startedAt": rfc(started),
        "deadline": rfc(started + limit),
        "timeLimitSeconds": limit,
        "draft": draft,
        "surface": "cli",
        "visibility": "private",
    });
    let path = session_path(dir);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, record.to_string()).unwrap();
}

fn sample_body(path: &Path) -> String {
    let raw = fs::read_to_string(path).unwrap().replace("\r\n", "\n");
    let rest = &raw[4..];
    let end = rest.find("\n---\n").unwrap();
    rest[end + 5..]
        .strip_prefix('\n')
        .unwrap()
        .strip_suffix('\n')
        .unwrap()
        .to_string()
}

#[cfg(windows)]
fn fake_editor(dir: &Path, name: &str, unix: &str, windows: &str) -> String {
    let _ = unix;
    let path = dir.join(format!("{name}.cmd"));
    fs::write(&path, format!("@echo off\r\n{windows}\r\n")).unwrap();
    format!("\"{}\"", path.display())
}

#[cfg(not(windows))]
fn fake_editor(dir: &Path, name: &str, unix: &str, windows: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    let _ = windows;
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\n{unix}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    format!("\"{}\"", path.display())
}

// ---- the post-init invitation (VS2.1.1) --------------------------------------------------

#[test]
fn init_never_asks_a_script_and_does_not_hang() {
    let dir = std::env::temp_dir().join(format!("openblog-voice-init-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    // Piped stdin that stays open and never answers: a prompt would hang here.
    let mut child = command(&["init"])
        .arg(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let held_open = child.stdin.take().unwrap();
    let started = Instant::now();
    let output = child.wait_with_output().unwrap();
    drop(held_open);
    assert!(output.status.success(), "{}", text(&output));
    assert!(started.elapsed() < Duration::from_secs(20));
    let printed = text(&output);
    assert!(printed.contains("created openblog.json"), "{printed}");
    assert!(
        !printed.to_lowercase().contains("voice") && !printed.contains("[y/N]"),
        "{printed}"
    );
    assert!(!dir.join(".openblog/private/voice").exists());
    assert!(!dir.join("assistant/context/voice").exists());
    // --no-voice is accepted and changes nothing for a script.
    let other = std::env::temp_dir().join(format!("openblog-voice-init2-{}", std::process::id()));
    let _ = fs::remove_dir_all(&other);
    let output = command(&["init", "--no-voice"])
        .arg(&other)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", text(&output));
    assert_eq!(text(&output).replace(&other.display().to_string(), "X"), {
        let again =
            std::env::temp_dir().join(format!("openblog-voice-init3-{}", std::process::id()));
        let _ = fs::remove_dir_all(&again);
        let plain = command(&["init"])
            .arg(&again)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let printed = text(&plain).replace(&again.display().to_string(), "X");
        let _ = fs::remove_dir_all(&again);
        printed
    });
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&other);
}

#[test]
fn the_help_documents_the_voice_command_and_no_voice() {
    let output = command(&["init", "--help"]).output().unwrap();
    let help = text(&output);
    assert!(help.contains("--no-voice"), "{help}");
    for needle in [
        "voice [prompt-id]",
        "voice --resume",
        "voice polish|diff|promote",
        "--stdin",
        "--portable",
    ] {
        assert!(help.contains(needle), "{needle}");
    }
}

// ---- draw, pick and list (VS2.1.2) -------------------------------------------------------

#[test]
fn list_shows_packs_and_creates_nothing() {
    let dir = site("list");
    let output = run(&dir, &["voice", "--list"], "");
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    assert!(
        printed.contains("Stories (stories): 0 of 5 answered"),
        "{printed}"
    );
    assert!(printed.contains(PROMPT), "{printed}");
    assert!(!printed.contains('\u{1b}'), "plain text, no colour codes");
    assert!(!dir.join(".openblog/private/voice").exists());
    assert!(!dir.join(PORTABLE).exists());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn an_unknown_prompt_id_lists_nearby_ids() {
    let dir = site("unknown");
    let output = run(&dir, &["voice", "a-mistake-i-mad"], "");
    assert!(!output.status.success());
    let printed = text(&output);
    assert!(
        printed.contains("There is no prompt called \"a-mistake-i-mad\""),
        "{printed}"
    );
    assert!(printed.contains(PROMPT), "{printed}");
    assert!(!session_path(&dir).exists());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn drawing_shows_three_cards_and_quitting_starts_nothing() {
    let dir = site("draw");
    let output = run(&dir, &["voice"], "q\n");
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    assert!(
        printed.contains("  1. ") && printed.contains("  2. ") && printed.contains("  3. "),
        "{printed}"
    );
    assert!(printed.contains("words."), "{printed}");
    assert!(printed.contains("Nothing started."), "{printed}");
    assert!(!session_path(&dir).exists());
    // No answer at all (end of input) also starts nothing.
    let output = run(&dir, &["voice"], "");
    assert!(output.status.success(), "{}", text(&output));
    assert!(!session_path(&dir).exists());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn picking_a_card_runs_the_session_and_saves_the_text_as_written() {
    let dir = site("pick");
    let output = run(
        &dir,
        &["voice", "--stdin"],
        "x\n9\n1\nteh first line\n\n  second   line  \n.\n",
    );
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    assert!(
        printed.contains("Please type a number from 1 to 3"),
        "{printed}"
    );
    let files = samples(&dir, PRIVATE);
    assert_eq!(files.len(), 1, "{files:?}");
    assert!(files[0].ends_with("-rough.md"));
    assert_eq!(
        sample_body(&dir.join(PRIVATE).join(&files[0])),
        "teh first line\n\n  second   line  "
    );
    assert!(
        printed.contains("Saved your rough draft: .openblog/private/context/voice/"),
        "{printed}"
    );
    assert!(printed.contains("5 words"), "{printed}");
    assert!(!session_path(&dir).exists(), "the record is closed");
    let _ = fs::remove_dir_all(dir);
}

// ---- capture and lock (VS2.2.1, VS2.2.2) -------------------------------------------------

#[test]
fn a_named_prompt_saves_to_the_portable_folder_on_request() {
    let dir = site("portable");
    let output = run(
        &dir,
        &["voice", PROMPT, "--stdin", "--portable"],
        "so i delted it\nlol\n",
    );
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    assert_eq!(samples(&dir, PORTABLE).len(), 1);
    assert!(samples(&dir, PRIVATE).is_empty());
    assert!(printed.contains("assistant/context/voice/"), "{printed}");
    assert!(printed.contains("5 words (suggested"), "{printed}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn an_empty_draft_saves_nothing_and_says_so() {
    let dir = site("empty");
    let output = run(&dir, &["voice", PROMPT, "--stdin"], "\n   \n.\n");
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    assert!(
        printed.contains("Nothing was written, so nothing was saved."),
        "{printed}"
    );
    assert!(samples(&dir, PRIVATE).is_empty());
    assert!(!session_path(&dir).exists());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn the_editor_gets_a_header_and_marker_and_neither_is_saved() {
    let dir = site("editor");
    let editor = fake_editor(
        &dir,
        "append",
        "grep -q 'write below this line' \"$1\" || exit 3\nprintf 'teh editor text\\n' >> \"$1\"",
        "findstr /C:\"write below this line\" \"%~1\" >nul || exit /b 3\r\necho teh editor text>> \"%~1\"",
    );
    let output = run_with(&dir, &["voice", PROMPT], "", &[("EDITOR", &editor)]);
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    assert!(printed.contains("Time ends at"), "{printed}");
    let files = samples(&dir, PRIVATE);
    assert_eq!(files.len(), 1, "{printed}");
    let path = dir.join(PRIVATE).join(&files[0]);
    assert_eq!(sample_body(&path), "teh editor text");
    let saved = fs::read_to_string(&path).unwrap();
    assert!(!saved.contains("write below this line") && !saved.contains("# A mistake I made"));
    assert!(!dir.join(".openblog/private/voice/editing.md").exists());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_line_typed_after_the_deadline_is_discarded_and_a_silent_stdin_does_not_hold_the_session() {
    let dir = site("deadline");
    // Started 28 seconds ago with a 30 second window: about two seconds are left.
    write_session(&dir, 28, 30, "");
    let mut child = command(&["voice", "--resume", "--stdin"])
        .arg("--root")
        .arg(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"in time\n").unwrap();
    stdin.flush().unwrap();
    // The pipe stays open and silent. The session must end by itself at the deadline.
    let started = Instant::now();
    let output = child.wait_with_output().unwrap();
    drop(stdin);
    assert!(started.elapsed() < Duration::from_secs(15));
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    assert!(printed.contains("Time ran out at"), "{printed}");
    let files = samples(&dir, PRIVATE);
    assert_eq!(files.len(), 1, "{printed}");
    assert_eq!(sample_body(&dir.join(PRIVATE).join(&files[0])), "in time");
    assert!(!session_path(&dir).exists());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn resuming_after_the_deadline_locks_the_saved_text_at_once() {
    let dir = site("expired");
    write_session(&dir, 400, 180, "saved before the lights went out");
    let started = Instant::now();
    // A second session cannot start over the top of it.
    let blocked = run(&dir, &["voice", PROMPT, "--stdin"], "");
    assert!(!blocked.status.success());
    assert!(
        text(&blocked).contains("already open"),
        "{}",
        text(&blocked)
    );
    let output = run(&dir, &["voice", "--resume"], "");
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    assert!(started.elapsed() < Duration::from_secs(15));
    assert!(printed.contains("had run out"), "{printed}");
    let files = samples(&dir, PRIVATE);
    assert_eq!(files.len(), 1, "{printed}");
    assert_eq!(
        sample_body(&dir.join(PRIVATE).join(&files[0])),
        "saved before the lights went out"
    );
    assert!(!session_path(&dir).exists());
    // Nothing is left to resume.
    let again = run(&dir, &["voice", "--resume"], "");
    assert!(
        text(&again).contains("no writing session"),
        "{}",
        text(&again)
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn an_expired_session_with_nothing_saved_is_discarded() {
    let dir = site("discard");
    write_session(&dir, 400, 180, "");
    let output = run(&dir, &["voice", "--resume"], "");
    assert!(output.status.success(), "{}", text(&output));
    assert!(text(&output).contains("discarded"), "{}", text(&output));
    assert!(samples(&dir, PRIVATE).is_empty());
    assert!(!session_path(&dir).exists());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn resuming_with_time_left_keeps_the_text_and_the_deadline() {
    let dir = site("active");
    write_session(&dir, 10, 180, "first part");
    let before = fs::read_to_string(session_path(&dir)).unwrap();
    let output = run(&dir, &["voice", "--resume", "--stdin"], "second part\n.\n");
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    assert!(
        printed.contains("Your text so far:") && printed.contains("first part"),
        "{printed}"
    );
    let files = samples(&dir, PRIVATE);
    assert_eq!(
        sample_body(&dir.join(PRIVATE).join(&files[0])),
        "first part\nsecond part"
    );
    assert!(before.contains("\"timeLimitSeconds\":180"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_session_can_be_given_up_with_confirmation() {
    let dir = site("scrap");
    write_session(&dir, 10, 180, "will be thrown away");
    let refused = run(&dir, &["voice", "--scrap"], "");
    assert!(!refused.status.success() && session_path(&dir).exists());
    let output = run(&dir, &["voice", "--scrap", "--yes"], "");
    assert!(output.status.success(), "{}", text(&output));
    assert!(!session_path(&dir).exists());
    assert!(samples(&dir, PRIVATE).is_empty());
    let _ = fs::remove_dir_all(dir);
}

// ---- polish, diff, promote (VS2.3.1, VS2.3.2) --------------------------------------------

fn hash(path: &Path) -> Vec<u8> {
    fs::read(path).unwrap()
}

fn write_rough_sample(dir: &Path) -> String {
    let output = run(
        dir,
        &["voice", PROMPT, "--stdin"],
        "so i delted the foldr\nand panicked\n.\n",
    );
    assert!(output.status.success(), "{}", text(&output));
    samples(dir, PRIVATE).remove(0)
}

#[test]
fn polish_edits_a_copy_and_the_rough_file_never_changes() {
    let dir = site("polish");
    let rough = write_rough_sample(&dir);
    let rough_path = dir.join(PRIVATE).join(&rough);
    let before = hash(&rough_path);

    // The copy opens with the rough text in it.
    let check = fake_editor(
        &dir,
        "check",
        "grep -q 'so i delted' \"$1\" || exit 3\nprintf 'I deleted the wrong folder.\\nThen I panicked.\\n' > \"$1\"",
        "findstr /C:\"so i delted\" \"%~1\" >nul || exit /b 3\r\n(echo I deleted the wrong folder.& echo Then I panicked.) > \"%~1\"",
    );
    let output = run_with(
        &dir,
        &[
            "voice",
            "polish",
            &rough,
            "--title",
            "The day I deleted a folder",
            "--slug",
            "deleted-folder",
        ],
        "",
        &[("VISUAL", &check)],
    );
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    assert_eq!(
        hash(&rough_path),
        before,
        "the rough file is byte-identical"
    );
    let polished = rough.replace("-rough.md", "-polished.md");
    let polished_path = dir.join(PRIVATE).join(&polished);
    assert_eq!(
        sample_body(&polished_path),
        "I deleted the wrong folder.\nThen I panicked."
    );
    let saved = fs::read_to_string(&polished_path).unwrap();
    assert!(
        saved.contains(&format!("voice.roughOf: {rough}")),
        "{saved}"
    );
    assert!(
        saved.contains("title: The day I deleted a folder"),
        "{saved}"
    );
    let leftovers: Vec<_> = fs::read_dir(dir.join(".openblog/private/voice"))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("polishing"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");

    // A second polish edits the existing polished draft, and says what it opened.
    let second = fake_editor(
        &dir,
        "second",
        "grep -q 'wrong folder' \"$1\" || exit 3\nprintf 'I deleted the wrong folder.\\nThen I panicked, briefly.\\n' > \"$1\"",
        "findstr /C:\"wrong folder\" \"%~1\" >nul || exit /b 3\r\n(echo I deleted the wrong folder.& echo Then I panicked, briefly.) > \"%~1\"",
    );
    let output = run_with(
        &dir,
        &["voice", "polish", PROMPT],
        "",
        &[("EDITOR", &second)],
    );
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    assert!(printed.contains("your polished draft"), "{printed}");
    assert_eq!(
        sample_body(&polished_path),
        "I deleted the wrong folder.\nThen I panicked, briefly."
    );
    assert!(fs::read_to_string(&polished_path)
        .unwrap()
        .contains("title: The day I deleted a folder"));
    assert_eq!(hash(&rough_path), before);

    // Naming the polished file polishes the same pair; it never opens the rough file for edits.
    let diff = run(&dir, &["voice", "diff", &polished], "");
    let diffed = text(&diff);
    assert!(diff.status.success(), "{diffed}");
    assert!(
        diffed.contains("-so i delted the foldr")
            && diffed.contains("+I deleted the wrong folder."),
        "{diffed}"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn polish_without_an_editor_or_changes_saves_nothing() {
    let dir = site("polish-none");
    let rough = write_rough_sample(&dir);
    let output = run(&dir, &["voice", "polish", &rough], "");
    assert!(!output.status.success());
    assert!(
        text(&output).contains("$VISUAL or $EDITOR"),
        "{}",
        text(&output)
    );
    let untouched = fake_editor(&dir, "untouched", "exit 0", "exit /b 0");
    let output = run_with(
        &dir,
        &["voice", "polish", &rough],
        "",
        &[("EDITOR", &untouched)],
    );
    assert!(output.status.success(), "{}", text(&output));
    assert!(text(&output).contains("No changes"), "{}", text(&output));
    assert_eq!(samples(&dir, PRIVATE).len(), 1, "no polished file was made");
    let diff = run(&dir, &["voice", "diff", &rough], "");
    assert!(!diff.status.success() && text(&diff).contains("no polished draft yet"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn promote_makes_a_post_draft_the_site_accepts_and_leaves_the_samples_alone() {
    let dir = site("promote");
    let rough = write_rough_sample(&dir);
    // A rough draft alone cannot be promoted, by name or by prompt.
    let output = run(&dir, &["voice", "promote", &rough], "");
    assert!(!output.status.success());
    assert!(
        text(&output).contains("no polished draft"),
        "{}",
        text(&output)
    );
    assert!(!dir
        .join("content/posts")
        .read_dir()
        .unwrap()
        .any(|e| { e.unwrap().file_name().to_string_lossy().contains(PROMPT) }));

    let editor = fake_editor(
        &dir,
        "polish",
        "printf 'I deleted the wrong folder.\\n' > \"$1\"",
        "echo I deleted the wrong folder.> \"%~1\"",
    );
    let output = run_with(
        &dir,
        &[
            "voice",
            "polish",
            &rough,
            "--slug",
            "deleted-folder",
            "--title",
            "The day I deleted a folder",
        ],
        "",
        &[("EDITOR", &editor)],
    );
    assert!(output.status.success(), "{}", text(&output));
    let before: Vec<(String, Vec<u8>)> = samples(&dir, PRIVATE)
        .into_iter()
        .map(|name| (name.clone(), hash(&dir.join(PRIVATE).join(name))))
        .collect();

    let output = run(&dir, &["voice", "promote", PROMPT], "");
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    let posts: Vec<String> = fs::read_dir(dir.join("content/posts"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with("-deleted-folder.md"))
        .collect();
    assert_eq!(posts.len(), 1, "{printed}");
    assert!(printed.contains("content/posts/"), "{printed}");
    let post = fs::read_to_string(dir.join("content/posts").join(&posts[0])).unwrap();
    assert!(
        post.contains("I deleted the wrong folder.") && !post.contains("voice"),
        "{post}"
    );
    let after: Vec<(String, Vec<u8>)> = samples(&dir, PRIVATE)
        .into_iter()
        .map(|name| (name.clone(), hash(&dir.join(PRIVATE).join(name))))
        .collect();
    assert_eq!(before, after, "the sample files are untouched");

    // The existing post parser and a drafts build accept it; a normal build leaves it out.
    let check = command(&["check", "--drafts"])
        .arg("--root")
        .arg(&dir)
        .output()
        .unwrap();
    assert!(check.status.success(), "{}", text(&check));

    // The slug is now taken.
    let again = run(&dir, &["voice", "promote", PROMPT], "");
    assert!(!again.status.success());
    assert!(text(&again).contains("deleted-folder"), "{}", text(&again));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn erase_lists_then_removes_everything_only_with_yes_and_checks_nothing_is_left() {
    let dir = site("erase");
    let none = run(&dir, &["voice", "erase", "--yes"], "");
    assert!(none.status.success(), "{}", text(&none));
    assert!(text(&none).contains("no voice data"), "{}", text(&none));

    write_rough_sample(&dir);
    let portable = run(
        &dir,
        &["voice", "your-town", "--stdin", "--portable"],
        "x\n",
    );
    assert!(portable.status.success(), "{}", text(&portable));
    assert_eq!(samples(&dir, PORTABLE).len(), 1);
    fs::create_dir_all(dir.join("assistant/context")).unwrap();
    fs::write(dir.join("assistant/context/voice.md"), "guide").unwrap();
    fs::write(dir.join(".openblog/private/voice/editing-9-9.md"), "ed").unwrap();
    write_session(&dir, 10, 180, "unsaved");
    fs::write(dir.join("assistant/context/author.md"), "keep").unwrap();

    let refused = run(&dir, &["voice", "erase"], "");
    let printed = text(&refused);
    assert!(!refused.status.success(), "{printed}");
    assert!(printed.contains("voice.md") && printed.contains("session.json"));
    assert!(printed.contains("--yes"), "{printed}");
    assert!(!samples(&dir, PRIVATE).is_empty() && session_path(&dir).exists());

    let output = run(&dir, &["voice", "erase", "--yes"], "");
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    assert!(printed.contains("nothing is left"), "{printed}");
    assert!(samples(&dir, PRIVATE).is_empty() && samples(&dir, PORTABLE).is_empty());
    assert!(!session_path(&dir).exists());
    assert!(!dir.join("assistant/context/voice.md").exists());
    assert!(!dir.join(".openblog/private/voice/editing-9-9.md").exists());
    assert_eq!(
        fs::read_to_string(dir.join("assistant/context/author.md")).unwrap(),
        "keep"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn list_names_rough_only_prompts_and_one_sample_traits_from_the_guide() {
    let dir = site("list-gaps");
    // No guide and no sample: the list is as it was, with no gap sections.
    let plain = text(&run(&dir, &["voice", "--list"], ""));
    assert!(!plain.contains("Rough only"), "{plain}");
    assert!(!plain.contains("rest on one sample"), "{plain}");

    write_rough_sample(&dir);
    fs::create_dir_all(dir.join("assistant/context")).unwrap();
    fs::write(
        dir.join("assistant/context/voice.md"),
        "# Voice guide\n\n## Word choice\n\n- Says delted: \"delted\" (a-rough.md) (one sample)\n- Short: \"panicked\" (a-rough.md)\n",
    )
    .unwrap();
    let before = fs::read(dir.join("assistant/context/voice.md")).unwrap();
    let output = run(&dir, &["voice", "--list"], "");
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    assert!(
        printed.contains(&format!("Rough only, no polished draft yet: {PROMPT}.")),
        "{printed}"
    );
    assert!(
        printed
            .contains("Voice guide traits that rest on one sample:\n  Says delted (Word choice)"),
        "{printed}"
    );
    assert!(!printed.contains("Short ("), "{printed}");
    assert!(printed.contains("Packs with no sample yet"), "{printed}");
    assert_eq!(
        fs::read(dir.join("assistant/context/voice.md")).unwrap(),
        before,
        "listing never writes"
    );
    let _ = fs::remove_dir_all(dir);
}

// ---- losing nothing (pre-release audit) ----------------------------------------------------

#[test]
fn piping_text_without_naming_a_prompt_fails_and_starts_nothing() {
    let dir = site("piped");
    let output = run(&dir, &["voice", "--stdin"], "my answer here\n.\n");
    let printed = text(&output);
    assert!(!output.status.success(), "{printed}");
    assert!(
        printed.contains("openblog voice <prompt-id> --stdin"),
        "{printed}"
    );
    assert!(!session_path(&dir).exists());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn an_editor_that_returns_at_once_locks_nothing_and_keeps_the_session() {
    let dir = site("nowait");
    write_session(&dir, 10, 180, "half of my answer");
    // Like `code` without --wait: hands the file to another window and exits at once.
    let editor = fake_editor(&dir, "nowait", "exit 0", "exit /b 0");
    let output = run_with(&dir, &["voice", "--resume"], "", &[("EDITOR", &editor)]);
    let printed = text(&output);
    assert!(!output.status.success(), "{printed}");
    assert!(printed.contains("--wait"), "{printed}");
    assert!(samples(&dir, PRIVATE).is_empty(), "nothing was locked");
    let record = fs::read_to_string(session_path(&dir)).unwrap();
    assert!(record.contains("half of my answer"), "{record}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn an_editor_file_that_vanishes_keeps_the_text_already_saved() {
    let dir = site("vanish");
    write_session(&dir, 10, 180, "words saved before the file went away");
    let editor = fake_editor(&dir, "vanish", "rm -f \"$1\"", "del /q \"%~1\"");
    let output = run_with(&dir, &["voice", "--resume"], "", &[("EDITOR", &editor)]);
    let printed = text(&output);
    assert!(output.status.success(), "{printed}");
    let files = samples(&dir, PRIVATE);
    assert_eq!(files.len(), 1, "{printed}");
    assert_eq!(
        sample_body(&dir.join(PRIVATE).join(&files[0])),
        "words saved before the file went away"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_second_window_cannot_drive_a_session_another_window_is_writing() {
    let dir = site("second");
    write_session(&dir, 10, 180, "the first window's words");
    // The first window's editor file, owned by a process that is running (this test).
    let editing = dir.join(format!(
        ".openblog/private/voice/editing-{}-1.md",
        std::process::id()
    ));
    fs::write(&editing, "the first window's words\n").unwrap();
    let output = run(
        &dir,
        &["voice", "--resume", "--stdin"],
        "second window\n.\n",
    );
    let printed = text(&output);
    assert!(!output.status.success(), "{printed}");
    assert!(
        printed.contains("Another `openblog voice` window"),
        "{printed}"
    );
    assert!(editing.exists(), "the first window's file is left alone");
    assert!(samples(&dir, PRIVATE).is_empty());
    let record = fs::read_to_string(session_path(&dir)).unwrap();
    assert!(record.contains("the first window's words"), "{record}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn the_guide_moves_between_the_folders_only_with_yes_and_never_to_portable_when_it_quotes_private_samples(
) {
    let dir = site("guide-move");
    let portable = dir.join("assistant/context/voice.md");
    let private = dir.join(".openblog/private/context/voice.md");
    let guide = "# Voice guide\n<!-- openblog:voice-provenance sources=portable -->\n\n- Mine\n";
    fs::create_dir_all(portable.parent().unwrap()).unwrap();
    fs::write(&portable, guide).unwrap();

    // A preview by default: it says what would move and moves nothing.
    let preview = run(&dir, &["voice", "guide", "--move", "private"], "");
    assert!(!preview.status.success());
    let said = text(&preview);
    assert!(
        said.contains("from assistant/context/voice.md to .openblog/private/context/voice.md"),
        "{said}"
    );
    assert!(said.contains("Nothing was moved"), "{said}");
    assert!(portable.exists() && !private.exists());

    let moved = run(&dir, &["voice", "guide", "--move", "private", "--yes"], "");
    assert!(moved.status.success(), "{}", text(&moved));
    assert!(!portable.exists());
    assert_eq!(fs::read_to_string(&private).unwrap(), guide);

    let back = run(&dir, &["voice", "guide", "--move", "portable", "--yes"], "");
    assert!(back.status.success(), "{}", text(&back));
    assert_eq!(fs::read_to_string(&portable).unwrap(), guide);
    assert!(!private.exists());

    // A guide whose provenance names a private sample stays private.
    fs::remove_file(&portable).unwrap();
    fs::create_dir_all(private.parent().unwrap()).unwrap();
    let quoting = "# Voice guide\n<!-- openblog:voice-provenance sources=private -->\n";
    fs::write(&private, quoting).unwrap();
    let refused = run(&dir, &["voice", "guide", "--move", "portable", "--yes"], "");
    assert!(!refused.status.success());
    assert!(
        text(&refused).contains("quotes private samples"),
        "{}",
        text(&refused)
    );
    assert_eq!(fs::read_to_string(&private).unwrap(), quoting);
    assert!(!portable.exists());

    let usage = run(&dir, &["voice", "guide"], "");
    assert!(!usage.status.success());
    assert!(text(&usage).contains("--move portable|private"));
    let _ = fs::remove_dir_all(&dir);
}
