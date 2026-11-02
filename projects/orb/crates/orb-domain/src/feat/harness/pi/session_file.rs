//! pi's session files: where a session's JSONL lives, what to title it,
//! and the exchanges and messages the preview and search read from it.
//!
//! pi writes the file on the first prompt, appending whole lines. Its name
//! ends in `_<session id>.jsonl`; it sits in a per-cwd directory under
//! pi's sessions directory, or straight in a configured one.

use std::{
    ffi::OsStr,
    fs, io,
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde_json::Value;

use crate::feat::harness::Scan;
use crate::feat::sessions::transcript::{Exchange, Message, MessageRead, Role, read_new_lines};

/// The per-cwd directory pi files a session under: the cwd without its
/// leading `/`, with every `/`, `\` and `:` replaced by `-`, between `--`.
pub fn dir_name(cwd: &Path) -> String {
    let cwd = cwd.to_string_lossy();
    let escaped = cwd
        .strip_prefix('/')
        .unwrap_or(&cwd)
        .replace(['/', '\\', ':'], "-");
    format!("--{escaped}--")
}

/// The session file of `id`: in `cwd`'s directory when `cwd` is given, else
/// at `sessions_dir`'s top level (a configured, flat directory), else in any
/// directory under it.
pub fn find(sessions_dir: &Path, cwd: Option<&Path>, id: &str) -> Option<PathBuf> {
    let suffix = format!("_{id}.jsonl");
    let in_dir = |dir: &Path| {
        fs::read_dir(dir)
            .ok()?
            .flatten()
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(OsStr::to_str)
                    .is_some_and(|name| name.ends_with(&suffix))
                    && path.is_file()
            })
    };
    cwd.and_then(|cwd| in_dir(&sessions_dir.join(dir_name(cwd))))
        .or_else(|| in_dir(sessions_dir))
        .or_else(|| {
            fs::read_dir(sessions_dir)
                .ok()?
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .find_map(|dir| in_dir(&dir))
        })
}

/// Reads the complete lines added to the session file since `offset` and
/// builds on `previous`: the title is the first prompt's first line, the
/// custom title the latest name given with `/name`. pi records no branch,
/// so that is left to git.
///
/// # Errors
///
/// Returns an error if the session file can't be opened or read.
pub fn scan(path: &Path, offset: u64, previous: &Scan) -> io::Result<Scan> {
    let new = read_new_lines(path, offset)?;
    let scan = Scan {
        title: previous.title.clone(),
        custom_title: previous.custom_title.clone(),
        branch: None,
        ai_titled: false,
        offset: new.offset,
    };
    Ok(new.text.lines().fold(scan, next_title))
}

/// The titles after one session file line.
fn next_title(scan: Scan, line: &str) -> Scan {
    if !line.contains(r#""type":"message""#) && !line.contains(r#""type":"session_info""#) {
        return scan;
    }
    let Ok(entry) = serde_json::from_str::<Value>(line) else {
        return scan;
    };
    match entry.get("type").and_then(Value::as_str) {
        Some("session_info") => Scan {
            custom_title: text_field(&entry, "name").or(scan.custom_title),
            ..scan
        },
        Some("message") if scan.title.is_none() => Scan {
            title: prompt_text(&entry)
                .and_then(|text| text.lines().next())
                .map(|first| first.trim().to_owned()),
            ..scan
        },
        _ => scan,
    }
}

/// How much of a session file's end the preview reads.
const PREVIEW_TAIL: u64 = 512 * 1024;

/// How many exchanges the preview keeps: two briefs and the newest.
const PREVIEW_EXCHANGES: usize = 3;

