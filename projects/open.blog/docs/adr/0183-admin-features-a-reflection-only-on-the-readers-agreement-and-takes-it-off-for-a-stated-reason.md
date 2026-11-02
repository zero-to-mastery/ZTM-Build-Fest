# ADR 0183: Admin features a reflection only on the reader's agreement, previews exactly what the page will show, and takes it off for a stated reason

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#229](https://github.com/journey-to-code-org/open.blog/issues/229)
- Parent story: [#205](https://github.com/journey-to-code-org/open.blog/issues/205)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0115](0115-approved-third-perspectives-publish-from-a-versioned-public-file-and-portable-copies-link-to-them.md),
  [ADR 0176](0176-featuring-a-reflection-is-an-editorial-selection-of-one-approved-reflection-with-the-readers-own-consent.md),
  [ADR 0177](0177-feature-consent-binds-the-exact-text-and-the-name-and-a-material-edit-needs-renewed-consent.md),
  [ADR 0178](0178-withdrawal-retention-and-a-lost-source-take-a-feature-off-for-a-stated-reason.md),
  [ADR 0179](0179-taking-a-feature-off-leaves-no-public-tombstone-and-the-moderation-audit-stays-private.md),
  [ADR 0180](0180-a-feature-says-whose-reflection-it-is-and-why-it-is-shown-and-nothing-counts-ranks-or-claims-consensus.md),
  [ADR 0182](0182-a-featured-reflection-stays-in-the-third-perspectives-list-under-its-own-anchor-and-that-lists-counts-stay.md)
- Coordinates with: [#230](https://github.com/journey-to-code-org/open.blog/issues/230) (public section)

## Context

#214 defined what a feature is and when it must come off. #229 is where an editor does it: select an
approved reflection whose reader agreed, say why it is worth reading, see what the page will show, and
take it off when it must or should come off. It reuses RD10's publication file and RD12's inbox and adds
no state, no hosted column and no route that decides anything the pure module does not.

## Decision

- **Only the reader's agreement for this text makes a reflection selectable.** The inbox view gains
  `featureConsent` (`agreed`, `earlier-text` or `not-agreed`, from `FeatureConsent::of`), and the card
  offers Preview and Feature only for `agreed`. Approval never changes it, and an Admin user cannot
  agree for the reader. A reader agrees on the submission form or by their receipt (ADR 0176, 0177). The
  card says in words which case it is, including that an agreement for an earlier text does not cover
  this one.
- **Five Admin routes, all the site Admin's, all deny-by-default.** `GET engagement/community/features`
  (the audit), `POST .../preview`, `.../feature`, `.../note` and `.../unfeature`. Each runs inside the
  existing Admin authentication and CSRF handling, then resolves the reflection's hosted row and requires
  the account to be the site Admin for its work (`feature_target`, `feature_admin`); anything else is
  `403 denied` before any file is read. Choosing needs the `expectedVersion` the editor saw, so a
  reflection that changed (a consent change raises the version) is `409 stale`. Choosing refuses when
  Third Perspectives are off on the hosted side, because the reader's consent cannot then be checked.
- **Choosing is one atomic step under the content lock.** Locks are taken in the existing order (the
  build lock, then the content transaction), the two files are read, `FeatureRecord::new` runs every
  check of ADR 0176 against the published copy, and then the files are written with the safe write
  already used for `third-perspectives.json`: the published reflection first when it was not yet on the
  file (so a feature never stands without it), the feature second. A file that cannot be read is refused
  and never overwritten. A published reflection that differs from the hosted copy (for example a name
  the reader hid since) is `409 publishedDiffers`: Admin does not quietly republish text inside a
  feature; the card's "Republish without the name" comes first (ADR 0177).
- **The preview is the page's own projection and writes nothing.** It builds the record exactly as
  choosing does, adds the reflection to an in-memory copy of the published file when it is not on it,
  and returns `community_feature::project_post`'s `FeaturedPerspective` with the fixed
  `NON_CONSENSUS_NOTICE`. Choosing runs the same `project_post` check before it writes, so a kind that is
  hidden or locked out on the post is `409` for a choice exactly as for a preview. The card renders it as text only (the reader's words, the provenance line, the
  editors' note labelled as theirs); an editor never previews something choosing would refuse, and the
  preview carries no id of a moderator, no consent record and no count, rank or score. #230 renders the
  same value on the canonical page (ADR 0184).
- **The note is the editors' own words, changed without the reader.** `POST .../note` re-runs ADR 0180's
  lint and replaces only the note; the reader's text, the digest and the day featured are untouched.
  There is no reorder: features are listed by the day they were featured and the id, so there is no
  position to set (ADR 0180).
- **Taking off is for a stated reason, or by choice.** The audit checks every feature against its
  hosted row on each load (`FeatureRecord::hosted_standing`, up to 200 at a time) and says `covered`,
  `hidden` (the article is not published now; kept, not a take-off), `mustComeOff` with the fixed reason,
  or `unknown` where the hosted service does not read consent. Admin shows them in a banner on every tab
  and on the reflection's card. `.../unfeature` removes only the feature record; the reflection stays
  published. Taking a reflection off (`unpublish_perspective`) removes its feature first, in the same
  step, so a feature never outlives its reflection. An editor may take a feature off by choice at any
  time; nothing is e-mailed and no tombstone is left (ADR 0179). Removing is always safe, so the site
  Admin of every work may take a feature off or change its note when the hosted service cannot be asked;
  a per-work Admin needs the hosted row to prove the work. The audit then reports what the committed
  file alone shows and `unknown` for the rest, and the banner says the features could not be checked for
  any failure except `403`.
- **The build reads the file strictly.** `community-perspectives.json` is read with the same rules at
  build time: a file that cannot be read refuses the build, naming the item and never its contents, and
  an item about something that is not a post is a warning. The section it feeds is #230 (ADR 0184); a
  site without the file is untouched.
- **Hosted changes are additive.** The one hosted addition is the receipt's `feature` action, which
  reuses the consent-append path and the version raise (ADR 0176); there is no schema change, route,
  environment variable or setting.
- **Nothing a reader sees counts, ranks or claims consensus.** No route, field or message states how
  many reflections were received, approved or featured. The one exemption is the count of Admin tasks
  in Admin's own banner ("2 featured reflections must come off"), shown only to the site Admin and
  never to a reader: it says how much work is waiting, not how well a reflection fared. The editors'
  note is refused when it claims popularity.
- **No manual order or placement.** Issue #229 listed order, reorder and placement. They are replaced by
  the day featured and one placement per reflection: a hand-set order would be an editor ranking
  reflections, which is what ADR 0180 refuses.

## Considered options

- **Let Admin publish and feature in two clicks.** Rejected as the only path: choosing publishes a
  reflection that is approved and shown but not yet on the file, because the editor already decided it
  may be shown, and doing both in one locked step avoids a half-done state.
- **Let Admin edit the reader's text when featuring.** Rejected: ADR 0177; the reader clarifies and
  agrees again.
- **A "featured" column on the hosted row.** Rejected: ADR 0176.
- **An audit that auto-removes features.** Rejected: the static build cannot see the hosted copy, and a
  server that rewrote committed content on a read would surprise an owner (ADR 0178).

## Consequences

- #230 reads `FeaturesFile` and calls `project_post`; it needs no new Admin route.
- A site's committed history shows when features were added and removed (ADR 0179).
