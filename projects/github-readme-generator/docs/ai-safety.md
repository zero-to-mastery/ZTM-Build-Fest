# Writing assistant safety audit — v1.4.3

## Scope and trust boundaries

Reviewed the optional writing dialog, context projection, prompt construction, provider transport, response staging, diff application and portable exports. This is a code and mocked-request audit, not a certification of any model's resistance to prompt injection.

| Input or operation                                                            | Boundary                                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imported README, repository metadata, comments and style examples             | Encoded inside a user-message JSON object. Never interpolated into system instructions or parsed as message roles. Selected context is reviewed evidence, not instruction authority.     |
| Embedded “ignore instructions”, fake role delimiters or exfiltration requests | System instructions reject rule changes, secret disclosure, URL following and scope expansion. No tool definitions, repository execution or autonomous follow-up requests are available. |
| Provider selection and destination                                            | Explicit UI configuration only; never derived from imported content. HTTPS or loopback HTTP, no URL credentials/query/fragment, no redirects, cookies or referrer.                       |
| API key                                                                       | Memory-only configuration; header only on compatible adapter. Local adapter strips the key. Provider/endpoint changes clear credentials and consent.                                     |
| Response                                                                      | Bounded JSON/text; tool/function calls, refusals and incomplete responses rejected. Displayed as textarea content, not executable HTML.                                                  |
| Document mutation                                                             | Original, Proposed, exact diff and approval; stale-draft guard and Undo. Nothing automatically replaces the document.                                                                    |
| Export                                                                        | Portable credential-field filtering plus configuration kept outside document state. Source export remains verbatim.                                                                      |

## Findings addressed

The request client previously combined transport with wire-specific parsing. These now live behind registered adapters, so a provider protocol can be replaced without changing source editing. Settings explicitly describe where requests go and what key policy applies. An explicit disabled mode supports manual proposals offline.

Portable metadata filtering did not explicitly cover API-key field names. A shared recursive boundary now removes apiKey/api_key/api-key, password, private-key and existing token/authorization fields from project metadata, draft JSON and workspace backups. It does not search or rewrite source strings.

Prompts already separated source data from instructions; the hardened instructions now explicitly cover imported comments, fake role delimiters, secret disclosure and scope expansion. The UI calls selected information “reviewed context” rather than implying imported information is inherently trusted.

## Verification and residual risks

Tests exercise hostile role delimiters/comments, context preservation without extra roles, disabled/unknown providers with no fetch, local-host restrictions and no key forwarding, response tool-call rejection, nested credential filtering, provider switching, offline manual review and inert hostile proposals. Browser checks run against Chromium, Firefox and WebKit with mocked providers; no paid/live model calls are needed.

Prompt wording cannot guarantee model obedience or factual accuracy. A malicious document can still influence generated text. Users must inspect links, claims and commands before Apply; ordinary preview sanitization does not certify external links or code as safe. A provider receives the explicitly approved input and may retain it under its own policy. Cancellation cannot recall data already sent. Browser extensions or an already-compromised page can access in-memory keys. Secrets pasted into Markdown or notes remain user content and may be exported or transmitted when selected; the portable field filter is not a general secret scanner.
