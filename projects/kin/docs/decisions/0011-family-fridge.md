# ADR 0011 — The Family Fridge: Board Shape, Its Own Log, Strokes and Magnets

Status: Accepted (#318, for the family fridge epic #317)

## Context

The fridge is a playful shared board: everyone in the household draws on it
and hangs magnets (emoji, a few Kin-drawn magnets, short notes). It has to
work offline, merge across devices, stay encrypted end to end, fit a 320 px
phone, a landscape kitchen tablet and a desktop, and never become a
productivity or engagement surface.

Three facts from the code shape the design:

- A household's history is capped at 10,000 events (`wire::MAX_EVENT_COUNT`).
  A drawing is many strokes, so the fridge would fill it.
- One envelope carries at most 6,144 bytes of ciphertext
  (`web/sync/envelope-wire.js`); a canonical event has an 88-byte header.
- Chat already solved "a busy, separate log" ([ADR 0008](0008-household-chat.md)):
  its own Rust log with its own cap and checkpoint, its own relay stream with
  its own cursor, per-device sequence, logical clock and quota, and a local
  IndexedDB log per household. Every layer names it "chat"; Rust's `History`
  with its `Log` enum is the one place built to take another log.

## Decision

### Board shape
- **One fixed board per household**, a portrait "door" in a 3:4 logical
  coordinate space: x 0–4095, y 0–5460 (u16). No infinite canvas, no pan or
  zoom on the board; the page around it stays zoomable. Every device scales
  the same board, so a drawing looks the same everywhere.

### Its own log and relay stream
- **A third log, `board`**, beside household and chat, at every layer:
  - **Rust:** `Log::Board` in `History`, with its own cap
    (**250,000 board events**, like chat) and checkpoint. Each log refuses the
    others' kinds; board kinds never enter household replay or the KINS
    projection, so devices before this release never see them.
  - **Service:** a board relay stream (`/api/board/events`, `/api/board/status`)
    with the chat relay's rules (the device's own envelopes, gapless
    per-device sequence, identical-bytes idempotency, logical-time bound,
    per-device rate window) and its own tables, quota and cursor. The chat
    relay's store and service are generalized by stream name rather than
    copied; chat's tables, routes and behaviour do not change.
  - **Client:** a board log per household in IndexedDB, built on a log store
    modelled on `ChatLogStore` (envelopes, outbox, cursor; a separate copy, not
    a shared module), and a board
    pass that runs after the chat pass in the sync coordinator.
- **Encryption:** board events use the household key epoch, like household
  events. There is no separate board key: everyone in the household may see
  the fridge, and its access rule (below) is enforced by the service.
- **No live streaming and no presence.** Strokes sync on pen-up through the
  ordinary passes and live hints. There is no "Sam is drawing" and no
  "online now" ([UX](../UX.md) §10.1).

### Events (board kinds, from 52)
All carry the ordinary header (event id, household, member, device, logical
time); replay order is the protocol-8 order `(logical_time, device, event_id)`.

| Kind | Payload |
|---|---|
| `BOARD_STROKE_ADDED` | stroke id[16], colour u8 (palette index 0–7), width u8 (0–2), point count u16 (1–1,024; one point is a dot), first point x,y u16, then (dx, dy) zigzag varints; payload ≤ 4,096 bytes |
| `BOARD_STROKE_HIDDEN` | stroke id[16], hidden u8 (1 erase, 0 restore), 7 reserved zero bytes |
| `BOARD_MAGNET_PLACED` | magnet id[16], kind u8 (1 emoji, 2 Kin magnet, 3 note), x,y u16, then content: emoji (`check_emoji`), Kin magnet number u8, or note text (1–60 characters, UTF-8, one line) |
| `BOARD_MAGNET_MOVED` | magnet id[16], x,y u16, 4 reserved zero bytes |
| `BOARD_MAGNET_HIDDEN` | magnet id[16], hidden u8, 7 reserved zero bytes |
| `BOARD_CLEARED` | clear id[16] |
| `BOARD_CLEAR_UNDONE` | clear id[16] |

- **Strokes are encoded on the device that draws them:** points are
  simplified (about 2 units of tolerance) and delta-encoded. A longer stroke
  is split into several strokes drawn end to end. Colour is a palette index,
  so dark mode and forced colours remap it; three widths only.
