# Deploying

`openblog build` writes a complete static site to `dist/`. Anything that serves files can
host it. The choice is between a static host (simplest, no server to run) and
`openblog serve` on a machine you control (adds the admin editor, the view counter, and
automatic publishing of scheduled posts).

| | Static host (Pages, Netlify, S3, ...) | `openblog serve` |
| --- | --- | --- |
| Pages, feeds, search, themes | yes | yes |
| Scheduled posts | on the next build after the date (schedule a build) | automatic, within seconds |
| Admin editor | no (edit files, push) | yes, with `--admin` |
| View counter and analytics | no (`<ob-views>` hides itself) | yes |
| HTTPS | provided | put a reverse proxy in front |
| Published Knowledge Atlas | only if you build locally and upload `dist/` | yes |
| Published claim evidence | only if you build locally and upload `dist/` (revision notes always) | yes |

A blog made with `openblog init` is a folder of Markdown, settings, and themes. It has
no Rust code of its own: the `openblog` command does the building. The instructions below
assume that layout. (If you instead work inside a clone of the open.blog repository, its
own `.github/workflows/pages.yml` builds the starter site from source; replace
`openblog build` with `cargo run --release -p openblog-cli -- build` in the commands here.)

**The Knowledge Atlas is not in the repository.** With `knowledgeAtlas.publish` on, `/atlas/`
and `/atlas.json` come from the private atlas at `.openblog/private/research/atlas.json`, which
is Git-ignored. A build that runs from a clone (GitHub Actions, Netlify, Cloudflare Pages, any
CI) cannot read it and publishes an empty atlas; `openblog build` and `openblog check` warn when
that happens. Only a build that can read the private atlas publishes it: `openblog serve` and
Admin on the machine that holds it, or an `openblog build` run there whose `dist/` you then
upload.

**Passage comparisons are not in the repository either.** With `comparisons.publish` on,
`/comparisons/` and `/comparisons.json` come from `.openblog/private/research/alignments.json`,
the library and the notebook, which are Git-ignored. A build from a clone publishes empty
comparisons and warns.

**Claim evidence is not in the repository either.** With `claimEvidence.publish` on, the "Claims
and evidence" sections and `/claim-evidence.json` come from `.openblog/private/research/claims.json`,
which is Git-ignored. A build from a clone publishes no claims and warns; the revision notes
written in posts' front matter are published either way.

## GitHub Pages

1. Create the blog with the workflow included, or add it to an existing blog:

   ```sh
   openblog init my-blog --github-pages
   ```

   This writes `.github/workflows/pages.yml`. It installs `openblog` on the build machine
   (cached between runs), runs `openblog build`, and deploys `dist/`, on every push to `main`
   and once an hour so scheduled posts publish on time. Edit the `cron` line if you want a
   different rhythm.

2. Push the blog to a GitHub repository.
3. In the repository settings, under *Pages*, set *Source* to **GitHub Actions**.
4. Set `"url"` in `openblog.json` to the address the site will have.

Two kinds of address are possible:

- **A custom domain, or a `user.github.io` user site**: the site lives at the root. Add the
  domain to `static/CNAME` (one line) and configure it under *Pages*; the build copies the
  file to the site root. With `"postPath": "/{slug}/"`, URLs imported from Hashnode stay
  identical.
- **A project site, `https://user.github.io/repo/`**: set `"url"` to exactly that. The build
  reads the path from it and prefixes every root-relative link, asset, and the search index,
  while feeds and the sitemap use the full address. `openblog serve` honours the same prefix
  locally, so `http://localhost:8080/repo/` previews what Pages will serve.

The build also writes a `.nojekyll` file so Pages serves everything as is.

## Netlify

Netlify builds from private repositories on its free tier and handles custom domains, so
it is the natural choice when the repository is private. A clone of the engine repository
(such as a fork) already contains `netlify.toml` and `rust-toolchain.toml`:

