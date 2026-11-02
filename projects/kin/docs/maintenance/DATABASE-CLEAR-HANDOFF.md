# Database-wide clear command handoff

The database-wide `clear` command was removed from the v0.41.0 candidate. It is
an administrative destructive operation, has no mobile UX acceptance
criterion, and needs its own maintenance proposal and review.

The implementation that was reviewed during PR #40 is visible in commit
`b471e3c` in `server/admin.mjs`, `server/durable-store.mjs`, and
`server/admin.test.mjs`; it is not part of the current v0.41.0 working-tree
changes. Do not run it against a development or household database. Any future
reintroduction must use isolated temporary SQLite fixtures and separately
verify lock behavior, backup failure atomicity, WAL/integrity handling,
restore, and deletion scope before an authorized maintenance PR.

No database clearing command was executed as part of this review.

## Household-scoped operator purge

Kin provides a deliberately narrow operator CLI for inspecting and forcibly
finalizing one household deletion. It does not expose SQL, decrypted content,
search by personal information, or a database-wide clear operation.

Stop the Kin service before using the mutation command. The command acquires
both maintenance and service locks and refuses to run while either is held.

```text
node server/admin.mjs household-status <household-id>
node server/admin.mjs household-purge <household-id> --confirm-household-id <household-id>
node server/admin.mjs household-verify-purged <household-id>
```

The confirmation must repeat the exact 32-character opaque household ID. The
purge uses the same transactional data-removal routine as scheduled deletion,
then verifies that all service-controlled household rows are gone while the
minimal anti-resurrection tombstone remains. It can finalize either an active
or deletion-pending household and therefore bypasses the normal 30-day grace
period. Use it only after independently verifying the request and target.

The command cannot erase browser storage, offline devices, user-created
exports, screenshots, or separately retained database backups. Operators must
apply their backup-retention policy separately. Output contains lifecycle
metadata and row counts, never decrypted household content.
