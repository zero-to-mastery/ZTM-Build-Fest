# Publishing from home, backups, and view counts without a server

The pieces fit together like this: you write at home with `openblog serve --admin`, a
**Publish** button commits and pushes your Markdown with git, a GitHub Actions workflow
builds and deploys the site, and the git repository is your backup. View counts live on a
separate git branch and are baked into the pages at build time, so they show on a static
host too.

## Set up once

```sh
cd my-blog
openblog publish setup
```

This creates a git repository if there is none, writes the Pages workflow if it is
missing, and prints what is still yours to do: add a remote (`git remote add origin ...`
after creating an empty repository on GitHub), set *Pages → Source* to **GitHub Actions**
in the repository settings, and set `"url"` in `openblog.json`. Git must be installed and
able to push to the remote (SSH key or credential helper), exactly as it would from a
terminal; open.blog stores no tokens.

## Publish

In the admin editor the header shows "N unpublished changes" and a **Publish** button.
Pressing it runs, in this order:

1. `git add` on the content paths (`content`, `static`, `openblog.json`, `themes`,
   `.github` by default), minus drafts.
2. `git commit` with a message such as "Publish: Rust enums and match".
3. `git pull --rebase` so edits made elsewhere (another machine, the GitHub web editor)
   are kept. A conflict stops here with a clear message to resolve in git.
4. `git push`. The push triggers the deploy workflow.

The same thing from a terminal:

```sh
openblog publish                 # commit and push what changed
openblog publish "Fix typos"     # with your own summary
```

Drafts (`draft: true`) are never committed unless `publish.includeDrafts` is `true`: in
a public repository, a committed draft is public text. The header counts them separately
("2 drafts kept local").

Publishing refuses pre-staged files outside the publishable changes, including staged
drafts. Unstage those files before retrying; it will not silently include unrelated staged
work in the publishing commit. Uploads under a configured public static path are publishable
assets even when a draft references them; do not put confidential attachments there.

To publish on every save instead of on request, set `"publish": { "auto": true }`. The
admin then commits and pushes after each save in the background; a half-finished post
saved often makes many small commits, which is why it is off by default.

```jsonc
"publish": {
  "remote": "origin",
  "branch": "main",
  "auto": false,
  "includeDrafts": false,
  "paths": ["content", "static", "openblog.json", "themes", ".github"],
  "pullFirst": true
}
```

## Backups

Once you publish with git, every version of every post is in the repository, on GitHub
and on every machine that cloned it. Images and settings are included. `.openblog/` (your
users file, trash, and the live analytics store) is deliberately not committed; back that
folder up like any private file, and use the analytics branch below for the counts.

### Publishing from the Render container

Set `GIT_AUTHOR_NAME` and optionally `GIT_AUTHOR_EMAIL` for the publishing identity.
For a GitHub HTTPS or SSH origin, `OPENBLOG_GIT_TOKEN` enables an environment-backed Git
credential helper. The token must have permission to push to the intended repository and
branch; branch protection still applies. It is not written into the remote URL or
editorial backups. Never give this token to visitors or put it in public site settings.

Container startup reports invalid Admin credentials and users-file failures instead of
continuing as if login setup succeeded. Set both `OPENBLOG_ADMIN_USER` and
`OPENBLOG_ADMIN_PASSWORD`, or neither when managing users separately.

A successful local commit is not proof of a successful push or deployment. A rejected
push is reported as an error and leaves the local commit available for retry. The
integration tests exercise a real local Git remote, draft exclusion, and push rejection;
the hosted end-to-end test must additionally confirm the commit on GitHub and the page
on Netlify.

### Public deployment smoke checks

Run the read-only checks against the demo deployment:

```sh
node scripts/deployment-smoke.mjs https://open-blog-jtc.netlify.app \
  https://openblog-o0o5.onrender.com /posts/welcome-to-your-blog/
```

The checks require a homepage and linked CSS, a representative article, the exact Admin
redirects and Render assets, valid public engagement responses, and `401` for anonymous
moderation requests. They send no credentials, create no comments, and do not record views.

The **Production smoke checks** GitHub Actions workflow runs every six hours and can
also be dispatched manually. Forks can set repository variables `SMOKE_SITE_ORIGIN`,
`SMOKE_ADMIN_ORIGIN`, and `SMOKE_POST_PATH` for their own deployment. It checks public
availability, not whether a particular commit deployed or an authenticated save survived
a restart. Failures appear as failed workflow runs; enable GitHub Actions notifications
for alerts.

