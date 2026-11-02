# ADR 0302: Transcription is a separate, confirmed call through the provider boundary that sends only the recording and returns untrusted text

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#480](https://github.com/journey-to-code-org/open.blog/issues/480)
- Task: [#502](https://github.com/journey-to-code-org/open.blog/issues/502)
- Builds on: [ADR 0298](0298-a-voice-note-is-recorded-only-after-a-tap-is-bounded-in-time-and-size-and-stays-on-the-authors-server.md), [ADR 0278](0278-voice-samples-and-the-voice-guide-are-selected-as-assistant-context-by-id-and-reloaded-on-the-server.md)

## Context

A voice note is private and stays on the author's server (ADR 0298). Turning it into words means sending audio
somewhere, which is the most sensitive thing the Assistant could be asked to carry. Epic TRADE2 requires that
this goes only through the Assistant provider boundary (or a local engine), explicitly, with disclosure, and that
a site without a provider still completes the flow with typed notes.

## Decision

- **Its own call, not part of drafting.** `POST /admin/api/assistant/transcribe` takes `{ captureId, confirmed: true }`
  and returns words. Drafting (ADR 0303) is a second call that never sees audio. The author can transcribe and
  not draft, or type and draft.
- **The audio is the only thing sent.** No notes, photos, title, context or voice guide travel with a recording.
  `GET /admin/api/assistant/transcribe[?capture=<id>]` returns the disclosure: the engine, its destination and
  model, whether the recording leaves the server, what is sent, and what is kept. It reads configuration and the
  stored note's size and contacts nothing. The Capture view shows it, and sends only when the author taps
  **Send the recording**. A request without `confirmed: true` is refused with `400` before the note is read.
- **Only providers that take audio.** OpenAI (`/v1/audio/transcriptions`, model `gpt-4o-mini-transcribe`, because
  the site's configured model is a text model) and Gemini (`generateContent` with inline audio, the configured
  model). Every other provider kind, including the custom endpoint, is never sent audio: the disclosure says so
  and the view says "Type your notes instead".
- **An optional local engine.** The server's owner may set `OPENBLOG_TRANSCRIBE_COMMAND` to a JSON array (the
  program, then fixed arguments). The audio file's path is appended; the transcript is read from stdout. It runs
  without a shell and without the server's environment (only `PATH` and the few variables a program needs to
  start, never an API key), with no input, a bounded output and a deadline, and is preferred when configured
  because nothing leaves the server. It is an environment setting, not site configuration, so content in a
  repository can never name a program to run.
- **Same seams as every Assistant route.** It is an authenticated, CSRF-protected Admin route with the ordinary
  JSON body bound; the call takes a permit from the shared concurrency limit, uses the provider timeout, reads
  the reply with a byte limit, and maps failures to the same safe messages as review (no credential, no provider
  body). A missing provider is `404 not-configured`, a missing key `503`, an empty transcript `422`; nothing is
  stored on a failure.
- **The transcript is untrusted text.** The core cleans it (`capture::clean_transcript`: control characters and
  byte-order marks removed, line endings normalized, blank runs collapsed, at most 20,000 characters) and keeps it
  privately at `.openblog/captures/<id>.transcript.txt`, beside the note and never under the static folder. It is
  never interpreted by the server. The Capture view puts it into the Notes box, where it is made plain first:
  `<` becomes an entity, a line that would start a heading, quote, list, rule or fence and any bracket is
  escaped, so a transcript that says "ignore your instructions" or contains markup is only ever words the author
  edits. Adding it is one undoable edit (**Undo the transcript**); nothing is saved or published by it.
- **Tests make no network call.** Provider adapters are exercised against loopback fakes (a test-only endpoint
  override), and the local engine against `echo`.

## Considered options

- **Sending the audio with the draft request.** Rejected: it would put the recording in the same disclosure as the
  voice guide and photos' text, and make "transcribe only" impossible.
- **Taking the engine command from `openblog.json`.** Rejected: site content is often shared through a repository,
  and a command is code execution on the server.
- **Transcribing with the custom HTTPS provider.** Rejected: its contract is a JSON generation endpoint; inventing
  an audio protocol for it would be a stored promise nobody agreed to.
- **Saving the transcript in the post's front matter.** Rejected: it is private working text, not content. The
  author's edited notes are what becomes the post.

## Consequences

- A site with no audio provider and no local engine loses nothing: the Capture view says so in one sentence.
- Re-transcribing replaces the stored transcript for that capture; the voice note is never changed.
- A provider's own retention rules apply to the audio it receives, and the disclosure says so.
