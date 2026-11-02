# Writing Assistant

Version 1.4.3 adds provider selection and safety hardening to optional, context-aware AI editing. README Studio's editor, builders, preview, exports and local recovery still work without an AI account, connection or model.

## Roadmap certification

Release 1.9.21 certifies the shipped workflow against Epic 09. Story #100 and tasks #160/#161 are covered by the allowlisted context projection, grounding instructions, a conservative response support check, hostile-context and unsupported-claim tests, plus the mandatory Original → Proposed → Diff → Apply boundary. Story #101 and tasks #162/#163 are covered by a shared compatible/local adapter conformance matrix, malformed/refused/tool/partial/empty/oversized response tests, network and timeout failures, and the provider-disabled manual path. Story #102 and tasks #164/#165 are covered by exact message preview equality, destination/key-policy disclosure, explicit consent, memory-only credential isolation, provider-change cleanup, explicit-cancellation cleanup and stale-result browser tests.

All network and model results in automated checks are mocked. This evidence certifies README Studio's request boundaries and failure behavior, not live provider availability, retention policy, model quality or universal resistance to prompt injection. Ordinary editing, recovery and export remain local-first; applying any proposal still requires exact diff review.

## Original → Proposed → Diff → Apply

1. Select text in the Markdown editor, then open **Review → Writing assistant** (also available in workspace search).
2. Confirm **Content to edit**. Choose selected text, a named Markdown section, or **New section at cursor**. The exact affected source appears under **Original**. For an empty insertion, choose **Draft section** and supply factual notes.
3. Choose an action: Draft section, Improve wording, Shorten (long → short), Expand, Make more technical, Make more casual, Turn notes/paragraph into bullets, Turn bullets into paragraph, Grammar cleanup, or Technical notes → README summary.
4. Optionally add facts or instructions. Configure a trusted chat-completions endpoint, its model identifier and an API key if required. Confirm the content being sent, then choose **Generate proposal**.
5. Inspect and edit **Proposed**. Generation never changes the draft. You can also paste a proposal manually without connecting AI.
6. Choose **Review diff**, inspect the complete current/resulting README and line diff, approve the exact change, then **Apply**.

Changing the proposal or inputs invalidates approval. A draft changed elsewhere cannot be overwritten: reopen the assistant against the current draft. Applying replaces only the chosen range; surrounding source remains exact. Check heading spacing when drafting at the cursor. The existing source-edit path turns only the builder, component or generated sections whose lines change into Custom Markdown, so stale settings cannot overwrite edits, and names them in the status; untouched sections keep their ownership. Undo restores source and ownership. AI metadata is not embedded in exported Markdown.

The assistant requests fact-preserving edits but cannot guarantee correctness. Review claims, URLs, commands, code and placeholders. Expansion is not permission to invent project capabilities or developer proficiency.

## Optional connection

Select **Provider**: **Chat completions compatible provider**, **Local chat completions server**, or **No AI — manual writing**. The compatible adapter may require a key depending on the chosen server; Studio cannot determine a remote server's authentication policy without contacting it. The local adapter permits only loopback hosts and never sends a key. No-AI mode disables transmission while leaving manual Proposed/diff/Apply available. Switching providers cancels pending requests and clears the key and consent. The selected mode remains in tab memory until reload.

The destination summary names the adapter, endpoint and key policy. The exact message preview lists all transmitted content, including selected context. Nothing is sent just by opening or configuring the assistant. **Forget connection** also selects no-AI mode.

Provide the **full endpoint ending in `/chat/completions`**, such as a local server's `http://localhost:1234/v1/chat/completions`, and a model that server actually provides. No model or paid provider is selected automatically. HTTPS remote endpoints and HTTP loopback endpoints are supported. Browser CORS access must be enabled by the endpoint operator; Studio cannot bypass it.

