# Security boundaries

## Source and preview

Markdown is untrusted input. The preview renders locally and sanitizes its HTML through DOMPurify and the shared URL-safety boundary. Script-bearing HTML, event handlers and dangerous URL schemes are removed from the preview. Sanitization never rewrites the user's Markdown. Export intentionally preserves source, including unsafe examples or markup: sanitize again if you later render that source in another application.

Analysis and deterministic refactors inspect text; they do not execute it. Applying a refactor requires source review and an explicit action. Structured metadata is not executable code. Imported metadata is escaped before display; imported source follows the same preview sanitizer as typed source.

Portable extension manifests are data, not plugins. Their allowlisted capabilities describe local Markdown interpolation, fields and optional external media; they do not grant network, storage, DOM or code-execution access. Recursive validation rejects executable fields and active markup before review. The import trust review names provenance, capabilities and external URLs; importing remains offline, while explicitly rendering remote media may contact its host.

## Generated assets and workflows

Banner SVG comes from bounded, validated settings and escaped strings. The generator does not accept arbitrary SVG, external fonts, scripts or `foreignObject`. Generated-asset publishing independently regenerates the expected SVG on the server. Workflow generation validates paths, schedules and provider settings, uses secret-name placeholders and shows requested permissions. Explicit user-supplied commands are executable **when the workflow is run on GitHub**, not in Studio; inspect them before committing.

## Optional GitHub publishing

The optional same-origin Node service keeps GitHub credentials in ephemeral server sessions. The browser receives an HttpOnly/Secure/SameSite cookie and holds a CSRF nonce in memory. State-changing requests require the configured origin and nonce. The server uses a fixed host/operation allowlist, validates targets and permissions, and checks remote SHAs before writes. Workflow writes require an additional server opt-in and permission.

Draft autosave is never a GitHub write. Every publishing review starts in Read-only mode: the confirmation and publish controls are not rendered until a read-only Preflight for the exact target passes every blocking check (service, session, app installation, Contents: write, push access, not archived, branch exists, supported path and, for workflows, server opt-in plus Workflows: write). The server re-runs the same checks before each write. Branch rules are advisory warnings; GitHub's own refusal at write time is final. Preflight results stay in memory and are never stored. Publishing requires a reviewed repository, branch, path, diff, message and an explicit Publish approval of one Change set, which any change withdraws. Each write carries its Base SHA and the Result SHA of the reviewed content. The server recomputes the Result SHA and refuses a mismatch, and it refuses a create when the file already exists. There is no force, delete or ref-rewrite path. Asset batches are separate commits and can partially succeed; the UI reports each outcome and stops on failure. Conflicts require a fresh review. See [publishing setup](github-publishing.md) for session expiry, limits and deployment responsibilities.

Disconnect destroys the server session; it does not revoke the GitHub App grant. Manage or revoke that grant on GitHub. Tokens must not be placed in frontend environment variables, source, URLs, workflows, backups, logs or project metadata. Studio does not scan arbitrary user-authored README text for secrets; review what you choose to export or publish.

## Local data and external services

Browser drafts and libraries are local, unencrypted data available to software with access to that browser profile. Clearing site data can remove them. Download backups and keep sensitive information out of READMEs. Storage failure opens a recoverable/temporary workspace instead of silently overwriting unreadable originals.

Previewing remote images contacts their hosts and can disclose IP address and URL parameters. External widgets and badges remain third-party services; Studio does not proxy their traffic. Follow links to their upstream documentation and inspect generated markup. See [privacy](privacy.md).

## Reporting a vulnerability

Use the repository's private **Report a vulnerability** route on [GitHub Security](https://github.com/mnichols08/readme-studio/security) when available. If private reporting is unavailable, open an issue asking the maintainer for a private contact channel without posting exploit details, credentials or private README content. Do not test attacks against other users' deployments or repositories.

Automated security fixtures and mocked publishing tests do not constitute an independent security audit. Production HTTPS/proxy configuration and a real GitHub App installation require separate operator verification before public publishing is enabled.
