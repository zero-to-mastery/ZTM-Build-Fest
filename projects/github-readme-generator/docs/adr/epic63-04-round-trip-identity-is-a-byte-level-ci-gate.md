# Round-trip identity is a byte-level CI gate over pinned fixtures

> **Status: accepted and completed by story #79 in v1.9.8.**

"Unchanged round trips are identical" is only provable if the fixtures themselves cannot drift. `.gitattributes` forces `*.md` to LF, which would quietly destroy the CRLF, mixed-line-ending and BOM cases we most need. So the Round-trip corpus lives under `tests/fixtures/round-trip/`, marked `-text`. A `manifest.json` lists every fixture with its kind, what it covers and its SHA-256, and the gate fails on an unlisted file or a hash mismatch before it tests anything else.

Identity means byte equality for Markdown. For Studio projects and workspace backups it means deep equality after replacing block IDs with ordinals and ignoring save times and app version. It never means "renders the same".

We considered adding a property-testing library and rejected it: it would be a new dependency, and its shrinking makes failures non-deterministic between runs. Instead a small seeded generator in the test harness runs a fixed list of seeds, and every failure prints its seed.

The gate runs as its own named CI step, `npm run test:round-trip`, early in the `verify` job, so it fails in seconds. It also still runs inside `npm test`, which costs a few seconds twice; we accepted that for a visibly named release gate. Pull requests, `main` and version tags all run the gate. A failing gate is fixed in code. A fixture is re-pinned only when the fixture itself changes on purpose, and the PR must say why.

The completed corpus includes raw Markdown fixtures plus Studio-project JSON fixtures. One project deliberately mixes builder, exact Custom Markdown and component Blocks, explicit Seams, CRLF/LF source and component-instance metadata. The gate verifies the pinned input bytes, exact Source, Block order/types, settings, ownership metadata and stable project/workspace re-exports; an unlisted corpus file fails the gate.
