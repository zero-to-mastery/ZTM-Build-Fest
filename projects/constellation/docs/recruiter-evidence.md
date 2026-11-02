# Recruiter Evidence v1

Recruiter Evidence v1 is the deterministic Rust/WASM analysis used by the recruiter README view. JavaScript normalizes GitHub data and passes a small JSON value to `analyze_recruiter_evidence`; Rust derives project evidence and the canonical project order. Layout, colors, role-based radius, relationships, the seven-project display cap, and SVG presentation remain in JavaScript and SVG/CSS.

## Contract

The input has `version: 1`, an explicit `reference` time in epoch milliseconds, the account login, and normalized repositories. Each repository has a stable call-local `id`, `fullName`, optional `pushedAt`, authored `role` and `priority`, optional snapshot status, normalized commits (`date`, `login`), normalized activity events (`date`, `kind`), and optional organization coverage (`complete`, `logins`). The engine never reads the clock or accepts raw GitHub API objects.

The output has `version: 1`, one evidence result per input repository, and `order`, a list of input IDs. Evidence contains observed month count, history completeness, latest observed time, recency band and unknown-recency flag, contributor count and coverage flag, external/contributed flags, trailing-quarter activity, role, and featured status.

Ordering is role (`featured`, `supporting`, `experimental`, `historical`, then unassigned), authored priority (default 9999), `pushedAt` descending (invalid or absent is zero), then `fullName`. GitHub identifiers use explicit ASCII case-insensitive ordering with lowercase before uppercase for an otherwise equal name. ASCII punctuation therefore follows byte order; unlike the former locale-sensitive JavaScript comparator, this is reproducible across hosts.

Callers that only need selection order set `orderingOnly: true` on the same JSON-string contract. Their repository records contain only `id`, `fullName`, `pushedAt`, `role`, and `priority`; commit, event, and organization evidence is not serialized or analyzed.

## Limits and errors

- JSON input: at most 1,000,000 bytes.
- Repositories: at most 512.
- Commits per repository: at most 4,096.
- Events per repository: at most 4,096.

Malformed, unsupported, or oversized input returns a structured JSON error containing `code` and `message`. The boundary does not panic on externally authored input.

## Evidence honesty

Observed months are lower bounds unless the selected commit snapshot is explicitly complete (`partial` is false) and has no diagnostic. Missing events never imply inactivity because activity feeds may be capped. Future-dated pushes, commits, and events are excluded relative to the explicit reference date. Unknown recency is reported explicitly and currently maps to the outermost recruiter band. Contributor counts are unknown when organization records are absent, and incomplete organization coverage is reported rather than presented as complete. Evidence describes observed activity and contribution; it does not evaluate a developer.

This additive engine contract does not change Config v7, Scene v1, Evidence v1, Semantic Graph v1, or Web Component API v1.
