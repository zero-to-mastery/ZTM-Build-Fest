# ADR 0290: A review can cover a selection or a section, and voice match reviews only a passage

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#409](https://github.com/journey-to-code-org/open.blog/issues/409)
- Story: #424 (task #459)
- Amends: ADR 0280 (voice review and voice match)

## Context

Story #424 asks for a `voice-match` skill with "scopes: selection, section". Task #459 adds "No full-document
rewrites". The user benefit is "An author can ask for a passage to sound more like them". ADR 0280 had to give
voice match the `document` scope as well, because the only review entry sent the whole document and the route
refused any skill without `document`. The model then chose which passages to change. The author could not
point at the paragraph they wanted to sound more like themselves.

Skills already declare `selection`, `section` and `document` scopes, and the Assistant's interaction tools
already work from "selected text or the current section". What was missing was a review entry for a passage.

## Decision

- **The review request may carry a bounded passage.** `POST /admin/api/assistant/review` accepts an optional
  `passage: { kind: "selection" | "section", start, end }`. The offsets are zero-based Unicode code points into
  `source.markdown`, the unit findings already use. The server refuses the request with a plain 400 when:
  - any other key is present, or `kind` is anything else;
  - the range is empty, reversed or outside the document;
  - the passage is only whitespace;
  - the passage is longer than 20,000 code points (`MAX_REVIEW_PASSAGE`).

  Without `passage` the request is the whole-document review it always was, byte for byte.
- **A skill must declare the scope it is used for.** A whole-document review needs the `document` scope, and a
  passage review needs `selection` or `section` to match its kind. Otherwise the route refuses with "Selected
  skill does not support review of selected text" (or "of one section", or "complete-document review").
- **The provider sees the passage in place.** The request's `scope` names the kind and offsets. The passage
  text is copied to `untrustedData.source.passage`, and the whole document still travels as untrusted data so
  the provider can read the passage in context. The system instructions add one sentence: review only that
  passage, and every finding's range and evidence must lie inside it. A whole-document request has no such
  sentence and no `passage` field.
- **Findings must fall inside the passage.** The validator takes a supplied range only when it lies inside the
  passage and matches the evidence. Otherwise it looks for the evidence exactly once *inside the passage*. Text
  that also occurs elsewhere in the document still anchors to its place in the passage. If the evidence is not
  found inside the passage:
  - for `voice-match`, the finding is kept as advice and its suggestion is never applicable, the same rule
    ADR 0280 uses for a suggestion that does not anchor;
  - for any other skill, the whole review is rejected ("does not identify one exact range inside the reviewed
    passage"), the same rule that applies to a whole document.

  The voice-match limits from ADR 0280 are unchanged: at most 600 code points, no blank line, under half the
  document, and at most five applicable suggestions.
- **`voice-match` declares `scopes: [selection, section]`.** It no longer declares `document`. `voice-review`
  is unchanged.
- **The Admin review entry.** **Assistant → Review** has a "What to review" choice: **Complete document**
  (the default), **Selected text** or **Current section**. Selected text uses the Markdown editor's selection.
  In the visual editor it uses the remembered selection, mapped into the Markdown with temporary marks, as the
  knowledge-check target does. Current section runs from the heading before the cursor (or the start) to the
  next heading (or the end). A `#` line inside a ``` or ~~~ fence is code, not a heading. Surrounding whitespace is trimmed. A
  skill without the chosen scope is shown as unavailable ("Not for this scope") and is deselected. The
  disclosure names the scope, and the run button names it too (**Review selected text**, **Review current
  section**). An empty selection or an over-long passage is refused in the browser before anything is sent. The
  results, **Apply suggestion** and undo are the existing ones.

## Considered options

- **Send only the passage, not the document.** Rejected: findings are anchored by document offsets, which the
  apply and undo path needs. A provider that cannot see the paragraphs around the passage also gives worse
  advice.
- **Keep `document` on voice match and add the passage as an option.** Rejected: the story says "selection,
  section", and leaving the model to pick passages from a whole document is what #459 rules out.
- **Treat a finding outside the passage as advice for every skill.** Rejected: other skills have always been
  held to an exact anchor, and a finding outside the reviewed passage means the result ignored the request.

## Consequences

- An author can select one paragraph, or put the cursor in a section, and ask voice match for that passage
  alone.
- Project skills that declare `selection` or `section` can now be used on a passage, and a skill that declares
  only `document` works as before.
