# AGENTS.md — Kin

Standing instructions for AI coding agents and automated tools working on
**Kin**. Read it all before changing anything. It applies to every task unless
the task says otherwise. Human contributors: [CONTRIBUTING](CONTRIBUTING.md)
says the same things in a friendlier order.

## The repository boundary (hard rule)

Kin lives inside the ZTM Build Fest repository at `projects/kin/`. Treat that
folder as the project root and **change nothing outside it**: not the root
`README.md`, not other participants' projects, no parent-level Cargo, npm,
lockfile, editor, script, documentation or build files. The one authorized
exception is `.github/workflows/kin-verification.yml` at the repository root,
which is a synchronized copy of `docs/ci/kin-verification.workflow.yml` (a
test fails if they drift). Do not widen that exception.

Before finishing any task, run `git status` and `git diff`. Every changed path
must start with `projects/kin/`. Revert anything else.

## What Kin is

A private, lightweight household coordination app: what does our household
need to know right now? Today, Lists, Routines, Updates and Household, a family
hub (calendar, kitchen display, chore chart, photos, fridge, meals), a private
space per member, accounts and trusted devices, and modes for people who
rarely use apps. Local-first, encrypted on the device, synced through a relay
that only ever holds ciphertext. [PRODUCT](docs/PRODUCT.md) and
[PRINCIPLES](docs/PRINCIPLES.md) are the product truth;
[ARCHITECTURE](docs/ARCHITECTURE.md) is the technical truth; the
[documentation map](docs/README.md) lists the rest.

Kin coordinates. It never judges, blames, scores, ranks, compares, gamifies,
diagnoses or surveils. Test every feature against: *would a tired parent
holding a child actually use this?* Favour tap, type a few words, tap, done.
Do not add priorities, tags, projects, mandatory fields or configuration
screens to ordinary household coordination.

## Where Kin is now

The current release is **v1.6.0 — Kin for Everyone**, tagged `kin-v1.6.0`
on 2026-10-21. [CHANGELOG](CHANGELOG.md) lists every release and what each
changed; its *Unreleased* section is where new work is recorded. Work after
v1.0 is tracked as GitHub issues, not pre-assigned version numbers. The
planning documents from v0.1 through the October 2026 push to v1.0 are
archived under [docs/planning/](docs/planning/README.md); they are history,
not a backlog.

Standing constraints since v1.0:

- **Formats are frozen.** Every v1.x release keeps reading the storage, sync,
  export and server formats in [V1.0-COMPATIBILITY](docs/V1.0-COMPATIBILITY.md).
  A CI test fails if a frozen version changes without that document. A new
  format is an addition, never a replacement. Server schema migrations are
  forward-only.
