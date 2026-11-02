# Agent Handoff — Kin Build Fest Daily Roadmap

Read:

1. existing Kin agent/contributor guidance;
2. `docs/PRINCIPLES.md`;
3. `docs/PRODUCT.md`;
4. `docs/ROADMAP.md`;
5. `docs/BUILD-FEST-CADENCE.md`;
6. `docs/RELEASE-LINE-PROTOCOL.md`;
7. the current release contract.

## Mission

For the current user-authorized fast-track, complete `v0.21.0` through
`v0.25.0` one minor at a time on `kin-fast-track-v0.21-v0.25`, preserving
one milestone commit per minor. v0.21.0 Household Modes, v0.22.0
Lightweight Planning Dates, v0.23.0 Calendar Interoperability, v0.24.0
Useful Household History, and v0.25.0 Search & Filters are implementation
candidates. Do not tag or merge the batch branch, and do not start v0.26.x.
The broader October roadmap still targets
v0.40.x, with v0.41–v0.45 as undated proposals for reassessment after
October feedback.

Follow the current user-authorized scope in [AGENTS.md](../../AGENTS.md) and the
[release process](../RELEASES.md). This handoff does not authorize
publication, tagging, or branch merge.

Never fake tags to satisfy dates.

Within an explicitly authorized daily implementation sequence, continue between daily releases without routine feedback stops. Preserve required review/release gates and stop for genuinely ambiguous security/recovery/destructive authority, architecture-changing dependencies, product-boundary conflicts or acceptance criteria that cannot be met. After the end-of-month build (target v0.40.x), follow the roadmap's human-feedback gate.

No AI runtime. No gamification. No surveillance. No enterprise workflow drift.

At the end of each minor report:

- capability delivered;
- contracts/files changed;
- version/migration changes;
- security/privacy impact;
- tests/measurements;
- known limits;
- tags created;
- readiness for next minor.
