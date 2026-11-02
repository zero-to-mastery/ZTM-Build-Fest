# GitHub publishing

Publishing is optional. Static hosting (including GitHub Pages and ordinary Netlify builds) keeps every local editing/export feature and displays a setup message instead of pretending authentication is configured. No real GitHub writes are performed by the test suite.

## Server setup

The optional, dependency-free Node 22 service serves `dist` and a small same-origin `/api/publishing/` boundary. Build with `npm run build`, then run `npm run serve:publishing` behind an HTTPS reverse proxy. Set **server-only** environment variables:

- `PUBLISH_ORIGIN`: exact public HTTPS origin, for example `https://studio.example.com` (no trailing slash or subpath).
- `GITHUB_APP_CLIENT_ID`: the registered GitHub App client ID.
- `PORT`: optional loopback service port, default 8787.

Register a GitHub App with repository **Contents: read/write** and **Metadata: read**, enable device flow and expiring user access tokens, and install it only on selected repositories. Add **Pull requests: read/write** only if the deployment should create reviewed draft PRs; file publishing works without that additional permission. No organization/admin permissions, private key, client secret, PAT field, or frontend environment variables are needed. Keep the backend on loopback behind the proxy; do not log request bodies, cookies, authorization headers, or authentication responses. Apply deployment-level connection/rate limits. A public deployment requires the operator to register/install this app and configure HTTPS; this repository does not contain credentials or a deployed authentication service.

## Authentication boundary

Connect GitHub displays a short-lived user code for GitHub's device authorization page. Check authorization after approving on GitHub. Only approve a code you requested in Studio; never share it. This extra step deliberately avoids authorization-code callback URLs and client secrets in a static bundle. GitHub recommends web flow for browser applications; this implementation uses its supported device flow to meet the no-code-in-URL boundary. See [GitHub's user access token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

Access tokens and pending device codes live only in server memory. Refresh tokens are discarded. The browser receives an opaque `HttpOnly; Secure; SameSite=Lax` session cookie, plus a CSRF nonce held only in the publishing component. POSTs require the exact configured Origin and nonce. Sessions expire after at most one hour; a restart signs everybody out. Disconnect immediately deletes the server session; it does not uninstall/revoke the GitHub App grant (manage that on GitHub). There is no silent refresh or login-triggered publish.

This intentionally small deployment supports one server process. Multi-instance/serverless deployments require a separately reviewed shared session store and are not supported by the memory implementation. The server caps sessions and serializes operations per session, bounds bodies, times out upstream requests, rejects redirects, and uses fixed GitHub hosts/operation routes. It never returns or logs raw GitHub error bodies or credentials. Authentication state is entirely separate from drafts, backups, snippets and exported README files.

## Review and publish