The adapter uses the [documented chat-completions message format](https://developers.openai.com/api/reference/cli/resources/chat), non-streaming text, `store: false`, and an 8,192 completion-token limit. Compatible providers must accept those fields and return a complete text choice with `finish_reason: "stop"`. Tool calls, refusals, partial/truncated or empty responses are rejected. Not every provider or model implements this subset identically. Automated tests use mocked responses; no paid provider availability or live model quality is certified by the release checks.

Connection settings and keys live only in this tab's memory. They never join drafts, local storage, backups, project files or exports. **Forget connection** or reload clears them; changing endpoint clears the key and consent. For shared deployments, use your own secured gateway and keep operator secrets server-side. Never ship a shared API key in a public frontend. A user's entered key is accessible to that browser session, its developer tools and extensions.

Only Original, optional notes, explicitly selected context and fixed editing instructions are sent after confirmation and Generate. No surrounding README, other drafts or repository metadata is included automatically. Provider retention/billing rules still apply; `store: false` is a request, not a guarantee about an external service. No source or response logging is added by Studio.

## Limits and recovery

- Original plus notes and serialized context: 32,000 characters. Choose a smaller selection for large READMEs.
- Proposed Markdown: 64,000 characters; provider JSON response: 512 KB maximum.
- One request at a time, 60-second timeout, no automatic retries.
- Cancel request or close the dialog to stop waiting. Late responses cannot overwrite a locally edited proposal.
- Authentication, missing model/endpoint, usage limits, malformed responses and network/CORS failures leave the draft untouched.
- Manual proposal editing and review work offline once the app is loaded. Remote generation requires connectivity; local models depend on local server/browser access.

Source proposals are displayed as text, never executable HTML. After Apply, the normal preview sanitizer still applies; exported source remains ordinary user-controlled Markdown.

## Trusted context (1.4.1)

Seven optional sources appear in the assistant, all unchecked each time it opens:

- **GitHub profile:** allowlisted facts from this draft's previously imported public profile snapshot; excludes email, credentials and repository lists.
- **Selected repository:** choose one already loaded public repository. Only its displayed fields are available; no new fetch occurs.
- **Project type:** this draft's chosen documentation type, editable before inclusion. A type describes intent, not proof of features.
- **Stack DNA:** existing session evidence for the chosen repository only, with observation time/status and the distinction between detection and proficiency. Missing scans remain blank; they are not inferred or fetched.
- **Project metadata:** reviewed repository-builder fields from this draft. These do not silently change when another context repository is chosen.
- **Selected section:** choose one Markdown section. When editing a smaller text selection this can explicitly supply surrounding section text. No other sections are sent.
- **Current writing style:** editable tone guidance referencing Original; paste a style sample if desired. Style context is not factual evidence.

Inspect/edit each text field before checking **Include**. Blank sources can receive manually supplied facts; checked empty or oversized sources block generation. Sources are not independently certified as true: trust is your explicit choice. Refresh stale GitHub evidence through the normal workflows first.

**Exact messages to send** displays the actual system and user messages, including Original, notes and only checked context. No hidden workspace context is added. Model and request flags are described separately; the API key stays outside the preview in the Authorization header. Changes clear send consent, cancel in-flight generation and invalidate the proposal/diff approval. Switching repository clears its repository/Stack DNA selections; switching target section clears selected-section inclusion. Reopening starts all sources unchecked again.

The grounding prompt requires factual claims to be supported by supplied Original, factual notes or selected factual context. Unsupported claims must be omitted, not filled from outside knowledge. All context is treated as data, not system instructions; style guidance cannot establish facts. After generation, a local support check names the approved evidence sources. A statement is unflagged only when it matches a non-struck statement in one approved source; paraphrases, cross-source recombinations, changed relationships, contradictions and retracted evidence all require explicit human confirmation. To fail closed on ambiguous, malformed or nested deletion markup, evidence after the first tilde or raw `<del>`/`<s>` opening in a source is not used for support. This intentionally conservative check can flag valid evidence or rewrites and cannot prove factual truth, so inspect every flag, Proposed and Diff before Apply. Invalid or oversized selected context makes the check unavailable and blocks diff review until corrected. Tests inject novel, negated and entity-swapped mocked output and verify the visible flag; they do not claim universal model compliance.

Choosing **Cancel request** aborts the request and clears the in-memory API key, send consent, factual notes, selected context, exact outbound preview and pending comparison state. Closing the assistant performs the same sensitive-state cleanup. README Source is never changed by cleanup.

Each selected context source is limited to 12,000 characters; serialized selected context to 16,000; total Original/notes/context to 32,000. Oversized context is shown intact and rejected until you explicitly shorten or deselect it. No silent truncation or upload of whole drafts/workspaces.

## Rewrite & Compare (1.4.2)

Choose **Generation mode → Compare Concise, Technical and Friendly** to request three alternatives. The chosen writing action applies to each version; each gets a different style instruction but identical Original, notes and checked context. **Exact messages to send** shows all three labeled requests before you confirm and Generate. Single proposal remains the default.

Comparison may incur up to three provider charges. Requests run sequentially, with no automatic retry. If one fails, remaining requests stop and completed versions remain selectable. Cancel stops waiting and suppresses late output; completed versions remain available. A new generation starts a new comparison. Provider availability and model quality remain external.

The alternatives appear side by side on desktop and stack on narrow screens. Their source is inert text. **Use Concise**, **Use Technical** or **Use Friendly** copies that version into Proposed; it does not apply anything to the README. You can edit or combine wording in Proposed, then review the exact full-document diff and explicitly Apply. Choosing another alternative clears prior approval. Undo restores the prior README after Apply.

Different prompts encourage distinct alternatives but cannot guarantee them. Studio warns about exactly identical returned text (ignoring surrounding whitespace) and never relabels one output as three generated versions. Changing Original's scope, notes, action, mode or context clears stale comparisons and consent.

Transformations are available from **Writing action** in either mode:

- **Shorten (long → short)** retains essential facts while reducing length.
- **Turn notes/paragraph into bullets** organizes supplied prose as Markdown bullets.
- **Turn bullets into paragraph** produces connected prose.
- **Technical notes → README summary** explains purpose clearly from supplied technical facts, omitting unsupported claims.

Factual grounding, request limits and Original / Proposed / Diff / Apply apply equally to every alternative. Nothing depends on AI for ordinary editing or exporting.

## Imported content and safety

Repository descriptions, README text, comments and style samples are untrusted data even when selected by you. They cannot configure a provider, authorize transmission or invoke tools. Prompt instructions explicitly reject embedded attempts to reveal secrets, expand scope or follow URLs. Models can still follow malicious instructions or produce misleading text: review every proposal. See the [safety audit](ai-safety.md) for boundaries, tests and limitations.
