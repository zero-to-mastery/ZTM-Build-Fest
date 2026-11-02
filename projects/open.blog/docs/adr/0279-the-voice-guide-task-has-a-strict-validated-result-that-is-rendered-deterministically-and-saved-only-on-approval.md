# ADR 0279: The voice-guide task has a strict validated result that is rendered deterministically and saved only on approval

- Status: Accepted
- Date: 2026-10-28
- Parent epic: [#409](https://github.com/journey-to-code-org/open.blog/issues/409)
- Tasks: #455, #456
- Builds on: ADR 0266 (an AI tool proposes, never applies), ADR 0278 (samples as context)

## Context

A voice guide is a description of how the author writes, built from their samples. The provider can propose
one, but a model asked to describe a voice will happily describe a plausible one. What makes a guide worth
keeping is that every claim points at the author's own words. And the author, not the model, decides what is
saved.

## Decision

- **A new Assistant task, `voice-guide`.** Its input is the current guide (if any), the selected samples (read
  by the server, ADR 0278) and a summary of the gaps (ADR 0281); all of it sits under `untrustedData`. The
  trusted part is the engine guide, the task's own instruction and the `voice-guide` skill.
- **The result is strict JSON**:
  `{ sections: [{ id, traits: [{ statement, quote, sample, oneSample }] }], unknown: [string] }`, with no other
  key anywhere. It is validated in the core (`openblog_core::voice::guide`), with no network, before anyone sees
  it:
  - a section id is one of seven fixed ids (`sentences`, `diction`, `structure`, `openings-and-endings`,
    `stance`, `humor`, `habits`), at most once each;
  - `sample` is the file name of a sample that was selected for this request;
  - `quote` occurs word for word (a plain substring, no case or whitespace folding) in the body of that
    sample;
  - sizes are bounded (12 traits per section, 20 unknown items, 300 characters for a statement, a quote or an
    unknown item) and no field has a control character, so a rendered line cannot be split into a new heading
    or instruction.
  A result that fails is rejected whole with one plain sentence naming the first problem, and the Admin shows
  that sentence and no guide.
- **Rendering is deterministic.** `VoiceGuide::render` writes `# Voice guide`, then one `## <heading>` per
  non-empty section in the fixed order (not the provider's), a bullet per trait,
  `- <statement>: "<quote>" (<file>)` with ` (one sample)` appended when `oneSample` is true, and always a
  final `## What is not yet known` section (`_Nothing is flagged yet._` if empty). The same result renders to
  the same bytes.
- **The author approves; nothing is written until then.** `POST /admin/api/assistant/voice-guide` returns the
  validated result, the rendered Markdown, the current guide's text and revision (from the same files the
  Context view saves) and a unified diff of current against proposed. It writes nothing. The Admin shows the
  diff and the Markdown in an editable box with Edit (change the text before saving), Save as portable, Save as
  private and Discard. Save is the existing context save (`PUT /admin/api/assistant/context`,
  `contextType: voice`), with the revision the author last saw, so a guide edited elsewhere in the meantime is
  a conflict and not a silent overwrite. Discard leaves the files as they were.
- **The provider boundary is unchanged.** The route uses the same authentication, CSRF check, credential
  handling, timeout and two-at-a-time limit as review and completion, and resolves samples with the same
  resolver and budget.
- **What the AI cannot do.** It cannot write a file, edit a sample, or choose where the guide goes. A sample is
  quoted and never changed; a rough draft is never proposed for editing.

## Considered options

- **Let the provider return the Markdown.** Rejected: nothing then ties a claim to a quote, and the layout
  would vary from run to run, so a diff against the current guide would be noise.
- **Check quotes with case and whitespace folded.** Rejected: "word for word" is the promise to the author.
  A model that cannot copy a sentence exactly has not read it.
- **Save automatically when the diff is empty or small.** Rejected: the rule is the author's approval, every
  time.

## What would trigger revisiting this

- Authors wanting a section the fixed list lacks: the list is additive, and the schema enum and the renderer
  read the one list.
- Quotes that must span a line break: today a quote is one line.

## Consequences

- A guide saved from a proposal has a quote for every claim, and `(one sample)` marks the ones a second sample
  has not yet confirmed (ADR 0281 reads those markers).
- Provider adapters are unchanged: they only gain the new result type and its schema.

## Amendment: private samples never reach portable context

The proposal records the visibilities of its source samples on a `<!-- openblog:voice-provenance sources=... -->` line under the title and reports `portableAllowed: false` when any sample is private. The Admin disables "Save as portable" for such a guide, and the context save refuses (422) a portable voice guide whose provenance includes `private`, because portable context is git-tracked and the guide quotes samples verbatim.

## Amendment: the proposal is folded into the saved guide (ADR 0288)

The proposal no longer replaces the saved guide. A trait may carry `replaces` (the statement of a saved trait it
changes). The server keeps saved traits the proposal does not address, together with free text, and shows each
changed trait with both texts. The author picks one for each change before saving. Only an exact repeat of a
saved trait may cite a sample that was not selected. See [ADR 0288](0288-a-proposed-voice-guide-is-folded-into-the-saved-guide-on-the-server-and-the-author-decides-each-change.md).
