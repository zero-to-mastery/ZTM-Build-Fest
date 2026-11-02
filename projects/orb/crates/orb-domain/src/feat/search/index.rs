//! The transcript search index, kept in `search.sqlite`.
//!
//! It holds every agent's prompts and the text replies, read from the
//! transcripts, and finds the ones containing case-insensitive substrings of 3
//! or more characters. It is a disposable copy of the transcripts: when the
//! file is missing, can't be opened, or was written by another schema, it is
//! deleted and built again.

use std::collections::HashSet;
use std::io;
use std::ops::Range;
use std::path::{Path, PathBuf};

use error_stack::{Report, ResultExt};
use rusqlite::{Connection, OptionalExtension, params};
use unicode_segmentation::UnicodeSegmentation;
use wherror::Error;

use crate::feat::sessions::transcript::{MessageRead, Role};
use crate::ids::AgentId;

#[derive(Debug, Error)]
#[error(debug)]
pub struct SearchIndexError;

/// An agent as the index knows it: its id and its `created_at` in unix ms.
/// The pair tells an agent apart from a later one that reuses its id.
pub type AgentKey = (AgentId, i64);

/// How many rows a query returns at most.
pub const MAX_HITS: usize = 200;

/// How many graphemes a snippet keeps before the first hit, and from it on.
const SNIPPET_BEFORE: usize = 40;
const SNIPPET_AFTER: usize = 200;

/// The index's schema version, kept in `user_version`.
const SCHEMA: i32 = 1;

/// Private-use characters `highlight()` puts around each match.
const OPEN: char = '\u{E000}';
const CLOSE: char = '\u{E001}';

/// The tables, the trigram full-text table over `messages.text`, and the
/// triggers that keep the two in step.
const SCHEMA_SQL: &str = "
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  thread INTEGER NOT NULL,
  born INTEGER NOT NULL,
  path TEXT NOT NULL,
  offset INTEGER NOT NULL,
  prompt_offset INTEGER NOT NULL,
  role TEXT NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL);
CREATE INDEX messages_thread ON messages(thread, born);
CREATE INDEX messages_exchange ON messages(path, prompt_offset, offset);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text, content='messages', content_rowid='id', tokenize='trigram');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
CREATE TABLE transcripts (
  path TEXT PRIMARY KEY,
  thread INTEGER NOT NULL,
  born INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  prompt_offset INTEGER NOT NULL);
";

/// One message that matched a query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub id: i64,
    pub agent: AgentId,
    /// The agent's `created_at` in unix ms; with `agent` it names the agent.
    pub born: i64,
    pub path: PathBuf,
    pub prompt_offset: u64,
    pub role: Role,
    /// Unix ms; 0 when the line had no timestamp.
    pub at: i64,
    /// The whole message text.
    pub text: String,
    /// Byte offsets into `text` of every grapheme the query matched.
    pub lit: Vec<usize>,
}

/// A query's rows, newest first, and whether more than `MAX_HITS` matched.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Hits {
    pub hits: Vec<Hit>,
    pub overflow: bool,
}

/// The transcript search index over its own SQLite file.
#[derive(Debug)]
pub struct SearchIndex {
    conn: Connection,
}

