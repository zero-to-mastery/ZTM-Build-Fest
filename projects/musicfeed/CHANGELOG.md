# Changelog

All notable changes to MusicFeed are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-10-07

Missing metadata is no longer permanent. A background healer wakes with the process,
re-runs the metadata lookup for entries saved without cover art or a release year,
and writes back whatever it finds.

### Added

- `heal_attempts` column (migration 2): the worker's memory of failure. Entries at or
  over the cap drop out of the candidate query, so permanently-unfindable albums are
  left alone instead of retried forever. Success resets the counter.
- `list_incomplete` / `update_metadata` / `record_heal_failure` on `DatabaseBackend` —
  the healer's entire storage surface.
- `src/healer.rs`: `heal_once` (one candidate pass: lookup, write back, count) and
  `spawn_healer` (spawned at startup — pass one fires on wake, then a pass every
  `interval_secs`).
- `[healing]` configuration: `enabled` (kill switch via `APP_HEALING__ENABLED=false`),
  `interval_secs = 900`, `max_attempts = 3`, `per_pass = 3`.

### Changed

- `main.rs` spawns the healer alongside the server. A sleeping container wakes when
  the blog widget GETs, the process starts, and pass one fires — readership is the de
  facto scheduler.
- Politeness budget: at most 3 lookups per pass, one pass per 15 minutes.

### Notes

- The first deployed entry — saved during a Cover Art Archive outage — is the
  healer's first real patient.
- A pass interrupted by a restart is redone on the next start; nothing is lost.

## [0.5.0] - 2026-10-07

The rotation survives restarts, deploys, and Railway sleep cycles. The oldest known issue —
"storage is in memory, so every deploy empties the rotation" — is closed.

### Added

- A persistence layer, borrowed in shape from the metallian-photos database layer: a
  `DatabaseBackend` trait (`insert` / `list` / `random`) that routes code against, and a
  `SqliteRepository` implementation on `sqlx` behind it. The trait is the expansion seam for
  tracking listening habits later — one migration for an events table, new trait methods,
  nothing else moves.
- Embedded SQLx migrations (`migrations/`): `rotation_entries` mirrors the domain struct, with
  sequential `INTEGER PRIMARY KEY` ids preserving the u64 ids the templates and API expose.
- `DatabaseSettings` (`[database]` path + optional `max_connections`) in the configuration
  crate, threaded through `AppState::new` following the `basicauth` precedent. Production
  points at `/data/musicfeed.db` on a Railway volume.
- WAL journal mode: blog-island reads never block a form write, and an acknowledged insert
  survives a crash between commit and checkpoint.
- `tests/api/persistence.rs`: spawn an app, post an entry, drop the app, spawn a second app
  over the same file, assert the entry is served by both the index page and the random
  endpoint. Fails by construction against the in-memory state of 0.4.0.
- `tests/api/database.rs`: CRUD suite for the repository itself — sequential ids, optional-field
  round-trips, insertion order, random draw, empty-store `NotFound`, and reopen persistence.

### Changed

- `AppState` holds `Arc<dyn DatabaseBackend>` instead of `Arc<Mutex<Vec<RotationEntry>>>` and a
  `next_id` counter. The database is the counter now; `AppState::new` is async and fallible
  (connect + migrate before the first request).
- Random draws moved from `rand::random_range` to `ORDER BY RANDOM() LIMIT 1`; the empty-rotation
  404 contract now lives in the store. The `rand` dependency is gone.
- Route error enums gained a `Database` variant (500); the 404-on-empty behavior of
  `GET /rotation` is unchanged.
- `POST /rotation` renders after inserting rather than before. With in-memory state, rendering
  first protected against a half-added entry; with a store as the source of truth the risk
  inverts — a template failure after a successful insert leaves the entry saved but unpatched,
  recoverable on the next page load.

## [0.4.0] - 2026-10-06

The write path is gated. Posting an entry now requires Basic credentials, and the browser
asks for them itself — no login page, no form changes.

### Added

- `basic_auth` middleware (`src/middleware.rs`), attached to `POST /rotation` only via
  `from_fn_with_state`. Parses the `Authorization` header through six stages — header present,
  valid text, `Basic ` scheme, base64, UTF-8, split on the first colon — with every failure
  converging on the same 401. Implemented by hand rather than via `axum-extra`'s
  `ValidateRequestHeader`, because the point was to understand the mechanism.
- The 401 carries `WWW-Authenticate: Basic realm="musicfeed"`, which is what makes a browser
  render its own native login box. The form needs no changes: the browser prompts on the first
  POST, caches the credentials, and replays the request with them attached.
