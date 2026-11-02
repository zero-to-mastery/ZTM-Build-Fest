# One lesson, multiple destinations

The [canonical lesson](./content/posts/portable-lesson.md) combines research metadata,
[contributor credits](./content/posts/portable-lesson.credits.json), a callout, knowledge check,
Rust and configured Python runners, a web sandbox, media, timestamps, and discussion links.
The [configuration](./openblog.json) enables all five destination policies for offline dry runs.
Its example endpoints are placeholders, not usable hosted services.

From the repository root:

```sh
cargo run -p openblog-cli -- export portable-lesson --root examples/portable-publishing
cargo run -p openblog-cli -- syndicate portable-lesson --json --root examples/portable-publishing
```

Neither command contacts a provider or writes content. To create a Markdown file, add
`--out portable-lesson.md --write` to the export command; an existing file is not overwritten.
Do not use syndication `--write` with these placeholder endpoints.

## What readers receive

- Portable HTML and Markdown preserve the question, choices, visible answer, explanation,
  source, expected output, evidence, public credits, and canonical identity.
- Rust gets a prefilled external Playground link as well as the canonical run/edit link.
  Python retains its source and canonical execution link without exposing the runner endpoint.
- The web sandbox becomes labeled HTML/CSS/JavaScript blocks plus a canonical live-preview link.
  No CodePen copy is created.
- Video becomes a provider link. Timestamps remain readable prose because this example uses the
  research profile; automatic linked chapter lists belong to the video profile.
- RSS and JSON Feed use the same portable HTML; JSON Feed adds a portable text companion.
- DEV/Hashnode plans select Markdown, Ghost/WordPress plans select HTML, and Medium remains
  manual import. Destination policies explain canonical limitations.
- DEV/Hashnode plans disclose selected/omitted tags and invalid metadata; the example uses
  DEV-compatible alphanumeric tags. Hashnode plans measure the complete serialized request
  against a conservative 100,000-byte limit without contacting the provider.
- Private front matter, HTML comments, and configured service endpoints never enter the public
  representations. Native quizzes and sandboxes remain interactive on the canonical site.
- Discussion links reach the generated `#ob-discussion` region, not a submission endpoint.
  Public exports never import moderation queues or private reader responses.

The shared example is exercised by core/feed, Admin preview, export, and adapter regression
tests. These verify local artifacts and safety gates, not third-party rendering parity.

## Release gates

From the repository root, run the existing validation commands:

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
node --test tests/web/*.test.mjs tests/portability-contracts.test.mjs
node scripts/check-doc-links.mjs
cargo run -p openblog-cli -- build
cargo run -p openblog-cli -- build --root examples/portable-publishing
```

Then run `npx playwright test` from `tests/browser` (with the pinned test dependencies and
Chromium installed). It starts and stops its own authenticated local server and checks independent
XML/JSON readers, canonical anchor targets, script/CSS-free and print output, keyboard/mobile
views, unsaved Admin edits, exact copy/download bytes and failed previews.

The core gate includes reviewed HTML/Markdown goldens and mutation tests that remove required
facts from HTML, Markdown and text. Missing facts block artifact generation. Visual-editor
round trips preserve the authored and exported corpus; acknowledgement tests reject malformed,
oversized, unsupported-version, stale-revision and unknown-destination state. Export/adapter
fixtures verify manifests, no-clobber writes, payload byte bounds, create/update identities,
partial/error outcomes and private-state exclusion without live credentials.

These gates do not implement the planned research/discovery interactions. Their registered
contracts remain canonical-only (or absent for private state) until their owning stories ship
approved public representations. They also do not prove provider rendering parity, create a
remote publication, or substitute for a hosted CI run after changes are pushed.