- **Erase, undo and redo are visibility, not deletion.** Erasing a stroke or
  removing a magnet sets it hidden; undo and redo set it back. The latest
  event in replay order wins. Anyone who may draw may erase any stroke or
  move any magnet, as on a real fridge; attribution stays in the log.
- **Magnets:** a move puts the magnet on top (z-order is the replay order of
  its latest place or move). Its small tilt comes from its id, not from an
  event. A move or hide of a magnet the device hasn't seen yet waits in
  replay until the magnet arrives (or is ignored if it never does).
- **Clearing** hides every stroke and magnet ordered before the clear and
  records which clear hid them; `BOARD_CLEAR_UNDONE` shows exactly those again
  (unless hidden since). A stroke drawn offline whose logical time sorts
  before a clear is cleared too, as the replay order says; this is accepted
  for a fridge.
- **Budget:** at most **2,000 visible strokes and 200 visible magnets**. An
  add beyond it is refused by the device with a truthful "The fridge is full —
  clear it or erase something" and, if it arrives from elsewhere anyway, is
  kept in the log but not shown. Replay is bounded by the board log cap.

### Retention
- "History is never erased" holds: hiding and clearing add events; nothing
  is compacted ([RETENTION](../RETENTION.md)). A board log that reaches its cap
  makes the fridge read-only with the same truthful message. Compaction would
  need its own proof, as RETENTION says.
- The board log is part of the encrypted archive (export and restore) and is
  purged on household deletion on the service. Like the household history and
  the chat log, its local database (`kin-board-log:<household>`) stays on a
  device that leaves the household, encrypted under keys that device keeps;
  removing it is clearing the site's data, as [RETENTION](../RETENTION.md)
  says. `BoardLogStore.remove` exists for a later household-wide local
  cleanup to call.

### Access
- **Everyone may draw and hang magnets by default**, Limited and Temporary
  members included. A household admin can set "Who can use the fridge" for
  Limited and for Temporary members to **Draw**, **Look only** or **No
  access**, with a passkey, exactly like "Who can chat". The service enforces
  it on the board routes (push needs Draw; pull and status need anything but
  No access).
- Clearing is open to anyone who may draw, with confirmation and undo.
  The service cannot tell a clear from a stroke (the events are encrypted).

### Surfaces
- **Magnets are DOM elements over the canvas**, not pixels: they get focus,
  keyboard movement (arrows 1%, Shift 10%, or "Move to" one of nine regions),
  accessible names and hit-testing. Strokes are drawn on a canvas whose
  backing store is the CSS size × devicePixelRatio (capped at 3), with the
  live stroke on its own layer.
- A screen-reader summary names what is on the fridge ("14 drawings by Sam
  and Alex; 6 magnets") and lists magnets.
- **No notifications.** At most one quiet "The fridge changed" line in
  Catch-up. No counts, scores or streaks per person; gentle attribution only
  ("Drawn by Sam" on long-press or hover).

## Alternatives considered

- **Strokes in the household history.** Simplest, but a few drawings would
  fill the 10,000-event cap that every household feature shares.
- **Riding the chat stream.** It would tie fridge access to chat access and
  put drawings under the chat key and quota.
- **The board as snapshot blobs.** Concurrent drawing on two offline devices
  would conflict instead of merging, and old snapshots would be real deletion
  problems.
- **Copying chat's relay wholesale.** About a dozen server touch points and
  the client store would be duplicated; generalizing by stream name keeps one
  implementation.

## Consequences

- Additive format: new kinds 52–58 in a new log, a new relay stream, a server
  schema migration (board tables and the two policy columns) and a new
  archive section. Older clients ignore all of it; older services refuse the
  board routes, so a newer client says "The fridge needs an updated household
  service" and keeps what is drawn on this device until it can send. [V1.0-COMPATIBILITY](../V1.0-COMPATIBILITY.md)
  gets a row.
- The service learns when someone in the household draws (timing and size of
  board envelopes), never what.
- A shared kitchen tablet left unlocked shows the household; kitchen-screen
  mode (#324) keeps automatic lock and says so.
