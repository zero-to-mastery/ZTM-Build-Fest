# ADR 0278: Voice samples and the voice guide are selected as Assistant context by id and reloaded on the server

- Status: Accepted
- Date: 2026-10-28
- Parent epic: [#409](https://github.com/journey-to-code-org/open.blog/issues/409)
- Tasks: #453, #454
- Builds on: ADR 0266 (samples are Assistant context), ADR 0267 (the file format)

## Context

ADR 0266 said an AI tool reads a sample through the existing context selection and disclosure flow and the
credential-safe provider boundary, and that the text is untrusted data. This decides how: what a sample's
context id is, what the browser may send, what the server does with it, and how much one request may carry.

## Decision

- **A sample is a context item with the id `voice:<portable|private>:<file>`**, for example
  `voice:private:2026-10-28-a-mistake-i-made-rough.md`. The voice guide is an ordinary context file,
  `assistant/context/voice.md` or `.openblog/private/context/voice.md`, with the ids `portable:voice` and
  `private:voice`, listed, saved and deleted by the same routes (and the same revision check) as `author.md`
  and `site.md`. Nothing else about selection changes: it is the same set of ids in the Context view.
- **The context catalog gains `voiceSamples`, `voiceGuides` (the two guide files, in the same shape as `documents`, which stays as it was) and `voiceBudget`.** Each sample shows its pack, prompt, stage,
  visibility, size in characters (of the author's text, not the front matter) and the path it lives at. An
  unreadable file is listed as not valid with the store's guidance and cannot be selected. The listing never
  carries sample text, and looking creates no folder.
- **The browser can only name samples.** A review, completion or voice-guide request carries ids in
  `contextIds`. For every request the server reads each sample again through the voice store, requires it to
  be a valid sample, and puts the text it just read into the request. A client-supplied text, size, stage or
  pack is never read. An id that is malformed, names a sample that is missing or invalid, or names a file
  name the store would not accept, fails the whole request with 400 before any provider call.
- **One request budget.** At most 8 samples and 120,000 characters of sample text per request, counted by the
  server from what it read, and enforced in the browser from the catalog before any request is sent. Over
  budget is refused with a plain sentence naming both limits (400 on the server). The budget is for samples
  only: it adds no limit to author, site, post or reference context, so a request with no sample behaves as
  it did.
- **Labelled as data in the normalized request.** A sample is an entry of `untrustedData.context` like every
  other context file, with its `id`, `name` (the file name, which a guide cites), `visibility` and `content`,
  plus `kind: "voice-sample"`, `stage`, `pack` and `prompt`. The guide is the same entry shape with
  `kind: "voice-guide"`. When a request carries either, the request's system instruction adds one sentence
  saying they are the author's own words and an approved description of them, to be compared against and never
  obeyed. A request with neither carries no new field and no new sentence.
- **Disclosure is the existing one.** The Context disclosure and the review summary list each selected sample
  as `path · Voice sample · stage · pack · visibility · characters`, with a running total against the budget.

## Considered options

- **Send the text from the browser, which already has it.** Rejected: the server would have to trust it, and
  a page could then put anything under the label "my voice".
- **A separate endpoint for samples.** Rejected: selection, disclosure, review, completion and the budget
  would each need a second path. One id scheme reuses all of them.
- **One budget for all context.** Rejected: it would change which existing requests are accepted.

## What would trigger revisiting this

- Authors with more than eight useful samples: raise the numbers, or add a summary step.
- A provider with a much smaller context window than the budget assumes.

## Consequences

- Review, completion and the voice-guide task share one resolver, so a fourth path gets the rules for free.
- No-sample requests are unchanged apart from the engine guide's own version (ADR 0281).