impl SearchIndex {
    /// Opens the index at `path`, creating it if it doesn't exist. A file that
    /// can't be opened or holds another schema is deleted and created again.
    ///
    /// # Errors
    ///
    /// Returns an error if the directory can't be created, or the index still
    /// can't be opened after recreating the file.
    pub fn open(path: &Path) -> Result<Self, Report<SearchIndexError>> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .change_context(SearchIndexError)
                .attach_with(|| format!("failed to create {}", parent.display()))?;
        }
        let conn = connect(path).or_else(|_| {
            match std::fs::remove_file(path) {
                Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
                    return Err(Report::new(err)
                        .change_context(SearchIndexError)
                        .attach(format!("failed to delete {}", path.display())));
                }
                _ => {}
            }
            connect(path)
        })?;
        Ok(Self { conn })
    }

    /// Opens a fresh index that lives only in memory.
    ///
    /// # Errors
    ///
    /// Returns an error if SQLite can't open it or create the schema.
    pub fn open_in_memory() -> Result<Self, Report<SearchIndexError>> {
        let conn = Connection::open_in_memory()
            .change_context(SearchIndexError)
            .attach("failed to open an in-memory database")?;
        set_up(&conn)?;
        Ok(Self { conn })
    }

    /// Adds the messages written to the transcript at `path` since it was
    /// last indexed, under the agent `key`, as `read` (the agent's
    /// harness's reader) reads them from an offset and a prompt offset. A
    /// transcript shorter than what was read before was replaced, so its old
    /// messages are dropped and it is read from the start.
    ///
    /// Returns whether the index changed.
    ///
    /// # Errors
    ///
    /// Returns an error if the path isn't UTF-8, the transcript can't be read,
    /// or the index can't be read or written.
    pub fn index_transcript<F>(
        &mut self,
        key: AgentKey,
        path: &Path,
        read: F,
    ) -> Result<bool, Report<SearchIndexError>>
    where
        F: FnOnce(&Path, u64, u64) -> io::Result<MessageRead>,
    {
        let text_path = utf8(path)?;
        let (offset, prompt_offset): (u64, u64) = self
            .conn
            .query_row(
                "SELECT offset, prompt_offset FROM transcripts WHERE path = ?1",
                [text_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .change_context(SearchIndexError)
            .attach_with(|| format!("failed to read the offset of {text_path}"))?
            .unwrap_or((0, 0));
        let read = read(path, offset, prompt_offset)
            .change_context(SearchIndexError)
            .attach_with(|| format!("failed to read {text_path}"))?;
        if !read.restarted && read.offset == offset {
            return Ok(false);
        }
        let tx = self
            .conn
            .transaction()
            .change_context(SearchIndexError)
            .attach("failed to start the index transaction")?;
        if read.restarted {
            tx.execute("DELETE FROM messages WHERE path = ?1", [text_path])
                .change_context(SearchIndexError)
                .attach_with(|| format!("failed to drop the old messages of {text_path}"))?;
        }
        {
            let mut insert = tx
                .prepare(
                    "INSERT INTO messages (thread, born, path, offset, prompt_offset, role, at, text)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )
                .change_context(SearchIndexError)
                .attach("failed to prepare the message insert")?;
            for message in &read.messages {
                insert
                    .execute(params![
                        key.0.0,
                        key.1,
                        text_path,
                        message.offset,
                        message.prompt_offset,
                        role_str(message.role),
                        message.at,
                        message.text,
                    ])
                    .change_context(SearchIndexError)
                    .attach_with(|| format!("failed to add a message of {text_path}"))?;
            }
        }
        tx.execute(
            "INSERT INTO transcripts (path, thread, born, offset, prompt_offset)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET thread = excluded.thread, born = excluded.born,
               offset = excluded.offset, prompt_offset = excluded.prompt_offset",
            params![text_path, key.0.0, key.1, read.offset, read.prompt_offset],
        )
        .change_context(SearchIndexError)
        .attach_with(|| format!("failed to save the offset of {text_path}"))?;
        tx.commit()
            .change_context(SearchIndexError)
            .attach_with(|| format!("failed to commit the messages of {text_path}"))?;
        Ok(true)
    }

    /// How many bytes of the transcript at `path` are indexed, or `None` when
    /// none are.
    ///
    /// # Errors
    ///
    /// Returns an error if the path isn't UTF-8 or the index can't be read.
    pub fn transcript_offset(&self, path: &Path) -> Result<Option<u64>, Report<SearchIndexError>> {
        let text_path = utf8(path)?;
        self.conn
            .query_row(
                "SELECT offset FROM transcripts WHERE path = ?1",
                [text_path],
                |row| row.get(0),
            )
            .optional()
            .change_context(SearchIndexError)
            .attach_with(|| format!("failed to read the offset of {text_path}"))
    }

    /// Drops every message and transcript of an agent not in `live`. An agent
    /// whose id was reused has a newer `created_at`, so its old rows go too.
    ///
    /// # Errors
    ///
    /// Returns an error if the index can't be read or written.
    pub fn retain_agents(
        &mut self,
        live: &HashSet<AgentKey>,
    ) -> Result<(), Report<SearchIndexError>> {
        let gone: Vec<(i64, i64)> = {
            let mut select = self
                .conn
                .prepare(
                    "SELECT thread, born FROM messages UNION SELECT thread, born FROM transcripts",
                )
                .change_context(SearchIndexError)
                .attach("failed to prepare the agent list")?;
            let indexed = select
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .and_then(Iterator::collect::<rusqlite::Result<Vec<(i64, i64)>>>)
                .change_context(SearchIndexError)
                .attach("failed to list the indexed agents")?;
            indexed
                .into_iter()
                .filter(|&(agent, born)| !live.contains(&(AgentId(agent), born)))
                .collect()
        };
        if gone.is_empty() {
            return Ok(());
        }
        let tx = self
            .conn
            .transaction()
            .change_context(SearchIndexError)
            .attach("failed to start the retain transaction")?;
        for (agent, born) in gone {
            tx.execute(
                "DELETE FROM messages WHERE thread = ?1 AND born = ?2",
                params![agent, born],
            )
            .and_then(|_| {
                tx.execute(
                    "DELETE FROM transcripts WHERE thread = ?1 AND born = ?2",
                    params![agent, born],
                )
            })
            .change_context(SearchIndexError)
            .attach_with(|| format!("failed to drop agent {agent} born {born}"))?;
        }
        tx.commit()
            .change_context(SearchIndexError)
            .attach("failed to commit the dropped agents")
    }

    /// The messages containing every term of `text` that is 3 or more
    /// graphemes long, newest first, at most `MAX_HITS` of them. Text with no
    /// such term matches nothing.
    ///
    /// # Errors
    ///
    /// Returns an error if the index can't be read.
    pub fn query(&self, text: &str) -> Result<Hits, Report<SearchIndexError>> {
        let Some(expr) = expression(text) else {
            return Ok(Hits::default());
        };
        let mut select = self
            .conn
            .prepare(
                "SELECT m.id, m.thread, m.born, m.path, m.prompt_offset, m.role, m.at,
                        highlight(messages_fts, 0, ?2, ?3)
                 FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
                 WHERE messages_fts MATCH ?1
                 ORDER BY m.at DESC, m.id DESC
                 LIMIT ?4",
            )
            .change_context(SearchIndexError)
            .attach("failed to prepare the query")?;
        let mut hits = select
            .query_map(
                params![expr, OPEN.to_string(), CLOSE.to_string(), MAX_HITS + 1],
                |row| {
                    let (text, lit) = unmark(&row.get::<_, String>(7)?);
                    Ok(Hit {
                        id: row.get(0)?,
                        agent: AgentId(row.get(1)?),
                        born: row.get(2)?,
                        path: PathBuf::from(row.get::<_, String>(3)?),
                        prompt_offset: row.get(4)?,
                        role: role(&row.get::<_, String>(5)?),
                        at: row.get(6)?,
                        text,
                        lit,
                    })
                },
            )
            .and_then(Iterator::collect::<rusqlite::Result<Vec<Hit>>>)
            .change_context(SearchIndexError)
            .attach_with(|| format!("failed to run the query {expr}"))?;
        let overflow = hits.len() > MAX_HITS;
        hits.truncate(MAX_HITS);
        Ok(Hits { hits, overflow })
    }

    /// Every indexed message of the exchange opened by the prompt at
    /// `prompt_offset` in the transcript at `path`, as `(id, role, text)` in
    /// transcript order.
    ///
    /// # Errors
    ///
    /// Returns an error if the path isn't UTF-8 or the index can't be read.
    pub fn exchange(
        &self,
        path: &Path,
        prompt_offset: u64,
    ) -> Result<Vec<(i64, Role, String)>, Report<SearchIndexError>> {
        let text_path = utf8(path)?;
        let mut select = self
            .conn
            .prepare(
                "SELECT id, role, text FROM messages
                 WHERE path = ?1 AND prompt_offset = ?2
                 ORDER BY offset",
            )
            .change_context(SearchIndexError)
            .attach("failed to prepare the exchange")?;
        select
            .query_map(params![text_path, prompt_offset], |row| {
                Ok((row.get(0)?, role(&row.get::<_, String>(1)?), row.get(2)?))
            })
            .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
            .change_context(SearchIndexError)
            .attach_with(|| {
                format!("failed to read the exchange at {prompt_offset} of {text_path}")
            })
    }
}

/// The one-line snippet of `text` around its first lit grapheme, and `lit`
/// moved into it.
///
/// The snippet keeps up to 40 graphemes before the first hit and 200 from it
/// on, turns line breaks and runs of whitespace into one space, and starts
/// with `…` when text before it was cut. `lit` holds the byte offsets of lit
/// graphemes in `text`, as [`SearchIndex::query`] gives them.
#[must_use]
pub fn snippet(text: &str, lit: &[usize]) -> (String, Vec<usize>) {
    let first = text
        .grapheme_indices(true)
        .position(|(at, _)| lit.contains(&at))
        .unwrap_or(0);
    let start = first.saturating_sub(SNIPPET_BEFORE);
    let mut out = match start {
        0 => String::new(),
        _ => "…".to_owned(),
    };
    let lead = out.len();
    let mut moved = Vec::new();
    let mut space = false;
    for (at, grapheme) in text
        .grapheme_indices(true)
        .skip(start)
        .take(first + SNIPPET_AFTER - start)
    {
        if grapheme.trim().is_empty() {
            space = true;
            continue;
        }
        if space && out.len() > lead {
            out.push(' ');
        }
        space = false;
        if lit.contains(&at) {
            moved.push(out.len());
        }
        out.push_str(grapheme);
    }
    (out, moved)
}

/// The FTS expression for typed `text`: each whitespace-separated term of 3
/// or more graphemes, quoted so FTS syntax in it is taken literally, all of
/// them required. `None` when no term is long enough.
fn expression(text: &str) -> Option<String> {
    let terms: Vec<String> = text
        .split_whitespace()
        .filter(|term| term.graphemes(true).count() >= 3)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

/// `marked` without the `OPEN`/`CLOSE` markers, and the byte offsets in it of
/// every grapheme that started between a pair.
// ponytail: a message that itself contains U+E000/U+E001 mis-highlights;
// switch to FTS5 `offsets()` if that ever shows up.
fn unmark(marked: &str) -> (String, Vec<usize>) {
    let mut text = String::with_capacity(marked.len());
    let mut ranges: Vec<Range<usize>> = Vec::new();
    for (i, part) in marked.split(OPEN).enumerate() {
        let (lit, rest) = match i {
            0 => ("", part),
            _ => part.split_once(CLOSE).unwrap_or((part, "")),
        };
        let start = text.len();
        text.push_str(lit);
        ranges.push(start..text.len());
        text.push_str(rest);
    }
    let lit = text
        .grapheme_indices(true)
        .map(|(at, _)| at)
        .filter(|at| ranges.iter().any(|range| range.contains(at)))
        .collect();
    (text, lit)
}

/// How a role is stored in `messages.role`.
fn role_str(role: Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

/// The role stored as `role_str` wrote it.
fn role(stored: &str) -> Role {
    match stored {
        "user" => Role::User,
        _ => Role::Assistant,
    }
}

fn utf8(path: &Path) -> Result<&str, Report<SearchIndexError>> {
    path.to_str().ok_or_else(|| {
        Report::new(SearchIndexError).attach(format!("the path {} isn't UTF-8", path.display()))
    })
}

fn connect(path: &Path) -> Result<Connection, Report<SearchIndexError>> {
    let conn = Connection::open(path)
        .change_context(SearchIndexError)
        .attach_with(|| format!("failed to open {}", path.display()))?;
    set_up(&conn)?;
    Ok(conn)
}

/// Creates the schema in an empty database, and accepts one already at
/// `SCHEMA`.
fn set_up(conn: &Connection) -> Result<(), Report<SearchIndexError>> {
    let version: i32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .change_context(SearchIndexError)
        .attach("failed to read the schema version")?;
    match version {
        SCHEMA => Ok(()),
        0 => {
            let tx = conn
                .unchecked_transaction()
                .change_context(SearchIndexError)
                .attach("failed to start the schema transaction")?;
            tx.execute_batch(SCHEMA_SQL)
                .change_context(SearchIndexError)
                .attach("failed to create the schema")?;
            tx.pragma_update(None, "user_version", SCHEMA)
                .change_context(SearchIndexError)
                .attach("failed to save the schema version")?;
            tx.commit()
                .change_context(SearchIndexError)
                .attach("failed to commit the schema")
        }
        other => Err(Report::new(SearchIndexError)
            .attach(format!("schema version {other}, this orb builds {SCHEMA}"))),
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate index failures with `?` and assert on the outcome"
)]
mod tests {
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};

    use error_stack::{Report, ResultExt};
    use rusqlite::Connection;
    use serde_json::json;
    use tempfile::tempdir;

    use super::{AgentKey, SCHEMA, SearchIndex, SearchIndexError, snippet};
    use crate::feat::harness::claude::transcript::read_messages;
    use crate::feat::sessions::transcript::Role;
    use crate::ids::AgentId;

    const KEY: AgentKey = (AgentId(1), 1_000);

    /// The `timestamp` of a line written `second` seconds into 2026.
    fn stamp(second: u32) -> String {
        format!("2026-01-01T00:{:02}:{:02}Z", second / 60, second % 60)
    }

    /// A prompt line the user typed.
    fn prompt(text: &str, second: u32) -> String {
        json!({"type": "user", "timestamp": stamp(second), "message": {"content": text}})
            .to_string()
    }

    /// An assistant line with one text block per entry of `blocks`.
    fn reply(blocks: &[&str], second: u32) -> String {
        let content: Vec<_> = blocks
            .iter()
            .map(|text| json!({"type": "text", "text": text}))
            .collect();
        json!({"type": "assistant", "timestamp": stamp(second), "message": {"content": content}})
            .to_string()
    }

    /// Writes `lines`, each ended by a newline, to `name` in `dir`.
    fn write(
        dir: &Path,
        name: &str,
        lines: &[String],
    ) -> Result<PathBuf, Report<SearchIndexError>> {
        let path = dir.join(name);
        let text = format!("{}\n", lines.join("\n"));
        std::fs::write(&path, text).change_context(SearchIndexError)?;
        Ok(path)
    }

    /// An in-memory index holding one transcript of `lines` under `KEY`.
    fn indexed(lines: &[String]) -> Result<SearchIndex, Report<SearchIndexError>> {
        let dir = tempdir().change_context(SearchIndexError)?;
        let path = write(dir.path(), "transcript.jsonl", lines)?;
        let mut index = SearchIndex::open_in_memory()?;
        index.index_transcript(KEY, &path, read_messages)?;
        Ok(index)
    }

    /// The text of every message `query` finds, in result order.
    fn found(index: &SearchIndex, query: &str) -> Result<Vec<String>, Report<SearchIndexError>> {
        Ok(index
            .query(query)?
            .hits
            .into_iter()
            .map(|hit| hit.text)
            .collect())
    }

    /// The `user_version` saved in the file at `path`.
    fn schema_of(path: &Path) -> Result<i32, Report<SearchIndexError>> {
        Connection::open(path)
            .and_then(|conn| conn.pragma_query_value(None, "user_version", |row| row.get(0)))
            .change_context(SearchIndexError)
    }

    #[rstest::rstest]
    fn open_recreates_an_unopenable_file() -> Result<(), Report<SearchIndexError>> {
        // Given a search.sqlite file holding garbage bytes, and a transcript.
        let dir = tempdir().change_context(SearchIndexError)?;
        let path = dir.path().join("search.sqlite");
        std::fs::write(&path, b"not a database at all, just bytes")
            .change_context(SearchIndexError)?;
        let transcript = dir.path().join("transcript.jsonl");
        std::fs::write(
            &transcript,
            format!(
                "{}\n",
                json!({"type": "user", "message": {"content": "hello index"}})
            ),
        )
        .change_context(SearchIndexError)?;

        // When opening the index there and indexing the transcript.
        let indexed = SearchIndex::open(&path)?.index_transcript(
            (AgentId(1), 1_000),
            &transcript,
            read_messages,
        )?;

        // Then the recreated file is at this build's schema and takes the transcript.
        assert!(
            indexed && schema_of(&path)? == SCHEMA,
            "an unopenable file should be replaced by a fresh index that indexes"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn open_recreates_a_file_from_another_schema() -> Result<(), Report<SearchIndexError>> {
        // Given a search.sqlite file from schema version 99.
        let dir = tempdir().change_context(SearchIndexError)?;
        let path = dir.path().join("search.sqlite");
        Connection::open(&path)
            .and_then(|conn| conn.pragma_update(None, "user_version", 99))
            .change_context(SearchIndexError)?;

        // When opening the index there.
        SearchIndex::open(&path)?;

        // Then the file is back at this build's schema.
        assert_eq!(
            schema_of(&path)?,
            SCHEMA,
            "another schema should be rebuilt"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn typed_prompt_is_found_by_its_text() -> Result<(), Report<SearchIndexError>> {
        // Given a transcript with a typed prompt.
        let index = indexed(&[prompt("Fix the parser", 1)])?;

        // When querying a word of it.
        let texts = found(&index, "parser")?;

        // Then the prompt is found.
        assert_eq!(
            texts,
            ["Fix the parser"],
            "a typed prompt should be indexed"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn assistant_text_block_is_found_by_its_text() -> Result<(), Report<SearchIndexError>> {
        // Given a transcript with a reply text block.
        let index = indexed(&[prompt("Fix it", 1), reply(&["Patched the lexer"], 2)])?;

        // When querying a word of the reply.
        let texts = found(&index, "lexer")?;

        // Then the reply block is found.
        assert_eq!(
            texts,
            ["Patched the lexer"],
            "a reply text block should be indexed"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[case::tool_use(
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"grep needle"}}]}}"#
    )]
    #[case::tool_result(
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"needle found"}]}}"#
    )]
    #[case::meta_prompt(
        r#"{"type":"user","isMeta":true,"message":{"content":"needle skill body"}}"#
    )]
    #[case::sidechain_reply(
        r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"needle here"}]}}"#
    )]
    #[case::thinking_block(
        r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"needle thought"}]}}"#
    )]
    fn non_message_lines_are_not_indexed(
        #[case] line: &str,
    ) -> Result<(), Report<SearchIndexError>> {
        // Given a transcript holding only a line that isn't a message.
        let index = indexed(&[line.to_owned()])?;

        // When querying a word in it.
        let texts = found(&index, "needle")?;

        // Then nothing is found.
        assert!(texts.is_empty(), "a non-message line should not be indexed");
        Ok(())
    }

    #[rstest::rstest]
    #[case::command("<command-name>/plan</command-name>", "command-name")]
    #[case::interrupted("[Request interrupted by user]", "interrupted")]
    fn command_and_interrupt_prompts_are_not_indexed(
        #[case] content: &str,
        #[case] query: &str,
    ) -> Result<(), Report<SearchIndexError>> {
        // Given a transcript holding only a command or interruption user line.
        let index = indexed(&[prompt(content, 1)])?;

        // When querying a word in it.
        let texts = found(&index, query)?;

        // Then nothing is found.
        assert!(
            texts.is_empty(),
            "commands and interruptions should not be indexed"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn unfinished_last_line_is_not_indexed() -> Result<(), Report<SearchIndexError>> {
        // Given a transcript whose last line has no newline yet.
        let dir = tempdir().change_context(SearchIndexError)?;
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(
            &path,
            format!("{}\n{}", prompt("Fix it", 1), reply(&["Still typing"], 2)),
        )
        .change_context(SearchIndexError)?;
        let mut index = SearchIndex::open_in_memory()?;

        // When indexing it.
        index.index_transcript(KEY, &path, read_messages)?;

        // Then the unfinished line isn't found.
        assert!(
            found(&index, "typing")?.is_empty(),
            "a line still being written should not be indexed"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn indexing_again_adds_no_duplicate_rows() -> Result<(), Report<SearchIndexError>> {
        // Given an indexed transcript.
        let dir = tempdir().change_context(SearchIndexError)?;
        let path = write(
            dir.path(),
            "transcript.jsonl",
            &[prompt("Fix the parser", 1)],
        )?;
        let mut index = SearchIndex::open_in_memory()?;
        index.index_transcript(KEY, &path, read_messages)?;

        // When indexing it again unchanged.
        index.index_transcript(KEY, &path, read_messages)?;

        // Then its prompt is found once.
        assert_eq!(
            found(&index, "parser")?,
            ["Fix the parser"],
            "indexing from the saved offset should add nothing"
        );
        Ok(())
    }

    /// An index of a long transcript that was then replaced by a shorter one
    /// and indexed again.
    fn replaced() -> Result<SearchIndex, Report<SearchIndexError>> {
        let dir = tempdir().change_context(SearchIndexError)?;
        let path = write(
            dir.path(),
            "transcript.jsonl",
            &[
                prompt("Fix the old parser", 1),
                reply(&["Patched the old parser at length"], 2),
            ],
        )?;
        let mut index = SearchIndex::open_in_memory()?;
        index.index_transcript(KEY, &path, read_messages)?;
        write(dir.path(), "transcript.jsonl", &[prompt("Lint", 3)])?;
        index.index_transcript(KEY, &path, read_messages)?;
        Ok(index)
    }

    #[rstest::rstest]
    fn replaced_transcript_loses_its_old_rows() -> Result<(), Report<SearchIndexError>> {
        // Given a transcript replaced by a shorter one and indexed again.
        let index = replaced()?;

        // When querying the old text.
        let texts = found(&index, "parser")?;

        // Then the old messages are gone.
        assert!(
            texts.is_empty(),
            "a replaced transcript's old rows should be dropped"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn replaced_transcript_indexes_its_new_text() -> Result<(), Report<SearchIndexError>> {
        // Given a transcript replaced by a shorter one and indexed again.
        let index = replaced()?;

        // When querying the new text.
        let texts = found(&index, "Lint")?;

        // Then the new prompt is found.
        assert_eq!(
            texts,
            ["Lint"],
            "a replaced transcript's new text should be indexed"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn retain_agents_drops_a_missing_agents_rows() -> Result<(), Report<SearchIndexError>> {
        // Given two agents' transcripts indexed.
        let dir = tempdir().change_context(SearchIndexError)?;
        let kept = write(dir.path(), "kept.jsonl", &[prompt("Fix the parser", 1)])?;
        let gone = write(dir.path(), "gone.jsonl", &[prompt("Fix the lexer", 2)])?;
        let mut index = SearchIndex::open_in_memory()?;
        index.index_transcript(KEY, &kept, read_messages)?;
        index.index_transcript((AgentId(2), 2_000), &gone, read_messages)?;

        // When retaining only the first agent.
        index.retain_agents(&HashSet::from([KEY]))?;

        // Then the second agent's messages are gone.
        assert!(
            found(&index, "lexer")?.is_empty(),
            "an agent missing from the live set should lose its rows"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn retain_agents_drops_rows_of_a_reused_agent_id() -> Result<(), Report<SearchIndexError>> {
        // Given an agent's transcript indexed.
        let mut index = indexed(&[prompt("Fix the parser", 1)])?;

        // When retaining an agent with the same id but a newer created_at.
        index.retain_agents(&HashSet::from([(KEY.0, KEY.1 + 1)]))?;

        // Then the old agent's messages are gone.
        assert!(
            found(&index, "parser")?.is_empty(),
            "a reused agent id should not keep the old agent's rows"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn query_matches_inside_a_word() -> Result<(), Report<SearchIndexError>> {
        // Given a prompt mentioning IntentHandler.
        let index = indexed(&[prompt("Wire the IntentHandler", 1)])?;

        // When querying part of the word.
        let texts = found(&index, "Handler")?;

        // Then the prompt is found.
        assert_eq!(
            texts,
            ["Wire the IntentHandler"],
            "a substring should match"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn query_ignores_case() -> Result<(), Report<SearchIndexError>> {
        // Given a lowercase prompt.
        let index = indexed(&[prompt("fix the parser", 1)])?;

        // When querying in uppercase.
        let texts = found(&index, "PARSER")?;

        // Then the prompt is found.
        assert_eq!(texts, ["fix the parser"], "matching should ignore case");
        Ok(())
    }

    #[rstest::rstest]
    fn query_requires_every_term() -> Result<(), Report<SearchIndexError>> {
        // Given a prompt with only one of two terms.
        let index = indexed(&[prompt("Fix the parser", 1)])?;

        // When querying both terms.
        let texts = found(&index, "parser lexer")?;

        // Then nothing is found.
        assert!(texts.is_empty(), "every term should have to match");
        Ok(())
    }

    #[rstest::rstest]
    fn query_ignores_a_term_under_three_graphemes() -> Result<(), Report<SearchIndexError>> {
        // Given a prompt.
        let index = indexed(&[prompt("Fix the parser", 1)])?;

        // When querying a matching term beside a short one it lacks.
        let texts = found(&index, "zz parser")?;

        // Then the prompt is still found.
        assert_eq!(
            texts,
            ["Fix the parser"],
            "a term under 3 graphemes should be ignored"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn query_of_only_short_terms_returns_nothing() -> Result<(), Report<SearchIndexError>> {
        // Given a prompt containing the short terms.
        let index = indexed(&[prompt("Fix it", 1)])?;

        // When querying only terms under 3 graphemes.
        let texts = found(&index, "Fi it")?;

        // Then nothing is found.
        assert!(texts.is_empty(), "only short terms should match nothing");
        Ok(())
    }

    #[rstest::rstest]
    #[case::quote(r#"foo"bar"#)]
    #[case::star("foo*bar")]
    #[case::minus("foo-bar")]
    #[case::colon("foo:bar")]
    fn query_matches_fts_syntax_characters_literally(
        #[case] term: &str,
    ) -> Result<(), Report<SearchIndexError>> {
        // Given a prompt containing the term, and one with its letters only.
        let text = format!("call {term} now");
        let index = indexed(&[prompt(&text, 1), prompt("call foo bar now", 2)])?;

        // When querying the term.
        let texts = found(&index, term)?;

        // Then only the literal match is found.
        assert_eq!(
            texts,
            [text],
            "FTS syntax in a query should match literally"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn query_lists_the_newest_message_first() -> Result<(), Report<SearchIndexError>> {
        // Given a newer message indexed before an older one.
        let dir = tempdir().change_context(SearchIndexError)?;
        let newer = write(dir.path(), "newer.jsonl", &[prompt("newer parser", 9)])?;
        let older = write(dir.path(), "older.jsonl", &[prompt("older parser", 1)])?;
        let mut index = SearchIndex::open_in_memory()?;
        index.index_transcript(KEY, &newer, read_messages)?;
        index.index_transcript((AgentId(2), 2_000), &older, read_messages)?;

        // When querying both.
        let texts = found(&index, "parser")?;

        // Then the newer one comes first.
        assert_eq!(
            texts,
            ["newer parser", "older parser"],
            "newest should come first"
        );
        Ok(())
    }

    /// An index of 250 prompts that all contain `needle`.
    fn crowded() -> Result<SearchIndex, Report<SearchIndexError>> {
        let lines: Vec<String> = (0..250)
            .map(|n| prompt(&format!("needle {n}"), n))
            .collect();
        indexed(&lines)
    }

    #[rstest::rstest]
    fn query_caps_rows_at_200() -> Result<(), Report<SearchIndexError>> {
        // Given 250 matching messages.
        let index = crowded()?;

        // When querying them.
        let hits = index.query("needle")?;

        // Then 200 rows come back.
        assert_eq!(hits.hits.len(), 200, "rows should be capped at 200");
        Ok(())
    }

    #[rstest::rstest]
    fn query_flags_overflow_past_200() -> Result<(), Report<SearchIndexError>> {
        // Given 250 matching messages.
        let index = crowded()?;

        // When querying them.
        let hits = index.query("needle")?;

        // Then the result says more matched.
        assert!(hits.overflow, "more than 200 matches should set overflow");
        Ok(())
    }

    #[rstest::rstest]
    fn query_lights_the_matched_graphemes() -> Result<(), Report<SearchIndexError>> {
        // Given a prompt with a multi-byte grapheme before the match.
        let index = indexed(&[prompt("Café IntentHandler", 1)])?;

        // When querying part of it.
        let lit: Vec<Vec<usize>> = index
            .query("handler")?
            .hits
            .into_iter()
            .map(|hit| hit.lit)
            .collect();

        // Then the lit offsets are the bytes where "Handler"'s graphemes start.
        assert_eq!(
            lit,
            [(12..19).collect::<Vec<usize>>()],
            "highlights should point at the matched graphemes"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn exchange_lists_the_prompt_then_every_reply_block() -> Result<(), Report<SearchIndexError>> {
        // Given two exchanges, the first with a tool call between two reply blocks.
        let index = indexed(&[
            prompt("Fix the parser", 1),
            reply(&["Looking now"], 2),
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#
                .to_owned(),
            reply(&["Fixed it"], 3),
            prompt("Now add tests", 4),
        ])?;
        let hit = index
            .query("Fixed")?
            .hits
            .into_iter()
            .next()
            .ok_or_else(|| Report::new(SearchIndexError).attach("no hit for Fixed"))?;

        // When reading the exchange of the reply hit.
        let messages: Vec<(Role, String)> = index
            .exchange(&hit.path, hit.prompt_offset)?
            .into_iter()
            .map(|(_, role, text)| (role, text))
            .collect();

        // Then it holds its prompt then each reply block, in order.
        assert_eq!(
            messages,
            [
                (Role::User, "Fix the parser".to_owned()),
                (Role::Assistant, "Looking now".to_owned()),
                (Role::Assistant, "Fixed it".to_owned()),
            ],
            "the exchange should be the prompt then its reply blocks"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn snippet_cuts_40_graphemes_before_the_first_hit() {
        // Given a hit 100 graphemes into the text.
        let text = format!("{}needle", "a".repeat(100));
        let lit: Vec<usize> = (100..106).collect();

        // When building its snippet.
        let (cut, _) = snippet(&text, &lit);

        // Then it keeps 40 graphemes before the hit, after an ellipsis.
        assert_eq!(
            cut,
            format!("…{}needle", "a".repeat(40)),
            "the snippet should start 40 graphemes before the hit"
        );
    }

    #[rstest::rstest]
    fn snippet_keeps_200_graphemes_from_the_first_hit() {
        // Given a hit at the start of a long text.
        let text = format!("needle{}", "b".repeat(300));
        let lit: Vec<usize> = (0..6).collect();

        // When building its snippet.
        let (cut, _) = snippet(&text, &lit);

        // Then it ends 200 graphemes from the hit.
        assert_eq!(
            cut,
            format!("needle{}", "b".repeat(194)),
            "the snippet should keep 200 graphemes from the hit"
        );
    }

    #[rstest::rstest]
    fn snippet_collapses_whitespace_runs() {
        // Given text with line breaks, tabs and runs of spaces.
        let text = "  fix\n\n  the\tparser \n";

        // When building its snippet.
        let (cut, _) = snippet(text, &[]);

        // Then each run is one space and the ends are trimmed.
        assert_eq!(
            cut, "fix the parser",
            "whitespace runs should collapse to one space"
        );
    }

    #[rstest::rstest]
    fn snippet_moves_hit_offsets_with_the_text() {
        // Given a hit after 50 graphemes and a whitespace run.
        let text = format!("{}  \nneedle", "a".repeat(50));
        let lit: Vec<usize> = (53..59).collect();

        // When building its snippet.
        let (_, moved) = snippet(&text, &lit);

        // Then the offsets point at "needle" after the ellipsis, 37 a's and one space.
        assert_eq!(
            moved,
            (41..47).collect::<Vec<usize>>(),
            "lit offsets should follow the text into the snippet"
        );
    }
}