1. Connect, then choose an explicitly selected repository. The picker shows visibility, default branch, and effective write status based on app installation and user access. A profile repository is suggested, never assumed or created.
2. Enter the branch and README path. Load remote README runs a [Preflight](#preflight) for that exact Publish target and then captures the file's exact text, blob SHA and branch commit separately from your local draft.
3. Review the [Change set](#change-set-review): every file the publish would write, with its action, Base SHA and Result SHA, and for each file the remote/prepared source, unified changed-region diff, line counts and headings. The diff uses bounded linear memory and may include unchanged interior lines within a changed region; source panes are authoritative.
4. Edit the commit message, then check the Publish approval, which names the file count, repository, branch and change set id. The approval and publish button exist only when the Preflight for the current target is writable, and the publish button stays disabled until this exact Change set is approved. Confirm and publish re-reads every file, then makes one Contents API write per File change, sending the Base SHA for updates and requiring the file to be absent for a create. GitHub rejects a stale SHA. No files are deleted.
5. Success shows the commit, repository and file links. Local source remains unchanged. Failure keeps the prepared source/diff and Download README fallback. If a network response is lost, check GitHub before retrying; a remote write may have completed.

### Branch and pull request review

Studio uses the same source-preserving Change set for direct branches and PR branches; there is no separate unreviewed PR write path.

- **Existing PR:** choose “Update an existing documentation pull request,” fetch the compatible list, then explicitly select one. Studio offers only open PRs whose head and base repositories both equal the selected repository—fork PRs are excluded. Loading the PR head captures its exact SHA. Immediately before file publishing, the server requires the PR to remain open with the same number, head, base and head SHA, and requires GitHub to report it mergeable. A stale head, closed/repointed PR, conflict, or unknown mergeability writes nothing.
- **New PR:** first create a new branch from the reviewed source-branch SHA, load that branch, review the exact file changes and publish the commit. Only then can “Create a reviewed draft pull request” appear. Its separate review names the title, notes, head, base and exact head/base SHAs. The server re-reads both branch heads, requires Pull requests: write, checks for an existing open PR with the same head/base, and creates a **draft** only after explicit confirmation. Studio never merges a PR, bypasses protection, force-pushes, deletes a branch, or silently retries.
- **Failure and recovery:** a denied permission, changed SHA, duplicate, or protection refusal is definitive and safe to review again. A lost/unreadable POST response is uncertain: `readme-studio-pull-request-journal-v1` blocks another creation until reconciliation searches all PR states for one unique match on the exact title, repository, head, base, head SHA and base SHA within a bounded, second-normalized creation-time window (five minutes before through ten minutes after the recorded attempt). Zero or multiple plausible matches remain unresolved and no request is retried. After a zero-match check, clearing requires inspecting GitHub, downloading the content-free recovery record and confirming the risk before a fresh review; malformed recovery likewise must be downloaded before clearing. The journal contains only those identifiers, the title, note byte count, time and outcome—never README content, PR notes or credentials.

PR discovery and reconciliation are read-only. Changing a target invalidates PR selection. Local README source, drafts, Undo history and exports are unchanged by selection, creation, failure and reconciliation.

### Change set review

A **Change set** is the complete, reviewed list of file writes one publish makes to one Publish target and branch. It is built in memory when the remote file loads (ADR epic69-02) and shown first in the review:

- The header names the repository, the branch and the **base commit**, which is the branch head when the README was loaded.
- One row per **File change**, in execution order (generated assets first, the README or workflow last), lists the path, kind, action, **Base SHA**, **Result SHA**, size in bytes and added/removed lines. Each row has an expandable diff that uses the same source panes as the README review.
  - `create (new file)`: the file does not exist. Base SHA reads “none: new file”, and the write is refused if the file exists by then.
  - `update`: the file is written only while GitHub still has the Base SHA. If the remote file starts with a UTF-8 byte order mark (BOM) and the prepared content does not (or the reverse), the row says so, because a BOM is invisible in the diff panes. Remote files are read with their BOM, so the reviewed text is always the exact bytes the Base SHA names.
  - `unchanged: no write`: the prepared content already has the remote SHA, so nothing is sent for it.
- Every SHA is a Git blob SHA (SHA-1 of `blob <bytes>`, a NUL byte, then the UTF-8 content), the same value GitHub reports for each file. The Result SHA identifies the exact reviewed content.
- The change set id is the SHA-256 of the target, branch, base commit, commit message and ordered File changes. Its first eight characters appear in the Publish approval.

There is one **Publish approval** per Change set, held in memory only. Anything that builds a new Change set withdraws it: editing the commit message (the message is part of the set), resolving a merge, reloading a baseline, changing the asset options or changing the target. Re-checking access also clears the checkbox. A Change set with no file writes cannot be approved. Approval covers one Publish attempt: once it has run, complete or partial, no change set built on that remote baseline can be approved again, because Studio's own writes would read back as remote changes. Load the remote file again to review a new one.

Before the first write, Studio re-reads every file in the Change set. Only per-file SHA drift makes it a **Stale change set**. The branch head moving alone does not, because each Contents write commits on top of the head. A stale set writes nothing at all:

- A stale README or workflow opens the existing remote-change review (merge, reload or cancel), which builds a new Change set.
- A stale generated asset takes its latest remote SHA into a new Change set, which is shown under “Stale change set” and needs a fresh approval.

Each write sends its Base SHA (none for a create), Result SHA and change set id. The server recomputes the Result SHA from the content it received and refuses a mismatch (400) before contacting GitHub. It then re-reads the file and refuses an update whose Base SHA no longer matches, or a create whose file now exists (409, with the remote file for review). There is no force, delete or ref-rewrite path. Writes run one at a time and stop at the first failure. The results list each file as written, no write, failed or not attempted. A Change set is **not atomic**: earlier commits remain after a later failure.

The Change set content and its approval are never saved to drafts, backups, projects or browser storage, and reloading the page discards them. The content-free Publish journal described below saves only the identity and outcomes needed to reconcile an interrupted attempt. Computing Git blob SHAs needs the browser's Web Crypto API, which requires a secure (HTTPS or localhost) page. Without it, the review stays in Read-only mode with a message, and Download remains available.

#### Manual verification of change sets (not performed by CI)

Automated tests use mocked GitHub responses only. An operator can confirm Change set behaviour against a real app installation on a disposable repository. CI does not run these steps.

- [ ] **Result SHA matches GitHub**: publish a README update. The README row's Result SHA equals the blob SHA GitHub reports for the new file (the Contents API `sha`, or `git rev-parse HEAD:README.md` after pulling).
- [ ] **Stale asset**: load a review with generated banner assets, then commit a change to one of those asset paths on GitHub. Confirm and publish writes nothing and shows “Stale change set” with the new Base SHA.
- [ ] **Create when the file appears**: load a review for a README path that does not exist, create that file on GitHub, then publish. Nothing is written and the remote-change review opens.

Record who ran each check and when in your deployment notes; Studio does not record or claim these results.

### Preflight

Every publishing review starts in **Read-only mode**: remote content can be loaded, reviewed and downloaded, but no write can be approved. A Preflight is an explicit, read-only check of the exact repository, branch and path. It runs when you choose Load remote README (Preflight first, then the read, as one action) and again only when you choose **Re-check access**. Nothing is checked automatically or retried.

The Preflight section lists each check with a written status (Pass, Warning, Fail or Unknown), never colour alone, and announces the verdict as a status message.

| Check                   | Kind                     | Fails when                                                                                                                                                                   |
| ----------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publishing service      | blocking                 | The deployment has no publishing service configured.                                                                                                                         |
| GitHub session          | blocking                 | You are not connected.                                                                                                                                                       |
| GitHub App installation | blocking                 | The app is not installed on the repository, or the repository is not shared with it.                                                                                         |
| Contents permission     | blocking                 | The installation grants Contents: read only (or none).                                                                                                                       |
| Your push access        | blocking                 | Your own account cannot push to the repository.                                                                                                                              |
| Repository not archived | blocking                 | The repository is archived.                                                                                                                                                  |
| Branch exists           | blocking                 | The branch is missing. Choose an existing branch, load it, then use “Publish on a new branch instead”.                                                                       |
| Supported path          | blocking                 | The README, asset or workflow path is not one Studio writes.                                                                                                                 |
| Workflow permission     | blocking, workflows only | The server lacks `ALLOW_WORKFLOW_WRITES=true`, or the app lacks Workflows: write.                                                                                            |
| Branch rules            | advisory                 | Warns when the branch is protected or a ruleset requires pull requests, status checks, signatures, linear updates or blocks force pushes. Unknown when rules cannot be read. |
| Default branch          | advisory                 | Warns when you are committing directly to the default branch.                                                                                                                |

The target is writable only when every blocking check passes; any Fail or Unknown keeps Read-only mode. Advisory checks never block, because a token without admin rights cannot read every protection setting and rulesets can allow bypass. GitHub still decides at write time: a 403 or 422 from GitHub writes nothing and opens the “Publish on a new branch instead” route. That route appears only when the checks the server enforces for branch creation pass: installation, Contents permission, push access, repository not archived, branch exists and, for workflows, Workflow permission. A refusal by the server's own Preflight at write time (for example, access revoked after the check) does not suggest the route, because branch creation would be refused the same way; re-check access instead.

The server enforces the same blocking checks before every write with the same evaluator (`src/publishing/preflight.js`), so a refused commit reports the same message the Preflight showed. If the Preflight request fails or you are offline, every check is Unknown, the review stays read-only and your local draft is safe. The Preflight report is held only in the dialog's memory: changing the target, disconnecting or reloading clears it, and it is never saved to drafts, backups or projects.

#### Manual verification with a real GitHub App (not performed by CI)

Automated tests use mocked GitHub responses only. Before offering publishing publicly, an operator should verify these cases by hand against a real app installation on a disposable repository. CI does not run these steps.

- [ ] **Read-only installation**: set the app's Contents permission to read-only (or accept a read-only installation). Load remote README shows Contents permission Fail with “App grants Contents: read only”, and no confirmation or publish button appears.
- [ ] **Removed Workflows permission**: with `ALLOW_WORKFLOW_WRITES=true`, remove Workflows: write from the app. Workflow publishing shows Workflow permission Fail, and Download YAML fallback still works.
- [ ] **Protected branch or ruleset**: protect the target branch or add a ruleset requiring pull requests. Branch rules shows Warning, the verdict stays writable, and a direct commit refused by GitHub (403/422) writes nothing and opens “Publish on a new branch instead”.
- [ ] **Archived repository**: archive the repository. Repository not archived shows Fail and no publish control appears. Unarchive it afterwards.
- [ ] **Lost write response**: on a disposable repository, let one reviewed PUT reach GitHub and drop the proxy response. Studio reports an unknown outcome and makes no automatic retry. Reconcile reads the Result SHA, records the write and creates no second commit.

Record who ran each check and when in your deployment notes; Studio does not record or claim these results.

Publishing supports UTF-8 README text up to 750 KB, relative README paths without hidden folders/traversal, and valid Git ref names. Read-only repositories remain exportable. Offline editing/export works; publishing needs connectivity. Changing the target invalidates the review. Source is a snapshot taken when opening publishing, so unrelated background editor changes cannot silently change the reviewed commit.

## Verification

`npm test` includes server tests in Node with mocked OAuth, Contents and Pull Requests responses: cookie flags, CSRF/Origin rejection, permission enforcement, token redaction, read/create/update, exact Unicode source, compatible PR filtering, stale/conflicting PR refusal, duplicate prevention, ambiguous PR reconciliation and disconnect. `tests/publishing-preflight.test.js` covers every Preflight check, and the server tests prove a refused commit matches the Preflight message with zero PUT requests. `tests/publishing-change-set.test.js` checks Git blob SHAs against `git hash-object` vectors (including Unicode), action derivation, change set id stability, stale detection, stop-on-first-failure execution and selected-path retry. Journal and server tests inject lost responses, already-applied results, malformed storage and divergent state. `tests/browser/publishing.spec.js` covers explicit confirmation, Change set rows with Base and Result SHAs, existing-PR selection/recheck, reviewed draft-PR creation, approval withdrawn by a message edit, approval retired after a Publish attempt, unknown-to-written reconciliation without a duplicate write, unknown-to-not-written reconciliation with a new approval, malformed journal recovery, an unchanged README (asset-only publish and nothing to approve), a remote BOM named in the review, a stale asset blocking every write, missing Web Crypto, Read-only mode, failing checks, target changes, offline Preflight, unchanged local source, new files, denied writes and mobile download fallback in all three engines. Manual deployment verification with a real app is still required before offering publishing publicly; automated tests do not prove an operator's proxy/configuration is secure.

The API contract follows [GitHub Contents documentation](https://docs.github.com/en/rest/repos/contents). Check upstream permission changes when enabling new write types.

## Concurrent changes and recovery (0.8.1)

The browser and server re-fetch the remote blob SHA before a commit. A changed SHA stops publishing. Review the latest remote changes, merge, reload the baseline for an explicitly reviewed local replacement, or cancel. GitHub's SHA precondition also guards the race between the final read and write.

Three-way merge compares the loaded remote BASE, prepared LOCAL and latest REMOTE. Independent changes in uniquely identified, unchanged section structures merge automatically. Rename/reorder/duplicate-heading and structural changes fall back to an explicit whole-document conflict. Each conflict offers local, remote, combine (local then remote), or manual text. A new diff and unchecked confirmation follow every merge. This changes only prepared publishing source, never the local draft.

A source checkpoint is saved locally before a write; inability to save stops publishing. Download it or restore it as a **new Custom Markdown draft** under Local publishing history and recovery. This recovery preserves source, not builder ownership. The latest checkpoint and at most 50 metadata-only commit records live in a separate versioned browser key. Existing malformed history is never overwritten. History save failure after a successful remote commit is reported as a local failure, not a failed remote write.

### Ambiguous write recovery (1.9.6)

Before the first Contents write, Studio saves `readme-studio-publish-journal-v1`. This machine-local journal contains no file content or credentials: only the target, change set id, Base and Result SHAs, byte counts and each Write outcome. It is excluded from README exports, Studio projects and workspace backups. If it cannot be saved, nothing is written. Malformed journal data is preserved and blocks publishing; download the original JSON before the clear control becomes available.

A dropped connection, timeout or unreadable response after a write request makes that file `unknown`, and the attempt stops. Never repeat that request directly. Choose **Reconcile with GitHub**: Studio explicitly reads every changed file. A remote Result SHA means `written`; the Base SHA (or an absent file for a create) means `not-written`; any other SHA means `diverged`, which requires loading and reviewing a fresh change set. The server independently refuses a commit when the Result SHA is already present, so a duplicate request cannot produce another write.

Retry is available only while the same change set and prepared content remain in the current dialog. It submits only paths reconciled as `not-written`, requires a new explicit checkbox approval and keeps the original Base SHA protection. After a reload, the journal can still reconcile and record a successful remote result, but file content is intentionally absent, so retry requires a freshly loaded and approved change set. Local Markdown, builder state and Undo history are never changed by reconciliation or retry.

Target branch remains explicit. Optional Create branch requires its own confirmation and unchanged source commit SHA, then requires loading and reviewing the README on that new branch. After committing, deployments with Pull requests: write can create a separately reviewed draft PR with exact head/base checks; Studio never merges it. Branch protection is never bypassed. Previous/new commit links provide recovery context without implementing destructive rollback.

#### Manual verification of pull request publishing (not performed by CI)

- [ ] Install the app without Pull requests: write. Confirm file publishing remains available but draft-PR creation explains the missing permission and makes no POST.
- [ ] Select an existing same-repository PR, change its head on GitHub, then publish. Confirm Studio refuses the stale head before any Contents write.
- [ ] Put the selected PR in conflict with its base. Confirm Studio refuses it; resolve the conflict, reload and review fresh.
- [ ] Drop the proxy response after GitHub accepts a draft-PR POST. Confirm Studio blocks another creation, reconciliation finds the exact PR (including if it was closed), and no duplicate appears.

Record operator, disposable repository, app installation and date in deployment notes. These checks are required before advertising live PR publishing; automated mocks are not evidence of a production GitHub App configuration.

## Workflow permission boundary (0.8.3)

Workflow Builder can use this same diff/SHA confirmation flow only when the operator sets `ALLOW_WORKFLOW_WRITES=true` and the app installation grants Workflows: write in addition to Contents: write. The Preflight's Workflow permission check reports which of the two is missing. The server accepts only safely named workflow files whose YAML matches its validated generator settings. Ordinary README/asset publishing does not need the extra permission. See [workflow setup and limits](workflows.md). The optional server denies framing and rejects non-UTF-8 remote content rather than silently replacing bytes.