1. In Netlify, add a new site from the repository. The settings come from `netlify.toml`:
   Netlify installs Rust, compiles the engine, runs `openblog build`, and publishes
   `dist/`. The first build takes several minutes; later ones reuse the cache.
2. Set `"url"` in `openblog.json` to the site's address (the Netlify subdomain, or your
   custom domain once it is configured under *Domain management*).
3. For scheduled posts, create a build hook under *Site configuration → Build & deploy →
   Build hooks*, and store its URL as a repository secret named `NETLIFY_BUILD_HOOK`. The
   included workflow `.github/workflows/netlify-schedule.yml` then triggers a rebuild
   once a day (06:23 UTC), which is when a due post appears. Every build compiles the
   engine and counts against Netlify's build minutes (300 a month on the free tier), so
   the default is deliberately rare; edit the `cron` line for more, and date scheduled
   posts for the rebuild time.

The file also sets cache headers for assets and CORS headers for the feeds and the
latest-posts JSON. Aliases are plain redirect pages, so they need no Netlify redirects.

### Admin hosted separately on Render

This repository's Netlify configuration redirects `/admin` and `/admin/*` to
`https://openblog-o0o5.onrender.com/admin/`, preserving nested paths. Replace that hostname
in both rules when deploying your own Admin service. These are temporary (`302`) redirects,
not proxy rewrites: the browser moves to Render, where login, cookies, and authenticated
requests stay on the same origin. Public engagement routes under `/api/` stay on Netlify.