## View counts on a static host

A static host cannot count visits by itself, so open.blog separates *recording* from
*showing*:

- **Recording** needs something that accepts a request. Either `openblog serve` (wherever
  it runs, including at home while you write), or a small counter you host yourself (next
  section).
- **Showing** needs nothing live. The build reads the counts it can find and bakes
  "N views" into each post and into `/api/views.json`. On a static host the number is as
  of the last build; the Pages workflow builds hourly. If a live counter is reachable,
  `<ob-views>` updates the number and records the visit; if not, the baked number stays.

The counts are kept on a git branch named by `analytics.branch` (default `analytics`),
as a single `analytics.json` committed with git plumbing, so it never touches your working
tree or your `main` history:

```sh
openblog analytics backup        # commit the current counts to the branch and push
```

`openblog serve` does this by itself every 15 minutes while it runs. The Pages workflow
fetches the branch before building, which is how the counts reach the static site. If you
ever lose `.openblog/analytics.json`, the next build and the next `openblog serve` read it
back from the branch.

## A counter you host: Cloudflare Worker

For a static site with live counting, open.blog ships a counter for Cloudflare Workers
(free tier, no account needed beyond Cloudflare's). It is about 120 lines of plain
JavaScript, no dependencies, with the same privacy rules as the built-in counter: no
cookies, no addresses stored, uniques from a daily hash that is thrown away.

```sh
openblog analytics worker        # writes counter/worker.js and counter/wrangler.toml
cd counter
npm install --global wrangler    # one time
wrangler kv namespace create VIEWS     # paste the printed id into wrangler.toml
wrangler secret put EXPORT_SECRET      # any long random string; you need it below
wrangler deploy                        # prints https://<name>.<you>.workers.dev
```

Then in `openblog.json`:

```jsonc
"analytics": { "builtin": false, "endpoint": "https://<name>.<you>.workers.dev" }
```

Rebuild and deploy; posts now record and show live counts from the worker. To bring the
data into your dashboard and backups:

```sh
openblog analytics pull https://<name>.<you>.workers.dev --secret <EXPORT_SECRET>
openblog analytics backup
```

Pulling replaces the worker's share of the data each time, so pulling twice never counts
twice. A scheduled job that runs these two commands keeps the branch, and therefore the
baked counts, fresh; the admin's Analytics tab shows the merged numbers.

## A counter you host: Render with MongoDB

If you would rather have a database you can query, or already use Render, open.blog
ships the same counter as a small Node service whose only dependency is the official
MongoDB driver (the HTTP server is Node's own):

```sh
openblog analytics service       # writes counter-service/ (server.js, package.json, render.yaml, README)
```

Create a MongoDB database (Atlas has a free tier), push the folder to a repository, and
create a Render Blueprint from it; `render.yaml` sets the build and start commands and
asks for `MONGODB_URI`, generates `EXPORT_SECRET`, and sets `SITE_ORIGIN` to your blog.
Then point the blog at it, exactly as with the worker:

```jsonc
"analytics": { "builtin": false, "endpoint": "https://openblog-counter.onrender.com" }
```

`openblog analytics pull <that address> --secret <EXPORT_SECRET>` works the same, since
every counter speaks the same three routes. A free Render service sleeps after fifteen
minutes without traffic, so the command also writes
`.github/workflows/keep-counter-awake.yml` into the blog: a workflow that requests the
service's health page every 14 minutes (on minutes 7, 21, 35 and 49, away from the
top-of-hour rush when GitHub's scheduler runs late). Set the repository variable
`COUNTER_URL` to the service address and the counter never sleeps. One always-awake free
service uses most of Render's 750 free instance hours a month, so keep it to one.

## Writing your own counter

Any service that answers these three routes works with `<ob-views>` and
`openblog analytics pull`:

```
POST /hit            JSON {path, referrer}            → {views}
GET  /views?path=    → {views}
GET  /export         Authorization: Bearer <secret>   → {version: 1, days: {...}, totals: {...}}
```

`days` maps `YYYY-MM-DD` to `{views: {path: n}, uniques: {path: n}, referrers: {host: n}}`
and `totals` maps paths to all-time views. The two shipped counters are the reference.

## What stays manual

Creating the GitHub repository and the Cloudflare account, setting *Pages → Source*, and
adding the git remote. Everything after that is a button or one command.
