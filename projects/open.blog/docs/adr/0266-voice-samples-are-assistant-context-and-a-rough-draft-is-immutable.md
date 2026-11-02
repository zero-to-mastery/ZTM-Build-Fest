# ADR 0266: Voice samples are Assistant context and a rough draft is immutable

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#429](https://github.com/journey-to-code-org/open.blog/issues/429)
- Parent story: [#411](https://github.com/journey-to-code-org/open.blog/issues/411)
- Parent epic: [#406](https://github.com/journey-to-code-org/open.blog/issues/406)
- Builds on: ADR 0264 (private storage under `.openblog/private/`)

## Context

The Assistant's `voice-review` skill asks for "explicitly supplied voice context", but nothing produces it.
Authors paste ad-hoc notes. The voice-samples family (epics #406 to #410) captures the author's own unedited
writing so that the CLI, Admin and the Assistant read and write the same files. The words must be settled
first, and so must the rule everything else leans on: the author's rough words are never touched.

## Decision

- **A voice sample is Assistant context, not a Post.** It lives beside the existing context files, in
  `assistant/context/voice/` (portable, may be committed and shared with the project) or
  `.openblog/private/context/voice/` (private, ignored by Git and never staged by publishing). It is never
  published, built into the site, added to a feed, a sitemap or a search index, or put in `dist` or a portable
  export. A build reads only the content folder, so this needs no new filter, and a test proves it.
- **Two stages.** A **rough draft** is written against the clock and locked when the session ends. A
  **polished draft** is the author's own revision of exactly one rough draft and says so with `roughOf`.
- **The rough stage is immutable.** From the moment the session ends, nothing in the product edits,
  corrects, normalizes or re-saves rough text: not spell-check, not autocorrect, not an AI tool, not a restore,
  not a "save" button. This is enforced where the bytes are written, in the store (`voice_store.rs`): a rough
  file is created once, never replaced, and any later write to its path is refused with a plain sentence. The
  surfaces additionally show it read-only, but they are not what protects it. The author may still read it,
  move it between portable and private (a byte-for-byte copy), or erase it.
- **The polished stage is author-owned.** Only the author's own save writes it, with a revision check. An AI
  tool may propose changes to a polished draft as text; it never applies them.
- **Private by default.** A new sample is private unless the author chooses portable. Moving a sample moves
  its rough and polished files together so a pair never straddles the two.
- **Sample text is untrusted data.** When an AI tool reads a sample it goes through the existing context
  selection and disclosure flow and the credential-safe provider boundary; the text never becomes
  instructions.
- **Opt-in.** `openblog init`, builds, publishing and the existing Assistant workflows are unchanged when no
  sample exists. Nothing creates a voice folder until the author writes a first sample (tested).
- **Line endings are normalized once, before the lock.** A CRLF draft, or one with a lone CR, is stored with LF endings. That is the
  only change ever made to the text, and it is made on the way in, while the session is still open, so the
  locked text is the stored text.

## Considered options

- **Samples as posts with a flag.** Rejected: a post can be built, fed and exported by mistake, and a flag is
  one bug away from publishing someone's private practice writing.
- **Make immutability a UI rule.** Rejected: Admin, the CLI and the Assistant would each have to remember it,
  and a bug in one would rewrite the author's words. The store is the one place all of them pass through.
- **Allow edits to rough text with history.** Rejected: the value of a rough draft is that it is unedited;
  a history of edits would make "what did I actually write" an open question.

## What would trigger revisiting this

- Authors asking to fix a typo in a rough draft. The answer is a polished draft, which exists for that.
- A hosted store for samples. That is a new decision with its own privacy review (ADR 0267 keeps the format
  portable so it can move).

## Consequences

- The store, not the callers, owns the rule; new surfaces get it for free.
- The terms are in [CONTEXT.md](../../CONTEXT.md#voice-samples). The file format and session record are in
  [ADR 0267](0267-the-voice-sample-file-format-and-session-record-are-versioned-flat-markdown-and-json.md).
