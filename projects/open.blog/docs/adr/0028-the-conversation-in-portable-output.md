# ADR 0028: The conversation in portable output

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#181](https://github.com/journey-to-code-org/open.blog/issues/181)
- Parent story: [#150](https://github.com/journey-to-code-org/open.blog/issues/150)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

ADR 0026 makes the conversation ordinary Post body Markdown, so the portable projection (ADR
0004) already carries it. #181 asks that categories, attribution, order and open questions
survive in every format, that no drafting or approval state exports, and that losses are reported
only for unsupported presentation.

## Decision

- No separate export path. The conversation is exported only because it is body Markdown, and
  only approved items are ever in that Markdown (ADR 0026), so there is no second place where
  private state could be added. Withdrawn, unapproved and edited-away text, item ids, approver
  lists, revisions, digests and tokens have no path to any output.
- Per format: portable HTML keeps the semantic headings, the stable ids and a canonical-page
  link on each heading. Portable Markdown keeps the headings with their `{#id}` anchors. Text
  keeps every heading and attribution as its own line in order, without markers.
  Full-content RSS, JSON Feed and `llms-full` use those projections. Each carries the canonical
  URL, so the canonical `#continuing-the-conversation` fragment is the stable permalink.
- Summary-only feeds export no body, so no conversation: only the summary, title and canonical
  link, exactly as for any post (ADR 0023). Assembly writes an explicit `description` drawn from
  the sections only, so a short piece's summary never runs into attribution headings or half an
  item. The renderer has no special case for the heading: an ordinary post that happens to have
  a "Continuing the conversation" heading is summarised like any other. Search and `llms-full` still index the whole body.
- Loss diagnostics are unchanged: they report unsupported presentation (for example raw HTML or
  media limits) from the projection and destination policies, never anything about the
  conversation's content or authors. Plain prose gives none. Destination plans (DEV, Hashnode,
  Ghost, WordPress, Medium) are computed from the same output, so they carry the conversation
  and never echo its text; Hashnode's payload limit reports an error rather than truncating.
- Failure leaves canonical content and public output unchanged: assembly refuses before anything
  is written (ADR 0022, 0027).

## Consequences

- Golden tests compare the semantic facts in order across HTML, Markdown, text, both feeds and
  llms, and scan every output for private fields.
- Text output cannot show heading levels, so category and attribution lines are distinguished by
  their fixed labels ("Speaking for ...").
