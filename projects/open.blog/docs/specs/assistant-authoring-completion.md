# Assistant authoring completion

Status: approved from the 2026-10-23 product conversation

## Problem

The Assistant can review a draft and generate knowledge checks, but review findings are read-only,
the Interactions view is still a placeholder, and authors cannot ask for a continuation while they
write. Provider prompts also know only two renderer facts, so otherwise capable models can give
advice that conflicts with open.blog's authoring and publishing contracts.

## Solution

Complete the author-time Assistant with three deliberately bounded workflows:

1. Review findings with exact replacement suggestions can be applied to the unsaved draft and
   immediately undone. Application is local, explicit, source-anchored, and never saves or publishes.
2. Authors can explicitly enable session-scoped AI autocomplete. After a quiet typing interval it
   proposes a short prose continuation beside either writing surface. Tab or an Accept button inserts
   it; Escape, continued typing, provider failure, or a Dismiss button removes it.
3. Every native provider request receives one authoritative engine guide describing open.blog syntax,
   content profiles, rendering behavior, and safety boundaries. The Interactions view becomes the
   home for the existing knowledge-check proposal workflow rather than remaining a placeholder.

## User stories

1. As an author, I want to apply one concrete review suggestion, so that I do not have to copy and
   paste a replacement manually.
2. As an author, I want suggestion application to fail closed when its source passage is stale or
   ambiguous, so that AI output cannot overwrite the wrong prose.
3. As an author, I want to undo the most recent applied suggestion, so that I retain editorial control.
4. As an author, I want applied suggestions to remain unsaved until I press Save, so that review never
   becomes publication authority.
5. As an author, I want to enable autocomplete explicitly for the current editor session, so that my
   unsaved draft is not sent merely because I opened a post.
6. As an author, I want a short continuation after I pause while writing in Visual or Markdown mode,
   so that AI assistance feels available without interrupting composition.
7. As an author, I want continued typing to invalidate an older completion, so that stale text is never
   inserted at a new caret position.
8. As an author, I want Tab/Accept and Escape/Dismiss controls with an announced status, so that
   autocomplete is usable from the keyboard and assistive technology.
9. As an author, I want provider errors and missing configuration to leave ordinary writing untouched,
   so that AI remains optional.
10. As an author, I want selected Assistant context disclosed and used for completion only when I have
    explicitly selected it and enabled autocomplete, so that context sharing stays intentional.
11. As an author, I want knowledge-check generation represented in Interactions, so that Assistant
    workflows have one understandable home.
12. As an author, I want the AI to understand native quiz blocks, runnable code, embeds, profiles,
    scheduling, front matter, and source-preserving Visual mode, so that its output is compatible with
    the publishing engine.
13. As a site owner, I want completion calls to use the same authenticated, credential-safe, bounded,
    concurrency-limited provider boundary as reviews, so that enabling autocomplete does not expose
    keys or create an unbounded paid-request path.

## Implementation decisions

### Suggestion application

- Keep provider output immutable. Apply a finding only when `suggestion` is a string and its exact
  UTF-8 evidence matches the current Markdown at the returned byte range, or occurs exactly once in
  the current Markdown and can be safely re-anchored.
- Perform replacement in Unicode code-point space because server review ranges use code-point
  offsets while browser string indexes use UTF-16 code units. Reject invalid boundaries, absent
  evidence, ambiguous evidence, and overlapping/stale passages.
- Dispatch the editor's normal input path after replacement. Visual mode re-renders from the updated
  Markdown so protected blocks and source preservation keep their existing behavior.
- Maintain an in-memory last-change undo record. Applying, undoing, or accepting a completion never
  invokes Save or Publish.

### Autocomplete

- Add authenticated `POST /admin/api/assistant/complete` using the existing provider selection,
  credential lookup, timeout, concurrency guard, response-size limit, and safe public errors.
- The request contains the bounded unsaved document, a bounded plain-text prefix and suffix around
  the caret, the editor mode, and explicitly selected context IDs. The server reloads selected context;
  the browser cannot submit arbitrary trusted context content.
- Add an `inline-completion` Assistant task and a strict `{ "completion": "string" }` result schema.
  Validate a maximum 2,000 Unicode code points, reject control characters other than whitespace, and
  allow an empty completion.
- Autocomplete is off by default and session-scoped. Enabling it clearly states that the current
  unsaved draft and selected context will be sent after typing pauses.
- Debounce for at least 800 ms, require a meaningful nearby prefix, permit at most one active request,
  and ignore every response whose request generation or captured caret no longer matches.
- In Markdown mode insert at the captured selection. In Visual mode capture a DOM Range in an editable
  non-protected block and insert plain prose at that range. Completion must not synthesize front matter,
  HTML, or fenced blocks.

### Engine knowledge

- Replace the narrow review-only capability list with one versioned authoritative engine guide used by
  review, knowledge-check, and completion prompts.
- Cover native quiz fences, runnable Rust fences, ordinary code options, supported embeds, content
  profiles, Markdown/front-matter ownership, scheduling, citations/references boundaries, and the rule
  that AI output is a proposal which never saves or publishes itself.
- Article and context text remain untrusted data. Engine knowledge and selected skill instructions are
  trusted rules. External research remains off unless a future explicit workflow enables it.

### Interactions

- Replace the placeholder with a concise explanation and a button that opens the existing knowledge-
  check proposal editor. Do not create a second quiz format or generation path.

## Testing decisions

- Test suggestion replacement and stale/ambiguous UTF-8 evidence through exported browser helpers,
  including non-ASCII text and undo state.
- Test completion payload schemas and result validation at the provider-neutral Rust seam, then test the
  authenticated API for missing credentials, concurrency, selected context loading, bounds, and wrong
  result types.
- Test Visual and Markdown acceptance, stale-response suppression, opt-in behavior, keyboard controls,
  and Interactions wiring through the existing Admin DOM harness.
- Assert the engine guide is present in normalized review, quiz, and completion requests and names every
  supported native authoring contract.
- Run the full Rust, web, clippy, formatting, and isolated release-build gates at each stable commit.

## Delivery slices

1. Engine guide and provider-neutral inline-completion contract.
2. Safe review suggestion application and undo.
3. Authenticated autocomplete API and both editor-mode interactions.
4. Interactions integration, documentation, full regression review, and stable release candidate.

## Out of scope

- Autonomous editing, automatic saving, automatic publishing, or applying all findings at once.
- Token streaming, chat, image generation, web research, agents, or background completions when no
  editor is focused.
- Provider model catalog fetching, per-provider prompt tuning, or billing controls beyond debounce,
  concurrency limits, and explicit opt-in.
- Generating arbitrary executable components or bypassing existing Markdown and site validation.
