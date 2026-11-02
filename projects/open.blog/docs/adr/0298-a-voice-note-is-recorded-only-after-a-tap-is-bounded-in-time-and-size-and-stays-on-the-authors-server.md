# ADR 0295: A voice note is recorded only after a tap, is bounded in time and size, and stays on the author's server

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#479](https://github.com/journey-to-code-org/open.blog/issues/479)
- Task: [#501](https://github.com/journey-to-code-org/open.blog/issues/501)
- Builds on: [ADR 0293](0296-a-capture-is-a-job-draft-started-from-a-phone-built-from-the-job-forms-own-keys.md), [ADR 0294](0297-a-capture-waits-in-a-bounded-versioned-queue-on-the-phone-and-is-sent-with-its-id-as-an-idempotency-key.md)

## Context

Talking is faster than typing on a roof. The browser's `MediaRecorder` can record, but a microphone is
sensitive: it must never open by surprise, never run unbounded, and the recording must not leave the author's
control. Epic TRADE2's rule is that audio stays on the author's device or server and that anything that
reaches an AI provider does so only through the Assistant boundary, explicitly and with disclosure. Drafting
from a recording is a later story; this one only captures.

## Decision

- **Feature-detected, permission-gated, gesture-gated.** The **Record a voice note** control exists only when
  the browser has `MediaRecorder`, `getUserMedia` and a type it can record (`audio/webm;codecs=opus`,
  `audio/webm`, `audio/mp4`, `audio/ogg;codecs=opus`, in that order). Otherwise the view says the browser cannot
  record and offers typing; nothing else changes. `start` requires a **trusted event** (`isTrusted`), so a
  script, a synthetic click or page load can never open the microphone, and the permission prompt is asked only
  by that tap. A refusal is explained in a sentence and leaves nothing recording.
- **Bounded in time and size.** A note is at most **180 seconds** (a timer in the view stops it) and
  **8 MB** (`openblog_core::capture::MAX_AUDIO_BYTES`). The recorder asks for one-second slices and counts bytes
  as they arrive; a slice that would pass the limit is not kept, the recording stops, and the note keeps only
  whole slices so it still plays. The server enforces the size again: the upload preflight limits the body to
  8 MB before it is buffered, and the handler checks it. The time limit is the phone's; the byte limit is what
  the server can verify.
- **A clear stop and a clear discard.** **Stop recording** keeps the note and shows a player; **Discard** throws
  a recording in progress away; **Discard voice note** removes a finished one. Saving while a recording runs
  stops and keeps it. Leaving the view, closing the page or discarding releases the microphone.
- **Kept in memory until sent.** A recording is a `Blob` in the page until the capture is saved; it is then part
  of the capture queue record (`audio: { type, size, seconds, blob }`, ADR 0294's format) and counts toward its
  byte bounds. Nothing is written to `localStorage`.
- **Stored privately on the server.** `POST /admin/api/capture-audio?capture=<id>` checks the bytes (not the
  client's claim; WebM, Ogg, MP4/M4A, WAV or MP3) and keeps the note at
  `.openblog/captures/<id>.audio.<ext>`, beside the capture's ledger entry. That folder is never under the
  static folder, so no build, feed, archive or portable export can publish it, and it is not in the draft's
  Markdown or front matter. The same id keeps its first note and answers `200` with `"duplicate": true`. When
  the draft is created, its ledger entry names the note, which is how a later feature finds it.
- **Attached to the draft by id.** "Attached" means keyed by the capture id the draft was made from; the draft
  stays an ordinary post (ADR 0285).
- **No transcription, no provider.** Nothing in this story transcribes, uploads to a third party or contacts
  the Assistant. A future feature that sends a note or its transcript to a provider must go through the
  Assistant provider boundary with its own preview and consent.

## Considered options

- **Hold to record.** Rejected: hard with gloves and on a roof; a tap to start and a tap to stop is easier.
- **Putting the note in `static/` so the post can link it.** Rejected: that publishes the author's voice by
  default. A published audio embed is a separate, deliberate feature.
- **Letting the server measure duration.** Rejected: it would need to parse every container; the byte bound
  already makes the cost finite, and the phone enforces the minutes.

## Consequences

- A refused or unsupported microphone costs the author nothing but the choice to type.
- A voice note is private, sized and findable by capture id; the next story can read it server-side.
- The note's playback address is a local `blob:` URL; nothing serves the stored file back yet.
