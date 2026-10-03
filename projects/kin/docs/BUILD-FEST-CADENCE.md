# Build Fest Daily Cadence

## One full minor per day

A daily minor is a small coherent capability plus its incubation loop.

The October 3–31, 2026 plan contains 29 daily targets: v0.12.x on October 3 through v0.40.x on October 31, assuming v0.12.0 completes on October 3. The remaining platform and foundation lines are included in those days. v0.41–v0.45 are undated follow-ups, outside the October commitment.

This cadence applies within an authorized implementation sequence. The roadmap itself is planning, and the existing v0.11 candidate review and release gates still apply. Target dates depend on the [bridge prerequisites](BRIDGE-0.11-0.16.md); they do not establish completed releases or grant publication authority.

Recommended cadence:

```text
morning     v0.N.0  capability
midday      v0.N.1  correctness / migration / domain boundaries
afternoon   v0.N.2  resilience / accessibility / multi-device behavior
evening     v0.N.3  hardening / polish / docs / release gate
```

Only create patch tags when a real coherent change exists. Do not manufacture empty `.1/.2/.3` releases.

A day devoted solely to hardening or release-candidate validation may produce a patch on the current minor line. Update the proposed calendar/version mapping when needed; a new minor still requires a new product capability.

## Daily operating loop

1. Read the release contract.
2. Reconfirm prerequisites.
3. Define the smallest end-to-end capability.
4. Implement through existing event/Rust/WASM/web boundaries.
5. Test stale state, retry, offline, migration, accessibility, malformed input, and authorization where relevant.
6. Reconcile documentation.
7. Run the release gate.
8. Tag only when real.
9. Move on.

If a feature cannot fit coherently into one day, narrow it or slip the calendar. Do not weaken correctness, privacy, migration safety, or accessibility to keep the date.

## Human-intervention conditions

Within the authorized sequence, stop for human input when:

- security/recovery authority is genuinely ambiguous;
- destructive data-lifecycle promises change;
- a feature risks surveillance, judgment, or gamification;
- a new dependency/framework would materially change architecture;
- acceptance criteria cannot honestly be met.

Otherwise continue autonomously within that scope. Honor any required review/release gate and the final Build Fest feedback checkpoint.
