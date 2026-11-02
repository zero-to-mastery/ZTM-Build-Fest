//! Claude transcripts — where a session's transcript lives and what to title it.
//!
//! Claude appends one JSON object per line to `<sessionId>.jsonl` under its
//! projects directory. orb reads only the lines added since its last look, so
//! each line is parsed once, and titles an agent by the latest title the user
//! gave with `/rename`, else Claude's latest generated title, else the first
//! real prompt, counting the text typed after a slash command. The same pass
//! notes the git branch the latest prompt ran on.
//!
//! For the session picker's preview it also reads a transcript's tail into
//! its last few exchanges: a prompt, the tools Claude ran, and Claude's last
//! text.
//!
//! For transcript search it also reads the prompts and Claude's text replies,
//! each with where it sits in the file and which prompt it answers.

use std::{
    fs, io,
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde_json::Value;

use crate::feat::harness::Scan;
use crate::feat::sessions::transcript::{Exchange, Message, MessageRead, Role, read_new_lines};

/// Where Claude writes the transcript of `session_id` started in `cwd`.
///
/// Claude names the project directory after the cwd with every character
/// that isn't an ASCII letter or digit replaced by `-`.
pub fn transcript_path(claude_dir: &Path, cwd: &Path, session_id: &str) -> PathBuf {
    let escaped: String = cwd
        .to_string_lossy()
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() => char::from(byte),
            _ => '-',
        })
        .collect();
    claude_dir
        .join("projects")
        .join(escaped)
        .join(format!("{session_id}.jsonl"))
}

/// Finds the transcript of `session_id`, or `None` if Claude hasn't written one
/// yet (a session has none until its first prompt).
///
/// Looks at the expected path first, then in every project directory.
pub fn locate(claude_dir: &Path, cwd: &Path, session_id: &str) -> Option<PathBuf> {
    let expected = transcript_path(claude_dir, cwd, session_id);
    if expected.is_file() {
        return Some(expected);
    }
    let file_name = format!("{session_id}.jsonl");
    fs::read_dir(claude_dir.join("projects"))
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(&file_name))
        .find(|path| path.is_file())
}

/// Reads the complete lines added to the transcript since `offset` and
/// updates `title`, `custom_title`, and `branch` from them, noting whether
/// Claude generated a title.
///
/// # Errors
///
/// Returns an error if the transcript can't be opened or read.
pub fn scan_title(
    path: &Path,
    offset: u64,
    title: Option<String>,
    custom_title: Option<String>,
    branch: Option<String>,
) -> io::Result<Scan> {
    let new = read_new_lines(path, offset)?;
    let scan = Scan {
        title,
        custom_title,
        branch,
        ai_titled: false,
        offset: new.offset,
    };
    Ok(new.text.lines().fold(scan, next_title))
}

