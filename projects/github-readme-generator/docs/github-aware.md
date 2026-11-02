# GitHub-aware authoring

Use **Repositories** to browse public metadata already loaded by GitHub Autofill or explicitly look up `owner/repository`. Search, language, archived/fork filters and updated/stars/name/created sorting operate locally. Select up to 50 repositories; large results show the first 200, with search available to narrow them. Profile repositories are identified and never selected automatically.

Choose projects, compact/detailed/table/badge lists, links, a saved custom component, or technology suggestions. Confirm technologies and badge types, provide a workflow file for workflow badges, and review source plus sanitized rendering before applying. Previewing remote badges contacts their provider. Homepages are repository metadata, not proof of a working live demo. Languages/topics suggest technologies, never proficiency or roles. Project generation reuses Project Studio and its field ownership model.

Generated repository sections store normalized source snapshots and generation settings in Studio state. README export contains only Markdown/HTML. Existing Custom Markdown is untouched. Applying output is undoable and autosaved. Cached context and generation work offline; new public lookups require a connection. No token, private data, polling, manifest scanning or GitHub write is used. GitHub API errors remain explicit.

## Profile Intelligence

The Profile Intelligence dialog works locally from loaded metadata and current README structure. It suggests missing sections, possible projects to feature, known technology categories and archived status review. Each opportunity explains its source; there is no numeric score or generated prose. Candidate reasons describe stars, recent updates, topics and an unverified repository homepage, never “best projects.” Repository primary languages do not measure proficiency.

Open a relevant builder or review/select public profile links before adding them. Only the email returned publicly by GitHub is offered. Plain company text is not turned into an invented website; an explicit GitHub `@organization` may become a link. Run Autofill again for profiles loaded before this version to obtain the normalized profile snapshot.

Dismissals belong to the current draft and survive backup/reload. They persist until the relevant suggestion context changes (not merely a new star count or timestamp). Reset dismissals explicitly to review them again. README Health retains technical, compatibility and accessibility checks; Profile Intelligence does not repeat its widget clutter or alt-text warnings.

## Repository Health

**Check links** opens an inventory; its Check links action starts network validation. Recheck an item or all results explicitly. Cancel retains completed results. Scans are capped at 300 unique targets, four concurrent requests, ten seconds per target, and a five-minute in-memory cache. No results are treated as permanent. Link checks omit credentials and referrers and do not proxy requests.

GitHub repository URLs use public metadata to show archived status, homepage/default-branch changes against loaded context, and factual update age. Imported relative paths use the public contents endpoint where source context is available. Anchors and mailto links do not trigger network checks. Code examples and HTML comments are excluded. Missing public repositories may also be private; Studio does not attempt authentication.

Other hosts use HEAD, with a GET fallback for 405/501. GET bodies are cancelled rather than downloading large assets. A bounded 64 KB SVG inspection on that fallback can flag possible provider-error text, advisory only. Exposed image content type/size headers can reveal mismatches or files over 5 MB; absent headers and HEAD success cannot prove a valid rendered image. Remote previews themselves may already contact image hosts independently of the explicit checker.

Results distinguish reachable, redirected, not found, timeout, rate limited, blocked by CORS/HEAD policy, and unknown. Browser policy and network errors cannot reliably be separated, so these are not labelled broken. See [MDN Fetch response restrictions](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch) and [GitHub repository endpoints](https://docs.github.com/en/rest/repos/repos). Redirects are reported when exposed by the browser. No scan changes source or blocks export.

## Refreshing

Use [Refresh GitHub data](refreshing.md) to review later metadata changes. Refresh source ownership is separate from README import history. Manual fields and raw edits remain yours; no refresh occurs in the background.
