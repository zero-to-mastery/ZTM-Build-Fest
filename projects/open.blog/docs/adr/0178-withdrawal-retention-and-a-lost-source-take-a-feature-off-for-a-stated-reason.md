# ADR 0178: Withdrawal, retention and a lost source take a feature off for a stated reason

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#214](https://github.com/journey-to-code-org/open.blog/issues/214)
- Parent story: [#205](https://github.com/journey-to-code-org/open.blog/issues/205)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0102](0102-one-moderation-state-machine-where-everything-starts-pending.md),
  [ADR 0110](0110-submission-consent-is-an-append-only-record-and-anonymous-display-keeps-provenance.md),
  [ADR 0111](0111-third-perspective-lifecycle-and-its-one-public-projection.md),
  [ADR 0115](0115-approved-third-perspectives-publish-from-a-versioned-public-file-and-portable-copies-link-to-them.md),
  [ADR 0177](0177-feature-consent-binds-the-exact-text-and-the-name-and-a-material-edit-needs-renewed-consent.md)

## Context

A feature stays public only while everything that allowed it holds. Admin must be able to say, on every
inbox load, which features must come off and why, without showing a reader's words, and the static page
must stop showing a feature when its inputs disappear even before Admin acts.

## Decision

- **One check, one standing.** `FeatureRecord::hosted_standing(row, post, config, mode)` returns
  `Covered`, `Hidden(reason)` or `MustComeOff(reason)`, checking in this order and stopping at the first
  that fails (the order is the code's, and a test pins it):

  | Order | Standing | Reason | When |
  | --- | --- | --- | --- |
  | 1 | `MustComeOff` | `deleted` | there is no hosted row |
  | 2 | `MustComeOff` | `withdrawn` | the reader withdrew (RD12's `withdraw`), whether or not retention has purged the text since |
  | 3 | `MustComeOff` | `deleted` | retention purged the text, name and consent |
  | 4 | `MustComeOff` | `not-approved` | the row is not approved (pending, rejected, removed) |
  | 5 | `MustComeOff` | `consent-declined` | the reader's consent in effect agrees to no feature |
  | 6 | `MustComeOff` | `text-changed` | the consent names another revision, or the row has another revision, another approved revision or another text digest |
  | 7 | `Hidden` | `source-gone` | everything above holds, and the article it is about is not published now |
  | 8 | `MustComeOff` | `not-approved` | the one projection no longer shows it (hidden kind, another work) |

  What the reader or the editors decided is checked before the article, so a withdrawn, purged or declined
  feature is never reported as merely hidden. `hosted_standing` takes the row's moderation facts and its
  Third Perspective separately (the text is `None` once purged), which is how a withdrawn row is told
  apart from a gone one.

  `Hidden` is a different standing from a take-off: nothing the reader or the editors did has changed, so
  Admin shows no must-come-off banner for it and does not offer to remove it unless the editor wants to;
  restoring the article restores the feature, which is true because every check above has passed. A page check can also hide a feature for `misdated` (below).
  The reason's explanation is fixed text: it carries no id, name or reader words.
- **The static page also refuses a misdated feature.** A feature's day is raised to the day the
  reflection was approved when it is made, so one dated earlier is a hand edit and is hidden
  (`misdated`, never produced by the hosted check). Admin's audit also reads the committed
  `third-perspectives.json` through the page's own `resolve_post` and, when the page would not show a
  feature (reflection not on the file, text digest differs, misdated), reports `mustComeOff` with the
  page's reason, even when the hosted service cannot be asked.
- **The static page checks the same facts it has.** `resolve_post` shows a feature only when the
  published reflection is still in `third-perspectives.json` for that post, the one projection still
  shows it, the digest still matches. Otherwise the feature is absent, and
  the reason is available to a build warning that names the id only.
- **Taking a reflection off takes its feature off.** Admin's existing take-off (withdrawal, deletion
  request, removal, upheld report, retention) calls `FeaturesFile::unpublish_reflection`, which removes
  the published reflection and its feature in one step. A withdrawal by receipt reaches the file as it
  does for a Third Perspective: through the take-off button, then a rebuild (ADR 0115). Until then the
  static page may still show a feature whose hosted copy was withdrawn; the inbox says so and offers
  the one button, exactly as for the reflection itself.
- **A declined feature comes off alone.** Declining consent removes only the feature
  (`consent-declined`); the reflection stays published. Admin's button for it removes the feature
  record and leaves `third-perspectives.json` untouched.
- **A lost source is hidden, not taken off.** If the article is no longer published, the feature is never
  shown (`Hidden(source-gone)`, not a `MustComeOff`), but the record stays so that restoring the article at
  the same address restores the section; Admin may take it off by choice. A reflection about a work that moved is not shown for the same reason the
  reflection itself is not (ADR 0115).
- **Retention.** Expired retention purges the hosted text, name and consent (RD12); the feature is then
  `deleted` and must come off. The file never holds text or a private name, so there is nothing in it
  to expire; its remaining record is a reference, a digest and the editor's note, and
  comes off in the same step.

## Considered options

- **Auto-remove on the next build.** Rejected: the static build cannot see the hosted copy, and a build
  that rewrote committed content would surprise an owner.
- **Keep showing the feature when the source is gone.** Rejected: the reflection is about a work the
  site no longer publishes, and its section target can no longer be checked.
