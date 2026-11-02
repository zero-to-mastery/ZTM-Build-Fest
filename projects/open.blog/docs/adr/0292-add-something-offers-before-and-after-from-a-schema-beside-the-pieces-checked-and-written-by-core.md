# ADR 0292: Add something offers Before and after from a schema beside the pieces, checked and written by core

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#478](https://github.com/journey-to-code-org/open.blog/issues/478)
- Task: [#498](https://github.com/journey-to-code-org/open.blog/issues/498)
- Builds on: [ADR 0291](0291-a-before-and-after-pair-is-a-compare-fence-the-engine-validates-with-two-figures-as-its-portable-form.md), [ADR 0253](0253-pieces-are-validated-data-with-one-form-schema-and-embeds-are-privacy-enhanced-lazy-frames-that-degrade-to-a-link.md)

## Context

Authors add a before and after pair without writing fence syntax. The Add something dialog is built from the
engine's piece schema, which the landing page also uses, and a pair has no landing section.

## Decision

- **A schema beside the pieces.** `GET /admin/api/meta` returns `compare` (`compare::schema_json()`) next to
  `pieces`, in the same field shape. `pieces` still holds exactly the nine landing pieces; the post editor
  shows `[...pieces, compare]` and the landing builder does not see the pair.
- **One check route.** `POST /admin/api/pieces` with `kind: "compare"` runs `compare::from_values`, the same
  parser the build uses, and answers with the fence (`compare::Comparison::to_markdown`) or `422` with every
  problem as a plain sentence. It is the existing authenticated, CSRF-checked, size-bounded route, so no new
  seam is added and nothing is stored.
- **Picture fields have a picker.** A field whose input is `image` is an address field with a file input under
  it. A chosen file goes through the Admin's `upload` route and its returned address is written into the field;
  a failed upload leaves what was there and says so. The dialog never previews unpublished files.
- **Visual mode shows a block.** A `compare` fence is a protected block labelled "Before and after" with an
  **Edit** form built from the same schema. The form opens only when it would write back every line that is
  there; a fence with a field the form lacks, or a repeated field, stays protected as Markdown, and an unchanged
  **Apply** hands back the original text.
- **Errors are inline and at insert.** The dialog checks when **Insert** is chosen, shows the problems inside
  the dialog, keeps what was typed and inserts nothing until the pair is valid.

## Considered options

- **A tenth piece kind.** Rejected: the landing builder and the piece count would change for a thing it cannot
  show.
- **Validating in JavaScript.** Rejected: two sets of rules drift (the lesson of ADR 0287).
- **Checking on every keystroke.** Rejected: a round trip per key for a form that is checked when it is used.

## Consequences

- The Add something list gains one entry in both editor modes; existing pieces are unchanged.
- The dialog works at 400 px: one column, 44 px targets, the file input wraps inside the dialog.