/// The titles and branch after one transcript line.
fn next_title(scan: Scan, line: &str) -> Scan {
    if !line.contains(r#""type":"user""#)
        && !line.contains(r#""type":"ai-title""#)
        && !line.contains(r#""type":"custom-title""#)
    {
        return scan;
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return scan;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("ai-title") => match text_field(&value, "aiTitle") {
            Some(title) => Scan {
                title: Some(title),
                ai_titled: true,
                ..scan
            },
            None => scan,
        },
        Some("custom-title") => Scan {
            custom_title: text_field(&value, "customTitle").or(scan.custom_title),
            ..scan
        },
        Some("user") => Scan {
            title: scan.title.or_else(|| prompt(&value)),
            branch: text_field(&value, "gitBranch").or(scan.branch),
            ..scan
        },
        _ => scan,
    }
}

/// A line's string field, trimmed, or `None` if it's missing or blank.
fn text_field(line: &Value, key: &str) -> Option<String> {
    line.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The first line of a prompt the user typed, or of the text typed after a
/// slash command, or `None` for anything else Claude records as a user line.
fn prompt(line: &Value) -> Option<String> {
    match prompt_text(line) {
        Some(text) => text.lines().next().map(|first| first.trim().to_owned()),
        None => command_args(line)?
            .lines()
            .map(str::trim)
            .find(|first| !first.is_empty())
            .map(str::to_owned),
    }
}

/// The text typed after a slash command, trimmed, or `None` for a command
/// typed bare and anything that isn't a command.
fn command_args(line: &Value) -> Option<&str> {
    let text = user_text(line)?;
    if !text.starts_with("<command-message>") && !text.starts_with("<command-name>") {
        return None;
    }
    let (_, rest) = text.split_once("<command-args>")?;
    let (args, _) = rest.split_once("</command-args>")?;
    Some(args.trim()).filter(|args| !args.is_empty())
}

/// The whole prompt the user typed, trimmed, or `None` for anything else
/// Claude records as a user line (skill bodies, commands, tool results,
/// interruptions).
fn prompt_text(line: &Value) -> Option<&str> {
    let text = user_text(line)?;
    match text {
        "" => None,
        _ if text.starts_with('<') || text.starts_with("[Request interrupted") => None,
        _ => Some(text),
    }
}

/// The text of a user line Claude didn't add itself, trimmed: the string
/// content or the first text block.
fn user_text(line: &Value) -> Option<&str> {
    if line.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let text = match line.pointer("/message/content")? {
        Value::String(text) => text,
        Value::Array(blocks) => blocks
            .iter()
            .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))?
            .get("text")?
            .as_str()?,
        _ => return None,
    };
    Some(text.trim())
}

/// How much of a transcript's end the preview reads.
const PREVIEW_TAIL: u64 = 512 * 1024;

/// How many exchanges the preview keeps: two briefs and the newest.
const PREVIEW_EXCHANGES: usize = 3;

/// The transcript's length and its last exchanges, read from its last
/// 512 KB. A tail that starts mid-file drops its first line, which may be
/// cut.
///
/// # Errors
///
/// Returns an error if the transcript can't be opened or read.
pub fn read_exchanges(path: &Path) -> io::Result<(u64, Vec<Exchange>)> {
    let len = fs::metadata(path)?.len();
    let start = len.saturating_sub(PREVIEW_TAIL);
    let text = read_new_lines(path, start)?.text;
    let mut exchanges = text
        .lines()
        .skip(usize::from(start > 0))
        .filter(|line| line.contains(r#""type":"user""#) || line.contains(r#""type":"assistant""#))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .fold(Vec::new(), |exchanges, line| {
            next_exchange(exchanges, &line)
        });
    let excess = exchanges.len().saturating_sub(PREVIEW_EXCHANGES);
    exchanges.drain(..excess);
    Ok((len, exchanges))
}

/// The exchanges after one transcript line: a prompt opens one, an assistant
/// line adds its text or tool to the latest. Meta and sidechain lines change
/// nothing.
fn next_exchange(mut exchanges: Vec<Exchange>, line: &Value) -> Vec<Exchange> {
    let flag = |key| line.get(key).and_then(Value::as_bool) == Some(true);
    if flag("isMeta") || flag("isSidechain") {
        return exchanges;
    }
    let time = line
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|text| text.parse::<jiff::Timestamp>().ok())
        .map(SystemTime::from);
    match line.get("type").and_then(Value::as_str) {
        Some("user") => {
            if let Some(text) = prompt_text(line) {
                exchanges.push(Exchange {
                    prompt: Some((text.to_owned(), time)),
                    ..Exchange::default()
                });
            }
        }
        Some("assistant") => {
            if exchanges.is_empty() {
                exchanges.push(Exchange::default());
            }
            let Some(exchange) = exchanges.last_mut() else {
                return exchanges;
            };
            let blocks = line.pointer("/message/content").and_then(Value::as_array);
            for block in blocks.into_iter().flatten() {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = text_field(block, "text") {
                            exchange.reply = Some((text, time));
                        }
                    }
                    Some("tool_use") => {
                        if let Some(name) = block.get("name").and_then(Value::as_str) {
                            match exchange.tools.last_mut() {
                                Some((last, count)) if last == name => *count += 1,
                                _ => exchange.tools.push((name.to_owned(), 1)),
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    exchanges
}

/// Reads the prompts and Claude's text blocks added to the transcript since
/// `offset`, each with where its line sits and which prompt it answers.
///
/// `prompt_offset` is the prompt the previous read ended under. A replaced
/// transcript is read from the start, and its prompt offset starts at 0.
///
/// # Errors
///
/// Returns an error if the transcript can't be opened or read.
pub fn read_messages(path: &Path, offset: u64, prompt_offset: u64) -> io::Result<MessageRead> {
    let new = read_new_lines(path, offset)?;
    let (mut line_offset, mut prompt_offset) = if new.restarted {
        (0, 0)
    } else {
        (offset, prompt_offset)
    };
    let mut messages = Vec::new();
    for line in new.text.split_inclusive('\n') {
        let start = line_offset;
        line_offset += line.len() as u64;
        if !line.contains(r#""type":"user""#) && !line.contains(r#""type":"assistant""#) {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let flag = |key| value.get(key).and_then(Value::as_bool) == Some(true);
        if flag("isMeta") || flag("isSidechain") {
            continue;
        }
        let time = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|text| text.parse::<jiff::Timestamp>().ok())
            .map_or(0, jiff::Timestamp::as_millisecond);
        let message = move |role, text| Message {
            role,
            text,
            offset: start,
            prompt_offset,
            at: time,
        };
        match value.get("type").and_then(Value::as_str) {
            Some("user") => {
                if let Some(text) = prompt_text(&value) {
                    prompt_offset = start;
                    messages.push(Message {
                        prompt_offset,
                        ..message(Role::User, text.to_owned())
                    });
                }
            }
            Some("assistant") => {
                let blocks = value.pointer("/message/content").and_then(Value::as_array);
                messages.extend(
                    blocks
                        .into_iter()
                        .flatten()
                        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|block| text_field(block, "text"))
                        .map(|text| message(Role::Assistant, text)),
                );
            }
            _ => {}
        }
    }
    Ok(MessageRead {
        messages,
        offset: new.offset,
        restarted: new.restarted,
        prompt_offset,
    })
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate file failures with `?` and assert on the outcome"
)]
mod tests {
    use std::{
        fs::{self, OpenOptions},
        io::{self, Write},
        path::{Path, PathBuf},
    };

    use std::time::{Duration, SystemTime};

    use serde_json::json;
    use tempfile::tempdir;

    use super::{
        Exchange, Scan, locate, read_exchanges, read_messages, scan_title, transcript_path,
    };

    const PROMPT: &str = r#"{"type":"user","message":{"role":"user","content":"Fix the parser\nIt drops the last line"}}"#;

    const COMMAND: &str = r#"{"type":"user","message":{"content":"<command-message>plan</command-message>\n<command-name>/plan</command-name>\n<command-args>fix parser\nand the lexer</command-args>"}}"#;

    fn write_transcript(dir: &Path, lines: &[&str]) -> io::Result<PathBuf> {
        let path = dir.join("session.jsonl");
        fs::write(&path, format!("{}\n", lines.join("\n")))?;
        Ok(path)
    }

    fn title_of(lines: &[&str]) -> io::Result<Option<String>> {
        let dir = tempdir()?;
        let path = write_transcript(dir.path(), lines)?;
        Ok(scan_title(&path, 0, None, None, None)?.title)
    }

    #[rstest::rstest]
    fn transcript_path_replaces_every_non_alphanumeric_character_with_a_dash() {
        // Given a cwd with slashes, a dot, and an underscore.
        let cwd = Path::new("/Users/me/.t3/a_b");

        // When computing its transcript path.
        let path = transcript_path(Path::new("/claude"), cwd, "abc");

        // Then each of those characters became a dash.
        assert_eq!(
            path,
            PathBuf::from("/claude/projects/-Users-me--t3-a-b/abc.jsonl"),
            "the project directory should be the escaped cwd"
        );
    }

    #[rstest::rstest]
    fn locate_finds_a_transcript_in_another_project_directory() -> io::Result<()> {
        // Given the transcript only exists under a different project directory.
        let claude_dir = tempdir()?;
        let other = claude_dir.path().join("projects").join("-somewhere-else");
        fs::create_dir_all(&other)?;
        fs::write(other.join("abc.jsonl"), "")?;

        // When locating it for a cwd whose escaped directory doesn't have it.
        let found = locate(claude_dir.path(), Path::new("/Users/me/orb"), "abc");

        // Then the scan of the project directories finds it.
        assert_eq!(
            found,
            Some(other.join("abc.jsonl")),
            "the scan should find the transcript"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn locate_returns_none_without_a_transcript() -> io::Result<()> {
        // Given a Claude directory with no transcript for the session.
        let claude_dir = tempdir()?;
        fs::create_dir_all(claude_dir.path().join("projects").join("-Users-me-orb"))?;

        // When locating it.
        let found = locate(claude_dir.path(), Path::new("/Users/me/orb"), "abc");

        // Then nothing is found.
        assert_eq!(found, None, "a prompt-less session has no transcript");
        Ok(())
    }

    #[rstest::rstest]
    fn first_prompt_titles_the_agent_by_its_first_line() -> io::Result<()> {
        // Given a transcript whose first prompt spans two lines.
        // When scanning it.
        let title = title_of(&[PROMPT])?;

        // Then the title is the prompt's first line.
        assert_eq!(
            title.as_deref(),
            Some("Fix the parser"),
            "title should be the first line"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn latest_ai_title_replaces_the_prompt_title() -> io::Result<()> {
        // Given a prompt followed by two generated titles.
        // When scanning it.
        let title = title_of(&[
            PROMPT,
            r#"{"type":"ai-title","aiTitle":"Parser fix"}"#,
            r#"{"type":"ai-title","aiTitle":"Fix last-line drop in parser"}"#,
        ])?;

        // Then the title is the latest generated one.
        assert_eq!(
            title.as_deref(),
            Some("Fix last-line drop in parser"),
            "the latest ai-title should win"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn ai_title_line_marks_the_scan_ai_titled() -> io::Result<()> {
        // Given a prompt followed by a generated title.
        let dir = tempdir()?;
        let path = write_transcript(
            dir.path(),
            &[PROMPT, r#"{"type":"ai-title","aiTitle":"Parser fix"}"#],
        )?;

        // When scanning it.
        let scan = scan_title(&path, 0, None, None, None)?;

        // Then the scan notes that Claude titled the agent.
        assert!(scan.ai_titled, "an ai-title line should mark the scan");
        Ok(())
    }

    #[rstest::rstest]
    fn custom_title_after_an_ai_title_is_kept_beside_it() -> io::Result<()> {
        // Given a prompt, a generated title, then a `/rename`.
        let dir = tempdir()?;
        let path = write_transcript(
            dir.path(),
            &[
                PROMPT,
                r#"{"type":"ai-title","aiTitle":"Parser fix"}"#,
                r#"{"type":"custom-title","customTitle":" orb-m1 ","sessionId":"s1"}"#,
            ],
        )?;

        // When scanning it.
        let scan = scan_title(&path, 0, None, None, None)?;

        // Then the custom title is set and the title is still the generated one.
        assert_eq!(
            (scan.title.as_deref(), scan.custom_title.as_deref()),
            (Some("Parser fix"), Some("orb-m1")),
            "`/rename` should be kept apart from the ai-title"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn later_prompt_keeps_the_existing_title() -> io::Result<()> {
        // Given a titled agent whose transcript gains another prompt.
        let dir = tempdir()?;
        let path = write_transcript(
            dir.path(),
            &[r#"{"type":"user","message":{"content":"Now add tests"}}"#],
        )?;

        // When scanning the new prompt.
        let scan = scan_title(&path, 0, Some("Fix the parser".to_owned()), None, None)?;

        // Then the title is unchanged.
        assert_eq!(
            scan.title.as_deref(),
            Some("Fix the parser"),
            "later prompts don't retitle"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn scan_takes_the_latest_git_branch() -> io::Result<()> {
        // Given two prompts that ran on different branches.
        let dir = tempdir()?;
        let path = write_transcript(
            dir.path(),
            &[
                r#"{"type":"user","gitBranch":"main","message":{"content":"Fix the parser"}}"#,
                r#"{"type":"user","gitBranch":"fix/parser","message":{"content":"Now add tests"}}"#,
            ],
        )?;

        // When scanning them.
        let scan = scan_title(&path, 0, None, None, None)?;

        // Then the branch is the one the latest prompt named.
        assert_eq!(
            scan.branch.as_deref(),
            Some("fix/parser"),
            "the latest gitBranch should win"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn scan_ignores_an_empty_git_branch() -> io::Result<()> {
        // Given an agent on `main` whose transcript gains a prompt with no branch.
        let dir = tempdir()?;
        let path = write_transcript(
            dir.path(),
            &[r#"{"type":"user","gitBranch":"","message":{"content":"Now add tests"}}"#],
        )?;

        // When scanning the new prompt.
        let scan = scan_title(&path, 0, None, None, Some("main".to_owned()))?;

        // Then the branch is still `main`.
        assert_eq!(
            scan.branch.as_deref(),
            Some("main"),
            "an empty gitBranch means no branch, not a change"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[case::meta(
        r#"{"type":"user","isMeta":true,"message":{"content":"Base directory for this skill"}}"#
    )]
    #[case::command_name(
        r#"{"type":"user","message":{"content":"<command-name>/plan</command-name>"}}"#
    )]
    #[case::empty_command_args(
        r#"{"type":"user","message":{"content":"<command-name>/plan</command-name>\n<command-args></command-args>"}}"#
    )]
    #[case::local_command_caveat(r#"{"type":"user","message":{"content":"<local-command-caveat>Caveat: do not respond</local-command-caveat>"}}"#)]
    #[case::tool_result(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#)]
    #[case::interrupted(r#"{"type":"user","message":{"content":"[Request interrupted by user]"}}"#)]
    fn non_prompt_user_lines_are_skipped_for_the_title(#[case] skipped: &str) -> io::Result<()> {
        // Given a user line that isn't a typed prompt, then a real prompt.
        // When scanning them.
        let title = title_of(&[skipped, PROMPT])?;

        // Then the title comes from the real prompt.
        assert_eq!(
            title.as_deref(),
            Some("Fix the parser"),
            "non-prompt lines should be skipped"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn text_block_of_a_prompt_array_titles_the_agent() -> io::Result<()> {
        // Given a prompt made of an image block and a text block.
        // When scanning it.
        let title = title_of(&[
            r#"{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"AA=="}},{"type":"text","text":"What's in this screenshot?"}]}}"#,
        ])?;

        // Then the title is the text block's text.
        assert_eq!(
            title.as_deref(),
            Some("What's in this screenshot?"),
            "title should come from the text block"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn command_args_title_the_agent() -> io::Result<()> {
        // Given a transcript that starts with a slash command and its args.
        // When scanning it.
        let title = title_of(&[COMMAND])?;

        // Then the title comes from the args.
        assert_eq!(
            title.as_deref(),
            Some("fix parser"),
            "the command's args should title the agent"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn command_args_title_the_agent_by_their_first_line_only() -> io::Result<()> {
        // Given a slash command whose args span two lines.
        // When scanning it.
        let title = title_of(&[COMMAND])?;

        // Then the second line is left out of the title.
        assert!(
            title
                .as_deref()
                .is_some_and(|title| !title.contains("lexer")),
            "only the args' first line should title the agent, got {title:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn command_args_starting_blank_title_by_their_first_text_line() -> io::Result<()> {
        // Given a slash command whose args begin with blank lines.
        // When scanning it.
        let title = title_of(&[
            r#"{"type":"user","message":{"content":"<command-name>/plan</command-name>\n<command-args>\n\nfix parser</command-args>"}}"#,
        ])?;

        // Then the title is the first line with text.
        assert_eq!(
            title.as_deref(),
            Some("fix parser"),
            "blank leading lines should be skipped"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn ai_title_replaces_the_command_args_title() -> io::Result<()> {
        // Given a slash command followed by a generated title.
        // When scanning it.
        let title = title_of(&[COMMAND, r#"{"type":"ai-title","aiTitle":"Parser fix"}"#])?;

        // Then the generated title wins.
        assert_eq!(
            title.as_deref(),
            Some("Parser fix"),
            "a later ai-title should replace the args title"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn text_block_of_a_command_array_titles_the_agent() -> io::Result<()> {
        // Given a slash command stored as a text block in a content array.
        // When scanning it.
        let title = title_of(&[
            r#"{"type":"user","message":{"content":[{"type":"text","text":"<command-name>/plan</command-name>\n<command-args>fix parser</command-args>"}]}}"#,
        ])?;

        // Then the title comes from the block's args.
        assert_eq!(
            title.as_deref(),
            Some("fix parser"),
            "a command text block should title the agent"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn scan_leaves_a_partial_last_line_unread() -> io::Result<()> {
        // Given a complete prompt line followed by a line still being written.
        let dir = tempdir()?;
        let path = dir.path().join("session.jsonl");
        fs::write(&path, format!("{PROMPT}\n{{\"type\":\"ai-title\",\"aiT"))?;

        // When scanning it.
        let scan = scan_title(&path, 0, None, None, None)?;

        // Then only the complete line was read.
        assert_eq!(
            scan,
            Scan {
                title: Some("Fix the parser".to_owned()),
                custom_title: None,
                branch: None,
                ai_titled: false,
                offset: PROMPT.len() as u64 + 1
            },
            "the offset should stop after the last newline"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn completed_partial_line_is_parsed_on_the_next_scan() -> io::Result<()> {
        // Given a scan that stopped before a partial line, which is then completed.
        let dir = tempdir()?;
        let path = dir.path().join("session.jsonl");
        fs::write(&path, format!("{PROMPT}\n{{\"type\":\"ai-title\",\"aiT"))?;
        let first = scan_title(&path, 0, None, None, None)?;
        OpenOptions::new()
            .append(true)
            .open(&path)?
            .write_all(b"itle\":\"Parser fix\"}\n")?;

        // When scanning again from the first scan's offset.
        let scan = scan_title(&path, first.offset, first.title, None, None)?;

        // Then the completed line applied and the offset reached the file end.
        assert_eq!(
            scan,
            Scan {
                title: Some("Parser fix".to_owned()),
                custom_title: None,
                branch: None,
                ai_titled: true,
                offset: fs::metadata(&path)?.len()
            },
            "the completed line should be parsed once"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn malformed_line_is_skipped() -> io::Result<()> {
        // Given a truncated user line followed by a real prompt.
        // When scanning them.
        let title = title_of(&[r#"{"type":"user","message":{"content":"Bro"#, PROMPT])?;

        // Then the malformed line is ignored and the prompt still titles the agent.
        assert_eq!(
            title.as_deref(),
            Some("Fix the parser"),
            "malformed lines should be skipped"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn file_shorter_than_the_offset_is_rescanned_from_the_start() -> io::Result<()> {
        // Given a transcript shorter than the saved offset (the file was replaced).
        let dir = tempdir()?;
        let path = write_transcript(dir.path(), &[PROMPT])?;

        // When scanning from that offset.
        let scan = scan_title(&path, 10_000, None, None, None)?;

        // Then the whole file was read again.
        assert_eq!(
            scan,
            Scan {
                title: Some("Fix the parser".to_owned()),
                custom_title: None,
                branch: None,
                ai_titled: false,
                offset: fs::metadata(&path)?.len()
            },
            "a replaced file should be read from the start"
        );
        Ok(())
    }

    fn exchanges_of(lines: &[&str]) -> io::Result<Vec<Exchange>> {
        let dir = tempdir()?;
        let path = write_transcript(dir.path(), lines)?;
        Ok(read_exchanges(&path)?.1)
    }

    /// A prompt line typing `text`.
    fn user(text: &str) -> String {
        json!({"type": "user", "message": {"content": text}}).to_string()
    }

    /// An assistant line writing `reply`.
    fn text(reply: &str) -> String {
        json!({"type": "assistant", "message": {"content": [{"type": "text", "text": reply}]}})
            .to_string()
    }

    /// An assistant line running tool `name`.
    fn tool(name: &str) -> String {
        json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": name}]}})
            .to_string()
    }

    fn prompts(exchanges: Vec<Exchange>) -> Vec<Option<String>> {
        exchanges
            .into_iter()
            .map(|exchange| exchange.prompt.map(|(text, _)| text))
            .collect()
    }

    fn replies(exchanges: Vec<Exchange>) -> Vec<Option<String>> {
        exchanges
            .into_iter()
            .map(|exchange| exchange.reply.map(|(text, _)| text))
            .collect()
    }

    #[rstest::rstest]
    #[case::meta(
        r#"{"type":"user","isMeta":true,"message":{"content":"Base directory for this skill"}}"#
    )]
    #[case::sidechain(
        r#"{"type":"user","isSidechain":true,"message":{"content":"Explore the parser"}}"#
    )]
    #[case::command_name(
        r#"{"type":"user","message":{"content":"<command-name>/plan</command-name>"}}"#
    )]
    #[case::command_with_args(COMMAND)]
    #[case::tool_result(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#)]
    #[case::interrupted(r#"{"type":"user","message":{"content":"[Request interrupted by user]"}}"#)]
    fn non_prompt_user_lines_open_no_exchange(#[case] line: &str) -> io::Result<()> {
        // Given a transcript holding only a user line that isn't a typed prompt.
        // When reading its exchanges.
        let exchanges = exchanges_of(&[line])?;

        // Then there are none.
        assert_eq!(exchanges, [], "non-prompt lines shouldn't open an exchange");
        Ok(())
    }

    #[rstest::rstest]
    fn sidechain_reply_is_skipped() -> io::Result<()> {
        // Given a prompt followed by a subagent's text.
        // When reading the exchanges.
        let exchanges = exchanges_of(&[
            PROMPT,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"Found it"}]}}"#,
        ])?;

        // Then the exchange has no reply.
        assert_eq!(
            replies(exchanges),
            [None],
            "a subagent's text isn't Claude's reply"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn last_text_block_of_an_exchange_is_its_reply() -> io::Result<()> {
        // Given a prompt followed by two texts.
        // When reading the exchanges.
        let exchanges = exchanges_of(&[PROMPT, &text("First"), &text("Second")])?;

        // Then the reply is the second text.
        assert_eq!(
            replies(exchanges),
            [Some("Second".to_owned())],
            "the last text should be the reply"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn same_tool_run_is_counted_once() -> io::Result<()> {
        // Given a prompt followed by Grep, Edit, Edit.
        // When reading the exchanges.
        let exchanges = exchanges_of(&[PROMPT, &tool("Grep"), &tool("Edit"), &tool("Edit")])?;

        // Then the two Edits are one run counted twice.
        assert_eq!(
            exchanges
                .into_iter()
                .map(|exchange| exchange.tools)
                .collect::<Vec<_>>(),
            [vec![("Grep".to_owned(), 1), ("Edit".to_owned(), 2)]],
            "a run of one tool should collapse"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn reply_before_any_prompt_opens_an_exchange_without_one() -> io::Result<()> {
        // Given a transcript tail that starts with Claude's text.
        // When reading the exchanges.
        let exchanges = exchanges_of(&[&text("Done")])?;

        // Then one exchange holds the reply and no prompt.
        assert_eq!(
            exchanges,
            [Exchange {
                reply: Some(("Done".to_owned(), None)),
                ..Exchange::default()
            }],
            "a reply with no prompt before it should still show"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn only_the_last_three_exchanges_are_kept() -> io::Result<()> {
        // Given five prompts.
        // When reading the exchanges.
        let exchanges = exchanges_of(&[
            &user("p1"),
            &user("p2"),
            &user("p3"),
            &user("p4"),
            &user("p5"),
        ])?;

        // Then only the last three remain, oldest first.
        assert_eq!(
            prompts(exchanges),
            [
                Some("p3".to_owned()),
                Some("p4".to_owned()),
                Some("p5".to_owned())
            ],
            "older exchanges should be dropped"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn tail_read_skips_the_line_it_starts_inside() -> io::Result<()> {
        // Given a 600 KB first line that still parses when cut, then a prompt.
        let first = format!(
            "{}{}",
            " ".repeat(600 * 1024),
            r#"{"type":"user","message":{"content":"Old"}}"#
        );

        // When reading the exchanges.
        let exchanges = exchanges_of(&[&first, PROMPT])?;

        // Then only the prompt after the cut line is read.
        assert_eq!(
            prompts(exchanges),
            [Some("Fix the parser\nIt drops the last line".to_owned())],
            "the line the tail starts inside should be skipped"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn bad_timestamp_keeps_the_exchange_without_a_time() -> io::Result<()> {
        // Given a prompt whose timestamp doesn't parse.
        // When reading the exchanges.
        let exchanges = exchanges_of(&[
            r#"{"type":"user","timestamp":"yesterday","message":{"content":"Fix it"}}"#,
        ])?;

        // Then the exchange is kept, its prompt without a time.
        assert_eq!(
            exchanges
                .into_iter()
                .map(|exchange| exchange.prompt)
                .collect::<Vec<_>>(),
            [Some(("Fix it".to_owned(), None))],
            "a bad timestamp should only drop the time"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn prompt_time_comes_from_its_timestamp() -> io::Result<()> {
        // Given a prompt stamped one second after the epoch.
        // When reading the exchanges.
        let exchanges = exchanges_of(&[
            r#"{"type":"user","timestamp":"1970-01-01T00:00:01Z","message":{"content":"Fix it"}}"#,
        ])?;

        // Then the prompt's time is that second.
        assert_eq!(
            exchanges
                .into_iter()
                .filter_map(|exchange| exchange.prompt)
                .map(|(_, time)| time)
                .collect::<Vec<_>>(),
            [Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1))],
            "the time should come from the timestamp"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn read_exchanges_returns_the_transcript_length() -> io::Result<()> {
        // Given a one-prompt transcript.
        let dir = tempdir()?;
        let path = write_transcript(dir.path(), &[PROMPT])?;

        // When reading its exchanges.
        let (len, _) = read_exchanges(&path)?;

        // Then the length is the file's.
        assert_eq!(
            len,
            fs::metadata(&path)?.len(),
            "the length should be the file's"
        );
        Ok(())
    }

    /// The offsets of the messages `read_messages` finds in `lines` from the start.
    fn message_offsets(lines: &[&str]) -> io::Result<Vec<(u64, u64)>> {
        let dir = tempdir()?;
        let path = write_transcript(dir.path(), lines)?;
        Ok(read_messages(&path, 0, 0)?
            .messages
            .into_iter()
            .map(|message| (message.offset, message.prompt_offset))
            .collect())
    }

    #[rstest::rstest]
    fn read_messages_gives_each_message_its_line_offset() -> io::Result<()> {
        // Given a prompt and Claude's reply on the next line.
        let first = user("Fix the parser");

        // When reading the messages.
        let offsets = message_offsets(&[&first, &text("Done")])?;

        // Then the reply sits right after the prompt's line and its newline.
        assert_eq!(
            offsets.get(1).map(|(offset, _)| *offset),
            Some(first.len() as u64 + 1),
            "the second message should start after the first line"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn read_messages_gives_a_reply_the_offset_of_its_prompt() -> io::Result<()> {
        // Given a reply, a prompt, then a reply to it.
        let opener = text("Hello");

        // When reading the messages.
        let offsets = message_offsets(&[&opener, &user("Fix the parser"), &text("Done")])?;

        // Then the last reply carries the prompt's offset.
        assert_eq!(
            offsets.last().map(|(_, prompt)| *prompt),
            Some(opener.len() as u64 + 1),
            "the reply should point at the prompt it answers"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn read_messages_carries_the_prompt_offset_into_the_next_read() -> io::Result<()> {
        // Given a transcript read once after a reply and a prompt.
        let dir = tempdir()?;
        let opener = text("Hello");
        let path = write_transcript(dir.path(), &[&opener, &user("Fix the parser")])?;
        let first = read_messages(&path, 0, 0)?;
        let mut file = OpenOptions::new().append(true).open(&path)?;
        writeln!(file, "{}", text("Done"))?;

        // When reading the appended reply from where the first read stopped.
        let second = read_messages(&path, first.offset, first.prompt_offset)?;

        // Then the reply carries the first read's prompt offset.
        assert_eq!(
            second
                .messages
                .iter()
                .map(|message| message.prompt_offset)
                .collect::<Vec<_>>(),
            [opener.len() as u64 + 1],
            "the reply should answer the prompt from the earlier read"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn read_messages_of_a_replaced_transcript_starts_the_prompt_offset_at_zero() -> io::Result<()> {
        // Given a transcript replaced by a shorter one holding only a reply.
        let dir = tempdir()?;
        let path = write_transcript(dir.path(), &[&text("Done")])?;
        let past_the_end = fs::metadata(&path)?.len() + 100;

        // When reading it from a saved offset past its end.
        let read = read_messages(&path, past_the_end, 50)?;

        // Then the reply answers no prompt.
        assert_eq!(
            read.messages
                .iter()
                .map(|message| message.prompt_offset)
                .collect::<Vec<_>>(),
            [0],
            "a replaced transcript's old prompt offset should be dropped"
        );
        Ok(())
    }
}
