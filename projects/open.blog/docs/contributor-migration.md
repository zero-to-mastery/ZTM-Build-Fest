# Migrating inherited authorship

Existing posts do not need migration: when no credit sidecar exists, open.blog continues to
use the site-level `author`. Use this migration only when you want every current post to
carry an explicit, reusable contributor credit.

Preview the migration first. Choose the contributor ID deliberately; it becomes a stable
reference from post sidecars and is not a display name.

```sh
openblog contributors migrate --id ada-lovelace
```

The dry run reports whether it would register the legacy site author, how many version-1
credit sidecars it would create, and how many existing sidecars it would skip. It changes no
files. Review `author.name`, `author.url`, and `author.sameAs` in `openblog.json`, then run
write mode explicitly:

```sh
openblog contributors migrate --id ada-lovelace --write
```

Write mode recalculates and validates a fresh plan from the files currently on disk; it does
not apply a stored dry-run snapshot. Use the dry-run summary for confirmation in an
automation or wrapper; write mode prints a completion report for the fresh plan it applied.

The command never rewrites Markdown or front matter. It creates one `crossref:author`
credit only for posts that have no adjacent sidecar. Existing sidecars—including explicit
empty or malformed files—are left untouched. The configuration update preserves unrelated
and unknown JSON members. During each write invocation it locks migrations, snapshots the
configuration and source posts, creates sidecars without clobbering existing files, and
rechecks those snapshots before writing. If a write fails, it removes only unchanged
sidecars it created and restores the prior configuration only when the migration still owns
that value.

Admin Studio and CLI authoring and publishing commands honor the same
`.openblog/content-transaction.lock`. A normal command removes it automatically. If the
process or machine crashes, first confirm that no open.blog writer is running, then remove
that exact lock file and retry; the error message also names the recovery path.

Running the command again with the same ID is safe: it reuses an identical registered
identity and skips posts already migrated. A different identity already registered under
that ID is an error. This migration copies public identity fields only; it does not infer or
authenticate an ORCID iD and does not change the public authorship readers saw through the
legacy fallback.
