# ADR 0104: Retention purges what is not published, audit events outlive it, and removal and abuse reports fail closed

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#211](https://github.com/journey-to-code-org/open.blog/issues/211)
- Parent story: [#203](https://github.com/journey-to-code-org/open.blog/issues/203)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0102](0102-one-moderation-state-machine-where-everything-starts-pending.md),
  [ADR 0103](0103-who-may-moderate-reader-participation.md)
- Coordinates with: [#226](https://github.com/journey-to-code-org/open.blog/issues/226)

## Context

Reader text that is never published should not be kept indefinitely, but a removal or an upheld
report must stay explainable after the text is gone. The issue asks that removal and abuse reports
fail closed while preserving the audit metadata they require, and that retention expiry be tested.
Hosted storage is a one-way door ([ADR 0080](0080-hosted-feedback-is-one-additive-private-table.md)), so this decision defines the rules and leaves jobs,
tables and the function's adoption to #226.

## Decision

- **Retention** is `participation.retention` in `openblog.json`, in whole days, each between 1 and
  3,650:

  | Setting | Default | Effect |
  | --- | --- | --- |
  | `pendingDays` | 90 | an unmoderated pending item expires: rejected with reason `expired` |
  | `clarificationDays` | 30 | an unanswered clarification request expires the same way |
  | `closedDays` | 30 | the text, details and reader name of a rejected or removed item, or of an upheld abuse report, are purged |
  | `auditDays` | 365 | audit events are deleted; must be at least `closedDays` |

  A withdrawn item's text is due for purging at once. Approved items are kept while published.
  An approved item of a kind that is never public, which today is an upheld abuse report, is
  closed for retention: nothing publishes it, so its text, details and reader name are purged
  `closedDays` after it was upheld, like a rejected item's, while its audit events, and the
  removal they name, stay for `auditDays`.
- **Comments are opted in, never swept in.** Hosted comments predate this policy, and today they
  are kept until a moderator acts. While `participation.retention` is absent from `openblog.json`,
  the default periods above apply to every other kind and to no comment: a pending comment never
  expires and a rejected comment's text is never purged, so a site that changes nothing keeps its
  comments exactly as before once the retention job (#226) runs. A site that sets
  `participation.retention` itself, even as `{}` (the default periods), opts its comments in, and
  every period then applies to every kind. Switching a kind on in `participation.kinds` does not
  opt comments in. Audit events are this policy's own new records, not the comments, so
  `auditDays` applies to them for every kind. In code, `ModerationPolicy::default()` is the site
  that never set retention, `ModerationPolicy::new(periods)` one that did, and `from_config` picks
  between them.
  `ModerationPolicy::retention_due` says which step an item owes (`expire` or `purge-content`),
  `expire` is a transition only the System actor may take and only once due, and
  `purge_event` records the purge without changing the state. Purged items cannot be reopened or
  viewed; only their state and audit remain.
- **Audit events** (`AuditEvent`) record, for each submission, transition and purge: the item, its
  kind, the action, the states before and after, the actor's role, the Admin account for site
  Admins, coordinators and contributing authors, the reason, the time, the revision and version,
  and the related item (a report and its target, a response and its parent). They never hold the
  text, details, a reader's name, contact, address or device data, so they can outlive the text.
  The caller writes a transition and its event in one write; if either fails, nothing changed.
- **Removal fails closed.** A removal needs a grant, the current version and a reason; its event
  names who, when, why and which revision. Removed items are never public again unless reopened
  and approved afresh. Anything the public test does not recognise as approved at its current
  revision is private.
- **Abuse reports fail closed.**
  - A report is accepted only for an item that is public now (ADR 0102), and answers
    `unavailable` otherwise, exactly as for an item that does not exist.
  - A report is never public, not counted publicly, and never changes its target by itself, so
    reporting cannot be used to take content down.
  - Upholding (`uphold-report`) needs a reason, the report's current version and the stored item
    the report names; the wrong item or none is `reportMismatch`. It also needs the grant to
    remove that item; without it nothing changes. If the item is still approved, the same decision
    removes it with reason `upheld-report`, both events naming each other; if it is already out of
    view, only the report changes. An upheld report therefore always leaves its target out of
    public view, or changes nothing at all.
  - Dismissing a report is a rejection with `no-action`, `duplicate`, `spam` or `other`.
- **No reader is contacted.** Nothing in retention, removal or reporting sends e-mail or any other
  message to readers.

## Considered options

- **Delete everything on rejection.** Rejected: an owner could not explain or undo a decision,
  and repeated abuse would be invisible.
- **Keep audit events with the text.** Rejected: the audit trail would carry the private text
  past its retention period.
- **Remove a reported item first and check the report later.** Rejected: an unauthorized or
  mistaken report would act as a takedown.

## Consequences

- #226 adds the retention job, the private audit table (additive, like [ADR 0080](0080-hosted-feedback-is-one-additive-private-table.md)) and reader
  receipts, applying these rules; #225 shows reasons and audit history to moderators. (Done in
  [ADR 0107](0107-reader-receipts-deletion-requests-and-anonymous-abuse-reports.md) and
  [ADR 0108](0108-retention-runs-from-a-dry-run-and-quotas-keep-only-hourly-digests.md): a purge
  also raises the item's version, so no earlier view can act on it.)
- Shorter periods are a configuration change, not a code change, and are validated at load.
