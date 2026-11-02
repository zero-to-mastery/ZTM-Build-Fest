//! Transcripts in any harness's format: the complete lines a file gained
//! since an offset, and the exchanges and messages a harness reads out of them.

use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
    time::SystemTime,
};

/// The complete lines appended to a transcript since an offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewLines {
    /// The new complete lines (lossy UTF-8), each ending in `\n`.
    pub text: String,
    /// Bytes read so far; pass it to the next read.
    pub offset: u64,
    /// The file was shorter than the offset, so it was read from the start.
    pub restarted: bool,
}

/// Reads the complete lines added to the transcript since `offset`.
///
/// A trailing line without its newline is left for the next read. A file
/// shorter than `offset` was replaced, so it's read again from the start.
///
/// # Errors
///
/// Returns an error if the transcript can't be opened or read.
pub fn read_new_lines(path: &Path, offset: u64) -> io::Result<NewLines> {
    let mut file = File::open(path)?;
    let restarted = file.metadata()?.len() < offset;
    let start = if restarted { 0 } else { offset };
    #[expect(
        clippy::verbose_file_reads,
        reason = "reads from the saved offset; `fs::read` would re-read the whole transcript"
    )]
    let bytes = {
        let mut bytes = Vec::new();
        file.seek(SeekFrom::Start(start))?;
        file.read_to_end(&mut bytes)?;
        let complete = bytes
            .iter()
            .rposition(|&byte| byte == b'\n')
            .map_or(0, |newline| newline + 1);
        bytes.truncate(complete);
        bytes
    };
    Ok(NewLines {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        offset: start + bytes.len() as u64,
        restarted,
    })
}

/// A prompt and what the session did after it, oldest first in a tail.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Exchange {
    /// What the user typed and when; `None` when the tail starts after it.
    pub prompt: Option<(String, Option<SystemTime>)>,
    /// Tool names in order, a run of the same tool counted once.
    pub tools: Vec<(String, usize)>,
    /// The reply's last text block in the exchange and when it was written.
    pub reply: Option<(String, Option<SystemTime>)>,
}

/// Who wrote a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// A prompt the user typed.
    User,
    /// A text block of the reply.
    Assistant,
}

/// A prompt the user typed, or one text block of the reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    /// Who wrote it.
    pub role: Role,
    /// The text, trimmed.
    pub text: String,
    /// Byte offset of its line in the transcript.
    pub offset: u64,
    /// Byte offset of the prompt that opened its exchange; 0 before any prompt.
    pub prompt_offset: u64,
    /// Unix ms from the line's `timestamp`, 0 when missing or unparsable.
    pub at: i64,
}

/// The messages in a transcript's new lines, and where to read from next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageRead {
    /// The prompts and reply text blocks, in file order.
    pub messages: Vec<Message>,
    /// Bytes read so far; pass it to the next read.
    pub offset: u64,
    /// The file was shorter than the offset, so it was read from the start.
    pub restarted: bool,
    /// The prompt offset the last message ran under; pass it to the next read.
    pub prompt_offset: u64,
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate file failures with `?` and assert on the outcome"
)]
mod tests {
    use std::{
        fs, io,
        path::{Path, PathBuf},
    };

    use tempfile::tempdir;

    use super::{NewLines, read_new_lines};

    const PROMPT: &str = r#"{"type":"user","message":{"role":"user","content":"Fix the parser\nIt drops the last line"}}"#;

    fn write_transcript(dir: &Path, lines: &[&str]) -> io::Result<PathBuf> {
        let path = dir.join("session.jsonl");
        fs::write(&path, format!("{}\n", lines.join("\n")))?;
        Ok(path)
    }

    #[rstest::rstest]
    fn read_new_lines_restarts_on_a_file_shorter_than_the_offset() -> io::Result<()> {
        // Given a transcript shorter than the saved offset (the file was replaced).
        let dir = tempdir()?;
        let path = write_transcript(dir.path(), &[PROMPT])?;

        // When reading from that offset.
        let new = read_new_lines(&path, 10_000)?;

        // Then it restarted and read the whole file.
        assert_eq!(
            new,
            NewLines {
                text: format!("{PROMPT}\n"),
                offset: fs::metadata(&path)?.len(),
                restarted: true,
            },
            "a replaced file should be read from the start"
        );
        Ok(())
    }
}
