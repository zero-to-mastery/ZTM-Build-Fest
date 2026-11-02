# ADR 0039: Arranging a shared reflection's series in Admin

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#183](https://github.com/journey-to-code-org/open.blog/issues/183)
- Parent story: [#151](https://github.com/journey-to-code-org/open.blog/issues/151)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

[ADR 0038](0038-shared-publications-join-the-existing-series.md) gave a shared publication an
optional series placement that is bound into every approval, but nothing in Admin could set it.
Coordinators need to choose or start a series, describe its recurring premise, assign the piece and
see the reading order, without a second series concept and without letting any participant change
what the others are approving.

## Decision

- **Who may do what.** Series are site-owned: name, description, theme and cover live in the
  series file. Setting, changing or removing a publication's placement is an arrangement decision,
  held by a new `AuthorizationAction::PlaceInSeries` that targets the publication and is granted to
  Site owners and Coordinators only. Contributors, Editors and Readers do not hold it. Authors
  consent through approval: the placement is shown in the combined preview and bound into each
  approval, so a change drops every approval in the same write. Every participant who can view the
  publication can see the placement. Creating a new series file is a separate
  `AuthorizationAction::CreateSeries`, held by Site owners only.
- **Concurrency.** The record carries `seriesRevision`, a counter that is absent (zero) until the
  first change, so legacy records serialize byte for byte as before. A change names the revision it
  read; any other revision is refused as stale and nothing is written, even when the requested value
  equals the current one. A request that changes nothing keeps the record and its revision.
  `SharedPublication::place_in_series` authorizes, checks the revision and validates in one place.
- **Routes.** `GET /admin/api/collaboration/series?publicationId=` returns the placement, its
  revision, `canPlace`, `canCreate`, whether the piece is published, the series to choose from and
  the order preview; optional `series` and `order` query values preview another choice without
  storing it. `PUT .../series` sets or clears the placement and reconciles approvals (and the
  synthesis attribution, as every metadata change does) in the same transaction. `POST
  .../series/create` adds a series definition. All need the Admin session, writes need CSRF and
  strict JSON with unknown fields refused, and every refusal for an unknown publication, a stranger
  or a missing grant is the same 404. Stale changes answer 409; refusals by rule are 422 and name
  the field and rule, never the value.
- **After publication.** Once the piece is published its placement lives in the Post's front
  matter, so the route refuses changes (409) and the panel only shows it.
- **Public data only.** The series list and the order preview are read from the site as readers
  see it now: no drafts, nothing scheduled for later, and no other shared publication's unsaved
  placement, which exists only in private records. The preview uses the existing ordering
  (explicit positions first with ties by date, unordered parts after, by date) and places this
  unpublished piece as the newest part.
- **References.** Choosing an existing series stores its address (the slug), exactly what an
  ordinary post's `series` holds, so a series whose name differs from its file name is still
  joined. A new title is stored as typed and uses the implicit series until a site owner describes
  it.
- **New series definitions.** A site owner gives a name (the placement title rules) and an optional
  one-line premise of up to 500 bytes. The file is `content/series/<slug>.md` with `name`,
  `description` and the premise as body text with every ASCII punctuation character escaped, so it
  reads as written and never becomes markup. An existing definition at that address is never
  overwritten (409). The candidate is validated and the site rebuilt as a save from the Series
  editor is. An empty series has no public page, index entry or feed, so public output does not
  change until a part is published. Creating a series does not place the piece in it. Editing an
  existing series stays in the Series editor.
- **Admin.** Each Shared reflections card has a Series panel that loads when opened. Everyone sees
  the placement in words and the reading order, with this piece marked in words. Arrangers get a
  labelled form: a series select (not in a series, each existing series with its published part
  count, or a new title), an optional position, "Preview order" and "Save placement". Focus stays
  on the control used; a refused save keeps what was typed, and a stale save also shows the current
  placement beside it. Site owners also get "Add a new series". The copy assumes nothing about the
  people taking part.

## Consequences

- A coordinator who is also an author changes the placement as a coordinator; their own approval
  is dropped with everyone else's.
- Named series templates, theme or cover choices from a shared publication, and editing an
  existing series file from this panel remain out of scope.
