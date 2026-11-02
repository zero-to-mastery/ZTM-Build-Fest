# ADR 0009 — Durable Chat and Ephemeral Signaling Are Separate

Status: Accepted (#257, #258, #259, for the household chat epic #104)

## Context

The live channel (#107, #108) already carries two kinds of traffic that are not
household data: sealed typing and presence frames, relayed to open sockets and
kept nowhere. A later epic may want real-time voice or video between household
devices. That would need short-lived signaling (offers, answers, candidates,
hang-ups) with very different rules from chat: it must not become history, must
not reach a device that is offline or revoked, and must not be replayed.

This record sets the boundary now, so that later work can be added without
rewriting chat storage, the privacy policy or the manual WASM ABI. It does not
add calling, and nothing here promises it.

## Decision

- **Two kinds of message, never mixed.**
  - *Durable chat* is signed events and sealed blobs. It is stored, replayed to
    a device that was offline, exported, pushed and deleted by the rules in
    [ADR 0008](0008-household-chat.md), [RETENTION](../RETENTION.md) and
    [PORTABILITY](../PORTABILITY.md). It moves only over the HTTP sync routes.
  - *Ephemeral signaling* is one bounded, versioned envelope on the live
    channel (record type `EPHEMERAL`, [SYNC](../SYNC.md#ephemeral-envelope-v11-257-258)).
    It goes to sockets that are open now, is held in no table, queue or log,
    is never replayed, exported or pushed, and is dropped when the receiver
    cannot take it. A category is a closed list inside the service; production
    has none, so the path is closed until a feature adds one on purpose.
- **Addressing is by trusted device and member, decided on the server.** A
  message names a household, a member (all that member's connected trusted
  devices) or one device, using the canonical IDs that pairing already issues.
  The service stamps the sender from the sender's own session and re-checks
  device trust, member status and chat access at dispatch for both sides. A
  foreign, unknown, offline or revoked target gets nothing and the sender is
  told nothing, so the path is not a way to find out who is online.
- **Rust owns policy and state; the browser owns devices and media.** If calls
  are ever built, a Rust state machine behind the manual versioned ABI
  ([ADR 0003](0003-manual-wasm-abi.md)) would decide, independently of
  whether a WebSocket delivered anything: who may start or join, which
  transitions are legal, when an unanswered call expires, and what a
  revocation or key rotation ends. The browser would own only what Rust cannot
  see: microphones, cameras, permission prompts and the media connection. The
  boundary is a command and result, as with every other feature, not a code
  generator, and not a framework ([ADR 0007](0007-zero-runtime-frameworks.md)).
- **What this epic does and does not use.** Voice messages (#134) record a
  short clip with the microphone and send it as an ordinary sealed attachment.
  That is not real-time communication, and the recording code lives in one
  file, `web/chat/chat-voice.js`. WebRTC (peer connections, offers, answers,
  candidates), screen capture, TURN/STUN and any call UI are not used here and
  are not built as placeholders. A later epic may evaluate them; it decides
  then, with its own threat model.
- **Privacy rules for anything ephemeral.** No offer, answer, candidate,
  caption, audio or video is put in immutable event history, an archive, a
  log, a diagnostic or analytics. A future call history would be a separate,
  opt-in design with its own retention, not a side effect of signaling.
- **Authentication and the E2EE claim.** Signaling is accepted only from an
  authenticated socket of a trusted device and carries the sender the service
  stamped. A payload that must stay hidden from the service is sealed under the
  household key like typing frames are, and binds the sender's device. The
  transport encryption a media connection brings (for example DTLS-SRTP) is
  transport security between two endpoints; it is not Kin's household
  end-to-end claim, and must not be described as if it were, because a relay or
  signaling mistake could still connect the wrong endpoints.
- **Known limits, deferred.** A device that is offline, asleep, or a PWA in the
  background receives nothing: ephemeral messages are not queued and there is
  no push for them. Reachability through NATs (STUN), relays (TURN), their
  cost and a support matrix of browsers are not decided here.

## Consequences

- The live channel's plumbing stays domain-neutral, and existing chat delivery,
  receipts, typing and presence keep exactly their behavior.
- An ephemeral category cannot silently become history: the path writes
  nothing, and tests below fail if it starts to.
- A later epic can add a category (with its limits, scopes and access level),
  a Rust state machine and a UI, and has to bring its own threat model and
  review for each.

## Conformance checklist

These hold today and are guarded by `scripts/ephemeral-isolation.test.mjs`,
`server/live.test.mjs` and `web/sync/ephemeral-envelope.test.mjs`:

1. The category table is empty in production; an envelope for any category
   closes the socket.
2. The code in `server/live/` has no database, file or log access, and a
   message for a receiver that cannot take it right now is dropped, not
   queued (tested).
3. Nothing in the engine, the chat, archive, attachment, storage and sync code
   (apart from the envelope codec itself) or the server's routes refers to
   ephemeral messages.
4. No WebRTC API (`RTCPeerConnection`, session descriptions, ICE candidates),
   no screen capture, and no `getUserMedia` outside `web/chat/chat-voice.js`
   (voice messages) and `web/components/kin-qr-scanner.js` (video-only QR
   scanning, no audio, nothing recorded).
5. Routing uses member and device IDs only; the sender is never read from the
   message; foreign, unknown, offline and revoked targets receive nothing.
6. Zero third-party packages and crates; the ABI stays manual and versioned.
