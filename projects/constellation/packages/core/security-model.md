# Security model

Configuration, scene JSON, transforms, mappings, timelines, hierarchy and stories are declarative data. No config/share value is passed to `eval`, `Function` or a dynamic module loader. Executable source, layout and renderer extensions are explicitly registered by trusted application code and have that application's privileges; registration is not a sandbox.

Scene validation rejects non-JSON values, cycles, unsafe object keys, invalid IDs/endpoints/styles, malformed temporal/hierarchical/story/evidence records and bounded-size violations. Scene Evidence stores short scalar claims, not provider payloads; token-like bearer strings are rejected and auth data is never sourced from acquisition state. Renderer text, attributes, icon descriptors and embedded JSON have separate escaping/validation boundaries. Imported component CSS rejects external URLs/imports/escapes/expressions; trusted local CLI/workflow CSS remains supported. CSS can change presentation and should come from a trusted author.

Offline HTML embeds its WASM and includes a hash-based script CSP. It permits WASM compilation, blocks unapproved scripts/event handlers, and denies network fetching by default. Inline styles are required by SVG presentation. Project links permit only HTTP(S), strip no credentials silently, and reject URLs containing credentials. They use `noopener noreferrer`. Runtime metadata and narration use text APIs.

Source fetches run only for configured/registered sources, use cancellation and are subject to the host's CORS/CSP and network policy. Browser config and share links must not contain tokens. The Action obtains its token through the existing environment/input mechanism; `.env` remains ignored. Public-repository filters and organization coverage notes remain part of compilation. Historical metrics are never manufactured.

WASM is required for supported rendering. Missing assets or restrictive policy produce a clear startup failure; there is no alternate JavaScript layout/traversal fallback. Keep the packaged engine assets and MIME types intact.

Tests cover malformed configs/scenes, prototype keys, escaping, safe links, CSP enforcement, module registration boundaries, private repository scope, cancellation, isolated package loading and browser interactions. Bounds are detailed in [scaling](scaling.md), [timeline](timeline.md), [hierarchy](hierarchical-scenes.md) and [Story](story-mode.md) guides.

## The Studio

The Studio (`src/app/`) accepts the same inputs as before the v5.0.0 rebuild and no new ones: a username, settings files, JSON pasted into **Fine-tune**, share links, and saved designs from `localStorage`. Settings files and pasted JSON are limited to 250 KB and go through the configuration parser (`parseConfig`), which rejects future versions and prototype keys and excludes tokens and unknown runtime fields. Every registry setting coerces its value to the control's type and range before it reaches configuration. GitHub data and project names are inserted as text, and the map is SVG produced by the renderer, never HTML built from GitHub data. Downloaded file names are derived from a lowercase slug of the account name. Nothing in **Get it** contacts GitHub; the profile step only opens GitHub pages for the visitor to act on.

## Hosted GitHub sign-in

The Studio uses GitHub App authorization-code OAuth with strong state and S256 PKCE. A separate fixed-origin exchange service holds the client secret. A one-use ten-minute transaction (state and verifier, not access tokens) survives the redirect in sessionStorage. Callback parameters are removed from the URL. The service returns only the access token and never logs credentials; deployment should enforce rate limits.

The session verifies identity through GitHub's user API. Access tokens remain in page memory, outside configs, scene JSON, storage, share links and exports. Sign-out, reload and authenticated 401 responses clear the session. Authenticated browser requests target the exact GitHub API origin with redirects rejected. Public exploration remains anonymous. Localhost has a collapsed **Use a personal access token (local only)** form; server-side .env, CLI and Actions tokens retain their existing behavior. See [deployment and security boundaries](github-oauth.md).
