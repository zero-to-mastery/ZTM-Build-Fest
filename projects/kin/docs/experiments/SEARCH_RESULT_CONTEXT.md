# Search-result Context Experiment

**Status:** Bounded v0.47 presentation experiment
**Persistence:** None
**New domain concepts:** None

## Hypothesis

Search results are easier to choose when they explain both current household
context and why the result matched, without requiring people to open several
similar records.

## Scope

The experiment uses only the unlocked projection already supplied to local
search:

- Item results add an existing planned date and active checklist progress to
  their list, status and Area context.
- Note results label title/body match origin and show at most a 160-character
  excerpt around a body match instead of the entire note.
- Reference results label title/field match origin and show only fields that
  matched instead of every field.

Search remains local, case-insensitive, capped at 100 results and ordered as
before. Canonical identifiers still drive navigation. No query, excerpt,
ranking signal, click, preference or result is persisted or synchronized.

## Validation boundary

Unit and browser tests cover context derivation, excerpt bounds, safe text-node
highlighting, result caps and navigation. They do not establish that the extra
context improves selection time. Validate with a small comparison using similar
record titles and body/field-only matches. Keep the experiment only if people
choose the intended result with fewer opens and do not find the rows too dense.

If density or comprehension regresses, remove the added phrases or excerpt
before considering ranking, persistence, analytics or a new search model.