- `[basicauth]` configuration section and `BasicAuthSettings`, threaded through
  `AppState::new` following the existing `metadata` precedent. Local defaults are `test`/`test`;
  production reads real values from `APP_BASICAUTH__USERNAME` / `APP_BASICAUTH__PASSWORD` on
  Railway.
- Tests: 47 passing. The harness now builds two clients — one authenticated, one bare — so the
  suite documents which routes are protected. New cases cover no credentials (asserting the
  `WWW-Authenticate` header is present, not just the status, because a bare 401 would pass the
  status check while breaking the browser login box), wrong credentials (catching an
  implementation that decodes but forgets to compare), and the index page staying open.

### Notes

- Basic auth over sessions is deliberate. There is exactly one authorised user, the credential
  lives in an environment variable rather than a database, and the app is stateless by design —
  a session store would break across the serverless sleep cycles. "Never use basic auth" is
  consumer-product advice (password resets, MFA, many users) that does not reach a single-user
  gate over HTTPS. The known costs — no logout except closing the browser, and rotation being
  the real remedy for a stale credential — are accepted.
- `GET /` and `GET /rotation` stay open on purpose. The blog island fetches the latter from a
  static site that has nowhere to keep a secret, and the form needs to load before any login
  happens. CORS already restricts the write path to browsers; this closes the `curl` hole.

### Known issues

- Storage is in memory, so every deploy empties the rotation.
- `allow_origin(Any)` still permits any site to read the rotation.
- *Invincible Shield* resolves to a release MusicBrainz has no artwork for, so it renders without
  a cover or year.
- The `year` field does not visually clear after submission in Firefox.

## [0.3.1] - 2026-10-04

The API is deployed and serving the blog from production.

### Added

- `Dockerfile` adapted from the Zero to Production in Rust (Zero2Prod), with a `chef` / `builder` / `runtime`
  shape so dependency compilation is cached independently of our own source.
- `.dockerignore`, keeping `target/`, `.git` and scratch files out of the build context.

### Notes

- Four deviations from the Zero2Prod Dockerfile, each forced by this project rather than chosen:
  the `latest-rust-1-bookworm` chef tag, because the plain `latest-rust-1` image is Debian
  trixie (glibc 2.41) while the runtime stage is bookworm (2.38), and a binary built against
  the newer glibc will not start on the older one; Rust 1.99 rather than 1.80.1, because
  edition 2024 does not compile on 1.80; `cmake` alongside `clang`/`lld`, because
  `aws-lc-sys` (a rustls backend) builds C; and `static/` plus `templates/` copied into the
  runtime image, because the app reads both from the working directory at startup.
  `openssl` is not needed — the TLS stack is rustls, not OpenSSL.
- No test stage. The suite is hermetic and fast enough to run locally, and a failing test should
  fail `cargo test` rather than the container build.
- Deployed on Railway at `musicfeed-production.up.railway.app`, verified end to end: form post,
  live MusicBrainz lookup returning cover art and year, rendered and streamed to the taxus blog.
  The port mapping on the Railway domain targets 8000, which `production.toml` already sets, so no
  `APP_APPLICATION__PORT` is required.
- The runtime image is 148MB, of which the binary is 15MB and the Debian base is the rest.
  `cargo-chef` buys rebuild speed, not size; real reduction means distroless or scratch.

### Known issues

- Storage is in memory, so every deploy empties the rotation.
- `POST /rotation` is publicly reachable and unauthenticated. CORS only stops browsers from
  posting cross-origin; `curl` bypasses it entirely.
- `allow_origin(Any)` still permits any site to read the rotation.
- *Invincible Shield* resolves to a release MusicBrainz has no artwork for, so it renders without
  a cover or year.
- The `year` field does not visually clear after submission in Firefox.

## [0.3.0] - 2026-10-04

The blog island is live. `crusty-metallian.net` now loads `datastar.js` and pulls one entry from the
API over SSE, so the "Currently Spinning" widget reflects real data instead of a hand-maintained
JSON file that was rarely updated.

Cover art and release year are now looked up from MusicBrainz and the Cover Art Archive rather than
typed by hand — the reason the project exists.

### Added

- `MetadataClient` (`src/metadata.rs`) for MusicBrainz release search plus Cover Art Archive lookup,
  borrowed in shape from the `OpenRouterClient` in the user's `flux-learner` repo: `new()` delegates
  to `with_base_urls()` so tests point it at a local stub. No trait, no mocking framework in the
  production code.
- `MetadataSettings` in `configuration/`, so both service base URLs are environment-configurable
  rather than hardcoded.
- CORS on the read endpoint, allowing the blog origin to fetch one rotation entry cross-origin.
- `datastar-request` in `allow_headers` — Datastar tags its own fetches, and without it the
  browser's preflight fails and the island never connects.
- Tests for the lookup: release selection, year parsing from partial and empty dates, cover
  selection, Lucene escaping, and the fact that a miss is an ordinary outcome rather than an error.