/// The session file's length and its last exchanges, read from its last
/// 512 KB. A tail that starts mid-file drops its first line, which may be
/// cut.
///
/// # Errors
///
/// Returns an error if the session file can't be opened or read.
pub fn exchanges(path: &Path) -> io::Result<(u64, Vec<Exchange>)> {
    let len = fs::metadata(path)?.len();
    let start = len.saturating_sub(PREVIEW_TAIL);
    let text = read_new_lines(path, start)?.text;
    let mut exchanges = text
        .lines()
        .skip(usize::from(start > 0))
        .filter(|line| line.contains(r#""type":"message""#))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .fold(Vec::new(), |exchanges, entry| {
            next_exchange(exchanges, &entry)
        });
    let excess = exchanges.len().saturating_sub(PREVIEW_EXCHANGES);
    exchanges.drain(..excess);
    Ok((len, exchanges))
}

/// The exchanges after one message entry: a prompt opens one, an assistant
/// message adds its tool calls and its last text to the latest. Other roles
/// change nothing.
fn next_exchange(mut exchanges: Vec<Exchange>, entry: &Value) -> Vec<Exchange> {
    let time = timestamp(entry).map(SystemTime::from);
    match role(entry) {
        Some("user") => {
            if let Some(text) = prompt_text(entry) {
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
            for block in blocks(entry) {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = text_field(block, "text") {
                            exchange.reply = Some((text, time));
                        }
                    }
                    Some("toolCall") => {
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

/// Reads the prompts and pi's text blocks added to the session file since
/// `offset`, each with where its line sits and which prompt it answers.
///
/// `prompt_offset` is the prompt the previous read ended under. A replaced
/// file is read from the start, and its prompt offset starts at 0.
///
/// # Errors
///
/// Returns an error if the session file can't be opened or read.
pub fn messages(path: &Path, offset: u64, prompt_offset: u64) -> io::Result<MessageRead> {
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
        if !line.contains(r#""type":"message""#) {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let at = timestamp(&entry).map_or(0, jiff::Timestamp::as_millisecond);
        let message = move |role, text| Message {
            role,
            text,
            offset: start,
            prompt_offset,
            at,
        };
        match role(&entry) {
            Some("user") => {
                if let Some(text) = prompt_text(&entry) {
                    prompt_offset = start;
                    messages.push(Message {
                        prompt_offset,
                        ..message(Role::User, text.to_owned())
                    });
                }
            }
            Some("assistant") => messages.extend(
                blocks(&entry)
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| text_field(block, "text"))
                    .map(|text| message(Role::Assistant, text)),
            ),
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

/// When an entry was written, from its `timestamp`.
fn timestamp(entry: &Value) -> Option<jiff::Timestamp> {
    entry.get("timestamp")?.as_str()?.parse().ok()
}

/// The content blocks of a message entry's message.
fn blocks(entry: &Value) -> impl Iterator<Item = &Value> {
    entry
        .pointer("/message/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// A field's string, trimmed, or `None` if it's missing or blank.
fn text_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The role of a message entry's message.
fn role(entry: &Value) -> Option<&str> {
    entry.pointer("/message/role").and_then(Value::as_str)
}

/// The prompt a user message holds: its first text block (or its text, when
/// the content is a plain string), trimmed; `None` for any other entry or a
/// blank prompt.
fn prompt_text(entry: &Value) -> Option<&str> {
    if role(entry) != Some("user") {
        return None;
    }
    let text = match entry.pointer("/message/content")? {
        Value::String(text) => text,
        Value::Array(blocks) => blocks
            .iter()
            .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))?
            .get("text")?
            .as_str()?,
        _ => return None,
    }
    .trim();
    Some(text).filter(|text| !text.is_empty())
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate file failures with `?` and assert on the outcome"
)]
mod tests {
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};

    use serde_json::json;
    use tempfile::tempdir;

    use super::{dir_name, exchanges, find, messages, scan};
    use crate::feat::harness::Scan;
    use crate::feat::sessions::transcript::Role;

    /// pi's first line in every session file.
    const HEADER: &str = r#"{"type":"session","version":3,"id":"orb-a","timestamp":"2026-10-04T01:24:14.425Z","cwd":"/work/a"}"#;

    /// A prompt the user typed, as pi writes it.
    fn prompt(text: &str) -> String {
        json!({
            "type": "message",
            "timestamp": "2026-10-04T01:24:22.358Z",
            "message": {"role": "user", "content": [{"type": "text", "text": text}]},
        })
        .to_string()
    }

    /// An assistant message with `content` blocks.
    fn reply(content: &serde_json::Value) -> String {
        json!({
            "type": "message",
            "timestamp": "2026-10-04T01:24:25.463Z",
            "message": {"role": "assistant", "content": content, "stopReason": "stop"},
        })
        .to_string()
    }

    /// An assistant message that only says `text`.
    fn said(text: &str) -> String {
        reply(&json!([{"type": "text", "text": text}]))
    }

    /// An assistant message that calls each tool in `names`.
    fn calls(names: &[&str]) -> String {
        let blocks: Vec<_> = names
            .iter()
            .map(|name| json!({"type": "toolCall", "id": "c", "name": name, "arguments": {}}))
            .collect();
        reply(&json!(blocks))
    }

    /// A tool's result.
    fn tool_result() -> String {
        json!({
            "type": "message",
            "timestamp": "2026-10-04T01:24:27.015Z",
            "message": {"role": "toolResult", "toolName": "bash", "content": [{"type": "text", "text": "done\n"}]},
        })
        .to_string()
    }

    /// The name the user gave the session with `/name`.
    fn named(name: &str) -> String {
        json!({"type": "session_info", "timestamp": "2026-10-04T01:25:10.919Z", "name": name})
            .to_string()
    }

    fn write_session(dir: &Path, lines: &[String]) -> io::Result<PathBuf> {
        let path = dir.join("2026-10-04T01-24-14-425Z_orb-a.jsonl");
        fs::write(&path, format!("{}\n", lines.join("\n")))?;
        Ok(path)
    }

    fn scanned(lines: &[String]) -> io::Result<Scan> {
        let dir = tempdir()?;
        let path = write_session(dir.path(), lines)?;
        scan(&path, 0, &Scan::default())
    }

    /// An exchange's prompt text, tools and reply text.
    type ExchangeText = (Option<String>, Vec<(String, usize)>, Option<String>);

    /// Each exchange as its prompt text, tools and reply text.
    fn exchange_texts(lines: &[String]) -> io::Result<Vec<ExchangeText>> {
        let dir = tempdir()?;
        let path = write_session(dir.path(), lines)?;
        let (_, exchanges) = exchanges(&path)?;
        Ok(exchanges
            .into_iter()
            .map(|exchange| {
                (
                    exchange.prompt.map(|(text, _)| text),
                    exchange.tools,
                    exchange.reply.map(|(text, _)| text),
                )
            })
            .collect())
    }

    #[rstest::rstest]
    #[case::a_worktree(
        "/Users/me/.t3/worktrees/orb/orb-4eb91b0d",
        "--Users-me-.t3-worktrees-orb-orb-4eb91b0d--"
    )]
    #[case::backslash_and_colon(r"/work/a\b:c", "--work-a-b-c--")]
    fn dir_name_escapes_the_cwd(#[case] cwd: &str, #[case] expected: &str) {
        // Given / When / Then: the cwd's directory name is escaped and fenced.
        assert_eq!(dir_name(Path::new(cwd)), expected, "dir name of {cwd}");
    }

    #[rstest::rstest]
    fn find_looks_in_the_cwd_directory() -> io::Result<()> {
        // Given the session's file in its cwd's directory.
        let sessions = tempdir()?;
        let dir = sessions.path().join("--work-a--");
        fs::create_dir_all(&dir)?;
        let path = write_session(&dir, &[HEADER.to_owned()])?;

        // When finding it for that cwd.
        let found = find(sessions.path(), Some(Path::new("/work/a")), "orb-a");

        // Then it's the file in the cwd's directory.
        assert_eq!(found, Some(path), "the cwd's directory should hold it");
        Ok(())
    }

    #[rstest::rstest]
    fn find_falls_back_to_other_directories() -> io::Result<()> {
        // Given the session's file in another cwd's directory.
        let sessions = tempdir()?;
        let dir = sessions.path().join("--elsewhere--");
        fs::create_dir_all(&dir)?;
        let path = write_session(&dir, &[HEADER.to_owned()])?;

        // When finding it for a cwd whose directory doesn't have it.
        let found = find(sessions.path(), Some(Path::new("/work/a")), "orb-a");

        // Then the other directory's file is found.
        assert_eq!(found, Some(path), "other directories should be searched");
        Ok(())
    }

    #[rstest::rstest]
    fn find_looks_at_the_top_of_a_configured_directory() -> io::Result<()> {
        // Given a configured sessions directory holding the file directly.
        let sessions = tempdir()?;
        let path = write_session(sessions.path(), &[HEADER.to_owned()])?;

        // When finding it for a cwd.
        let found = find(sessions.path(), Some(Path::new("/work/a")), "orb-a");

        // Then the top-level file is found.
        assert_eq!(found, Some(path), "the top level should be searched");
        Ok(())
    }

    #[rstest::rstest]
    fn find_without_a_file_is_none() -> io::Result<()> {
        // Given a sessions directory with another session's file.
        let sessions = tempdir()?;
        fs::write(sessions.path().join("2026-10-04_orb-b.jsonl"), HEADER)?;

        // When finding a session pi hasn't written yet.
        let found = find(sessions.path(), Some(Path::new("/work/a")), "orb-a");

        // Then there is none.
        assert_eq!(found, None, "no file should be found");
        Ok(())
    }

    #[rstest::rstest]
    fn scan_titles_a_session_by_its_first_prompt() -> io::Result<()> {
        // Given two prompts, the first two lines long.
        let lines = [
            HEADER.to_owned(),
            prompt("Fix the parser\nIt drops the last line"),
            said("Done"),
            prompt("Now the tests"),
        ];

        // When scanning the file.
        let scan = scanned(&lines)?;

        // Then the title is the first prompt's first line.
        assert_eq!(
            scan.title.as_deref(),
            Some("Fix the parser"),
            "the first prompt should title the session"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn scan_takes_the_first_text_block_of_an_array_prompt() -> io::Result<()> {
        // Given a prompt whose content is an image, then two text blocks.
        let entry = json!({
            "type": "message",
            "timestamp": "2026-10-04T01:24:22.358Z",
            "message": {"role": "user", "content": [
                {"type": "image", "data": "iVBOR", "mimeType": "image/png"},
                {"type": "text", "text": "What is this?"},
                {"type": "text", "text": "Be brief."},
            ]},
        });
        let lines = [HEADER.to_owned(), entry.to_string()];

        // When scanning the file.
        let scan = scanned(&lines)?;

        // Then the title is the first text block.
        assert_eq!(
            scan.title.as_deref(),
            Some("What is this?"),
            "the first text block should title the session"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn scan_takes_the_latest_session_name_as_custom_title() -> io::Result<()> {
        // Given a session named twice.
        let lines = [
            HEADER.to_owned(),
            prompt("Fix the parser"),
            named("first name"),
            said("Done"),
            named("spike-title"),
        ];

        // When scanning the file.
        let scan = scanned(&lines)?;

        // Then the custom title is the latest name.
        assert_eq!(
            scan.custom_title.as_deref(),
            Some("spike-title"),
            "the latest name should be the custom title"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn scan_reports_no_branch() -> io::Result<()> {
        // Given a session with a prompt and a reply.
        let lines = [HEADER.to_owned(), prompt("Fix the parser"), said("Done")];

        // When scanning the file.
        let scan = scanned(&lines)?;

        // Then it names no branch, leaving that to git.
        assert_eq!(scan.branch, None, "pi records no branch");
        Ok(())
    }

    #[rstest::rstest]
    fn exchanges_hold_prompt_tools_and_reply() -> io::Result<()> {
        // Given a prompt, a tool call, its result and a final reply.
        let lines = [
            HEADER.to_owned(),
            prompt("Run the tests"),
            calls(&["bash"]),
            tool_result(),
            said("All green"),
        ];

        // When reading the exchanges.
        let exchanges = exchange_texts(&lines)?;

        // Then one exchange holds the prompt, the tool and the reply.
        assert_eq!(
            exchanges,
            [(
                Some("Run the tests".to_owned()),
                vec![("bash".to_owned(), 1)],
                Some("All green".to_owned()),
            )],
            "the exchange should hold prompt, tool and reply"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn tool_runs_count_once() -> io::Result<()> {
        // Given three reads across two messages, then a bash call.
        let lines = [
            HEADER.to_owned(),
            prompt("Look around"),
            calls(&["read", "read"]),
            tool_result(),
            calls(&["read", "bash"]),
        ];

        // When reading the exchanges.
        let exchanges = exchange_texts(&lines)?;

        // Then the reads are one entry counted three times.
        let tools: Vec<_> = exchanges
            .into_iter()
            .flat_map(|(_, tools, _)| tools)
            .collect();
        assert_eq!(
            tools,
            [("read".to_owned(), 3), ("bash".to_owned(), 1)],
            "a run of one tool should be one entry"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn exchanges_keep_the_last_three() -> io::Result<()> {
        // Given four prompts, each answered.
        let lines: Vec<String> = std::iter::once(HEADER.to_owned())
            .chain(
                ["one", "two", "three", "four"]
                    .into_iter()
                    .flat_map(|text| [prompt(text), said("ok")]),
            )
            .collect();

        // When reading the exchanges.
        let exchanges = exchange_texts(&lines)?;

        // Then only the last three prompts are kept.
        let prompts: Vec<_> = exchanges
            .into_iter()
            .filter_map(|(prompt, _, _)| prompt)
            .collect();
        assert_eq!(
            prompts,
            ["two", "three", "four"],
            "the oldest exchange should be dropped"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn messages_carry_line_and_prompt_offsets() -> io::Result<()> {
        // Given a header, a prompt and a reply.
        let dir = tempdir()?;
        let lines = [HEADER.to_owned(), prompt("Fix the parser"), said("Done")];
        let path = write_session(dir.path(), &lines)?;
        let prompt_at = HEADER.len() as u64 + 1;
        let reply_at = prompt_at + lines.get(1).map_or(0, String::len) as u64 + 1;

        // When reading the messages from the start.
        let read = messages(&path, 0, 0)?;

        // Then each sits at its line, under the prompt's line.
        let found: Vec<_> = read
            .messages
            .iter()
            .map(|message| {
                (
                    message.role,
                    message.text.as_str(),
                    message.offset,
                    message.prompt_offset,
                )
            })
            .collect();
        assert_eq!(
            found,
            [
                (Role::User, "Fix the parser", prompt_at, prompt_at),
                (Role::Assistant, "Done", reply_at, prompt_at),
            ],
            "messages should carry their line and prompt offsets"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn messages_restart_on_a_shorter_file() -> io::Result<()> {
        // Given a file shorter than the offset the last read ended at.
        let dir = tempdir()?;
        let path = write_session(dir.path(), &[HEADER.to_owned(), prompt("Fix the parser")])?;
        let prompt_at = HEADER.len() as u64 + 1;

        // When reading its messages from that offset.
        let read = messages(&path, 100_000, 90_000)?;

        // Then it's read from the start, with offsets counted from 0.
        let found: Vec<_> = read
            .messages
            .iter()
            .map(|message| (message.offset, message.prompt_offset))
            .collect();
        assert!(
            read.restarted && found == [(prompt_at, prompt_at)],
            "a replaced file should be read from the start, got {found:?}"
        );
        Ok(())
    }
}
