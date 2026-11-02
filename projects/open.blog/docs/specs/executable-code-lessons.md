# Executable code lessons

Status: implemented from the 2026-10-24 approved epic and executable-code-lessons research

## Outcome

Authors can publish accessible, editable code lessons without executing reader code in the blog or
Admin process. Rust keeps its official Playground default. A site owner may configure one public,
credential-free execution gateway; Rust then uses it, and only explicitly allowlisted languages gain
execution. Web HTML/CSS/JavaScript keeps its separate opaque-origin preview.

## Security and ownership boundary

- Core remains deterministic and performs no I/O. It validates public configuration and emits
  markup only.
- The browser sends `{ language, source, stdin }` directly to the configured HTTPS endpoint with no
  credentials or referrer. No runner secret is serialized into the page.
- The browser bounds request/response/output sizes, validates result types, strips terminal controls,
  aborts slow requests, and uses `textContent` for output.
- The independently deployed runner is the execution boundary. It must enforce resource limits,
  network denial, fresh unprivileged workspaces, concurrency/rate limits, and patching.
- No endpoint means no new remote execution capability. Unsupported `runnable` fences remain static.

## Authoring contract

- `rust runnable`: official Rust Playground when no runner is configured; configured gateway when
  present.
- `web runnable`: local HTML/CSS/JavaScript preview using `---html`, `---css`, and `---js` markers.
- `<allowed-language> runnable`: configured gateway only when the language is in
  `codeRunner.languages`.
- Every enhanced remote-runner lesson preserves its source as the no-JavaScript fallback and adds
  source/stdin editors, Run, Reset, Copy, status, disclosure, and plain-text output.

## Assistant contract

Interactions accepts an exact requested language of Rust, web, or a site-allowed runner language.
The provider schema requires the same language in its result and rejects unknown fields, oversized
or control-bearing source, fence delimiters, invalid web sections, and challenges without a visible
comment-form TODO. Generation never mutates source; authors edit and explicitly insert the proposal.

## Out of scope

Multi-file projects, uploaded files, dependency/package installation, custom compiler flags, shell
commands, hidden tests, grading, reader accounts, persisted submissions, and execution by the static
site generator or Admin server.
