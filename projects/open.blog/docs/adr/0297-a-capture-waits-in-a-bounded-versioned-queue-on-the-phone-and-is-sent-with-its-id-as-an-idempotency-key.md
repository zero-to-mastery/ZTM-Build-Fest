# ADR 0294: A capture waits in a bounded, versioned queue on the phone and is sent with its id as an idempotency key

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#479](https://github.com/journey-to-code-org/open.blog/issues/479)
- Task: [#500](https://github.com/journey-to-code-org/open.blog/issues/500)
- Builds on: [ADR 0293](0296-a-capture-is-a-job-draft-started-from-a-phone-built-from-the-job-forms-own-keys.md)

## Context

On a job site the connection drops. A capture must not be lost, must not need retyping and must never turn into
two drafts when the phone sends it twice (a retry after a lost answer, two open tabs, a reload mid-send). The
queue also holds a stored format, which is a one-way door: a future version must be able to read what this one
wrote, and this one must survive what a future one writes.

## Decision

- **A capture id.** The view makes a random 128-bit id (32 lowercase hex digits) when a capture is started. It
  is the idempotency key and the only thing the server accepts as one (`openblog_core::capture::valid_id`).
- **The server is idempotent on it.**
  - `POST /admin/api/upload?name=&capture=<id>&slot=<n>` stores a photo at a fixed name,
    `images/uploads/captures/capture-<first 12 of id>-<slot>.<ext>`. A second send of the same slot answers
    `200` with the same address and `"duplicate": true` and writes nothing. `capture` and `slot` come together
    and are validated; the slot is below twelve.
  - `POST /admin/api/document` with `captureId` creates the draft once. After the file is written the server
    records `.openblog/captures/<id>.json` (`{ "v": 1, "path": ... }`, never published or built). Later sends
    of the id answer `200` with the same path, `"duplicate": true` and the draft's present status, and write and
    rebuild nothing. A draft the author has since deleted answers `"status": "removed"`; a replay never brings
    it back. A ledger entry of another version is refused with `409`, never guessed at.
  - Everything runs under the same locks and size and CSRF checks as the existing routes.
- **The queue is IndexedDB, bounded.** Database `openblog-capture`, store `captures`, key `id`. Records hold the
  capture's fields, its photos as blobs and (ADR 0295) a voice note. Bounds, from core and advertised in
  Admin's meta: at most **5** waiting captures, **60 MB** per capture, **120 MB** in all, twelve photos and
  8,000 characters of notes per capture. A capture that does not fit is refused with a sentence and stays on the
  screen; nothing is dropped silently and nothing is evicted.
- **Stored format, version 1.** `{ v: 1, id, createdAt, fields: { trade, service, town, notes }, photos:
  [{ name, type, size, blob }], audio: null | { type, size, seconds, blob }, attempts, failed, lastError }`.
  `lastError` is clipped to 200 characters and holds a server sentence, never a path or a credential. Only
  these keys are copied in, so the record cannot grow by accident. The reader is defensive: a value with a
  higher `v` is **kept untouched**, shown as "saved by a newer version", never sent and removed only if the
  author discards it; a value that is damaged is shown and can be discarded. A future version adds keys or a
  new `v`; it never reuses a key with another meaning.
- **Keep first, then send.** Save writes the record, clears the form and then tries to send, so a lost
  connection, a closed tab or a crash mid-send leaves the capture on the device.
- **Sending is oldest first and stops at the first sign the connection or the session is gone.** No answer, a
  busy or failing server (5xx), `408` and `429` are retried (on reconnect, on opening the view, and by **Send
  now**). `401` stops the flush and asks the author to sign in again. Any other refusal (`4xx`) marks that
  capture `failed` with the server's sentence, and the next one still goes; a failed capture is not retried until
  the author chooses **Try again**. A photo refused for good (not an image, too large) is skipped and named,
  and the draft is still made.
- **The queue never deletes by itself.** A record leaves only when the server has the draft or the author
  discards it, after a confirmation. There is no expiry; the count and byte bounds are what keep it small.
- **Without storage, send straight away.** When IndexedDB is missing, blocked or refuses to open, the view
  uploads immediately and, on a failure, leaves the capture on the screen as before.

## Considered options

- **A service worker with background sync.** Rejected: it needs a worker registration on the Admin origin and
  is not available on every phone browser; the queue works with the page open, which is when a person is
  capturing.
- **Local storage or a file on the server.** Rejected: photos do not fit local storage, and a file on the
  server is not there when the server cannot be reached.
- **A client-side record of which photos were sent.** Rejected: the fixed server-side names make a resend safe,
  so the phone keeps no progress to get wrong.

## Consequences

- Replaying a capture any number of times yields one draft and one copy of each photo.
- The ledger entry is a second stored format (`v: 1`); it holds only a content path.
- The queue holds photos that have not been sent to anyone. It is on the author's own device and is cleared
  only by sending or discarding.
