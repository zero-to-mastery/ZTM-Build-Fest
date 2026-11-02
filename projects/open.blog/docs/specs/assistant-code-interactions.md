# Assistant runnable examples and coding challenges

Status: approved from the 2026-10-24 product conversation

## Problem

Assistant Interactions can propose only multiple-choice knowledge checks. Authors teaching technical
topics also need useful code interactions throughout a post, but asking a model for arbitrary
interactive syntax would conflict with open.blog's actual renderer. The publishing engine currently
supports reader-editable execution only for self-contained Rust fences marked `runnable`.

## Solution

Expand Assistant Interactions with one source-preserving code workflow that produces either a
complete runnable Rust example or a small Rust coding challenge. Both are grounded in selected text
or the current section, returned through a strict provider-neutral schema, shown in an editable
proposal dialog, and inserted only after author approval. Coding challenges combine ordinary
portable Markdown instructions with the engine's existing runnable Rust fence rather than adding a
second challenge language or execution service.

Update Learning design review so it can identify appropriate locations for knowledge checks,
runnable examples, or coding challenges. Review findings remain advice; authors use Interactions to
generate and inspect the actual code proposal.

## User stories

1. As a technical author, I want AI to suggest runnable examples as well as quizzes, so that an
   article can teach through practice instead of recall alone.
2. As a technical author, I want a coding-challenge option, so that readers can complete a bounded
   exercise while they read.
3. As an author, I want generation grounded in selected text or the current section, so that the
   proposed interaction fits the nearby lesson.
4. As an author, I want to edit the title, instructions, code, expected result, hint, and explanation
   before insertion, so that AI never becomes publication authority.
5. As an author, I want non-AI code-interaction authoring to remain available, so that provider setup
   is optional.
6. As an author, I want invalid, oversized, or structurally unsafe provider output rejected as a
   whole, so that malformed code fences cannot enter my draft unnoticed.
7. As an author, I want insertion to work from both Visual and Markdown modes and return focus to the
   visible writing surface, so that the workflow is keyboard and screen-reader usable.
8. As a site owner, I want code generation to reuse the authenticated, credential-safe, bounded, and
   concurrency-limited Assistant provider boundary, so that the new workflow does not expose keys or
   create an unbounded paid-request path.
9. As a reader, I want generated examples and challenges to use the existing runnable Rust component,
   so that Run, Reset, Copy, output, privacy messaging, and fallback behavior stay consistent.
10. As an author, I want Learning design review to distinguish quizzes, runnable examples, and coding
    challenges, so that interaction advice is not limited to one teaching pattern.

## Implementation decisions

### Provider contract

- Add a `code-interaction` Assistant task with a requested kind of `example` or `challenge`.
- Use the existing bounded article excerpt source, configured provider, timeout, credential lookup,
  native structured-output adapters, generic HTTPS adapter, and global Assistant concurrency limit.
- Require exactly one result object containing `kind`, `title`, `instructions`, `code`,
  `expectedOutput`, `hint`, and `explanation`. Every field is a string and every unknown field is
  rejected.
- Require the returned kind to match the requested kind. Bound all prose and code, reject control
  characters and fence delimiters that could escape the authored block, and require non-empty title,
  instructions, and Rust code. A challenge also requires an expected result and a visible TODO marker
  in its starter code.
- Include the authoritative engine guide in the normalized request and explicitly state that the only
  executable target in this release is self-contained stable Rust through the official Playground.

### Admin workflow

- Add **Create runnable-code proposal** beside the knowledge-check action in Assistant Interactions.
- Open an editable dialog with an Example/Challenge choice and the proposal fields. The same dialog
  works without AI; generation is an optional action when a provider is ready.
- Resolve the insertion target from the current Visual or Markdown selection through the existing
  source-preserving marker translation. If there is no selection, send the current section, falling
  back to the document.
- Insert portable prose plus one `rust runnable` fence. Examples insert a complete program and an
  optional explanation. Challenges insert instructions, an expected result, starter code, and an
  optional TIP callout. The author must press Insert; generation alone never mutates the draft.
- Dispatch the normal input/dirty/preview path, re-render Visual mode, return to Write, and focus the
  visible editor after insertion.

### Review guidance and capabilities

- Update the built-in Learning design skill to consider three interaction types and to explain why a
  specific location and type improves the lesson.
- Extend safe provider capability status with code interactions and extend the engine guide without
  claiming support for languages or validation the renderer does not provide.

## Testing decisions

- Test request normalization, strict schemas, bounds, kind matching, fence rejection, and challenge
  requirements at the provider-neutral Rust seam.
- Test the authenticated endpoint for request bounds, missing configuration, concurrency, exact
  result type, and the unsaved selected/current-section excerpt.
- Test the mounted Admin action, editable proposal formatting, explicit insertion, non-AI path,
  Visual selection preservation, and input/focus behavior through the existing DOM harness.
- Assert Learning design and the engine guide name runnable examples and coding challenges without
  promising unsupported execution.
- Run the complete Rust, browser, documentation-link, formatting, clippy, and locked release-build
  gates before delivery.

## Delivery slices

1. Provider-neutral code-interaction task, validation, engine guidance, and authenticated endpoint.
2. Editable Admin proposal workflow for examples and challenges, including Visual/Markdown insertion.
3. Learning-design guidance, documentation, complete regression review, and stable commits.

## Out of scope

- Executing JavaScript, Python, shell, or arbitrary project repositories in the browser.
- Multi-file codebases, dependency installation, containers, hidden tests, grading, score tracking,
  reader accounts, or persisted reader submissions.
- AI-generated execution, automatic insertion, automatic saving, automatic publishing, or bypassing
  the existing Rust Playground privacy and timeout boundary.
- Claiming that generated code compiles, is secure, or is factually correct before author review.
