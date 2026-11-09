# Confidence is a named basis, and staleness needs no extra requests

Each Declaration carries Provenance (repository, branch, Project boundary, Manifest path, blob SHA, section, line when known, Observed at) and one Confidence basis: `explicit`, `inherited`, `conditional` or `ambiguous`, each with a fixed one-line explanation. A deterministic rule assigns the basis from the parser's own facts. It is never a number, an average or a ranking, and it never describes the developer. A stack result is Stale when the currently loaded repository list reports `pushed_at` later than the `pushed_at` the scan started from (two GitHub times, so a wrong local clock does not matter), or when it was observed more than 24 hours ago. Staleness is computed when the result is shown, from data Studio already holds. It never refetches, polls or reads per-file commit history.

We rejected a numeric confidence score because a percentage invites reading it as proficiency or quality, and because the inputs (field kind, inheritance, file format) are categorical anyway. We rejected per-Manifest last-commit dates and background re-checks of the branch head, because each costs one request per file or repository against the unauthenticated rate limit and would make a passive display start network work. We accepted that Stale can be a false alarm (a push that did not touch Manifests), so it only prompts **Fetch fresh manifests** and never hides or downgrades evidence.

## Consequences

- Provenance and basis are part of the session-only scan record (version 5). Nothing new is persisted, so there is no storage key, migration or backup change.
- Root-only scans have no commit SHA, because the contents API does not return one. They identify file content by blob SHA. Nested discovery records the branch head SHA it already read.