- **Known limitations** are listed in
  [THREAT-MODEL](docs/THREAT-MODEL.md#known-limitations-at-v10). Never claim
  protection against them.
- **Household authority:** up to four Adults, Limited members and Temporary
  members; the founder is the first household admin; admins promote or demote
  other Adults with a fresh passkey or password. Membership, revoking another
  member's device, household deletion, admin recovery and shared settings
  require an admin. Do not add member classes or permission tiers.
- **Recovery** restores continuity without reviving revoked authority, and the
  server never holds a readable content key ([ADR 0018](docs/decisions/0018-account-key-vault.md)).
- **Tags** are created, moved or pushed only with the owner's explicit
  approval.

## Technical direction

Rust compiled to `wasm32-unknown-unknown`, native Web Components, vanilla
JavaScript, native browser APIs, Node.js with its built-in SQLite. The project
explores how far these go without frameworks.

**Responsibilities.** Rust owns deterministic domain logic: events,
validation, state transitions, replay, recurrence, diffing, reconciliation,
search. JavaScript owns the DOM, components, rendering, interaction, browser
lifecycle, IndexedDB, WebAuthn, Web Crypto, networking and loading the
WebAssembly. Rust never touches the DOM; JavaScript never duplicates the Rust
reducer. Rust must have a real job: do not add Rust because this is a Rust
project.

**Events are the record.** `ITEM_ADDED`, `ITEM_COMPLETED` and so on, replayed
deterministically, are the truth; `milk.completed = true` is derived. Given
the same valid event stream the engine derives the same state, always. Do not
add event kinds before they are needed, and never change the meaning of an
existing one ([EVENTS](docs/EVENTS.md), [STATE](docs/STATE.md)).

**The ABI is manual.** Memory ownership, buffer lifetime and every export are
documented in [ABI](docs/ABI.md); unsafe Rust is isolated and explained.

**Dependencies.** Prefer the Rust standard library and the web platform. No
React, Vue, Svelte, Angular, Solid, Lit, jQuery, Tailwind, Bootstrap, Vite,
Webpack, Rollup or Parcel; no `wasm-bindgen`, `web-sys`, `js-sys`, `serde` by
default. The web runtime has zero npm dependencies and the engine has zero
crates; keep it that way unless a dependency's value clearly outweighs its
complexity and maintenance, and document why before adding it. The one
exception on record is Android's `androidbrowserhelper`
([ADR 0020](docs/decisions/0020-google-play-twa.md)).

## Privacy, security, accessibility

- Treat privacy as architecture. Local-first storage, minimal server
  knowledge, encrypted sync, explicit trusted devices, revocable access,
  deliberate exports, clear deletion. No advertising, no sale or analytics of
  household content, no telemetry. Never send household text to an external
  AI system.
- Treat household text and imported data as untrusted. Render it with
  `textContent` or explicit DOM construction, never as HTML; no `eval` and no
  generated executable code. Changes to WebAuthn, Web Crypto, sync, device
  authorization, key handling, migration, rendering of household text or
  imported data get review proportional to their sensitivity.
- Accessibility is a baseline, not a polish phase: semantic HTML, native
  controls, labels, keyboard operation, visible focus, logical headings,
  contrast, zoom, 320 px reflow, reduced motion, no unnecessary ARIA. The
  browser gate asserts these; keep it passing.
- Mobile first: one-handed use, 48 px targets, short forms, interrupted
  interactions.
- Kin itself has no AI runtime. If AI features are ever considered they must
  be optional and privacy-conscious, and never judge, blame or score.

## How to work

1. **Read before changing.** The relevant contract in `docs/` and the
   decision records that apply. If a task intentionally changes an
   architectural decision, update the document (or add an ADR) rather than
   diverging silently.
2. **Keep scope.** Build what the task asks, completely. Do not implement a
   roadmap item, a plan from the archive or a "while I'm here" feature the
   task did not ask for.
3. **Test.** Every meaningful Rust behaviour has a test; browser behaviour has
   a browser suite without introducing a JavaScript test framework. Run
   `npm run verify` and, for anything a browser can see, `npm run verify:browser`
   ([TESTING](docs/TESTING.md)). Report results faithfully, including what you
   could not run.
4. **Document.** Documentation is part of the product. Update the contract a
   change affects, keep the README's description of what exists accurate
   (planned is never described as implemented), and add a line under
   *Unreleased* in the changelog.
5. **Check the tree.** `git status` and `git diff` before you finish: only
   `projects/kin/` paths, no generated artifacts that should be ignored, no
   household text or secrets in fixtures, screenshots or logs.

Error handling: never swallow an unexpected failure. Errors are deterministic,
actionable, surfaced appropriately and safe to show. Code: small focused
modules, explicit data flow, descriptive names, documented invariants, minimal
global state. Comments explain invariants, non-obvious decisions, memory
safety, protocol formats and security considerations, not what the code
already says. Use synthetic household text only, everywhere.

## Versions, tags and releases

Semantic `MAJOR.MINOR.PATCH`. A minor release introduces a product capability;
a patch does not. Within a line, `.1` correctness, `.2` resilience and
accessibility, `.3` hardening and polish, when such work exists; never
manufacture a patch. After `.3`, ask the owner before starting another
capability.

Every completed version gets an annotated `kin-vX.Y.Z` tag on its validated
release commit (`git tag -l 'kin-v*'` lists them; the latest is `kin-v1.6.0`).
Never use an un-prefixed tag; never move, force-update or reuse a pushed tag;
fix a released mistake in a new patch. The release sequence:

1. Complete the scope and its documentation.
2. Run the gate and inspect `git status` and `git diff`.
3. Commit the final state; the working tree is clean.
4. Create the annotated tag on that exact commit, with a message such as
   `Kin v1.6.0 — Kin for Everyone`.
5. Push the commit and, only when authorized, the tag.

A release is complete only when its scope and checks pass, its commit exists
and the tag points at it. Never claim a push that did not happen; if a push
is not authorized, report the exact command (`git push origin kin-vX.Y.Z`).
`scripts/check_version.py` keeps the version consistent across
`Cargo.toml`, `package.json`, the README, the changelog, the bug template,
this file and the app shell; update all of them together.

## Finishing a task

Summarize **what changed**, **files changed**, **decisions made**,
**validation** (what was run and what it showed, including skipped or failed
checks), **deferred** work, and confirm:

> All changes are confined to `projects/kin/`.

## When requirements conflict

1. Safety and security.
2. Explicit task instructions.
3. ZTM Build Fest contribution requirements.
4. This file.
5. Documented Kin architecture.
6. Convenience.

## Guiding principle

Kin should make family life require less remembering, less repeating and
less unnecessary friction. If a feature would make Kin harder than sending a
text message, reconsider it.