### Changed

- The form takes artist, album, and note only. Cover and year are looked up, which also removed the
  field whose type mismatch caused the third-entry `400`.
- Entry markup now matches the blog's existing `.rotation-*` classes, so the widget's own CSS applies
  and the rendered `<li>` is no longer required.
- `year` is `Option<i32>`, and every optional field is `{% if %}`-guarded in the template. A field
  carrying `skip_serializing_if` is absent from the JSON when `None`, and Tera treats an absent field
  as a render error rather than a blank.

### Fixed

- Some albums resolved to a year but no cover art. Selecting the best match by date alone picked a
  release whose MBID had no art at all, so ranking now returns candidates best-first and the lookup
  walks them until one yields both a year and an image.
- A release with no date could outrank one that had a year, and an empty date string (`"date": ""`)
  counted as a date. Both meant the dateless record won, which cost us the year *and* the cover.
- A failed cover request no longer discards the year already resolved, and a 404 from the archive is
  treated as "no art" rather than a failure.

### Known issues

- The `year` field does not visually clear after submission in Firefox. It is `required` and is
  excluded from the signal reset, so the value persists by design — but the browser is not
  clearing the input itself.
- `allow_origin(Any)` is still in place and localhost is not yet allowed. Neither breaks the
  island; both are tightening to do before deploying.
- `POST /rotation` has no authentication. CORS only stops *browsers* from issuing a cross-origin
  POST — `curl` bypasses it entirely. An API key is required before this is publicly reachable.

## [0.2.0] - 2026-10-03

The first real feature: the to-do starter demo is gone, replaced by a music rotation log. Entries
can be added through a form and appear live in the list.

### Added

- `RotationEntry` domain type (`src/domain.rs`), replacing the starter's `Item`. Field names mirror
  the blog widget's existing `rotation.json` contract (`artist`, `album`, `cover`, `year`, `note`)
  so the destination site needs no data-handling changes. `id` and `listened_date` are stamped by the
  app and the type derives `Serialize` only, so neither can be forged by a client.
- `POST /rotation` handler (`src/routes/rotation.rs`) accepting form input and streaming SSE patches.
- `RawRotationEntry`, the request type, alongside the handler. `year` is typed `i32` and validated by
  serde, so bad input is rejected before the handler runs — no custom parsing required.
- In-memory storage: `AppState { rotation_entries, next_id }`, replacing `items` and `next_id`.
- Entry form and rotation list (`templates/index.html`), with `templates/rotation.html` as a shared
  partial included by both the server-rendered page and the SSE patch.
- Empty state ("Nothing spinning yet"), shown only while the list is empty.
- `compact_html()` in `src/utils.rs`. Datastar prefixes every line of `data: elements`, so a
  pretty-printed fragment arrives as many separate patches. Compacting at render time keeps the
  templates readable.
- `bacon.toml` with the `test` job wired to `cargo nextest`.
- README run instructions: clone, `cargo run`, configuration table, test instructions.
- 19 tests covering the SSE contract, HTML escaping, the empty state, cover handling, and the
  form-reset round trip.

### Changed

- Crate renamed from `axum-tera-datastar` to `musicfeed`.
- Entry list is rendered as cards with an optional cover image, artist, album, year, note, and the
  date listened.
- Blank `cover` and `note` are treated as absent and omitted rather than rendered empty.

### Removed

- The starter's to-do demo: `Item`, `src/routes/items.rs`, `tests/api/items.rs`, and the
  `POST /items` / `DELETE /items/{id}` routes.

### Fixed

- Only the first entry appeared in the live list. A multi-line template produced one `data: elements`
  field per line, so Datastar applied fragments instead of the whole entry.
- "Nothing spinning yet" survived the first submission. The empty state sat outside the patched
  element and no patch removed it; it now lives inside `#rotation-list` and the stream carries an
  explicit removal.
- Entries after the second silently failed with a `400`. The form reset sent `"year":""`, which
  serde rejects for an `i32`; `year` is no longer cleared.

## [0.1.0] - 2026-10-02

Initial scaffold, renamed from the `axum-tera-datastar` starter.

### Added

- axum 0.8 + Tera 2 + Datastar 0.4 application skeleton with layered configuration, Bunyan-formatted
  tracing, and graceful shutdown.
- `GET /health_check` and a starter to-do demo.

[Unreleased]: https://github.com/crustyrustacean/ZTM-Build-Fest/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/crustyrustacean/ZTM-Build-Fest/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/crustyrustacean/ZTM-Build-Fest/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/crustyrustacean/ZTM-Build-Fest/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/crustyrustacean/ZTM-Build-Fest/releases/tag/musicfeed-v0.2.0
