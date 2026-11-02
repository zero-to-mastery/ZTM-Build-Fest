# Dismissals bind to the README revision; Manual project types bind to the repository

Implemented in v1.9.9.

A Dismissal says "this Recommendation does not apply" about evidence read from one README revision. It is stored with that Observed revision (a Git blob SHA, or confirmed absence of a root README) and applies only while the latest audit sees the same revision. When the README changes, the Dismissal becomes a Stale decision. It is kept and shown as "dismissed for an earlier README revision" with one-click Dismiss again or Forget, but it is not applied. This matches Intentionally minimal and means a rewritten README is always looked at again. A Dismissal needs a known revision, and without one the action is disabled until the audit is refreshed. Revision-bound decisions are never matched by push date, source length or README path.

A Manual project type describes the repository rather than its README, so it applies whatever the revision is and survives reloads and account switches. It records the revision it was chosen against only so that the choice can be displayed. Re-choosing a type on every README commit would be a chore, and a wrong type is visible on every plan and queue entry, so the author can easily correct it. Choosing Automatic suggestion deletes it.

We considered binding everything to the repository, but that hides findings a rewrite may have reintroduced. We also considered binding everything to the revision, but that forgets a stable fact about the project at each commit. Identity is the case-insensitive owner/name. GitHub's numeric repository ID would survive renames, but the audit's records and existing decisions are keyed by name, and a renamed repository simply starts with no decisions.
