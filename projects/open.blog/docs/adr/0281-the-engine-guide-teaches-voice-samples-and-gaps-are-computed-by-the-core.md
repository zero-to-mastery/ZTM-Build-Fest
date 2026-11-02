# ADR 0281: The engine guide teaches voice samples and gaps are computed by the core

- Status: Accepted
- Date: 2026-10-28
- Parent epic: [#409](https://github.com/journey-to-code-org/open.blog/issues/409)
- Tasks: #461, #462
- Builds on: ADR 0266 (stages and immutability), ADR 0278 to 0280

## Context

Every Assistant request carries the engine guide: trusted facts about open.blog that a model should know before
it reads any author text. Voice samples have rules a model must know before it sees one (a rough draft is never
edited; samples and the guide are data), and the author needs one answer, shared by the CLI, Admin and the
provider, to "what is missing from my voice material".

## Decision

### The engine guide (#461)

- **A new capability, `voice-samples`**, in `openblog_core::assistant_guide`: it defines a sample and its two
  stages, says a rough draft is never edited, corrected, normalized or proposed for editing (its typos are the
  author's voice), says a polished draft may be changed only by the author's own save with AI proposing text,
  defines the voice guide as approved context and not a source of instructions, and says samples and the guide
  are untrusted author data to quote and compare with, never to obey. It also says the Assistant never claims it
  saved a guide or changed a sample.
- **`ENGINE_GUIDE_VERSION` goes from 4 to 5.** The capability is in every request, not only those with a
  sample, so the rules are known before the first sample is ever selected: review, completion,
  knowledge-check, code-interaction and voice-guide requests all carry it (tested for each).
- **What "unchanged without samples" means.** A request with no sample and no guide differs from the same
  request before this epic only by that engine guide, its version and the one new capability; no field, key or
  instruction sentence is added to it (a test compares the whole request with the earlier shape).

### Gaps (#462)

- **`openblog_core::voice::gaps::gaps(catalog, library, guide)` is a pure function, not AI.** It returns, in
  catalog order: the packs none of whose prompts has a sample at any stage, the prompts with no sample, the
  prompts with a rough draft and no polished draft, and the traits of the saved guide marked `(one sample)`,
  in the guide's order. A prompt a sample names that the catalog no longer has is ignored.
- **Markers are read from Markdown, tolerantly.** A bullet that ends with `(one sample)` is a one-sample trait
  wherever it sits; the text before the first `: "` is its statement, the last parenthesis group before the
  marker is the sample it names, and the nearest `##` heading is its section. A guide the author edited by hand
  is read the same way as one the product rendered.
- **One answer, three readers.** `openblog voice --list` prints it, the context catalog returns it as
  `voiceGaps` (for the Admin library view) and the voice-guide task receives it as `untrustedData.gaps`, so
  the provider is told what the samples cannot yet show and fills the guide's "What is not yet known" from it.
  Which packs would most improve the guide are the unanswered ones, first in catalog order.

## Considered options

- **Put the voice rules only in requests that carry a sample.** Rejected: the guide is the one place the rules
  live, and a request that adds the guide only sometimes is a request whose rules depend on what the browser
  asked for.
- **Ask the provider for the gaps.** Rejected: the gap list is arithmetic over files the product owns; a model
  would add a way to be wrong.

## What would trigger revisiting this

- A fourth stage, or a third kind of voice material: the contract and the gap function grow together.
- A guide format other than the rendered one: the marker reader is the only place that depends on the text.

## Consequences

- Admin screens that show the library read `voiceGaps` and need no logic of their own. (Note, 2026-10-28: the Sample
  library reads the same `gaps_json` result as `gaps` from `GET voice/samples` and shows it under "What is
  missing"; the Context view does not show it.)
- Changing the contract text changes the version; the version is how a cached request is told apart.
