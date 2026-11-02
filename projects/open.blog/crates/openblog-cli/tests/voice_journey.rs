//! The whole voice chain through the real command line (epic #410, task #468): init, draw, a
//! timed write, the lock, polish, promote, export, import into a fresh project, erase and the
//! post-check, plus the security rules that matter most: nothing private reaches a build or a
//! default export, hostile names and files are refused without echoing sample text, and a rough
//! draft is never replaced. No network and no provider are involved.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const PRIVATE: &str = ".openblog/private/context/voice";
const PORTABLE: &str = "assistant/context/voice";
const MARK: &str = "ZEBRAQUILL-4417";

fn command(args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_openblog"));
    command
        .args(args)
        .env_remove("VISUAL")
        .env_remove("EDITOR")
        .env_remove("OPENBLOG_WORKSPACE");
    command
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

fn run(dir: &Path, args: &[&str], stdin: &str) -> Output {
    run_with(dir, args, stdin, &[])
}

fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn ok(output: &Output) -> String {
    let printed = text(output);
    assert!(output.status.success(), "{printed}");
    printed
}

fn unique(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "openblog-voice-journey-{tag}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn site(tag: &str) -> PathBuf {
    let dir = unique(tag);
    let output = command(&["init"])
        .arg(&dir)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    ok(&output);
    dir
}

fn files(dir: &Path, folder: &str) -> Vec<String> {
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

/// Every file under `dir` (relative path, bytes).
fn snapshot(dir: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                let name = path
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((name, fs::read(&path).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

fn with_marker(dir: &Path) -> Vec<String> {
    snapshot(dir)
        .into_iter()
        .filter(|(_, bytes)| String::from_utf8_lossy(bytes).contains(MARK))
        .map(|(name, _)| name)
        .collect()
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

fn cleanup(dirs: &[&Path]) {
    for dir in dirs {
        let _ = fs::remove_dir_all(dir);
    }
}

#[test]
fn the_whole_journey_from_a_first_session_to_an_erased_library() {
    let one = site("one");
    let two = site("two");
    let scratch = unique("out");
    fs::create_dir_all(&scratch).unwrap();

    // Nothing exists until the author asks: listing makes no folder and no session.
    ok(&run(&one, &["voice", "--list"], ""));
    assert!(!one.join(PRIVATE).exists() && !one.join(".openblog/private/voice").exists());

    // A timed write (stdin stands in for the editor) saves the text as written, privately.
    let rough_text = format!("so i delted the foldr {MARK}\n\n  and panicked  ");
    let written = ok(&run(
        &one,
        &["voice", "a-mistake-i-made", "--stdin", "--seconds", "120"],
        &format!("{rough_text}\n.\n"),
    ));
    assert!(written.contains("Saved your rough draft"), "{written}");
    let rough = files(&one, PRIVATE).remove(0);
    assert!(rough.ends_with("-rough.md"), "{rough}");
    assert!(files(&one, PORTABLE).is_empty());
    assert!(
        !one.join(".openblog/private/voice/session.json").exists(),
        "the session is closed once locked"
    );
    // A second, portable sample on request.
    ok(&run(
        &one,
        &["voice", "your-town", "--stdin", "--portable"],
        "a small town by a river\n.\n",
    ));
    assert_eq!(files(&one, PORTABLE).len(), 1);

    // Polish edits a copy; the rough draft stays byte for byte.
    let rough_path = one.join(PRIVATE).join(&rough);
    let rough_bytes = fs::read(&rough_path).unwrap();
    let editor = fake_editor(
        &one,
        "polish",
        "printf 'I deleted the wrong folder, then I panicked.\\n' > \"$1\"",
        "echo I deleted the wrong folder, then I panicked.> \"%~1\"",
    );
    ok(&run_with(
        &one,
        &[
            "voice",
            "polish",
            &rough,
            "--title",
            "The folder I deleted",
            "--slug",
            "folder-deleted",
        ],
        "",
        &[("VISUAL", &editor)],
    ));
    assert_eq!(fs::read(&rough_path).unwrap(), rough_bytes);

    // Promote makes a post draft and leaves both samples alone.
    ok(&run(&one, &["voice", "promote", "a-mistake-i-made"], ""));
    let posts: Vec<String> = files(&one, "content/posts")
        .into_iter()
        .filter(|n| n.ends_with("-folder-deleted.md"))
        .collect();
    assert_eq!(posts.len(), 1);
    assert_eq!(fs::read(&rough_path).unwrap(), rough_bytes);
    ok(&run(&one, &["check", "--drafts"], ""));

    // A dry run prints the file and writes nothing; the default export holds no private text.
    let before = snapshot(&one);
    let dry = ok(&run(&one, &["voice", "export", "--include-private"], ""));
    assert!(dry.contains(MARK), "a dry run prints the file");
    assert_eq!(snapshot(&one), before);
    let public = scratch.join("public.json");
    ok(&run(
        &one,
        &[
            "voice",
            "export",
            "--out",
            public.to_str().unwrap(),
            "--write",
        ],
        "",
    ));
    let public_text = fs::read_to_string(&public).unwrap();
    assert!(!public_text.contains(MARK) && public_text.contains("a small town"));
    let full = scratch.join("full.json");
    let export_full = |project: &Path, out: &Path| {
        ok(&run(
            project,
            &[
                "voice",
                "export",
                "--include-private",
                "--out",
                out.to_str().unwrap(),
                "--write",
            ],
            "",
        ))
    };
    export_full(&one, &full);

    // Import into a fresh project: previewed first, then all of it, folder for folder.
    let full_arg = full.to_str().unwrap();
    let preview = ok(&run(&two, &["voice", "import", full_arg], ""));
    assert!(preview.contains("Dry run"), "{preview}");
    assert!(files(&two, PRIVATE).is_empty() && files(&two, PORTABLE).is_empty());
    ok(&run(&two, &["voice", "import", full_arg, "--write"], ""));
    for folder in [PRIVATE, PORTABLE] {
        assert_eq!(files(&one, folder), files(&two, folder), "{folder}");
        for name in files(&one, folder) {
            assert_eq!(
                fs::read(one.join(folder).join(&name)).unwrap(),
                fs::read(two.join(folder).join(&name)).unwrap(),
                "{folder}/{name} is byte-identical"
            );
        }
    }
    // A second import changes nothing; a re-export is the same file.
    let after_import = snapshot(&two);
    ok(&run(&two, &["voice", "import", full_arg, "--write"], ""));
    assert_eq!(snapshot(&two), after_import);
    let full_two = scratch.join("full-two.json");
    export_full(&two, &full_two);
    assert_eq!(fs::read(&full).unwrap(), fs::read(&full_two).unwrap());

    // A build of the fresh project publishes none of it.
    ok(&run(&two, &["build"], ""));
    assert!(
        with_marker(&two.join("dist")).is_empty(),
        "{:?}",
        with_marker(&two.join("dist"))
    );
    assert!(!snapshot(&two.join("dist"))
        .iter()
        .any(|(name, _)| name.contains("voice") || name.contains("zebra")));

    // Erase lists first, needs --yes, and checks afterwards. Other context survives.
    fs::write(two.join("assistant/context/author.md"), "keep").unwrap();
    let refused = run(&two, &["voice", "erase"], "");
    assert!(!refused.status.success());
    assert!(!files(&two, PRIVATE).is_empty());
    let erased = ok(&run(&two, &["voice", "erase", "--yes"], ""));
    assert!(erased.contains("nothing is left"), "{erased}");
    assert!(files(&two, PRIVATE).is_empty() && files(&two, PORTABLE).is_empty());
    assert_eq!(
        fs::read_to_string(two.join("assistant/context/author.md")).unwrap(),
        "keep"
    );
    // The post-check: no marker survives anywhere in the erased project, build output included.
    let left = with_marker(&two);
    assert!(left.is_empty(), "{left:?}");
    let empty = ok(&run(&two, &["voice", "erase", "--yes"], ""));
    assert!(empty.contains("no voice data"), "{empty}");

    cleanup(&[&one, &two, &scratch]);
}

#[test]
fn hostile_names_are_refused_everywhere_and_nothing_outside_the_library_changes() {
    let dir = site("names");
    let outside = dir.join("openblog.json");
    let config = fs::read(&outside).unwrap();
    ok(&run(
        &dir,
        &["voice", "a-mistake-i-made", "--stdin"],
        &format!("{MARK}\n.\n"),
    ));
    let editor = fake_editor(&dir, "clobber", "printf 'x' > \"$1\"", "echo x> \"%~1\"");
    let before = snapshot(&dir);
    let names = [
        "../../openblog.json",
        "..\\..\\openblog.json",
        "../private/context/voice/x-rough.md",
        "/etc/passwd",
        "C:\\Windows\\win.ini",
        "assistant/context/voice/../../../openblog.json",
        "2026-10-29-a-mistake-i-made-rough.md/../../../../openblog.json",
        "%2e%2e%2fopenblog.json",
        "",
    ];
    for name in names {
        for verb in ["polish", "diff", "promote"] {
            let output = run_with(&dir, &["voice", verb, name], "", &[("VISUAL", &editor)]);
            let printed = text(&output);
            assert!(!output.status.success(), "{verb} {name:?}: {printed}");
            assert!(!printed.contains(MARK), "{verb} {name:?}: {printed}");
        }
    }
    assert_eq!(fs::read(&outside).unwrap(), config);
    assert_eq!(
        snapshot(&dir),
        before,
        "nothing was created, moved or changed"
    );
    let unknown = run(
        &dir,
        &["voice", "../../x", "--stdin"],
        &format!("{MARK}\n.\n"),
    );
    assert!(!unknown.status.success());
    assert!(!text(&unknown).contains(MARK));
    assert_eq!(snapshot(&dir), before);
    cleanup(&[&dir]);
}

fn export_with(items: &str) -> String {
    format!("{{\"format\":\"openblog-voice-export\",\"version\":1,\"samples\":[{items}]}}")
}

fn sample_file(prompt: &str, stage: &str, body: &str) -> String {
    format!(
        "---\ntitle: T\nslug: s\ndate: 2026-10-29T01:00:00Z\nvoice.format: 1\nvoice.catalog: 1\nvoice.pack: stories\nvoice.prompt: {prompt}\nvoice.stage: {stage}\nvoice.timeLimitSeconds: 180\nvoice.words: 3\n---\n\n{body}\n"
    )
}

fn entry(visibility: &str, file: &str, content: &str) -> String {
    serde_json::json!({ "visibility": visibility, "file": file, "content": content }).to_string()
}

#[test]
fn hostile_import_files_are_refused_whole_without_echoing_their_text() {
    let dir = site("hostile");
    ok(&run(
        &dir,
        &["voice", "a-mistake-i-made", "--stdin"],
        "my own words here\n.\n",
    ));
    let rough = files(&dir, PRIVATE).remove(0);
    let before = snapshot(&dir);
    let good = entry(
        "portable",
        "2026-10-29-your-town-rough.md",
        &sample_file("your-town", "rough", &format!("fine {MARK}")),
    );
    let cases: Vec<(&str, String)> = vec![
        (
            "path traversal in a file name",
            export_with(&format!(
                "{good},{}",
                entry(
                    "portable",
                    "../../openblog-rough.md",
                    &sample_file("a", "rough", MARK)
                )
            )),
        ),
        (
            "a separator in a file name",
            export_with(&format!(
                "{good},{}",
                entry(
                    "private",
                    "sub/dir-rough.md",
                    &sample_file("a", "rough", MARK)
                )
            )),
        ),
        (
            "an unknown folder",
            export_with(&format!(
                "{good},{}",
                entry(
                    "public",
                    "2026-10-29-x-rough.md",
                    &sample_file("x", "rough", MARK)
                )
            )),
        ),
        (
            "a rough draft that would replace a different one",
            export_with(&entry(
                "private",
                &rough,
                &sample_file("a-mistake-i-made", "rough", &format!("REPLACED {MARK}")),
            )),
        ),
        (
            "a newer export format",
            format!("{{\"format\":\"openblog-voice-export\",\"version\":99,\"samples\":[{good}]}}"),
        ),
        ("not json", format!("this is not json {MARK}")),
        (
            "the wrong format",
            format!("{{\"format\":\"other\",\"note\":\"{MARK}\"}}"),
        ),
        (
            "a file that is not a sample",
            export_with(&entry(
                "portable",
                "2026-10-29-junk-rough.md",
                &format!("plain text {MARK}"),
            )),
        ),
    ];
    let file = unique("hostile").with_extension("json");
    for (label, body) in cases {
        fs::write(&file, body).unwrap();
        let output = run(
            &dir,
            &[
                "voice",
                "import",
                file.to_str().unwrap(),
                "--write",
                "--overwrite",
            ],
            "",
        );
        let printed = text(&output);
        assert!(!output.status.success(), "{label}: {printed}");
        assert!(
            !printed.contains(MARK),
            "{label} echoed sample text: {printed}"
        );
        assert_eq!(snapshot(&dir), before, "{label}: all or nothing");
    }
    // A missing file and an oversized one are refusals too.
    let missing = run(
        &dir,
        &["voice", "import", "does-not-exist.json", "--write"],
        "",
    );
    assert!(!missing.status.success());
    fs::write(
        &file,
        format!("{{\"pad\":\"{}\"}}", "x".repeat(40 * 1024 * 1024)),
    )
    .unwrap();
    let huge = run(
        &dir,
        &["voice", "import", file.to_str().unwrap(), "--write"],
        "",
    );
    assert!(!huge.status.success());
    assert_eq!(snapshot(&dir), before);
    let _ = fs::remove_file(&file);
    cleanup(&[&dir]);
}

#[test]
fn an_import_never_replaces_a_rough_draft_and_never_makes_private_text_portable() {
    let dir = site("tighten");
    ok(&run(
        &dir,
        &["voice", "a-mistake-i-made", "--stdin"],
        "my own words here\n.\n",
    ));
    let rough = files(&dir, PRIVATE).remove(0);
    let original = fs::read(dir.join(PRIVATE).join(&rough)).unwrap();
    let file = unique("tighten").with_extension("json");
    fs::write(
        &file,
        export_with(&format!(
            "{},{}",
            entry(
                "private",
                &rough,
                &sample_file("a-mistake-i-made", "rough", &format!("DIFFERENT {MARK}"))
            ),
            entry(
                "portable",
                "2026-10-29-your-town-rough.md",
                &sample_file("your-town", "rough", "from elsewhere")
            )
        )),
    )
    .unwrap();
    // Even with --overwrite a rough draft is not replaced, and --as private keeps the rest private.
    let output = run(
        &dir,
        &[
            "voice",
            "import",
            file.to_str().unwrap(),
            "--write",
            "--overwrite",
            "--as",
            "private",
        ],
        "",
    );
    let printed = text(&output);
    let _ = fs::remove_file(&file);
    assert!(!printed.contains(MARK), "{printed}");
    assert_eq!(fs::read(dir.join(PRIVATE).join(&rough)).unwrap(), original);
    assert!(
        files(&dir, PORTABLE).is_empty(),
        "nothing became portable: {printed}"
    );
    cleanup(&[&dir]);
}

#[test]
fn errors_and_help_never_carry_sample_text() {
    let dir = site("quiet");
    ok(&run(
        &dir,
        &["voice", "a-mistake-i-made", "--stdin"],
        &format!("{MARK}\n.\n"),
    ));
    let rough = files(&dir, PRIVATE).remove(0);
    let outputs = vec![
        run(&dir, &["voice", "diff", &rough], ""),
        run(&dir, &["voice", "promote", &rough], ""),
        run(&dir, &["voice", "polish", &rough], ""),
        run(
            &dir,
            &["voice", "polish", "2020-01-01-nothing-rough.md"],
            "",
        ),
        run(&dir, &["voice", "erase"], ""),
        run(&dir, &["voice", "export", "--write"], ""),
        run(&dir, &["voice", "--list"], ""),
        run(&dir, &["voice", "--resume"], ""),
        run(&dir, &["voice", "a-mistake-i-made", "--stdin"], ""),
    ];
    for output in &outputs {
        let printed = text(output);
        assert!(!printed.contains(MARK), "{printed}");
    }
    assert!(!text(&run(&dir, &["build"], "")).contains(MARK));
    assert!(!text(&run(&dir, &["check"], "")).contains(MARK));
    cleanup(&[&dir]);
}