Keeping Admin requests off Netlify's proxy also avoids its 26-second proxy timeout for
long-running operations. Do not change these rules to `200` rewrites without verifying
Admin's Origin/Host checks and request timeouts. On Render, use `OPENBLOG_BEHIND_PROXY=1`
for secure session cookies, and follow the [self-hosting](#self-hosting-with-openblog-serve)
and Render guidance below for credentials, persistent storage, and Git publishing.

### Comments and persistent analytics on Netlify

The repository includes an optional Netlify Function backed by Supabase. It adds moderated comments
and lets the existing privacy-respecting view counter retain analytics across deploys. Run
[`supabase/openblog.sql`](../supabase/openblog.sql) in a Supabase project, then follow the
[function setup guide](../netlify/functions/README.md) to configure the server environment. The
Supabase secret API key (`SUPABASE_SECRET_KEY`) remains in Netlify and is never an Admin or
public-site setting. Existing `SUPABASE_SERVICE_ROLE_KEY` deployments remain supported.

After deployment, open **Admin → Analytics**, enable hosted engagement, enter the public `/api`
endpoint, and save the matching write-only moderation token. New comments remain pending until an
Admin user approves them in the **Moderation inbox**, which also lists passage feedback (ADR 0105).
To offer every moderation decision, with versions and an audit trail for comments, run the
additive [`supabase/moderation.sql`](../supabase/moderation.sql) (and `feedback.sql` again if you
use feedback) and set `OPENBLOG_MODERATION_ENABLED=true` (ADR 0106); see the
[function setup guide](../netlify/functions/README.md#moderation-inbox). Reader receipts, abuse
reports, deletion requests and the retention run are a further opt-in step,
[engagement protection](../netlify/functions/README.md#engagement-protection-optional) (ADR 0108),
and so are readers' evidence and your correction decisions,
[evidence and correction decisions](../netlify/functions/README.md#evidence-and-correction-decisions-optional) (ADR 0118). Tokens saved by Admin are bound to the endpoint origin, redirects are not
followed, and Supabase-backed quotas limit public writes. The function also reads the generated
comment-policy manifest from `OPENBLOG_SITE_ORIGIN` before comment access, so locked and hidden
policies are enforced on the server as well as in the page UI. Set `OPENBLOG_SITE_BASE_PATH` when
the published site lives below `/`. The existing local counter stays the default when hosted
engagement is off.

#### Optional passage feedback

Typed passage feedback (reader questions, suggested sources and corrections, and other
interpretations, ADRs 0079 to 0081) is off by default and needs three explicit steps: run the
additive migration [`supabase/feedback.sql`](../supabase/feedback.sql), set
`OPENBLOG_FEEDBACK_ENABLED=true` in Netlify, and set `engagement.feedback` to `true` in
`openblog.json`. The migration only creates the private `openblog_feedback` table; existing comments,
analytics and their tables are not changed. It also adds the private moderation audit table
`openblog_feedback_events` and the function `openblog_moderate_feedback` (ADR 0083). Approved notes
are published from `content/reader-feedback.json` in the repository, so the build needs no access
to the hosted service. To roll back, unset `OPENBLOG_FEEDBACK_ENABLED` and redeploy, then, if you
also want the data gone, export it and run
[`supabase/feedback-rollback.sql`](../supabase/feedback-rollback.sql), which drops only what the
migration created.
The [function setup guide](../netlify/functions/README.md#passage-feedback-optional) has the
details. The engagement function is bundled with esbuild (`[functions."engagement"]` in `netlify.toml`) so it can share
the feedback validator in `web/components/`.

### Durable editorial workspace on ephemeral hosts

By default, drafts and unpublished files live **only on the Admin host's filesystem**.
Git publishing is not a draft backup. For an ephemeral Render service, opt into the
separate Supabase workspace store; a public Netlify deployment still builds exclusively
from Git. This does not change the engagement database or expose editorial data to Netlify.

1. In the existing Supabase project, run
   [`supabase/workspace.sql`](../supabase/workspace.sql) in the SQL editor. It creates
   one service-role-only revisioned manifest table and the **private**
   `openblog-workspace` Storage bucket. No public/anonymous access is granted, and
   a restrictive bucket policy excludes this bucket from broad authenticated policies.
2. Set these **server-only Render environment variables**, never in `openblog.json`,
   client JavaScript, Netlify's public configuration, or Git:

   | Variable | Value |
   | --- | --- |
   | `OPENBLOG_WORKSPACE_SUPABASE_URL` | The project's HTTPS origin, e.g. `https://PROJECT.supabase.co` |
   | `OPENBLOG_WORKSPACE_SECRET_KEY` | A server-side Supabase secret key (`sb_secret_…`) or legacy service-role JWT (never an anon/publishable key) |
   | `OPENBLOG_WORKSPACE_NAMESPACE` | A stable, unique blog identifier: 1–80 ASCII letters, digits, `-`, `_` |

   Set all three, or none. Partial/invalid configuration fails startup rather than
   silently using local storage. Use a different namespace for a staging blog.
   Modern secret keys are sent only in `apikey`; legacy service-role JWTs additionally
   use Bearer authorization. The private bucket name is fixed; there is no default
   namespace, so the blog identifier must be explicitly supplied.
3. Deploy the updated binary. The entrypoint must provision Admin login/provider/Git
   credentials **before** `openblog serve --admin`. Supabase does not back up these secrets.
   The Docker build and runtime both use Debian bookworm; building against a newer libc
   than the runtime supports can prevent the binary from starting. The image executes
   `openblog help` during its build to check runtime compatibility.
   If Render omits `.git` from its Docker context, the entrypoint recovers Git metadata
   from Render's `RENDER_GIT_REPO_SLUG`, `RENDER_GIT_COMMIT`, and `RENDER_GIT_BRANCH`.
   It fetches the exact shipped commit and checks the existing file contents before
   attaching HEAD; it does not replace files or create a synthetic publishing baseline.
   Private repositories require `OPENBLOG_GIT_TOKEN` or the SSH deploy key described
   below for that fetch. Non-Render images
   must include a valid Git checkout or explicitly provide these source identifiers.
   When opted in, Rust startup fetches `publish.remote` / `publish.branch` into its
   remote-tracking ref, verifies that `HEAD` is an ancestor, then uses a fast-forward-only
   merge with autostash disabled to prepare the published checkout. No shell JSON parsing,
   reset, checkout/discard, or separate fetch integration is required in the entrypoint.
   Restore and reconciliation finish before building, starting watchers, or opening HTTP.
   Startup fails visibly on unavailable storage, invalid data, or conflicting edits.
   Fetch failures, missing remote branches, local-only commits/divergence, insufficient
   shallow history, and dirty tracked/untracked files that prevent fast-forwarding fail
   visibly before contacting Supabase. Unrelated local files are retained. Resolve these
   failures manually without discarding unpublished work. Git fetch/merge commands have
   a 60-second timeout each, interactive prompts are disabled, and credential-bearing
   Git diagnostics are not echoed. With no configured Git remote, startup `HEAD` is the
   initial baseline. Default/non-opted-in serving never fetches or merges.
4. Verify against the deployed service: create a draft, save an unpublished edit, upload an
   image/GPX, change a non-secret setting and personal preference, restart/redeploy Render,
   and confirm they survive. Also verify publishing still pushes the public Git branch.
   SQL application, environment configuration, and this live restart check are manual setup;
   repository changes alone do not configure the live service.

**What is stored.** UTF-8 database text records hold Markdown posts/pages/series,
credit sidecars, `openblog.json`, `.gitignore`, project Assistant skills and portable/private
context/references, per-login presentation preferences, and typed editor trash. Images,
GPX uploads, and pending GPX data use content-addressed objects in the private bucket.
Only the explicitly selected `.openblog/private/context/` and
`.openblog/private/admin-preferences/` directories, plus the single research source library
file `.openblog/private/research/sources.json` (up to 4 MiB), participate. Auth users/password hashes,
sessions, analytics, provider/moderation/API keys, Git configuration/credentials, arbitrary
`.openblog/private/`, themes, generated output, and other files are **never** backed up.
Unknown configuration fields are rejected rather than risking storing an inline secret.
Do not put secrets in authored documents, public settings, or the included context directories.
Re-provision write-only credentials through environment variables or the host's secret
setup after restart; saving one in Admin does not make that credential durable.

**Acknowledgement and conflicts.** Every authenticated Admin mutation completes its local
filesystem transaction and synchronous durable manifest revision before returning success.
Uploads finish before the atomic database compare-and-swap. A service outage, timeout,
quota/size error or stale revision returns an explicit **503 / save NOT acknowledged**;
local changes may still exist, but subsequent writes stop until restart/reconciliation.
Do not treat a failed save as backed up. Preserve/export that local version before replacing
an ephemeral instance. A timeout can mean the commit actually succeeded: inspect the remote
revision before retrying. Other instances cannot silently overwrite newer saves.

Git remains published truth. Restore records the published Git blob each edit replaced,
checks the entire bundle first, and permits only matching baselines or already-identical
results. New upstream edits or unrelated local edits cause a visible startup conflict,
not an overwrite. Deletions/renames have tombstones; document, credit, context, track and
setting changes share one manifest revision. Successful Git pushes retire published
overlays; local-only publication is disabled in this mode. After a conflict, stop writers,
preserve both versions, reconcile/export the namespace manifest with the current Git
checkout, and restart. There is deliberately no automatic merge or “last writer wins.”

**Limits and operating model.** Run one active Admin instance per namespace. Revision CAS
protects against overlapping instances, but is not collaborative multi-master editing.
Each HTTP storage request has a 15-second timeout and no redirects; save/restore loops
stop after a 90-second operation budget (plus at most one in-flight request). Maximums:
2,048 records/files, 2 MiB per UTF-8 text file, 16 MiB per upload, 64 MiB selected filesystem
data, 8 MiB manifest, bounded directory traversal and relative paths. Tombstones count
toward the record limit. Content/static/users path layout cannot change while enabled.
Symlinks (including internal ones) are rejected, and the normal content lock spans the
durability transaction. Filesystem access assumes trusted/cooperating OS processes; it
does not defend against a hostile local account racing filesystem replacement.

Use Admin's API for mutations in this mode. CLI content creation/import/migration/publish
commands are disabled when workspace environment variables are present; direct disk edits,
external tools, and periodic file-watcher rebuilds are **not durable acknowledgements**.
Stop the service to perform maintenance, then restart and reconcile before accepting edits.
The store is a recoverable working overlay, not version history or a full-repository backup.
Failed/uncommitted uploads and superseded objects are retained (no racing automatic GC);
monitor the free-tier database/Storage quotas and remove only unreferenced objects while
writers are stopped. Free Supabase projects may pause or exhaust quota: an outage blocks
startup/saves rather than falling back to ephemeral storage.

For a blog made with `openblog init` (no engine source in the repository), use this
build command instead, with `dist` as the publish directory:

```sh
curl https://sh.rustup.rs -sSf | sh -s -- -y && . "$HOME/.cargo/env" \
  && cargo install --git https://github.com/journey-to-code-org/open.blog openblog-cli \
  && openblog build
```

### Publishing from the container with an SSH deploy key

Instead of a token, the container can push with a write-enabled SSH deploy key registered on
this one repository, so a leaked credential cannot reach any other repository. Mount the
private key and a pinned GitHub known-hosts file as secret files (Render calls them secret
files) and point to them:

- `OPENBLOG_GIT_SSH_KEY_PATH`: the private deploy key.
- `OPENBLOG_GIT_SSH_KNOWN_HOSTS_PATH`: GitHub's host keys, taken from GitHub's authenticated
  HTTPS metadata API. Refresh them when GitHub rotates keys; never disable host verification.

At startup the entrypoint copies the key to a private file (mode 600), requires strict host-key
checking, and rewrites an `https://github.com/...` origin to `git@github.com:...`. Git metadata
recovery on Render (`scripts/container-git.sh`) uses the same key for its first fetch. Startup
fails if either file is unreadable, if the remote is not a GitHub repository, or if
`OPENBLOG_GIT_TOKEN` is also set: configure only one credential method.

## Execution gateway

`codeRunner` is a browser-to-runner integration, not a code executor inside open.blog. Deploy the
gateway on infrastructure isolated from the blog repository, Admin service, databases, deployment
credentials, and private networks. The generated page makes this credential-free request:

```http
POST /v1/execute
Content-Type: application/json

{"language":"python","source":"print(input())","stdin":"hello\n"}
```

Return JSON with exactly the useful execution outcome:

```json
{"success":true,"stdout":"hello\n","stderr":"","exitCode":0}
```

`success` is a Boolean, `stdout` and `stderr` are strings, and `exitCode` is an integer or `null`.
The browser caps source at 20,000 bytes, standard input at 8,000 bytes, the response body at 512,000
bytes, and displayed output at 64,000 bytes. It times out after 20 seconds, strips terminal control
sequences, truncates output, and renders text rather than HTML. Those client checks are defense in
depth, not server controls: independently enforce smaller source/output limits, compile and run
deadlines, CPU, memory, PID, file, and disk quotas, per-client rate limits, a global concurrency cap,
and an emergency disable switch.

Run every request in a fresh unprivileged workspace with no network, secrets, host mounts, Docker
socket, package installation, or writable runtime image. Pin and patch the executor. Suitable gateway
implementations include:

- a self-hosted Piston deployment for a multi-language API;
- a patched self-hosted Judge0 deployment behind an adapter that exposes only this narrow contract;
- a pinned self-hosted Pyodide worker on a dedicated runner origin for Python. Pyodide and Web
  Workers still expose browser networking APIs unless the runner origin applies its own restrictive
  CSP, so WebAssembly is not an isolation boundary by itself.

Do not put Piston/Judge0 credentials in `openblog.json` or generated HTML. Keep them between the
public gateway and executor. Configure only the public gateway URL and the exact languages it
supports; a `runnable` fence for any other language remains static.

## Cloudflare Pages, Vercel, and others

Same shape: publish `dist/`, and build with either the clone command
(`cargo build --release -p openblog-cli --locked && ./target/release/openblog build`) or
the `cargo install --git` command above. Trigger a build on a schedule for scheduled
posts: a build hook called from a cron job or a scheduled workflow, as with Netlify.

## Self-hosting with `openblog serve`

```sh
openblog user add you
openblog serve --admin --port 8080
```

Then put a reverse proxy with HTTPS in front (Caddy, nginx, Traefik, ...) and set, in
`openblog.json`:

```jsonc
"admin": {
  "secureCookies": true,              // required over HTTPS
  "trustedProxies": ["127.0.0.1"]     // the proxy's address, exact IP (no ranges)
}
```

Three things the proxy must do, or logins and saves are refused as cross-origin and
every visitor shares one login limit:

- Pass the original `Host` header through. Caddy does by default. For nginx add
  `proxy_set_header Host $host;`.
- Add `X-Forwarded-For`. Caddy does by default. For nginx add
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.
- Reach `openblog serve` on the address it listens on. Keep the default `--host 127.0.0.1`
  when the proxy runs on the same machine, so only the proxy can reach the plain-HTTP port.
  Use `--host 0.0.0.0` or the machine's private address only when the proxy is elsewhere,
  and firewall the port so it is not reachable from the internet.

A minimal nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Run the server under a process manager (systemd, a container, or a Windows service) so it
restarts with the machine, and keep `.openblog/` (users, trash, analytics) out of version
control and in your backups. [The admin editor](admin.md) has the full checklist.

A common hybrid: run `openblog serve --admin` privately for writing, and let the Pages
workflow deploy `dist/` for readers. The editor's Publish button commits and pushes for
you; see [Publishing from home](publishing.md).

## Docker, and Render as a web service

The repository ships a `Dockerfile` that builds the engine and serves the blog in the
same image with `openblog serve --admin`: pages, the editor, the view counter, and the
analytics dashboard in one process. It suits Render, Fly, a VPS with Docker, or a NAS.

```sh
docker build -t my-blog .
docker run -p 8080:8080 \
  -e OPENBLOG_ADMIN_USER=you -e OPENBLOG_ADMIN_PASSWORD='a long passphrase' \
  -e OPENBLOG_BEHIND_PROXY=1 my-blog
```

- `OPENBLOG_ADMIN_USER` and `OPENBLOG_ADMIN_PASSWORD` create the login at start (or
  update its password), so a host without a persistent disk still has one.
- `OPENBLOG_BEHIND_PROXY=1` tells the server an HTTPS proxy is in front: cookies are
  marked Secure and the client address comes from `X-Forwarded-For` whatever the proxy's
  address is. Set it on any PaaS; leave it unset when you run the container directly on
  plain HTTP.
- Mount a volume at `/blog/.openblog` to keep users, analytics, and the trash across
  restarts.

`render.yaml` at the repository root is a Render blueprint for exactly this: create a
Blueprint from the repository, then set `OPENBLOG_ADMIN_PASSWORD` in the dashboard. On
Render's free tier there is no disk, so treat the editor there as a writing surface and
press Publish to get posts into git; view counts survive through the analytics branch. A
paid plan can mount the disk (the commented section in `render.yaml`).

The Dockerfile assumes the blog lives in a clone of the engine repository (the layout a
fork has). For a blog made with `openblog init`, replace the build stage with
`cargo install --git https://github.com/journey-to-code-org/open.blog openblog-cli`.

## A theme that is not in the repository

Builds in CI only see committed files. If a theme is kept out of the repository
(private fonts, a design you do not want to publish), either commit it after all, add a
workflow step that checks the theme out from a private repository into `themes/<name>/`
(a second `actions/checkout` with a deploy key or token), or build locally and upload
`dist/` instead of building in CI. A missing theme fails the build with
"theme `name` not found".

## Moving URLs

When a post's address changes, keep the old one working with `aliases` in its front matter:

```yaml
aliases:
  - /old-slug/
  - /2024/03/original-title/
```

Each alias becomes a small page that redirects to the post, carries a canonical link to
the new address, and is excluded from the sitemap. An alias that collides with a real page
fails the build instead of overwriting it. Pages support `aliases` too.

Changing `postPath` moves every post at once; add an alias for the old address to each
post you care about, or keep `postPath` as it was.
