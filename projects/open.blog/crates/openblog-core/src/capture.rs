//! The bounds and stored formats of a job capture made on a phone (ADRs 0296 to 0298). Pure: no file, clock
//! or network.
//!
//! Admin's Capture view reads these numbers from `GET /admin/api/meta` (`capture`), so the phone, the queue
//! on the phone and the server agree on one set of limits.

use serde_json::{json, Value};

/// Most photos one capture may carry.
pub const MAX_PHOTOS: usize = 12;
/// Most characters in the notes of one capture.
pub const MAX_NOTES_CHARS: usize = 8_000;
/// Longest a capture's voice note may run, in seconds.
pub const MAX_AUDIO_SECONDS: u32 = 180;
/// Most bytes a capture's voice note may hold. A recorder's own clock cannot be trusted, so this is the real bound.
pub const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;
/// The audio containers a browser's recorder produces, by the extension a stored note gets.
pub const AUDIO_EXTENSIONS: &[&str] = &["webm", "ogg", "m4a", "wav", "mp3"];

/// Version of the record the phone keeps for a waiting capture, and of the server's ledger entry.
pub const STORED_VERSION: u32 = 1;
/// Most captures a device keeps waiting to be sent.
pub const MAX_QUEUED: usize = 5;
/// Most bytes one waiting capture may hold (photos and any voice note).
pub const MAX_CAPTURE_BYTES: u64 = 60 * 1024 * 1024;
/// Most bytes the whole waiting queue may hold.
pub const MAX_QUEUE_BYTES: u64 = 120 * 1024 * 1024;

const ID_LEN: usize = 32;

/// A capture id: 32 lowercase hex digits, made on the phone. It names files and ledger entries, so nothing else is accepted.
pub fn valid_id(id: &str) -> bool {
    id.len() == ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The stored name (without extension) of a capture's photo, so sending the same photo again lands on the same file.
pub fn photo_stem(id: &str, slot: usize) -> Option<String> {
    (valid_id(id) && slot < MAX_PHOTOS).then(|| format!("capture-{}-{slot}", &id[..12]))
}

/// What the server keeps once a capture has become a draft, so a replay finds it. `audio` names the private
/// voice note stored with it, if there is one; readers of version 1 ignore keys they do not know.
pub fn ledger_text(path: &str, audio: Option<&str>) -> String {
    match audio {
        Some(audio) => json!({ "v": STORED_VERSION, "path": path, "audio": audio }),
        None => json!({ "v": STORED_VERSION, "path": path }),
    }
    .to_string()
}

/// The audio container, judged by the bytes and never by what the client claims.
pub fn sniff_audio(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some("webm")
    } else if bytes.starts_with(b"OggS") {
        Some("ogg")
    } else if bytes.len() > 12 && &bytes[4..8] == b"ftyp" {
        Some("m4a")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        Some("wav")
    } else if bytes.starts_with(b"ID3")
        || (bytes.len() > 2 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0)
    {
        Some("mp3")
    } else {
        None
    }
}

/// The stored name of a capture's voice note, beside its ledger entry and never under the published static folder.
pub fn audio_file_name(id: &str, extension: &str) -> Option<String> {
    (valid_id(id) && AUDIO_EXTENSIONS.contains(&extension))
        .then(|| format!("{id}.audio.{extension}"))
}

/// Most characters a transcript keeps. It is the notes bound's neighbour: a ninety second description is a few
/// hundred words, and anything longer is cut rather than refused.
pub const MAX_TRANSCRIPT_CHARS: usize = 20_000;

/// The stored name of a capture's transcript, beside its voice note.
pub fn transcript_file_name(id: &str) -> Option<String> {
    valid_id(id).then(|| format!("{id}.transcript.txt"))
}

/// A transcript made safe to keep and show (ADR 0302). It is untrusted words: control characters and
/// byte-order marks go, line endings are normalized, runs of blank lines collapse, and the text is bounded.
/// Nothing is interpreted: markup stays text, and the author's editor escapes it like any typed note.
/// `truncated` says the text was cut at the bound.
pub fn clean_transcript(raw: &str) -> (String, bool) {
    let mut text = String::new();
    let mut blank_run = 0;
    for line in raw.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        let line: String = line
            .chars()
            .filter(|c| !c.is_control() && *c != '\u{feff}' && *c != '\u{2028}' && *c != '\u{2029}')
            .collect();
        let line = line.trim();
        if line.is_empty() {
            blank_run += 1;
            continue;
        }
        if !text.is_empty() {
            text.push_str(if blank_run > 0 { "\n\n" } else { "\n" });
        }
        blank_run = 0;
        text.push_str(line);
    }
    let truncated = text.chars().count() > MAX_TRANSCRIPT_CHARS;
    if truncated {
        text = text.chars().take(MAX_TRANSCRIPT_CHARS).collect();
        text.truncate(text.trim_end().len());
    }
    (text, truncated)
}

/// The draft path a ledger entry names. An entry written by a newer version is an error, never guessed at.
pub fn parse_ledger(text: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| "The capture ledger entry is unreadable".to_string())?;
    if value["v"] != STORED_VERSION {
        return Err("The capture ledger entry was written by another version of open.blog".into());
    }
    value["path"]
        .as_str()
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "The capture ledger entry has no path".to_string())
}

/// The limits Admin's Capture view works to. `max_photo_mb` is the site's own `admin.maxUploadMb`.
pub fn limits_json(max_photo_mb: u32) -> Value {
    json!({
        "maxPhotos": MAX_PHOTOS,
        "maxNotesChars": MAX_NOTES_CHARS,
        "maxPhotoBytes": max_photo_mb as u64 * 1024 * 1024,
        "maxAudioSeconds": MAX_AUDIO_SECONDS,
        "maxAudioBytes": MAX_AUDIO_BYTES,
        "maxTranscriptChars": MAX_TRANSCRIPT_CHARS,
        "storedVersion": STORED_VERSION,
        "maxQueued": MAX_QUEUED,
        "maxCaptureBytes": MAX_CAPTURE_BYTES,
        "maxQueueBytes": MAX_QUEUE_BYTES,
    })
}
